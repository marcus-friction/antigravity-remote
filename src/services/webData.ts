import { requireNativeModule } from 'expo';

export interface NativeActionNotificationPayload {
  title: string;
  body: string;
  expandedBody: string;
  count: number;
  deepLinkUrl: string;
  shouldAlert: boolean;
}

interface RemoteSessionNativeModule {
  clearWebData(): Promise<void>;
  configureKeepAlive?(
    enabled: boolean,
    durationMinutes: number,
    sessionActive: boolean,
  ): Promise<void>;
  syncActionNotification?(
    title: string,
    body: string,
    expandedBody: string,
    count: number,
    deepLinkUrl: string,
    shouldAlert: boolean,
  ): Promise<void>;
  clearActionNotification?(): Promise<void>;
  requestNotificationPermission?(): Promise<boolean>;
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

/** Posts or updates the single OS action-required notification in place. */
export async function syncNativeActionNotification(
  payload: NativeActionNotificationPayload,
): Promise<void> {
  try {
    const nativeModule =
      requireNativeModule<RemoteSessionNativeModule>('RemoteSession');
    if (typeof nativeModule.syncActionNotification === 'function') {
      await nativeModule.syncActionNotification(
        payload.title,
        payload.body,
        payload.expandedBody,
        payload.count,
        payload.deepLinkUrl,
        payload.shouldAlert,
      );
    }
  } catch {
    // Best-effort native notification; never disrupt workspace session.
  }
}

/** Dismisses any active action-required notification from the OS status bar. */
export async function clearNativeActionNotification(): Promise<void> {
  try {
    const nativeModule =
      requireNativeModule<RemoteSessionNativeModule>('RemoteSession');
    if (typeof nativeModule.clearActionNotification === 'function') {
      await nativeModule.clearActionNotification();
    }
  } catch {
    // Ignore if unsupported or already dismissed.
  }
}

/** Requests OS notification authorization where handled by the native module (iOS). */
export async function requestNativeNotificationPermission(): Promise<boolean> {
  try {
    const nativeModule =
      requireNativeModule<RemoteSessionNativeModule>('RemoteSession');
    if (typeof nativeModule.requestNotificationPermission === 'function') {
      return Boolean(await nativeModule.requestNotificationPermission());
    }
  } catch {
    // Ignore permission errors on unsupported environments.
  }
  return false;
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
