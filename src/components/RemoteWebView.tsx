import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  BackHandler,
  Keyboard,
  KeyboardEvent,
  LayoutChangeEvent,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  WebView,
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview';
import { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import {
  ANTIGRAVITY_DASHBOARD_URL,
  AUTO_NOTIFICATION_KEEP_ALIVE_MINUTES,
  DEFAULT_ACTION_NOTIFICATION_MODE,
  DEFAULT_KEEP_ALIVE_MINUTES,
} from '../constants/config';
import {
  INBOX_BRIDGE_SCRIPT,
  buildFastThreadSwitchScript,
  buildInboxRefreshScript,
  buildMarkThreadReadScript,
} from '../services/inboxBridge';
import {
  PROJECT_OVERVIEW_SCROLL_SCRIPT,
  buildReturnToOverviewScript,
} from '../services/scrollRestorationBridge';
import {
  backupCookiesFromWebView,
  clearSession,
  getActionNotificationMode,
  getGoogleSessionSignature,
  getKeepAliveMinutes,
  getLastActiveUrl,
  hydrateCookiesToWebView,
  saveActionNotificationMode,
  saveKeepAliveMinutes,
  saveLastActiveUrl,
  suspendSessionPersistence,
  resumeSessionPersistence,
} from '../services/sessionVault';
import {
  clearNativeActionNotification,
  configureNativeKeepAlive,
  installNativeDocumentStartScript,
  requestNativeNotificationPermission,
  syncNativeActionNotification,
} from '../services/webData';
import {
  InboxBridgeMessage,
  InboxSnapshot,
  InboxThreadItem,
} from '../types/inbox';
import {
  ActionNotificationMode,
  AuthFlowStage,
  KeepAliveMinutes,
} from '../types/session';
import { buildActionNotificationSyncState } from '../utils/actionNotification';
import {
  applyLocalStateToSnapshot,
  buildInboxSnapshot,
  extractActiveRouteFromUrl,
  parseInboxBridgeMessage,
  reconcileRunningThreadTransitions,
  resolveActiveRouteFromBridgeMessage,
} from '../utils/inboxParser';
import {
  isGoogleCookieErrorUrl,
  isAllowedAuthSubframeUrl,
  isAllowedRemoteClientSubframeUrl,
  isInternalWebViewSchemeUrl,
  validateNavigationUrl,
} from '../utils/urlValidator';
import { getCleanMobileUserAgent } from '../utils/userAgent';
import { DrawerMode, LeftNavigationDrawer } from './LeftNavigationDrawer';
import { TopStatusBanner } from './TopStatusBanner';

/**
 * Injected into the WebView to ensure that when the mobile software keyboard
 * opens or resizes the viewport, any focused chat box (<textarea>, <input>,
 * or [contenteditable]) stays scrolled into view above the keyboard.
 */
const KEYBOARD_ADAPTATION_SCRIPT = `
(function() {
  if (window.__agyKeyboardAssistInstalled) return true;
  window.__agyKeyboardAssistInstalled = true;

  function isEditableElement(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (el.isContentEditable) return true;
    var role = el.getAttribute && el.getAttribute('role');
    return role === 'textbox' || role === 'combobox' || role === 'searchbox';
  }

  function keepActiveInputVisible() {
    var active = document.activeElement;
    if (!isEditableElement(active)) return;
    try {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (_) {}
  }

  function scheduleScrollSync() {
    keepActiveInputVisible();
    setTimeout(keepActiveInputVisible, 80);
    setTimeout(keepActiveInputVisible, 220);
  }

  document.addEventListener('focusin', scheduleScrollSync, true);
  window.addEventListener('resize', scheduleScrollSync, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleScrollSync, { passive: true });
    window.visualViewport.addEventListener('scroll', scheduleScrollSync, { passive: true });
  }
  return true;
})();
`;

/**
 * Dispatched immediately when the app returns to the foreground so active
 * Antigravity WebSocket / streaming RPC clients and Google 2FA flows bypass
 * stale reconnect backoff timers without reloading or losing unsent input.
 */
const RESUME_WAKEUP_SCRIPT = `
(function() {
  try {
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (_) {}
  return true;
})();
`;

/**
 * Acquires or releases a W3C Web Lock (`navigator.locks`) while background
 * keep-alive is enabled so Chromium's Blink PageScheduler opts the session out
 * of background page freezing without spoofing `document.visibilityState`.
 */
function buildKeepAliveWebLockScript(acquire: boolean): string {
  if (acquire) {
    return `
(function() {
  try {
    window.__agyKeepAliveLockDesired = true;
    if (window.__agyKeepAliveLockHeld || window.__agyKeepAliveLockPending) return true;
    if (navigator && navigator.locks && typeof navigator.locks.request === 'function') {
      window.__agyKeepAliveLockPending = true;
      navigator.locks.request('__agy_remote_keep_alive', function() {
        window.__agyKeepAliveLockPending = false;
        if (!window.__agyKeepAliveLockDesired) {
          window.__agyKeepAliveLockHeld = false;
          return Promise.resolve();
        }
        window.__agyKeepAliveLockHeld = true;
        return new Promise(function(resolve) {
          window.__agyReleaseKeepAliveLock = function() {
            window.__agyKeepAliveLockHeld = false;
            window.__agyReleaseKeepAliveLock = null;
            resolve();
          };
          if (!window.__agyKeepAliveLockDesired) {
            window.__agyReleaseKeepAliveLock();
          }
        });
      }).catch(function() {
        window.__agyKeepAliveLockPending = false;
        window.__agyKeepAliveLockHeld = false;
      });
    }
  } catch (_) {}
  return true;
})();
`;
  }
  return `
(function() {
  try {
    window.__agyKeepAliveLockDesired = false;
    if (typeof window.__agyReleaseKeepAliveLock === 'function') {
      window.__agyReleaseKeepAliveLock();
    }
    window.__agyKeepAliveLockHeld = false;
  } catch (_) {}
  return true;
})();
`;
}

const MAX_RENDER_RECOVERY_ATTEMPTS = 3;
const RENDER_RECOVERY_WINDOW_MS = 30_000;
const FAST_THREAD_NAV_FALLBACK_MS = 750;
const INBOX_REFRESH_TIMEOUT_MS = 9_000;
const MAX_LOCALLY_READ_ENTRIES = 500;

function recordBoundedLocalRead(
  map: Record<string, number>,
  threadKey: string,
  readAtMs: number,
): void {
  if (Object.prototype.hasOwnProperty.call(map, threadKey)) {
    delete map[threadKey];
  }
  map[threadKey] = readAtMs;
  const keys = Object.keys(map);
  if (keys.length > MAX_LOCALLY_READ_ENTRIES) {
    const excess = keys.length - MAX_LOCALLY_READ_ENTRIES;
    for (let i = 0; i < excess; i++) {
      delete map[keys[i]];
    }
  }
}

function findMatchingThread(
  threads: readonly InboxThreadItem[],
  instanceUuid: string | null,
  cascadeId: string | null,
): InboxThreadItem | undefined {
  if (!instanceUuid || !cascadeId) {
    return undefined;
  }
  return threads.find(
    (t) =>
      t.instanceUuid === instanceUuid &&
      (t.cascadeId === cascadeId || t.trajectoryId === cascadeId),
  );
}

const COMBINED_INJECTED_SCRIPT = `${KEYBOARD_ADAPTATION_SCRIPT}\n${PROJECT_OVERVIEW_SCROLL_SCRIPT}\n${INBOX_BRIDGE_SCRIPT}`;

const EMPTY_INBOX_SNAPSHOT: InboxSnapshot = {
  instances: [],
  threads: [],
  fetchedAtMs: 0,
  activeInstanceUuid: null,
  activeCascadeId: null,
  usage: null,
  error: null,
};

/**
 * Push-notification 2-Step Verification and cookie-sync paths where the user
 * approves a prompt outside the WebView (e.g., Google Prompt notification) and
 * the page may stall upon returning to the app. Excludes interactive input
 * challenges (`/challenge/totp`, `/challenge/pwd`, `/challenge/ipp`) so users
 * switching to an Authenticator or Password Manager app never lose typed input.
 */
function isPushPromptOrCookieSyncUrl(rawUrl: string): boolean {
  if (!rawUrl) {
    return false;
  }
  const lower = rawUrl.toLowerCase();
  return (
    lower.includes('/challenge/dp') ||
    lower.includes('/challenge/az') ||
    lower.includes('/checkcookie') ||
    lower.includes('/setsid')
  );
}

interface RemoteWebViewProps {
  incomingDeepLinkUrl: string | null;
  pendingOpenInbox?: boolean;
  isInitialUrlResolved?: boolean;
  onDeepLinkConsumed: () => void;
  onOpenInboxConsumed?: () => void;
}

export const RemoteWebView: React.FC<RemoteWebViewProps> = ({
  incomingDeepLinkUrl,
  pendingOpenInbox = false,
  isInitialUrlResolved = true,
  onDeepLinkConsumed,
  onOpenInboxConsumed,
}) => {
  const insets = useSafeAreaInsets();
  const initialIsForeground =
    AppState.currentState !== 'background' &&
    AppState.currentState !== 'inactive';
  const webViewRef = useRef<WebView | null>(null);
  const hydratedRef = useRef(false);
  const canGoBackRef = useRef<boolean>(false);
  const uncompressedHeightRef = useRef<number>(0);
  const cookieRecoveryAttemptsRef = useRef<number>(0);
  const isResettingSessionRef = useRef(false);
  const currentNavUrlRef = useRef<string>(ANTIGRAVITY_DASHBOARD_URL);
  const stageRef = useRef<AuthFlowStage>('hydrating');
  const baselineAuthSigRef = useRef<string | null>(null);
  const post2faReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const renderRecoveryTimestampsRef = useRef<number[]>([]);
  const renderProcessDeadRef = useRef<boolean>(false);
  const notificationPermissionRequestedRef = useRef<boolean>(false);
  const wasBackgroundedRef = useRef<boolean>(false);
  const isAppForegroundRef = useRef<boolean>(initialIsForeground);
  const keepAliveMinutesRef = useRef<KeepAliveMinutes>(
    DEFAULT_KEEP_ALIVE_MINUTES,
  );
  const actionNotificationModeRef = useRef<ActionNotificationMode>(
    DEFAULT_ACTION_NOTIFICATION_MODE,
  );
  const inboxSnapshotRef = useRef<InboxSnapshot>(EMPTY_INBOX_SNAPSHOT);
  const lastSnapshotMessageRef = useRef<Extract<
    InboxBridgeMessage,
    { type: 'AGY_INBOX_SNAPSHOT' }
  > | null>(null);
  const resumeReadSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastActionNotifSigRef = useRef<string>('');
  const previousOpenActionIdsRef = useRef<Set<string>>(new Set());
  const knownRunningThreadIdsRef = useRef<Set<string>>(new Set());
  const completedUnreadMapRef = useRef<Record<string, number>>({});
  const locallyReadMapRef = useRef<Record<string, number>>({});
  const activeInstanceUuidRef = useRef<string | null>(null);
  const lastObservedOverviewInstanceRef = useRef<string | null>(null);
  const canReturnToOverviewRef = useRef<boolean>(false);
  const pendingFastNavRef = useRef<
    Map<string, { timer: ReturnType<typeof setTimeout>; targetUrl: string }>
  >(new Map());
  const inboxRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const isDrawerOpenRef = useRef<boolean>(false);

  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [keepAliveMinutes, setKeepAliveMinutes] = useState<KeepAliveMinutes>(
    DEFAULT_KEEP_ALIVE_MINUTES,
  );
  const [actionNotificationMode, setActionNotificationMode] =
    useState<ActionNotificationMode>(DEFAULT_ACTION_NOTIFICATION_MODE);
  const [isAppForeground, setIsAppForeground] =
    useState<boolean>(initialIsForeground);
  const [focusInboxRequestKey, setFocusInboxRequestKey] = useState<number>(0);
  const [currentSourceUrl, setCurrentSourceUrl] = useState<string>(
    ANTIGRAVITY_DASHBOARD_URL,
  );
  const [stage, setStage] = useState<AuthFlowStage>('hydrating');
  const [hasNetworkError, setHasNetworkError] = useState<boolean>(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [drawerInitialMode, setDrawerInitialMode] =
    useState<DrawerMode>('inbox');
  const [isInboxRefreshing, setIsInboxRefreshing] = useState<boolean>(false);
  const [inboxSnapshot, setInboxSnapshot] =
    useState<InboxSnapshot>(EMPTY_INBOX_SNAPSHOT);
  const [webViewInstanceKey, setWebViewInstanceKey] = useState<number>(1);
  const [resetRequest, setResetRequest] = useState<{
    reason: 'signout' | 'recovery';
    attempt: number;
  } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [initializationError, setInitializationError] = useState(false);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [pageError, setPageError] = useState<string | null>(null);
  const [rawKeyboardHeight, setRawKeyboardHeight] = useState<number>(0);
  const [rootLayoutHeight, setRootLayoutHeight] = useState<number>(0);

  const syncCookiesToVault = useCallback(async () => {
    if (!hydratedRef.current || isResettingSessionRef.current) return;
    await backupCookiesFromWebView();
  }, []);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    keepAliveMinutesRef.current = keepAliveMinutes;
  }, [keepAliveMinutes]);

  useEffect(() => {
    actionNotificationModeRef.current = actionNotificationMode;
  }, [actionNotificationMode]);

  useEffect(() => {
    inboxSnapshotRef.current = inboxSnapshot;
  }, [inboxSnapshot]);

  const checkPost2faSessionAndAdvance = useCallback(async () => {
    if (stageRef.current !== 'authenticating') {
      return;
    }
    const currentSig = await getGoogleSessionSignature();
    if (baselineAuthSigRef.current === null) {
      baselineAuthSigRef.current = currentSig;
      return;
    }
    if (currentSig.length > 0 && currentSig !== baselineAuthSigRef.current) {
      baselineAuthSigRef.current = currentSig;
      await syncCookiesToVault();
      if (post2faReloadTimerRef.current) {
        clearTimeout(post2faReloadTimerRef.current);
      }
      post2faReloadTimerRef.current = setTimeout(() => {
        if (stageRef.current === 'authenticating') {
          void syncCookiesToVault();
          webViewRef.current?.reload();
        }
      }, 1800);
      (post2faReloadTimerRef.current as { unref?: () => void })?.unref?.();
    }
  }, [syncCookiesToVault]);

  // Step 1: Hydrate cookies from hardware-backed Keychain / Keystore before first WebView mount
  useEffect(() => {
    if (!isInitialUrlResolved || isHydrated) {
      return;
    }

    let isMounted = true;

    async function initializeSession() {
      // Complete hydration (including any interrupted-sign-out wipe) before reading
      // persisted URL or keep-alive preferences.
      const restoredCount = await hydrateCookiesToWebView();
      const [
        savedUrl,
        savedKeepAliveMinutes,
        savedActionNotificationMode,
        sessionSignature,
      ] = await Promise.all([
        getLastActiveUrl(),
        getKeepAliveMinutes(),
        getActionNotificationMode(),
        getGoogleSessionSignature(),
      ]);

      if (!isMounted) {
        return;
      }

      const initialTarget = incomingDeepLinkUrl ?? savedUrl;
      const initialRoute = extractActiveRouteFromUrl(initialTarget);
      activeInstanceUuidRef.current = initialRoute.instanceUuid;
      lastObservedOverviewInstanceRef.current = initialRoute.cascadeId
        ? null
        : initialRoute.instanceUuid;
      canReturnToOverviewRef.current = false;
      setKeepAliveMinutes(savedKeepAliveMinutes);
      keepAliveMinutesRef.current = savedKeepAliveMinutes;
      setActionNotificationMode(savedActionNotificationMode);
      actionNotificationModeRef.current = savedActionNotificationMode;
      setCurrentSourceUrl(initialTarget);
      currentNavUrlRef.current = initialTarget;
      if (incomingDeepLinkUrl) {
        onDeepLinkConsumed();
      }
      setStage(
        restoredCount > 0 && sessionSignature.length > 0
          ? 'authenticated'
          : 'authenticating',
      );
      hydratedRef.current = true;
      setIsHydrated(true);
    }

    initializeSession().catch(() => {
      if (isMounted) setInitializationError(true);
    });

    return () => {
      isMounted = false;
    };
  }, [
    incomingDeepLinkUrl,
    isHydrated,
    isInitialUrlResolved,
    onDeepLinkConsumed,
    initializationAttempt,
  ]);

  const recordActiveRouteForBackNavigation = useCallback(
    (instanceUuid: string | null, cascadeId: string | null) => {
      if (!instanceUuid) {
        lastObservedOverviewInstanceRef.current = null;
        canReturnToOverviewRef.current = false;
        return;
      }
      if (!cascadeId) {
        lastObservedOverviewInstanceRef.current = instanceUuid;
        canReturnToOverviewRef.current = false;
        return;
      }
      canReturnToOverviewRef.current =
        lastObservedOverviewInstanceRef.current === instanceUuid;
    },
    [],
  );

  // Step 2a: Register document-start scroll restoration for cross-origin workstation iframes on Android
  useEffect(() => {
    if (
      Platform.OS !== 'android' ||
      !isHydrated ||
      isResettingSessionRef.current ||
      resetRequest
    ) {
      return;
    }
    void installNativeDocumentStartScript?.(PROJECT_OVERVIEW_SCROLL_SCRIPT);
  }, [isHydrated, resetRequest, webViewInstanceKey]);

  const requestNotificationPermissionIfNeeded = useCallback(() => {
    if (notificationPermissionRequestedRef.current) {
      return;
    }
    if (Platform.OS === 'ios') {
      notificationPermissionRequestedRef.current = true;
      void requestNativeNotificationPermission?.();
      return;
    }
    if (
      Platform.OS !== 'android' ||
      typeof Platform.Version !== 'number' ||
      Platform.Version < 33
    ) {
      return;
    }
    notificationPermissionRequestedRef.current = true;
    const permission = 'android.permission.POST_NOTIFICATIONS' as any;
    void (async () => {
      try {
        const alreadyGranted = await PermissionsAndroid?.check?.(permission);
        if (!alreadyGranted) {
          await PermissionsAndroid?.request?.(permission);
        }
      } catch {
        // Ignore permission request errors on restricted profiles/ROMs.
      }
    })();
  }, []);

  // Step 2b: Synchronize bounded background keep-alive settings with native Android/iOS controllers
  useEffect(() => {
    const keepAliveEligible =
      isHydrated &&
      !isResettingSessionRef.current &&
      !resetRequest &&
      keepAliveMinutes > 0 &&
      stage === 'authenticated';
    const notificationsEligible =
      isHydrated &&
      !isResettingSessionRef.current &&
      !resetRequest &&
      actionNotificationMode !== 'off' &&
      stage === 'authenticated';
    const effectiveMinutes = keepAliveEligible ? keepAliveMinutes : 0;

    void configureNativeKeepAlive?.(
      keepAliveEligible,
      effectiveMinutes,
      keepAliveEligible,
    );

    if (isHydrated && !resetRequest) {
      webViewRef.current?.injectJavaScript(
        buildKeepAliveWebLockScript(keepAliveEligible),
      );
    }

    if (keepAliveEligible || notificationsEligible) {
      requestNotificationPermissionIfNeeded();
    }
  }, [
    actionNotificationMode,
    isHydrated,
    keepAliveMinutes,
    requestNotificationPermissionIfNeeded,
    resetRequest,
    stage,
  ]);

  const clearInboxTimers = useCallback(() => {
    for (const pending of pendingFastNavRef.current.values()) {
      clearTimeout(pending.timer);
    }
    pendingFastNavRef.current.clear();
    if (inboxRefreshTimeoutRef.current) {
      clearTimeout(inboxRefreshTimeoutRef.current);
      inboxRefreshTimeoutRef.current = null;
    }
    if (resumeReadSettleTimerRef.current) {
      clearTimeout(resumeReadSettleTimerRef.current);
      resumeReadSettleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearInboxTimers();
      void configureNativeKeepAlive?.(false, 0, false);
      void clearNativeActionNotification?.();
    };
  }, [clearInboxTimers]);

  const recomputeSnapshotWithLocalState = useCallback(
    (overrides?: {
      activeInstanceUuid?: string | null;
      activeCascadeId?: string | null;
      isAppForeground?: boolean;
      isDrawerOpen?: boolean;
    }) => {
      setInboxSnapshot((previous) => {
        const effectiveActiveInstanceUuid =
          overrides && 'activeInstanceUuid' in overrides
            ? (overrides.activeInstanceUuid ?? null)
            : previous.activeInstanceUuid;
        const effectiveActiveCascadeId =
          overrides && 'activeCascadeId' in overrides
            ? (overrides.activeCascadeId ?? null)
            : previous.activeCascadeId;
        const effectiveForeground =
          overrides?.isAppForeground ?? isAppForegroundRef.current;
        const effectiveDrawerOpen =
          overrides?.isDrawerOpen ?? isDrawerOpenRef.current;

        const rawMsg = lastSnapshotMessageRef.current;
        if (rawMsg) {
          return buildInboxSnapshot(
            {
              ...rawMsg,
              activeInstanceUuid: effectiveActiveInstanceUuid,
              activeCascadeId: effectiveActiveCascadeId,
            },
            locallyReadMapRef.current,
            currentNavUrlRef.current,
            effectiveForeground,
            completedUnreadMapRef.current,
            effectiveDrawerOpen,
          );
        }

        if (previous.threads.length === 0) {
          return previous;
        }
        return applyLocalStateToSnapshot(previous, {
          activeInstanceUuid: effectiveActiveInstanceUuid,
          activeCascadeId: effectiveActiveCascadeId,
          locallyReadAtByThreadId: locallyReadMapRef.current,
          isAppForeground: effectiveForeground,
          isDrawerOpen: effectiveDrawerOpen,
        });
      });
    },
    [],
  );

  const markThreadReadInWorkstationClock = useCallback(
    (
      thread: InboxThreadItem | undefined,
      syncRemoteMode: 'none' | 'unread_only' | 'dismissible' = 'none',
    ) => {
      if (!thread) {
        return;
      }
      // Never stamp a running or approval-waiting thread as read before its run finishes.
      if (
        thread.attentionKind === 'running' ||
        thread.attentionKind === 'approval'
      ) {
        return;
      }
      if (
        Object.prototype.hasOwnProperty.call(
          completedUnreadMapRef.current,
          thread.id,
        )
      ) {
        delete completedUnreadMapRef.current[thread.id];
      }
      const stampMs =
        thread.lastModifiedAtMs > 0
          ? Math.max(
              locallyReadMapRef.current[thread.id] ?? 0,
              thread.lastModifiedAtMs,
            )
          : Math.max(locallyReadMapRef.current[thread.id] ?? 0, 1);
      recordBoundedLocalRead(locallyReadMapRef.current, thread.id, stampMs);

      const hasServerUnread =
        thread.attentionKind === 'unread' ||
        (thread.lastModifiedAtMs > 0 &&
          thread.lastModifiedAtMs > thread.lastUserViewAtMs);
      const shouldSyncRemote =
        thread.source === 'remote-control' &&
        (syncRemoteMode === 'dismissible'
          ? hasServerUnread || thread.attentionKind === 'error'
          : syncRemoteMode === 'unread_only'
            ? hasServerUnread
            : false);
      if (shouldSyncRemote) {
        const readAtIso = new Date(
          thread.lastModifiedAtMs > 0
            ? Math.max(thread.lastModifiedAtMs, thread.lastUserViewAtMs) + 1
            : Date.now(),
        ).toISOString();
        webViewRef.current?.injectJavaScript(
          buildMarkThreadReadScript({
            instanceUuid: thread.instanceUuid,
            cascadeId: thread.cascadeId,
            readAtIso,
          }),
        );
      }
    },
    [],
  );

  // Step 3: Flush & back up cookies whenever the app transitions to background/inactive,
  // and wake up active sessions + 2-Step Verification immediately when returning to active
  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    const subscription = AppState.addEventListener(
      'change',
      (nextAppState: AppStateStatus) => {
        if (nextAppState === 'background' || nextAppState === 'inactive') {
          if (resumeReadSettleTimerRef.current) {
            clearTimeout(resumeReadSettleTimerRef.current);
            resumeReadSettleTimerRef.current = null;
          }
          if (nextAppState === 'background') {
            wasBackgroundedRef.current = true;
          }
          if (isAppForegroundRef.current) {
            const currentSnap = inboxSnapshotRef.current;
            if (!isDrawerOpenRef.current) {
              const activeThread = findMatchingThread(
                currentSnap.threads,
                currentSnap.activeInstanceUuid,
                currentSnap.activeCascadeId,
              );
              markThreadReadInWorkstationClock(activeThread, 'none');
            }
            isAppForegroundRef.current = false;
            setIsAppForeground(false);
            recomputeSnapshotWithLocalState({
              isAppForeground: false,
              isDrawerOpen: isDrawerOpenRef.current,
            });
          }
          void syncCookiesToVault();
        } else if (nextAppState === 'active') {
          const returningFromBackground = wasBackgroundedRef.current;
          wasBackgroundedRef.current = false;
          if (!isAppForegroundRef.current) {
            isAppForegroundRef.current = true;
            setIsAppForeground(true);
            recomputeSnapshotWithLocalState({
              isAppForeground: true,
              isDrawerOpen: isDrawerOpenRef.current,
            });
            if (resumeReadSettleTimerRef.current) {
              clearTimeout(resumeReadSettleTimerRef.current);
            }
            // Wait briefly before permanently stamping the foreground thread as read so an
            // incoming `antigravity-remote://inbox` or cross-thread notification deep link
            // arriving alongside `Activity.onResume` never loses the finished thread's blue state.
            resumeReadSettleTimerRef.current = setTimeout(() => {
              resumeReadSettleTimerRef.current = null;
              if (
                isResettingSessionRef.current ||
                !isAppForegroundRef.current ||
                isDrawerOpenRef.current
              ) {
                return;
              }
              const settledSnap = inboxSnapshotRef.current;
              const settledThread = findMatchingThread(
                settledSnap.threads,
                settledSnap.activeInstanceUuid,
                settledSnap.activeCascadeId,
              );
              markThreadReadInWorkstationClock(settledThread, 'unread_only');
            }, 250);
            (
              resumeReadSettleTimerRef.current as { unref?: () => void }
            )?.unref?.();
          }
          if (hydratedRef.current && !isResettingSessionRef.current) {
            if (
              returningFromBackground ||
              stageRef.current === 'authenticating'
            ) {
              webViewRef.current?.injectJavaScript(RESUME_WAKEUP_SCRIPT);
            }
            if (returningFromBackground) {
              webViewRef.current?.injectJavaScript(
                buildKeepAliveWebLockScript(
                  keepAliveMinutesRef.current > 0 &&
                    stageRef.current === 'authenticated',
                ),
              );
            }
            if (stageRef.current === 'authenticated') {
              webViewRef.current?.injectJavaScript(buildInboxRefreshScript());
            }
          }
          void syncCookiesToVault();
          if (stageRef.current === 'authenticating') {
            void checkPost2faSessionAndAdvance();

            const urlAtResume = currentNavUrlRef.current;
            if (isPushPromptOrCookieSyncUrl(urlAtResume)) {
              if (resumeTimer) {
                clearTimeout(resumeTimer);
              }
              resumeTimer = setTimeout(() => {
                if (
                  stageRef.current === 'authenticating' &&
                  currentNavUrlRef.current === urlAtResume
                ) {
                  void syncCookiesToVault();
                  webViewRef.current?.reload();
                }
              }, 2200);
              (resumeTimer as { unref?: () => void })?.unref?.();
            }
          }
        }
      },
    );

    return () => {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
      }
      subscription.remove();
    };
  }, [
    checkPost2faSessionAndAdvance,
    markThreadReadInWorkstationClock,
    recomputeSnapshotWithLocalState,
    syncCookiesToVault,
  ]);

  // Step 3b: Poll for newly issued `.google.com` session cookies while on Google Sign-In
  // so that if the post-2FA redirect ever stalls on the loading bar, it auto-reloads
  useEffect(() => {
    if (stage !== 'authenticating') {
      baselineAuthSigRef.current = null;
      if (post2faReloadTimerRef.current) {
        clearTimeout(post2faReloadTimerRef.current);
        post2faReloadTimerRef.current = null;
      }
      return;
    }

    void checkPost2faSessionAndAdvance();
    const intervalId = setInterval(() => {
      void checkPost2faSessionAndAdvance();
    }, 1500);
    (intervalId as { unref?: () => void })?.unref?.();

    return () => {
      clearInterval(intervalId);
      if (post2faReloadTimerRef.current) {
        clearTimeout(post2faReloadTimerRef.current);
        post2faReloadTimerRef.current = null;
      }
    };
  }, [stage, checkPost2faSessionAndAdvance]);

  // Step 4: Adapt WebView height when software keyboard opens/closes so bottom
  // chat inputs in Antigravity Remote are never covered by the keyboard
  useEffect(() => {
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent =
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onKeyboardShow = (event: KeyboardEvent) => {
      const height = event?.endCoordinates?.height ?? 0;
      setRawKeyboardHeight(height > 0 ? height : 0);
      webViewRef.current?.injectJavaScript(KEYBOARD_ADAPTATION_SCRIPT);
    };

    const onKeyboardHide = () => {
      setRawKeyboardHeight(0);
    };

    const showSub = Keyboard.addListener(showEvent, onKeyboardShow);
    const hideSub = Keyboard.addListener(hideEvent, onKeyboardHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Step 5: Android hardware Back button closes the left drawer first, then navigates WebView history
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const onHardwareBackPress = (): boolean => {
      if (isDrawerOpenRef.current) {
        isDrawerOpenRef.current = false;
        setIsDrawerOpen(false);
        if (isAppForegroundRef.current) {
          const currentSnap = inboxSnapshotRef.current;
          const activeThread = findMatchingThread(
            currentSnap.threads,
            currentSnap.activeInstanceUuid,
            currentSnap.activeCascadeId,
          );
          markThreadReadInWorkstationClock(activeThread, 'unread_only');
        }
        recomputeSnapshotWithLocalState({
          isDrawerOpen: false,
        });
        return true;
      }
      if (canGoBackRef.current && webViewRef.current) {
        canReturnToOverviewRef.current = false;
        webViewRef.current.goBack();
        return true;
      }
      if (canReturnToOverviewRef.current && webViewRef.current) {
        canReturnToOverviewRef.current = false;
        webViewRef.current.injectJavaScript(buildReturnToOverviewScript());
        return true;
      }
      return false;
    };

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      onHardwareBackPress,
    );

    return () => {
      subscription.remove();
    };
  }, [markThreadReadInWorkstationClock, recomputeSnapshotWithLocalState]);

  const handleRootLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measuredHeight = event?.nativeEvent?.layout?.height ?? 0;
      if (measuredHeight <= 0) {
        return;
      }
      setRootLayoutHeight(measuredHeight);
      if (
        rawKeyboardHeight === 0 ||
        measuredHeight > uncompressedHeightRef.current
      ) {
        uncompressedHeightRef.current = measuredHeight;
      }
    },
    [rawKeyboardHeight],
  );

  // Calculate how much bottom inset the WebView needs when the keyboard is open.
  // On Android 15/16 (targetSdk 36) edge-to-edge and iOS, the native root view
  // does not shrink automatically (`nativeShrinkAmount === 0`), so we pad the
  // bottom of `webViewWrapper` by the exact keyboard height minus safe area bottom.
  const nativeShrinkAmount =
    uncompressedHeightRef.current > 0 && rootLayoutHeight > 0
      ? Math.max(0, uncompressedHeightRef.current - rootLayoutHeight)
      : 0;

  const keyboardBottomPadding =
    rawKeyboardHeight > 0
      ? Math.max(0, rawKeyboardHeight - nativeShrinkAmount - insets.bottom)
      : 0;

  const isKeyboardVisible = rawKeyboardHeight > 0;

  const beginSessionReset = useCallback(
    (reason: 'signout' | 'recovery') => {
      if (isResettingSessionRef.current) return;
      isResettingSessionRef.current = true;
      suspendSessionPersistence();
      void configureNativeKeepAlive?.(false, 0, false);
      void clearNativeActionNotification?.();
      lastActionNotifSigRef.current = 'none';
      previousOpenActionIdsRef.current = new Set();
      knownRunningThreadIdsRef.current = new Set();
      completedUnreadMapRef.current = {};
      lastSnapshotMessageRef.current = null;
      clearInboxTimers();
      locallyReadMapRef.current = {};
      activeInstanceUuidRef.current = null;
      lastObservedOverviewInstanceRef.current = null;
      canReturnToOverviewRef.current = false;
      webViewRef.current?.stopLoading();
      stageRef.current = 'hydrating';
      setStage('hydrating');
      isDrawerOpenRef.current = false;
      setIsDrawerOpen(false);
      setIsInboxRefreshing(false);
      setInboxSnapshot(EMPTY_INBOX_SNAPSHOT);
      setResetError(null);
      setResetRequest({ reason, attempt: 0 });
    },
    [clearInboxTimers],
  );

  // Effects run after the reset screen has unmounted the old WebView. No page
  // may repopulate native cookies or DOM storage while cleanup is in progress.
  useEffect(() => {
    if (!resetRequest) return;
    let mounted = true;
    clearSession()
      .then(() => {
        if (!mounted) return;
        setHasNetworkError(false);
        setPageError(null);
        renderProcessDeadRef.current = false;
        renderRecoveryTimestampsRef.current = [];
        setCurrentSourceUrl(ANTIGRAVITY_DASHBOARD_URL);
        currentNavUrlRef.current = ANTIGRAVITY_DASHBOARD_URL;
        canGoBackRef.current = false;
        if (resetRequest.reason === 'signout') {
          cookieRecoveryAttemptsRef.current = 0;
          notificationPermissionRequestedRef.current = false;
          setKeepAliveMinutes(DEFAULT_KEEP_ALIVE_MINUTES);
          keepAliveMinutesRef.current = DEFAULT_KEEP_ALIVE_MINUTES;
          setActionNotificationMode(DEFAULT_ACTION_NOTIFICATION_MODE);
          actionNotificationModeRef.current = DEFAULT_ACTION_NOTIFICATION_MODE;
        }
        setWebViewInstanceKey((prev) => prev + 1);
        setStage('authenticating');
        isResettingSessionRef.current = false;
        resumeSessionPersistence();
        setResetRequest(null);
      })
      .catch(() => {
        if (mounted)
          setResetError(
            'Unable to finish clearing this session. Retry to securely sign out.',
          );
      });
    return () => {
      mounted = false;
    };
  }, [resetRequest]);

  const recoverFromCookieMismatch = useCallback(() => {
    if (isResettingSessionRef.current) return;
    if (cookieRecoveryAttemptsRef.current >= 2) {
      setPageError(
        'Automatic sign-in recovery stopped. Pull open the left Settings drawer and sign out to start again.',
      );
      setHasNetworkError(true);
      setStage('offline');
      return;
    }
    cookieRecoveryAttemptsRef.current++;
    beginSessionReset('recovery');
  }, [beginSessionReset]);

  const handleShouldStartLoadWithRequest = useCallback(
    (request: ShouldStartLoadRequest): boolean => {
      if (isResettingSessionRef.current) return false;
      // Internal documents are needed by auth subframes, never as top-level pages.
      if (isInternalWebViewSchemeUrl(request.url))
        return request.isTopFrame === false;
      const validation = validateNavigationUrl(request.url);
      if (!validation.isValid || !validation.normalizedUrl) return false;
      if (request.isTopFrame === false && isAllowedAuthSubframeUrl(request.url))
        return true;
      if (
        request.isTopFrame === false &&
        isAllowedRemoteClientSubframeUrl(request.url)
      )
        return true;
      if (
        request.isTopFrame !== false &&
        isGoogleCookieErrorUrl(validation.normalizedUrl)
      ) {
        recoverFromCookieMismatch();
        return false;
      }
      if (validation.isAllowedInApp) return true;
      if (request.isTopFrame !== false) {
        void Linking.openURL(validation.normalizedUrl).catch(() => undefined);
      }
      return false;
    },
    [recoverFromCookieMismatch],
  );

  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      if (isResettingSessionRef.current) return;
      const validation = validateNavigationUrl(navState.url);
      if (!validation.isAllowedInApp || !validation.normalizedUrl) return;
      canGoBackRef.current = Boolean(navState.canGoBack);
      currentNavUrlRef.current = validation.normalizedUrl;
      if (isGoogleCookieErrorUrl(validation.normalizedUrl)) {
        recoverFromCookieMismatch();
        return;
      }
      if (validation.isAuthHost) {
        setStage('authenticating');
        if (!navState.loading) void checkPost2faSessionAndAdvance();
        return;
      }
      if (
        new URL(validation.normalizedUrl).hostname === 'antigravity.google.com'
      ) {
        void saveLastActiveUrl(validation.normalizedUrl);
        const route = extractActiveRouteFromUrl(validation.normalizedUrl);
        activeInstanceUuidRef.current = route.instanceUuid;
        recordActiveRouteForBackNavigation(route.instanceUuid, route.cascadeId);
        if (
          isAppForegroundRef.current &&
          !isDrawerOpenRef.current &&
          route.instanceUuid &&
          route.cascadeId
        ) {
          const activeThread = findMatchingThread(
            inboxSnapshotRef.current.threads,
            route.instanceUuid,
            route.cascadeId,
          );
          markThreadReadInWorkstationClock(activeThread, 'unread_only');
        }
        recomputeSnapshotWithLocalState({
          activeInstanceUuid: route.instanceUuid,
          activeCascadeId: route.cascadeId,
        });
        if (!navState.loading) {
          setHasNetworkError(false);
          setPageError(null);
          void syncCookiesToVault();
          // A loading dashboard can immediately redirect back to a broken login.
          // Reset the retry budget only after a completed page with session cookies.
          void getGoogleSessionSignature().then((signature) => {
            if (
              signature &&
              !isResettingSessionRef.current &&
              currentNavUrlRef.current === validation.normalizedUrl
            ) {
              cookieRecoveryAttemptsRef.current = 0;
              renderRecoveryTimestampsRef.current = [];
              renderProcessDeadRef.current = false;
              setStage('authenticated');
              webViewRef.current?.injectJavaScript(INBOX_BRIDGE_SCRIPT);
            }
          });
        }
      }
    },
    [
      checkPost2faSessionAndAdvance,
      markThreadReadInWorkstationClock,
      recomputeSnapshotWithLocalState,
      recordActiveRouteForBackNavigation,
      recoverFromCookieMismatch,
      syncCookiesToVault,
    ],
  );

  const handleLoadStart = useCallback(() => {
    if (Platform.OS === 'android' && !isResettingSessionRef.current) {
      void installNativeDocumentStartScript?.(PROJECT_OVERVIEW_SCROLL_SCRIPT);
    }
  }, []);

  const handleLoadEnd = useCallback(() => {
    void syncCookiesToVault();
    webViewRef.current?.injectJavaScript(KEYBOARD_ADAPTATION_SCRIPT);
    webViewRef.current?.injectJavaScript(PROJECT_OVERVIEW_SCROLL_SCRIPT);
    webViewRef.current?.injectJavaScript(INBOX_BRIDGE_SCRIPT);
    webViewRef.current?.injectJavaScript(
      buildKeepAliveWebLockScript(
        keepAliveMinutesRef.current > 0 && stageRef.current === 'authenticated',
      ),
    );
  }, [syncCookiesToVault]);

  const handleWebProcessTerminated = useCallback(() => {
    if (isResettingSessionRef.current) return;
    const now = Date.now();
    const recent = renderRecoveryTimestampsRef.current.filter(
      (timestamp) => now - timestamp < RENDER_RECOVERY_WINDOW_MS,
    );
    if (recent.length >= MAX_RENDER_RECOVERY_ATTEMPTS) {
      renderRecoveryTimestampsRef.current = recent;
      renderProcessDeadRef.current = true;
      setPageError(
        'The remote session view stopped unexpectedly. Tap Reconnect to reload.',
      );
      setHasNetworkError(true);
      setStage('offline');
      return;
    }
    recent.push(now);
    renderRecoveryTimestampsRef.current = recent;
    renderProcessDeadRef.current = false;
    setHasNetworkError(false);
    setPageError(null);
    setCurrentSourceUrl(currentNavUrlRef.current);
    setWebViewInstanceKey((prev) => prev + 1);
  }, []);

  const handleReloadSession = useCallback(() => {
    if (isResettingSessionRef.current) return;
    setHasNetworkError(false);
    setPageError(null);
    if (stageRef.current === 'offline') {
      setStage('authenticating');
    }
    void syncCookiesToVault();
    if (renderProcessDeadRef.current) {
      renderProcessDeadRef.current = false;
      renderRecoveryTimestampsRef.current = [];
      setCurrentSourceUrl(currentNavUrlRef.current);
      setWebViewInstanceKey((prev) => prev + 1);
      return;
    }
    webViewRef.current?.reload();
  }, [syncCookiesToVault]);

  const handleChangeKeepAliveMinutes = useCallback(
    (minutes: KeepAliveMinutes) => {
      if (isResettingSessionRef.current) return;
      keepAliveMinutesRef.current = minutes;
      setKeepAliveMinutes(minutes);
      void saveKeepAliveMinutes(minutes);
      if (minutes > 0) {
        requestNotificationPermissionIfNeeded();
      }
    },
    [requestNotificationPermissionIfNeeded],
  );

  const handleChangeActionNotificationMode = useCallback(
    (mode: ActionNotificationMode) => {
      if (isResettingSessionRef.current) return;
      actionNotificationModeRef.current = mode;
      setActionNotificationMode(mode);
      void saveActionNotificationMode(mode);
      if (mode === 'off') {
        lastActionNotifSigRef.current = 'none';
        previousOpenActionIdsRef.current = new Set();
        void clearNativeActionNotification?.();
        return;
      }
      notificationPermissionRequestedRef.current = false;
      requestNotificationPermissionIfNeeded();
      if (keepAliveMinutesRef.current === 0) {
        keepAliveMinutesRef.current = AUTO_NOTIFICATION_KEEP_ALIVE_MINUTES;
        setKeepAliveMinutes(AUTO_NOTIFICATION_KEEP_ALIVE_MINUTES);
        void saveKeepAliveMinutes(AUTO_NOTIFICATION_KEEP_ALIVE_MINUTES);
      }
    },
    [requestNotificationPermissionIfNeeded],
  );

  const handleNavigateToUrl = useCallback((targetUrl: string) => {
    if (isResettingSessionRef.current) return;
    const validation = validateNavigationUrl(targetUrl);
    if (!validation.isAllowedInApp || !validation.normalizedUrl) return;
    setHasNetworkError(false);
    setPageError(null);
    renderProcessDeadRef.current = false;
    renderRecoveryTimestampsRef.current = [];
    if (stageRef.current === 'offline') {
      setStage('authenticating');
    }
    setCurrentSourceUrl(validation.normalizedUrl);
    currentNavUrlRef.current = validation.normalizedUrl;
    const targetRoute = extractActiveRouteFromUrl(validation.normalizedUrl);
    activeInstanceUuidRef.current = targetRoute.instanceUuid;
    lastObservedOverviewInstanceRef.current = targetRoute.cascadeId
      ? null
      : targetRoute.instanceUuid;
    canReturnToOverviewRef.current = false;
    // Explicit native navigation must work even when the source prop already
    // contains this URL and the browser has since navigated somewhere else.
    setWebViewInstanceKey((prev) => prev + 1);
    void saveLastActiveUrl(validation.normalizedUrl);
  }, []);

  const handleSignOut = useCallback(
    () => beginSessionReset('signout'),
    [beginSessionReset],
  );

  const armInboxRefreshTimeout = useCallback(() => {
    if (inboxRefreshTimeoutRef.current) {
      clearTimeout(inboxRefreshTimeoutRef.current);
    }
    inboxRefreshTimeoutRef.current = setTimeout(() => {
      inboxRefreshTimeoutRef.current = null;
      setIsInboxRefreshing(false);
    }, INBOX_REFRESH_TIMEOUT_MS);
    (inboxRefreshTimeoutRef.current as { unref?: () => void })?.unref?.();
  }, []);

  const handleRefreshInbox = useCallback(
    (forceUsage: boolean = false) => {
      if (isResettingSessionRef.current) return;
      setIsInboxRefreshing(true);
      armInboxRefreshTimeout();
      webViewRef.current?.injectJavaScript(INBOX_BRIDGE_SCRIPT);
      webViewRef.current?.injectJavaScript(buildInboxRefreshScript(forceUsage));
    },
    [armInboxRefreshTimeout],
  );

  const handleOpenDrawer = useCallback(
    (preferredMode?: DrawerMode) => {
      if (isResettingSessionRef.current) return;
      if (resumeReadSettleTimerRef.current) {
        clearTimeout(resumeReadSettleTimerRef.current);
        resumeReadSettleTimerRef.current = null;
      }
      const resolvedMode: DrawerMode =
        preferredMode ??
        (stageRef.current === 'authenticated' ? 'inbox' : 'settings');
      setDrawerInitialMode(resolvedMode);
      isDrawerOpenRef.current = true;
      setIsDrawerOpen(true);
      recomputeSnapshotWithLocalState({ isDrawerOpen: true });
      if (stageRef.current === 'authenticated') {
        handleRefreshInbox(resolvedMode === 'usage');
      }
    },
    [handleRefreshInbox, recomputeSnapshotWithLocalState],
  );

  const handleCloseDrawer = useCallback(() => {
    isDrawerOpenRef.current = false;
    setIsDrawerOpen(false);
    if (isAppForegroundRef.current) {
      const currentSnap = inboxSnapshotRef.current;
      const activeThread = findMatchingThread(
        currentSnap.threads,
        currentSnap.activeInstanceUuid,
        currentSnap.activeCascadeId,
      );
      markThreadReadInWorkstationClock(activeThread, 'unread_only');
    }
    recomputeSnapshotWithLocalState({ isDrawerOpen: false });
  }, [markThreadReadInWorkstationClock, recomputeSnapshotWithLocalState]);

  const handleMarkThreadRead = useCallback(
    (thread: InboxThreadItem) => {
      if (isResettingSessionRef.current) return;
      markThreadReadInWorkstationClock(thread, 'dismissible');
      recomputeSnapshotWithLocalState();
    },
    [markThreadReadInWorkstationClock, recomputeSnapshotWithLocalState],
  );

  const handleMarkAllRead = useCallback(() => {
    if (isResettingSessionRef.current) return;
    for (const thread of inboxSnapshot.threads) {
      if (
        thread.attentionKind !== 'unread' &&
        thread.attentionKind !== 'error'
      ) {
        continue;
      }
      markThreadReadInWorkstationClock(thread, 'dismissible');
    }
    recomputeSnapshotWithLocalState();
  }, [
    inboxSnapshot.threads,
    markThreadReadInWorkstationClock,
    recomputeSnapshotWithLocalState,
  ]);

  const handleSelectInboxThread = useCallback(
    (thread: InboxThreadItem) => {
      if (isResettingSessionRef.current) return;
      if (resumeReadSettleTimerRef.current) {
        clearTimeout(resumeReadSettleTimerRef.current);
        resumeReadSettleTimerRef.current = null;
      }
      isDrawerOpenRef.current = false;
      setIsDrawerOpen(false);

      markThreadReadInWorkstationClock(thread, 'unread_only');
      recomputeSnapshotWithLocalState({
        activeInstanceUuid: thread.instanceUuid,
        activeCascadeId: thread.cascadeId,
        isDrawerOpen: false,
      });

      const currentRoute = extractActiveRouteFromUrl(currentNavUrlRef.current);
      const isSameActiveInstance =
        currentRoute.instanceUuid === thread.instanceUuid ||
        activeInstanceUuidRef.current === thread.instanceUuid;
      if (
        thread.source === 'remote-control' &&
        isSameActiveInstance &&
        webViewRef.current
      ) {
        const requestId = `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const fallbackTimer = setTimeout(() => {
          pendingFastNavRef.current.delete(requestId);
          handleNavigateToUrl(thread.targetUrl);
        }, FAST_THREAD_NAV_FALLBACK_MS);
        (fallbackTimer as { unref?: () => void })?.unref?.();
        pendingFastNavRef.current.set(requestId, {
          timer: fallbackTimer,
          targetUrl: thread.targetUrl,
        });

        webViewRef.current.injectJavaScript(
          buildFastThreadSwitchScript({
            requestId,
            instanceUuid: thread.instanceUuid,
            childPath: thread.childPath,
            targetUrl: thread.targetUrl,
          }),
        );
        return;
      }

      handleNavigateToUrl(thread.targetUrl);
    },
    [
      handleNavigateToUrl,
      markThreadReadInWorkstationClock,
      recomputeSnapshotWithLocalState,
    ],
  );

  // Step 2: Handle incoming deep links and multi-action Inbox opens when mounted
  useEffect(() => {
    if (!isHydrated || isResettingSessionRef.current || !pendingOpenInbox) {
      return;
    }
    if (resumeReadSettleTimerRef.current) {
      clearTimeout(resumeReadSettleTimerRef.current);
      resumeReadSettleTimerRef.current = null;
    }
    setDrawerInitialMode('inbox');
    setFocusInboxRequestKey((prev) => prev + 1);
    isDrawerOpenRef.current = true;
    setIsDrawerOpen(true);
    recomputeSnapshotWithLocalState({ isDrawerOpen: true });
    if (stageRef.current === 'authenticated') {
      handleRefreshInbox();
    }
    onOpenInboxConsumed?.();
  }, [
    handleRefreshInbox,
    isHydrated,
    onOpenInboxConsumed,
    pendingOpenInbox,
    recomputeSnapshotWithLocalState,
    resetRequest,
  ]);

  useEffect(() => {
    if (!isHydrated || isResettingSessionRef.current || !incomingDeepLinkUrl) {
      return;
    }

    if (resumeReadSettleTimerRef.current) {
      clearTimeout(resumeReadSettleTimerRef.current);
      resumeReadSettleTimerRef.current = null;
    }

    const validation = validateNavigationUrl(incomingDeepLinkUrl);
    if (
      validation.isValid &&
      validation.normalizedUrl &&
      validation.isAllowedInApp
    ) {
      const targetRoute = extractActiveRouteFromUrl(validation.normalizedUrl);
      const matchingThread =
        stageRef.current === 'authenticated' &&
        !renderProcessDeadRef.current &&
        targetRoute.instanceUuid &&
        targetRoute.cascadeId
          ? findMatchingThread(
              inboxSnapshotRef.current.threads,
              targetRoute.instanceUuid,
              targetRoute.cascadeId,
            )
          : undefined;

      if (matchingThread) {
        handleSelectInboxThread(matchingThread);
      } else {
        isDrawerOpenRef.current = false;
        setIsDrawerOpen(false);
        if (targetRoute.instanceUuid && targetRoute.cascadeId) {
          recomputeSnapshotWithLocalState({
            activeInstanceUuid: targetRoute.instanceUuid,
            activeCascadeId: targetRoute.cascadeId,
            isDrawerOpen: false,
          });
        }
        if (validation.normalizedUrl !== currentNavUrlRef.current) {
          handleNavigateToUrl(validation.normalizedUrl);
        }
      }
    }
    onDeepLinkConsumed();
  }, [
    handleNavigateToUrl,
    handleSelectInboxThread,
    incomingDeepLinkUrl,
    isHydrated,
    onDeepLinkConsumed,
    recomputeSnapshotWithLocalState,
    resetRequest,
  ]);

  // Step 2c: Synchronize the single live OS action-required notification
  useEffect(() => {
    if (!isHydrated || isResettingSessionRef.current || resetRequest) {
      return;
    }
    if (
      stage === 'authenticated' &&
      actionNotificationMode !== 'off' &&
      inboxSnapshot.fetchedAtMs === 0
    ) {
      return;
    }

    const syncResult = buildActionNotificationSyncState({
      stage,
      mode: actionNotificationMode,
      threads: inboxSnapshot.threads,
      isAppForeground,
      isDrawerOpen,
      previousOpenThreadIds: previousOpenActionIdsRef.current,
    });
    previousOpenActionIdsRef.current = syncResult.openThreadIds;

    if (syncResult.signature === lastActionNotifSigRef.current) {
      return;
    }
    lastActionNotifSigRef.current = syncResult.signature;

    if (!syncResult.notification) {
      void clearNativeActionNotification?.();
      return;
    }

    void syncNativeActionNotification?.(syncResult.notification);
  }, [
    actionNotificationMode,
    inboxSnapshot.fetchedAtMs,
    inboxSnapshot.threads,
    isAppForeground,
    isDrawerOpen,
    isHydrated,
    resetRequest,
    stage,
  ]);

  const syncVerifiedActiveHostUrl = useCallback((rawActiveUrl?: string) => {
    if (typeof rawActiveUrl !== 'string' || !rawActiveUrl) return;
    const activeValidation = validateNavigationUrl(rawActiveUrl);
    if (
      activeValidation.isAllowedInApp &&
      activeValidation.normalizedUrl &&
      new URL(activeValidation.normalizedUrl).hostname ===
        'antigravity.google.com'
    ) {
      currentNavUrlRef.current = activeValidation.normalizedUrl;
      void saveLastActiveUrl(activeValidation.normalizedUrl);
    }
  }, []);

  const handleWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (isResettingSessionRef.current) return;
      const senderUrl = event?.nativeEvent?.url;
      if (typeof senderUrl !== 'string' || !senderUrl) return;
      const senderValidation = validateNavigationUrl(senderUrl);
      if (!senderValidation.isValid || !senderValidation.normalizedUrl) return;
      if (
        new URL(senderValidation.normalizedUrl).hostname !==
        'antigravity.google.com'
      ) {
        return;
      }

      const message = parseInboxBridgeMessage(event.nativeEvent.data);
      if (!message) return;

      switch (message.type) {
        case 'AGY_INBOX_SNAPSHOT': {
          if (inboxRefreshTimeoutRef.current) {
            clearTimeout(inboxRefreshTimeoutRef.current);
            inboxRefreshTimeoutRef.current = null;
          }
          setIsInboxRefreshing(false);
          syncVerifiedActiveHostUrl(message.activeUrl);
          lastSnapshotMessageRef.current = message;
          const built = reconcileRunningThreadTransitions({
            message,
            knownRunningThreadIds: knownRunningThreadIdsRef.current,
            completedUnreadAtByThreadId: completedUnreadMapRef.current,
            locallyReadAtByThreadId: locallyReadMapRef.current,
            fallbackActiveUrl: currentNavUrlRef.current,
            isAppForeground: isAppForegroundRef.current,
            isDrawerOpen: isDrawerOpenRef.current,
          });
          lastSnapshotMessageRef.current = {
            ...message,
            activeInstanceUuid: built.activeInstanceUuid,
            activeCascadeId: built.activeCascadeId,
          };
          activeInstanceUuidRef.current = built.activeInstanceUuid;
          recordActiveRouteForBackNavigation(
            built.activeInstanceUuid,
            built.activeCascadeId,
          );
          if (
            isAppForegroundRef.current &&
            !isDrawerOpenRef.current &&
            !resumeReadSettleTimerRef.current &&
            built.activeInstanceUuid &&
            built.activeCascadeId
          ) {
            const activeThread = findMatchingThread(
              built.threads,
              built.activeInstanceUuid,
              built.activeCascadeId,
            );
            markThreadReadInWorkstationClock(activeThread, 'none');
          }
          setInboxSnapshot(built);
          break;
        }

        case 'AGY_INBOX_ACTIVE_ROUTE': {
          syncVerifiedActiveHostUrl(message.activeUrl);
          const {
            instanceUuid: activeInstanceUuid,
            cascadeId: activeCascadeId,
          } = resolveActiveRouteFromBridgeMessage(
            message,
            currentNavUrlRef.current,
          );
          activeInstanceUuidRef.current = activeInstanceUuid;
          recordActiveRouteForBackNavigation(
            activeInstanceUuid,
            activeCascadeId,
          );
          if (lastSnapshotMessageRef.current) {
            lastSnapshotMessageRef.current = {
              ...lastSnapshotMessageRef.current,
              activeInstanceUuid,
              activeCascadeId,
            };
          }
          if (
            isAppForegroundRef.current &&
            !isDrawerOpenRef.current &&
            !resumeReadSettleTimerRef.current &&
            activeInstanceUuid &&
            activeCascadeId
          ) {
            const activeThread = findMatchingThread(
              inboxSnapshotRef.current.threads,
              activeInstanceUuid,
              activeCascadeId,
            );
            markThreadReadInWorkstationClock(activeThread, 'unread_only');
          }
          recomputeSnapshotWithLocalState({
            activeInstanceUuid,
            activeCascadeId,
          });
          break;
        }

        case 'AGY_INBOX_REALTIME_HINT': {
          setIsInboxRefreshing(true);
          armInboxRefreshTimeout();
          break;
        }

        case 'AGY_INBOX_FAST_NAV_RESULT': {
          const pending = pendingFastNavRef.current.get(message.requestId);
          if (!pending) {
            break;
          }
          clearTimeout(pending.timer);
          pendingFastNavRef.current.delete(message.requestId);
          if (!message.handled) {
            handleNavigateToUrl(pending.targetUrl);
          } else {
            syncVerifiedActiveHostUrl(pending.targetUrl);
            const fastRoute = extractActiveRouteFromUrl(pending.targetUrl);
            activeInstanceUuidRef.current = fastRoute.instanceUuid;
            recordActiveRouteForBackNavigation(
              fastRoute.instanceUuid,
              fastRoute.cascadeId,
            );
          }
          break;
        }
      }
    },
    [
      armInboxRefreshTimeout,
      handleNavigateToUrl,
      markThreadReadInWorkstationClock,
      recomputeSnapshotWithLocalState,
      recordActiveRouteForBackNavigation,
      syncVerifiedActiveHostUrl,
    ],
  );

  const inboxCounts = useMemo(() => {
    let attention = 0;
    let urgent = 0;
    let running = 0;
    for (const thread of inboxSnapshot.threads) {
      if (thread.needsAttention) {
        attention++;
      }
      if (
        thread.attentionKind === 'approval' ||
        thread.attentionKind === 'error'
      ) {
        urgent++;
      }
      if (thread.attentionKind === 'running') {
        running++;
      }
    }
    return { attention, urgent, running };
  }, [inboxSnapshot.threads]);

  if (resetRequest) {
    return (
      <View style={styles.loadingScreen}>
        <Text style={styles.loadingTitle}>
          {resetError ? 'Sign-out needs attention' : 'Clearing session…'}
        </Text>
        {resetError ? (
          <>
            <Text style={styles.loadingSubtitle}>{resetError}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => {
                setResetError(null);
                setResetRequest(
                  (previous) =>
                    previous && { ...previous, attempt: previous.attempt + 1 },
                );
              }}
            >
              <Text style={styles.primaryRetryText}>Retry sign-out</Text>
            </TouchableOpacity>
          </>
        ) : (
          <ActivityIndicator size="large" color="#60A5FA" />
        )}
      </View>
    );
  }

  if (!isHydrated) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#60A5FA" />
        <Text style={styles.loadingTitle}>Antigravity Remote</Text>
        <Text style={styles.loadingSubtitle}>
          {initializationError
            ? 'Session storage is unavailable. Retry before opening the session.'
            : 'Restoring saved session…'}
        </Text>
        {initializationError ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              setInitializationError(false);
              setInitializationAttempt((previous) => previous + 1);
            }}
          >
            <Text style={styles.primaryRetryText}>Retry restore</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.root} onLayout={handleRootLayout}>
      <TopStatusBanner stage={stage} onRetryPress={handleReloadSession} />

      <View
        style={[
          styles.webViewWrapper,
          keyboardBottomPadding > 0
            ? { paddingBottom: keyboardBottomPadding }
            : null,
        ]}
      >
        <WebView
          key={`agy-webview-${webViewInstanceKey}`}
          ref={webViewRef}
          source={{ uri: currentSourceUrl }}
          userAgent={getCleanMobileUserAgent()}
          style={styles.webView}
          containerStyle={styles.webViewContainer}
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
          domStorageEnabled={true}
          javaScriptEnabled={true}
          cacheEnabled={true}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={true}
          pullToRefreshEnabled={true}
          injectedJavaScriptBeforeContentLoaded={PROJECT_OVERVIEW_SCROLL_SCRIPT}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
          injectedJavaScript={COMBINED_INJECTED_SCRIPT}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
          onNavigationStateChange={handleNavigationStateChange}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onMessage={handleWebViewMessage}
          onRenderProcessGone={handleWebProcessTerminated}
          onContentProcessDidTerminate={handleWebProcessTerminated}
          onError={() => {
            setPageError(null);
            setHasNetworkError(true);
            setStage('offline');
          }}
          onHttpError={(syntheticEvent) => {
            if (syntheticEvent.nativeEvent.statusCode >= 502) {
              setStage('offline');
            }
          }}
        />
        {hasNetworkError ? (
          <View style={[styles.errorContainer, styles.errorOverlay]}>
            <Text style={styles.errorHeading}>
              Unable to reach Antigravity Remote
            </Text>
            <Text style={styles.errorBody}>
              {pageError ??
                'Check your internet connection, then reconnect to this page.'}
            </Text>
            <TouchableOpacity
              style={styles.primaryRetryButton}
              onPress={handleReloadSession}
              accessibilityRole="button"
            >
              <Text style={styles.primaryRetryText}>Reconnect</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <LeftNavigationDrawer
        visible={isDrawerOpen}
        initialMode={drawerInitialMode}
        focusInboxRequestKey={focusInboxRequestKey}
        isKeyboardVisible={isKeyboardVisible}
        keyboardBottomPadding={keyboardBottomPadding}
        stage={stage}
        snapshot={inboxSnapshot}
        isRefreshing={isInboxRefreshing}
        attentionCount={inboxCounts.attention}
        urgentAttentionCount={inboxCounts.urgent}
        runningCount={inboxCounts.running}
        keepAliveMinutes={keepAliveMinutes}
        actionNotificationMode={actionNotificationMode}
        onOpen={handleOpenDrawer}
        onClose={handleCloseDrawer}
        onRefreshInbox={handleRefreshInbox}
        onSelectThread={handleSelectInboxThread}
        onMarkThreadRead={handleMarkThreadRead}
        onMarkAllRead={handleMarkAllRead}
        onChangeKeepAliveMinutes={handleChangeKeepAliveMinutes}
        onChangeActionNotificationMode={handleChangeActionNotificationMode}
        onNavigateToUrl={handleNavigateToUrl}
        onReloadSession={handleReloadSession}
        onSignOut={handleSignOut}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0B0F17',
  },
  webViewWrapper: {
    flex: 1,
    backgroundColor: '#0B0F17',
  },
  webViewContainer: {
    flex: 1,
    backgroundColor: '#0B0F17',
  },
  webView: {
    flex: 1,
    backgroundColor: '#0B0F17',
  },
  loadingScreen: {
    flex: 1,
    backgroundColor: '#0B0F17',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  loadingTitle: {
    marginTop: 16,
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
  loadingSubtitle: {
    marginTop: 6,
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: '#0B0F17',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  errorHeading: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorBody: {
    color: '#94A3B8',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 22,
  },
  primaryRetryButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryRetryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
