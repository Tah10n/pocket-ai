import BackgroundService from 'react-native-background-actions';
import { Platform } from 'react-native';

import { backgroundTaskService } from '../src/services/BackgroundTaskService';

describe('BackgroundTaskService', () => {
  const originalPlatform = Platform.OS;

  beforeEach(async () => {
    await backgroundTaskService.stopBackgroundTask();
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    (backgroundTaskService as any).appState = 'active';
  });

  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('returns a successful Android foreground-service start outcome', async () => {
    const Notifications = require('expo-notifications');

    await expect(backgroundTaskService.startBackgroundDownload()).resolves.toEqual({
      status: 'started',
      serviceRunning: true,
      degraded: false,
      required: false,
      requirementSatisfied: true,
    });

    expect(backgroundTaskService.taskType).toBe('download');
    expect(BackgroundService.start).toHaveBeenCalledTimes(1);
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.getNotificationChannelsAsync).not.toHaveBeenCalled();
  });

  it('returns already_running without starting a second native service', async () => {
    await backgroundTaskService.startBackgroundInference('Model');

    await expect(backgroundTaskService.startBackgroundInference('Model')).resolves.toEqual({
      status: 'already_running',
      serviceRunning: true,
      degraded: false,
      required: false,
      requirementSatisfied: true,
    });

    expect(BackgroundService.start).toHaveBeenCalledTimes(1);
  });

  it('preserves a privacy-safe native rejection outcome while production work stays tracked', async () => {
    const nativeError = Object.assign(new Error('ForegroundServiceStartNotAllowedException'), {
      name: 'ForegroundServiceStartNotAllowedException',
    });
    (BackgroundService.start as jest.Mock).mockRejectedValueOnce(nativeError);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(backgroundTaskService.startBackgroundInference('Model', {
      requireServiceStart: true,
    })).resolves.toEqual({
      status: 'start_failed',
      serviceRunning: false,
      degraded: true,
      required: true,
      requirementSatisfied: false,
      failureCategory: 'foreground_service_start_not_allowed',
    });

    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[BackgroundTaskService] Failed to start background task',
      nativeError,
    );
    warnSpy.mockRestore();
  });

  it('returns skipped_android_background instead of attempting a forbidden background start', async () => {
    (backgroundTaskService as any).appState = 'background';

    await expect(backgroundTaskService.startBackgroundDownload(undefined, {
      requireServiceStart: true,
    })).resolves.toEqual({
      status: 'skipped_android_background',
      serviceRunning: false,
      degraded: true,
      required: true,
      requirementSatisfied: false,
    });

    expect(BackgroundService.start).not.toHaveBeenCalled();
    expect(backgroundTaskService.isTaskActive('download')).toBe(true);
  });

  it('returns skipped_ios_foreground while foreground iOS work remains tracked', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });

    await expect(backgroundTaskService.startBackgroundInference('Model')).resolves.toEqual({
      status: 'skipped_ios_foreground',
      serviceRunning: false,
      degraded: true,
      required: false,
      requirementSatisfied: false,
    });

    expect(BackgroundService.start).not.toHaveBeenCalled();
    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);
  });

  it('stops the native service when the final tracked task stops', async () => {
    await backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' });

    await backgroundTaskService.stopBackgroundTask('download');

    expect(BackgroundService.stop).toHaveBeenCalledTimes(1);
    expect(backgroundTaskService.isTaskActive('download')).toBe(false);
    expect(backgroundTaskService.isActive).toBe(false);
  });

  it('shares one native start across concurrent download and inference work', async () => {
    let releaseNativeStart!: () => void;
    const nativeStartGate = new Promise<void>((resolve) => {
      releaseNativeStart = resolve;
    });
    (BackgroundService.start as jest.Mock).mockImplementationOnce(async () => {
      await nativeStartGate;
    });

    const inferenceStart = backgroundTaskService.startBackgroundInference('Test Model');
    const downloadStart = backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' });
    releaseNativeStart();

    await expect(Promise.all([inferenceStart, downloadStart])).resolves.toEqual([
      {
        status: 'started',
        serviceRunning: true,
        degraded: false,
        required: false,
        requirementSatisfied: true,
      },
      {
        status: 'started',
        serviceRunning: true,
        degraded: false,
        required: false,
        requirementSatisfied: true,
      },
    ]);
    expect(BackgroundService.start).toHaveBeenCalledTimes(1);
    expect(backgroundTaskService.isTaskActive('download')).toBe(true);
    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);
  });
});
