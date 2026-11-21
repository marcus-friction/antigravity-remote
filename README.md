# Antigravity Remote

An Android and iOS wrapper for `https://antigravity.google.com`, built with Expo SDK 55, React Native 0.83, and TypeScript. Native development builds are required; the local website-data module is not included in Expo Go.

## Sessions and navigation

- Google account pages load in a persistent WebView. Sign-in and 2FA behavior depends on Google's embedded-browser support and needs testing on real devices; a browser user agent does not guarantee compatibility.
- Android preserves cookie attributes in the native Chromium store. iOS backs up eligible cookies in SecureStore/Keychain using alternating atomic snapshots. Host-prefixed cookies are left to the native store.
- Sign-out unmounts the WebView, drains pending vault operations, and clears cookies, website data, and saved snapshots. Failed or interrupted cleanup blocks reopening until a retry succeeds.
- Configurable **Action Notifications** in the left **Settings** drawer (`Off`, `Approvals`, or `All Attention`, defaulting to `All Attention`) post and update a single OS notification with color-coded thread cards showing each thread's project name and open action count across connected workstations: tapping opens the relevant thread directly when `1` action is open (`antigravity-remote://r/<instance-id>?p=c%2F<cascade-id>`), opens the Sidebar **Inbox** (or an individual card on Android) when multiple actions are open (`antigravity-remote://inbox`), and clears automatically when resolved.
- Background keep-alive (`30m` by default to keep action notifications live across app switches and while locked; configurable in **Settings** to `Off`, `5m`, `15m`, `30m`, or `60m` on Android, and `Off` / `On (~30s)` on iOS) holds active remote workstation connections open and continues lightweight on-device state polling while the screen is locked using a bounded Android `specialUse` foreground service (with a **Stop Keep-Alive** notification button) and iOS `beginBackgroundTask`, while waking active sessions and auto-recovering evicted WebView processes on resume.
- Pull-in left navigation drawer (**Inbox**, **Projects**, **Usage**, and **Settings** views — docked side-by-side on tablets/foldables, opened on phones via a back-gesture-safe vertical handle line along the left margin, and opened automatically whenever archiving or navigating leaves an empty workspace screen) aggregates conversations and server projects across all connected Remote Control workstations (`ListInstances`, `GetAllCascadeTrajectories`, `JetboxSubscribeToSummaries`, `ListProjects`, `ReadProjects`, `GetWorkspaceInfos`, and `ListBackgroundTasks`), surfacing pending tool/question approvals (including bubbled subagent prompts), execution errors, and unread completions with instant same-workstation switching, project-scoped new chats, remote folder browsing/project creation, thread project headers, and one-tap **Mark read**, alongside live plan/credit balances, 5-hour & weekly quota pools, and per-model quota reset countdowns (`RetrieveUserQuotaSummary` + `GetUserStatus`).
- Open **Open Link or Machine ID** in the left **Settings** drawer to paste an HTTPS `/r/<instance-id>` link, terminal output, or machine ID. The custom scheme `antigravity-remote://r/<instance-id>` opens the installed app.
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

Dependencies use published upstream releases without local source patches. Expo's Zod dependency is overridden to upstream 4.6.7, with compatibility tests. `npm run audit:dependencies` runs the standard npm audit across all dependency types without exemptions. It currently fails on the unresolved node-forge advisory; no fixed upstream release is available as of 2026-10-26. See [SECURITY.md](SECURITY.md) for the affected dependency paths and upstream tracking.

## Native regeneration

`npm run prebuild` and `npx expo prebuild --clean` apply [withRemoteSecurity](plugins/withRemoteSecurity.js). The plugin preserves backup and cleartext restrictions, SDK settings, release shrinking/signing, and keyboard insets. The local `modules/remote-session` package survives regeneration and is autolinked on both platforms.

A clean prebuild deletes the native directory, including local signing files and build outputs. Keep production keystores outside that directory and configure signing through environment variables, or back up ignored signing files before regenerating. `npm run test:prebuild` tests clean and incremental regeneration in a temporary project without touching local signing files.

## Release builds

Provide `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`, or an ignored `android/keystore.properties` file with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. Relative keystore paths resolve from `android/app`. Release tasks fail if credentials are incomplete; debug signing never substitutes for release signing. The committed debug keystore uses the standard public Android development credentials.

```bash
npm run generate:play-assets
npm run build:play-aab
# Also check a separately built APK/AAB:
npm run check:16kb -- /absolute/path/to/app.apk
```

The build script verifies native configuration, Play Store metadata/screenshot dimensions, and all 64-bit library LOAD alignments before accepting the AAB. APK checks additionally verify ZIP alignment for uncompressed libraries. Building a single architecture for local verification does not replace a release build with all configured architectures.

`npm run capture:play-screenshots -- --build` builds an isolated sample-data app, starts a loopback-only sample backend, and takes native Android screenshots using a connected Android 16 emulator with a Pixel 10 Pro display profile (`1280x2856`, `495 dpi`; select it with `ANDROID_SERIAL`). The native drawer, its closed handle, and Android notification layouts use the production components; the thread WebView uses Google’s unmodified Remote Control renderer with local sample RPC responses. The renderer version and core asset checksums are pinned in `scripts/screenshots/upstream-renderer.json`; upstream JavaScript and CSS are never patched. The capture-only Android variant permits HTTP solely to the loopback fixture server. Capture code is excluded from the production entry point and uses a separate application ID and the public debug signing key. Original, unedited captures and their checksum/provenance manifest are saved under `store-assets/screenshots/`, including native docked tablet views (`1728x1080` / `1920x1200`).

`npm run generate:play-assets` copies those captured screenshots into the Play listing and renders the app icon (`512x512`) and feature graphic (`1024x500`) using local headless Chromium (override with `CHROME_BIN` if needed). Use `-- --screenshots-only` to update screenshots while preserving branding assets. Phone exports add plain side gutters (`1428x2856`) for the repository's existing 2:1 store bounds; the original captured UI stays at native resolution. Missing or modified capture sources fail generation, so browser mockups cannot silently replace the screenshots. `npm run publish:play-listing` regenerates, validates, and uploads the store listing & graphics; `npm run publish:play-internal` and `npm run publish:play-production` validate and upload release bundles. Configure `PLAY_SERVICE_ACCOUNT_JSON` or an ignored `android/play-service-account.json` first. Publishing is a separate, explicit action.

See [SECURITY.md](SECURITY.md) for the threat boundaries, regression coverage, and outstanding build-tool advisory.
