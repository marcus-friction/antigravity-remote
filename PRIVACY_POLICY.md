# Privacy Policy for Antigravity Remote

**Effective Date**: October 26, 2026  
**Application Name**: Antigravity Remote (`com.frictionventures.antigravityremote` / `com.frictionventures.antigravity-remote`)  
**Developer / Publisher**: Friction Ventures  
**Contact Email**: [antigravity-remote@frictionventures.com](mailto:antigravity-remote@frictionventures.com)

---

## 1. Overview & Independent Publisher Disclosure

**Antigravity Remote** is an open-source mobile companion wrapper developed by **Friction Ventures** for accessing `https://antigravity.google.com` on Android and iOS devices. Antigravity Remote is an independent client application and is not affiliated with, sponsored by, or endorsed by Google LLC.

## 2. Information Collection and Use (Zero Off-Device Collection)

**Friction Ventures does not collect, transmit, store, share, or sell any personal data, authentication credentials, browsing history, or device telemetry.**

- **No Developer Backend**: The application operates no backend servers or external APIs controlled by Friction Ventures.
- **No Analytics or Advertising SDKs**: The application contains no third-party analytics, crash-reporting, tracking, or advertising SDKs, and does not access the Android Advertising ID (`AD_ID`).
- **Direct HTTPS Communication**: All network requests occur directly over encrypted HTTPS (`TLS 1.2+` / `TLS 1.3`) between your device's system WebView (`Android System WebView` / iOS `WKWebView`) and Google's servers (`antigravity.google.com`, `accounts.google.com`, and regional Google authentication endpoints). Your interaction with Google services is governed by the [Google Privacy Policy](https://policies.google.com/privacy).

## 3. On-Device Session & Cookie Storage

To keep you signed in across app restarts and support `/remote-control` session handoff links:

- **Android**: Session cookies are stored locally on your device inside the application's private Android System WebView database (`app_webview`). Cloud backup (`android:allowBackup="false"`) and device-to-device transfer are explicitly disabled in the Android manifest and data extraction rules.
- **iOS**: Eligible session cookies and the last visited `antigravity.google.com` session URL are stored locally on your device inside the iOS Keychain using `expo-secure-store` (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), which is excluded from iCloud backups.

## 4. Data Deletion & User Control

You have full control over all locally stored session data at any time:

1. **In-App Sign Out**: Tap the floating **Remote** button in the bottom-right corner, select **Sign Out of Google Account**, and tap **Confirm Sign Out**. This immediately unmounts the WebView and deletes all saved cookies, DOM storage, WebView cache, and Keychain/SecureStore snapshots from your device.
2. **Operating System Settings**: Clearing storage or uninstalling **Antigravity Remote** through your Android or iOS system settings permanently deletes all local application data from your device.

## 5. Permissions

Antigravity Remote requests only standard network access (`android.permission.INTERNET`) required to load `https://antigravity.google.com`. It does not request access to your camera, microphone, contacts, location, photos, or external storage.

## 6. Changes to This Privacy Policy

If we update this Privacy Policy, we will post the updated version at `https://marcus-friction.github.io/antigravity-remote/privacy-policy.html` and in the public source repository at `https://github.com/marcus-friction/antigravity-remote` with an updated Effective Date.

## 7. Contact Us

If you have any questions about this Privacy Policy or the security practices of Antigravity Remote, contact us at:  
**Email**: [antigravity-remote@frictionventures.com](mailto:antigravity-remote@frictionventures.com)
