import CookieManager, { Cookie } from '@preeternal/react-native-cookie-manager';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  ANTIGRAVITY_DASHBOARD_URL,
  COOKIE_SYNC_URLS,
  LEGACY_SECURE_STORE_CHUNK_PREFIX_V1,
  LEGACY_SECURE_STORE_META_KEY_V1,
  MAX_COOKIE_CHUNKS,
  SECURE_STORE_CHUNK_PREFIX,
  SECURE_STORE_CHUNK_SIZE,
  SECURE_STORE_SNAPSHOT_PREFIX,
  SECURE_STORE_SIGN_OUT_KEY,
  SECURE_STORE_LAST_URL_KEY,
  SECURE_STORE_META_KEY,
  SECURE_STORE_MIGRATION_V2_KEY,
} from '../constants/config';
import { CookieVaultMetadata, PersistedCookieRecord } from '../types/session';
import { clearWebData } from './webData';
import { validateNavigationUrl } from '../utils/urlValidator';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Serialize every vault mutation and restoration. Invalidate work immediately
// when cleanup starts, including work that is already waiting on a native call.
let persistenceQueue: Promise<unknown> = Promise.resolve();
let sessionGeneration = 0;
let persistenceSuspended = false;

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = persistenceQueue.then(operation);
  persistenceQueue = result.catch(() => undefined);
  return result;
}

export function suspendSessionPersistence(): void {
  persistenceSuspended = true;
  sessionGeneration++;
}

export function resumeSessionPersistence(): void {
  persistenceSuspended = false;
}

function isCurrent(generation: number): boolean {
  return !persistenceSuspended && generation === sessionGeneration;
}

/**
 * Determines whether a cookie can be safely re-injected via `CookieManager.set()`.
 *
 * Why this is critical for Google Auth (`CookieMismatch` prevention):
 * 1. `__Host-` prefixed cookies (such as `__Host-GAPS`, `__Host-1PLSID`, `__Host-3PLSID`)
 *    MUST NOT carry a `Domain` attribute per RFC 6265bis. This vault records a
 *    domain without a separate host-only flag; replaying that field would violate
 *    prefix semantics. Leave these cookies in the native store instead.
 * 2. Cookies without explicit `domain` metadata (such as those returned by Android's
 *    `CookieManager.getCookie(url)` raw header string) must not be re-injected with a
 *    synthesized host domain, which would shadow parent `.google.com` cookies (`SID`, `HSID`,
 *    `SSID`, `NID`, `__Secure-1PSID`, `__Secure-3PSID`).
 */
export function isSafeToReinjectCookie(name: string, domain?: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }
  if (name.startsWith('__Host-')) {
    return false;
  }
  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return false;
  }
  return true;
}

/**
 * Splits a serialized string payload into fixed-size chunks that fit safely
 * inside conservative SecureStore items for the iOS cookie backup.
 */
export function splitIntoChunks(
  payload: string,
  chunkSize: number = SECURE_STORE_CHUNK_SIZE,
): string[] {
  if (!payload) {
    return [];
  }
  if (chunkSize <= 0) {
    throw new Error('chunkSize must be positive');
  }
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    chunks.push(payload.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Reassembles ordered string chunks back into the original serialized payload.
 */
export function reassembleChunks(chunks: readonly string[]): string {
  return chunks.join('');
}

function getChunkKey(index: number, slot?: 'a' | 'b'): string {
  return slot
    ? `${SECURE_STORE_SNAPSHOT_PREFIX}${slot}_${index}`
    : `${SECURE_STORE_CHUNK_PREFIX}${index}`;
}

function getLegacyV1ChunkKey(index: number): string {
  return `${LEGACY_SECURE_STORE_CHUNK_PREFIX_V1}${index}`;
}

const GOOGLE_AUTH_SESSION_COOKIE_NAMES: readonly string[] = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
];

/**
 * Returns a deterministic signature of active `.google.com` authenticated session
 * cookies visible to `https://antigravity.google.com`. Returns `''` if no
 * authenticated session cookies exist yet.
 *
 * Used to detect the exact moment Google 2-Step Verification finishes issuing
 * `.google.com` session cookies so the WebView can auto-complete navigation if
 * the post-2FA redirect stalls.
 */
export async function getGoogleSessionSignature(): Promise<string> {
  try {
    if (persistenceSuspended) return '';
    const useWebKit = Platform.OS === 'ios';
    const cookiesMap = await CookieManager.get(
      ANTIGRAVITY_DASHBOARD_URL,
      useWebKit,
    );
    if (!cookiesMap) {
      return '';
    }

    const parts: string[] = [];
    for (const cookieName of GOOGLE_AUTH_SESSION_COOKIE_NAMES) {
      const value = cookiesMap[cookieName]?.value;
      if (typeof value === 'string' && value.length > 0) {
        parts.push(`${cookieName}=${value}`);
      }
    }

    return parts.join(';');
  } catch {
    return '';
  }
}

/**
 * Flushes the native OS WebView cookie store to persistent disk storage.
 * On Android, `android.webkit.CookieManager.flush()` writes the Chromium
 * cookie monster directly to the app's persistent SQLite database.
 */
export async function flushNativeCookies(): Promise<void> {
  try {
    if (
      Platform.OS === 'android' &&
      typeof CookieManager.flush === 'function'
    ) {
      await CookieManager.flush();
    }
  } catch {
    // Fail silently without logging sensitive session state
  }
}

/**
 * One-time migration that cleans up corrupted `v1` cookies created by `v1.0.0`/`v1.0.1`
 * where `CookieManager.set()` injected `Domain` attributes onto `__Host-` and domain-less
 * Android cookies, causing Google's `CookieMismatch` screen after app updates.
 */
export async function migrateCorruptedV1CookiesIfNeeded(): Promise<boolean> {
  try {
    const migrationDone = await SecureStore.getItemAsync(
      SECURE_STORE_MIGRATION_V2_KEY,
      SECURE_STORE_OPTIONS,
    );
    const legacyMetaRaw = await SecureStore.getItemAsync(
      LEGACY_SECURE_STORE_META_KEY_V1,
      SECURE_STORE_OPTIONS,
    );

    const needsCleanup =
      Boolean(legacyMetaRaw) ||
      (Platform.OS === 'android' && migrationDone !== 'true');

    if (!needsCleanup) {
      return false;
    }

    const useWebKit = Platform.OS === 'ios';
    try {
      await CookieManager.clearAll(useWebKit);
      if (useWebKit) {
        await CookieManager.clearAll(false);
      }
      await flushNativeCookies();
    } catch {
      return false;
    }

    if (legacyMetaRaw) {
      let legacyChunkCount = MAX_COOKIE_CHUNKS;
      try {
        const legacyMeta = JSON.parse(legacyMetaRaw) as CookieVaultMetadata;
        if (
          typeof legacyMeta.chunkCount === 'number' &&
          legacyMeta.chunkCount > 0
        ) {
          legacyChunkCount = Math.min(legacyMeta.chunkCount, MAX_COOKIE_CHUNKS);
        }
      } catch {
        // Fallback to MAX_COOKIE_CHUNKS
      }

      const deleteOps: Promise<void>[] = [];
      for (let i = 0; i < legacyChunkCount; i++) {
        deleteOps.push(
          SecureStore.deleteItemAsync(
            getLegacyV1ChunkKey(i),
            SECURE_STORE_OPTIONS,
          ),
        );
      }
      deleteOps.push(
        SecureStore.deleteItemAsync(
          LEGACY_SECURE_STORE_META_KEY_V1,
          SECURE_STORE_OPTIONS,
        ),
      );
      await Promise.all(deleteOps);
    }

    await SecureStore.setItemAsync(
      SECURE_STORE_MIGRATION_V2_KEY,
      'true',
      SECURE_STORE_OPTIONS,
    );

    return true;
  } catch {
    return false;
  }
}

/** Write the inactive snapshot, then commit its pointer in one SecureStore item. */
export function backupCookiesFromWebView(): Promise<number> {
  const generation = sessionGeneration;
  return serialize(async () => {
    if (!isCurrent(generation)) return 0;
    try {
      await flushNativeCookies();
      const collected: PersistedCookieRecord[] = [];
      const seen = new Set<string>();
      const activeNames = new Set<string>();
      for (const originUrl of COOKIE_SYNC_URLS) {
        const cookies = await CookieManager.get(
          originUrl,
          Platform.OS === 'ios',
        );
        if (!isCurrent(generation)) return 0;
        for (const cookie of Object.values(cookies ?? {})) {
          if (!cookie?.name || typeof cookie.value !== 'string') continue;
          activeNames.add(`${originUrl}|${cookie.name}`);
          if (!isSafeToReinjectCookie(cookie.name, cookie.domain)) continue;
          const key = `${cookie.domain}|${cookie.path ?? '/'}|${cookie.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path ?? '/',
            expires: cookie.expires,
            secure: cookie.secure ?? true,
            httpOnly: cookie.httpOnly ?? true,
            originUrl,
          });
        }
      }
      // Android relies on the native cookie store to preserve host-only attributes.
      if (Platform.OS === 'android') return activeNames.size;
      const chunks = collected.length
        ? splitIntoChunks(JSON.stringify(collected))
        : [];
      if (chunks.length > MAX_COOKIE_CHUNKS) return 0;
      const previousRaw = await SecureStore.getItemAsync(
        SECURE_STORE_META_KEY,
        SECURE_STORE_OPTIONS,
      );
      let previous: Partial<CookieVaultMetadata> = {};
      try {
        previous = JSON.parse(previousRaw ?? '{}');
      } catch {
        /* Replace invalid metadata. */
      }
      const slot = previous?.slot === 'a' ? 'b' : 'a';
      for (let i = 0; i < chunks.length; i++) {
        if (!isCurrent(generation)) return 0;
        await SecureStore.setItemAsync(
          getChunkKey(i, slot),
          chunks[i],
          SECURE_STORE_OPTIONS,
        );
      }
      if (!isCurrent(generation)) return 0;
      const metadata: CookieVaultMetadata = {
        version: 3,
        slot,
        chunkCount: chunks.length,
        updatedAtIso: new Date().toISOString(),
        cookieCount: collected.length,
      };
      await SecureStore.setItemAsync(
        SECURE_STORE_META_KEY,
        JSON.stringify(metadata),
        SECURE_STORE_OPTIONS,
      );
      return activeNames.size;
    } catch {
      // The previously committed snapshot remains intact after a failed write.
      return 0;
    }
  });
}

export function hydrateCookiesToWebView(): Promise<number> {
  const generation = sessionGeneration;
  return serialize(async () => {
    // A failed or interrupted sign-out must be retried before loading any page.
    const pending = await SecureStore.getItemAsync(
      SECURE_STORE_SIGN_OUT_KEY,
      SECURE_STORE_OPTIONS,
    );
    if (pending) {
      suspendSessionPersistence();
      await clearSessionStores();
      resumeSessionPersistence();
      return 0;
    }
    if (!isCurrent(generation)) return 0;
    await migrateCorruptedV1CookiesIfNeeded();
    if (!isCurrent(generation)) return 0;
    try {
      if (Platform.OS === 'android') {
        await flushNativeCookies();
        const maps = await Promise.all(
          COOKIE_SYNC_URLS.map((url) => CookieManager.get(url, false)),
        );
        return maps.reduce(
          (count, map) => count + Object.keys(map ?? {}).length,
          0,
        );
      }
      const raw = await SecureStore.getItemAsync(
        SECURE_STORE_META_KEY,
        SECURE_STORE_OPTIONS,
      );
      if (!raw) return 0;
      const metadata = JSON.parse(raw) as CookieVaultMetadata;
      if (
        !metadata ||
        ![2, 3].includes(metadata.version) ||
        !Number.isInteger(metadata.chunkCount) ||
        metadata.chunkCount < 0 ||
        metadata.chunkCount > MAX_COOKIE_CHUNKS ||
        (metadata.version === 3 &&
          metadata.slot !== 'a' &&
          metadata.slot !== 'b')
      )
        return 0;
      if (metadata.chunkCount === 0) return 0;
      const chunks: string[] = [];
      for (let i = 0; i < metadata.chunkCount; i++) {
        const chunk = await SecureStore.getItemAsync(
          getChunkKey(i, metadata.version === 3 ? metadata.slot : undefined),
          SECURE_STORE_OPTIONS,
        );
        if (typeof chunk !== 'string') return 0;
        chunks.push(chunk);
      }
      const records: PersistedCookieRecord[] = JSON.parse(
        reassembleChunks(chunks),
      );
      if (!Array.isArray(records)) return 0;
      const existing = new Map<string, Record<string, Cookie>>();
      for (const url of COOKIE_SYNC_URLS)
        existing.set(url, (await CookieManager.get(url, true)) ?? {});
      let restored = 0;
      for (const record of records) {
        if (!isCurrent(generation)) return 0;
        if (
          !record ||
          typeof record.value !== 'string' ||
          !isSafeToReinjectCookie(record.name, record.domain) ||
          !COOKIE_SYNC_URLS.includes(record.originUrl)
        )
          continue;
        if (
          record.expires &&
          (!Number.isFinite(Date.parse(record.expires)) ||
            Date.parse(record.expires) <= Date.now())
        )
          continue;
        const host = new URL(record.originUrl).hostname;
        const domain = record.domain!.replace(/^\./, '');
        if (host !== domain && !host.endsWith(`.${domain}`)) continue;
        if (!existing.get(record.originUrl)?.[record.name]?.value) {
          await CookieManager.set(
            record.originUrl,
            {
              name: record.name,
              value: record.value,
              domain: record.domain,
              path: record.path ?? '/',
              secure: record.secure ?? true,
              httpOnly: record.httpOnly ?? true,
              ...(record.expires ? { expires: record.expires } : {}),
            },
            true,
          );
        }
        restored++;
      }
      return restored;
    } catch {
      return 0;
    }
  });
}

export function saveLastActiveUrl(url: string): Promise<void> {
  const generation = sessionGeneration;
  return serialize(async () => {
    if (!isCurrent(generation)) return;
    try {
      const validation = validateNavigationUrl(url);
      if (
        !validation.isAllowedInApp ||
        !validation.normalizedUrl ||
        new URL(validation.normalizedUrl).hostname !== 'antigravity.google.com'
      )
        return;
      await SecureStore.setItemAsync(
        SECURE_STORE_LAST_URL_KEY,
        validation.normalizedUrl,
        SECURE_STORE_OPTIONS,
      );
    } catch {
      /* A missing resume URL does not affect authentication. */
    }
  });
}

export async function getLastActiveUrl(): Promise<string> {
  try {
    const saved = await SecureStore.getItemAsync(
      SECURE_STORE_LAST_URL_KEY,
      SECURE_STORE_OPTIONS,
    );
    const validation = validateNavigationUrl(saved ?? '');
    if (
      validation.isAllowedInApp &&
      validation.normalizedUrl &&
      new URL(validation.normalizedUrl).hostname === 'antigravity.google.com'
    )
      return validation.normalizedUrl;
  } catch {
    /* Use the dashboard if the saved location is unavailable. */
  }
  return ANTIGRAVITY_DASHBOARD_URL;
}

async function clearSessionStores(): Promise<void> {
  // Establish intent before deleting anything so a process kill cannot reopen
  // a partly cleared session. Continue all cleanup if the marker write fails.
  const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([
    SecureStore.setItemAsync(
      SECURE_STORE_SIGN_OUT_KEY,
      'true',
      SECURE_STORE_OPTIONS,
    ),
  ]);
  const operations: (() => Promise<unknown>)[] = [
    () => CookieManager.clearAll(false),
    () => clearWebData(),
  ];
  if (Platform.OS === 'ios')
    operations.push(() => CookieManager.clearAll(true));
  // Clear both snapshot slots and all legacy/orphan chunks, even with missing metadata.
  for (let i = 0; i < MAX_COOKIE_CHUNKS; i++) {
    for (const key of [
      getChunkKey(i),
      getChunkKey(i, 'a'),
      getChunkKey(i, 'b'),
      getLegacyV1ChunkKey(i),
    ]) {
      operations.push(() =>
        SecureStore.deleteItemAsync(key, SECURE_STORE_OPTIONS),
      );
    }
  }
  for (const key of [
    SECURE_STORE_META_KEY,
    LEGACY_SECURE_STORE_META_KEY_V1,
    SECURE_STORE_LAST_URL_KEY,
  ]) {
    operations.push(() =>
      SecureStore.deleteItemAsync(key, SECURE_STORE_OPTIONS),
    );
  }
  // Attempt every cleanup independently; never let one failure skip another store.
  results.push(
    ...(await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(operation)),
    )),
  );
  if (Platform.OS === 'android') {
    results.push(...(await Promise.allSettled([CookieManager.flush()])));
  }
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error(
      'Session cleanup failed. Keep this screen open and retry sign-out.',
    );
  }
  await SecureStore.deleteItemAsync(
    SECURE_STORE_SIGN_OUT_KEY,
    SECURE_STORE_OPTIONS,
  );
}

/** Persistence remains suspended until the caller mounts a clean WebView. */
export function clearSession(): Promise<void> {
  suspendSessionPersistence();
  return serialize(clearSessionStores);
}
