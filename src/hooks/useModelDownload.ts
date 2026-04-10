import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useDownloadStore } from '../store/downloadStore';
import { getModelDownloadManager } from '../services/ModelDownloadManager';
import { notificationService } from '../services/NotificationService';
import { ModelMetadata } from '../types/models';
import { useShallow } from 'zustand/react/shallow';
import i18n from '../i18n';

export function useModelDownload() {
  const queueIds = useDownloadStore(useShallow((state) => state.queue.map((model) => model.id)));
  const activeDownloadId = useDownloadStore((state) => state.activeDownloadId);
  const addToQueue = useDownloadStore((state) => state.addToQueue);

  const startDownload = useCallback((model: ModelMetadata) => {
    void (async () => {
      try {
        const granted = await notificationService.requestPermissions();
        const canStartForegroundNotifications = granted
          ? await notificationService.canStartForegroundServiceNotifications()
          : false;

        if (!granted || !canStartForegroundNotifications) {
          Alert.alert(
            i18n.t('notifications.permissions.title'),
            i18n.t('notifications.permissions.body'),
            [
              { text: i18n.t('notifications.permissions.openSettings'), onPress: () => { void notificationService.openSystemSettings(); } },
              { text: i18n.t('notifications.permissions.continue'), style: 'cancel' },
            ],
          );
        }
      } catch (error) {
        console.warn('[useModelDownload] Failed to request notification permission', error);
      } finally {
        addToQueue(model);
      }
    })();
  }, [addToQueue]);

  const pauseDownload = useCallback((modelId: string) => {
    getModelDownloadManager().pauseDownload(modelId);
  }, []);

  const cancelDownload = useCallback((modelId: string) => {
    getModelDownloadManager().cancelDownload(modelId);
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
