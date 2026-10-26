jest.mock('../src/services/webData', () => ({
  clearWebData: jest.fn(async () => undefined),
}));
const mockSecureStoreData = new Map<string, string>();
const mockCookieStore = new Map<string, Record<string, any>>();

import CookieManager from '@preeternal/react-native-cookie-manager';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { clearWebData } from '../src/services/webData';

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

import {
  LEGACY_SECURE_STORE_CHUNK_PREFIX_V1,
  LEGACY_SECURE_STORE_META_KEY_V1,
  SECURE_STORE_CHUNK_SIZE,
  SECURE_STORE_META_KEY,
  SECURE_STORE_MIGRATION_V2_KEY,
  SECURE_STORE_SNAPSHOT_PREFIX,
  SECURE_STORE_CHUNK_PREFIX,
  SECURE_STORE_SIGN_OUT_KEY,
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
  resumeSessionPersistence,
} from '../src/services/sessionVault';

describe('sessionVault', () => {
  beforeEach(() => {
    resumeSessionPersistence();
    (Platform as { OS: string }).OS = 'ios';
    (SecureStore.setItemAsync as jest.Mock).mockImplementation(
      async (key: string, value: string) => {
        mockSecureStoreData.set(key, value);
      },
    );
    (CookieManager.clearAll as jest.Mock).mockImplementation(async () => {
      mockCookieStore.clear();
      return true;
    });
    (clearWebData as jest.Mock).mockResolvedValue(undefined);
    mockSecureStoreData.clear();
    mockCookieStore.clear();
  });

  const seed = (value: string) =>
    mockCookieStore.set('https://antigravity.google.com', {
      SID: { name: 'SID', value, domain: '.google.com', path: '/' },
    });

  it('invalidates and drains an in-flight backup before clearing all credentials', async () => {
    seed('old-session');
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    (SecureStore.setItemAsync as jest.Mock).mockImplementation(
      async (key: string, value: string) => {
        if (key === `${SECURE_STORE_SNAPSHOT_PREFIX}a_0`) {
          reached();
          await gate;
        }
        mockSecureStoreData.set(key, value);
      },
    );
    const backup = backupCookiesFromWebView();
    await writeStarted;
    const clearing = clearSession();
    const queuedBackup = backupCookiesFromWebView();
    release();
    await Promise.all([backup, clearing, queuedBackup]);
    expect(mockCookieStore.size).toBe(0);
    expect(mockSecureStoreData.has(SECURE_STORE_META_KEY)).toBe(false);
    resumeSessionPersistence();
    expect(await hydrateCookiesToWebView()).toBe(0);
  });

  it('preserves the committed snapshot when writing a later chunk fails', async () => {
    seed('A'.repeat(2500));
    await backupCookiesFromWebView();
    const committed = mockSecureStoreData.get(SECURE_STORE_META_KEY);
    seed('B'.repeat(2500));
    (SecureStore.setItemAsync as jest.Mock).mockImplementation(
      async (key: string, value: string) => {
        if (key === `${SECURE_STORE_SNAPSHOT_PREFIX}b_1`)
          throw new Error('Storage failure');
        mockSecureStoreData.set(key, value);
      },
    );
    expect(await backupCookiesFromWebView()).toBe(0);
    expect(mockSecureStoreData.get(SECURE_STORE_META_KEY)).toBe(committed);
    mockCookieStore.clear();
    expect(await hydrateCookiesToWebView()).toBe(1);
    expect(
      mockCookieStore.get('https://antigravity.google.com')?.SID.value,
    ).toBe('A'.repeat(2500));
  });

  it('commits removal of all cookies instead of replaying a stale snapshot', async () => {
    seed('removed-session');
    await backupCookiesFromWebView();
    mockCookieStore.clear();
    await backupCookiesFromWebView();
    expect(await hydrateCookiesToWebView()).toBe(0);
  });

  it('attempts every store and rejects sign-out if any cleanup fails', async () => {
    seed('old-session');
    await backupCookiesFromWebView();
    (CookieManager.clearAll as jest.Mock).mockRejectedValueOnce(
      new Error('Cookie deletion failed'),
    );
    await expect(clearSession()).rejects.toThrow('Session cleanup failed');
    expect(CookieManager.clearAll).toHaveBeenCalledWith(false);
    expect(CookieManager.clearAll).toHaveBeenCalledWith(true);
    expect(clearWebData).toHaveBeenCalled();
    expect(mockSecureStoreData.get(SECURE_STORE_SIGN_OUT_KEY)).toBe('true');
    expect(await backupCookiesFromWebView()).toBe(0);
    await clearSession();
    expect(mockSecureStoreData.has(SECURE_STORE_SIGN_OUT_KEY)).toBe(false);
  });

  it('retries interrupted sign-out on cold start and refuses hydration on failure', async () => {
    seed('old-session');
    mockSecureStoreData.set(SECURE_STORE_SIGN_OUT_KEY, 'true');
    (clearWebData as jest.Mock).mockRejectedValueOnce(
      new Error('Storage unavailable'),
    );
    await expect(hydrateCookiesToWebView()).rejects.toThrow(
      'Session cleanup failed',
    );
    expect(mockSecureStoreData.has(SECURE_STORE_SIGN_OUT_KEY)).toBe(true);
    await expect(hydrateCookiesToWebView()).resolves.toBe(0);
    expect(mockSecureStoreData.has(SECURE_STORE_SIGN_OUT_KEY)).toBe(false);
  });

  it('restores the previous v2 format and upgrades the next backup atomically', async () => {
    mockSecureStoreData.set(
      SECURE_STORE_META_KEY,
      JSON.stringify({ version: 2, chunkCount: 1 }),
    );
    mockSecureStoreData.set(
      `${SECURE_STORE_CHUNK_PREFIX}0`,
      JSON.stringify([
        {
          name: 'SID',
          value: 'v2-session',
          domain: '.google.com',
          originUrl: 'https://antigravity.google.com',
        },
      ]),
    );
    expect(await hydrateCookiesToWebView()).toBe(1);
    await backupCookiesFromWebView();
    expect(
      JSON.parse(mockSecureStoreData.get(SECURE_STORE_META_KEY)!).version,
    ).toBe(3);
    await clearSession();
    expect(mockSecureStoreData.has(`${SECURE_STORE_CHUNK_PREFIX}0`)).toBe(
      false,
    );
  });

  it('preserves Android cookies natively and clears persistent web data during sign-out', async () => {
    (Platform as { OS: string }).OS = 'android';
    mockSecureStoreData.set(SECURE_STORE_MIGRATION_V2_KEY, 'true');
    seed('android-session');
    expect(await hydrateCookiesToWebView()).toBe(1);
    expect(await backupCookiesFromWebView()).toBe(1);
    expect(mockSecureStoreData.has(SECURE_STORE_META_KEY)).toBe(false);
    await clearSession();
    expect(clearWebData).toHaveBeenCalled();
    expect(mockCookieStore.size).toBe(0);
    expect(CookieManager.flush).toHaveBeenCalled();
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
      'https://antigravity.google.com',
    );
    expect(restoredAgCookies).toBeDefined();
    expect(restoredAgCookies!['SID'].value).toContain('sid-token-');
    expect(restoredAgCookies!['__Secure-1PSID'].value).toContain(
      '1psid-token-',
    );
  });

  it('persists and validates the last active Antigravity Remote URL', async () => {
    expect(await getLastActiveUrl()).toBe('https://antigravity.google.com');

    await saveLastActiveUrl(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F999',
    );
    expect(await getLastActiveUrl()).toBe(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F999',
    );

    // Rejects untrusted URLs from overwriting last active URL
    await saveLastActiveUrl('https://evil.example.com/r/123');
    expect(await getLastActiveUrl()).toBe(
      'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F999',
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
      false,
    );
    expect(isSafeToReinjectCookie('__Host-1PLSID', 'accounts.google.com')).toBe(
      false,
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
      'https://accounts.google.com',
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
      }),
    );
    mockSecureStoreData.set(
      `${LEGACY_SECURE_STORE_CHUNK_PREFIX_V1}0`,
      JSON.stringify([{ name: '__Host-GAPS', value: 'corrupted' }]),
    );
    mockCookieStore.set('https://accounts.google.com', {
      '__Host-GAPS': { name: '__Host-GAPS', value: 'corrupted-domain-cookie' },
    });

    await hydrateCookiesToWebView();

    expect(mockCookieStore.size).toBe(0);
    expect(
      mockSecureStoreData.get(LEGACY_SECURE_STORE_META_KEY_V1),
    ).toBeUndefined();
    expect(
      mockSecureStoreData.get(`${LEGACY_SECURE_STORE_CHUNK_PREFIX_V1}0`),
    ).toBeUndefined();
    expect(mockSecureStoreData.get(SECURE_STORE_MIGRATION_V2_KEY)).toBe('true');
  });
});
