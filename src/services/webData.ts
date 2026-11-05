import { requireNativeModule } from 'expo';

interface RemoteSessionNativeModule {
  clearWebData(): Promise<void>;
  configureKeepAlive?(
    enabled: boolean,
    durationMinutes: number,
    sessionActive: boolean,
  ): Promise<void>;
  installDocumentStartScript?(script: string): Promise<void>;
}

/** The WebView must be unmounted before clearing its shared persistent profile. */
export async function clearWebData(): Promise<void> {
  await requireNativeModule<RemoteSessionNativeModule>(
    'RemoteSession',
  ).clearWebData();
}

/** Synchronizes bounded background keep-alive settings with the native lifecycle controller. */
export async function configureNativeKeepAlive(
  enabled: boolean,
  durationMinutes: number,
  sessionActive: boolean,
): Promise<void> {
  try {
    const nativeModule =
      requireNativeModule<RemoteSessionNativeModule>('RemoteSession');
    if (typeof nativeModule.configureKeepAlive === 'function') {
      await nativeModule.configureKeepAlive(
        enabled,
        durationMinutes,
        sessionActive,
      );
    }
  } catch {
    // Best-effort native enhancement; never block WebView rendering.
  }
}

/**
 * Installs an origin-scoped document-start user script on the active Android WebView
 * (`WebViewCompat.addDocumentStartJavaScript`) so cross-origin Antigravity workstation
 * iframes (`https://antigravity.static.usercontent.goog`) receive Trusted-Types-safe
 * UI state helpers that `react-native-webview` only injects into main frames on Android.
 */
export async function installNativeDocumentStartScript(
  script: string,
): Promise<void> {
  try {
    const nativeModule =
      requireNativeModule<RemoteSessionNativeModule>('RemoteSession');
    if (typeof nativeModule.installDocumentStartScript === 'function') {
      await nativeModule.installDocumentStartScript(script);
    }
  } catch {
    // Best-effort native enhancement; never block WebView rendering.
  }
}
