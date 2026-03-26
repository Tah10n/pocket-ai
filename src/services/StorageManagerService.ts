import * as FileSystem from 'expo-file-system/legacy';
import { useChatStore } from '../store/chatStore';
import { storage as appStorage } from '../store/storage';
import { CACHE_DIR } from './FileSystemSetup';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import {
  CHAT_HISTORY_INDEX_KEY,
  CHAT_HISTORY_PREFIX,
  SETTINGS_KEY,
  clearLegacyChatHistory,
  resetSettings,
  storage as settingsStorage,
} from './SettingsStore';
import { LifecycleStatus, ModelMetadata } from '../types/models';

const CHAT_STORE_KEY = 'chat-store';
const MIN_DIRECTORY_SIZE_FALLBACK_BYTES = 0;
const ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR = 0.2;
const ESTIMATED_CONTEXT_BYTES_PER_TOKEN = 2 * 1024;
const MIN_ESTIMATED_CONTEXT_BYTES = 64 * 1024 * 1024;

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

function getLegacyChatHistoryBytes() {
  const legacyKeys = settingsStorage
    .getAllKeys()
    .filter((key) => key === CHAT_HISTORY_INDEX_KEY || key.startsWith(CHAT_HISTORY_PREFIX));

  return legacyKeys.reduce((sum, key) => {
    const value = settingsStorage.getString(key);
    return sum + getTextByteLength(key) + getTextByteLength(value);
  }, 0);
}

function getPersistedChatStoreBytes() {
  const persistedState = appStorage.getString(CHAT_STORE_KEY);
  return getTextByteLength(CHAT_STORE_KEY) + getTextByteLength(persistedState);
}

function getSettingsBytes() {
  const settingsValue = settingsStorage.getString(SETTINGS_KEY);
  return getTextByteLength(SETTINGS_KEY) + getTextByteLength(settingsValue);
}

function getActiveModelEstimateBytes() {
  const activeModelId = llmEngineService.getState().activeModelId ?? null;
  if (!activeModelId) {
    return 0;
  }

  const activeModel = registry.getModel(activeModelId);
  if (!activeModel) {
    return 0;
  }

  const baseModelBytes = Math.max(activeModel.size, 0);
  const contextBytes = Math.max(
    llmEngineService.getContextSize() * ESTIMATED_CONTEXT_BYTES_PER_TOKEN,
    MIN_ESTIMATED_CONTEXT_BYTES,
  );

  return Math.round(baseModelBytes * (1 + ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR) + contextBytes);
}

export async function getAppStorageMetrics(): Promise<AppStorageMetrics> {
  const downloadedModels = getDownloadedModels();
  const modelsBytes = downloadedModels.reduce((sum, model) => sum + Math.max(model.size, 0), 0);
  const [cacheBytes] = await Promise.all([
    getDirectorySizeBytes(CACHE_DIR),
  ]);
  const chatHistoryBytes = getPersistedChatStoreBytes() + getLegacyChatHistoryBytes();
  const settingsBytes = getSettingsBytes();

  return {
    downloadedModels,
    modelsBytes,
    cacheBytes,
    chatHistoryBytes,
    settingsBytes,
    appFilesBytes: modelsBytes + cacheBytes + chatHistoryBytes + settingsBytes,
    activeModelEstimateBytes: getActiveModelEstimateBytes(),
    activeModelId: llmEngineService.getState().activeModelId ?? null,
  };
}

export async function offloadModel(modelId: string) {
  if (llmEngineService.getState().activeModelId === modelId) {
    await llmEngineService.unload();
  }

  await registry.removeModel(modelId);
}

export async function clearActiveCache() {
  try {
    const cacheInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!cacheInfo.exists) {
      return 0;
    }

    const entries = await FileSystem.readDirectoryAsync(CACHE_DIR);
    await Promise.all(
      entries.map((entryName) => FileSystem.deleteAsync(`${CACHE_DIR}${entryName}`, { idempotent: true })),
    );

    return entries.length;
  } catch (error) {
    console.warn('[StorageManagerService] Failed to clear cache directory', error);
    throw error;
  }
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
