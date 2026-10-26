import { requireNativeModule } from 'expo';

/** The WebView must be unmounted before clearing its shared persistent profile. */
export async function clearWebData(): Promise<void> {
  await requireNativeModule<{ clearWebData(): Promise<void> }>(
    'RemoteSession',
  ).clearWebData();
}
