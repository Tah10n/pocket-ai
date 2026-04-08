import BackgroundService from 'react-native-background-actions';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import { notificationService } from '../src/services/NotificationService';

describe('NotificationService', () => {
  const originalPlatformOS = Platform.OS;

  beforeEach(async () => {
    jest.clearAllMocks();
    (notificationService as any).permissionState = 'unknown';
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.getNotificationChannelsAsync as jest.Mock).mockResolvedValue([]);
    await BackgroundService.stop();
  });

  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
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

  it('refuses to start foreground-service notifications on Android when notifications are denied', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });

    const canStart = await notificationService.canStartForegroundServiceNotifications();

    expect(canStart).toBe(false);
    expect(Notifications.getNotificationChannelsAsync).not.toHaveBeenCalled();
  });

  it('refuses to start foreground-service notifications on Android when RN background-actions channel is blocked', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.getNotificationChannelsAsync as jest.Mock).mockResolvedValue([
      { id: 'RN_BACKGROUND_ACTIONS_CHANNEL', importance: Notifications.AndroidImportance.NONE },
    ]);

    const canStart = await notificationService.canStartForegroundServiceNotifications();

    expect(canStart).toBe(false);
  });
});
