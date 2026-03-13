import { create } from 'zustand';
import { persist, createJSONStorage, subscribeWithSelector } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { ModelMetadata, LifecycleStatus } from '../types/models';

interface DownloadState {
  queue: ModelMetadata[];
  activeModelId: string | null;
  
  addToQueue: (model: ModelMetadata) => void;
  removeFromQueue: (modelId: string) => void;
  setActiveModel: (modelId: string | null) => void;
  updateModelInQueue: (modelId: string, updates: Partial<ModelMetadata>) => void;
}

export const useDownloadStore = create<DownloadState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        queue: [],
        activeModelId: null,

        addToQueue: (model) => set((state) => {
          if (state.queue.find(m => m.id === model.id)) return state;
          return { queue: [...state.queue, { ...model, lifecycleStatus: LifecycleStatus.QUEUED }] };
        }),

        removeFromQueue: (modelId) => set((state) => ({
          queue: state.queue.filter(m => m.id !== modelId),
          activeModelId: state.activeModelId === modelId ? null : state.activeModelId
        })),

        setActiveModel: (modelId) => set({ activeModelId: modelId }),

        updateModelInQueue: (modelId, updates) => set((state) => ({
          queue: state.queue.map(m => m.id === modelId ? { ...m, ...updates } : m)
        })),
      }),
      {
        name: 'download-queue-storage',
        storage: createJSONStorage(() => mmkvStorage),
      }
    )
  )
);
