const mockClearWebData = jest.fn(async () => undefined);
jest.mock('expo', () => ({
  requireNativeModule: jest.fn(() => ({ clearWebData: mockClearWebData })),
}));

import { clearWebData } from '../src/services/webData';
import { requireNativeModule } from 'expo';

it('awaits native website-data cleanup and propagates failure to sign-out', async () => {
  await clearWebData();
  expect(requireNativeModule).toHaveBeenCalledWith('RemoteSession');
  expect(mockClearWebData).toHaveBeenCalled();
  mockClearWebData.mockRejectedValueOnce(new Error('Cleanup failed'));
  await expect(clearWebData()).rejects.toThrow('Cleanup failed');
});
