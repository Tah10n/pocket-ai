import type { MMKV } from 'react-native-mmkv';
import { StateStorage } from 'zustand/middleware';
import { createStorage } from '../services/storage';

let storageInstance: MMKV | null = null;

export function getAppStorage(): MMKV {
  if (!storageInstance) {
    storageInstance = createStorage('global-app-storage', { tier: 'private' });
  }

  return storageInstance;
}

export type AppStorageFacade = Pick<
  MMKV,
  'set' | 'getString' | 'getNumber' | 'getBoolean' | 'remove' | 'clearAll' | 'contains' | 'getAllKeys'
>;

export const storage: AppStorageFacade = {
  set: (key: string, value: boolean | string | number | ArrayBuffer) => getAppStorage().set(key, value),
  getString: (key: string) => getAppStorage().getString(key),
  getNumber: (key: string) => getAppStorage().getNumber(key),
  getBoolean: (key: string) => getAppStorage().getBoolean(key),
  remove: (key: string) => getAppStorage().remove(key),
  clearAll: () => getAppStorage().clearAll(),
  contains: (key: string) => getAppStorage().contains(key),
  getAllKeys: () => getAppStorage().getAllKeys(),
};

// Zustand persist middleware integration
export const mmkvStorage: StateStorage = {
  setItem: (name: string, value: string) => {
    return getAppStorage().set(name, value);
  },
  getItem: (name: string) => {
    const value = getAppStorage().getString(name);
    return value ?? null;
  },
  removeItem: (name: string) => {
    getAppStorage().remove(name);
  },
};
