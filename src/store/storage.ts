import { createStorage } from '../services/storage';
import { StateStorage } from 'zustand/middleware';

export const storage = createStorage('global-app-storage');

// Zustand persist middleware integration
export const mmkvStorage: StateStorage = {
  setItem: (name: string, value: string) => {
    return storage.set(name, value);
  },
  getItem: (name: string) => {
    const value = storage.getString(name);
    return value ?? null;
  },
  removeItem: (name: string) => {
    storage.remove(name);
  },
};
