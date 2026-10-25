const mockSecureStoreData = new Map<string, string>();
const mockCookieStore = new Map<string, Record<string, any>>();

jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
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

import {
  LEGACY_SECURE_STORE_CHUNK_PREFIX_V1,
  LEGACY_SECURE_STORE_META_KEY_V1,
  SECURE_STORE_CHUNK_SIZE,
  SECURE_STORE_META_KEY,
  SECURE_STORE_MIGRATION_V2_KEY,
} from '../src/constants/config';
import {
  backupCookiesFromWebView,
  clearSession,
  getLastActiveUrl,
  hydrateCookiesToWebView,
  isSafeToReinjectCookie,
  reassembleChunks,
  saveLastActiveUrl,
  splitIntoChunks,
} from '../src/services/sessionVault';

describe('sessionVault', () => {
  beforeEach(() => {
    mockSecureStoreData.clear();
    mockCookieStore.clear();
  });

  it('splits large payloads into chunks under 2048 bytes and reassembles them losslessly', () => {
    const largePayload = 'A'.repeat(4200) + 'B'.repeat(1900);
    const chunks = splitIntoChunks(largePayload, SECURE_STORE_CHUNK_SIZE);

    expect(chunks.length).toBe(4);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SECURE_STORE_CHUNK_SIZE);
    }

    expect(reassembleChunks(chunks)).toBe(largePayload);
  });

  it('backs up multi-kilobyte Google session cookies into SecureStore chunks and hydrates them on cold start', async () => {
    mockCookieStore.set('https://antigravity.google.com', {
      SID: {
        name: 'SID',
        value: 'sid-token-' + 'x'.repeat(1200),
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
      '__Secure-1PSID': {
        name: '__Secure-1PSID',
        value: '1psid-token-' + 'y'.repeat(1200),
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
    });

    mockCookieStore.set('https://accounts.google.com', {
      LSID: {
        name: 'LSID',
        value: 'lsid-token-' + 'z'.repeat(1200),
        domain: 'accounts.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
    });

    const backedUpCount = await backupCookiesFromWebView();
    expect(backedUpCount).toBe(3);

    const metaRaw = mockSecureStoreData.get(SECURE_STORE_META_KEY);
    expect(metaRaw).toBeDefined();
    const meta = JSON.parse(metaRaw!);
    expect(meta.cookieCount).toBe(3);
    expect(meta.chunkCount).toBeGreaterThanOrEqual(3);

    // Simulate OS evicting WebView cookies on cold restart
    mockCookieStore.clear();
    expect(mockCookieStore.size).toBe(0);

    // Hydrate from SecureStore back into CookieManager
    const restoredCount = await hydrateCookiesToWebView();
    expect(restoredCount).toBe(3);

    const restoredAgCookies = mockCookieStore.get(
      'https://antigravity.google.com'
    );
    expect(restoredAgCookies).toBeDefined();
    expect(restoredAgCookies!['SID'].value).toContain('sid-token-');
    expect(restoredAgCookies!['__Secure-1PSID'].value).toContain('1psid-token-');
  });

  it('persists and validates the last active Antigravity Remote URL', async () => {
    expect(await getLastActiveUrl()).toBe('https://antigravity.google.com');

    await saveLastActiveUrl(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F999'
    );
    expect(await getLastActiveUrl()).toBe(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F999'
    );

    // Rejects untrusted URLs from overwriting last active URL
    await saveLastActiveUrl('https://evil.example.com/r/123');
    expect(await getLastActiveUrl()).toBe(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F999'
    );
  });

  it('completely wipes CookieManager and all SecureStore chunks on clearSession()', async () => {
    mockCookieStore.set('https://antigravity.google.com', {
      SID: {
        name: 'SID',
        value: 'secret-session-cookie',
        domain: '.google.com',
        path: '/',
      },
    });

    await backupCookiesFromWebView();
    await saveLastActiveUrl('https://antigravity.google.com/r/my-box');
    expect(mockSecureStoreData.size).toBeGreaterThan(0);

    await clearSession();

    expect(mockCookieStore.size).toBe(0);
    expect(mockSecureStoreData.get(SECURE_STORE_META_KEY)).toBeUndefined();
  });

  it('excludes __Host- prefixed and domain-less cookies from CookieManager.set re-injection to prevent Google CookieMismatch', async () => {
    expect(isSafeToReinjectCookie('__Host-GAPS', 'accounts.google.com')).toBe(
      false
    );
    expect(isSafeToReinjectCookie('__Host-1PLSID', 'accounts.google.com')).toBe(
      false
    );
    expect(isSafeToReinjectCookie('SID', undefined)).toBe(false);
    expect(isSafeToReinjectCookie('SID', '.google.com')).toBe(true);

    mockCookieStore.set('https://accounts.google.com', {
      '__Host-GAPS': {
        name: '__Host-GAPS',
        value: 'host-gaps-token',
        domain: 'accounts.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
      LSID: {
        name: 'LSID',
        value: 'valid-lsid-token',
        domain: 'accounts.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
    });

    await backupCookiesFromWebView();
    mockCookieStore.clear();
    await hydrateCookiesToWebView();

    const hydratedAccountsCookies = mockCookieStore.get(
      'https://accounts.google.com'
    );
    expect(hydratedAccountsCookies?.LSID?.value).toBe('valid-lsid-token');
    expect(hydratedAccountsCookies?.['__Host-GAPS']).toBeUndefined();
  });

  it('automatically migrates and wipes corrupted v1 cookie vault state on upgrade to v2', async () => {
    // Seed legacy v1 vault data and a corrupted cookie in CookieManager
    mockSecureStoreData.set(
      LEGACY_SECURE_STORE_META_KEY_V1,
      JSON.stringify({
        version: 1,
        chunkCount: 1,
        updatedAtIso: new Date().toISOString(),
        cookieCount: 1,
      })
    );
    mockSecureStoreData.set(
      `${LEGACY_SECURE_STORE_CHUNK_PREFIX_V1}0`,
      JSON.stringify([{ name: '__Host-GAPS', value: 'corrupted' }])
    );
    mockCookieStore.set('https://accounts.google.com', {
      '__Host-GAPS': { name: '__Host-GAPS', value: 'corrupted-domain-cookie' },
    });

    await hydrateCookiesToWebView();

    expect(mockCookieStore.size).toBe(0);
    expect(
      mockSecureStoreData.get(LEGACY_SECURE_STORE_META_KEY_V1)
    ).toBeUndefined();
    expect(
      mockSecureStoreData.get(`${LEGACY_SECURE_STORE_CHUNK_PREFIX_V1}0`)
    ).toBeUndefined();
    expect(mockSecureStoreData.get(SECURE_STORE_MIGRATION_V2_KEY)).toBe('true');
  });
});
