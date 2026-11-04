import { requireNativeModule } from 'expo';

interface RemoteSessionNativeModule {
  clearWebData(): Promise<void>;
  configureKeepAlive?(
    enabled: boolean,
    durationMinutes: number,
    sessionActive: boolean,
  ): Promise<void>;
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
