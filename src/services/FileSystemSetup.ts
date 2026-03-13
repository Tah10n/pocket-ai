/* eslint-disable import/namespace */
import * as FileSystem from 'expo-file-system/legacy';

// @ts-ignore
export const MODELS_DIR = `${FileSystem.documentDirectory}models/`;
// @ts-ignore
export const CACHE_DIR = `${FileSystem.cacheDirectory}models-cache/`;

export async function setupFileSystem(): Promise<void> {
  try {
    const modelsDirInfo = await FileSystem.getInfoAsync(MODELS_DIR);
    if (!modelsDirInfo.exists) {
      await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
    }

    const cacheDirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!cacheDirInfo.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
  } catch (e) {
    console.error('[FileSystemSetup] Failed to setup base directories', e);
    throw e;
  }
}
