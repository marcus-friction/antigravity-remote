/**
 * Core configuration constants for Antigravity Remote mobile wrapper.
 *
 * Top-level WebView navigation uses explicit HTTPS application/account hosts.
 */

export const ANTIGRAVITY_DASHBOARD_URL = 'https://antigravity.google.com';

export const GOOGLE_ACCOUNTS_URL = 'https://accounts.google.com';

export const PRIVACY_POLICY_URL =
  'https://marcus-friction.github.io/antigravity-remote/privacy-policy.html';

export const SOURCE_REPO_URL =
  'https://github.com/marcus-friction/antigravity-remote';

export const CUSTOM_APP_SCHEME = 'antigravity-remote:';

/**
 * Exact application and account hosts permitted as top-level documents.
 * permitted to load inside the authenticated application WebView. Any external
 * HTTPS link outside these hosts will be handed off safely to the OS browser.
 */
export const ALLOWED_IN_APP_HOSTS: ReadonlySet<string> = new Set([
  'antigravity.google.com',
  'antigravity.google',
  'accounts.google.com',
  'myaccount.google.com',
  'accounts.youtube.com',
  'gds.google.com',
  'consent.google.com',
]);

/**
 * Hostnames that indicate the user is actively on a Google authentication
 * or account challenge screen (login, 2FA, Passkey, Workspace SSO).
 */
export const GOOGLE_AUTH_HOSTS: ReadonlySet<string> = new Set([
  'accounts.google.com',
  'myaccount.google.com',
  'accounts.youtube.com',
  'gds.google.com',
  'consent.google.com',
]);

/**
 * Origins whose cookies should be backed up to and restored from the
 * hardware-backed Keychain / Keystore vault.
 */
export const COOKIE_SYNC_URLS: readonly string[] = [
  'https://antigravity.google.com',
  'https://accounts.google.com',
];

/**
 * iOS SecureStore backup keys and conservative per-item chunking limits.
 */
export const SECURE_STORE_META_KEY = 'agy_cookie_vault_meta_v2';
export const SECURE_STORE_CHUNK_PREFIX = 'agy_cookie_vault_chunk_v2_';
export const SECURE_STORE_SNAPSHOT_PREFIX = 'agy_cookie_vault_snapshot_v3_';
export const SECURE_STORE_SIGN_OUT_KEY = 'agy_session_cleanup_pending';
export const LEGACY_SECURE_STORE_META_KEY_V1 = 'agy_cookie_vault_meta_v1';
export const LEGACY_SECURE_STORE_CHUNK_PREFIX_V1 = 'agy_cookie_vault_chunk_v1_';
export const SECURE_STORE_MIGRATION_V2_KEY = 'agy_cookie_migration_v2_done';
export const SECURE_STORE_LAST_URL_KEY = 'agy_last_active_url_v1';
export const SECURE_STORE_CHUNK_SIZE = 1800;
export const MAX_COOKIE_CHUNKS = 32;

/**
 * Platform-matched mobile browser User-Agent strings.
 *
 * Why this is required:
 * Default Android WebView includes `; wv` and default iOS WKWebView omits the
 * `Version/... Mobile/... Safari/...` token, which triggers Google OAuth's
 * `403: disallowed_useragent` block on `accounts.google.com`. Using standard
 * mobile browser User-Agents allows first-party `.google.com` login and 2FA
 * flows to use browser-compatible identifiers. Google may still reject embedded
 * authentication; this is not a guarantee of sign-in or passkey support.
 */
export const IOS_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';

export const ANDROID_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
