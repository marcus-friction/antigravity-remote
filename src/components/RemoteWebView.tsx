import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  BackHandler,
  Keyboard,
  KeyboardEvent,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
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
  DEFAULT_ACTION_NOTIFICATION_MODE,
  DEFAULT_KEEP_ALIVE_MINUTES,
} from '../constants/config';
import { ANTIGRAVITY_THEME } from '../constants/theme';
import {
  INBOX_BRIDGE_SCRIPT,
  buildCreateProjectScript,
  buildFastThreadSwitchScript,
  buildInboxRefreshScript,
  buildListDirectoryScript,
  buildMarkThreadReadScript,
  buildOpenHostSettingsScript,
  buildStartProjectChatScript,
  buildSyncThreadContextScript,
} from '../services/inboxBridge';
import {
  PROJECT_OVERVIEW_SCROLL_SCRIPT,
  buildReturnToOverviewScript,
} from '../services/scrollRestorationBridge';
import {
  backupCookiesFromWebView,
  clearSession,
  getActionNotificationMode,
  getDrawerGuidanceSeen,
  getGoogleSessionSignature,
  getIntroTourSeen,
  getKeepAliveMinutes,
  getLastActiveUrl,
  hydrateCookiesToWebView,
  saveActionNotificationMode,
  saveDrawerGuidanceSeen,
  saveIntroTourSeen,
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
  ActiveThreadProjectContext,
  CreateProjectRequestParams,
  CreateProjectResult,
  DirectoryListingResult,
  InboxBridgeMessage,
  InboxProjectGroup,
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
  PendingThreadProjectFallback,
  applyLocalStateToSnapshot,
  buildInboxSnapshot,
  extractAccountPathPrefix,
  extractActiveRouteFromUrl,
  extractWorkspaceSubPathFromUrl,
  isEmptyWorkspaceRoute,
  isTrajectoryMarkedArchivedInMessage,
  parseInboxBridgeMessage,
  reconcileRunningThreadTransitions,
  resolveActiveRouteFromBridgeMessage,
  resolveActiveThreadProject,
} from '../utils/inboxParser';
import { computeDrawerWidth, isTabletViewport } from '../utils/layout';
import {
  isGoogleCookieErrorUrl,
  isAllowedAuthSubframeUrl,
  isAllowedRemoteClientSubframeUrl,
  isInternalWebViewSchemeUrl,
  validateNavigationUrl,
} from '../utils/urlValidator';
import { getCleanMobileUserAgent } from '../utils/userAgent';
import {
  IntroTourModal,
  NotificationPermissionStatus,
} from './IntroTourModal';
import { DrawerMode, LeftNavigationDrawer } from './LeftNavigationDrawer';
import { TopStatusBanner } from './TopStatusBanner';

/**
 * Injected into the WebView to ensure that when the mobile software keyboard
 * opens or resizes the viewport, any focused chat box (<textarea>, <input>,
 * or [contenteditable]) stays scrolled into view above the keyboard.
 */
const KEYBOARD_ADAPTATION_SCRIPT = `
(function() {
  if (
    !window.location ||
    (window.location.protocol !== 'https:' && window.location.protocol !== 'about:')
  ) {
    return true;
  }

  function isEditableElement(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (el.isContentEditable) return true;
    var role = el.getAttribute && el.getAttribute('role');
    return role === 'textbox' || role === 'combobox' || role === 'searchbox';
  }

  function isAxisLocked(el) {
    if (!el) return false;
    var inlineOv = (el.style && (el.style.overflowY || el.style.overflow)) || '';
    if (inlineOv === 'hidden' || inlineOv === 'clip') return true;
    if (typeof window.getComputedStyle === 'function') {
      try {
        var cs = window.getComputedStyle(el);
        var oy = (cs && (cs.overflowY || cs.overflow)) || '';
        if (oy === 'hidden' || oy === 'clip') return true;
      } catch (_) {}
    }
    return false;
  }

  function isDocumentScrollLocked() {
    return Boolean(
      document &&
        (isAxisLocked(document.body) || isAxisLocked(document.documentElement))
    );
  }

  function hasOverflowHiddenAncestor(el) {
    var cursor = el ? el.parentElement : null;
    while (
      cursor &&
      cursor !== document.body &&
      cursor !== document.documentElement
    ) {
      if (isAxisLocked(cursor)) {
        return true;
      }
      cursor = cursor.parentElement;
    }
    return false;
  }

  function keepActiveInputVisible() {
    try {
      if (isDocumentScrollLocked()) {
        var vv = window.visualViewport;
        var vvOffset = vv && typeof vv.offsetTop === 'number' ? vv.offsetTop : 0;
        if (vvOffset <= 0) {
          var se =
            document.scrollingElement ||
            document.documentElement ||
            document.body;
          if (
            window.scrollY > 0 ||
            window.pageYOffset > 0 ||
            (se && se.scrollTop > 0)
          ) {
            window.scrollTo(0, 0);
          }
        }
        return;
      }
      var active = document.activeElement;
      if (!isEditableElement(active) || hasOverflowHiddenAncestor(active)) {
        return;
      }
      if (typeof active.getBoundingClientRect === 'function') {
        var rect = active.getBoundingClientRect();
        var vh =
          (window.visualViewport && window.visualViewport.height) ||
          window.innerHeight ||
          0;
        if (vh > 0 && rect.top >= 0 && rect.bottom <= vh) {
          return;
        }
      }
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (_) {}
  }

  function scheduleScrollSync() {
    keepActiveInputVisible();
    setTimeout(keepActiveInputVisible, 100);
    setTimeout(keepActiveInputVisible, 260);
  }

  if (typeof window.__agyKeyboardAssistSchedule === 'function') {
    window.__agyKeyboardAssistSchedule();
    return true;
  }
  window.__agyKeyboardAssistInstalled = true;
  window.__agyKeyboardAssistSchedule = scheduleScrollSync;

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
const START_PROJECT_CHAT_FALLBACK_MS = 6_500;
const LIST_DIR_TIMEOUT_MS = 10_000;
const CREATE_PROJECT_TIMEOUT_MS = 12_000;
const HOST_SETTINGS_FALLBACK_MS = 500;
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

function isRemoteCloudWorkspaceUrl(rawUrl?: string | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
      return false;
    }
    const stripped = parsed.pathname.replace(/^\/u\/\d+(?=\/|$)/, '');
    return (
      stripped === '/remote' ||
      stripped === '/remote/' ||
      stripped.startsWith('/remote/')
    );
  } catch {
    return false;
  }
}

function getEmptyScreenKey(
  instanceUuid: string | null,
  activeUrl?: string | null,
): string {
  if (instanceUuid) {
    return `empty:${instanceUuid}`;
  }
  if (isRemoteCloudWorkspaceUrl(activeUrl)) {
    return 'empty:__cloud__';
  }
  return 'empty:root';
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
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const windowHeightRef = useRef<number>(windowHeight);
  windowHeightRef.current = windowHeight;
  const isTabletLayout = isTabletViewport(windowWidth, windowHeight);
  const dockedSidebarWidth = isTabletLayout
    ? computeDrawerWidth(windowWidth, true)
    : 0;
  const isTabletLayoutRef = useRef<boolean>(isTabletLayout);
  isTabletLayoutRef.current = isTabletLayout;
  const prevIsTabletLayoutRef = useRef<boolean>(isTabletLayout);
  const userClosedTabletSidebarRef = useRef<boolean>(false);
  const initialIsForeground =
    AppState.currentState !== 'background' &&
    AppState.currentState !== 'inactive';
  const webViewRef = useRef<WebView | null>(null);
  const hydratedRef = useRef(false);
  const canGoBackRef = useRef<boolean>(false);
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
  const activeCascadeIdRef = useRef<string | null>(null);
  const isOnEmptyScreenRef = useRef<boolean>(false);
  const currentEmptyScreenKeyRef = useRef<string | null>(null);
  const emptyScreenDismissedKeyRef = useRef<string | null>(null);
  const seenLiveActiveThreadKeyRef = useRef<string | null>(null);
  const lastObservedOverviewInstanceRef = useRef<string | null>(null);
  const canReturnToOverviewRef = useRef<boolean>(false);
  const pendingFastNavRef = useRef<
    Map<string, { timer: ReturnType<typeof setTimeout>; targetUrl: string }>
  >(new Map());
  const pendingDirRequestsRef = useRef<
    Map<
      string,
      {
        timer: ReturnType<typeof setTimeout>;
        resolve: (result: DirectoryListingResult) => void;
      }
    >
  >(new Map());
  const pendingCreateProjectRequestsRef = useRef<
    Map<
      string,
      {
        timer: ReturnType<typeof setTimeout>;
        resolve: (result: CreateProjectResult) => void;
      }
    >
  >(new Map());
  const hostSettingsFallbackTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const inboxRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const isDrawerOpenRef = useRef<boolean>(false);
  const isComposingNewThreadRef = useRef<boolean>(false);
  const wasAuthenticatedRef = useRef<boolean>(false);
  const drawerBackInterceptorRef = useRef<(() => boolean) | null>(null);
  const introTourBackInterceptorRef = useRef<(() => boolean) | null>(null);
  const isIntroTourOpenRef = useRef<boolean>(false);
  const activeThreadProjectRef = useRef<ActiveThreadProjectContext | null>(null);
  const lastSyncedThreadProjectSigRef = useRef<string | null>(null);

  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [keepAliveMinutes, setKeepAliveMinutes] = useState<KeepAliveMinutes>(
    DEFAULT_KEEP_ALIVE_MINUTES,
  );
  const [actionNotificationMode, setActionNotificationMode] =
    useState<ActionNotificationMode>(DEFAULT_ACTION_NOTIFICATION_MODE);
  const [isAppForeground, setIsAppForeground] =
    useState<boolean>(initialIsForeground);
  const [focusInboxRequestKey, setFocusInboxRequestKey] = useState<number>(0);
  const [drawerModeRequestKey, setDrawerModeRequestKey] = useState<number>(0);
  const [currentSourceUrl, setCurrentSourceUrl] = useState<string>(
    ANTIGRAVITY_DASHBOARD_URL,
  );
  const [activeHostUrl, setActiveHostUrl] = useState<string>(
    ANTIGRAVITY_DASHBOARD_URL,
  );
  const [stage, setStage] = useState<AuthFlowStage>('hydrating');
  const [hasNetworkError, setHasNetworkError] = useState<boolean>(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [hasSeenDrawerGuidance, setHasSeenDrawerGuidance] =
    useState<boolean>(false);
  const [isIntroTourOpen, setIsIntroTourOpen] = useState<boolean>(false);
  const [notificationPermissionStatus, setNotificationPermissionStatus] =
    useState<NotificationPermissionStatus>('undetermined');
  const [drawerInitialMode, setDrawerInitialMode] =
    useState<DrawerMode>('inbox');
  const [isInboxRefreshing, setIsInboxRefreshing] = useState<boolean>(false);
  const [inboxSnapshot, setInboxSnapshot] =
    useState<InboxSnapshot>(EMPTY_INBOX_SNAPSHOT);
  const [pendingThreadProject, setPendingThreadProject] =
    useState<PendingThreadProjectFallback | null>(null);
  const [webViewInstanceKey, setWebViewInstanceKey] = useState<number>(1);
  const [resetRequest, setResetRequest] = useState<{
    reason: 'signout' | 'recovery';
    attempt: number;
  } | null>(null);
  const isResetRequestRef = useRef<boolean>(false);
  isResetRequestRef.current = Boolean(resetRequest);
  const [resetError, setResetError] = useState<string | null>(null);
  const [initializationError, setInitializationError] = useState(false);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [pageError, setPageError] = useState<string | null>(null);
  const [rawKeyboardHeight, setRawKeyboardHeight] = useState<number>(0);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState<boolean>(false);

  const setStageSynced = useCallback((next: AuthFlowStage) => {
    stageRef.current = next;
    setStage(next);
  }, []);

  const syncCookiesToVault = useCallback(async () => {
    if (!hydratedRef.current || isResettingSessionRef.current) return;
    await backupCookiesFromWebView();
  }, []);

  useEffect(() => {
    keepAliveMinutesRef.current = keepAliveMinutes;
  }, [keepAliveMinutes]);

  useEffect(() => {
    actionNotificationModeRef.current = actionNotificationMode;
  }, [actionNotificationMode]);

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
        savedDrawerGuidanceSeen,
        savedIntroTourSeen,
        sessionSignature,
      ] = await Promise.all([
        getLastActiveUrl(),
        getKeepAliveMinutes(),
        getActionNotificationMode(),
        getDrawerGuidanceSeen(),
        getIntroTourSeen(),
        getGoogleSessionSignature(),
      ]);

      if (!isMounted) {
        return;
      }

      const initialTarget = incomingDeepLinkUrl ?? savedUrl;
      const initialRoute = extractActiveRouteFromUrl(initialTarget);
      const isInitialEmpty = isEmptyWorkspaceRoute({
        activeUrl: initialTarget,
        activeInstanceUuid: initialRoute.instanceUuid,
        activeCascadeId: initialRoute.cascadeId,
      });
      activeInstanceUuidRef.current = initialRoute.instanceUuid;
      activeCascadeIdRef.current = initialRoute.cascadeId;
      isOnEmptyScreenRef.current = isInitialEmpty;
      currentEmptyScreenKeyRef.current = isInitialEmpty
        ? getEmptyScreenKey(initialRoute.instanceUuid, initialTarget)
        : null;
      emptyScreenDismissedKeyRef.current = null;
      seenLiveActiveThreadKeyRef.current = null;
      lastObservedOverviewInstanceRef.current = initialRoute.cascadeId
        ? null
        : initialRoute.instanceUuid;
      canReturnToOverviewRef.current = false;
      setKeepAliveMinutes(savedKeepAliveMinutes);
      keepAliveMinutesRef.current = savedKeepAliveMinutes;
      setActionNotificationMode(savedActionNotificationMode);
      actionNotificationModeRef.current = savedActionNotificationMode;
      setHasSeenDrawerGuidance(savedDrawerGuidanceSeen);
      const shouldShowIntroTour = !savedIntroTourSeen;
      isIntroTourOpenRef.current = shouldShowIntroTour;
      setIsIntroTourOpen(shouldShowIntroTour);
      if (Platform.OS === 'android') {
        if (typeof Platform.Version === 'number' && Platform.Version < 33) {
          setNotificationPermissionStatus('not_required');
        } else {
          try {
            const granted = await PermissionsAndroid?.check?.(
              'android.permission.POST_NOTIFICATIONS' as any,
            );
            setNotificationPermissionStatus(
              granted ? 'granted' : 'undetermined',
            );
          } catch {
            setNotificationPermissionStatus('undetermined');
          }
        }
      }
      setCurrentSourceUrl(initialTarget);
      setActiveHostUrl(initialTarget);
      currentNavUrlRef.current = initialTarget;
      if (incomingDeepLinkUrl) {
        onDeepLinkConsumed();
      }
      const isAuthenticatedAtLaunch =
        restoredCount > 0 && sessionSignature.length > 0;
      wasAuthenticatedRef.current = isAuthenticatedAtLaunch;
      const initialStage: AuthFlowStage = isAuthenticatedAtLaunch
        ? 'authenticated'
        : 'authenticating';
      setStageSynced(initialStage);
      // Antigravity's native web sidebar is hidden inside the WebView:
      // - On tablet screens, open our native docked sidebar by default whenever authenticated.
      // - On phones, open it automatically on empty workspace overviews or the root dashboard
      //   (skipping active threads and non-empty sub-routes like `/battle/...` or `/remote/history`).
      const shouldOpenPhoneLaunchDrawer =
        isInitialEmpty ||
        (!initialRoute.cascadeId &&
          extractWorkspaceSubPathFromUrl(initialTarget) === null);
      if (
        isAuthenticatedAtLaunch &&
        !pendingOpenInbox &&
        (isTabletLayoutRef.current || shouldOpenPhoneLaunchDrawer)
      ) {
        setDrawerInitialMode('inbox');
        isDrawerOpenRef.current = true;
        setIsDrawerOpen(true);
      }
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
    setStageSynced,
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

  const reconcilePendingThreadProject = useCallback(
    (instanceUuid: string | null, cascadeId: string | null) => {
      setPendingThreadProject((prev) => {
        if (!prev) {
          return null;
        }
        if (!instanceUuid || prev.instanceUuid !== instanceUuid) {
          return null;
        }
        if (cascadeId) {
          if (prev.cascadeId === null) {
            return { ...prev, cascadeId };
          }
          return prev.cascadeId === cascadeId ? prev : null;
        }
        return isComposingNewThreadRef.current ? prev : null;
      });
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

  const refreshNotificationPermissionStatus = useCallback(async () => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (typeof Platform.Version === 'number' && Platform.Version < 33) {
      setNotificationPermissionStatus('not_required');
      return;
    }
    try {
      const granted = await PermissionsAndroid?.check?.(
        'android.permission.POST_NOTIFICATIONS' as any,
      );
      if (granted) {
        setNotificationPermissionStatus('granted');
      } else {
        setNotificationPermissionStatus((prev) =>
          prev === 'denied' ? 'denied' : 'undetermined',
        );
      }
    } catch {
      // Ignore permission check errors on restricted profiles/ROMs.
    }
  }, []);

  const handleRequestNotificationPermission =
    useCallback(async (): Promise<NotificationPermissionStatus> => {
      if (Platform.OS === 'ios') {
        notificationPermissionRequestedRef.current = true;
        try {
          const granted = Boolean(await requestNativeNotificationPermission?.());
          const nextStatus: NotificationPermissionStatus = granted
            ? 'granted'
            : 'denied';
          setNotificationPermissionStatus(nextStatus);
          return nextStatus;
        } catch {
          return 'undetermined';
        }
      }
      if (
        Platform.OS !== 'android' ||
        typeof Platform.Version !== 'number' ||
        Platform.Version < 33
      ) {
        setNotificationPermissionStatus('not_required');
        return 'not_required';
      }
      notificationPermissionRequestedRef.current = true;
      const permission = 'android.permission.POST_NOTIFICATIONS' as any;
      try {
        const alreadyGranted = await PermissionsAndroid?.check?.(permission);
        if (alreadyGranted) {
          setNotificationPermissionStatus('granted');
          return 'granted';
        }
        const result = await PermissionsAndroid?.request?.(permission);
        const grantedValue = PermissionsAndroid?.RESULTS?.GRANTED ?? 'granted';
        const nextStatus: NotificationPermissionStatus =
          result === grantedValue ? 'granted' : 'denied';
        setNotificationPermissionStatus(nextStatus);
        return nextStatus;
      } catch {
        // Ignore permission request errors on restricted profiles/ROMs.
        return 'undetermined';
      }
    }, []);

  const requestNotificationPermissionIfNeeded = useCallback(() => {
    if (notificationPermissionRequestedRef.current) {
      return;
    }
    void handleRequestNotificationPermission();
  }, [handleRequestNotificationPermission]);

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

    if (!isIntroTourOpen && (keepAliveEligible || notificationsEligible)) {
      requestNotificationPermissionIfNeeded();
    }
  }, [
    actionNotificationMode,
    isHydrated,
    isIntroTourOpen,
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
    for (const pending of pendingDirRequestsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        currentUri: '',
        parentUri: null,
        entries: [],
        error: 'Session interrupted',
      });
    }
    pendingDirRequestsRef.current.clear();
    for (const pending of pendingCreateProjectRequestsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: 'Session interrupted',
      });
    }
    pendingCreateProjectRequestsRef.current.clear();
    if (inboxRefreshTimeoutRef.current) {
      clearTimeout(inboxRefreshTimeoutRef.current);
      inboxRefreshTimeoutRef.current = null;
    }
    if (hostSettingsFallbackTimerRef.current) {
      clearTimeout(hostSettingsFallbackTimerRef.current);
      hostSettingsFallbackTimerRef.current = null;
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

  const syncActionNotificationFromState = useCallback(
    (
      snapshot: InboxSnapshot,
      overrides?: {
        stage?: AuthFlowStage;
        mode?: ActionNotificationMode;
        isAppForeground?: boolean;
        isDrawerOpen?: boolean;
        isTabletLayout?: boolean;
      },
    ) => {
      if (
        !hydratedRef.current ||
        isResettingSessionRef.current ||
        isResetRequestRef.current
      ) {
        return;
      }
      const effectiveStage = overrides?.stage ?? stageRef.current;
      const effectiveMode = overrides?.mode ?? actionNotificationModeRef.current;
      if (
        effectiveStage === 'authenticated' &&
        effectiveMode !== 'off' &&
        snapshot.fetchedAtMs === 0
      ) {
        return;
      }
      const effectiveForeground =
        overrides?.isAppForeground ?? isAppForegroundRef.current;
      const effectiveDrawerOpen =
        overrides?.isDrawerOpen ?? isDrawerOpenRef.current;
      const effectiveTablet =
        overrides?.isTabletLayout ?? isTabletLayoutRef.current;
      const isDrawerBlockingWebView = effectiveDrawerOpen && !effectiveTablet;

      const syncResult = buildActionNotificationSyncState({
        stage: effectiveStage,
        mode: effectiveMode,
        threads: snapshot.threads,
        isAppForeground: effectiveForeground,
        isDrawerOpen: isDrawerBlockingWebView,
        isDrawerVisible: effectiveDrawerOpen,
        previousOpenThreadIds: previousOpenActionIdsRef.current,
      });
      previousOpenActionIdsRef.current = syncResult.openThreadIds;

      if (
        syncResult.signature === lastActionNotifSigRef.current &&
        !syncResult.notification?.shouldAlert
      ) {
        return;
      }
      lastActionNotifSigRef.current = syncResult.signature;

      if (!syncResult.notification) {
        void clearNativeActionNotification?.();
        return;
      }

      void syncNativeActionNotification?.(syncResult.notification);
    },
    [],
  );

  const recomputeSnapshotWithLocalState = useCallback(
    (overrides?: {
      activeInstanceUuid?: string | null;
      activeCascadeId?: string | null;
      isAppForeground?: boolean;
      isDrawerOpen?: boolean;
    }) => {
      const previous = inboxSnapshotRef.current;
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
      const rawDrawerOpen = overrides?.isDrawerOpen ?? isDrawerOpenRef.current;
      const effectiveDrawerOpen = rawDrawerOpen && !isTabletLayoutRef.current;

      let next: InboxSnapshot;
      const rawMsg = lastSnapshotMessageRef.current;
      if (rawMsg) {
        next = buildInboxSnapshot(
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
      } else if (previous.threads.length === 0) {
        next =
          previous.activeInstanceUuid === effectiveActiveInstanceUuid &&
          previous.activeCascadeId === effectiveActiveCascadeId
            ? previous
            : {
                ...previous,
                activeInstanceUuid: effectiveActiveInstanceUuid,
                activeCascadeId: effectiveActiveCascadeId,
              };
      } else {
        next = applyLocalStateToSnapshot(previous, {
          activeInstanceUuid: effectiveActiveInstanceUuid,
          activeCascadeId: effectiveActiveCascadeId,
          locallyReadAtByThreadId: locallyReadMapRef.current,
          isAppForeground: effectiveForeground,
          isDrawerOpen: effectiveDrawerOpen,
        });
      }

      inboxSnapshotRef.current = next;
      setInboxSnapshot(next);
      syncActionNotificationFromState(next, {
        isAppForeground: effectiveForeground,
        isDrawerOpen: rawDrawerOpen,
      });
    },
    [syncActionNotificationFromState],
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

  const handleDismissDrawerGuidance = useCallback(() => {
    setHasSeenDrawerGuidance((prev) => {
      if (!prev) {
        void saveDrawerGuidanceSeen(true);
      }
      return true;
    });
  }, []);

  const openDrawerForEmptyScreen = useCallback(
    (
      emptyKey: string,
      options?: {
        triggerRefresh?: boolean;
        skipSnapshotRecompute?: boolean;
      },
    ): boolean => {
      if (
        isResettingSessionRef.current ||
        stageRef.current !== 'authenticated' ||
        isComposingNewThreadRef.current ||
        emptyScreenDismissedKeyRef.current === emptyKey
      ) {
        return false;
      }
      if (isDrawerOpenRef.current) {
        // Drawer (or docked tablet sidebar) is already open; avoid switching
        // away from the user's active tab, just refresh Inbox if requested.
        if (options?.triggerRefresh) {
          handleRefreshInbox(false);
        }
        return false;
      }
      if (resumeReadSettleTimerRef.current) {
        clearTimeout(resumeReadSettleTimerRef.current);
        resumeReadSettleTimerRef.current = null;
      }
      userClosedTabletSidebarRef.current = false;
      handleDismissDrawerGuidance();
      if (!isTabletLayoutRef.current) {
        Keyboard.dismiss?.();
      }
      setDrawerInitialMode('inbox');
      isDrawerOpenRef.current = true;
      setIsDrawerOpen(true);
      if (!options?.skipSnapshotRecompute) {
        recomputeSnapshotWithLocalState({ isDrawerOpen: true });
      }
      if (options?.triggerRefresh) {
        handleRefreshInbox(false);
      }
      return true;
    },
    [
      handleDismissDrawerGuidance,
      handleRefreshInbox,
      recomputeSnapshotWithLocalState,
    ],
  );

  useEffect(() => {
    if (prevIsTabletLayoutRef.current === isTabletLayout) {
      return;
    }
    prevIsTabletLayoutRef.current = isTabletLayout;
    if (!isHydrated || isResettingSessionRef.current || resetRequest) {
      return;
    }
    if (isTabletLayout) {
      if (
        stageRef.current === 'authenticated' &&
        !isDrawerOpenRef.current &&
        !userClosedTabletSidebarRef.current
      ) {
        setDrawerInitialMode('inbox');
        isDrawerOpenRef.current = true;
        setIsDrawerOpen(true);
      }
      recomputeSnapshotWithLocalState({ isDrawerOpen: isDrawerOpenRef.current });
      return;
    }
    const route = extractActiveRouteFromUrl(currentNavUrlRef.current);
    const hasActiveThread =
      !isOnEmptyScreenRef.current &&
      Boolean(
        activeCascadeIdRef.current ??
          inboxSnapshotRef.current.activeCascadeId ??
          route.cascadeId,
      );
    if (isDrawerOpenRef.current && hasActiveThread) {
      isDrawerOpenRef.current = false;
      setIsDrawerOpen(false);
      recomputeSnapshotWithLocalState({ isDrawerOpen: false });
      return;
    }
    recomputeSnapshotWithLocalState({ isDrawerOpen: isDrawerOpenRef.current });
  }, [
    isHydrated,
    isTabletLayout,
    recomputeSnapshotWithLocalState,
    resetRequest,
  ]);

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
            setIsKeyboardOpen(false);
            setRawKeyboardHeight(0);
          }
          if (isAppForegroundRef.current) {
            const currentSnap = inboxSnapshotRef.current;
            if (!isDrawerOpenRef.current || isTabletLayoutRef.current) {
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
          void refreshNotificationPermissionStatus();
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
                (isDrawerOpenRef.current && !isTabletLayoutRef.current)
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
              if (
                returningFromBackground &&
                !isDrawerOpenRef.current &&
                !isComposingNewThreadRef.current
              ) {
                const resumeRoute = extractActiveRouteFromUrl(
                  currentNavUrlRef.current,
                );
                const liveInstanceUuid =
                  activeInstanceUuidRef.current ?? resumeRoute.instanceUuid;
                const liveCascadeId =
                  activeCascadeIdRef.current ?? resumeRoute.cascadeId;
                const isResumeEmpty =
                  isOnEmptyScreenRef.current ||
                  isEmptyWorkspaceRoute({
                    activeUrl: currentNavUrlRef.current,
                    activeInstanceUuid: liveInstanceUuid,
                    activeCascadeId: liveCascadeId,
                    isEmptyRouteHint:
                      lastSnapshotMessageRef.current?.isEmptyRoute,
                  });
                const isResumeOverviewOrDashboard =
                  isResumeEmpty ||
                  (!liveCascadeId &&
                    extractWorkspaceSubPathFromUrl(
                      currentNavUrlRef.current,
                    ) === null);
                if (isResumeOverviewOrDashboard) {
                  emptyScreenDismissedKeyRef.current = null;
                  userClosedTabletSidebarRef.current = false;
                  if (isResumeEmpty) {
                    isOnEmptyScreenRef.current = true;
                    currentEmptyScreenKeyRef.current = getEmptyScreenKey(
                      liveInstanceUuid,
                      currentNavUrlRef.current,
                    );
                  }
                  setDrawerInitialMode('inbox');
                  isDrawerOpenRef.current = true;
                  setIsDrawerOpen(true);
                  recomputeSnapshotWithLocalState({ isDrawerOpen: true });
                }
              }
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
    refreshNotificationPermissionStatus,
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
      const coords = event?.endCoordinates;
      const height = coords?.height ?? 0;
      const sanitizedHeight = height > 0 ? height : 0;
      if (Platform.OS === 'android') {
        setRawKeyboardHeight(sanitizedHeight);
        setIsKeyboardOpen(true);
      } else {
        const winHeight = windowHeightRef.current;
        const screenY = coords?.screenY;
        let dockedOverlap = sanitizedHeight;
        if (
          sanitizedHeight > 0 &&
          typeof screenY === 'number' &&
          Number.isFinite(screenY) &&
          winHeight > 0
        ) {
          // Floating or undocked iPadOS keyboards sit above the bottom of the window
          // and do not dock against the bottom edge.
          if (screenY + sanitizedHeight < winHeight - 24) {
            dockedOverlap = 0;
          } else {
            dockedOverlap = Math.max(
              0,
              Math.min(sanitizedHeight, winHeight - screenY),
            );
          }
        }
        setRawKeyboardHeight(dockedOverlap);
        setIsKeyboardOpen(sanitizedHeight > 0);
      }
      if (!isDrawerOpenRef.current || isTabletLayoutRef.current) {
        webViewRef.current?.injectJavaScript(KEYBOARD_ADAPTATION_SCRIPT);
      }
    };

    const onKeyboardHide = () => {
      setIsKeyboardOpen(false);
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
      if (isIntroTourOpenRef.current) {
        if (introTourBackInterceptorRef.current?.()) {
          return true;
        }
        isIntroTourOpenRef.current = false;
        setIsIntroTourOpen(false);
        void saveIntroTourSeen(true);
        return true;
      }
      if (isDrawerOpenRef.current) {
        if (drawerBackInterceptorRef.current?.()) {
          return true;
        }
        if (!isTabletLayoutRef.current) {
          if (isOnEmptyScreenRef.current && currentEmptyScreenKeyRef.current) {
            emptyScreenDismissedKeyRef.current =
              currentEmptyScreenKeyRef.current;
          }
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
      }
      if (canGoBackRef.current && webViewRef.current) {
        canReturnToOverviewRef.current = false;
        isComposingNewThreadRef.current = false;
        webViewRef.current.goBack();
        return true;
      }
      if (canReturnToOverviewRef.current && webViewRef.current) {
        canReturnToOverviewRef.current = false;
        isComposingNewThreadRef.current = false;
        userClosedTabletSidebarRef.current = false;
        if (resumeReadSettleTimerRef.current) {
          clearTimeout(resumeReadSettleTimerRef.current);
          resumeReadSettleTimerRef.current = null;
        }
        if (!isTabletLayoutRef.current) {
          Keyboard.dismiss?.();
        }
        webViewRef.current.injectJavaScript(buildReturnToOverviewScript());
        // Because Antigravity's native sidebar is hidden, returning from a thread
        // to the overview automatically opens our native Inbox sidebar.
        const emptyKey = getEmptyScreenKey(
          activeInstanceUuidRef.current,
          currentNavUrlRef.current,
        );
        activeCascadeIdRef.current = null;
        seenLiveActiveThreadKeyRef.current = null;
        isOnEmptyScreenRef.current = true;
        currentEmptyScreenKeyRef.current = emptyKey;
        emptyScreenDismissedKeyRef.current = null;
        if (lastSnapshotMessageRef.current) {
          lastSnapshotMessageRef.current = {
            ...lastSnapshotMessageRef.current,
            activeInstanceUuid: activeInstanceUuidRef.current,
            activeCascadeId: null,
            isEmptyRoute: true,
          };
        }
        setDrawerInitialMode('inbox');
        isDrawerOpenRef.current = true;
        setIsDrawerOpen(true);
        recomputeSnapshotWithLocalState({
          activeInstanceUuid: activeInstanceUuidRef.current,
          activeCascadeId: null,
          isDrawerOpen: true,
        });
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

  // On Android, MainActivity's WindowInsets listener already pads android.R.id.content
  // by the exact IME bottom inset and zeroes Type.ime() before it reaches the WebView.
  // On iOS, WKWebView natively manages its own scroll insets and visualViewport (with
  // INBOX_BRIDGE_SCRIPT pinning promoted full-bleed workstation iframes to visualViewport),
  // so only the native LeftNavigationDrawer overlay needs a docked iOS keyboard offset.
  const keyboardBottomPadding =
    Platform.OS === 'ios' && rawKeyboardHeight > 0
      ? Math.max(0, rawKeyboardHeight - insets.bottom)
      : 0;

  const isKeyboardVisible = isKeyboardOpen || rawKeyboardHeight > 0;

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
      activeCascadeIdRef.current = null;
      isOnEmptyScreenRef.current = false;
      currentEmptyScreenKeyRef.current = null;
      emptyScreenDismissedKeyRef.current = null;
      seenLiveActiveThreadKeyRef.current = null;
      lastObservedOverviewInstanceRef.current = null;
      canReturnToOverviewRef.current = false;
      webViewRef.current?.stopLoading();
      setStageSynced('hydrating');
      isDrawerOpenRef.current = false;
      userClosedTabletSidebarRef.current = false;
      isComposingNewThreadRef.current = false;
      wasAuthenticatedRef.current = false;
      setDrawerInitialMode('inbox');
      setDrawerModeRequestKey(0);
      setFocusInboxRequestKey(0);
      setIsDrawerOpen(false);
      setIsInboxRefreshing(false);
      inboxSnapshotRef.current = EMPTY_INBOX_SNAPSHOT;
      setInboxSnapshot(EMPTY_INBOX_SNAPSHOT);
      setPendingThreadProject(null);
      activeThreadProjectRef.current = null;
      lastSyncedThreadProjectSigRef.current = null;
      setResetError(null);
      isResetRequestRef.current = true;
      setResetRequest({ reason, attempt: 0 });
    },
    [clearInboxTimers, setStageSynced],
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
        setActiveHostUrl(ANTIGRAVITY_DASHBOARD_URL);
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
        setStageSynced('authenticating');
        isResettingSessionRef.current = false;
        resumeSessionPersistence();
        isResetRequestRef.current = false;
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
  }, [resetRequest, setStageSynced]);

  const recoverFromCookieMismatch = useCallback(() => {
    if (isResettingSessionRef.current) return;
    if (cookieRecoveryAttemptsRef.current >= 2) {
      setPageError(
        'Automatic sign-in recovery stopped. Pull open the left Settings drawer and sign out to start again.',
      );
      setHasNetworkError(true);
      setStageSynced('offline');
      return;
    }
    cookieRecoveryAttemptsRef.current++;
    beginSessionReset('recovery');
  }, [beginSessionReset, setStageSynced]);

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
        setStageSynced('authenticating');
        if (!navState.loading) void checkPost2faSessionAndAdvance();
        return;
      }
      if (
        new URL(validation.normalizedUrl).hostname === 'antigravity.google.com'
      ) {
        setActiveHostUrl(validation.normalizedUrl);
        void saveLastActiveUrl(validation.normalizedUrl);
        const route = extractActiveRouteFromUrl(validation.normalizedUrl);
        if (route.cascadeId) {
          isComposingNewThreadRef.current = false;
        }
        const prevInstanceUuid = activeInstanceUuidRef.current;
        const prevCascadeId = activeCascadeIdRef.current;
        activeInstanceUuidRef.current = route.instanceUuid;
        activeCascadeIdRef.current = route.cascadeId;
        if (
          route.instanceUuid !== prevInstanceUuid ||
          route.cascadeId !== prevCascadeId
        ) {
          seenLiveActiveThreadKeyRef.current = null;
        }
        const isEmptyNow = isEmptyWorkspaceRoute({
          activeUrl: validation.normalizedUrl,
          activeInstanceUuid: route.instanceUuid,
          activeCascadeId: route.cascadeId,
        });
        if (!isEmptyNow) {
          isOnEmptyScreenRef.current = false;
          currentEmptyScreenKeyRef.current = null;
          emptyScreenDismissedKeyRef.current = null;
        }
        recordActiveRouteForBackNavigation(route.instanceUuid, route.cascadeId);
        reconcilePendingThreadProject(route.instanceUuid, route.cascadeId);
        if (
          isAppForegroundRef.current &&
          (!isDrawerOpenRef.current || isTabletLayoutRef.current) &&
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
              const becameAuthenticated = !wasAuthenticatedRef.current;
              wasAuthenticatedRef.current = true;
              cookieRecoveryAttemptsRef.current = 0;
              renderRecoveryTimestampsRef.current = [];
              renderProcessDeadRef.current = false;
              setStageSynced('authenticated');
              webViewRef.current?.injectJavaScript(INBOX_BRIDGE_SCRIPT);
              if (activeThreadProjectRef.current) {
                webViewRef.current?.injectJavaScript(
                  buildSyncThreadContextScript(activeThreadProjectRef.current),
                );
              }
              const shouldOpenPhoneAuthDrawer =
                isEmptyNow ||
                (!route.cascadeId &&
                  extractWorkspaceSubPathFromUrl(validation.normalizedUrl) ===
                    null);
              if (
                becameAuthenticated &&
                !isComposingNewThreadRef.current &&
                !isDrawerOpenRef.current &&
                (isTabletLayoutRef.current || shouldOpenPhoneAuthDrawer)
              ) {
                if (isEmptyNow) {
                  const emptyKey = getEmptyScreenKey(
                    route.instanceUuid,
                    validation.normalizedUrl,
                  );
                  isOnEmptyScreenRef.current = true;
                  currentEmptyScreenKeyRef.current = emptyKey;
                }
                setDrawerInitialMode('inbox');
                isDrawerOpenRef.current = true;
                setIsDrawerOpen(true);
                recomputeSnapshotWithLocalState({ isDrawerOpen: true });
              } else if (isEmptyNow) {
                const emptyKey = getEmptyScreenKey(
                  route.instanceUuid,
                  validation.normalizedUrl,
                );
                isOnEmptyScreenRef.current = true;
                currentEmptyScreenKeyRef.current = emptyKey;
                openDrawerForEmptyScreen(emptyKey, {
                  triggerRefresh: !becameAuthenticated,
                });
              }
            }
          });
        }
      }
    },
    [
      checkPost2faSessionAndAdvance,
      markThreadReadInWorkstationClock,
      openDrawerForEmptyScreen,
      recomputeSnapshotWithLocalState,
      reconcilePendingThreadProject,
      recordActiveRouteForBackNavigation,
      recoverFromCookieMismatch,
      setStageSynced,
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
    if (activeThreadProjectRef.current) {
      webViewRef.current?.injectJavaScript(
        buildSyncThreadContextScript(activeThreadProjectRef.current),
      );
    }
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
      setStageSynced('offline');
      return;
    }
    recent.push(now);
    renderRecoveryTimestampsRef.current = recent;
    renderProcessDeadRef.current = false;
    setHasNetworkError(false);
    setPageError(null);
    setCurrentSourceUrl(currentNavUrlRef.current);
    setWebViewInstanceKey((prev) => prev + 1);
  }, [setStageSynced]);

  const handleReloadSession = useCallback(() => {
    if (isResettingSessionRef.current) return;
    setHasNetworkError(false);
    setPageError(null);
    if (stageRef.current === 'offline') {
      setStageSynced('authenticating');
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
  }, [setStageSynced, syncCookiesToVault]);

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
    },
    [requestNotificationPermissionIfNeeded],
  );

  const handleCompleteIntroTour = useCallback(() => {
    isIntroTourOpenRef.current = false;
    setIsIntroTourOpen(false);
    void saveIntroTourSeen(true);
  }, []);

  const handleOpenIntroTour = useCallback(() => {
    if (isResettingSessionRef.current) return;
    void refreshNotificationPermissionStatus();
    isIntroTourOpenRef.current = true;
    setIsIntroTourOpen(true);
  }, [refreshNotificationPermissionStatus]);

  const registerIntroTourBackInterceptor = useCallback(
    (interceptor: (() => boolean) | null) => {
      introTourBackInterceptorRef.current = interceptor;
    },
    [],
  );

  const getDashboardUrlForCurrentAccount = useCallback((): string => {
    const prefix = extractAccountPathPrefix(currentNavUrlRef.current);
    return prefix
      ? `${ANTIGRAVITY_DASHBOARD_URL}${prefix}/`
      : ANTIGRAVITY_DASHBOARD_URL;
  }, []);

  const registerDrawerBackInterceptor = useCallback(
    (interceptor: (() => boolean) | null) => {
      drawerBackInterceptorRef.current = interceptor;
    },
    [],
  );

  const handleNavigateToUrl = useCallback(
    (targetUrl: string, options?: { preserveComposing?: boolean }) => {
      if (isResettingSessionRef.current) return;
      const validation = validateNavigationUrl(targetUrl);
      if (!validation.isAllowedInApp || !validation.normalizedUrl) return;
      setHasNetworkError(false);
      setPageError(null);
      renderProcessDeadRef.current = false;
      renderRecoveryTimestampsRef.current = [];
      if (stageRef.current === 'offline') {
        setStageSynced('authenticating');
      }
      setCurrentSourceUrl(validation.normalizedUrl);
      currentNavUrlRef.current = validation.normalizedUrl;
      if (
        new URL(validation.normalizedUrl).hostname === 'antigravity.google.com'
      ) {
        setActiveHostUrl(validation.normalizedUrl);
      }
      const targetRoute = extractActiveRouteFromUrl(validation.normalizedUrl);
      if (!options?.preserveComposing || targetRoute.cascadeId) {
        isComposingNewThreadRef.current = false;
      }
      activeInstanceUuidRef.current = targetRoute.instanceUuid;
      activeCascadeIdRef.current = targetRoute.cascadeId;
      seenLiveActiveThreadKeyRef.current = null;
      isOnEmptyScreenRef.current = false;
      currentEmptyScreenKeyRef.current = null;
      emptyScreenDismissedKeyRef.current = null;
      lastObservedOverviewInstanceRef.current = targetRoute.cascadeId
        ? null
        : targetRoute.instanceUuid;
      canReturnToOverviewRef.current = false;
      reconcilePendingThreadProject(
        targetRoute.instanceUuid,
        targetRoute.cascadeId,
      );
      recomputeSnapshotWithLocalState({
        activeInstanceUuid: targetRoute.instanceUuid,
        activeCascadeId: targetRoute.cascadeId,
      });
      // Explicit native navigation must work even when the source prop already
      // contains this URL and the browser has since navigated somewhere else.
      setWebViewInstanceKey((prev) => prev + 1);
      void saveLastActiveUrl(validation.normalizedUrl);
    },
    [
      recomputeSnapshotWithLocalState,
      reconcilePendingThreadProject,
      setStageSynced,
    ],
  );

  const handleSignOut = useCallback(
    () => beginSessionReset('signout'),
    [beginSessionReset],
  );

  const handleOpenHostSettings = useCallback(() => {
    if (isResettingSessionRef.current) return;
    if (!webViewRef.current || stageRef.current !== 'authenticated') {
      handleNavigateToUrl(getDashboardUrlForCurrentAccount());
      return;
    }
    if (hostSettingsFallbackTimerRef.current) {
      clearTimeout(hostSettingsFallbackTimerRef.current);
    }
    hostSettingsFallbackTimerRef.current = setTimeout(() => {
      hostSettingsFallbackTimerRef.current = null;
      handleNavigateToUrl(getDashboardUrlForCurrentAccount());
    }, HOST_SETTINGS_FALLBACK_MS);
    (
      hostSettingsFallbackTimerRef.current as { unref?: () => void }
    )?.unref?.();
    webViewRef.current.injectJavaScript(INBOX_BRIDGE_SCRIPT);
    webViewRef.current.injectJavaScript(buildOpenHostSettingsScript());
  }, [getDashboardUrlForCurrentAccount, handleNavigateToUrl]);

  const handleOpenDrawer = useCallback(
    (preferredMode?: DrawerMode) => {
      if (isResettingSessionRef.current) return;
      if (resumeReadSettleTimerRef.current) {
        clearTimeout(resumeReadSettleTimerRef.current);
        resumeReadSettleTimerRef.current = null;
      }
      isComposingNewThreadRef.current = false;
      userClosedTabletSidebarRef.current = false;
      emptyScreenDismissedKeyRef.current = null;
      handleDismissDrawerGuidance();
      if (!isTabletLayoutRef.current) {
        Keyboard.dismiss?.();
      }
      const resolvedMode: DrawerMode =
        preferredMode ??
        (stageRef.current === 'authenticated' ? 'inbox' : 'settings');
      setDrawerInitialMode(resolvedMode);
      if (preferredMode) {
        setDrawerModeRequestKey((prev) => prev + 1);
      }
      isDrawerOpenRef.current = true;
      setIsDrawerOpen(true);
      recomputeSnapshotWithLocalState({ isDrawerOpen: true });
      if (stageRef.current === 'authenticated') {
        handleRefreshInbox(resolvedMode === 'usage');
      }
    },
    [
      handleDismissDrawerGuidance,
      handleRefreshInbox,
      recomputeSnapshotWithLocalState,
    ],
  );

  const handleCloseDrawer = useCallback(() => {
    if (isTabletLayoutRef.current) {
      userClosedTabletSidebarRef.current = true;
    }
    if (isOnEmptyScreenRef.current && currentEmptyScreenKeyRef.current) {
      emptyScreenDismissedKeyRef.current = currentEmptyScreenKeyRef.current;
    }
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
      const keepDockedOpen =
        isTabletLayoutRef.current && isDrawerOpenRef.current;
      if (!keepDockedOpen) {
        isDrawerOpenRef.current = false;
        setIsDrawerOpen(false);
      }
      isComposingNewThreadRef.current = false;
      activeCascadeIdRef.current = thread.cascadeId;
      seenLiveActiveThreadKeyRef.current = thread.id;
      isOnEmptyScreenRef.current = false;
      currentEmptyScreenKeyRef.current = null;
      emptyScreenDismissedKeyRef.current = null;
      setPendingThreadProject(null);

      markThreadReadInWorkstationClock(thread, 'unread_only');
      recomputeSnapshotWithLocalState({
        activeInstanceUuid: thread.instanceUuid,
        activeCascadeId: thread.cascadeId,
        isDrawerOpen: keepDockedOpen,
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

  const handleStartProjectThread = useCallback(
    (project: InboxProjectGroup) => {
      if (isResettingSessionRef.current) return;
      if (resumeReadSettleTimerRef.current) {
        clearTimeout(resumeReadSettleTimerRef.current);
        resumeReadSettleTimerRef.current = null;
      }
      const keepDockedOpen =
        isTabletLayoutRef.current && isDrawerOpenRef.current;
      if (!keepDockedOpen) {
        isDrawerOpenRef.current = false;
        setIsDrawerOpen(false);
      }
      isComposingNewThreadRef.current = true;
      activeCascadeIdRef.current = null;
      seenLiveActiveThreadKeyRef.current = null;
      isOnEmptyScreenRef.current = false;
      currentEmptyScreenKeyRef.current = null;
      emptyScreenDismissedKeyRef.current = null;
      setPendingThreadProject({
        instanceUuid: project.instanceUuid,
        cascadeId: null,
        projectId: project.projectId,
        projectName: project.name,
      });
      recomputeSnapshotWithLocalState({
        activeInstanceUuid: project.instanceUuid,
        activeCascadeId: null,
        isDrawerOpen: keepDockedOpen,
      });

      if (
        project.source === 'remote-control' &&
        stageRef.current === 'authenticated' &&
        !renderProcessDeadRef.current &&
        webViewRef.current
      ) {
        const requestId = `start-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const fallbackTimer = setTimeout(() => {
          pendingFastNavRef.current.delete(requestId);
          handleNavigateToUrl(project.newChatUrl, { preserveComposing: true });
        }, START_PROJECT_CHAT_FALLBACK_MS);
        (fallbackTimer as { unref?: () => void })?.unref?.();
        pendingFastNavRef.current.set(requestId, {
          timer: fallbackTimer,
          targetUrl: project.newChatUrl,
        });

        webViewRef.current.injectJavaScript(INBOX_BRIDGE_SCRIPT);
        webViewRef.current.injectJavaScript(
          buildStartProjectChatScript({
            requestId,
            instanceUuid: project.instanceUuid,
            workspaceUri: project.workspaceUri,
            targetUrl: project.newChatUrl,
            projectId: project.projectId,
          }),
        );
        return;
      }

      handleNavigateToUrl(project.newChatUrl, { preserveComposing: true });
    },
    [handleNavigateToUrl, recomputeSnapshotWithLocalState],
  );

  const handleListDirectory = useCallback(
    (
      instanceUuid: string,
      uri?: string | null,
    ): Promise<DirectoryListingResult> => {
      if (
        isResettingSessionRef.current ||
        stageRef.current !== 'authenticated' ||
        renderProcessDeadRef.current ||
        !webViewRef.current
      ) {
        return Promise.resolve({
          ok: false,
          currentUri: '',
          parentUri: null,
          entries: [],
          error: 'Workstation is not connected.',
        });
      }
      return new Promise((resolve) => {
        const requestId = `list-dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          pendingDirRequestsRef.current.delete(requestId);
          resolve({
            ok: false,
            currentUri: uri ?? '',
            parentUri: null,
            entries: [],
            error: 'Timed out waiting for workstation directory listing.',
          });
        }, LIST_DIR_TIMEOUT_MS);
        (timer as { unref?: () => void })?.unref?.();
        pendingDirRequestsRef.current.set(requestId, { timer, resolve });

        webViewRef.current?.injectJavaScript(INBOX_BRIDGE_SCRIPT);
        webViewRef.current?.injectJavaScript(
          buildListDirectoryScript({
            requestId,
            instanceUuid,
            uri: uri ?? null,
          }),
        );
      });
    },
    [],
  );

  const handleCreateProject = useCallback(
    (params: CreateProjectRequestParams): Promise<CreateProjectResult> => {
      if (
        isResettingSessionRef.current ||
        stageRef.current !== 'authenticated' ||
        renderProcessDeadRef.current ||
        !webViewRef.current
      ) {
        return Promise.resolve({
          ok: false,
          error: 'Workstation is not connected.',
        });
      }
      return new Promise((resolve) => {
        const requestId = `create-proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          pendingCreateProjectRequestsRef.current.delete(requestId);
          resolve({
            ok: false,
            error: 'Timed out waiting for workstation response.',
          });
        }, CREATE_PROJECT_TIMEOUT_MS);
        (timer as { unref?: () => void })?.unref?.();
        pendingCreateProjectRequestsRef.current.set(requestId, {
          timer,
          resolve,
        });

        webViewRef.current?.injectJavaScript(INBOX_BRIDGE_SCRIPT);
        webViewRef.current?.injectJavaScript(
          buildCreateProjectScript({
            requestId,
            instanceUuid: params.instanceUuid,
            mode: params.mode,
            name: params.name,
            folderPathOrUri: params.folderPathOrUri ?? null,
          }),
        );
      });
    },
    [],
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
    isComposingNewThreadRef.current = false;
    userClosedTabletSidebarRef.current = false;
    emptyScreenDismissedKeyRef.current = null;
    setDrawerInitialMode('inbox');
    setFocusInboxRequestKey((prev) => prev + 1);
    if (!isTabletLayoutRef.current) {
      Keyboard.dismiss?.();
    }
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
        isComposingNewThreadRef.current = false;
        const isEmptyTarget = isEmptyWorkspaceRoute({
          activeUrl: validation.normalizedUrl,
          activeInstanceUuid: targetRoute.instanceUuid,
          activeCascadeId: targetRoute.cascadeId,
        });
        const shouldOpenEmptyDrawer =
          isEmptyTarget && stageRef.current === 'authenticated';
        const keepDockedOpen =
          isTabletLayoutRef.current && isDrawerOpenRef.current;
        const nextDrawerOpen = shouldOpenEmptyDrawer || keepDockedOpen;

        if (shouldOpenEmptyDrawer) {
          const emptyKey = getEmptyScreenKey(
            targetRoute.instanceUuid,
            validation.normalizedUrl,
          );
          isOnEmptyScreenRef.current = true;
          currentEmptyScreenKeyRef.current = emptyKey;
          emptyScreenDismissedKeyRef.current = null;
          userClosedTabletSidebarRef.current = false;
          setDrawerInitialMode('inbox');
          isDrawerOpenRef.current = true;
          setIsDrawerOpen(true);
        } else if (!keepDockedOpen) {
          isDrawerOpenRef.current = false;
          setIsDrawerOpen(false);
        }

        if (validation.normalizedUrl !== currentNavUrlRef.current) {
          handleNavigateToUrl(validation.normalizedUrl);
          if (shouldOpenEmptyDrawer) {
            const emptyKey = getEmptyScreenKey(
              targetRoute.instanceUuid,
              validation.normalizedUrl,
            );
            isOnEmptyScreenRef.current = true;
            currentEmptyScreenKeyRef.current = emptyKey;
          }
        } else {
          recomputeSnapshotWithLocalState({
            activeInstanceUuid: targetRoute.instanceUuid,
            activeCascadeId: targetRoute.cascadeId,
            isDrawerOpen: nextDrawerOpen,
          });
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

  // Step 2c: Synchronize the single live OS action-required notification using
  // live refs so stale render closures never rewind `previousOpenActionIdsRef`.
  useEffect(() => {
    if (!isHydrated || isResettingSessionRef.current || resetRequest) {
      return;
    }
    syncActionNotificationFromState(inboxSnapshotRef.current);
  }, [
    actionNotificationMode,
    inboxSnapshot,
    isAppForeground,
    isDrawerOpen,
    isHydrated,
    isTabletLayout,
    resetRequest,
    stage,
    syncActionNotificationFromState,
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
      setActiveHostUrl(activeValidation.normalizedUrl);
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
          const drawerBlockingNow =
            isDrawerOpenRef.current && !isTabletLayoutRef.current;
          const built = reconcileRunningThreadTransitions({
            message,
            knownRunningThreadIds: knownRunningThreadIdsRef.current,
            completedUnreadAtByThreadId: completedUnreadMapRef.current,
            locallyReadAtByThreadId: locallyReadMapRef.current,
            fallbackActiveUrl: currentNavUrlRef.current,
            isAppForeground: isAppForegroundRef.current,
            isDrawerOpen: drawerBlockingNow,
          });
          lastSnapshotMessageRef.current = {
            ...message,
            activeInstanceUuid: built.activeInstanceUuid,
            activeCascadeId: built.activeCascadeId,
          };
          const prevInstanceUuid = activeInstanceUuidRef.current;
          const prevCascadeId = activeCascadeIdRef.current;
          activeInstanceUuidRef.current = built.activeInstanceUuid;
          activeCascadeIdRef.current = built.activeCascadeId;
          recordActiveRouteForBackNavigation(
            built.activeInstanceUuid,
            built.activeCascadeId,
          );

          const activeThreadKey =
            built.activeInstanceUuid && built.activeCascadeId
              ? `${built.activeInstanceUuid}:${built.activeCascadeId}`
              : null;
          const matchingActiveThread = findMatchingThread(
            built.threads,
            built.activeInstanceUuid,
            built.activeCascadeId,
          );
          const activeThreadJustArchived = Boolean(
            activeThreadKey &&
              !matchingActiveThread &&
              seenLiveActiveThreadKeyRef.current === activeThreadKey &&
              isTrajectoryMarkedArchivedInMessage(
                message,
                built.activeInstanceUuid,
                built.activeCascadeId,
              ),
          );
          const snapshotActiveUrl =
            message.activeUrl ?? currentNavUrlRef.current;
          const isEmptySnapshotRoute = isEmptyWorkspaceRoute({
            activeUrl: snapshotActiveUrl,
            activeInstanceUuid: built.activeInstanceUuid,
            activeCascadeId: built.activeCascadeId,
            isEmptyRouteHint: message.isEmptyRoute,
          });

          if (matchingActiveThread && activeThreadKey) {
            seenLiveActiveThreadKeyRef.current = activeThreadKey;
            isOnEmptyScreenRef.current = false;
            currentEmptyScreenKeyRef.current = null;
            emptyScreenDismissedKeyRef.current = null;
          } else if (
            prevInstanceUuid !== built.activeInstanceUuid ||
            prevCascadeId !== built.activeCascadeId
          ) {
            seenLiveActiveThreadKeyRef.current = null;
          }

          let openedEmptyDrawer = false;
          if (activeThreadJustArchived || isEmptySnapshotRoute) {
            if (activeThreadJustArchived) {
              seenLiveActiveThreadKeyRef.current = null;
            }
            const emptyKey = getEmptyScreenKey(
              built.activeInstanceUuid,
              snapshotActiveUrl,
            );
            isOnEmptyScreenRef.current = true;
            currentEmptyScreenKeyRef.current = emptyKey;
            openedEmptyDrawer = openDrawerForEmptyScreen(emptyKey, {
              triggerRefresh: false,
              skipSnapshotRecompute: true,
            });
          }

          const finalBuilt =
            openedEmptyDrawer && !isTabletLayoutRef.current
              ? applyLocalStateToSnapshot(built, {
                  activeInstanceUuid: built.activeInstanceUuid,
                  activeCascadeId: built.activeCascadeId,
                  locallyReadAtByThreadId: locallyReadMapRef.current,
                  isAppForeground: isAppForegroundRef.current,
                  isDrawerOpen: true,
                })
              : built;

          if (
            isAppForegroundRef.current &&
            !(openedEmptyDrawer || drawerBlockingNow) &&
            !resumeReadSettleTimerRef.current &&
            finalBuilt.activeInstanceUuid &&
            finalBuilt.activeCascadeId
          ) {
            const activeThread = findMatchingThread(
              finalBuilt.threads,
              finalBuilt.activeInstanceUuid,
              finalBuilt.activeCascadeId,
            );
            markThreadReadInWorkstationClock(activeThread, 'none');
          }
          inboxSnapshotRef.current = finalBuilt;
          // Push OS notification immediately from the direct WebView message handler so
          // proactive lock-screen alerts fire without waiting on paused React UI frames.
          syncActionNotificationFromState(finalBuilt, {
            isDrawerOpen: openedEmptyDrawer ? true : isDrawerOpenRef.current,
          });
          setInboxSnapshot(finalBuilt);
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
          if (activeCascadeId) {
            isComposingNewThreadRef.current = false;
          }
          const prevInstanceUuid = activeInstanceUuidRef.current;
          const prevCascadeId = activeCascadeIdRef.current;
          activeInstanceUuidRef.current = activeInstanceUuid;
          activeCascadeIdRef.current = activeCascadeId;
          if (
            activeInstanceUuid !== prevInstanceUuid ||
            activeCascadeId !== prevCascadeId
          ) {
            seenLiveActiveThreadKeyRef.current = null;
          }
          recordActiveRouteForBackNavigation(
            activeInstanceUuid,
            activeCascadeId,
          );
          reconcilePendingThreadProject(activeInstanceUuid, activeCascadeId);
          if (lastSnapshotMessageRef.current) {
            lastSnapshotMessageRef.current = {
              ...lastSnapshotMessageRef.current,
              activeInstanceUuid,
              activeCascadeId,
              isEmptyRoute: message.isEmptyRoute,
            };
          }
          const routeActiveUrl = message.activeUrl ?? currentNavUrlRef.current;
          const isEmptyNow = isEmptyWorkspaceRoute({
            activeUrl: routeActiveUrl,
            activeInstanceUuid,
            activeCascadeId,
            isEmptyRouteHint: message.isEmptyRoute,
          });
          if (isEmptyNow) {
            const emptyKey = getEmptyScreenKey(
              activeInstanceUuid,
              routeActiveUrl,
            );
            isOnEmptyScreenRef.current = true;
            currentEmptyScreenKeyRef.current = emptyKey;
            const opened = openDrawerForEmptyScreen(emptyKey, {
              triggerRefresh: Boolean(prevCascadeId),
              skipSnapshotRecompute: true,
            });
            recomputeSnapshotWithLocalState({
              activeInstanceUuid,
              activeCascadeId,
              isDrawerOpen: opened ? true : isDrawerOpenRef.current,
            });
            break;
          }
          isOnEmptyScreenRef.current = false;
          currentEmptyScreenKeyRef.current = null;
          emptyScreenDismissedKeyRef.current = null;
          if (
            isAppForegroundRef.current &&
            (!isDrawerOpenRef.current || isTabletLayoutRef.current) &&
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
          if (isAppForegroundRef.current) {
            setIsInboxRefreshing(true);
            armInboxRefreshTimeout();
          }
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
            activeCascadeIdRef.current = fastRoute.cascadeId;
            if (fastRoute.cascadeId) {
              isOnEmptyScreenRef.current = false;
              currentEmptyScreenKeyRef.current = null;
              emptyScreenDismissedKeyRef.current = null;
            }
            recordActiveRouteForBackNavigation(
              fastRoute.instanceUuid,
              fastRoute.cascadeId,
            );
          }
          break;
        }

        case 'AGY_INBOX_START_CHAT_RESULT': {
          const pending = pendingFastNavRef.current.get(message.requestId);
          if (!pending) {
            break;
          }
          clearTimeout(pending.timer);
          pendingFastNavRef.current.delete(message.requestId);
          const candidateValidation = validateNavigationUrl(message.targetUrl);
          const effectiveUrl =
            candidateValidation.isAllowedInApp &&
            candidateValidation.normalizedUrl
              ? candidateValidation.normalizedUrl
              : pending.targetUrl;
          const resultRoute = extractActiveRouteFromUrl(effectiveUrl);
          const resolvedCascadeId = message.cascadeId || resultRoute.cascadeId;
          if (resolvedCascadeId) {
            isComposingNewThreadRef.current = false;
            isOnEmptyScreenRef.current = false;
            currentEmptyScreenKeyRef.current = null;
            emptyScreenDismissedKeyRef.current = null;
          }
          reconcilePendingThreadProject(
            resultRoute.instanceUuid,
            resolvedCascadeId,
          );
          if (!message.handled) {
            handleNavigateToUrl(effectiveUrl, {
              preserveComposing: !resolvedCascadeId,
            });
          } else {
            syncVerifiedActiveHostUrl(effectiveUrl);
            activeInstanceUuidRef.current = resultRoute.instanceUuid;
            activeCascadeIdRef.current = resolvedCascadeId;
            recordActiveRouteForBackNavigation(
              resultRoute.instanceUuid,
              resolvedCascadeId,
            );
            recomputeSnapshotWithLocalState({
              activeInstanceUuid: resultRoute.instanceUuid,
              activeCascadeId: resolvedCascadeId,
            });
          }
          break;
        }

        case 'AGY_INBOX_HOST_SETTINGS_RESULT': {
          if (!hostSettingsFallbackTimerRef.current) {
            break;
          }
          clearTimeout(hostSettingsFallbackTimerRef.current);
          hostSettingsFallbackTimerRef.current = null;
          if (!message.handled) {
            handleNavigateToUrl(getDashboardUrlForCurrentAccount());
          }
          break;
        }

        case 'AGY_INBOX_LIST_DIR_RESULT': {
          const pending = pendingDirRequestsRef.current.get(message.requestId);
          if (!pending) {
            break;
          }
          clearTimeout(pending.timer);
          pendingDirRequestsRef.current.delete(message.requestId);
          pending.resolve({
            ok: message.ok,
            currentUri: message.currentUri,
            parentUri: message.parentUri,
            entries: message.entries,
            error: message.error,
          });
          break;
        }

        case 'AGY_INBOX_CREATE_PROJECT_RESULT': {
          const pending = pendingCreateProjectRequestsRef.current.get(
            message.requestId,
          );
          if (!pending) {
            break;
          }
          clearTimeout(pending.timer);
          pendingCreateProjectRequestsRef.current.delete(message.requestId);
          pending.resolve({
            ok: message.ok,
            projectId: message.projectId,
            projectName: message.projectName,
            workspaceUri: message.workspaceUri,
            error: message.error,
          });
          break;
        }

        case 'AGY_INBOX_OPEN_DRAWER_REQUEST': {
          handleOpenDrawer(message.mode ?? 'inbox');
          break;
        }

        case 'AGY_INBOX_EMPTY_SCREEN': {
          syncVerifiedActiveHostUrl(message.activeUrl);
          const resolvedRoute = resolveActiveRouteFromBridgeMessage(
            message,
            currentNavUrlRef.current,
          );
          if (message.reason === 'route_overview') {
            activeInstanceUuidRef.current = resolvedRoute.instanceUuid;
            activeCascadeIdRef.current = resolvedRoute.cascadeId;
            if (!resolvedRoute.cascadeId) {
              seenLiveActiveThreadKeyRef.current = null;
            }
            recordActiveRouteForBackNavigation(
              resolvedRoute.instanceUuid,
              resolvedRoute.cascadeId,
            );
            reconcilePendingThreadProject(
              resolvedRoute.instanceUuid,
              resolvedRoute.cascadeId,
            );
            if (lastSnapshotMessageRef.current) {
              lastSnapshotMessageRef.current = {
                ...lastSnapshotMessageRef.current,
                activeInstanceUuid: resolvedRoute.instanceUuid,
                activeCascadeId: resolvedRoute.cascadeId,
              };
            }
          }
          const emptyActiveUrl = message.activeUrl ?? currentNavUrlRef.current;
          const emptyKey = getEmptyScreenKey(
            resolvedRoute.instanceUuid ?? activeInstanceUuidRef.current,
            emptyActiveUrl,
          );
          isOnEmptyScreenRef.current = true;
          currentEmptyScreenKeyRef.current = emptyKey;
          const opened = openDrawerForEmptyScreen(emptyKey, {
            triggerRefresh: true,
            skipSnapshotRecompute: message.reason === 'route_overview',
          });
          if (message.reason === 'route_overview') {
            recomputeSnapshotWithLocalState({
              activeInstanceUuid: resolvedRoute.instanceUuid,
              activeCascadeId: resolvedRoute.cascadeId,
              isDrawerOpen: opened ? true : isDrawerOpenRef.current,
            });
          }
          break;
        }
      }
    },
    [
      armInboxRefreshTimeout,
      getDashboardUrlForCurrentAccount,
      handleNavigateToUrl,
      handleOpenDrawer,
      markThreadReadInWorkstationClock,
      openDrawerForEmptyScreen,
      recomputeSnapshotWithLocalState,
      reconcilePendingThreadProject,
      recordActiveRouteForBackNavigation,
      syncActionNotificationFromState,
      syncVerifiedActiveHostUrl,
    ],
  );

  const activeThreadProject = useMemo(
    () =>
      stage === 'authenticated'
        ? resolveActiveThreadProject(inboxSnapshot, {
            activeUrl: activeHostUrl,
            fallbackProject: pendingThreadProject,
          })
        : null,
    [activeHostUrl, inboxSnapshot, pendingThreadProject, stage],
  );
  activeThreadProjectRef.current = activeThreadProject;

  const activeThreadProjectSig = activeThreadProject
    ? JSON.stringify(activeThreadProject)
    : 'null';

  useEffect(() => {
    if (!isHydrated || isResettingSessionRef.current || resetRequest) {
      lastSyncedThreadProjectSigRef.current = null;
      return;
    }
    if (
      lastSyncedThreadProjectSigRef.current === activeThreadProjectSig &&
      activeThreadProjectSig === 'null'
    ) {
      return;
    }
    if (
      lastSyncedThreadProjectSigRef.current === null &&
      activeThreadProjectSig === 'null'
    ) {
      lastSyncedThreadProjectSigRef.current = 'null';
      return;
    }
    lastSyncedThreadProjectSigRef.current = activeThreadProjectSig;
    webViewRef.current?.injectJavaScript(
      buildSyncThreadContextScript(activeThreadProjectRef.current),
    );
  }, [
    activeThreadProjectSig,
    isHydrated,
    resetRequest,
    webViewInstanceKey,
  ]);

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
          <ActivityIndicator
            size="large"
            color={ANTIGRAVITY_THEME.colors.primaryText}
          />
        )}
      </View>
    );
  }

  if (!isHydrated) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator
          size="large"
          color={ANTIGRAVITY_THEME.colors.primaryText}
        />
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
    <View style={styles.root}>
      <TopStatusBanner stage={stage} onRetryPress={handleReloadSession} />

      <View style={styles.workspaceArea}>
        <View
          testID="webview-wrapper"
          style={[
            styles.webViewWrapper,
            isTabletLayout && isDrawerOpen
              ? { marginLeft: dockedSidebarWidth }
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
              setStageSynced('offline');
            }}
            onHttpError={(syntheticEvent) => {
              if (syntheticEvent.nativeEvent.statusCode >= 502) {
                setStageSynced('offline');
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
          docked={isTabletLayout}
          initialMode={drawerInitialMode}
          drawerModeRequestKey={drawerModeRequestKey}
          focusInboxRequestKey={focusInboxRequestKey}
          isKeyboardVisible={isKeyboardVisible}
          keyboardBottomPadding={keyboardBottomPadding}
          hasSeenGuidance={hasSeenDrawerGuidance}
          stage={stage}
          activeUrl={activeHostUrl}
          snapshot={inboxSnapshot}
          isRefreshing={isInboxRefreshing}
          attentionCount={inboxCounts.attention}
          urgentAttentionCount={inboxCounts.urgent}
          runningCount={inboxCounts.running}
          keepAliveMinutes={keepAliveMinutes}
          actionNotificationMode={actionNotificationMode}
          onOpen={handleOpenDrawer}
          onClose={handleCloseDrawer}
          onDismissGuidance={handleDismissDrawerGuidance}
          onRegisterBackHandler={registerDrawerBackInterceptor}
          onRefreshInbox={handleRefreshInbox}
          onSelectThread={handleSelectInboxThread}
          onStartProjectThread={handleStartProjectThread}
          onListDirectory={handleListDirectory}
          onCreateProject={handleCreateProject}
          onMarkThreadRead={handleMarkThreadRead}
          onMarkAllRead={handleMarkAllRead}
          onChangeKeepAliveMinutes={handleChangeKeepAliveMinutes}
          onChangeActionNotificationMode={handleChangeActionNotificationMode}
          onNavigateToUrl={handleNavigateToUrl}
          onOpenHostSettings={handleOpenHostSettings}
          onOpenIntroTour={handleOpenIntroTour}
          onReloadSession={handleReloadSession}
          onSignOut={handleSignOut}
        />
      </View>

      <IntroTourModal
        visible={isIntroTourOpen}
        stage={stage}
        isTabletLayout={isTabletLayout}
        actionNotificationMode={actionNotificationMode}
        keepAliveMinutes={keepAliveMinutes}
        notificationPermissionStatus={notificationPermissionStatus}
        onChangeActionNotificationMode={handleChangeActionNotificationMode}
        onChangeKeepAliveMinutes={handleChangeKeepAliveMinutes}
        onRequestNotificationPermission={handleRequestNotificationPermission}
        onComplete={handleCompleteIntroTour}
        onRegisterBackHandler={registerIntroTourBackInterceptor}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: ANTIGRAVITY_THEME.colors.canvas,
  },
  workspaceArea: {
    flex: 1,
  },
  webViewWrapper: {
    flex: 1,
    backgroundColor: ANTIGRAVITY_THEME.colors.canvas,
  },
  webViewContainer: {
    flex: 1,
    backgroundColor: ANTIGRAVITY_THEME.colors.canvas,
  },
  webView: {
    flex: 1,
    backgroundColor: ANTIGRAVITY_THEME.colors.canvas,
  },
  loadingScreen: {
    flex: 1,
    backgroundColor: ANTIGRAVITY_THEME.colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  loadingTitle: {
    marginTop: 16,
    color: ANTIGRAVITY_THEME.colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  loadingSubtitle: {
    marginTop: 6,
    color: ANTIGRAVITY_THEME.colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: ANTIGRAVITY_THEME.colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  errorHeading: {
    color: ANTIGRAVITY_THEME.colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorBody: {
    color: ANTIGRAVITY_THEME.colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 22,
  },
  primaryRetryButton: {
    backgroundColor: ANTIGRAVITY_THEME.colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryRetryText: {
    color: ANTIGRAVITY_THEME.colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
});
