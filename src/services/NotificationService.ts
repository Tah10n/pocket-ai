import { Alert, Linking, Platform } from 'react-native';
import BackgroundService, { type BackgroundTaskOptions } from 'react-native-background-actions';
import * as Notifications from 'expo-notifications';
import { createURL } from 'expo-linking';
import { router } from 'expo-router';

import i18n from '../i18n';
import { useChatStore } from '../store/chatStore';
import { semanticColorTokens } from '../utils/themeTokens';
import { getPrivacySafeErrorLogDetails } from './AppError';
import { performanceMonitor } from './PerformanceMonitor';

export type NotificationTaskType = 'download' | 'inference';

export type DownloadErrorReason = 'storageFull' | 'connectionLost' | 'verificationFailed' | 'unknown';

export type NotificationUpdate =
    | {
        type: 'downloadProgress';
        modelName: string;
        progressPercent: number;
        speedBytesPerSec?: number;
    }
    | {
        type: 'downloadPaused';
    }
    | {
        type: 'inferenceProgress';
        modelName: string;
    };

const CHANNEL_IDS = {
    downloads: 'downloads',
    inference: 'inference',
} as const;

const BACKGROUND_ACTIONS_CHANNEL_ID = 'RN_BACKGROUND_ACTIONS_CHANNEL';
const FOREGROUND_SERVICE_NOTIFICATION_COLOR = semanticColorTokens.primary[500];
const INFERENCE_NOTIFICATION_IDENTIFIER_PREFIX = 'pocket-ai:inference:';

type NotificationInitializationFailureCategory =
    | 'handler_setup_failed'
    | 'download_channel_failed'
    | 'inference_channel_failed'
    | 'listener_registration_failed'
    | 'initial_response_failed'
    | 'disposed';

function getInferenceNotificationIdentifier(threadId: string): string {
    return `${INFERENCE_NOTIFICATION_IDENTIFIER_PREFIX}${encodeURIComponent(threadId)}`;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePermissionState(
    result: unknown,
): 'granted' | 'denied' | 'undetermined' {
    const anyResult = result as {
        status?: unknown;
        granted?: unknown;
        canAskAgain?: unknown;
        ios?: { status?: unknown; authorizationStatus?: unknown };
    } | null;

    const statusCandidate = anyResult?.ios?.status ?? anyResult?.status;
    const status = typeof statusCandidate === 'string' ? statusCandidate : null;
    if (status === 'granted' || status === 'denied' || status === 'undetermined') {
        return status;
    }

    // iOS can also report a numeric authorization status.
    const iosAuthorizationStatus = typeof anyResult?.ios?.authorizationStatus === 'number'
        ? anyResult.ios.authorizationStatus
        : null;
    const iosStatusNumber = typeof statusCandidate === 'number' ? statusCandidate : null;
    const numericStatus = iosAuthorizationStatus ?? iosStatusNumber;
    if (typeof numericStatus === 'number') {
        // Map common iOS UNAuthorizationStatus values:
        // 0: notDetermined, 1: denied, 2: authorized, 3: provisional, 4: ephemeral
        if (numericStatus === 0) {
            return 'undetermined';
        }
        if (numericStatus === 1) {
            return 'denied';
        }
        if (numericStatus === 2 || numericStatus === 3 || numericStatus === 4) {
            return 'granted';
        }
    }

    const granted = typeof anyResult?.granted === 'boolean' ? anyResult.granted : null;
    if (granted === true) {
        return 'granted';
    }

    const canAskAgain = typeof anyResult?.canAskAgain === 'boolean' ? anyResult.canAskAgain : null;
    if (granted === false && canAskAgain === false) {
        return 'denied';
    }

    return 'undetermined';
}

function formatBytesPerSecond(bytesPerSecond: number | undefined) {
    if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        return '—';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytesPerSecond;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1);
    return `${formatted} ${units[unitIndex]}`;
}

function clampProgressPercent(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(value)));
}

class NotificationService {
    private initialized = false;
    private initializationPromise: Promise<void> | null = null;
    private lifecycleGeneration = 0;
    private permissionState: 'unknown' | 'granted' | 'denied' = 'unknown';

    private responseSubscription?: Notifications.EventSubscription;
    private hasHandledInitialResponse = false;

    initialize(): Promise<void> {
        return this.ensureInitialized();
    }

    private ensureInitialized(): Promise<void> {
        if (this.initialized) {
            return Promise.resolve();
        }

        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        const generation = this.lifecycleGeneration;
        // Defer the async body by one microtask so the shared promise is assigned
        // synchronously before any initialization work can yield or re-enter.
        const initializationPromise = Promise.resolve().then(
            () => this.performInitialization(generation),
        );
        this.initializationPromise = initializationPromise;
        void initializationPromise.then(
            () => {
                if (this.initializationPromise === initializationPromise) {
                    this.initializationPromise = null;
                }
            },
            () => {
                if (this.initializationPromise === initializationPromise) {
                    this.initializationPromise = null;
                }
            },
        );
        return initializationPromise;
    }

    private assertInitializationGeneration(generation: number): void {
        if (generation !== this.lifecycleGeneration) {
            throw new Error('Notification initialization was disposed.');
        }
    }

    private async performInitialization(generation: number): Promise<void> {
        let failureCategory: NotificationInitializationFailureCategory = 'handler_setup_failed';
        let localResponseSubscription: Notifications.EventSubscription | undefined;
        let localResponseSubscriptionWasPublished = false;

        try {
            this.assertInitializationGeneration(generation);
            Notifications.setNotificationHandler({
                handleNotification: async () => ({
                    shouldShowBanner: true,
                    shouldShowList: true,
                    shouldPlaySound: false,
                    shouldSetBadge: false,
                }),
            });
            this.assertInitializationGeneration(generation);

            if (Platform.OS === 'android') {
                failureCategory = 'download_channel_failed';
                await Notifications.setNotificationChannelAsync(CHANNEL_IDS.downloads, {
                    name: 'Downloads',
                    importance: Notifications.AndroidImportance.HIGH,
                });
                this.assertInitializationGeneration(generation);

                failureCategory = 'inference_channel_failed';
                await Notifications.setNotificationChannelAsync(CHANNEL_IDS.inference, {
                    name: 'Inference',
                    importance: Notifications.AndroidImportance.DEFAULT,
                });
                this.assertInitializationGeneration(generation);
            }

            failureCategory = 'listener_registration_failed';
            localResponseSubscription = Notifications.addNotificationResponseReceivedListener(
                this.handleNotificationResponse,
            );
            if (!localResponseSubscription || typeof localResponseSubscription.remove !== 'function') {
                throw new Error('Notification response listener registration failed.');
            }
            this.assertInitializationGeneration(generation);
            this.responseSubscription = localResponseSubscription;
            localResponseSubscriptionWasPublished = true;

            if (!this.hasHandledInitialResponse) {
                failureCategory = 'initial_response_failed';
                const lastResponse = await Notifications.getLastNotificationResponseAsync();
                this.assertInitializationGeneration(generation);
                this.hasHandledInitialResponse = true;
                if (lastResponse) {
                    this.handleNotificationResponse(lastResponse);
                }
            }

            this.assertInitializationGeneration(generation);
            this.initialized = true;
            performanceMonitor.mark('notification.initialization', {
                notificationInitializationOutcome: 'success',
            });
        } catch (error) {
            if (
                localResponseSubscription
                && (
                    !localResponseSubscriptionWasPublished
                    || this.responseSubscription === localResponseSubscription
                )
            ) {
                try {
                    localResponseSubscription.remove();
                } catch {
                    // Preserve the initialization error.
                }
            }
            if (this.responseSubscription === localResponseSubscription) {
                this.responseSubscription = undefined;
            }
            if (generation === this.lifecycleGeneration) {
                this.initialized = false;
            } else {
                failureCategory = 'disposed';
            }
            performanceMonitor.mark('notification.initialization', {
                notificationInitializationOutcome:
                    failureCategory === 'disposed' ? 'disposed' : 'failure',
                notificationInitializationFailureCategory: failureCategory,
            });
            throw error;
        }
    }

    dispose(): void {
        this.lifecycleGeneration += 1;
        this.initialized = false;
        this.initializationPromise = null;
        this.permissionState = 'unknown';
        const subscription = this.responseSubscription;
        this.responseSubscription = undefined;
        try {
            subscription?.remove();
        } catch {
            // Best-effort lifecycle cleanup.
        }
    }

    private handleNotificationResponse = (response: Notifications.NotificationResponse) => {
        const data = response.notification.request.content.data ?? {};
        const taskType = typeof data.taskType === 'string' ? data.taskType : null;

        if (taskType === 'download') {
            router.push('/(tabs)/models');
            return;
        }

        if (taskType === 'inference') {
            const threadId = typeof data.threadId === 'string' && data.threadId.trim().length > 0
                ? data.threadId
                : null;
            const chatState = useChatStore.getState();
            if (
                !threadId
                || chatState.threads[threadId] == null
                || !chatState.setActiveThread(threadId)
            ) {
                performanceMonitor.incrementCounter('notification.staleTarget', 1, {
                    staleNotificationTarget: true,
                });
                Alert.alert(
                    i18n.t('notifications.conversationUnavailable.title'),
                    i18n.t('notifications.conversationUnavailable.body'),
                );
                router.push('/conversations');
                return;
            }

            router.push('/(tabs)/chat');
        }
    };

    async requestPermissions(): Promise<boolean> {
        await this.ensureInitialized();

        const current = await Notifications.getPermissionsAsync();
        if (resolvePermissionState(current) === 'granted') {
            this.permissionState = 'granted';
            return true;
        }

        const requested = await Notifications.requestPermissionsAsync();
        const requestedState = resolvePermissionState(requested);
        if (requestedState === 'undetermined') {
            this.permissionState = 'unknown';
        } else {
            this.permissionState = requestedState === 'granted' ? 'granted' : 'denied';
        }
        return requestedState === 'granted';
    }

    async openSystemSettings(): Promise<void> {
        try {
            await Linking.openSettings();
        } catch (error) {
            console.warn('[NotificationService] Failed to open system settings', error);
        }
    }

    async canStartForegroundServiceNotifications(): Promise<boolean> {
        await this.ensureInitialized();

        if (Platform.OS !== 'android') {
            return true;
        }

        try {
            const current = await Notifications.getPermissionsAsync();
            const permissionState = resolvePermissionState(current);
            const granted = permissionState === 'granted';
            if (granted) {
                this.permissionState = 'granted';
            } else if (permissionState === 'denied') {
                this.permissionState = 'denied';
            }

            // On Android 13+, a foreground service notification can crash if notification
            // permission is not granted, so refuse to start it until the user opts in.
            if (!granted) {
                return false;
            }
        } catch (error) {
            console.warn('[NotificationService] Failed to read notification permission', error);
            return false;
        }

        // If the RN background-actions channel exists but is blocked, starting the FGS can crash.
        try {
            const channels = await Notifications.getNotificationChannelsAsync();
            const fgsChannel = channels?.find((channel) => channel.id === BACKGROUND_ACTIONS_CHANNEL_ID) ?? null;
            if (fgsChannel && fgsChannel.importance === Notifications.AndroidImportance.NONE) {
                return false;
            }
        } catch {
            // Ignore channel lookup failures, fall back to permission check.
        }

        return true;
    }

    private async canSendLocalNotifications(): Promise<boolean> {
        if (this.permissionState === 'granted') {
            return true;
        }

        if (this.permissionState === 'denied') {
            return false;
        }

        const current = await Notifications.getPermissionsAsync();
        const permissionState = resolvePermissionState(current);
        if (permissionState === 'granted') {
            this.permissionState = 'granted';
            return true;
        }

        if (permissionState === 'denied') {
            this.permissionState = 'denied';
            return false;
        }

        // Do not prompt from background or service code paths.
        // Permissions should be requested explicitly via requestPermissions().
        return false;
    }

    getBackgroundTaskOptions(taskType: NotificationTaskType): BackgroundTaskOptions {
        const isDownload = taskType === 'download';

        return {
            taskName: taskType,
            taskTitle: isDownload
                ? i18n.t('notifications.download.progress.title', { modelName: '' }).trim() || 'Downloading…'
                : i18n.t('notifications.inference.progress.title'),
            taskDesc: isDownload
                ? i18n.t('notifications.download.progress.body', { progress: 0, speed: '—' })
                : i18n.t('notifications.inference.progress.body', { modelName: '' }).trim()
                    || i18n.t('notifications.inference.progress.body'),
            taskIcon: {
                name: 'ic_launcher',
                type: 'mipmap',
            },
            color: FOREGROUND_SERVICE_NOTIFICATION_COLOR,
            linkingURI: isDownload ? createURL('/(tabs)/models') : createURL('/(tabs)/chat'),
            progressBar: isDownload
                ? { max: 100, value: 0, indeterminate: false }
                : { max: 100, value: 0, indeterminate: true },
            // Required when the Android manifest declares a foregroundServiceType.
            // Omitting it can crash on newer Android versions.
            foregroundServiceType: ['dataSync'],
        };
    }

    async sendLocalNotification(
        content: Notifications.NotificationContentInput,
        options: { channelId?: string; identifier?: string } = {},
    ): Promise<string | null> {
        await this.ensureInitialized();

        const hasPermission = await this.canSendLocalNotifications();
        if (!hasPermission) {
            return null;
        }

        const trigger = options.channelId ? { channelId: options.channelId } : null;
        return await Notifications.scheduleNotificationAsync({
            ...(options.identifier ? { identifier: options.identifier } : null),
            content,
            trigger,
        });
    }

    async dismissInferenceNotificationForThread(threadId: string): Promise<void> {
        if (typeof threadId !== 'string' || threadId.trim().length === 0) {
            return;
        }

        try {
            await Notifications.dismissNotificationAsync(
                getInferenceNotificationIdentifier(threadId),
            );
        } catch (error) {
            console.warn(
                '[NotificationService] Failed to dismiss inference notification',
                {
                    scope: 'inference_notification_dismiss',
                    ...getPrivacySafeErrorLogDetails(error),
                },
            );
        }
    }

    async updateNotification(update: NotificationUpdate): Promise<void> {
        if (!BackgroundService.isRunning()) {
            return;
        }

        if (update.type === 'downloadProgress') {
            const progress = clampProgressPercent(update.progressPercent);
            const speed = formatBytesPerSecond(update.speedBytesPerSec);
            const taskTitle = i18n.t('notifications.download.progress.title', { modelName: update.modelName });
            const taskDesc = i18n.t('notifications.download.progress.body', { progress, speed });

            await BackgroundService.updateNotification({
                taskTitle,
                taskDesc,
                linkingURI: createURL('/(tabs)/models'),
                progressBar: { max: 100, value: progress, indeterminate: false },
            });
            return;
        }

        if (update.type === 'downloadPaused') {
            await BackgroundService.updateNotification({
                taskTitle: i18n.t('notifications.download.paused.title'),
                taskDesc: i18n.t('notifications.download.paused.body'),
                linkingURI: createURL('/(tabs)/models'),
                progressBar: { max: 100, value: 0, indeterminate: true },
            });
            return;
        }

        if (update.type === 'inferenceProgress') {
            await BackgroundService.updateNotification({
                taskTitle: i18n.t('notifications.inference.progress.title'),
                taskDesc: i18n.t('notifications.inference.progress.body', { modelName: update.modelName }),
                linkingURI: createURL('/(tabs)/chat'),
                progressBar: { max: 100, value: 0, indeterminate: true },
            });
        }
    }

    async sendCompletionNotification(taskType: NotificationTaskType, params: { modelName?: string; threadId?: string } = {}) {
        if (taskType === 'download') {
            const modelName = params.modelName ?? '';
            await this.sendLocalNotification(
                {
                    title: i18n.t('notifications.download.complete.title'),
                    body: i18n.t('notifications.download.complete.body', { modelName }),
                    data: { taskType },
                },
                { channelId: CHANNEL_IDS.downloads },
            );
            return;
        }

        await this.sendLocalNotification(
            {
                title: i18n.t('notifications.inference.complete.title'),
                body: i18n.t('notifications.inference.complete.body'),
                data: { taskType, threadId: params.threadId },
            },
            {
                channelId: CHANNEL_IDS.inference,
                ...(params.threadId
                    ? { identifier: getInferenceNotificationIdentifier(params.threadId) }
                    : null),
            },
        );
    }

    async sendInterruptedNotification(params: { threadId?: string } = {}) {
        await this.sendLocalNotification(
            {
                title: i18n.t('notifications.inference.interrupted.title'),
                body: i18n.t('notifications.inference.interrupted.body'),
                data: { taskType: 'inference', threadId: params.threadId },
            },
            {
                channelId: CHANNEL_IDS.inference,
                ...(params.threadId
                    ? { identifier: getInferenceNotificationIdentifier(params.threadId) }
                    : null),
            },
        );
    }

    async sendInferenceErrorNotification(params: { threadId?: string } = {}) {
        await this.sendLocalNotification(
            {
                title: i18n.t('notifications.inference.error.title'),
                body: i18n.t('notifications.inference.error.body'),
                data: { taskType: 'inference', threadId: params.threadId },
            },
            {
                channelId: CHANNEL_IDS.inference,
                ...(params.threadId
                    ? { identifier: getInferenceNotificationIdentifier(params.threadId) }
                    : null),
            },
        );
    }

    async sendErrorNotification(params: { modelName: string; reason?: DownloadErrorReason }) {
        const { modelName } = params;
        const reasonKey = params.reason ?? 'unknown';

        const errorReason = reasonKey === 'storageFull'
            ? i18n.t('notifications.error.storageFull')
            : reasonKey === 'connectionLost'
                ? i18n.t('notifications.error.connectionLost')
                : reasonKey === 'verificationFailed'
                    ? i18n.t('notifications.error.verificationFailed')
                    : i18n.t('common.actionFailed');

        await this.sendLocalNotification(
            {
                title: i18n.t('notifications.download.error.title'),
                body: i18n.t('notifications.download.error.body', { modelName, errorReason }),
                data: { taskType: 'download' },
            },
            { channelId: CHANNEL_IDS.downloads },
        );
    }

    async sendPausedNotification() {
        await this.sendLocalNotification(
            {
                title: i18n.t('notifications.download.paused.title'),
                body: i18n.t('notifications.download.paused.body'),
                data: { taskType: 'download' },
            },
            { channelId: CHANNEL_IDS.downloads },
        );
    }

    async keepJsAliveWhileRunning(): Promise<void> {
        while (BackgroundService.isRunning()) {
            await sleep(1000);
        }
    }
}

export const notificationService = new NotificationService();
