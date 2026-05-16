import * as FileSystem from 'expo-file-system/legacy';
import { useChatStore } from '../store/chatStore';
import { getQueuedDownloadFileNames } from '../store/downloadStore';
import { storage as appStorage } from '../store/storage';
import { getCacheDir, getModelsDir } from './FileSystemSetup';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { modelCatalogService } from './ModelCatalogService';
import { safeJoinModelPath } from '../utils/safeFilePath';
import {
  CHAT_HISTORY_INDEX_KEY,
  CHAT_HISTORY_PREFIX,
  SETTINGS_KEY,
  clearLegacyChatHistory,
  resetAllParametersForModel,
  resetSettings,
  storage as settingsStorage,
} from './SettingsStore';
import { LifecycleStatus, ModelMetadata } from '../types/models';
import {
  ESTIMATED_CONTEXT_BYTES_PER_TOKEN,
  ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR,
} from '../utils/contextWindow';
import {
  CHAT_PERSISTENCE_INDEX_KEY,
  CHAT_THREAD_STORAGE_KEY_PREFIX,
  LEGACY_CHAT_STORE_STORAGE_KEY,
} from '../store/chatPersistence';

const CHAT_STORE_KEY = LEGACY_CHAT_STORE_STORAGE_KEY;
const MIN_DIRECTORY_SIZE_FALLBACK_BYTES = 0;
const MIN_ESTIMATED_CONTEXT_BYTES = 64 * 1024 * 1024;
const DIRECTORY_SIZE_CACHE_TTL_MS = 5000;
const DIRECTORY_SIZE_MAX_CONCURRENT_STATS = 8;

type PersistedChatStorePayload = {
  state?: {
    threads?: Record<string, unknown>;
    activeThreadId?: string | null;
  };
};

export interface AppStorageMetrics {
  downloadedModels: ModelMetadata[];
  modelsBytes: number;
  quarantinedModelFiles: QuarantinedModelFilesMetrics;
  cacheBytes: number;
  chatHistoryBytes: number;
  settingsBytes: number;
  appFilesBytes: number;
  activeModelEstimateBytes: number;
  activeModelId: string | null;
}

export interface QuarantinedModelFilesMetrics {
  fileNames: string[];
  count: number;
  bytes: number;
}

export interface AppStorageMetricsOptions {
  refreshModelFileQuarantine?: boolean;
}

interface OffloadModelOptions {
  preserveSettings?: boolean;
}

type DirectorySizeCacheEntry = {
  measuredAt: number;
  sizeBytes: number;
};

type DirectoryStatLimiter = <T>(task: () => Promise<T>) => Promise<T>;

const directorySizeCache = new Map<string, DirectorySizeCacheEntry>();

function getTextByteLength(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }

  return unescape(encodeURIComponent(value)).length;
}

function normalizeDirectoryUri(directoryUri: string): string {
  return directoryUri.endsWith('/') ? directoryUri : `${directoryUri}/`;
}

function joinDirectoryEntryUri(directoryUri: string, entryName: string): string {
  return `${normalizeDirectoryUri(directoryUri)}${entryName}`;
}

function createDirectoryStatLimiter(maxConcurrent: number): DirectoryStatLimiter {
  const queue: (() => void)[] = [];
  let activeCount = 0;

  const drainQueue = () => {
    if (activeCount >= maxConcurrent) {
      return;
    }

    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const run = () => {
      activeCount += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeCount -= 1;
          drainQueue();
        });
    };

    if (activeCount < maxConcurrent) {
      run();
    } else {
      queue.push(run);
    }
  });
}

function getCachedDirectorySize(directoryUri: string): number | null {
  const cached = directorySizeCache.get(directoryUri);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.measuredAt > DIRECTORY_SIZE_CACHE_TTL_MS) {
    directorySizeCache.delete(directoryUri);
    return null;
  }

  return cached.sizeBytes;
}

async function getDirectorySizeBytes(
  directoryUri: string,
  statLimiter = createDirectoryStatLimiter(DIRECTORY_SIZE_MAX_CONCURRENT_STATS),
): Promise<number> {
  const normalizedDirectoryUri = normalizeDirectoryUri(directoryUri);
  const cachedSize = getCachedDirectorySize(normalizedDirectoryUri);
  if (cachedSize !== null) {
    return cachedSize;
  }

  try {
    const info = await FileSystem.getInfoAsync(normalizedDirectoryUri);
    if (!info.exists) {
      directorySizeCache.set(normalizedDirectoryUri, {
        measuredAt: Date.now(),
        sizeBytes: MIN_DIRECTORY_SIZE_FALLBACK_BYTES,
      });
      return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
    }

    const entries = await FileSystem.readDirectoryAsync(normalizedDirectoryUri);
    if (entries.length === 0) {
      directorySizeCache.set(normalizedDirectoryUri, {
        measuredAt: Date.now(),
        sizeBytes: 0,
      });
      return 0;
    }

    const entrySizes = await Promise.all(
      entries.map(async (entryName) => {
        const entryUri = joinDirectoryEntryUri(normalizedDirectoryUri, entryName);
        const entryInfo = await statLimiter(() => FileSystem.getInfoAsync(entryUri));

        if (!entryInfo.exists) {
          return 0;
        }

        if ((entryInfo as { isDirectory?: boolean }).isDirectory) {
          return getDirectorySizeBytes(entryUri, statLimiter);
        }

        return typeof entryInfo.size === 'number' ? entryInfo.size : 0;
      }),
    );

    const sizeBytes = entrySizes.reduce((sum, size) => sum + size, 0);
    directorySizeCache.set(normalizedDirectoryUri, {
      measuredAt: Date.now(),
      sizeBytes,
    });
    return sizeBytes;
  } catch (error) {
    console.warn('[StorageManagerService] Failed to read directory size', normalizedDirectoryUri, error);
    return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
  }
}

export function __resetStorageManagerDirectorySizeCacheForTests(): void {
  directorySizeCache.clear();
}

function getDownloadedModels() {
  return registry.getModels().filter((model) => (
    model.lifecycleStatus === LifecycleStatus.DOWNLOADED
    || model.lifecycleStatus === LifecycleStatus.ACTIVE
  ));
}

async function resolveStoredModelSize(model: ModelMetadata): Promise<number | null> {
  if (!model.localPath) {
    return model.size ?? null;
  }

  const modelsDir = getModelsDir();
  if (!modelsDir) {
    return model.size ?? null;
  }

  try {
    const localUri = safeJoinModelPath(modelsDir, model.localPath);
    if (!localUri) {
      return model.size ?? null;
    }

    const info = await FileSystem.getInfoAsync(localUri);
    if (
      info.exists &&
      typeof info.size === 'number' &&
      Number.isFinite(info.size) &&
      info.size > 0
    ) {
      return Math.round(info.size);
    }
  } catch {
    // Fall back to persisted metadata when local stat lookup fails.
  }

  return model.size ?? null;
}

async function getDownloadedModelsWithResolvedSizes(): Promise<ModelMetadata[]> {
  const downloadedModels = getDownloadedModels();
  const resolvedSizes = await Promise.all(
    downloadedModels.map((model) => resolveStoredModelSize(model)),
  );

  return downloadedModels.map((model, index) => {
    const resolvedSize = resolvedSizes[index];
    return resolvedSize !== null && resolvedSize !== model.size
      ? { ...model, size: resolvedSize }
      : model;
  });
}

async function getQuarantinedModelFilesMetrics(): Promise<QuarantinedModelFilesMetrics> {
  const fileNames = registry.getQuarantinedModelFileNames();
  const modelsDir = getModelsDir();

  if (!modelsDir || fileNames.length === 0) {
    return {
      fileNames,
      count: fileNames.length,
      bytes: 0,
    };
  }

  const sizes = await Promise.all(
    fileNames.map(async (fileName) => {
      const fileUri = safeJoinModelPath(modelsDir, fileName);
      if (!fileUri) {
        return 0;
      }

      try {
        const info = await FileSystem.getInfoAsync(fileUri);
        if (
          info.exists
          && !(info as { isDirectory?: boolean }).isDirectory
          && typeof info.size === 'number'
          && Number.isFinite(info.size)
          && info.size > 0
        ) {
          return Math.round(info.size);
        }
      } catch {
        // Keep the file visible in quarantine metrics even if size probing fails.
      }

      return 0;
    }),
  );

  return {
    fileNames,
    count: fileNames.length,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
  };
}

async function refreshModelFileQuarantine() {
  try {
    await registry.validateRegistry(getQueuedDownloadFileNames());
  } catch (error) {
    console.warn('[StorageManagerService] Failed to refresh model file quarantine', error);
  }
}

function getLegacyChatHistoryBytes() {
  const legacyKeys = settingsStorage
    .getAllKeys()
    .filter((key) => key === CHAT_HISTORY_INDEX_KEY || key.startsWith(CHAT_HISTORY_PREFIX));

  return legacyKeys.reduce((sum, key) => {
    const value = settingsStorage.getString(key);
    if (key === CHAT_HISTORY_INDEX_KEY) {
      try {
        const parsed = value ? JSON.parse(value) : [];
        if (Array.isArray(parsed) && parsed.length === 0) {
          return sum;
        }
      } catch {
        // If the legacy index is corrupted, still count its occupied bytes.
      }
    }

    return sum + getTextByteLength(key) + getTextByteLength(value);
  }, 0);
}

function getPersistedChatStoreBytes() {
  const chatKeys = appStorage.getAllKeys().filter((key) => (
    key === CHAT_STORE_KEY ||
    key === CHAT_PERSISTENCE_INDEX_KEY ||
    key.startsWith(CHAT_THREAD_STORAGE_KEY_PREFIX)
  ));

  return chatKeys.reduce((sum, key) => {
    const value = appStorage.getString(key);
    if (key === CHAT_STORE_KEY) {
      try {
        const parsed = JSON.parse(value ?? '') as PersistedChatStorePayload;
        const threads = parsed?.state?.threads;
        const activeThreadId = parsed?.state?.activeThreadId ?? null;
        const threadCount =
          threads && typeof threads === 'object' && !Array.isArray(threads)
            ? Object.keys(threads).length
            : 0;

        if (threadCount === 0 && activeThreadId === null) {
          return sum;
        }
      } catch {
        // If the persisted payload is corrupted, still count its occupied bytes.
      }
    }

    if (key === CHAT_PERSISTENCE_INDEX_KEY) {
      try {
        const parsed = JSON.parse(value ?? '') as { activeThreadId?: unknown; threadIds?: unknown };
        if (
          parsed.activeThreadId === null &&
          Array.isArray(parsed.threadIds) &&
          parsed.threadIds.length === 0
        ) {
          return sum;
        }
      } catch {
        // If the persisted index is corrupted, still count its occupied bytes.
      }
    }

    return sum + getTextByteLength(key) + getTextByteLength(value);
  }, 0);
}

function getSettingsBytes() {
  const settingsValue = settingsStorage.getString(SETTINGS_KEY);
  return getTextByteLength(SETTINGS_KEY) + getTextByteLength(settingsValue);
}

async function getActiveModelEstimateBytes(downloadedModels: ModelMetadata[]) {
  const activeModelId = llmEngineService.getState().activeModelId ?? null;
  if (!activeModelId) {
    return 0;
  }

  const activeModel = downloadedModels.find((model) => model.id === activeModelId)
    ?? registry.getModel(activeModelId);
  if (!activeModel) {
    return 0;
  }

  const baseModelBytes = Math.max(await resolveStoredModelSize(activeModel) ?? 0, 0);
  const contextBytes = Math.max(
    llmEngineService.getContextSize() * ESTIMATED_CONTEXT_BYTES_PER_TOKEN,
    MIN_ESTIMATED_CONTEXT_BYTES,
  );

  return Math.round(baseModelBytes * (1 + ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR) + contextBytes);
}

export async function getAppStorageMetrics(options: AppStorageMetricsOptions = {}): Promise<AppStorageMetrics> {
  if (options.refreshModelFileQuarantine) {
    directorySizeCache.clear();
    await refreshModelFileQuarantine();
  }

  const downloadedModels = await getDownloadedModelsWithResolvedSizes();
  const modelsBytes = downloadedModels.reduce((sum, model) => sum + Math.max(model.size ?? 0, 0), 0);
  const cacheDir = getCacheDir();
  const [quarantinedModelFiles, cacheDirectoryBytes] = await Promise.all([
    getQuarantinedModelFilesMetrics(),
    cacheDir ? getDirectorySizeBytes(cacheDir) : Promise.resolve(0),
  ]);
  const cacheBytes = cacheDirectoryBytes + modelCatalogService.getPersistentCacheBytes();
  const chatHistoryBytes = getPersistedChatStoreBytes() + getLegacyChatHistoryBytes();
  const settingsBytes = getSettingsBytes();
  const activeModelEstimateBytes = await getActiveModelEstimateBytes(downloadedModels);

  return {
    downloadedModels,
    modelsBytes,
    quarantinedModelFiles,
    cacheBytes,
    chatHistoryBytes,
    settingsBytes,
    appFilesBytes: modelsBytes + quarantinedModelFiles.bytes + cacheBytes + chatHistoryBytes + settingsBytes,
    activeModelEstimateBytes,
    activeModelId: llmEngineService.getState().activeModelId ?? null,
  };
}

export async function offloadModel(modelId: string, options?: OffloadModelOptions) {
  const preserveSettings = options?.preserveSettings !== false;

  if (llmEngineService.getState().activeModelId === modelId) {
    await llmEngineService.unload();
  }

  await registry.removeModel(modelId);

  if (!preserveSettings) {
    resetAllParametersForModel(modelId);
  }
}

export async function clearActiveCache() {
  directorySizeCache.clear();

  const deleteWithRetry = async (uri: string) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        return;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }

    throw lastError;
  };

  let clearedEntries = 0;
  let firstError: unknown = null;
  const cacheDir = getCacheDir();

  try {
    if (cacheDir) {
      const cacheInfo = await FileSystem.getInfoAsync(cacheDir);
      if (cacheInfo.exists) {
        const entries = await FileSystem.readDirectoryAsync(cacheDir);
        for (const entryName of entries) {
          try {
            await deleteWithRetry(`${cacheDir}${entryName}`);
            clearedEntries += 1;
          } catch (error) {
            console.warn('[StorageManagerService] Failed to delete cache entry', entryName, error);
            firstError ??= error;
          }
        }
      }
    }
  } catch (error) {
    console.warn('[StorageManagerService] Failed to clear cache directory', error);
    firstError = error;
  }

  try {
    modelCatalogService.clearCache('manual');
  } catch (error) {
    console.warn('[StorageManagerService] Failed to clear catalog cache', error);
    firstError ??= error;
  }

  if (firstError) {
    throw firstError;
  }

  return clearedEntries;
}

export async function cleanupQuarantinedModelFiles() {
  directorySizeCache.clear();
  const getCurrentQueuedModelFileNames = () => getQueuedDownloadFileNames();
  await registry.validateRegistry(getCurrentQueuedModelFileNames());

  const fileNames = registry.getQuarantinedModelFileNames();
  let deletedCount = 0;
  let firstError: unknown = null;

  for (const fileName of fileNames) {
    try {
      deletedCount += await registry.deleteQuarantinedModelFiles(
        [fileName],
        getCurrentQueuedModelFileNames,
      );
    } catch (error) {
      console.warn('[StorageManagerService] Failed to delete quarantined model file', fileName, error);
      firstError ??= error;
    }
  }

  directorySizeCache.clear();

  if (firstError) {
    throw firstError;
  }

  return deletedCount;
}

export async function clearChatHistory() {
  await llmEngineService.interruptActiveCompletion();
  const removedThreads = useChatStore.getState().clearAllThreads();
  const removedLegacyEntries = clearLegacyChatHistory();
  return removedThreads + removedLegacyEntries;
}

export async function resetAppSettings() {
  if (llmEngineService.getState().activeModelId) {
    await llmEngineService.unload();
  }

  return resetSettings();
}
