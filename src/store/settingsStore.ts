import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from './storage';

export type ThemeMode = 'Light' | 'Dark';

interface SettingsState {
  theme: ThemeMode;
  language: string;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'Dark',
      language: 'English (US)',
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: 'pocket-ai-settings',
      storage: createJSONStorage(() => mmkvStorage),
    }
  )
);
