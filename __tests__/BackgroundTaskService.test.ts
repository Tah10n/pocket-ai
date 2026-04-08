import BackgroundService from 'react-native-background-actions';

import { backgroundTaskService } from '../src/services/BackgroundTaskService';

describe('BackgroundTaskService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await backgroundTaskService.stopBackgroundTask();
  });

  it('does not start the foreground service while the app is active', async () => {
    await backgroundTaskService.startBackgroundDownload();
    expect(backgroundTaskService.taskType).toBe('download');
    expect(BackgroundService.start).not.toHaveBeenCalled();
  });

  it('starts the foreground service when the app backgrounds with active work', async () => {
    await backgroundTaskService.startBackgroundDownload();

    // Simulate AppState change to background.
    await (backgroundTaskService as any).handleAppStateChange('background');

    expect(BackgroundService.start).toHaveBeenCalled();
  });
});

