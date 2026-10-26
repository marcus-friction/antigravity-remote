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

The two remaining build-tool vulnerabilities are remediated with a dependency override and an installed-source backport. There is no time-based advisory acceptance list. `npm run audit:dependencies` audits all dependencies and verifies the backport before recognizing its one exact advisory as fixed. New advisories, expanded affected ranges, additional unverified dependency paths, missing patches, and changed source code fail the check.

- **GHSA-86w9-cpqp-85rv (`node-forge`)**: no patched npm release is available as of 2026-10-26. `scripts/patch-build-tools.js` backports the nested DigestAlgorithm element-count check proposed in [upstream PR #1152](https://github.com/digitalbazaar/forge/pull/1152) to pinned version 1.4.0. The postinstall script checks the complete original and patched `lib/rsa.js` SHA-256 hashes and installed/locked versions for every copy. It is idempotent and rejects unfamiliar source or versions. Start, native run, prebuild, and release scripts verify the patch before using the tooling. If lifecycle scripts were disabled, run `node scripts/patch-build-tools.js` explicitly before those commands. The package retains its real upstream name and version, so raw `npm audit` still reports this advisory and inherited Expo entries; use `npm run audit:dependencies` for the source-verified result. Replace the backport with a published fixed release and remove its audit handling when one becomes available.
- **GHSA-mrhx-c7xc-m3w5 (`zod`)**: an override scoped to `@expo/cli` installs patched Zod 4.6.7. Compatibility tests exercise Expo's installed plugin metadata/output schemas, output error handling, and dynamic MCP parameter schema generation/JSON conversion. A regression test verifies that oversized bounded arrays are rejected before visiting elements. This app does not install `expo-mcp`; enabling additional extensions or MCP integration requires checking those packages' own compatibility.

`__tests__/buildTools.test.js` rejects malformed RSA signatures that unpatched 1.4.0 accepted, checks valid signatures with/without optional NULL parameters, and exercises Expo certificate generation, validation, and signing. It also checks that skipped postinstall, altered source, unpatched nested copies, and new advisories cannot pass the audit gate. These controls apply to local tooling; this app has no OTA signing configuration, and Android release signing uses keystore tooling.

## Validation and limits

Regression tests cover cleanup races, partial writes, empty snapshots, failed/interrupted sign-out, legacy migration, Android native persistence, navigation policy, repeated native navigation, reconnect behavior, and recovery limits. `npm run test:prebuild` checks clean and incremental regeneration in an isolated project.

Real-device checks are required for Google sign-in, passkeys/federated accounts, iOS Keychain/WebKit behavior, keyboard insets, and Android WebView storage deletion. JavaScript tests use native mocks and do not establish those platform guarantees. This document describes controls and limits; it is not an independent security certification.
