import BackgroundService from 'react-native-background-actions';
import { Alert, Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createNotificationResponse({
  identifier = 'notification-1',
  actionIdentifier = 'expo.modules.notifications.actions.DEFAULT',
  date = 1,
  data = {},
}: {
  identifier?: string;
  actionIdentifier?: string;
  date?: number;
  data?: Record<string, unknown>;
} = {}): Notifications.NotificationResponse {
  return {
    actionIdentifier,
    notification: {
      date,
      request: {
        identifier,
        content: {
          title: null,
          subtitle: null,
          body: null,
          data,
          categoryIdentifier: null,
          sound: null,
        },
        trigger: null,
      },
    },
  };
}

jest.mock('../../src/i18n', () => ({
  t: (key: string, _options?: any) => key,
}));

const mockSetActiveThread = jest.fn();
let mockActiveThreadId: string | null;
let mockThreads: Record<string, { id: string }>;
jest.mock('../../src/store/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      activeThreadId: mockActiveThreadId,
      threads: mockThreads,
      setActiveThread: mockSetActiveThread,
    }),
  },
}));

// Import after mocks so NotificationService picks them up.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { notificationService } = require('../../src/services/NotificationService') as {
  notificationService: any;
};

async function flushNotificationResponsePipeline(): Promise<void> {
  await (notificationService as any).responseProcessingTail;
  await Promise.resolve();
}

describe('NotificationService (behavior)', () => {
  const originalPlatformOS = Platform.OS;

  beforeEach(async () => {
    notificationService.dispose();
    await flushNotificationResponsePipeline();
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
    (notificationService as any).initialized = false;
    (notificationService as any).initializationPromise = null;
    (notificationService as any).permissionState = 'unknown';
    (notificationService as any).responseSubscription = undefined;
    (notificationService as any).inFlightResponseOperations.clear();
    (notificationService as any).recentlyProcessedResponses.clear();
    mockThreads = {
      'thread-1': { id: 'thread-1' },
      'thread-current': { id: 'thread-current' },
    };
    mockActiveThreadId = 'thread-current';
    mockSetActiveThread.mockImplementation((threadId: string | null) => {
      if (threadId !== null && !mockThreads[threadId]) {
        return false;
      }
      mockActiveThreadId = threadId;
      return true;
    });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.getNotificationChannelsAsync as jest.Mock).mockResolvedValue([]);
    (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(null);
    (Notifications.setNotificationHandler as jest.Mock).mockImplementation(() => undefined);
    (Notifications.setNotificationChannelAsync as jest.Mock).mockResolvedValue(null);
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementation(
      () => ({ remove: jest.fn() }),
    );
    performanceMonitor.clear();
    performanceMonitor.setEnabled(false);
    await BackgroundService.stop();
  });

  afterAll(() => {
    notificationService.dispose();
    performanceMonitor.setEnabled(false);
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
  });

  it('single-flights concurrent initialize and permission requests through one listener', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const firstChannel = createDeferred<null>();
    const subscription = { remove: jest.fn() };
    (Notifications.setNotificationChannelAsync as jest.Mock)
      .mockImplementationOnce(() => firstChannel.promise)
      .mockResolvedValue(null);
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockReturnValue(subscription);

    const initializePromise = notificationService.initialize();
    const permissionPromise = notificationService.requestPermissions();

    expect((notificationService as any).initializationPromise).toBe(initializePromise);
    await Promise.resolve();
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();

    firstChannel.resolve(null);
    await expect(Promise.all([initializePromise, permissionPromise])).resolves.toEqual([
      undefined,
      true,
    ]);

    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledTimes(2);
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(Notifications.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
    expect((notificationService as any).responseSubscription).toBe(subscription);
    expect((notificationService as any).initializationPromise).toBeNull();
  });

  it('single-flights three public initialization paths', async () => {
    const results = await Promise.all([
      notificationService.initialize(),
      notificationService.canStartForegroundServiceNotifications(),
      notificationService.sendLocalNotification({ title: 'ready' }),
    ]);

    expect(results).toEqual([undefined, true, 'mock-notification-id']);
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
  });

  it('does not register another listener after successful initialization', async () => {
    await notificationService.initialize();
    await notificationService.initialize();
    await notificationService.requestPermissions();

    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(Notifications.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
  });

  it('cleans state after a pre-listener failure and supports a clean retry', async () => {
    const setupError = new Error('handler setup failed');
    (Notifications.setNotificationHandler as jest.Mock).mockImplementationOnce(() => {
      throw setupError;
    });

    await expect(notificationService.initialize()).rejects.toBe(setupError);

    expect((notificationService as any).initialized).toBe(false);
    expect((notificationService as any).initializationPromise).toBeNull();
    expect((notificationService as any).responseSubscription).toBeUndefined();
    expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();

    await expect(notificationService.initialize()).resolves.toBeUndefined();
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
  });

  it('removes a partially registered listener before retrying initialization', async () => {
    const firstSubscription = { remove: jest.fn() };
    const retrySubscription = { remove: jest.fn() };
    (Notifications.addNotificationResponseReceivedListener as jest.Mock)
      .mockReturnValueOnce(firstSubscription)
      .mockReturnValueOnce(retrySubscription);
    (Notifications.getLastNotificationResponseAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('initial response unavailable'))
      .mockResolvedValueOnce(null);

    await expect(notificationService.initialize()).rejects.toThrow('initial response unavailable');

    expect(firstSubscription.remove).toHaveBeenCalledTimes(1);
    expect((notificationService as any).responseSubscription).toBeUndefined();
    expect((notificationService as any).initialized).toBe(false);

    await expect(notificationService.initialize()).resolves.toBeUndefined();
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(2);
    expect((notificationService as any).responseSubscription).toBe(retrySubscription);
    expect(retrySubscription.remove).not.toHaveBeenCalled();
  });

  it('does not leave an active subscription when disposed during initialization', async () => {
    const initialResponse = createDeferred<null>();
    const inFlightSubscription = { remove: jest.fn() };
    const retrySubscription = { remove: jest.fn() };
    (Notifications.getLastNotificationResponseAsync as jest.Mock)
      .mockImplementationOnce(() => initialResponse.promise)
      .mockResolvedValueOnce(null);
    (Notifications.addNotificationResponseReceivedListener as jest.Mock)
      .mockReturnValueOnce(inFlightSubscription)
      .mockReturnValueOnce(retrySubscription);

    const initialization = notificationService.initialize();
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);

    notificationService.dispose();
    initialResponse.resolve(null);
    await expect(initialization).rejects.toThrow('disposed');

    expect(inFlightSubscription.remove).toHaveBeenCalledTimes(1);
    expect((notificationService as any).initialized).toBe(false);
    expect((notificationService as any).responseSubscription).toBeUndefined();

    await expect(notificationService.initialize()).resolves.toBeUndefined();
    expect((notificationService as any).responseSubscription).toBe(retrySubscription);
    expect(retrySubscription.remove).not.toHaveBeenCalled();
  });

  it('emits privacy-safe initialization outcome and failure category telemetry', async () => {
    const privateFailure = new Error('failed for private notification content');
    (Notifications.setNotificationHandler as jest.Mock).mockImplementationOnce(() => {
      throw privateFailure;
    });
    performanceMonitor.setEnabled(true);

    await expect(notificationService.initialize()).rejects.toBe(privateFailure);

    const initializationEvents = performanceMonitor.snapshot().events.filter(
      (event) => event.name === 'notification.initialization',
    );
    expect(initializationEvents).toEqual([
      expect.objectContaining({
        meta: {
          notificationInitializationOutcome: 'failure',
          notificationInitializationFailureCategory: 'handler_setup_failed',
        },
      }),
    ]);
    expect(JSON.stringify(initializationEvents)).not.toContain('private notification content');
  });

  it('single-flights the same initial and live inference response', async () => {
    const response = createNotificationResponse({
      identifier: 'pocket-ai:inference:thread-1',
      date: 100,
      data: { taskType: 'inference', threadId: 'thread-1' },
    });
    const initialResponse = createDeferred<Notifications.NotificationResponse>();
    (Notifications.getLastNotificationResponseAsync as jest.Mock)
      .mockImplementationOnce(() => initialResponse.promise)
      .mockResolvedValueOnce(response);

    const initialization = notificationService.initialize();
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
    const listener = (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mock.calls[0][0];

    listener(response);
    initialResponse.resolve(response);
    await initialization;
    await flushNotificationResponsePipeline();

    expect(mockSetActiveThread).toHaveBeenCalledTimes(1);
    expect(mockSetActiveThread).toHaveBeenCalledWith('thread-1');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/(tabs)/chat');
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it('single-flights stale-target alert and navigation across initial and live sources', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const response = createNotificationResponse({
      identifier: 'pocket-ai:inference:deleted-thread',
      date: 101,
      data: { taskType: 'inference', threadId: 'deleted-thread' },
    });
    const initialResponse = createDeferred<Notifications.NotificationResponse>();
    (Notifications.getLastNotificationResponseAsync as jest.Mock)
      .mockImplementationOnce(() => initialResponse.promise)
      .mockResolvedValueOnce(response);

    const initialization = notificationService.initialize();
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
    const listener = (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mock.calls[0][0];

    listener(response);
    initialResponse.resolve(response);
    await initialization;
    await flushNotificationResponsePipeline();

    expect(mockSetActiveThread).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/conversations');
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    alertSpy.mockRestore();
  });

  it('does not clear a newer native response after routing an older response', async () => {
    const olderResponse = createNotificationResponse({
      identifier: 'pocket-ai:inference:thread-1',
      date: 200,
      data: { taskType: 'inference', threadId: 'thread-1' },
    });
    const newerResponse = createNotificationResponse({
      identifier: 'pocket-ai:inference:thread-1',
      date: 201,
      data: { taskType: 'inference', threadId: 'thread-1' },
    });
    await notificationService.initialize();
    (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValueOnce(
      newerResponse,
    );

    const listener = (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mock.calls[0][0];
    listener(olderResponse);
    await flushNotificationResponsePipeline();

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it('retries a routing failure without leaking notification data or rejecting the listener', async () => {
    const response = createNotificationResponse({
      identifier: 'pocket-ai:inference:private-thread-id',
      date: 300,
      data: {
        taskType: 'download',
        threadId: 'private-thread-id',
        payload: 'private-payload',
      },
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const privateFailure = new Error('private-thread-id private-payload');
    (router.push as jest.Mock)
      .mockImplementationOnce(() => {
        throw privateFailure;
      })
      .mockImplementation(() => undefined);
    performanceMonitor.setEnabled(true);
    await notificationService.initialize();
    (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValueOnce(
      response,
    );

    const listener = (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mock.calls[0][0];
    expect(listener(response)).toBeUndefined();
    await flushNotificationResponsePipeline();

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    listener(response);
    await flushNotificationResponsePipeline();

    expect(router.push).toHaveBeenCalledTimes(2);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[NotificationService] Notification response processing failed',
      expect.objectContaining({
        scope: 'notification_response',
        category: 'routing_failed',
        source: 'listener',
        errorName: 'Error',
      }),
    );
    const privacySurface = JSON.stringify({
      logs: warnSpy.mock.calls,
      telemetry: performanceMonitor.snapshot(),
    });
    expect(privacySurface).not.toContain('private-thread-id');
    expect(privacySurface).not.toContain('private-payload');
    warnSpy.mockRestore();
  });

  it('handles later notifications with the same deterministic identifier and a new date', async () => {
    const firstResponse = createNotificationResponse({
      identifier: 'pocket-ai:inference:thread-1',
      date: 400,
      data: { taskType: 'inference', threadId: 'thread-1' },
    });
    const secondResponse = createNotificationResponse({
      identifier: 'pocket-ai:inference:thread-1',
      date: 401,
      data: { taskType: 'inference', threadId: 'thread-1' },
    });
    await notificationService.initialize();
    (Notifications.getLastNotificationResponseAsync as jest.Mock)
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);

    const listener = (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mock.calls[0][0];
    listener(firstResponse);
    await flushNotificationResponsePipeline();
    listener(secondResponse);
    await flushNotificationResponsePipeline();

    expect(mockSetActiveThread).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(2);
  });

  it('rejects a late callback from a disposed listener before navigation side effects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await notificationService.initialize();
    const listener = (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mock.calls[0][0];

    notificationService.dispose();
    listener(createNotificationResponse({
      data: { taskType: 'download' },
    }));
    await flushNotificationResponsePipeline();

    expect(router.push).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('navigates to models on download notification tap', async () => {
    await notificationService.initialize();

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener(createNotificationResponse({
      data: { taskType: 'download' },
    }));
    await flushNotificationResponsePipeline();

    expect(router.push).toHaveBeenCalledWith('/(tabs)/models');
  });

  it('navigates to chat and activates thread on inference notification tap', async () => {
    await notificationService.initialize();

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener(createNotificationResponse({
      data: { taskType: 'inference', threadId: 'thread-1' },
    }));
    await flushNotificationResponsePipeline();

    expect(mockSetActiveThread).toHaveBeenCalledWith('thread-1');
    expect(mockActiveThreadId).toBe('thread-1');
    expect(router.push).toHaveBeenCalledWith('/(tabs)/chat');
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('routes a stale inference target safely without changing the valid active thread', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    performanceMonitor.setEnabled(true);
    await notificationService.initialize();
    delete mockThreads['thread-1'];

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener(createNotificationResponse({
      data: { taskType: 'inference', threadId: 'thread-1' },
    }));
    await flushNotificationResponsePipeline();

    expect(mockSetActiveThread).not.toHaveBeenCalled();
    expect(mockActiveThreadId).toBe('thread-current');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/conversations');
    expect(alertSpy).toHaveBeenCalledWith(
      'notifications.conversationUnavailable.title',
      'notifications.conversationUnavailable.body',
    );
    expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
      'notification.staleTarget': 1,
    }));
    const staleTargetEvents = performanceMonitor.snapshot().events.filter(
      (event) => event.name === 'notification.staleTarget',
    );
    expect(staleTargetEvents).toEqual([
      expect.objectContaining({
        meta: {
          staleNotificationTarget: true,
        },
      }),
    ]);
    expect(JSON.stringify(staleTargetEvents)).not.toContain('thread-1');
    alertSpy.mockRestore();
  });

  it('routes an initial inference response without threadId to the safe conversation list', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValueOnce(
      createNotificationResponse({
        data: { taskType: 'inference' },
      }),
    );

    await notificationService.initialize();

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/conversations');
    expect(mockSetActiveThread).not.toHaveBeenCalled();
    expect(mockActiveThreadId).toBe('thread-current');
    expect(alertSpy).toHaveBeenCalledWith(
      'notifications.conversationUnavailable.title',
      'notifications.conversationUnavailable.body',
    );
    alertSpy.mockRestore();
  });

  it('routes an inference payload with a non-string threadId safely', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await notificationService.initialize();

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener(createNotificationResponse({
      data: { taskType: 'inference', threadId: 42 },
    }));
    await flushNotificationResponsePipeline();

    expect(mockSetActiveThread).not.toHaveBeenCalled();
    expect(mockActiveThreadId).toBe('thread-current');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/conversations');
    expect(alertSpy).toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('routes an old inference notification safely after all history is cleared', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await notificationService.initialize();
    mockThreads = {};
    mockActiveThreadId = null;

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener(createNotificationResponse({
      data: { taskType: 'inference', threadId: 'thread-1' },
    }));
    await flushNotificationResponsePipeline();

    expect(mockSetActiveThread).not.toHaveBeenCalled();
    expect(mockActiveThreadId).toBeNull();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/conversations');
    expect(alertSpy).toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('ignores notification taps with missing or unknown task types', async () => {
    await notificationService.initialize();

    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    listener(createNotificationResponse({
      identifier: 'unknown-task',
      data: { taskType: 'other' },
    }));
    listener(createNotificationResponse({
      identifier: 'missing-task',
      data: {},
    }));
    await flushNotificationResponsePipeline();

    expect(router.push).not.toHaveBeenCalled();
    expect(mockSetActiveThread).not.toHaveBeenCalled();
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

  it('initialize propagates listener setup failures without retaining partial state', async () => {
    const listenerError = new Error('listener failed');
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementationOnce(() => {
      throw listenerError;
    });

    await expect(notificationService.initialize()).rejects.toBe(listenerError);

    expect((notificationService as any).initialized).toBe(false);
    expect((notificationService as any).responseSubscription).toBeUndefined();
  });
});
