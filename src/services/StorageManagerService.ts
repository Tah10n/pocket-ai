import * as FileSystem from 'expo-file-system/legacy';
import { useChatStore } from '../store/chatStore';
import { storage as appStorage } from '../store/storage';
import { CACHE_DIR, MODELS_DIR } from './FileSystemSetup';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { modelCatalogService } from './ModelCatalogService';
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

const CHAT_STORE_KEY = 'chat-store';
const MIN_DIRECTORY_SIZE_FALLBACK_BYTES = 0;
const MIN_ESTIMATED_CONTEXT_BYTES = 64 * 1024 * 1024;

type PersistedChatStorePayload = {
  state?: {
    threads?: Record<string, unknown>;
    activeThreadId?: string | null;
  };
};

export interface AppStorageMetrics {
  downloadedModels: ModelMetadata[];
  modelsBytes: number;
  cacheBytes: number;
  chatHistoryBytes: number;
  settingsBytes: number;
  appFilesBytes: number;
  activeModelEstimateBytes: number;
  activeModelId: string | null;
}

interface OffloadModelOptions {
  preserveSettings?: boolean;
}

function getTextByteLength(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }

  return unescape(encodeURIComponent(value)).length;
}

async function getDirectorySizeBytes(directoryUri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(directoryUri);
    if (!info.exists) {
      return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
    }

    const entries = await FileSystem.readDirectoryAsync(directoryUri);
    if (entries.length === 0) {
      return 0;
    }

    const entrySizes = await Promise.all(
      entries.map(async (entryName) => {
        const entryUri = `${directoryUri}${entryName}`;
        const entryInfo = await FileSystem.getInfoAsync(entryUri);

        if (!entryInfo.exists) {
          return 0;
        }

        if ((entryInfo as { isDirectory?: boolean }).isDirectory) {
          return getDirectorySizeBytes(`${entryUri}/`);
        }

        return typeof entryInfo.size === 'number' ? entryInfo.size : 0;
      }),
    );

    return entrySizes.reduce((sum, size) => sum + size, 0);
  } catch (error) {
    console.warn('[StorageManagerService] Failed to read directory size', directoryUri, error);
    return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
  }
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

  try {
    const info = await FileSystem.getInfoAsync(`${MODELS_DIR}${model.localPath}`);
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
  const persistedState = appStorage.getString(CHAT_STORE_KEY);
  if (!persistedState) {
    return 0;
  }

  try {
    const parsed = JSON.parse(persistedState) as PersistedChatStorePayload;
    const threads = parsed?.state?.threads;
    const activeThreadId = parsed?.state?.activeThreadId ?? null;
    const threadCount =
      threads && typeof threads === 'object' && !Array.isArray(threads)
        ? Object.keys(threads).length
        : 0;

    if (threadCount === 0 && activeThreadId === null) {
      return 0;
    }
  } catch {
    // If the persisted payload is corrupted, still count its occupied bytes.
  }

  return getTextByteLength(CHAT_STORE_KEY) + getTextByteLength(persistedState);
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

export async function getAppStorageMetrics(): Promise<AppStorageMetrics> {
  const downloadedModels = await getDownloadedModelsWithResolvedSizes();
  const modelsBytes = downloadedModels.reduce((sum, model) => sum + Math.max(model.size ?? 0, 0), 0);
  const [cacheDirectoryBytes] = await Promise.all([
    getDirectorySizeBytes(CACHE_DIR),
  ]);
  const cacheBytes = cacheDirectoryBytes + modelCatalogService.getPersistentCacheBytes();
  const chatHistoryBytes = getPersistedChatStoreBytes() + getLegacyChatHistoryBytes();
  const settingsBytes = getSettingsBytes();
  const activeModelEstimateBytes = await getActiveModelEstimateBytes(downloadedModels);

  return {
    downloadedModels,
    modelsBytes,
    cacheBytes,
    chatHistoryBytes,
    settingsBytes,
    appFilesBytes: modelsBytes + cacheBytes + chatHistoryBytes + settingsBytes,
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
  let clearedEntries = 0;
  let firstError: unknown = null;

  try {
    const cacheInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (cacheInfo.exists) {
      const entries = await FileSystem.readDirectoryAsync(CACHE_DIR);
      await Promise.all(
        entries.map((entryName) => FileSystem.deleteAsync(`${CACHE_DIR}${entryName}`, { idempotent: true })),
      );

      clearedEntries = entries.length;
    }
  } catch (error) {
    console.warn('[StorageManagerService] Failed to clear cache directory', error);
    firstError = error;
  }

  try {
    modelCatalogService.clearCache();
  } catch (error) {
    console.warn('[StorageManagerService] Failed to clear catalog cache', error);
    firstError ??= error;
  }

  if (firstError) {
    throw firstError;
  }

  return clearedEntries;
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
