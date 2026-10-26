# Google Play Console — Production Release Checklist & Copy-Paste Guide

Use the answers below to complete the mandatory **Monitor and improve → Policy and programs → App content** declarations and **Grow users → Store presence → Main store listing** in Google Play Console before promoting **Antigravity Remote (`1.0.6 (7)`)** to **Production**.

---

## 1. Main Store Listing (`Grow users → Store presence → Main store listing`)

| Field | Value |
|---|---|
| **App name** (<= 30 chars) | `Antigravity Remote` |
| **Short description** (<= 80 chars) | `Mobile companion wrapper for Antigravity Remote with CLI handoff & session sync.` |
| **Full description** (<= 4000 chars) | Copy from [`android/app/src/main/play/listings/en-US/full-description.txt`](../android/app/src/main/play/listings/en-US/full-description.txt) |
| **App icon** (`512 x 512 px`) | Upload [`store-assets/play-icon-512.png`](./play-icon-512.png) |
| **Feature graphic** (`1024 x 500 px`) | Upload [`store-assets/feature-graphic-1024x500.png`](./feature-graphic-1024x500.png) |
| **Phone screenshots** (`1080 x 1920 px`) | Upload [`phone-1.png`](./screenshots/phone-1.png), [`phone-2.png`](./screenshots/phone-2.png), [`phone-3.png`](./screenshots/phone-3.png), [`phone-4.png`](./screenshots/phone-4.png) |
| **7-inch & 10-inch tablet screenshots** (`1200 x 1920 px`) | Upload [`tablet-1.png`](./screenshots/tablet-1.png), [`tablet-2.png`](./screenshots/tablet-2.png) |

### Store Settings (`Grow users → Store presence → Store settings`)
- **App or game**: `App`
- **Category**: `Tools` (or `Productivity`)
- **Contact email**: `antigravity-remote@frictionventures.com`
- **Website**: `https://marcus-friction.github.io/antigravity-remote/`

---

## 2. App Content Declarations (`Policy and programs → App content`)

### A. Privacy Policy
- **Privacy policy URL**: `https://marcus-friction.github.io/antigravity-remote/privacy-policy.html`

### B. App Access (Login Instructions for Google Play Reviewers)
Select **"All or some functionality in my app is restricted"** → **"Add instructions"**:
- **Instruction name**: `Google Sign-In & Native Remote Controls`
- **Username / password**: *(Leave blank or check "No username or password required for native controls; uses user's own Google Account for workspace")*
- **Any other information required to access your app (Copy-Paste)**:
  ```text
  Antigravity Remote is an open-source mobile companion client wrapper for https://antigravity.google.com.
  1. On launch, the app loads the public https://antigravity.google.com landing page and Google Sign-In flow (https://accounts.google.com).
  2. Reviewers can test all native wrapper features without a dedicated test account by tapping the floating "Remote" button in the bottom-right corner to open the native Remote Controls sheet:
     - View live Session Vault status
     - Test CLI handoff input validation (e.g., entering "devbox-demo-1" or "https://antigravity.google.com/r/devbox-demo-1")
     - Test "Reload & Sync Session Cookies"
     - Test "Sign Out of Google Account" -> "Confirm Sign Out" (which unmounts the WebView and wipes local cookies/cache)
     - Open the in-app Privacy Policy and Open Source (MIT) links
  3. Signing into an active Antigravity workspace uses standard Google Account authentication on accounts.google.com.
  ```

### C. Ads
- **Does your app contain ads?**: `No, my app does not contain ads`

### D. Content Rating (IARC Questionnaire)
- **Email address**: `antigravity-remote@frictionventures.com`
- **Category**: `Utility, Productivity, Communication, or Other`
- **Violence / Sexuality / Profanity / Controlled Substances**: `No` to all
- **User-generated content / user-to-user sharing / location sharing**: `No` to all
- **Digital purchases**: `No`

### E. Target Audience and Content
- **Target age group**: Select **`18 and over`** only (never select under-13 age groups, which trigger Families Policy restrictions).
- **Appeal to children**: `No`

### F. Data Safety
- **Does your app collect or share any of the required user data types?**: **`No`**
  - *Rationale*: Antigravity Remote operates no developer backend servers, analytics SDKs, crash-reporting services, or advertising trackers. All session cookies and last-visited URLs remain strictly on the user's device (`app_webview` with Android Auto Backup and device transfer disabled).

### G. Advertising ID
- **Does your app use advertising ID?**: **`No`** (verified absent from merged `AndroidManifest.xml`).

### H. Government Apps / Financial Features / Health Apps
- **Government app**: `No`
- **Financial features**: `My app doesn't provide any financial features`
- **Health features**: `My app does not have any health features`
