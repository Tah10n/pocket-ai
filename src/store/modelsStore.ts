import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from './storage';

export interface LocalModel {
  id: string;
  name: string;
  sizeMB: number;
  tags: string[];
}

interface ModelsState {
  activeModelId: string | null;
  downloadedModels: LocalModel[];
  setActiveModel: (id: string | null) => void;
  addDownloadedModel: (model: LocalModel) => void;
  removeDownloadedModel: (id: string) => void;
}

export const useModelsStore = create<ModelsState>()(
  persist(
    (set) => ({
      activeModelId: null,
      downloadedModels: [],
      setActiveModel: (id) => set({ activeModelId: id }),
      addDownloadedModel: (model) => set((state) => ({ 
        downloadedModels: [...state.downloadedModels, model] 
      })),
      removeDownloadedModel: (id) => set((state) => ({ 
        downloadedModels: state.downloadedModels.filter(m => m.id !== id),
        activeModelId: state.activeModelId === id ? null : state.activeModelId
      })),
    }),
    {
      name: 'pocket-ai-models',
      storage: createJSONStorage(() => mmkvStorage),
    }
  )
);
