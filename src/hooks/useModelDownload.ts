import { useCallback } from 'react';
import { useDownloadStore } from '../store/downloadStore';
import { modelDownloadManager } from '../services/ModelDownloadManager';
import { ModelMetadata } from '../types/models';

export function useModelDownload() {
  const queue = useDownloadStore((state) => state.queue);
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
    return queue.find(m => m.id === modelId);
  }, [queue]);

  return {
    queue,
    activeDownloadId,
    startDownload,
    pauseDownload,
    cancelDownload,
    getModelFromQueue,
  };
}
