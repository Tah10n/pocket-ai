import { create } from 'zustand';
import { persist, createJSONStorage, subscribeWithSelector } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { ModelMetadata, LifecycleStatus } from '../types/models';

interface DownloadState {
  queue: ModelMetadata[];
  activeDownloadId: string | null;
  
  addToQueue: (model: ModelMetadata) => void;
  removeFromQueue: (modelId: string) => void;
  setActiveDownload: (modelId: string | null) => void;
  updateModelInQueue: (modelId: string, updates: Partial<ModelMetadata>) => void;
}

export const useDownloadStore = create<DownloadState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        queue: [],
        activeDownloadId: null,

        addToQueue: (model) => set((state) => {
          if (state.queue.find(m => m.id === model.id)) return state;
          return { queue: [...state.queue, { ...model, lifecycleStatus: LifecycleStatus.QUEUED }] };
        }),

        removeFromQueue: (modelId) => set((state) => ({
          queue: state.queue.filter(m => m.id !== modelId),
          activeDownloadId: state.activeDownloadId === modelId ? null : state.activeDownloadId
        })),

        setActiveDownload: (modelId) => set({ activeDownloadId: modelId }),

        updateModelInQueue: (modelId, updates) => set((state) => ({
          queue: state.queue.map(m => m.id === modelId ? { ...m, ...updates } : m)
        })),
      }),
      {
        name: 'download-queue-storage',
        storage: createJSONStorage(() => mmkvStorage),
        // Do NOT persist activeDownloadId — after a restart, no real download is running.
        // Persisting it would leave the UI in a permanent "downloading" spinner state.
        partialize: (state) => ({ queue: state.queue }),
      }
    )
  )
);

export function getQueuedDownloadFileNames(): string[] {
  return useDownloadStore
    .getState()
    .queue
    .map((model) => model.id.replace(/\//g, '_') + '.gguf');
}
