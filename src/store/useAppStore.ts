import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from '../store/storage';

export type ThemeMode = 'light' | 'dark';

export interface DeviceResources {
  totalRAM: number;
  availableRAM: number;
  cachedRAM: number;
  usedStoragePercentage: number;
  theme: ThemeMode;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  isStreaming?: boolean;
  speedTs?: number;
}

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  sizeBytes: number;
  status: 'active' | 'downloaded' | 'not_downloaded';
  memoryUsageRatio?: number;
}

interface AppState {
  deviceResources: DeviceResources;
  chatSessions: Record<string, ChatMessage[]>;
  aiModels: AIModel[];
  clearCache: () => void;
  toggleTheme: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      deviceResources: {
        totalRAM: 16.0,
        availableRAM: 4.2,
        cachedRAM: 2.1,
        usedStoragePercentage: 82,
        theme: 'dark',
      },
      chatSessions: {
        'mock_1': [
          { id: '1', role: 'user', content: 'Hello, AI!' },
          { id: '2', role: 'ai', content: 'Hello! How can I help you today?', speedTs: 42.5 }
        ]
      },
      aiModels: [
        { id: 'llama3-8b', name: 'Llama 3 (8B)', provider: 'Meta AI', sizeBytes: 4.2 * 1024 * 1024 * 1024, status: 'active', memoryUsageRatio: 4.2 / 8.0 },
        { id: 'mistral-7b', name: 'Mistral 7B', provider: 'Mistral AI', sizeBytes: 3.8 * 1024 * 1024 * 1024, status: 'downloaded' },
        { id: 'phi-3-mini', name: 'Phi-3 Mini', provider: 'Microsoft', sizeBytes: 2.1 * 1024 * 1024 * 1024, status: 'not_downloaded' },
      ],
      clearCache: () => set((state) => ({
        deviceResources: {
          ...state.deviceResources,
          availableRAM: state.deviceResources.availableRAM + state.deviceResources.cachedRAM,
          cachedRAM: 0,
        }
      })),
      toggleTheme: () => set((state) => ({
        deviceResources: {
          ...state.deviceResources,
          theme: state.deviceResources.theme === 'dark' ? 'light' : 'dark',
        }
      })),
    }),
    {
      name: 'pocket-ai-app-store',
      storage: createJSONStorage(() => mmkvStorage),
    }
  )
);
