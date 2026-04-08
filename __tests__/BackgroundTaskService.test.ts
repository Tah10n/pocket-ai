import BackgroundService from 'react-native-background-actions';
import { Platform } from 'react-native';

import { backgroundTaskService } from '../src/services/BackgroundTaskService';

describe('BackgroundTaskService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await backgroundTaskService.stopBackgroundTask();
  });

  it('does not start the foreground service while the app is active', async () => {
    await backgroundTaskService.startBackgroundDownload();
    expect(backgroundTaskService.taskType).toBe('download');
    if (Platform.OS === 'android') {
      expect(BackgroundService.start).toHaveBeenCalled();
    } else {
      expect(BackgroundService.start).not.toHaveBeenCalled();
    }
  });

  it('starts the foreground service when the app backgrounds with active work', async () => {
    await backgroundTaskService.startBackgroundDownload();

    // Simulate AppState change to background.
    await (backgroundTaskService as any).handleAppStateChange('background');

    expect(BackgroundService.start).toHaveBeenCalled();
  });

  it('reapplies inference notification details when work backgrounds after starting in the foreground', async () => {
    await backgroundTaskService.startBackgroundInference('Test Model');

    await (backgroundTaskService as any).handleAppStateChange('background');

    expect(BackgroundService.updateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        linkingURI: 'pocketai:///(tabs)/chat',
      }),
    );
  });

  it('fires expiration listeners while inference is active even if a download task is also active', async () => {
    const listener = jest.fn();
    const unsubscribe = backgroundTaskService.subscribeToExpiration(listener);

    try {
      await backgroundTaskService.startBackgroundInference('Test Model');
      await backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' });

      (backgroundTaskService as any).handleExpiration();

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('stops only inference work when asked, keeping downloads active', async () => {
    await backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' });
    await backgroundTaskService.startBackgroundInference('Test Model');

    await backgroundTaskService.stopBackgroundTask('inference');

    expect(backgroundTaskService.isTaskActive('download')).toBe(true);
    expect(backgroundTaskService.isTaskActive('inference')).toBe(false);
  });

  it('stops only download work when asked, keeping inference active', async () => {
    await backgroundTaskService.startBackgroundInference('Test Model');
    await backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' });

    await backgroundTaskService.stopBackgroundTask('download');

    expect(backgroundTaskService.isTaskActive('download')).toBe(false);
    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);
  });
});
