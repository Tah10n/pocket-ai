import * as FileSystem from 'expo-file-system/legacy';

function resolveBaseDirectory(base: string | null, suffix: string): string | null {
  if (!base) {
    return null;
  }

  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${suffix}`;
}

export function getModelsDir(): string | null {
  return resolveBaseDirectory(FileSystem.documentDirectory ?? null, 'models/');
}

export function getCacheDir(): string | null {
  return resolveBaseDirectory(FileSystem.cacheDirectory ?? null, 'models-cache/');
}

export async function setupFileSystem(): Promise<void> {
  try {
    const modelsDir = getModelsDir();
    const cacheDir = getCacheDir();

    if (!modelsDir || !cacheDir) {
      return;
    }

    const modelsDirInfo = await FileSystem.getInfoAsync(modelsDir);
    if (!modelsDirInfo.exists) {
      await FileSystem.makeDirectoryAsync(modelsDir, { intermediates: true });
    }

    const cacheDirInfo = await FileSystem.getInfoAsync(cacheDir);
    if (!cacheDirInfo.exists) {
      await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
    }
  } catch (e) {
    console.error('[FileSystemSetup] Failed to setup base directories', e);
    throw e;
  }
}
