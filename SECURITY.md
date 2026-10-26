# Security architecture

## Session lifecycle

Vault writes, URL persistence, restoration, and cleanup share a serialized queue. Starting cleanup immediately invalidates pending operations and suspends subsequent writes. The UI unmounts the WebView before cleanup, so the old page cannot refill the profile while cookies and website data are removed.

iOS snapshot metadata commits a pointer to one of two chunk slots after every chunk has been written. Failed writes leave the previous snapshot readable. Version 2 snapshots remain readable; new backups use version 3. Empty cookie snapshots commit an empty vault. Cleanup removes both slots and all version 1/2 chunks, including orphans with missing metadata.

Sign-out attempts native cookie stores, native website data, and SecureStore cleanup independently. Any failure is surfaced. A durable cleanup-pending marker prevents hydration from reopening an interrupted sign-out on the next launch. The marker is removed only after all cleanup succeeds. No session tokens are logged.

Android uses the native cookie database, not an encrypted cookie backup. iOS eligible-cookie backups use SecureStore with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; hardware backing depends on the device and platform. The native stores retain attributes that cannot safely be reconstructed, including host-only cookie semantics.

The local RemoteSession module clears Android web storage and cache, using the browsing-data completion callback on supported WebViews, and removes all WKWebsiteDataStore data on iOS. Older Android WebViews expose only the legacy storage-deletion API without a completion callback; real-device sign-out validation must include supported WebView versions.

## Navigation boundaries

All schemes enter the application navigation callback through `originWhitelist=['*']`; this prevents react-native-webview from automatically launching unapproved schemes. Only validated external HTTPS documents can be handed to the OS. Internal blank/srcdoc/blob documents are limited to subframes; blob origins must themselves be trusted.

Top-level trust uses exact application/account hosts and an explicit list of regional Google domains with account-sync paths. Arbitrary Google subdomains, Cloud Storage HTML, Google Sites, lookalike account hosts, credentials in URLs, and non-default ports do not receive in-app trust. Allow-listing navigation does not control every subresource requested by the remote page; the browser's TLS, same-origin, and content-security policies still apply.

Destructive cookie recovery matches exact error paths on validated Google account origins and only main-frame navigation. Recovery stops after two attempts. A completed application page with Google session cookies is required to restore the automatic retry budget.

The app registers its custom URI scheme. It does not claim verified ownership of Google HTTPS URLs; automatic HTTPS app linking requires cooperation from that domain's owner.

## Native build controls

`plugins/withRemoteSecurity.js` persists backup restrictions, cleartext restrictions, resource shrinking, release signing, SDK settings, and IME handling through clean and incremental prebuild. Backup rules exclude cloud backup and device transfer. `plugins/android-release.gradle` rejects incomplete release credentials and never substitutes the debug signing key.

The Expo SDK 55 / React Native 0.83 stack supports Android 16 KB devices. `scripts/check-16kb.py` checks the actual APK/AAB libraries, including APK ZIP alignment, instead of inferring compatibility solely from version numbers. Release build and publication scripts run this validation.

## Dependency advisories

The previous v1.0.4 audit's blanket classification of build-tool advisories as false positives is withdrawn. Build dependencies execute with developer or CI permissions and must be assessed separately from the shipped mobile bundle. The upgrade removes the old tar, XML parser, and PostCSS dependency chains identified in that audit.

Two upstream advisory IDs remain accepted temporarily, affecting Expo CLI and inherited package entries. `dependency-advisories.json` records exact IDs, affected paths, conditions, mitigation, and a review deadline. `npm run audit:dependencies` audits all dependencies, fails on new advisories, and fails when an acceptance expires. It does not classify these as false positives.

- **GHSA-86w9-cpqp-85rv (`node-forge`)**: the latest published node-forge version remains affected. The paths are Expo CLI development/code-signing tooling and `@expo/code-signing-certificates`. This app has no expo-updates dependency or OTA code-signing configuration; release signing uses Android's keystore tooling. Do not enable OTA signing or validate externally supplied certificates through this tooling without reassessment. Development Metro binds to localhost by default.
- **GHSA-mrhx-c7xc-m3w5 (`zod`)**: Expo CLI 55 uses Zod 3 to validate developer-tool extension metadata/output and construct local MCP command schemas. This application has no developer-tool extensions or MCP server configured and does not pass remote page data through these validators. Do not install untrusted extensions. Zod 4.6.6+ fixes the issue, but overriding Expo's Zod 3 dependency with a different major version is not treated as a safe patch; reassess when Expo publishes a compatible update.

## Validation and limits

Regression tests cover cleanup races, partial writes, empty snapshots, failed/interrupted sign-out, legacy migration, Android native persistence, navigation policy, repeated native navigation, reconnect behavior, and recovery limits. `npm run test:prebuild` checks clean and incremental regeneration in an isolated project.

Real-device checks are required for Google sign-in, passkeys/federated accounts, iOS Keychain/WebKit behavior, keyboard insets, and Android WebView storage deletion. JavaScript tests use native mocks and do not establish those platform guarantees. This document describes controls and limits; it is not an independent security certification.
