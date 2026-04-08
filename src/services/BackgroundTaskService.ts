import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import BackgroundService from 'react-native-background-actions';

import { notificationService, type NotificationTaskType } from './NotificationService';

function normalizeAppState(state: string | null | undefined): AppStateStatus {
    if (state === 'active' || state === 'background' || state === 'inactive') {
        return state;
    }

    return 'active';
}

class BackgroundTaskService {
    private currentTaskType: NotificationTaskType | null = null;
    private currentStartedAt: number | null = null;
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
        return this.currentTaskType;
    }

    get startedAt() {
        return this.currentStartedAt;
    }

    async startBackgroundDownload() {
        this.start();
        this.setTaskType('download');
        await this.maybeStartForegroundService();
    }

    async startBackgroundInference() {
        this.start();
        this.setTaskType('inference');
        await this.maybeStartForegroundService();
    }

    async stopBackgroundTask() {
        this.start();
        this.currentTaskType = null;
        this.currentStartedAt = null;

        if (BackgroundService.isRunning()) {
            try {
                await BackgroundService.stop();
            } catch {
                // ignore
            }
        }

        await notificationService.cancelNotification();
        this.stop();
    }

    subscribeToExpiration(listener: () => void) {
        this.start();
        this.expirationListeners.add(listener);

        return () => {
            this.expirationListeners.delete(listener);
        };
    }

    private setTaskType(nextTaskType: NotificationTaskType) {
        const isChangingTask = this.currentTaskType != null && this.currentTaskType !== nextTaskType;
        this.currentTaskType = nextTaskType;
        if (!this.currentStartedAt || isChangingTask) {
            this.currentStartedAt = Date.now();
        }
    }

    private handleAppStateChange = (nextState: AppStateStatus) => {
        const normalized = normalizeAppState(nextState);
        const previous = this.appState;
        this.appState = normalized;

        if (previous === normalized) {
            return;
        }

        if (normalized === 'active') {
            void this.stopForegroundServiceIfRunning();
            return;
        }

        void this.maybeStartForegroundService();
    };

    private handleExpiration = () => {
        if (this.currentTaskType !== 'inference') {
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
        if (this.appState === 'active') {
            return;
        }

        const taskType = this.currentTaskType;
        if (!taskType) {
            return;
        }

        if (BackgroundService.isRunning()) {
            return;
        }

        const options = notificationService.getBackgroundTaskOptions(taskType);
        try {
            await BackgroundService.start(notificationService.keepJsAliveWhileRunning, options);
        } catch (error) {
            console.warn('[BackgroundTaskService] Failed to start background task', error);
        }
    }
}

export const backgroundTaskService = new BackgroundTaskService();
