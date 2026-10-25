# Security Architecture & Audit Report (`v1.0.4`)

## Security Architecture

- **Strict In-WebView Origin Allow-Listing**: [`validateNavigationUrl`](src/utils/urlValidator.ts) enforces `https:` and restricts in-WebView navigation to `antigravity.google.com`, `accounts.google.com`, first-party Google authentication assets, and regional Google cookie-sync endpoints (`/accounts/`, `/CheckCookie`, `/SetSID`, `/signin/`). All external links open in the OS browser.
- **Hardware-Backed Session Vault**: [`sessionVault.ts`](src/services/sessionVault.ts) encrypts backed-up session state in `expo-secure-store` (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) using Android Keystore / iOS Keychain, while preventing `CookieManager.set()` from synthesizing `Domain` attributes onto `__Host-` or domain-less `.google.com` cookies.
- **Disabled OS Backup & Cleartext Traffic**: [`AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml) enforces `android:allowBackup="false"`, `android:fullBackupContent="false"`, and `android:usesCleartextTraffic="false"` so the Chromium WebView SQLite cookie database (`app_webview/Default/Cookies`) is never exported via Android Auto Backup or `adb backup`.
- **Fail-Closed Release Signing & R8 Shrinking**: [`android/app/build.gradle`](android/app/build.gradle) requires `signingConfigs.release` for release builds and enables R8 minification (`enableMinifyInReleaseBuilds=true`) and resource shrinking (`enableShrinkResourcesInReleaseBuilds=true`).

---

## SecureCoder Security Audit (`v1.0.4`)

- **Status**: Completed
- **Scanned Files**: 14
- **Vulnerabilities Found**: 6
- **Vulnerabilities Fixed**: 5

### Vulnerability Report

| Vulnerability ID | File | Line | Description | Severity | Status | Remediation |
|---|---|---|---|---|---|---|
| `CS-BACKUP-001` | [`AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml) | 14 | Insecure Backup & Cleartext Configuration (`CWE-530` / `CWE-312`). `android:allowBackup="true"` allowed Android Auto Backup and `adb backup` to extract the unencrypted Chromium WebView SQLite cookie database (`app_webview/Default/Cookies`) containing live `.google.com` and `antigravity.google.com` session cookies. | High | Fixed | Set `android:allowBackup="false"`, `android:fullBackupContent="false"`, and `android:usesCleartextTraffic="false"` in [`AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml). |
| `CS-SESSION-001` | [`src/services/sessionVault.ts`](src/services/sessionVault.ts) | 39 | Cookie Prefix & Domain Scope Corruption (`CWE-565`). Re-injecting Android `CookieManager.get()` cookies via `CookieManager.set()` synthesized explicit `; Domain=` attributes onto `__Host-GAPS` (violating RFC 6265bis `__Host-` prefix rules) and shadowed parent `.google.com` session cookies with host-specific duplicates. | High | Fixed | Added `isSafeToReinjectCookie` to block re-injection of `__Host-` and domain-less cookies, switched Android persistence to native SQLite `CookieManager.flush()`, and added `migrateCorruptedV1CookiesIfNeeded`. |
| `CS-PRIV-001` | [`AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml) | 4 | Over-Privileged Android Manifest Permissions (`CWE-250`). Requested unused `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, and `VIBRATE` permissions. | Medium | Fixed | Stripped permissions via `tools:node="remove"` in [`AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml) and `android.blockedPermissions` in [`app.json`](app.json). |
| `CS-CRYPTO-001` | [`android/app/build.gradle`](android/app/build.gradle) | 136 | Weak Release Signing Fallback & Disabled Code Shrinking (`CWE-321` / `CWE-693`). The `release` buildType fell back to `signingConfigs.debug` when `keystore.properties` was absent and left R8 code shrinking disabled. | Medium | Fixed | Required `signingConfigs.release` directly in [`android/app/build.gradle`](android/app/build.gradle), enabled R8 minification and resource shrinking in [`android/gradle.properties`](android/gradle.properties), and added keep rules in [`android/app/proguard-rules.pro`](android/app/proguard-rules.pro). |
| `CS-REDIRECT-001` | [`src/utils/urlValidator.ts`](src/utils/urlValidator.ts) | 43 | Overly Broad In-WebView Origin Allow-Listing (`CWE-601`). Suffix allow-listing of `.googleusercontent.com`, `.youtube.com`, and full regional Google ccTLDs (`www.google.de`, etc.) allowed an authenticated WebView to remain inside non-auth origins. | Medium | Fixed | Pinned exact hosts `lh3.googleusercontent.com` and `accounts.youtube.com` in [`src/constants/config.ts`](src/constants/config.ts) and restricted regional Google ccTLDs via `isAllowedRegionalGoogleUrl` to `/accounts/`, `/CheckCookie`, `/SetSID`, and `/signin/` paths. |
| `CS-DEPS-001` | [`package.json`](package.json) | 19 | Transitive CLI Build-Tool Advisories (`@xmldom/xmldom`, `tar`, `postcss`, `node-forge`, `uuid`) pulled in by `@expo/cli` during local Metro bundling. | Low | False Positive | Build-time Node.js CLI dependencies are excluded from the compiled React Native runtime bundle (`index.android.bundle`). |

### Suppressed Findings

| Finding | File | Reason | Suppressed At |
|---|---|---|---|
| Transitive `@expo/cli` Build-Tool Advisories (`CS-DEPS-001`) | [`package.json`](package.json) | False Positive — build-time Node.js CLI dependencies (`@xmldom/xmldom`, `tar`, `postcss`) are not bundled into the mobile runtime binary | 2026-10-25 |
