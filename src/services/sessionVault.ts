import CookieManager, { Cookie } from '@react-native-cookies/cookies';
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
  SECURE_STORE_LAST_URL_KEY,
  SECURE_STORE_META_KEY,
  SECURE_STORE_MIGRATION_V2_KEY,
} from '../constants/config';
import {
  CookieVaultMetadata,
  PersistedCookieRecord,
} from '../types/session';
import { validateNavigationUrl } from '../utils/urlValidator';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * Determines whether a cookie can be safely re-injected via `CookieManager.set()`.
 *
 * Why this is critical for Google Auth (`CookieMismatch` prevention):
 * 1. `__Host-` prefixed cookies (such as `__Host-GAPS`, `__Host-1PLSID`, `__Host-3PLSID`)
 *    MUST NOT carry a `Domain` attribute per RFC 6265bis. Because `@react-native-cookies/cookies`
 *    always attaches a `Domain` attribute during `CookieManager.set()`, re-injecting `__Host-`
 *    cookies corrupts them and triggers `accounts.google.com/CookieMismatch`.
 * 2. Cookies without explicit `domain` metadata (such as those returned by Android's
 *    `CookieManager.getCookie(url)` raw header string) must not be re-injected with a
 *    synthesized host domain, which would shadow parent `.google.com` cookies (`SID`, `HSID`,
 *    `SSID`, `NID`, `__Secure-1PSID`, `__Secure-3PSID`).
 */
export function isSafeToReinjectCookie(
  name: string,
  domain?: string
): boolean {
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
 * inside hardware-backed Keychain / Keystore items (< 2048 bytes).
 */
export function splitIntoChunks(
  payload: string,
  chunkSize: number = SECURE_STORE_CHUNK_SIZE
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

function getChunkKey(index: number): string {
  return `${SECURE_STORE_CHUNK_PREFIX}${index}`;
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
    const useWebKit = Platform.OS === 'ios';
    const cookiesMap = await CookieManager.get(
      ANTIGRAVITY_DASHBOARD_URL,
      useWebKit
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
    if (Platform.OS === 'android' && typeof CookieManager.flush === 'function') {
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
      SECURE_STORE_OPTIONS
    );
    const legacyMetaRaw = await SecureStore.getItemAsync(
      LEGACY_SECURE_STORE_META_KEY_V1,
      SECURE_STORE_OPTIONS
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
      // Continue cleaning up SecureStore keys even if CookieManager throws
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
            SECURE_STORE_OPTIONS
          )
        );
      }
      deleteOps.push(
        SecureStore.deleteItemAsync(
          LEGACY_SECURE_STORE_META_KEY_V1,
          SECURE_STORE_OPTIONS
        )
      );
      await Promise.all(deleteOps);
    }

    await SecureStore.setItemAsync(
      SECURE_STORE_MIGRATION_V2_KEY,
      'true',
      SECURE_STORE_OPTIONS
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Reads active session cookies from the native WebView cookie store for
 * `antigravity.google.com` and `accounts.google.com`, flushes the native OS
 * cookie database, and backs up re-injectable cookies into the hardware-backed
 * encrypted Keychain / Keystore vault.
 */
export async function backupCookiesFromWebView(): Promise<number> {
  try {
    await flushNativeCookies();

    const useWebKit = Platform.OS === 'ios';
    const collected: PersistedCookieRecord[] = [];
    const seenKeys = new Set<string>();
    const activeNames = new Set<string>();

    for (const originUrl of COOKIE_SYNC_URLS) {
      const cookiesMap = await CookieManager.get(originUrl, useWebKit);
      if (!cookiesMap) {
        continue;
      }

      for (const cookie of Object.values(cookiesMap)) {
        if (!cookie || !cookie.name || typeof cookie.value !== 'string') {
          continue;
        }

        activeNames.add(`${originUrl}|${cookie.name}`);

        if (!isSafeToReinjectCookie(cookie.name, cookie.domain)) {
          continue;
        }

        const dedupeKey = `${cookie.domain}|${cookie.path ?? '/'}|${cookie.name}`;
        if (seenKeys.has(dedupeKey)) {
          continue;
        }
        seenKeys.add(dedupeKey);

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

    // On Android, native Chromium SQLite (`CookieManager.flush()`) persists all
    // cookies with full RFC 6265bis attributes (`__Host-`, `.google.com`, `SameSite`).
    if (Platform.OS === 'android') {
      return activeNames.size;
    }

    if (collected.length === 0) {
      return activeNames.size;
    }

    const serialized = JSON.stringify(collected);
    const chunks = splitIntoChunks(serialized, SECURE_STORE_CHUNK_SIZE);

    if (chunks.length > MAX_COOKIE_CHUNKS) {
      return activeNames.size;
    }

    // Write all new chunks first before updating metadata
    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(
        getChunkKey(i),
        chunks[i],
        SECURE_STORE_OPTIONS
      );
    }

    // Clean up any leftover chunks from a previously larger backup
    const previousMetaRaw = await SecureStore.getItemAsync(
      SECURE_STORE_META_KEY,
      SECURE_STORE_OPTIONS
    );
    if (previousMetaRaw) {
      try {
        const previousMeta = JSON.parse(previousMetaRaw) as CookieVaultMetadata;
        if (
          typeof previousMeta.chunkCount === 'number' &&
          previousMeta.chunkCount > chunks.length
        ) {
          for (let i = chunks.length; i < previousMeta.chunkCount; i++) {
            await SecureStore.deleteItemAsync(
              getChunkKey(i),
              SECURE_STORE_OPTIONS
            );
          }
        }
      } catch {
        // Ignore corrupted old metadata
      }
    }

    const metadata: CookieVaultMetadata = {
      version: 2,
      chunkCount: chunks.length,
      updatedAtIso: new Date().toISOString(),
      cookieCount: collected.length,
    };

    await SecureStore.setItemAsync(
      SECURE_STORE_META_KEY,
      JSON.stringify(metadata),
      SECURE_STORE_OPTIONS
    );

    return Math.max(collected.length, activeNames.size);
  } catch {
    return 0;
  }
}

/**
 * Restores backed-up cookies from the hardware-backed Keychain / Keystore vault
 * into the native WebView CookieManager before the WebView mounts on cold start.
 */
export async function hydrateCookiesToWebView(): Promise<number> {
  try {
    await migrateCorruptedV1CookiesIfNeeded();

    // On Android, Chromium's SQLite cookie store (`app_webview/Default/Cookies`)
    // natively persists cookies across restarts and app updates without losing
    // `.google.com` domain scoping or `__Host-` prefix semantics.
    if (Platform.OS === 'android') {
      await flushNativeCookies();
      let activeCount = 0;
      for (const originUrl of COOKIE_SYNC_URLS) {
        const existing = await CookieManager.get(originUrl, false);
        if (existing) {
          activeCount += Object.keys(existing).length;
        }
      }
      return activeCount;
    }

    const metaRaw = await SecureStore.getItemAsync(
      SECURE_STORE_META_KEY,
      SECURE_STORE_OPTIONS
    );
    if (!metaRaw) {
      return 0;
    }

    const metadata = JSON.parse(metaRaw) as CookieVaultMetadata;
    if (
      !metadata ||
      metadata.version !== 2 ||
      typeof metadata.chunkCount !== 'number' ||
      metadata.chunkCount <= 0 ||
      metadata.chunkCount > MAX_COOKIE_CHUNKS
    ) {
      return 0;
    }

    const chunks: string[] = [];
    for (let i = 0; i < metadata.chunkCount; i++) {
      const chunk = await SecureStore.getItemAsync(
        getChunkKey(i),
        SECURE_STORE_OPTIONS
      );
      if (typeof chunk !== 'string') {
        return 0;
      }
      chunks.push(chunk);
    }

    const payload = reassembleChunks(chunks);
    const records = JSON.parse(payload) as PersistedCookieRecord[];
    if (!Array.isArray(records) || records.length === 0) {
      return 0;
    }

    const useWebKit = Platform.OS === 'ios';
    const existingByOrigin = new Map<string, Record<string, Cookie>>();
    for (const originUrl of COOKIE_SYNC_URLS) {
      const currentCookies = await CookieManager.get(originUrl, useWebKit);
      existingByOrigin.set(originUrl, currentCookies ?? {});
    }

    let restoredCount = 0;

    for (const record of records) {
      if (
        !record ||
        !record.name ||
        typeof record.value !== 'string' ||
        !isSafeToReinjectCookie(record.name, record.domain)
      ) {
        continue;
      }

      const targetOrigin =
        record.originUrl && COOKIE_SYNC_URLS.includes(record.originUrl)
          ? record.originUrl
          : ANTIGRAVITY_DASHBOARD_URL;

      // Do not overwrite fresher cookies that are already present in WKHTTPCookieStore
      const existingCookies = existingByOrigin.get(targetOrigin);
      if (existingCookies && existingCookies[record.name]?.value) {
        restoredCount++;
        continue;
      }

      const cookieToSet: Cookie = {
        name: record.name,
        value: record.value,
        domain: record.domain,
        path: record.path ?? '/',
        secure: record.secure ?? true,
        httpOnly: record.httpOnly ?? true,
      };

      if (record.expires) {
        cookieToSet.expires = record.expires;
      }

      await CookieManager.set(targetOrigin, cookieToSet, useWebKit);
      restoredCount++;
    }

    await flushNativeCookies();
    return restoredCount;
  } catch {
    return 0;
  }
}

/**
 * Persists the last active `antigravity.google.com` URL so reopening the app
 * returns directly to the user's active remote workstation or conversation.
 */
export async function saveLastActiveUrl(url: string): Promise<void> {
  try {
    const validation = validateNavigationUrl(url);
    if (!validation.isValid || !validation.normalizedUrl) {
      return;
    }

    const parsed = new URL(validation.normalizedUrl);
    if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
      return;
    }

    await SecureStore.setItemAsync(
      SECURE_STORE_LAST_URL_KEY,
      validation.normalizedUrl,
      SECURE_STORE_OPTIONS
    );
  } catch {
    // Fail silently
  }
}

/**
 * Retrieves the last active `antigravity.google.com` URL from SecureStore,
 * falling back to the main dashboard URL if none is saved.
 */
export async function getLastActiveUrl(): Promise<string> {
  try {
    const savedUrl = await SecureStore.getItemAsync(
      SECURE_STORE_LAST_URL_KEY,
      SECURE_STORE_OPTIONS
    );
    if (!savedUrl) {
      return ANTIGRAVITY_DASHBOARD_URL;
    }

    const validation = validateNavigationUrl(savedUrl);
    if (!validation.isValid || !validation.normalizedUrl) {
      return ANTIGRAVITY_DASHBOARD_URL;
    }

    const parsed = new URL(validation.normalizedUrl);
    if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
      return ANTIGRAVITY_DASHBOARD_URL;
    }

    return validation.normalizedUrl;
  } catch {
    return ANTIGRAVITY_DASHBOARD_URL;
  }
}

/**
 * Completely wipes all session cookies from both the native WebView cookie store
 * and the hardware-backed Keychain / Keystore vault upon explicit user sign-out.
 */
export async function clearSession(): Promise<void> {
  try {
    const useWebKit = Platform.OS === 'ios';
    await CookieManager.clearAll(useWebKit);
    if (useWebKit) {
      // Also clear NSHTTPCookieStorage on iOS so shared cookies are fully wiped
      await CookieManager.clearAll(false);
    }
    await flushNativeCookies();
  } catch {
    // Continue to wipe SecureStore even if CookieManager throws
  }

  try {
    const metaRaw = await SecureStore.getItemAsync(
      SECURE_STORE_META_KEY,
      SECURE_STORE_OPTIONS
    );

    const deleteOps: Promise<void>[] = [];

    if (metaRaw) {
      let chunkCountToClear = MAX_COOKIE_CHUNKS;
      try {
        const meta = JSON.parse(metaRaw) as CookieVaultMetadata;
        if (typeof meta.chunkCount === 'number' && meta.chunkCount > 0) {
          chunkCountToClear = Math.min(meta.chunkCount, MAX_COOKIE_CHUNKS);
        }
      } catch {
        // Fallback to clearing MAX_COOKIE_CHUNKS if metadata JSON is corrupted
      }

      for (let i = 0; i < chunkCountToClear; i++) {
        deleteOps.push(
          SecureStore.deleteItemAsync(getChunkKey(i), SECURE_STORE_OPTIONS)
        );
      }
    }

    deleteOps.push(
      SecureStore.deleteItemAsync(SECURE_STORE_META_KEY, SECURE_STORE_OPTIONS),
      SecureStore.deleteItemAsync(
        SECURE_STORE_LAST_URL_KEY,
        SECURE_STORE_OPTIONS
      )
    );

    await Promise.all(deleteOps);
  } catch {
    // Fail silently
  }
}
