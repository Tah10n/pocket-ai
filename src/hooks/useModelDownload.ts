import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useDownloadStore } from '../store/downloadStore';
import { getModelDownloadManager } from '../services/ModelDownloadManager';
import { notificationService } from '../services/NotificationService';
import { ModelMetadata } from '../types/models';
import { useShallow } from 'zustand/react/shallow';
import i18n from '../i18n';

let hasShownNotificationsWarning = false;

export function useModelDownload() {
  const queueIds = useDownloadStore(useShallow((state) => state.queue.map((model) => model.id)));
  const activeDownloadId = useDownloadStore((state) => state.activeDownloadId);
  const addToQueue = useDownloadStore((state) => state.addToQueue);

  const startDownload = useCallback((model: ModelMetadata) => {
    void (async () => {
      let didQueueDownload = false;
      const queueDownload = () => {
        if (didQueueDownload) {
          return;
        }

        didQueueDownload = true;
        addToQueue(model);
      };

      try {
        const canStartForegroundNotifications = await notificationService.canStartForegroundServiceNotifications();
        if (canStartForegroundNotifications || hasShownNotificationsWarning) {
          queueDownload();
          return;
        }

        hasShownNotificationsWarning = true;
        queueDownload();
        Alert.alert(
          i18n.t('notifications.permissions.title'),
          i18n.t('notifications.permissions.body'),
          [
            {
              text: i18n.t('notifications.permissions.enable'),
              onPress: () => {
                void notificationService.requestPermissions()
                  .catch((error) => {
                    console.warn('[useModelDownload] Failed to request notification permission', error);
                  })
                  .finally(queueDownload);
              },
            },
            {
              text: i18n.t('notifications.permissions.openSettings'),
              onPress: () => {
                void notificationService.openSystemSettings()
                  .catch((error) => {
                    console.warn('[useModelDownload] Failed to open system settings', error);
                  })
                  .finally(queueDownload);
              },
            },
            {
              text: i18n.t('notifications.permissions.continue'),
              style: 'cancel',
              onPress: queueDownload,
            },
          ],
          {
            cancelable: true,
            onDismiss: queueDownload,
          },
        );
      } catch (error) {
        console.warn('[useModelDownload] Failed to check notification capability', error);
        queueDownload();
      }
    })();
  }, [addToQueue]);

  const pauseDownload = useCallback((modelId: string) => {
    void getModelDownloadManager().pauseDownload(modelId).catch((error) => {
      console.warn(`[useModelDownload] Failed to pause download for ${modelId}`, error);
    });
  }, []);

  const cancelDownload = useCallback((modelId: string) => {
    void getModelDownloadManager().cancelDownload(modelId).catch((error) => {
      console.warn(`[useModelDownload] Failed to cancel download for ${modelId}`, error);
    });
  }, []);

  const getModelFromQueue = useCallback((modelId: string) => {
    return useDownloadStore.getState().queue.find((model) => model.id === modelId);
  }, []);

  return {
    queueIds,
    activeDownloadId,
    startDownload,
    pauseDownload,
    cancelDownload,
    getModelFromQueue,
  };
}
