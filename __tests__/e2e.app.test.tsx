jest.mock('../src/services/webData', () => ({
  clearWebData: jest.fn(async () => undefined),
  configureNativeKeepAlive: jest.fn(async () => undefined),
}));
import React from 'react';
import renderer, { act, ReactTestRenderer } from 'react-test-renderer';

const mockSecureStoreData = new Map<string, string>();
const mockCookieStore = new Map<string, Record<string, any>>();
const mockAppStateListeners = new Set<(state: string) => void>();
const mockKeyboardShowListeners = new Set<(event: any) => void>();
const mockKeyboardHideListeners = new Set<() => void>();
const mockLinkingListeners = new Set<(event: { url: string }) => void>();
const mockBackPressListeners = new Set<() => boolean>();
let mockInitialUrl: string | null = null;
const mockOpenURL = jest.fn(async (_url: string) => true);
const mockPermissionsCheck = jest.fn(async (_permission: string) => false);
const mockPermissionsRequest = jest.fn(
  async (_permission: string) => 'granted',
);

jest.mock('react-native', () => {
  const ReactLib = require('react');
  const mockComponent = (name: string) =>
    ReactLib.forwardRef((props: any, ref: any) =>
      ReactLib.createElement(name, { ...props, ref }, props.children),
    );

  class MockAnimatedValue {
    _value: number;
    constructor(initialValue: number) {
      this._value = initialValue;
    }
    setValue(nextValue: number) {
      this._value = nextValue;
    }
    interpolate() {
      return 1;
    }
  }

  return {
    Platform: { OS: 'ios', Version: 34 },
    PermissionsAndroid: {
      check: (permission: string) => mockPermissionsCheck(permission),
      request: (permission: string) => mockPermissionsRequest(permission),
      RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
    },
    StyleSheet: {
      create: (styles: any) => styles,
      hairlineWidth: 1,
      absoluteFillObject: {},
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Animated: {
      Value: MockAnimatedValue,
      View: mockComponent('Animated.View'),
      timing: (val: any, config: any) => ({
        start: (cb?: (result: { finished: boolean }) => void) => {
          if (val && typeof val.setValue === 'function' && typeof config?.toValue === 'number') {
            val.setValue(config.toValue);
          }
          cb?.({ finished: true });
        },
      }),
      spring: (val: any, config: any) => ({
        start: (cb?: (result: { finished: boolean }) => void) => {
          if (val && typeof val.setValue === 'function' && typeof config?.toValue === 'number') {
            val.setValue(config.toValue);
          }
          cb?.({ finished: true });
        },
      }),
    },
    PanResponder: {
      create: (handlers: any) => ({ panHandlers: handlers }),
    },
    View: mockComponent('View'),
    ScrollView: mockComponent('ScrollView'),
    Text: mockComponent('Text'),
    TextInput: mockComponent('TextInput'),
    TouchableOpacity: mockComponent('TouchableOpacity'),
    Pressable: mockComponent('Pressable'),
    Modal: ({ visible, children, ...rest }: any) =>
      visible
        ? ReactLib.createElement('Modal', { visible, ...rest }, children)
        : null,
    KeyboardAvoidingView: mockComponent('KeyboardAvoidingView'),
    ActivityIndicator: mockComponent('ActivityIndicator'),
    AppState: {
      addEventListener: jest.fn(
        (_event: string, handler: (s: string) => void) => {
          mockAppStateListeners.add(handler);
          return {
            remove: () => mockAppStateListeners.delete(handler),
          };
        },
      ),
    },
    Keyboard: {
      addListener: jest.fn((event: string, handler: any) => {
        if (event === 'keyboardWillShow' || event === 'keyboardDidShow') {
          mockKeyboardShowListeners.add(handler);
          return { remove: () => mockKeyboardShowListeners.delete(handler) };
        }
        mockKeyboardHideListeners.add(handler);
        return { remove: () => mockKeyboardHideListeners.delete(handler) };
      }),
    },
    BackHandler: {
      addEventListener: jest.fn((_event: string, handler: () => boolean) => {
        mockBackPressListeners.add(handler);
        return { remove: () => mockBackPressListeners.delete(handler) };
      }),
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactLib = require('react');
  return {
    SafeAreaProvider: ({ children }: any) =>
      ReactLib.createElement('SafeAreaProvider', null, children),
    SafeAreaView: ({ children, ...props }: any) =>
      ReactLib.createElement('SafeAreaView', props, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('expo-status-bar', () => {
  const ReactLib = require('react');
  return {
    StatusBar: (props: any) => ReactLib.createElement('StatusBar', props),
  };
});

jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn(async () => mockInitialUrl),
  addEventListener: jest.fn(
    (_type: string, handler: (e: { url: string }) => void) => {
      mockLinkingListeners.add(handler);
      return {
        remove: () => mockLinkingListeners.delete(handler),
      };
    },
  ),
  openURL: (url: string) => mockOpenURL(url),
}));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStoreData.set(key, value);
  }),
  getItemAsync: jest.fn(async (key: string) => {
    return mockSecureStoreData.get(key) ?? null;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStoreData.delete(key);
  }),
}));

jest.mock('@preeternal/react-native-cookie-manager', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (url: string) => {
      return mockCookieStore.get(url) ?? {};
    }),
    set: jest.fn(async (url: string, cookie: any) => {
      const existing = mockCookieStore.get(url) ?? {};
      existing[cookie.name] = cookie;
      mockCookieStore.set(url, existing);
      return true;
    }),
    clearAll: jest.fn(async () => {
      mockCookieStore.clear();
      return true;
    }),
    flush: jest.fn(async () => undefined),
  },
}));

let mockWebViewMountCount = 0;
const mockWebViewReload = jest.fn();
const mockWebViewGoBack = jest.fn();
const mockWebViewClearCache = jest.fn();
const mockWebViewInjectJavaScript = jest.fn();

jest.mock('react-native-webview', () => {
  const ReactLib = require('react');
  const WebView = ReactLib.forwardRef((props: any, ref: any) => {
    ReactLib.useEffect(() => {
      mockWebViewMountCount++;
    }, []);
    ReactLib.useImperativeHandle(ref, () => ({
      reload: mockWebViewReload,
      goBack: mockWebViewGoBack,
      clearCache: mockWebViewClearCache,
      injectJavaScript: mockWebViewInjectJavaScript,
      stopLoading: jest.fn(),
    }));
    return ReactLib.createElement('WebView', props);
  });
  return { WebView };
});

import App from '../App';
import {
  clearWebData,
  configureNativeKeepAlive,
} from '../src/services/webData';
import {
  CLOSED_HANDLE_TOUCH_LEFT,
  HANDLE_LINE_HEIGHT,
  HANDLE_LINE_WIDTH,
  LeftNavigationDrawer,
} from '../src/components/LeftNavigationDrawer';
import { RemoteWebView } from '../src/components/RemoteWebView';
import { resumeSessionPersistence } from '../src/services/sessionVault';
import { SECURE_STORE_META_KEY } from '../src/constants/config';
import {
  backupCookiesFromWebView,
  saveLastActiveUrl,
} from '../src/services/sessionVault';

describe('End-to-End <App /> Flow', () => {
  beforeEach(() => {
    resumeSessionPersistence();
    mockSecureStoreData.clear();
    mockCookieStore.clear();
    mockAppStateListeners.clear();
    mockLinkingListeners.clear();
    mockBackPressListeners.clear();
    mockInitialUrl = null;
    mockOpenURL.mockClear();
    mockWebViewReload.mockClear();
    mockWebViewGoBack.mockClear();
    mockWebViewClearCache.mockClear();
  });

  it('hydrates vaulted Google cookies on cold start, handles Google Login & 2FA backgrounding, navigates via CLI handoff & deep links, and wipes vault on Sign Out', async () => {
    // 1. Seed initial Google session cookies into the encrypted SecureStore vault
    mockCookieStore.set('https://antigravity.google.com', {
      SID: {
        name: 'SID',
        value: 'initial-sid-cookie',
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
      '__Secure-1PSID': {
        name: '__Secure-1PSID',
        value: 'initial-1psid-cookie',
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
    });
    await backupCookiesFromWebView();
    await saveLastActiveUrl(
      'https://antigravity.google.com/r/saved-workstation',
    );

    // Simulate OS evicting WebView cookies while app was killed
    mockCookieStore.clear();
    expect(mockCookieStore.size).toBe(0);

    // 2. Cold-boot <App />
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<App />);
    });

    // Verify cookies were hydrated into CookieManager BEFORE WebView mounted
    expect(
      mockCookieStore.get('https://antigravity.google.com')?.SID?.value,
    ).toBe('initial-sid-cookie');

    const webView = tree.root.findByType('WebView' as any);
    expect(webView.props.source.uri).toBe(
      'https://antigravity.google.com/r/saved-workstation',
    );
    expect(webView.props.userAgent).toContain('Safari/604.1');
    expect(webView.props.sharedCookiesEnabled).toBe(true);
    expect(webView.props.thirdPartyCookiesEnabled).toBe(true);

    // 3. Simulate redirect to Google Sign-In (`accounts.google.com`)
    await act(async () => {
      webView.props.onNavigationStateChange({
        url: 'https://accounts.google.com/v3/signin/identifier',
        loading: false,
        canGoBack: true,
      });
    });

    const allTextsDuringAuth = tree.root
      .findAllByType('Text' as any)
      .map((node) => node.props.children);
    expect(allTextsDuringAuth).toContain(
      'Google Sign-In active — your session will be saved automatically',
    );

    // 4. Simulate user switching to Google Authenticator app (`AppState` -> 'background')
    mockCookieStore.set('https://accounts.google.com', {
      LSID: {
        name: 'LSID',
        value: 'fresh-2fa-lsid',
        domain: 'accounts.google.com',
        path: '/',
      },
    });

    await act(async () => {
      for (const listener of mockAppStateListeners) {
        listener('background');
      }
    });

    // WebView stays mounted and cookies are backed up to SecureStore
    expect(tree.root.findAllByType('WebView' as any).length).toBe(1);
    const metaAfter2FA = JSON.parse(
      mockSecureStoreData.get(SECURE_STORE_META_KEY)!,
    );
    expect(metaAfter2FA.cookieCount).toBe(3);

    // 5. Simulate completing Google Sign-In and landing on Antigravity Remote dashboard
    await act(async () => {
      webView.props.onNavigationStateChange({
        url: 'https://antigravity.google.com/',
        loading: false,
        canGoBack: true,
      });
    });

    const allTextsAfterAuth = tree.root
      .findAllByType('Text' as any)
      .map((node) => node.props.children);
    expect(allTextsAfterAuth).not.toContain(
      'Google Sign-In active — your session will be saved automatically',
    );

    // 6. Open unified left-hand navigation drawer, switch to Session mode, and paste CLI output
    expect(
      tree.root.findAll(
        (node) =>
          node.type === ('TouchableOpacity' as any) &&
          node.props.accessibilityLabel === 'Open Antigravity Remote controls',
      ),
    ).toHaveLength(0);

    const drawerHandleButton = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    expect(drawerHandleButton).toBeDefined();

    await act(async () => {
      drawerHandleButton.props.onPress();
    });

    const sessionModeBtn = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Drawer mode Session',
    )[0];
    await act(async () => {
      sessionModeBtn.props.onPress();
    });

    const handoffInput = tree.root.findAll(
      (node) =>
        node.type === ('TextInput' as any) &&
        node.props.accessibilityLabel === 'CLI handoff link or instance ID',
    )[0];
    await act(async () => {
      handoffInput.props.onChangeText(
        'Remote control on for this session.\nOpen https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F777 on another device',
      );
    });

    const goButton = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Connect to handoff instance',
    )[0];

    await act(async () => {
      goButton.props.onPress();
    });

    const updatedWebView = tree.root.findByType('WebView' as any);
    expect(updatedWebView.props.source.uri).toBe(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F777',
    );

    // 7. Verify external links open in system browser while allow-listed links stay in-app
    let allowInApp = false;
    let allowExternal = true;
    await act(async () => {
      allowInApp = updatedWebView.props.onShouldStartLoadWithRequest({
        url: 'https://antigravity.google.com/r/another-box',
      });
      allowExternal = updatedWebView.props.onShouldStartLoadWithRequest({
        url: 'https://github.com/google-antigravity/antigravity-sdk-python',
      });
    });

    expect(allowInApp).toBe(true);
    expect(allowExternal).toBe(false);
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://github.com/google-antigravity/antigravity-sdk-python',
    );

    // 8. Simulate incoming OS Deep Link (`antigravity-remote://r/deep-linked-host`)
    await act(async () => {
      for (const listener of mockLinkingListeners) {
        listener({ url: 'antigravity-remote://r/deep-linked-host' });
      }
    });

    expect(tree.root.findByType('WebView' as any).props.source.uri).toBe(
      'https://antigravity.google.com/r/deep-linked-host',
    );

    // 8b. Simulate software keyboard opening when focusing the bottom chat box
    await act(async () => {
      for (const listener of mockKeyboardShowListeners) {
        listener({ endCoordinates: { height: 336 } });
      }
    });

    // Verify closed left-drawer handle hides while typing and WebView wrapper shrinks above keyboard
    expect(
      tree.root.findAll(
        (node) =>
          node.type === ('TouchableOpacity' as any) &&
          node.props.accessibilityLabel === 'Open Antigravity drawer',
      ).length,
    ).toBe(0);
    expect(mockWebViewInjectJavaScript).toHaveBeenCalled();

    // Simulate keyboard closing
    await act(async () => {
      for (const listener of mockKeyboardHideListeners) {
        listener();
      }
    });

    const restoredDrawerHandle = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    expect(restoredDrawerHandle).toBeDefined();

    // 9. Test Sign Out flow: wipes CookieManager, SecureStore chunks, and resets WebView
    await act(async () => {
      restoredDrawerHandle.props.onPress();
    });

    const sessionModeBtnForSignOut = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Drawer mode Session',
    )[0];
    await act(async () => {
      sessionModeBtnForSignOut.props.onPress();
    });

    const signOutTrigger = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node
          .findAllByType('Text' as any)
          .some((t) => t.props.children === 'Sign Out of Google Account'),
    )[0];

    await act(async () => {
      signOutTrigger.props.onPress();
    });

    const confirmSignOutBtn = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node
          .findAllByType('Text' as any)
          .some((t) => t.props.children === 'Confirm Sign Out'),
    )[0];

    await act(async () => {
      await confirmSignOutBtn.props.onPress();
    });

    expect(mockCookieStore.size).toBe(0);
    expect(mockSecureStoreData.get(SECURE_STORE_META_KEY)).toBeUndefined();
    expect(clearWebData).toHaveBeenCalled();
    expect(tree.root.findByType('WebView' as any).props.source.uri).toBe(
      'https://antigravity.google.com',
    );

    // 10. Simulate encountering Google's CookieMismatch error screen and verify automatic self-healing
    mockCookieStore.set('https://accounts.google.com', {
      SID: { name: 'SID', value: 'corrupted-sid', domain: '.google.com' },
    });

    const currentWv = tree.root.findByType('WebView' as any);
    await act(async () => {
      currentWv.props.onNavigationStateChange({
        url: 'https://accounts.google.com/CookieMismatch',
        loading: false,
        canGoBack: false,
      });
    });

    // Corrupted cookies are automatically wiped and WebView remounts cleanly at dashboard URL
    expect(mockCookieStore.size).toBe(0);
    expect(tree.root.findByType('WebView' as any).props.source.uri).toBe(
      'https://antigravity.google.com',
    );
    await act(async () => tree.unmount());
  });
});

describe('Session and navigation regressions', () => {
  let tree: ReactTestRenderer;
  beforeEach(async () => {
    resumeSessionPersistence();
    mockSecureStoreData.clear();
    mockCookieStore.clear();
    mockAppStateListeners.clear();
    mockKeyboardShowListeners.clear();
    mockKeyboardHideListeners.clear();
    mockLinkingListeners.clear();
    mockBackPressListeners.clear();
    mockInitialUrl = null;
    mockWebViewMountCount = 0;
    mockOpenURL.mockClear();
    mockWebViewReload.mockClear();
    mockWebViewInjectJavaScript.mockClear();
    mockPermissionsCheck.mockReset().mockResolvedValue(false);
    mockPermissionsRequest.mockReset().mockResolvedValue('granted');
    const RNPlatform = require('react-native').Platform;
    RNPlatform.OS = 'ios';
    RNPlatform.Version = 34;
    (clearWebData as jest.Mock).mockReset().mockResolvedValue(undefined);
    (configureNativeKeepAlive as jest.Mock)
      .mockReset()
      .mockResolvedValue(undefined);
    await act(async () => {
      tree = renderer.create(<App />);
    });
  });
  afterEach(async () => {
    await act(async () => tree.unmount());
  });
  const webView = () => tree.root.findByType('WebView' as any);
  const controls = () => tree.root.findByType(LeftNavigationDrawer);
  const navigate = async (url: string, loading = false) => {
    await act(async () =>
      webView().props.onNavigationStateChange({
        url,
        loading,
        canGoBack: true,
      }),
    );
  };

  it('does not replace the saved vault with an empty snapshot before initial hydration', async () => {
    await act(async () => tree.unmount());
    mockCookieStore.set('https://antigravity.google.com', {
      SID: { name: 'SID', value: 'saved-session', domain: '.google.com' },
    });
    await backupCookiesFromWebView();
    mockCookieStore.clear();
    const committed = mockSecureStoreData.get(SECURE_STORE_META_KEY);
    const onConsumed = jest.fn();
    await act(async () => {
      tree = renderer.create(
        <RemoteWebView
          incomingDeepLinkUrl={null}
          isInitialUrlResolved={false}
          onDeepLinkConsumed={onConsumed}
        />,
      );
    });
    await act(async () => {
      for (const listener of mockAppStateListeners) listener('active');
      for (const listener of mockAppStateListeners) listener('background');
    });
    expect(mockSecureStoreData.get(SECURE_STORE_META_KEY)).toBe(committed);
    await act(async () =>
      tree.update(
        <RemoteWebView
          incomingDeepLinkUrl={null}
          isInitialUrlResolved={true}
          onDeepLinkConsumed={onConsumed}
        />,
      ),
    );
    expect(
      mockCookieStore.get('https://antigravity.google.com')?.SID.value,
    ).toBe('saved-session');
  });

  it('navigates to the original source again after an in-page navigation', async () => {
    await act(async () =>
      controls().props.onNavigateToUrl('https://antigravity.google.com'),
    );
    const mounts = mockWebViewMountCount;
    await navigate('https://antigravity.google.com/r/browser-session');
    await act(async () =>
      controls().props.onNavigateToUrl('https://antigravity.google.com'),
    );
    expect(webView().props.source.uri).toBe('https://antigravity.google.com/');
    expect(mockWebViewMountCount).toBe(mounts + 1);
  });

  it('keeps the current native page mounted and reloads it after a network error', async () => {
    await navigate('https://accounts.google.com/v3/signin/challenge/totp');
    const mounts = mockWebViewMountCount;
    await act(async () => webView().props.onError({ nativeEvent: {} }));
    expect(tree.root.findAllByType('WebView' as any)).toHaveLength(1);
    await act(async () => controls().props.onReloadSession());
    expect(mockWebViewMountCount).toBe(mounts);
    expect(mockWebViewReload).toHaveBeenCalledTimes(1);
  });

  it('does not clear sessions for a query string or a subframe error page', async () => {
    const count = (clearWebData as jest.Mock).mock.calls.length;
    await act(async () => {
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://antigravity.google.com/r/box?message=CookieMismatch',
          isTopFrame: true,
        }),
      ).toBe(true);
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://accounts.google.com/CookieMismatch',
          isTopFrame: false,
        }),
      ).toBe(true);
    });
    expect(clearWebData).toHaveBeenCalledTimes(count);
  });

  it('routes every URL through the policy and hands off only external HTTPS documents', async () => {
    expect(webView().props.originWhitelist).toEqual(['*']);
    await act(async () => {
      for (const url of [
        'http://example.com',
        'intent://example.com',
        'file:///tmp/test',
        'javascript:alert(1)',
        'blob:https://evil.example/id',
      ]) {
        expect(
          webView().props.onShouldStartLoadWithRequest({
            url,
            isTopFrame: true,
          }),
        ).toBe(false);
      }
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'about:blank',
          isTopFrame: true,
        }),
      ).toBe(false);
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'about:blank',
          isTopFrame: false,
        }),
      ).toBe(true);
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://www.google.com/recaptcha/api2/anchor',
          isTopFrame: false,
        }),
      ).toBe(true);
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://antigravity.static.usercontent.goog/web/1.0.20260910010023/?iframe=true',
          isTopFrame: false,
        }),
      ).toBe(true);
    });
    expect(mockOpenURL).not.toHaveBeenCalled();
    await act(async () => {
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://antigravity.static.usercontent.goog/web/1.0.20260910010023/?iframe=true',
          isTopFrame: true,
        }),
      ).toBe(false);
    });
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://antigravity.static.usercontent.goog/web/1.0.20260910010023/?iframe=true',
    );
    mockOpenURL.mockClear();
    await act(async () => {
      expect(
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://storage.googleapis.com/untrusted/index.html',
          isTopFrame: true,
        }),
      ).toBe(false);
    });
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://storage.googleapis.com/untrusted/index.html',
    );
  });

  it('unmounts the WebView during cleanup and keeps it closed on failure until retry succeeds', async () => {
    (clearWebData as jest.Mock).mockRejectedValueOnce(
      new Error('Deletion failed'),
    );
    await act(async () => controls().props.onSignOut());
    expect(tree.root.findAllByType('WebView' as any)).toHaveLength(0);
    expect(
      tree.root
        .findAllByType('Text' as any)
        .some((node) => node.props.children === 'Sign-out needs attention'),
    ).toBe(true);
    const retry = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) =>
        node
          .findAllByType('Text' as any)
          .some((text) => text.props.children === 'Retry sign-out'),
      )!;
    await act(async () => retry.props.onPress());
    expect(tree.root.findAllByType('WebView' as any)).toHaveLength(1);
    expect(webView().props.source.uri).toBe('https://antigravity.google.com');
    expect(clearWebData).toHaveBeenCalledTimes(2);
  });

  it('does not mount the new WebView until native website-data deletion completes', async () => {
    let finish!: () => void;
    const deletion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    (clearWebData as jest.Mock).mockImplementationOnce(() => deletion);
    await act(async () => controls().props.onSignOut());
    expect(tree.root.findAllByType('WebView' as any)).toHaveLength(0);
    await act(async () => finish());
    expect(tree.root.findAllByType('WebView' as any)).toHaveLength(1);
  });

  it('caps automatic recovery across loading-dashboard redirects', async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () =>
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://accounts.google.com/CookieMismatch',
          isTopFrame: true,
        }),
      );
      if (i < 2) await navigate('https://antigravity.google.com/', true);
    }
    expect(clearWebData).toHaveBeenCalledTimes(2);
    expect(
      tree.root
        .findAllByType('Text' as any)
        .some(
          (node) =>
            typeof node.props.children === 'string' &&
            node.props.children.startsWith(
              'Automatic sign-in recovery stopped',
            ),
        ),
    ).toBe(true);
  });

  it('resets recovery budget after a completed dashboard with an authenticated session', async () => {
    for (let i = 0; i < 2; i++) {
      await act(async () =>
        webView().props.onShouldStartLoadWithRequest({
          url: 'https://accounts.google.com/CookieMismatch',
          isTopFrame: true,
        }),
      );
      await navigate('https://antigravity.google.com/', true);
    }
    mockCookieStore.set('https://antigravity.google.com', {
      SID: { name: 'SID', value: 'fresh-session', domain: '.google.com' },
    });
    await navigate('https://antigravity.google.com/', false);
    await act(async () =>
      webView().props.onShouldStartLoadWithRequest({
        url: 'https://accounts.google.com/CookieMismatch',
        isTopFrame: true,
      }),
    );
    expect(clearWebData).toHaveBeenCalledTimes(3);
  });

  it('opens the Privacy Policy and Open Source links in the external browser from the left Session drawer', async () => {
    const drawerHandle = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    await act(async () => {
      drawerHandle.props.onPress();
    });
    const privacyLink = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Privacy Policy')!;
    const repoLink = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find(
        (node) => node.props.accessibilityLabel === 'Open Source Repository',
      )!;
    await act(async () => {
      privacyLink.props.onPress();
      repoLink.props.onPress();
    });
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://marcus-friction.github.io/antigravity-remote/privacy-policy.html',
    );
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://github.com/marcus-friction/antigravity-remote',
    );
  });

  it('wakes authenticated sessions immediately on foreground resume and syncs keep-alive controls', async () => {
    const RNPlatform = require('react-native').Platform;
    RNPlatform.OS = 'android';
    RNPlatform.Version = 34;

    // While unauthenticated on Google Sign-In, native keep-alive and POST_NOTIFICATIONS stay inactive
    await navigate('https://accounts.google.com/v3/signin/identifier', false);
    expect(configureNativeKeepAlive).toHaveBeenLastCalledWith(false, 0, false);
    expect(mockPermissionsRequest).not.toHaveBeenCalled();

    // Default is Off (0): even after signing in, native keep-alive and POST_NOTIFICATIONS stay inactive until user opts in
    mockCookieStore.set('https://antigravity.google.com', {
      SID: { name: 'SID', value: 'live-session', domain: '.google.com' },
    });
    await navigate('https://antigravity.google.com/r/workstation-1', false);

    expect(configureNativeKeepAlive).toHaveBeenLastCalledWith(false, 0, false);
    expect(mockPermissionsCheck).not.toHaveBeenCalled();
    expect(mockPermissionsRequest).not.toHaveBeenCalled();
    mockWebViewInjectJavaScript.mockClear();

    // Brief iOS/Android inactive peek without backgrounding does not spam wakeup events on authenticated pages
    await act(async () => {
      for (const listener of mockAppStateListeners) listener('inactive');
      for (const listener of mockAppStateListeners) listener('active');
    });
    expect(
      mockWebViewInjectJavaScript.mock.calls.some(
        ([script]) =>
          typeof script === 'string' && script.includes("new Event('online')"),
      ),
    ).toBe(false);

    await act(async () => {
      for (const listener of mockAppStateListeners) listener('background');
      for (const listener of mockAppStateListeners) listener('active');
    });

    expect(
      mockWebViewInjectJavaScript.mock.calls.some(
        ([script]) =>
          typeof script === 'string' &&
          script.includes("new Event('online')") &&
          script.includes("new Event('focus')") &&
          !script.includes('pageshow'),
      ),
    ).toBe(true);

    // Open left drawer, switch to Session mode, verify explanatory guidance, and opt in ('5m' -> '60m' -> 'Off')
    const drawerHandle = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    await act(async () => {
      drawerHandle.props.onPress();
    });
    const sessionModeBtn = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Drawer mode Session')!;
    await act(async () => {
      sessionModeBtn.props.onPress();
    });

    expect(
      tree.root
        .findAllByType('Text' as any)
        .some(
          (node) =>
            typeof node.props.children === 'string' &&
            node.props.children.includes(
              'Keeps your live workstation stream connected',
            ),
        ),
    ).toBe(true);
    expect(
      tree.root
        .findAllByType('Text' as any)
        .some(
          (node) =>
            typeof node.props.children === 'string' &&
            node.props.children.includes(
              'Off by default (no background battery use)',
            ),
        ),
    ).toBe(true);

    const fiveChip = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Keep-alive 5m')!;
    expect(fiveChip).toBeDefined();
    await act(async () => {
      fiveChip.props.onPress();
    });
    expect(configureNativeKeepAlive).toHaveBeenLastCalledWith(true, 5, true);
    expect(mockPermissionsCheck).toHaveBeenCalledWith(
      'android.permission.POST_NOTIFICATIONS',
    );
    expect(mockPermissionsRequest).toHaveBeenCalledWith(
      'android.permission.POST_NOTIFICATIONS',
    );

    const sixtyChip = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Keep-alive 60m')!;
    expect(sixtyChip).toBeDefined();
    await act(async () => {
      sixtyChip.props.onPress();
    });
    expect(configureNativeKeepAlive).toHaveBeenLastCalledWith(true, 60, true);

    const offChip = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Keep-alive Off')!;
    expect(offChip).toBeDefined();
    await act(async () => {
      offChip.props.onPress();
    });
    expect(configureNativeKeepAlive).toHaveBeenLastCalledWith(false, 0, false);

    // Verify iOS 'On (~30s)' chip passes a non-zero duration even though DEFAULT_KEEP_ALIVE_MINUTES is 0
    RNPlatform.OS = 'ios';
    await act(async () => {
      tree.update(<App />);
    });
    const iosOnChip = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Keep-alive On')!;
    expect(iosOnChip).toBeDefined();
    await act(async () => {
      iosOnChip.props.onPress();
    });
    expect(configureNativeKeepAlive).toHaveBeenLastCalledWith(true, 30, true);

    // Sign Out stops keep-alive and resets preference back to default Off (0)
    await act(async () => {
      await controls().props.onSignOut();
    });
    expect(controls().props.keepAliveMinutes).toBe(0);
    expect(configureNativeKeepAlive).toHaveBeenLastCalledWith(false, 0, false);
  });

  it('wipes stale workstation URL and keep-alive settings before mounting when recovering an interrupted sign-out', async () => {
    await act(async () => {
      tree.unmount();
    });
    mockSecureStoreData.set('agy_session_cleanup_pending', 'true');
    mockSecureStoreData.set(
      'agy_last_active_url_v1',
      'https://antigravity.google.com/r/wiped-workstation',
    );
    mockSecureStoreData.set('agy_keep_alive_minutes_v1', '60');

    await act(async () => {
      tree = renderer.create(<App />);
    });

    expect(webView().props.source.uri).toBe('https://antigravity.google.com');
    expect(controls().props.keepAliveMinutes).toBe(0);
    expect(mockSecureStoreData.has('agy_session_cleanup_pending')).toBe(false);
    expect(mockSecureStoreData.has('agy_last_active_url_v1')).toBe(false);
    expect(mockSecureStoreData.has('agy_keep_alive_minutes_v1')).toBe(false);
  });

  it('auto-recovers killed WebView render processes at the active URL and caps crash loops', async () => {
    await navigate('https://antigravity.google.com/r/resilient-box', false);
    const initialMounts = mockWebViewMountCount;

    // 3 background process evictions auto-remount right at the active workstation URL
    for (let attempt = 1; attempt <= 3; attempt++) {
      await act(async () => {
        webView().props.onRenderProcessGone({ nativeEvent: { didCrash: false } });
      });
      expect(mockWebViewMountCount).toBe(initialMounts + attempt);
      expect(webView().props.source.uri).toBe(
        'https://antigravity.google.com/r/resilient-box',
      );
    }

    // 4th rapid termination within 30s halts auto-loop and shows manual Reconnect
    await act(async () => {
      webView().props.onContentProcessDidTerminate({ nativeEvent: {} });
    });
    expect(mockWebViewMountCount).toBe(initialMounts + 3);
    expect(
      tree.root
        .findAllByType('Text' as any)
        .some(
          (node) =>
            node.props.children ===
            'The remote session view stopped unexpectedly. Tap Reconnect to reload.',
        ),
    ).toBe(true);

    // Tapping Reconnect recreates the dead WebView instance cleanly
    const reconnectBtn = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) =>
        node
          .findAllByType('Text' as any)
          .some((t) => t.props.children === 'Reconnect'),
      )!;
    await act(async () => {
      reconnectBtn.props.onPress();
    });
    expect(mockWebViewMountCount).toBe(initialMounts + 4);
    expect(webView().props.source.uri).toBe(
      'https://antigravity.google.com/r/resilient-box',
    );

    // Trigger another 4-crash halt and verify manual LeftNavigationDrawer navigation also clears dead-renderer state
    for (let attempt = 1; attempt <= 4; attempt++) {
      await act(async () => {
        webView().props.onRenderProcessGone({ nativeEvent: { didCrash: true } });
      });
    }
    const mountsAfterSecondHalt = mockWebViewMountCount;
    await act(async () => {
      controls().props.onNavigateToUrl('https://antigravity.google.com');
    });
    expect(mockWebViewMountCount).toBe(mountsAfterSecondHalt + 1);
    mockWebViewReload.mockClear();
    await act(async () => {
      controls().props.onReloadSession();
    });
    expect(mockWebViewReload).toHaveBeenCalledTimes(1);
  });

  it('aggregates cross-machine threads in the pull-in left Inbox drawer, preserves back-gesture edge gap and matching handle geometry, and wipes state on Sign Out', async () => {
    const RNPlatform = require('react-native').Platform;
    RNPlatform.OS = 'android';
    RNPlatform.Version = 34;
    await act(async () => {
      tree.unmount();
    });
    await act(async () => {
      tree = renderer.create(<App />);
    });

    // Verify back-gesture-safe gap (>= 20dp) and shared 4px × 112px handle geometry
    expect(CLOSED_HANDLE_TOUCH_LEFT).toBeGreaterThanOrEqual(20);
    expect(HANDLE_LINE_WIDTH).toBe(4);
    expect(HANDLE_LINE_HEIGHT).toBe(112);

    mockCookieStore.set('https://antigravity.google.com', {
      SID: { name: 'SID', value: 'inbox-session', domain: '.google.com' },
    });
    await navigate('https://antigravity.google.com/r/workstation-1?p=c%2Factive-1', false);

    // 1. Bridge messages from untrusted or auth origins must be ignored
    const spoofedPayload = JSON.stringify({
      type: 'AGY_INBOX_SNAPSHOT',
      fetchedAtMs: 1_762_265_000_000,
      instances: [
        {
          uuid: 'spoofed-box',
          name: 'Spoofed',
          status: 1,
          trajectories: {
            'spoofed-thread': {
              summary: 'Spoofed approval',
              waitingSteps: [{ step: {} }],
            },
          },
        },
      ],
    });
    await act(async () => {
      webView().props.onMessage({
        nativeEvent: {
          url: 'https://evil.example/attack',
          data: spoofedPayload,
        },
      });
      webView().props.onMessage({
        nativeEvent: {
          url: 'https://accounts.google.com/v3/signin',
          data: spoofedPayload,
        },
      });
    });

    const closedHandleBefore = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    expect(closedHandleBefore).toBeDefined();
    expect(closedHandleBefore.props.accessibilityHint).toBe(
      'Open Antigravity drawer',
    );
    expect(controls().props.attentionCount).toBe(0);

    // 2. Receive verified snapshot from antigravity.google.com across 2 workstations
    await act(async () => {
      webView().props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/workstation-1?p=c%2Factive-1',
          data: JSON.stringify({
            type: 'AGY_INBOX_SNAPSHOT',
            fetchedAtMs: 1_762_265_000_000,
            activeUrl:
              'https://antigravity.google.com/r/workstation-1?p=c%2Factive-1',
            instances: [
              {
                uuid: 'workstation-1',
                name: 'Primary Laptop',
                status: 1,
                trajectories: {
                  'approval-local': {
                    summary: 'Deploy mobile release',
                    waitingSteps: [
                      {
                        step: {
                          runCommand: {
                            commandLine: './gradlew bundleRelease',
                          },
                        },
                      },
                    ],
                    lastModifiedTime: '2026-11-04T14:20:00Z',
                  },
                },
              },
              {
                uuid: 'workstation-2',
                name: 'Cloud GPU Box',
                status: 1,
                trajectories: {
                  'unread-remote': {
                    summary: 'Evaluate benchmark metrics',
                    status: 1,
                    lastModifiedTime: '2026-11-04T14:18:00Z',
                    lastUserInputTime: '2026-11-04T14:10:00Z',
                  },
                },
              },
            ],
          }),
        },
      });
    });

    // Closed handle reflects 2 threads needing attention without any bottom-right pill
    expect(controls().props.attentionCount).toBe(2);
    const closedHandleAfter = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    expect(closedHandleAfter.props.accessibilityHint).toBe(
      'Open Antigravity drawer (2 need attention)',
    );

    // 3. Pull the left drawer open via horizontal drag gesture on the closed handle zone
    const closedDragZone = tree.root.findAll(
      (node) =>
        node.type === ('View' as any) &&
        typeof node.props.onMoveShouldSetPanResponder === 'function',
    )[0];
    expect(closedDragZone).toBeDefined();
    expect(
      closedDragZone.props.onMoveShouldSetPanResponder({}, { dx: 18, dy: 2 }),
    ).toBe(true);

    await act(async () => {
      closedDragZone.props.onPanResponderGrant();
      closedDragZone.props.onPanResponderMove({}, { dx: 180, dy: 4, vx: 0.6 });
      closedDragZone.props.onPanResponderRelease(
        {},
        { dx: 180, dy: 4, vx: 0.6 },
      );
    });

    // Open drawer displays Inbox mode with count badge '2' and matching 4px × 112px inner-right handle
    const inboxModeBtn = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Drawer mode Inbox')!;
    expect(
      inboxModeBtn.findAllByType('Text' as any).map((t) => t.props.children),
    ).toEqual(['Inbox', '2']);

    const innerRightHandle = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find(
        (node) => node.props.accessibilityLabel === 'Close Antigravity drawer',
      )!;
    expect(innerRightHandle).toBeDefined();
    const innerHandleBar = innerRightHandle.findByType('View' as any);
    const flatBarStyle = Object.assign(
      {},
      ...(Array.isArray(innerHandleBar.props.style)
        ? innerHandleBar.props.style.filter(Boolean)
        : [innerHandleBar.props.style]),
    );
    expect(flatBarStyle.width).toBe(HANDLE_LINE_WIDTH);
    expect(flatBarStyle.height).toBe(HANDLE_LINE_HEIGHT);

    // Mark the unread thread as read
    const markReadBtn = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find(
        (node) =>
          node.props.accessibilityLabel ===
          'Mark Evaluate benchmark metrics as read',
      )!;
    expect(markReadBtn).toBeDefined();

    mockWebViewInjectJavaScript.mockClear();
    await act(async () => {
      markReadBtn.props.onPress();
    });

    expect(
      mockWebViewInjectJavaScript.mock.calls.some(
        ([script]) =>
          typeof script === 'string' &&
          script.includes('markThreadRead') &&
          script.includes('unread-remote'),
      ),
    ).toBe(true);

    // Badge drops to 1 (`approval-local` still awaits command approval)
    expect(
      inboxModeBtn.findAllByType('Text' as any).map((t) => t.props.children),
    ).toEqual(['Inbox', '1']);

    // 4. Select `approval-local` on the same workstation -> uses fast iframe switch without remounting WebView
    const mountsBeforeFastSwitch = mockWebViewMountCount;
    mockWebViewInjectJavaScript.mockClear();

    const approvalCard = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find(
        (node) =>
          node.props.accessibilityLabel === 'Open thread Deploy mobile release',
      )!;
    await act(async () => {
      approvalCard.props.onPress();
    });

    const fastSwitchCall = mockWebViewInjectJavaScript.mock.calls.find(
      ([script]) =>
        typeof script === 'string' && script.includes('fastNavigate'),
    );
    expect(fastSwitchCall).toBeDefined();
    const requestIdMatch = /"requestId":"([^"]+)"/.exec(fastSwitchCall![0]);
    expect(requestIdMatch).not.toBeNull();

    await act(async () => {
      webView().props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/workstation-1?p=c%2Factive-1',
          data: JSON.stringify({
            type: 'AGY_INBOX_FAST_NAV_RESULT',
            requestId: requestIdMatch![1],
            handled: true,
            targetUrl:
              'https://antigravity.google.com/r/workstation-1?p=c%2Fapproval-local',
          }),
        },
      });
    });
    expect(mockWebViewMountCount).toBe(mountsBeforeFastSwitch);

    // Unsolicited or replayed AGY_INBOX_FAST_NAV_RESULT messages must be ignored
    await act(async () => {
      webView().props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/workstation-1?p=c%2Fapproval-local',
          data: JSON.stringify({
            type: 'AGY_INBOX_FAST_NAV_RESULT',
            requestId: 'unsolicited-request-id',
            handled: false,
            targetUrl: 'https://antigravity.google.com/r/spoofed-workstation',
          }),
        },
      });
      webView().props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/workstation-1?p=c%2Fapproval-local',
          data: JSON.stringify({
            type: 'AGY_INBOX_FAST_NAV_RESULT',
            requestId: requestIdMatch![1],
            handled: false,
            targetUrl: 'https://antigravity.google.com/r/spoofed-workstation',
          }),
        },
      });
    });
    expect(mockWebViewMountCount).toBe(mountsBeforeFastSwitch);
    expect(webView().props.source.uri).not.toContain('spoofed-workstation');

    // 5. Reopen drawer, verify keyboard inset while open, and verify Android hardware Back closes drawer before WebView history
    mockWebViewGoBack.mockClear();
    const reopenHandle = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    await act(async () => {
      reopenHandle.props.onPress();
    });
    expect(controls().props.visible).toBe(true);

    await act(async () => {
      for (const listener of mockKeyboardShowListeners) {
        listener({ endCoordinates: { height: 312 } });
      }
    });
    expect(controls().props.visible).toBe(true);
    expect(controls().props.keyboardBottomPadding).toBeGreaterThan(0);

    await act(async () => {
      for (const listener of mockKeyboardHideListeners) {
        listener();
      }
    });

    let backConsumedWhileOpen = false;
    await act(async () => {
      for (const listener of mockBackPressListeners) {
        backConsumedWhileOpen = listener() || backConsumedWhileOpen;
      }
    });
    expect(backConsumedWhileOpen).toBe(true);
    expect(controls().props.visible).toBe(false);
    expect(mockWebViewGoBack).not.toHaveBeenCalled();

    // 6. Reopen drawer, switch to 'All' tab, and select `unread-remote` on `workstation-2` -> navigates WebView across machines
    const reopenHandle2 = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    await act(async () => {
      reopenHandle2.props.onPress();
    });
    const allTab = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.accessibilityLabel === 'Inbox tab All')!;
    await act(async () => {
      allTab.props.onPress();
    });
    const crossMachineCard = tree.root
      .findAllByType('TouchableOpacity' as any)
      .find(
        (node) =>
          node.props.accessibilityLabel ===
          'Open thread Evaluate benchmark metrics',
      )!;
    await act(async () => {
      crossMachineCard.props.onPress();
    });
    expect(webView().props.source.uri).toBe(
      'https://antigravity.google.com/r/workstation-2?p=c%2Funread-remote',
    );

    // 7. Sign Out wipes all Inbox state immediately
    await act(async () => {
      await controls().props.onSignOut();
    });
    expect(controls().props.attentionCount).toBe(0);
    expect(controls().props.snapshot.threads).toHaveLength(0);
  });
});
