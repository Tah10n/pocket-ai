import { useCallback } from 'react';
import { useDownloadStore } from '../store/downloadStore';
import { modelDownloadManager } from '../services/ModelDownloadManager';
import { ModelMetadata } from '../types/models';
import { useShallow } from 'zustand/react/shallow';

export function useModelDownload() {
  const queueIds = useDownloadStore(useShallow((state) => state.queue.map((model) => model.id)));
  const activeDownloadId = useDownloadStore((state) => state.activeDownloadId);
  const addToQueue = useDownloadStore((state) => state.addToQueue);

  const startDownload = useCallback((model: ModelMetadata) => {
    addToQueue(model);
  }, [addToQueue]);

  const pauseDownload = useCallback((modelId: string) => {
    modelDownloadManager.pauseDownload(modelId);
  }, []);

  const cancelDownload = useCallback((modelId: string) => {
    modelDownloadManager.cancelDownload(modelId);
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
