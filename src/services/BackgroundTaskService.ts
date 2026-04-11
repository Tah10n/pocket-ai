import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import BackgroundService from 'react-native-background-actions';

import {
    notificationService,
    type NotificationTaskType,
    type NotificationUpdate,
} from './NotificationService';

function normalizeAppState(state: string | null | undefined): AppStateStatus {
    if (state === 'active' || state === 'background' || state === 'inactive') {
        return state;
    }

    return 'active';
}

class BackgroundTaskService {
    private activeTaskTypes = new Set<NotificationTaskType>();
    private startedAtByTask: Partial<Record<NotificationTaskType, number>> = {};
    private latestNotificationUpdateByTask: Partial<Record<NotificationTaskType, NotificationUpdate>> = {};
    private appState: AppStateStatus = normalizeAppState(AppState.currentState);

    private appStateSub?: NativeEventSubscription;
    private started = false;
    private expirationListeners = new Set<() => void>();

    start() {
        if (this.started) {
            return;
        }

        this.started = true;
        this.appStateSub = AppState.addEventListener('change', this.handleAppStateChange);

        try {
            BackgroundService.on('expiration', this.handleExpiration);
        } catch {
            // ignore
        }
    }

    stop() {
        if (!this.started) {
            return;
        }

        this.started = false;
        this.appStateSub?.remove();
        this.appStateSub = undefined;

        try {
            BackgroundService.off('expiration', this.handleExpiration);
        } catch {
            // ignore
        }
    }

    get isActive() {
        return BackgroundService.isRunning();
    }

    get taskType() {
        return this.getPrimaryTaskType();
    }

    get startedAt() {
        const primaryTaskType = this.getPrimaryTaskType();
        if (!primaryTaskType) {
            return null;
        }

        return this.startedAtByTask[primaryTaskType] ?? null;
    }

    isTaskActive(taskType: NotificationTaskType) {
        return this.activeTaskTypes.has(taskType);
    }

    async startBackgroundDownload(notificationUpdate?: Extract<NotificationUpdate, { type: 'downloadProgress' | 'downloadPaused' }>) {
        this.start();
        this.setTaskActive('download');
        if (notificationUpdate) {
            this.latestNotificationUpdateByTask.download = notificationUpdate;
        }
        await this.maybeStartForegroundService();
        await this.applyCurrentNotificationUpdate();
    }

    async startBackgroundInference(modelName?: string) {
        this.start();
        this.setTaskActive('inference');
        if (modelName) {
            this.latestNotificationUpdateByTask.inference = { type: 'inferenceProgress', modelName };
        }
        await this.maybeStartForegroundService();
        await this.applyCurrentNotificationUpdate();
    }

    async stopBackgroundTask(taskType?: NotificationTaskType) {
        this.start();
        if (taskType) {
            this.clearTask(taskType);
            if (this.activeTaskTypes.size === 0) {
                await this.stopAllTasksAndService();
                return;
            }

            // If another task is still active, ensure the foreground-service notification
            // reflects whichever task we keep as the primary.
            await this.applyCurrentNotificationUpdate();
            return;
        }

        this.activeTaskTypes.clear();
        this.startedAtByTask = {};
        this.latestNotificationUpdateByTask = {};

        await this.stopAllTasksAndService();
    }

    private async stopAllTasksAndService() {
        if (BackgroundService.isRunning()) {
            try {
                await BackgroundService.stop();
            } catch {
                // ignore
            }
        }
        this.stop();
    }

    subscribeToExpiration(listener: () => void) {
        this.start();
        this.expirationListeners.add(listener);

        return () => {
            this.expirationListeners.delete(listener);
        };
    }

    private setTaskActive(taskType: NotificationTaskType) {
        if (this.activeTaskTypes.has(taskType)) {
            return;
        }

        this.activeTaskTypes.add(taskType);
        this.startedAtByTask[taskType] = Date.now();
    }

    private clearTask(taskType: NotificationTaskType) {
        this.activeTaskTypes.delete(taskType);
        delete this.startedAtByTask[taskType];
        delete this.latestNotificationUpdateByTask[taskType];
    }

    private getPrimaryTaskType(): NotificationTaskType | null {
        // Prefer downloads when both types are active, so the persistent notification
        // stays relevant for long-running background work.
        if (this.activeTaskTypes.has('download')) {
            return 'download';
        }

        if (this.activeTaskTypes.has('inference')) {
            return 'inference';
        }

        return null;
    }

    private handleAppStateChange = (nextState: AppStateStatus) => {
        const normalized = normalizeAppState(nextState);
        const previous = this.appState;
        this.appState = normalized;

        if (previous === normalized) {
            return;
        }

        if (normalized === 'active') {
            // Keep the foreground service running while work is active.
            // Starting it from a backgrounded Android app can crash on Android 12+.
            if (this.activeTaskTypes.size === 0) {
                void this.stopForegroundServiceIfRunning();
                return;
            }

            const wasRunning = BackgroundService.isRunning();
            void (async () => {
                try {
                    await this.maybeStartForegroundService();
                    if (wasRunning) {
                        await this.applyCurrentNotificationUpdate();
                    }
                } catch (error) {
                    console.warn('[BackgroundTaskService] Failed to sync task notification', error);
                }
            })();
            return;
        }

        // Avoid starting a foreground service from the background on Android.
        // The service should be started while the app is still active (user-initiated).
        if (Platform.OS === 'android') {
            return;
        }

        void this.maybeStartForegroundService();
    };

    private handleExpiration = () => {
        if (!this.activeTaskTypes.has('inference')) {
            return;
        }

        this.expirationListeners.forEach((listener) => {
            try {
                listener();
            } catch (error) {
                console.warn('[BackgroundTaskService] Expiration listener failed', error);
            }
        });
    };

    private async stopForegroundServiceIfRunning(): Promise<void> {
        if (!BackgroundService.isRunning()) {
            return;
        }

        try {
            await BackgroundService.stop();
        } catch {
            // ignore
        }
    }

    private async maybeStartForegroundService(): Promise<void> {
        if (Platform.OS === 'android' && this.appState !== 'active') {
            return;
        }

        if (this.appState === 'active' && Platform.OS !== 'android') {
            return;
        }

        const taskType = this.getPrimaryTaskType();
        if (!taskType) {
            return;
        }

        if (BackgroundService.isRunning()) {
            return;
        }

        if (Platform.OS === 'android') {
            const canStart = await notificationService.canStartForegroundServiceNotifications();
            if (!canStart) {
                return;
            }
        }

        const options = notificationService.getBackgroundTaskOptions(taskType);
        try {
            await BackgroundService.start(notificationService.keepJsAliveWhileRunning, options);
            await this.applyCurrentNotificationUpdate();
        } catch (error) {
            console.warn('[BackgroundTaskService] Failed to start background task', error);
        }
    }

    private async applyCurrentNotificationUpdate(): Promise<void> {
        const taskType = this.getPrimaryTaskType();
        if (!taskType) {
            return;
        }

        const update = this.latestNotificationUpdateByTask[taskType] ?? null;
        if (!update) {
            return;
        }

        try {
            await notificationService.updateNotification(update);
        } catch (error) {
            console.warn('[BackgroundTaskService] Failed to update task notification', error);
        }
    }
}

export const backgroundTaskService = new BackgroundTaskService();
