import BackgroundService from 'react-native-background-actions';
import { Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

jest.mock('../../src/i18n', () => ({
  t: (key: string, _options?: any) => key,
}));

const mockSetActiveThread = jest.fn();
jest.mock('../../src/store/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      setActiveThread: mockSetActiveThread,
    }),
  },
}));

// Import after mocks so NotificationService picks them up.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { notificationService } = require('../../src/services/NotificationService') as {
  notificationService: any;
};

describe('NotificationService (behavior)', () => {
  const originalPlatformOS = Platform.OS;

  beforeEach(async () => {
    jest.clearAllMocks();
    (notificationService as any).initialized = false;
    (notificationService as any).permissionState = 'unknown';
    (notificationService as any).hasHandledInitialResponse = false;
    (notificationService as any).responseSubscription = undefined;
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.getNotificationChannelsAsync as jest.Mock).mockResolvedValue([]);
    (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(null);
    await BackgroundService.stop();
  });

  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
  });

  it('navigates to models on download notification tap', async () => {
    await notificationService.initialize();

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener({
      notification: {
        request: {
          content: {
            data: { taskType: 'download' },
          },
        },
      },
    });

    expect(router.push).toHaveBeenCalledWith('/(tabs)/models');
  });

  it('navigates to chat and activates thread on inference notification tap', async () => {
    await notificationService.initialize();

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener({
      notification: {
        request: {
          content: {
            data: { taskType: 'inference', threadId: 'thread-1' },
          },
        },
      },
    });

    expect(mockSetActiveThread).toHaveBeenCalledWith('thread-1');
    expect(router.push).toHaveBeenCalledWith('/(tabs)/chat');
  });

  it('requests permissions only when needed', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'granted' });
    await expect(notificationService.requestPermissions()).resolves.toBe(true);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied' });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied' });
    await expect(notificationService.requestPermissions()).resolves.toBe(false);
  });

  it('sendLocalNotification returns null when permissions are denied', async () => {
    (notificationService as any).permissionState = 'denied';
    await expect(notificationService.sendLocalNotification({ title: 'x' })).resolves.toBeNull();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('canStartForegroundServiceNotifications refuses on Android when permission lookup fails', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error('no perms'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const canStart = await notificationService.canStartForegroundServiceNotifications();

    expect(canStart).toBe(false);
    warnSpy.mockRestore();
  });

  it('updateNotification populates progress bars for download/inference', async () => {
    await BackgroundService.start(async () => undefined, {
      taskName: 'download',
      taskTitle: 'Downloading',
      taskDesc: '...',
      taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    });

    await notificationService.updateNotification({
      type: 'downloadProgress',
      modelName: 'Test Model',
      progressPercent: 101.4,
      speedBytesPerSec: 10 * 1024 * 1024,
    });
    expect(BackgroundService.updateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        linkingURI: 'pocketai:///(tabs)/models',
        progressBar: { max: 100, value: 100, indeterminate: false },
      }),
    );

    await notificationService.updateNotification({ type: 'downloadPaused' });
    expect(BackgroundService.updateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        linkingURI: 'pocketai:///(tabs)/models',
        progressBar: { max: 100, value: 0, indeterminate: true },
      }),
    );

    await notificationService.updateNotification({ type: 'inferenceProgress', modelName: 'Test Model' });
    expect(BackgroundService.updateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        linkingURI: 'pocketai:///(tabs)/chat',
        progressBar: { max: 100, value: 0, indeterminate: true },
      }),
    );
  });

  it('openSystemSettings swallows linking failures', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Linking, 'openSettings').mockRejectedValueOnce(new Error('nope'));

    await notificationService.openSystemSettings();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
