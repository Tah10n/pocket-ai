import BackgroundService from 'react-native-background-actions';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: {
    t: jest.fn((key: string, options?: any) => {
      if (key === 'notifications.download.progress.body') {
        return `progress:${options?.progress ?? ''}|speed:${options?.speed ?? ''}`;
      }
      if (key === 'notifications.download.error.body') {
        return `model:${options?.modelName ?? ''}|reason:${options?.errorReason ?? ''}`;
      }
      if (key === 'notifications.inference.progress.body') {
        return `model:${options?.modelName ?? ''}`;
      }
      return key;
    }),
  },
}));

import i18n from '../src/i18n';

function getFreshNotificationService() {
  let service: any;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require('../src/services/NotificationService').notificationService;
  });
  return service;
}

describe('NotificationService', () => {
  const originalPlatformOS = Platform.OS;
  let notificationService: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    notificationService = getFreshNotificationService();
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

  it('sendLocalNotification returns null when permission is undetermined', async () => {
    (notificationService as any).permissionState = 'unknown';
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'undetermined' });

    const result = await notificationService.sendLocalNotification({ title: 'x' });
    expect(result).toBeNull();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('sendLocalNotification schedules when permission is granted and respects channelId', async () => {
    (notificationService as any).permissionState = 'granted';

    const idA = await notificationService.sendLocalNotification({ title: 'x' });
    expect(idA).toBe('mock-notification-id');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 'x' },
      trigger: null,
    });

    const idB = await notificationService.sendLocalNotification({ title: 'y' }, { channelId: 'downloads' });
    expect(idB).toBe('mock-notification-id');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 'y' },
      trigger: { channelId: 'downloads' },
    });
  });

  it('updateNotification clamps progress percent and formats speed', async () => {
    await BackgroundService.start(async () => undefined, {
      taskName: 'download',
      taskTitle: 'Downloading',
      taskDesc: '...',
      taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    });

    await notificationService.updateNotification({
      type: 'downloadProgress',
      modelName: 'Test Model',
      progressPercent: Number.NaN,
      speedBytesPerSec: 0,
    });

    expect(BackgroundService.updateNotification).toHaveBeenCalledWith(expect.objectContaining({
      progressBar: { max: 100, value: 0, indeterminate: false },
      linkingURI: 'pocketai:///(tabs)/models',
    }));

    expect((i18n as any).t).toHaveBeenCalledWith('notifications.download.progress.body', expect.objectContaining({
      progress: 0,
      speed: '—',
    }));

    await notificationService.updateNotification({
      type: 'downloadProgress',
      modelName: 'Test Model',
      progressPercent: 99.6,
      speedBytesPerSec: 10 * 1024 * 1024,
    });

    expect((i18n as any).t).toHaveBeenCalledWith('notifications.download.progress.body', expect.objectContaining({
      progress: 100,
      speed: '10 MB',
    }));
  });

  it('sendErrorNotification maps reasons to translated errorReason strings', async () => {
    (notificationService as any).permissionState = 'granted';

    await notificationService.sendErrorNotification({ modelName: 'M', reason: 'storageFull' });
    expect((i18n as any).t).toHaveBeenCalledWith('notifications.error.storageFull');

    await notificationService.sendErrorNotification({ modelName: 'M', reason: 'connectionLost' });
    expect((i18n as any).t).toHaveBeenCalledWith('notifications.error.connectionLost');

    await notificationService.sendErrorNotification({ modelName: 'M', reason: 'verificationFailed' });
    expect((i18n as any).t).toHaveBeenCalledWith('notifications.error.verificationFailed');

    await notificationService.sendErrorNotification({ modelName: 'M' });
    expect((i18n as any).t).toHaveBeenCalledWith('common.actionFailed');
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
