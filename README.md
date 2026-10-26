# Antigravity Remote

An Android and iOS wrapper for `https://antigravity.google.com`, built with Expo SDK 55, React Native 0.83, and TypeScript. Native development builds are required; the local website-data module is not included in Expo Go.

## Sessions and navigation

- Google account pages load in a persistent WebView. Sign-in and 2FA behavior depends on Google's embedded-browser support and needs testing on real devices; a browser user agent does not guarantee compatibility.
- Android preserves cookie attributes in the native Chromium store. iOS backs up eligible cookies in SecureStore/Keychain using alternating atomic snapshots. Host-prefixed cookies are left to the native store.
- Sign-out unmounts the WebView, drains pending vault operations, and clears cookies, website data, and saved snapshots. Failed or interrupted cleanup blocks reopening until a retry succeeds.
- Paste an HTTPS `/r/<instance-id>` link, terminal output, or instance ID into Remote controls. The custom scheme `antigravity-remote://r/<instance-id>` opens the installed app.
- HTTPS links on `antigravity.google.com` stay ordinary browser links. Automatic Android App Links / iOS Universal Links require association files controlled by the domain owner and are not registered by this app.
- Top-level navigation is limited to explicit application/account hosts and regional account-sync paths. External HTTPS documents open in the browser; other external schemes are blocked.

## Development

Use Node.js 22.13 or later, JDK 17, and Android SDK 36 with NDK 27.1.12297006. Native iOS builds require macOS and Xcode.

```bash
npm ci
npm run typecheck
npm test -- --runInBand
npm run check:native
npm run test:prebuild
npm run audit:dependencies
npm run android
# On macOS:
npm run ios
```

`npm start` binds Metro to localhost. For development on a physical device over a trusted LAN, run `npx expo start --lan` explicitly.

## Native regeneration

`npm run prebuild` and `npx expo prebuild --clean` apply [withRemoteSecurity](plugins/withRemoteSecurity.js). The plugin preserves backup and cleartext restrictions, SDK settings, release shrinking/signing, and keyboard insets. The local `modules/remote-session` package survives regeneration and is autolinked on both platforms.

A clean prebuild deletes the native directory, including local signing files and build outputs. Keep production keystores outside that directory and configure signing through environment variables, or back up ignored signing files before regenerating. `npm run test:prebuild` tests clean and incremental regeneration in a temporary project without touching local signing files.

## Release builds

Provide `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`, or an ignored `android/keystore.properties` file with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. Relative keystore paths resolve from `android/app`. Release tasks fail if credentials are incomplete; debug signing never substitutes for release signing. The committed debug keystore uses the standard public Android development credentials.

```bash
npm run build:play-aab
# Also check a separately built APK/AAB:
npm run check:16kb -- /absolute/path/to/app.apk
```

The build script verifies native configuration and all 64-bit library LOAD alignments before accepting the AAB. APK checks additionally verify ZIP alignment for uncompressed libraries. Building a single architecture for local verification does not replace a release build with all configured architectures.

`npm run publish:play-internal` builds and validates the AAB before invoking the Play publisher. Configure `PLAY_SERVICE_ACCOUNT_JSON` or an ignored `android/play-service-account.json` first. Publishing is a separate, explicit action.

See [SECURITY.md](SECURITY.md) for the threat boundaries, regression coverage, and remaining upstream build-tool advisories.
