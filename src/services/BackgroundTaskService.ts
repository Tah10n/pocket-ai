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

export type ForegroundServiceStartStatus =
    | 'started'
    | 'already_running'
    | 'skipped_android_background'
    | 'skipped_ios_foreground'
    | 'skipped_no_active_task'
    | 'start_failed';

export type ForegroundServiceStartFailureCategory =
    | 'foreground_service_start_not_allowed'
    | 'security_exception'
    | 'native_rejection'
    | 'unknown';

export interface BackgroundTaskStartOptions {
    requireServiceStart?: boolean;
}

export interface ForegroundServiceStartOutcome {
    status: ForegroundServiceStartStatus;
    serviceRunning: boolean;
    degraded: boolean;
    required: boolean;
    requirementSatisfied: boolean;
    failureCategory?: ForegroundServiceStartFailureCategory;
}

type ForegroundServiceStartAttempt = Omit<
    ForegroundServiceStartOutcome,
    'required' | 'requirementSatisfied'
>;

function classifyForegroundServiceStartFailure(error: unknown): ForegroundServiceStartFailureCategory {
    if (!(error instanceof Error)) {
        return 'unknown';
    }

    const nativeCategory = `${error.name} ${error.message}`.toLowerCase();
    if (nativeCategory.includes('foregroundservicestartnotallowed')) {
        return 'foreground_service_start_not_allowed';
    }
    if (nativeCategory.includes('securityexception')) {
        return 'security_exception';
    }

    return 'native_rejection';
}

function applyStartRequirement(
    attempt: ForegroundServiceStartAttempt,
    requireServiceStart: boolean,
): ForegroundServiceStartOutcome {
    const requirementSatisfied = attempt.status === 'started' || attempt.status === 'already_running';
    return {
        ...attempt,
        required: requireServiceStart,
        requirementSatisfied,
    };
}

class BackgroundTaskService {
    private activeTaskTypes = new Set<NotificationTaskType>();
    private startedAtByTask: Partial<Record<NotificationTaskType, number>> = {};
    private latestNotificationUpdateByTask: Partial<Record<NotificationTaskType, NotificationUpdate>> = {};
    private appState: AppStateStatus = normalizeAppState(AppState.currentState);

    private appStateSub?: NativeEventSubscription;
    private started = false;
    private expirationListeners = new Set<() => void>();
    private foregroundServiceStartPromise: Promise<ForegroundServiceStartAttempt> | null = null;

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

    async startBackgroundDownload(
        notificationUpdate?: Extract<NotificationUpdate, { type: 'downloadProgress' | 'downloadPaused' }>,
        options: BackgroundTaskStartOptions = {},
    ): Promise<ForegroundServiceStartOutcome> {
        this.start();
        this.setTaskActive('download');
        if (notificationUpdate) {
            this.latestNotificationUpdateByTask.download = notificationUpdate;
        }
        const outcome = applyStartRequirement(
            await this.maybeStartForegroundService(),
            options.requireServiceStart === true,
        );
        await this.applyCurrentNotificationUpdate();
        return outcome;
    }

    async startBackgroundInference(
        modelName?: string,
        options: BackgroundTaskStartOptions = {},
    ): Promise<ForegroundServiceStartOutcome> {
        this.start();
        this.setTaskActive('inference');
        if (modelName) {
            this.latestNotificationUpdateByTask.inference = { type: 'inferenceProgress', modelName };
        }
        const outcome = applyStartRequirement(
            await this.maybeStartForegroundService(),
            options.requireServiceStart === true,
        );
        await this.applyCurrentNotificationUpdate();
        return outcome;
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
        if (this.foregroundServiceStartPromise) {
            await this.foregroundServiceStartPromise;
        }
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

            void (async () => {
                try {
                    await this.maybeStartForegroundService();
                    await this.applyCurrentNotificationUpdate();
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

        void (async () => {
            await this.maybeStartForegroundService();
            await this.applyCurrentNotificationUpdate();
        })();
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

    private async maybeStartForegroundService(): Promise<ForegroundServiceStartAttempt> {
        if (BackgroundService.isRunning()) {
            return {
                status: 'already_running',
                serviceRunning: true,
                degraded: false,
            };
        }

        if (this.foregroundServiceStartPromise) {
            return this.foregroundServiceStartPromise;
        }

        if (Platform.OS === 'android' && this.appState !== 'active') {
            return {
                status: 'skipped_android_background',
                serviceRunning: false,
                degraded: true,
            };
        }

        if (this.appState === 'active' && Platform.OS !== 'android') {
            return {
                status: 'skipped_ios_foreground',
                serviceRunning: false,
                degraded: true,
            };
        }

        const taskType = this.getPrimaryTaskType();
        if (!taskType) {
            return {
                status: 'skipped_no_active_task',
                serviceRunning: false,
                degraded: true,
            };
        }

        const startPromise = (async (): Promise<ForegroundServiceStartAttempt> => {
            if (BackgroundService.isRunning()) {
                return {
                    status: 'already_running',
                    serviceRunning: true,
                    degraded: false,
                };
            }

            const options = notificationService.getBackgroundTaskOptions(taskType);
            try {
                await BackgroundService.start(notificationService.keepJsAliveWhileRunning, options);
                return {
                    status: 'started',
                    serviceRunning: true,
                    degraded: false,
                };
            } catch (error) {
                console.warn('[BackgroundTaskService] Failed to start background task', error);
                return {
                    status: 'start_failed',
                    serviceRunning: false,
                    degraded: true,
                    failureCategory: classifyForegroundServiceStartFailure(error),
                };
            }
        })();
        this.foregroundServiceStartPromise = startPromise;
        try {
            return await startPromise;
        } finally {
            if (this.foregroundServiceStartPromise === startPromise) {
                this.foregroundServiceStartPromise = null;
            }
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
