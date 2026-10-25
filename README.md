# Antigravity Remote

A cross-platform (Android & iOS) mobile wrapper for **Antigravity Remote** (`https://antigravity.google.com`) built with React Native, Expo, and TypeScript.

## Features

- **Seamless First-Party Google Sign-In & 2FA**: Authenticates directly with `accounts.google.com` inside a persistent mobile WebView without `403: disallowed_useragent` or `CookieMismatch` errors.
- **Persistent Session & Cookie Vault**:
  - **Android**: Native Chromium SQLite cookie persistence (`CookieManager.flush()`) with RFC 6265bis `__Host-` and `.google.com` domain scoping intact.
  - **iOS**: Hardware-backed Keychain chunked cookie vault (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) synchronized with `WKHTTPCookieStore`.
- **CLI Handoff & Deep-Link Routing**: Supports `https://antigravity.google.com/r/<instance-id>` Android App Links / iOS Universal Links, custom `antigravity-remote://` URIs, and pasting `/remote-control` terminal output directly into the native Handoff sheet.
- **Keyboard-Adaptive Chat Viewport**: Native `WindowInsetsCompat.Type.ime()` (Android 15/16 edge-to-edge) and `visualViewport` adaptation so bottom chat inputs remain visible above the software keyboard.

## Development & Testing

```bash
# Install dependencies
npm install

# Run TypeScript typechecking
npm run typecheck

# Run unit & end-to-end test suites
npm test

# Start Expo development server
npm start
```

## Building for Production

```bash
# Build signed Android App Bundle (.aab)
npm run build:play-aab
```
