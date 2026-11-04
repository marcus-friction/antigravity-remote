const mockClearWebData = jest.fn(async () => undefined);
const mockConfigureKeepAlive = jest.fn(async () => undefined);
jest.mock('expo', () => ({
  requireNativeModule: jest.fn(() => ({
    clearWebData: mockClearWebData,
    configureKeepAlive: mockConfigureKeepAlive,
  })),
}));

import { clearWebData, configureNativeKeepAlive } from '../src/services/webData';
import { requireNativeModule } from 'expo';

it('awaits native website-data cleanup and propagates failure to sign-out', async () => {
  await clearWebData();
  expect(requireNativeModule).toHaveBeenCalledWith('RemoteSession');
  expect(mockClearWebData).toHaveBeenCalled();
  mockClearWebData.mockRejectedValueOnce(new Error('Cleanup failed'));
  await expect(clearWebData()).rejects.toThrow('Cleanup failed');
});

it('forwards bounded keep-alive settings to native module and swallows errors safely', async () => {
  await configureNativeKeepAlive(true, 30, true);
  expect(mockConfigureKeepAlive).toHaveBeenCalledWith(true, 30, true);

  mockConfigureKeepAlive.mockRejectedValueOnce(
    new Error('Foreground service restricted'),
  );
  await expect(configureNativeKeepAlive(false, 0, false)).resolves.toBeUndefined();
});
