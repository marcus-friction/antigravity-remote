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
      ReactLib.createElement(name, { ...props, ref }, props.children)
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
      addEventListener: jest.fn((_event: string, handler: (s: string) => void) => {
        mockAppStateListeners.add(handler);
        return {
          remove: () => mockAppStateListeners.delete(handler),
        };
      }),
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
  addEventListener: jest.fn((_type: string, handler: (e: { url: string }) => void) => {
    mockLinkingListeners.add(handler);
    return {
      remove: () => mockLinkingListeners.delete(handler),
    };
  }),
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

jest.mock('@react-native-cookies/cookies', () => ({
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

const mockWebViewReload = jest.fn();
const mockWebViewGoBack = jest.fn();
const mockWebViewClearCache = jest.fn();
const mockWebViewInjectJavaScript = jest.fn();

jest.mock('react-native-webview', () => {
  const ReactLib = require('react');
  const WebView = ReactLib.forwardRef((props: any, ref: any) => {
    ReactLib.useImperativeHandle(ref, () => ({
      reload: mockWebViewReload,
      goBack: mockWebViewGoBack,
      clearCache: mockWebViewClearCache,
      injectJavaScript: mockWebViewInjectJavaScript,
    }));
    return ReactLib.createElement('WebView', props);
  });
  return { WebView };
});

import App from '../App';
import { SECURE_STORE_META_KEY } from '../src/constants/config';
import {
  backupCookiesFromWebView,
  saveLastActiveUrl,
} from '../src/services/sessionVault';

describe('End-to-End <App /> Flow', () => {
  beforeEach(() => {
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
    await saveLastActiveUrl('https://antigravity.google.com/r/saved-workstation');

    // Simulate OS evicting WebView cookies while app was killed
    mockCookieStore.clear();
    expect(mockCookieStore.size).toBe(0);

    // 2. Cold-boot <App />
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<App />);
    });

    // Verify cookies were hydrated into CookieManager BEFORE WebView mounted
    expect(mockCookieStore.get('https://antigravity.google.com')?.SID?.value).toBe(
      'initial-sid-cookie'
    );

    const webView = tree.root.findByType('WebView' as any);
    expect(webView.props.source.uri).toBe(
      'https://antigravity.google.com/r/saved-workstation'
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
      'Google Sign-In active — your session will be saved automatically'
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
      mockSecureStoreData.get(SECURE_STORE_META_KEY)!
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
      'Google Sign-In active — your session will be saved automatically'
    );

    // 6. Open native Handoff Modal via the floating 'Remote' pill and paste CLI output
    const pillButton = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Open Antigravity Remote controls'
    )[0];

    await act(async () => {
      pillButton.props.onPress();
    });

    const handoffInput = tree.root.findByType('TextInput' as any);
    await act(async () => {
      handoffInput.props.onChangeText(
        'Remote control on for this session.\nOpen https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F777 on another device'
      );
    });

    const goButton = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.props.accessibilityLabel === 'Connect to handoff instance'
    )[0];

    await act(async () => {
      goButton.props.onPress();
    });

    const updatedWebView = tree.root.findByType('WebView' as any);
    expect(updatedWebView.props.source.uri).toBe(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F777'
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
      'https://github.com/google-antigravity/antigravity-sdk-python'
    );

    // 8. Simulate incoming OS Deep Link (`antigravity-remote://r/deep-linked-host`)
    await act(async () => {
      for (const listener of mockLinkingListeners) {
        listener({ url: 'antigravity-remote://r/deep-linked-host' });
      }
    });

    expect(tree.root.findByType('WebView' as any).props.source.uri).toBe(
      'https://antigravity.google.com/r/deep-linked-host'
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
          node.props.accessibilityLabel === 'Open Antigravity Remote controls'
      ).length
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
        node.props.accessibilityLabel === 'Open Antigravity Remote controls'
    )[0];
    expect(restoredPillButton).toBeDefined();

    // 9. Test Sign Out flow: wipes CookieManager, SecureStore chunks, and resets WebView
    await act(async () => {
      restoredPillButton.props.onPress();
    });

    const signOutTrigger = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.findAllByType('Text' as any).some(
          (t) => t.props.children === 'Sign Out of Google Account'
        )
    )[0];

    await act(async () => {
      signOutTrigger.props.onPress();
    });

    const confirmSignOutBtn = tree.root.findAll(
      (node) =>
        node.type === ('TouchableOpacity' as any) &&
        node.findAllByType('Text' as any).some(
          (t) => t.props.children === 'Confirm Sign Out'
        )
    )[0];

    await act(async () => {
      await confirmSignOutBtn.props.onPress();
    });

    expect(mockCookieStore.size).toBe(0);
    expect(mockSecureStoreData.get(SECURE_STORE_META_KEY)).toBeUndefined();
    expect(mockWebViewClearCache).toHaveBeenCalledWith(true);
    expect(tree.root.findByType('WebView' as any).props.source.uri).toBe(
      'https://antigravity.google.com'
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
      'https://antigravity.google.com'
    );
  });
});
