import { create } from 'zustand';
import { persist, createJSONStorage, subscribeWithSelector } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { normalizePersistedModelMetadata } from '../services/ModelMetadataNormalizer';
import { getCandidateModelDownloadFileNames } from '../utils/modelFiles';
import { createInstrumentedStateStorage } from './persistStateStorage';

const downloadStoreStateStorage = createInstrumentedStateStorage(mmkvStorage, { scope: 'downloadStore', dedupe: true });

interface DownloadState {
  queue: ModelMetadata[];
  activeDownloadId: string | null;
  
  addToQueue: (model: ModelMetadata) => void;
  removeFromQueue: (modelId: string) => void;
  setActiveDownload: (modelId: string | null) => void;
  updateModelInQueue: (modelId: string, updates: Partial<ModelMetadata>) => void;
}

export function normalizePersistedDownloadQueue(queue: ModelMetadata[]): ModelMetadata[] {
  return queue.map((model) => {
    const normalizedModel = normalizePersistedModelMetadata(model);
    if (
      normalizedModel.lifecycleStatus === LifecycleStatus.DOWNLOADING ||
      normalizedModel.lifecycleStatus === LifecycleStatus.VERIFYING
    ) {
      return {
        ...normalizedModel,
        lifecycleStatus: LifecycleStatus.QUEUED,
      };
    }

    return normalizedModel;
  });
}

export const useDownloadStore = create<DownloadState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        queue: [],
        activeDownloadId: null,

        addToQueue: (model) => set((state) => {
          const existing = state.queue.find((queued) => queued.id === model.id);

          if (!existing) {
            return {
              queue: [
                ...state.queue,
                normalizePersistedModelMetadata({
                  ...model,
                  lifecycleStatus: LifecycleStatus.QUEUED,
                }),
              ],
            };
          }

          if (
            existing.lifecycleStatus === LifecycleStatus.QUEUED
            || existing.lifecycleStatus === LifecycleStatus.DOWNLOADING
            || existing.lifecycleStatus === LifecycleStatus.VERIFYING
          ) {
            return state;
          }

          // If a previous download attempt failed, we keep it in the queue as "available"
          // so it won't auto-retry. Re-queue it when the user taps Download again.
          if (existing.lifecycleStatus === LifecycleStatus.AVAILABLE) {
            const nextEntry = normalizePersistedModelMetadata({
              ...existing,
              ...model,
              resumeData: existing.resumeData,
              downloadProgress: existing.downloadProgress,
              localPath: existing.localPath ?? model.localPath,
              lifecycleStatus: LifecycleStatus.QUEUED,
            });

            return {
              queue: state.queue.map((queued) => queued.id === model.id ? nextEntry : queued),
            };
          }

          return state;
        }),

        removeFromQueue: (modelId) => set((state) => ({
          queue: state.queue.filter(m => m.id !== modelId),
          activeDownloadId: state.activeDownloadId === modelId ? null : state.activeDownloadId
        })),

        setActiveDownload: (modelId) => set({ activeDownloadId: modelId }),

        updateModelInQueue: (modelId, updates) => set((state) => ({
          queue: state.queue.map((model) => (
            model.id === modelId
              ? normalizePersistedModelMetadata({ ...model, ...updates })
              : model
          )),
        })),
      }),
      {
        name: 'download-queue-storage',
        skipHydration: true,
        storage: createJSONStorage(() => downloadStoreStateStorage),
        // Do NOT persist activeDownloadId — after a restart, no real download is running.
        // Persisting it would leave the UI in a permanent "downloading" spinner state.
        // Avoid persisting volatile progress updates so downloads don't spam MMKV writes.
        partialize: (state) => ({ queue: state.queue.map((model) => ({ ...model, downloadProgress: 0 })) }),
        onRehydrateStorage: () => (state) => {
          if (!state) {
            return;
          }

          state.activeDownloadId = null;
          state.queue = normalizePersistedDownloadQueue(state.queue);
        },
      }
    )
  )
);

export function getQueuedDownloadFileNames(): string[] {
  return Array.from(new Set(
    useDownloadStore
      .getState()
      .queue
      .flatMap((model) => getCandidateModelDownloadFileNames(model)),
  ));
}
