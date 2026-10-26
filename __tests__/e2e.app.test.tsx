jest.mock('../src/services/webData', () => ({
  clearWebData: jest.fn(async () => undefined),
}));
import React from 'react';
import renderer, { act, ReactTestRenderer } from 'react-test-renderer';

const mockSecureStoreData = new Map<string, string>();
const mockCookieStore = new Map<string, Record<string, any>>();
const mockAppStateListeners = new Set<(state: string) => void>();
const mockKeyboardShowListeners = new Set<(event: any) => void>();
const mockKeyboardHideListeners = new Set<() => void>();
const mockLinkingListeners = new Set<(event: { url: string }) => void>();
let mockInitialUrl: string | null = null;
const mockOpenURL = jest.fn(async (_url: string) => true);

jest.mock('react-native', () => {
  const ReactLib = require('react');
  const mockComponent = (name: string) =>
    ReactLib.forwardRef((props: any, ref: any) =>
      ReactLib.createElement(name, { ...props, ref }, props.children),
    );

  return {
    Platform: { OS: 'ios' },
    StyleSheet: {
      create: (styles: any) => styles,
      hairlineWidth: 1,
      absoluteFillObject: {},
    },
    View: mockComponent('View'),
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
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
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
import { clearWebData } from '../src/services/webData';
import { HandoffModal } from '../src/components/HandoffModal';
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

    // 6. Open native Handoff Modal via the floating 'Remote' pill and paste CLI output
    const pillButton = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity Remote controls',
    )[0];

    await act(async () => {
      pillButton.props.onPress();
    });

    const handoffInput = tree.root.findByType('TextInput' as any);
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

    // Verify floating 'Remote' pill hides while typing and WebView wrapper shrinks above keyboard
    expect(
      tree.root.findAll(
        (node) =>
          node.type === ('TouchableOpacity' as any) &&
          node.props.accessibilityLabel === 'Open Antigravity Remote controls',
      ).length,
    ).toBe(0);
    expect(mockWebViewInjectJavaScript).toHaveBeenCalled();

    // Simulate keyboard closing
    await act(async () => {
      for (const listener of mockKeyboardHideListeners) {
        listener();
      }
    });

    const restoredPillButton = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity Remote controls',
    )[0];
    expect(restoredPillButton).toBeDefined();

    // 9. Test Sign Out flow: wipes CookieManager, SecureStore chunks, and resets WebView
    await act(async () => {
      restoredPillButton.props.onPress();
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
    mockInitialUrl = null;
    mockWebViewMountCount = 0;
    mockOpenURL.mockClear();
    mockWebViewReload.mockClear();
    (clearWebData as jest.Mock).mockReset().mockResolvedValue(undefined);
    await act(async () => {
      tree = renderer.create(<App />);
    });
  });
  afterEach(async () => {
    await act(async () => tree.unmount());
  });
  const webView = () => tree.root.findByType('WebView' as any);
  const controls = () => tree.root.findByType(HandoffModal);
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
    });
    expect(mockOpenURL).not.toHaveBeenCalled();
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

  it('opens the Privacy Policy and Open Source links in the external browser from Remote controls', async () => {
    const pillButton = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity Remote controls',
    )[0];
    await act(async () => {
      pillButton.props.onPress();
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
});
