import { Linking, Platform } from 'react-native';
import BackgroundService, { type BackgroundTaskOptions } from 'react-native-background-actions';
import * as Notifications from 'expo-notifications';
import { createURL } from 'expo-linking';
import { router } from 'expo-router';

import i18n from '../i18n';
import { useChatStore } from '../store/chatStore';

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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    private permissionState: 'unknown' | 'granted' | 'denied' = 'unknown';

    private responseSubscription?: Notifications.EventSubscription;
    private hasHandledInitialResponse = false;

    async initialize(): Promise<void> {
        try {
            await this.ensureInitialized();
        } catch (error) {
            console.warn('[NotificationService] Failed to initialize', error);
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) {
            return;
        }

        Notifications.setNotificationHandler({
            handleNotification: async () => ({
                shouldShowBanner: true,
                shouldShowList: true,
                shouldPlaySound: false,
                shouldSetBadge: false,
            }),
        });

        if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync(CHANNEL_IDS.downloads, {
                name: 'Downloads',
                importance: Notifications.AndroidImportance.HIGH,
            });

            await Notifications.setNotificationChannelAsync(CHANNEL_IDS.inference, {
                name: 'Inference',
                importance: Notifications.AndroidImportance.DEFAULT,
            });
        }

        this.responseSubscription = Notifications.addNotificationResponseReceivedListener(this.handleNotificationResponse);
        if (!this.hasHandledInitialResponse) {
            this.hasHandledInitialResponse = true;
            try {
                const lastResponse = await Notifications.getLastNotificationResponseAsync();
                if (lastResponse) {
                    this.handleNotificationResponse(lastResponse);
                }
            } catch {
                // ignore
            }
        }

        this.initialized = true;
    }

    private handleNotificationResponse = (response: Notifications.NotificationResponse) => {
        const data = response.notification.request.content.data ?? {};
        const taskType = typeof data.taskType === 'string' ? data.taskType : null;

        if (taskType === 'download') {
            router.push('/(tabs)/models');
            return;
        }

        if (taskType === 'inference') {
            const threadId = typeof data.threadId === 'string' ? data.threadId : null;
            if (threadId) {
                useChatStore.getState().setActiveThread(threadId);
            }
            router.push('/(tabs)/chat');
        }
    };

    async requestPermissions(): Promise<boolean> {
        await this.ensureInitialized();

        const current = await Notifications.getPermissionsAsync();
        if (current.status === 'granted') {
            this.permissionState = 'granted';
            return true;
        }

        const requested = await Notifications.requestPermissionsAsync();
        this.permissionState = requested.status === 'granted' ? 'granted' : 'denied';
        return requested.status === 'granted';
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
            const granted = current.status === 'granted';
            if (granted) {
                this.permissionState = 'granted';
            } else if (current.status === 'denied') {
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
        if (current.status === 'granted') {
            this.permissionState = 'granted';
            return true;
        }

        if (current.status === 'denied') {
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
            color: '#010100',
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
        options: { channelId?: string } = {},
    ): Promise<string | null> {
        await this.ensureInitialized();

        const hasPermission = await this.canSendLocalNotifications();
        if (!hasPermission) {
            return null;
        }

        const trigger = options.channelId ? { channelId: options.channelId } : null;
        return await Notifications.scheduleNotificationAsync({ content, trigger });
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
            { channelId: CHANNEL_IDS.inference },
        );
    }

    async sendInterruptedNotification(params: { threadId?: string } = {}) {
        await this.sendLocalNotification(
            {
                title: i18n.t('notifications.inference.interrupted.title'),
                body: i18n.t('notifications.inference.interrupted.body'),
                data: { taskType: 'inference', threadId: params.threadId },
            },
            { channelId: CHANNEL_IDS.inference },
        );
    }

    async sendInferenceErrorNotification(params: { threadId?: string } = {}) {
        await this.sendLocalNotification(
            {
                title: i18n.t('notifications.inference.error.title'),
                body: i18n.t('notifications.inference.error.body'),
                data: { taskType: 'inference', threadId: params.threadId },
            },
            { channelId: CHANNEL_IDS.inference },
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
