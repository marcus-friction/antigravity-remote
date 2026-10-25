import * as Linking from 'expo-linking';
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  BackHandler,
  Keyboard,
  KeyboardEvent,
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  WebView,
  WebViewNavigation,
} from 'react-native-webview';
import { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { ANTIGRAVITY_DASHBOARD_URL } from '../constants/config';
import {
  backupCookiesFromWebView,
  clearSession,
  getGoogleSessionSignature,
  getLastActiveUrl,
  hydrateCookiesToWebView,
  saveLastActiveUrl,
} from '../services/sessionVault';
import { AuthFlowStage } from '../types/session';
import {
  isGoogleCookieErrorUrl,
  isInternalWebViewSchemeUrl,
  validateNavigationUrl,
} from '../utils/urlValidator';
import { getCleanMobileUserAgent } from '../utils/userAgent';
import { FloatingControlPill } from './FloatingControlPill';
import { HandoffModal } from './HandoffModal';
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
  isInitialUrlResolved?: boolean;
  onDeepLinkConsumed: () => void;
}

export const RemoteWebView: React.FC<RemoteWebViewProps> = ({
  incomingDeepLinkUrl,
  isInitialUrlResolved = true,
  onDeepLinkConsumed,
}) => {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView | null>(null);
  const canGoBackRef = useRef<boolean>(false);
  const uncompressedHeightRef = useRef<number>(0);
  const cookieRecoveryAttemptsRef = useRef<number>(0);
  const isRecoveringCookiesRef = useRef<boolean>(false);
  const currentNavUrlRef = useRef<string>(ANTIGRAVITY_DASHBOARD_URL);
  const stageRef = useRef<AuthFlowStage>('hydrating');
  const baselineAuthSigRef = useRef<string | null>(null);
  const post2faReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [currentSourceUrl, setCurrentSourceUrl] = useState<string>(
    ANTIGRAVITY_DASHBOARD_URL
  );
  const [stage, setStage] = useState<AuthFlowStage>('hydrating');
  const [hasNetworkError, setHasNetworkError] = useState<boolean>(false);
  const [isModalVisible, setIsModalVisible] = useState<boolean>(false);
  const [lastSyncedCookieCount, setLastSyncedCookieCount] = useState<number>(0);
  const [webViewInstanceKey, setWebViewInstanceKey] = useState<number>(1);
  const [rawKeyboardHeight, setRawKeyboardHeight] = useState<number>(0);
  const [rootLayoutHeight, setRootLayoutHeight] = useState<number>(0);

  const syncCookiesToVault = useCallback(async () => {
    const count = await backupCookiesFromWebView();
    if (count > 0) {
      setLastSyncedCookieCount(count);
    }
  }, []);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

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
      const restoredCount = await hydrateCookiesToWebView();
      const savedUrl = await getLastActiveUrl();

      if (!isMounted) {
        return;
      }

      const initialTarget = incomingDeepLinkUrl ?? savedUrl;
      setLastSyncedCookieCount(restoredCount);
      setCurrentSourceUrl(initialTarget);
      currentNavUrlRef.current = initialTarget;
      if (incomingDeepLinkUrl) {
        onDeepLinkConsumed();
      }
      setStage('authenticated');
      setIsHydrated(true);
    }

    initializeSession();

    return () => {
      isMounted = false;
    };
  }, [incomingDeepLinkUrl, isHydrated, isInitialUrlResolved, onDeepLinkConsumed]);

  // Step 2: Handle incoming deep links when the app is already mounted
  useEffect(() => {
    if (!isHydrated || !incomingDeepLinkUrl) {
      return;
    }

    const validation = validateNavigationUrl(incomingDeepLinkUrl);
    if (
      validation.isValid &&
      validation.normalizedUrl &&
      validation.isAllowedInApp &&
      validation.normalizedUrl !== currentNavUrlRef.current
    ) {
      setHasNetworkError(false);
      setCurrentSourceUrl(validation.normalizedUrl);
      currentNavUrlRef.current = validation.normalizedUrl;
      void saveLastActiveUrl(validation.normalizedUrl);
    }
    onDeepLinkConsumed();
  }, [incomingDeepLinkUrl, isHydrated, onDeepLinkConsumed]);

  // Step 3: Flush & back up cookies whenever the app transitions to background/inactive,
  // and wake up / complete 2-Step Verification when returning to active
  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    const subscription = AppState.addEventListener(
      'change',
      (nextAppState: AppStateStatus) => {
        if (nextAppState === 'background' || nextAppState === 'inactive') {
          void syncCookiesToVault();
        } else if (nextAppState === 'active') {
          void syncCookiesToVault();
          if (stageRef.current === 'authenticating') {
            webViewRef.current?.injectJavaScript(`
              (function() {
                try {
                  window.dispatchEvent(new Event('focus'));
                  document.dispatchEvent(new Event('visibilitychange'));
                  window.dispatchEvent(new Event('online'));
                } catch (_) {}
                return true;
              })();
            `);
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
      }
    );

    return () => {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
      }
      subscription.remove();
    };
  }, [checkPost2faSessionAndAdvance, syncCookiesToVault]);

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

  // Step 5: Android hardware Back button navigation within WebView history
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const onHardwareBackPress = (): boolean => {
      if (canGoBackRef.current && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      onHardwareBackPress
    );

    return () => {
      subscription.remove();
    };
  }, []);

  const handleRootLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measuredHeight = event?.nativeEvent?.layout?.height ?? 0;
      if (measuredHeight <= 0) {
        return;
      }
      setRootLayoutHeight(measuredHeight);
      if (rawKeyboardHeight === 0 || measuredHeight > uncompressedHeightRef.current) {
        uncompressedHeightRef.current = measuredHeight;
      }
    },
    [rawKeyboardHeight]
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

  const recoverFromCookieMismatch = useCallback(async () => {
    if (isRecoveringCookiesRef.current || cookieRecoveryAttemptsRef.current >= 2) {
      return;
    }
    isRecoveringCookiesRef.current = true;
    cookieRecoveryAttemptsRef.current += 1;
    try {
      await clearSession();
      webViewRef.current?.clearCache?.(true);
      setLastSyncedCookieCount(0);
      setHasNetworkError(false);
      setStage('authenticating');
      setCurrentSourceUrl(ANTIGRAVITY_DASHBOARD_URL);
      setWebViewInstanceKey((prev) => prev + 1);
    } finally {
      isRecoveringCookiesRef.current = false;
    }
  }, []);

  const handleShouldStartLoadWithRequest = useCallback(
    (request: ShouldStartLoadRequest): boolean => {
      if (isInternalWebViewSchemeUrl(request.url)) {
        return true;
      }

      if (isGoogleCookieErrorUrl(request.url)) {
        void recoverFromCookieMismatch();
        return false;
      }

      const validation = validateNavigationUrl(request.url);
      if (!validation.isValid || !validation.normalizedUrl) {
        return false;
      }

      if (validation.isAllowedInApp) {
        return true;
      }

      // Valid external HTTPS link on top frame: open safely in the OS browser
      if (request.isTopFrame !== false) {
        void Linking.openURL(validation.normalizedUrl);
      }
      return false;
    },
    [recoverFromCookieMismatch]
  );

  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      canGoBackRef.current = Boolean(navState.canGoBack);
      if (navState.url) {
        currentNavUrlRef.current = navState.url;
      }

      if (isGoogleCookieErrorUrl(navState.url)) {
        void recoverFromCookieMismatch();
        return;
      }

      const validation = validateNavigationUrl(navState.url);
      if (!validation.isValid || !validation.normalizedUrl) {
        return;
      }

      if (validation.isAuthHost) {
        setStage('authenticating');
        if (!navState.loading) {
          void checkPost2faSessionAndAdvance();
        }
        return;
      }

      setStage('authenticated');

      const parsed = new URL(validation.normalizedUrl);
      if (parsed.hostname.toLowerCase() === 'antigravity.google.com') {
        cookieRecoveryAttemptsRef.current = 0;
        void saveLastActiveUrl(validation.normalizedUrl);
        if (!navState.loading) {
          void syncCookiesToVault();
        }
      }
    },
    [checkPost2faSessionAndAdvance, recoverFromCookieMismatch, syncCookiesToVault]
  );

  const handleLoadEnd = useCallback(() => {
    void syncCookiesToVault();
    webViewRef.current?.injectJavaScript(KEYBOARD_ADAPTATION_SCRIPT);
  }, [syncCookiesToVault]);

  const handleReloadSession = useCallback(() => {
    setHasNetworkError(false);
    void syncCookiesToVault();
    webViewRef.current?.reload();
  }, [syncCookiesToVault]);

  const handleNavigateToUrl = useCallback((targetUrl: string) => {
    const validation = validateNavigationUrl(targetUrl);
    if (!validation.isValid || !validation.normalizedUrl || !validation.isAllowedInApp) {
      return;
    }
    setHasNetworkError(false);
    setCurrentSourceUrl(validation.normalizedUrl);
    void saveLastActiveUrl(validation.normalizedUrl);
  }, []);

  const handleSignOut = useCallback(async () => {
    await clearSession();
    webViewRef.current?.clearCache?.(true);
    setLastSyncedCookieCount(0);
    setHasNetworkError(false);
    setStage('authenticating');
    setCurrentSourceUrl(ANTIGRAVITY_DASHBOARD_URL);
    setWebViewInstanceKey((prev) => prev + 1);
  }, []);

  if (!isHydrated) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#60A5FA" />
        <Text style={styles.loadingTitle}>Antigravity Remote</Text>
        <Text style={styles.loadingSubtitle}>
          Restoring encrypted Google session...
        </Text>
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
        {hasNetworkError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorHeading}>
              Unable to reach Antigravity Remote
            </Text>
            <Text style={styles.errorBody}>
              Check your internet connection. Your Google session cookies remain
              safely stored on this device.
            </Text>
            <TouchableOpacity
              style={styles.primaryRetryButton}
              onPress={handleReloadSession}
              accessibilityRole="button"
            >
              <Text style={styles.primaryRetryText}>Reconnect</Text>
            </TouchableOpacity>
          </View>
        ) : (
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
            injectedJavaScript={KEYBOARD_ADAPTATION_SCRIPT}
            originWhitelist={['https://*', 'about:blank', 'about:srcdoc', 'blob:*']}
            onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
            onNavigationStateChange={handleNavigationStateChange}
            onLoadEnd={handleLoadEnd}
            onError={() => {
              setHasNetworkError(true);
              setStage('offline');
            }}
            onHttpError={(syntheticEvent) => {
              if (syntheticEvent.nativeEvent.statusCode >= 502) {
                setStage('offline');
              }
            }}
          />
        )}
      </View>

      {!isKeyboardVisible ? (
        <FloatingControlPill
          stage={stage}
          onPress={() => setIsModalVisible(true)}
        />
      ) : null}

      <HandoffModal
        visible={isModalVisible}
        stage={stage}
        lastSyncedCookieCount={lastSyncedCookieCount}
        onClose={() => setIsModalVisible(false)}
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
