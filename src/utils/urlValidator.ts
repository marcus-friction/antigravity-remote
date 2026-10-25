import {
  ALLOWED_IN_APP_DOMAIN_SUFFIXES,
  ALLOWED_IN_APP_HOSTS,
  ANTIGRAVITY_DASHBOARD_URL,
  CUSTOM_APP_SCHEME,
  GOOGLE_AUTH_HOSTS,
} from '../constants/config';
import { UrlValidationResult } from '../types/session';

/**
 * Strict pattern for an Antigravity Remote instance identifier (e.g. `devbox-swift-falcon`).
 */
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/;

/**
 * Pattern to extract a direct Antigravity Remote URL if the user pastes an entire
 * terminal output block from `agy --remote-control`.
 */
const EMBEDDED_REMOTE_URL_PATTERN =
  /https:\/\/antigravity\.google\.com\/r\/[a-zA-Z0-9._-]+(?:\?[a-zA-Z0-9%&=_.-]+)?/;

/**
 * Maximum length for navigation URLs. Google OAuth / 2-Step Verification
 * `CheckCookie` and `SetSID` redirect URLs carry signed `TL`, `ifkv`, `chtml`,
 * and `continue` tokens that frequently exceed 2,048 characters.
 */
const MAX_NAVIGATION_URL_LENGTH = 65536;

/**
 * Matches regional Google ccTLD domains used during `SetSID` / `CheckCookie`
 * redirects (e.g., `www.google.de`, `accounts.google.de`, `www.google.co.uk`,
 * `www.google.ch`, `www.google.at`, `www.google.com.au`).
 */
const REGIONAL_GOOGLE_HOST_PATTERN =
  /^(?:[a-z0-9-]+\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/i;

const REGIONAL_GOOGLE_AUTH_PATH_PREFIXES: readonly string[] = [
  '/accounts/',
  '/checkcookie',
  '/setsid',
  '/signin/',
  '/v3/signin/',
];

function isAllowedRegionalGoogleUrl(hostname: string, pathname: string): boolean {
  if (!REGIONAL_GOOGLE_HOST_PATTERN.test(hostname)) {
    return false;
  }
  if (hostname.startsWith('accounts.google.')) {
    return true;
  }
  const lowerPath = pathname.toLowerCase();
  return REGIONAL_GOOGLE_AUTH_PATH_PREFIXES.some((prefix) =>
    lowerPath.startsWith(prefix)
  );
}

/**
 * Checks whether a URL uses an internal browser document scheme (`about:blank`,
 * `about:srcdoc`, `blob:`) that WebView subframes require during Google 2FA.
 */
export function isInternalWebViewSchemeUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  const lower = rawUrl.trim().toLowerCase();
  return (
    lower === 'about:blank' ||
    lower === 'about:srcdoc' ||
    lower.startsWith('about:blank#') ||
    lower.startsWith('blob:https://')
  );
}

/**
 * Validates a URL before allowing the WebView to navigate or handing it off to
 * the system browser. Enforces HTTPS and checks against the strict hostname allow-list.
 */
export function validateNavigationUrl(rawUrl: string): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return {
      isValid: false,
      normalizedUrl: null,
      isAllowedInApp: false,
      isAuthHost: false,
      reason: 'Empty or non-string URL',
    };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_NAVIGATION_URL_LENGTH) {
    return {
      isValid: false,
      normalizedUrl: null,
      isAllowedInApp: false,
      isAuthHost: false,
      reason: 'URL exceeds maximum length',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      isValid: false,
      normalizedUrl: null,
      isAllowedInApp: false,
      isAuthHost: false,
      reason: 'Malformed URL',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      isValid: false,
      normalizedUrl: null,
      isAllowedInApp: false,
      isAuthHost: false,
      reason: `Disallowed protocol: ${parsed.protocol}`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      isValid: false,
      normalizedUrl: null,
      isAllowedInApp: false,
      isAuthHost: false,
      reason: 'Credentials in URL are not permitted',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAllowedInApp =
    ALLOWED_IN_APP_HOSTS.has(hostname) ||
    ALLOWED_IN_APP_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isAllowedRegionalGoogleUrl(hostname, parsed.pathname);
  const isAuthHost =
    GOOGLE_AUTH_HOSTS.has(hostname) ||
    hostname.startsWith('accounts.google.');

  return {
    isValid: true,
    normalizedUrl: parsed.toString(),
    isAllowedInApp,
    isAuthHost,
  };
}

/**
 * Detects whether a URL is Google Account's `CookieMismatch` or `nocookie`
 * error page (e.g., `https://accounts.google.com/CookieMismatch`), which
 * occurs if WebView cookies become out of sync or corrupted.
 */
export function isGoogleCookieErrorUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname !== 'accounts.google.com' &&
      !hostname.endsWith('.google.com')
    ) {
      return false;
    }
    const lowerPathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return (
      lowerPathAndQuery.includes('cookiemismatch') ||
      lowerPathAndQuery.includes('/nocookie')
    );
  } catch {
    return false;
  }
}

/**
 * Parses a deep link or user-pasted handoff string into a verified
 * `https://antigravity.google.com/...` URL.
 *
 * Accepts:
 * 1. Direct URL: `https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F123`
 * 2. Multi-line CLI terminal output containing an `https://antigravity.google.com/r/...` link
 * 3. Custom app scheme: `antigravity-remote://r/devbox-swift-falcon?p=c%2F123`
 * 4. Bare instance ID: `devbox-swift-falcon`
 */
export function parseHandoffInput(rawInput: string): string | null {
  if (!rawInput || typeof rawInput !== 'string') {
    return null;
  }

  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 2048) {
    return null;
  }

  // Case 1: Custom scheme deep link `antigravity-remote://...`
  if (trimmed.toLowerCase().startsWith(CUSTOM_APP_SCHEME)) {
    const remainder = trimmed.slice(CUSTOM_APP_SCHEME.length).replace(/^\/+/, '');
    if (!remainder) {
      return ANTIGRAVITY_DASHBOARD_URL;
    }
    const candidateUrl = `${ANTIGRAVITY_DASHBOARD_URL}/${remainder}`;
    return validateAntigravityTargetUrl(candidateUrl);
  }

  // Case 2: Direct HTTPS URL
  if (trimmed.startsWith('https://')) {
    const directResult = validateAntigravityTargetUrl(trimmed);
    if (directResult) {
      return directResult;
    }
  }

  // Case 3: Terminal snippet containing an embedded `https://antigravity.google.com/r/...` URL
  const embeddedMatch = trimmed.match(EMBEDDED_REMOTE_URL_PATTERN);
  if (embeddedMatch && embeddedMatch[0]) {
    return validateAntigravityTargetUrl(embeddedMatch[0]);
  }

  // Case 4: Bare instance ID (e.g. `devbox-swift-falcon`)
  if (INSTANCE_ID_PATTERN.test(trimmed)) {
    return `${ANTIGRAVITY_DASHBOARD_URL}/r/${encodeURIComponent(trimmed)}`;
  }

  return null;
}

/**
 * Ensures a target handoff URL resolves strictly to `antigravity.google.com`.
 */
function validateAntigravityTargetUrl(candidateUrl: string): string | null {
  const validation = validateNavigationUrl(candidateUrl);
  if (!validation.isValid || !validation.normalizedUrl) {
    return null;
  }

  const parsed = new URL(validation.normalizedUrl);
  if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
    return null;
  }

  return parsed.toString();
}
