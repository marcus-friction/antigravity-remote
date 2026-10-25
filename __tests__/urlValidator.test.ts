jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
}));

import {
  isGoogleCookieErrorUrl,
  isInternalWebViewSchemeUrl,
  parseHandoffInput,
  validateNavigationUrl,
} from '../src/utils/urlValidator';
import {
  getCleanMobileUserAgent,
  stripWebViewMarkers,
} from '../src/utils/userAgent';

describe('urlValidator', () => {
  describe('validateNavigationUrl', () => {
    it('allows Antigravity Remote dashboard and handoff URLs in-app', () => {
      const rootResult = validateNavigationUrl('https://antigravity.google.com');
      expect(rootResult.isValid).toBe(true);
      expect(rootResult.isAllowedInApp).toBe(true);
      expect(rootResult.isAuthHost).toBe(false);

      const handoffResult = validateNavigationUrl(
        'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F12345'
      );
      expect(handoffResult.isValid).toBe(true);
      expect(handoffResult.isAllowedInApp).toBe(true);
      expect(handoffResult.isAuthHost).toBe(false);
    });

    it('recognizes Google authentication and first-party Google hosts as allowed in-app', () => {
      const loginResult = validateNavigationUrl(
        'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fantigravity.google.com'
      );
      expect(loginResult.isValid).toBe(true);
      expect(loginResult.isAllowedInApp).toBe(true);
      expect(loginResult.isAuthHost).toBe(true);

      const wwwGoogleResult = validateNavigationUrl(
        'https://www.google.com/accounts/SetSID?ssdc=1'
      );
      expect(wwwGoogleResult.isValid).toBe(true);
      expect(wwwGoogleResult.isAllowedInApp).toBe(true);

      // Regional Google ccTLD SetSID redirect (e.g. Germany .de)
      const regionalSetSidResult = validateNavigationUrl(
        'https://www.google.de/accounts/SetSID?ssdc=1&continue=https%3A%2F%2Fantigravity.google.com'
      );
      expect(regionalSetSidResult.isValid).toBe(true);
      expect(regionalSetSidResult.isAllowedInApp).toBe(true);

      // Non-auth paths on regional Google ccTLD or www.youtube.com open externally
      const regionalSearchResult = validateNavigationUrl(
        'https://www.google.de/search?q=antigravity'
      );
      expect(regionalSearchResult.isValid).toBe(true);
      expect(regionalSearchResult.isAllowedInApp).toBe(false);

      const youtubeVideoResult = validateNavigationUrl(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      );
      expect(youtubeVideoResult.isValid).toBe(true);
      expect(youtubeVideoResult.isAllowedInApp).toBe(false);

      const youtubeAuthResult = validateNavigationUrl(
        'https://accounts.youtube.com/accounts/SetSID?ssdc=1'
      );
      expect(youtubeAuthResult.isValid).toBe(true);
      expect(youtubeAuthResult.isAllowedInApp).toBe(true);

      // Long (>2,048 chars) post-2FA CheckCookie redirect URL with TL & ifkv tokens
      const longCheckCookieUrl =
        'https://accounts.google.com/CheckCookie?continue=https%3A%2F%2Fantigravity.google.com&TL=' +
        'a'.repeat(3200);
      const longCheckCookieResult = validateNavigationUrl(longCheckCookieUrl);
      expect(longCheckCookieResult.isValid).toBe(true);
      expect(longCheckCookieResult.isAllowedInApp).toBe(true);

      expect(isInternalWebViewSchemeUrl('about:blank')).toBe(true);
      expect(isInternalWebViewSchemeUrl('about:srcdoc')).toBe(true);
    });

    it('detects Google CookieMismatch and nocookie error URLs accurately', () => {
      expect(
        isGoogleCookieErrorUrl('https://accounts.google.com/CookieMismatch')
      ).toBe(true);
      expect(
        isGoogleCookieErrorUrl(
          'https://accounts.google.com/v3/signin/CookieMismatch?continue=https%3A%2F%2Fantigravity.google.com'
        )
      ).toBe(true);
      expect(
        isGoogleCookieErrorUrl('https://accounts.google.com/nocookie')
      ).toBe(true);
      expect(
        isGoogleCookieErrorUrl(
          'https://accounts.google.com/v3/signin/identifier'
        )
      ).toBe(false);
      expect(
        isGoogleCookieErrorUrl('https://antigravity.google.com')
      ).toBe(false);
    });

    it('marks external HTTPS URLs as valid but not allowed in-app (for system browser handoff)', () => {
      const externalResult = validateNavigationUrl(
        'https://github.com/google-antigravity/antigravity-sdk-python'
      );
      expect(externalResult.isValid).toBe(true);
      expect(externalResult.isAllowedInApp).toBe(false);
      expect(externalResult.isAuthHost).toBe(false);
    });

    it('rejects non-HTTPS schemes, credentials in URLs, and domain spoofing', () => {
      expect(
        validateNavigationUrl('http://antigravity.google.com').isValid
      ).toBe(false);
      expect(
        validateNavigationUrl('javascript:alert(1)').isValid
      ).toBe(false);
      expect(
        validateNavigationUrl('file:///etc/passwd').isValid
      ).toBe(false);
      expect(
        validateNavigationUrl('https://user:pass@antigravity.google.com').isValid
      ).toBe(false);

      const spoofed = validateNavigationUrl(
        'https://antigravity.google.com.attacker.example/r/test'
      );
      expect(spoofed.isValid).toBe(true);
      expect(spoofed.isAllowedInApp).toBe(false);
    });
  });

  describe('parseHandoffInput', () => {
    it('parses direct Antigravity Remote handoff URLs', () => {
      expect(
        parseHandoffInput(
          '  https://antigravity.google.com/r/devbox-swift-falcon?p=c%2Fabc123  '
        )
      ).toBe('https://antigravity.google.com/r/devbox-swift-falcon?p=c%2Fabc123');
    });

    it('extracts handoff URLs from pasted multi-line CLI terminal output', () => {
      const cliOutput = `
        Remote control on for this session.
        Hostname: devbox-swift-falcon
        Open https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F9876 on another device to continue this conversation.
      `;
      expect(parseHandoffInput(cliOutput)).toBe(
        'https://antigravity.google.com/r/devbox-swift-falcon?p=c%2F9876'
      );
    });

    it('converts custom scheme antigravity-remote:// URLs into HTTPS target URLs', () => {
      expect(
        parseHandoffInput('antigravity-remote://r/workstation-primary')
      ).toBe('https://antigravity.google.com/r/workstation-primary');

      expect(parseHandoffInput('antigravity-remote://')).toBe(
        'https://antigravity.google.com'
      );
    });

    it('converts a bare instance hostname into a full handoff URL', () => {
      expect(parseHandoffInput('devbox-swift-falcon')).toBe(
        'https://antigravity.google.com/r/devbox-swift-falcon'
      );
    });

    it('rejects untrusted domains and invalid inputs', () => {
      expect(parseHandoffInput('https://evil.example.com/r/123')).toBeNull();
      expect(parseHandoffInput('javascript:void(0)')).toBeNull();
      expect(parseHandoffInput('')).toBeNull();
      expect(parseHandoffInput('   ')).toBeNull();
    });
  });

  describe('userAgent helpers', () => {
    it('returns clean mobile User-Agents without WebView markers', () => {
      const iosUa = getCleanMobileUserAgent('ios');
      const androidUa = getCleanMobileUserAgent('android');

      expect(iosUa).toContain('Safari/');
      expect(iosUa).not.toContain('; wv');
      expect(androidUa).toContain('Chrome/');
      expect(androidUa).not.toContain('; wv');
    });

    it('strips ; wv and Version/X.Y tokens from raw WebView User-Agents', () => {
      const rawAndroidWv =
        'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
      const cleaned = stripWebViewMarkers(rawAndroidWv);
      expect(cleaned).not.toContain('; wv');
      expect(cleaned).not.toContain('Version/4.0');
      expect(cleaned).toContain('Chrome/130.0.0.0 Mobile Safari/537.36');
    });
  });
});
