const mockClearWebData = jest.fn(async () => undefined);
const mockConfigureKeepAlive = jest.fn(async () => undefined);
const mockSyncActionNotification = jest.fn(async () => undefined);
const mockClearActionNotification = jest.fn(async () => undefined);
const mockRequestNotificationPermission = jest.fn(async () => true);
jest.mock('expo', () => ({
  requireNativeModule: jest.fn(() => ({
    clearWebData: mockClearWebData,
    configureKeepAlive: mockConfigureKeepAlive,
    syncActionNotification: mockSyncActionNotification,
    clearActionNotification: mockClearActionNotification,
    requestNotificationPermission: mockRequestNotificationPermission,
  })),
}));

import {
  clearNativeActionNotification,
  clearWebData,
  configureNativeKeepAlive,
  requestNativeNotificationPermission,
  syncNativeActionNotification,
} from '../src/services/webData';
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

it('forwards live action notifications and permission requests safely', async () => {
  await syncNativeActionNotification({
    title: '1 action open • workstation-1',
    body: 'Deploy service — Waiting for your approval or input',
    expandedBody: 'Deploy service\nWaiting for your approval or input',
    count: 1,
    deepLinkUrl: 'antigravity-remote://r/workstation-1?p=c%2Fthread-1',
    shouldAlert: true,
  });
  expect(mockSyncActionNotification).toHaveBeenCalledWith(
    '1 action open • workstation-1',
    'Deploy service — Waiting for your approval or input',
    'Deploy service\nWaiting for your approval or input',
    1,
    'antigravity-remote://r/workstation-1?p=c%2Fthread-1',
    true,
  );

  await clearNativeActionNotification();
  expect(mockClearActionNotification).toHaveBeenCalled();

  await expect(requestNativeNotificationPermission()).resolves.toBe(true);
  expect(mockRequestNotificationPermission).toHaveBeenCalled();

  mockSyncActionNotification.mockRejectedValueOnce(new Error('Denied'));
  await expect(
    syncNativeActionNotification({
      title: '2 actions open',
      body: 'Deploy service (+1 more)',
      expandedBody: '• Deploy service',
      count: 2,
      deepLinkUrl: 'antigravity-remote://inbox',
      shouldAlert: false,
    }),
  ).resolves.toBeUndefined();
});
