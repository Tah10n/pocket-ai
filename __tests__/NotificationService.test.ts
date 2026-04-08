import BackgroundService from 'react-native-background-actions';
import * as Notifications from 'expo-notifications';

import { notificationService } from '../src/services/NotificationService';

describe('NotificationService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await BackgroundService.stop();
  });

  it('sends download completion notifications on the downloads channel', async () => {
    await notificationService.sendCompletionNotification('download', { modelName: 'Test Model' });

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ channelId: 'downloads' }),
      }),
    );
  });

  it('updates the foreground notification only when the background task is running', async () => {
    await notificationService.updateNotification({ type: 'downloadProgress', modelName: 'Test Model', progressPercent: 1 });
    expect(BackgroundService.updateNotification).not.toHaveBeenCalled();

    await BackgroundService.start(async () => undefined, {
      taskName: 'download',
      taskTitle: 'Downloading',
      taskDesc: '...',
      taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    });

    await notificationService.updateNotification({ type: 'downloadProgress', modelName: 'Test Model', progressPercent: 2 });
    expect(BackgroundService.updateNotification).toHaveBeenCalled();
  });
});
