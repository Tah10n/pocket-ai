jest.mock('../../src/store/chatStore', () => ({
  useChatStore: {
    getState: jest.fn(),
  },
}));

jest.mock('../../src/store/storage', () => ({
  storage: {
    getString: jest.fn(),
  },
}));

jest.mock('../../src/services/FileSystemSetup', () => ({
  getCacheDir: () => 'test-cache/',
  getModelsDir: () => 'test-models/',
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    getState: jest.fn().mockReturnValue({ activeModelId: null }),
    getContextSize: jest.fn().mockReturnValue(2048),
    interruptActiveCompletion: jest.fn().mockResolvedValue(undefined),
    unload: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModels: jest.fn().mockReturnValue([]),
    getModel: jest.fn(),
    removeModel: jest.fn(),
  },
}));

jest.mock('../../src/services/ModelCatalogService', () => ({
  modelCatalogService: {
    getPersistentCacheBytes: jest.fn().mockReturnValue(0),
    clearCache: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  CHAT_HISTORY_INDEX_KEY: 'chat_history_index',
  CHAT_HISTORY_PREFIX: 'chat_history_',
  SETTINGS_KEY: 'app_settings',
  clearLegacyChatHistory: jest.fn(),
  resetAllParametersForModel: jest.fn(),
  resetSettings: jest.fn(),
  storage: {
    getAllKeys: jest.fn().mockReturnValue([]),
    getString: jest.fn(),
  },
}));

import { clearChatHistory } from '../../src/services/StorageManagerService';
import { clearActiveCache } from '../../src/services/StorageManagerService';
import { getAppStorageMetrics } from '../../src/services/StorageManagerService';
import { offloadModel } from '../../src/services/StorageManagerService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { modelCatalogService } from '../../src/services/ModelCatalogService';
import {
  clearLegacyChatHistory,
  resetAllParametersForModel,
  storage as settingsStorage,
} from '../../src/services/SettingsStore';
import { useChatStore } from '../../src/store/chatStore';
import { storage as appStorage } from '../../src/store/storage';
import * as FileSystem from 'expo-file-system/legacy';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

const mockedRegistry = registry as jest.Mocked<typeof registry>;
const mockedModelCatalogService = modelCatalogService as jest.Mocked<typeof modelCatalogService>;
const mockedAppStorage = appStorage as jest.Mocked<typeof appStorage>;
const mockedSettingsStorage = settingsStorage as jest.Mocked<typeof settingsStorage>;

function createDownloadedModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'model',
    author: 'org',
    size: null,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    localPath: 'org_model.gguf',
    fitsInRam: null,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
    ...overrides,
  };
}

describe('StorageManagerService', () => {
  const mockClearAllThreads = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockClearAllThreads.mockReturnValue(2);
    (clearLegacyChatHistory as jest.Mock).mockReturnValue(3);
    (useChatStore.getState as jest.Mock).mockReturnValue({
      clearAllThreads: mockClearAllThreads,
    });
    mockedRegistry.getModels.mockReturnValue([]);
    mockedRegistry.getModel.mockReturnValue(undefined);
    mockedModelCatalogService.getPersistentCacheBytes.mockReturnValue(0);
    mockedAppStorage.getString.mockReturnValue(undefined);
    mockedSettingsStorage.getAllKeys.mockReturnValue([]);
    mockedSettingsStorage.getString.mockReturnValue(undefined);
    (llmEngineService.getState as jest.Mock).mockReturnValue({ activeModelId: null });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/org_model.gguf') {
        return { exists: true, size: 4096 };
      }

      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([]);
  });

  it('interrupts active completions before clearing persisted chat history', async () => {
    await expect(clearChatHistory()).resolves.toBe(5);

    expect(llmEngineService.interruptActiveCompletion).toHaveBeenCalledTimes(1);
    expect(mockClearAllThreads).toHaveBeenCalledTimes(1);
    expect(clearLegacyChatHistory).toHaveBeenCalledTimes(1);
    expect(
      (llmEngineService.interruptActiveCompletion as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(mockClearAllThreads.mock.invocationCallOrder[0]);
  });

  it('uses the actual downloaded file size when persisted model metadata is unknown', async () => {
    mockedRegistry.getModels.mockReturnValue([createDownloadedModel()]);

    const metrics = await getAppStorageMetrics();

    expect(metrics.downloadedModels).toHaveLength(1);
    expect(metrics.downloadedModels[0].size).toBe(4096);
    expect(metrics.modelsBytes).toBe(4096);
  });

  it('includes persisted catalog cache in app cache usage', async () => {
    mockedModelCatalogService.getPersistentCacheBytes.mockReturnValue(1024);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true };
      }

      if (uri === 'test-cache/catalog.json') {
        return { exists: true, size: 512 };
      }

      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-cache/' ? ['catalog.json'] : []
    ));

    const metrics = await getAppStorageMetrics();

    expect(metrics.cacheBytes).toBe(1536);
    expect(metrics.appFilesBytes).toBe(1548);
  });

  it('treats an empty persisted chat-store payload as zero chat history bytes', async () => {
    mockedAppStorage.getString.mockImplementation((key: string) => (
      key === 'chat-store'
        ? JSON.stringify({ state: { threads: {}, activeThreadId: null }, version: 0 })
        : undefined
    ));

    const metrics = await getAppStorageMetrics();

    expect(metrics.chatHistoryBytes).toBe(0);
  });

  it('treats an empty legacy chat history index as zero chat history bytes', async () => {
    mockedSettingsStorage.getAllKeys.mockReturnValue(['chat_history_index']);
    mockedSettingsStorage.getString.mockImplementation((key: string) => (
      key === 'chat_history_index' ? '[]' : undefined
    ));

    const metrics = await getAppStorageMetrics();

    expect(metrics.chatHistoryBytes).toBe(0);
  });

  it('uses the actual downloaded file size when estimating active model memory usage', async () => {
    const downloadedModel = createDownloadedModel({ id: 'org/active-model', localPath: 'org_model.gguf' });
    mockedRegistry.getModels.mockReturnValue([downloadedModel]);
    mockedRegistry.getModel.mockReturnValue(downloadedModel);
    (llmEngineService.getState as jest.Mock).mockReturnValue({ activeModelId: 'org/active-model' });

    const metrics = await getAppStorageMetrics();

    expect(metrics.activeModelEstimateBytes).toBe(
      Math.round(4096 * 1.2 + 64 * 1024 * 1024),
    );
  });

  it('clears persisted catalog cache even when the file cache directory is empty', async () => {
    await expect(clearActiveCache()).resolves.toBe(0);

    expect(mockedModelCatalogService.clearCache).toHaveBeenCalledTimes(1);
    expect(mockedModelCatalogService.clearCache).toHaveBeenCalledWith('manual');
  });

  it('preserves persisted per-model settings by default when offloading a model', async () => {
    await expect(offloadModel('org/model')).resolves.toBeUndefined();

    expect(mockedRegistry.removeModel).toHaveBeenCalledWith('org/model');
    expect(resetAllParametersForModel).not.toHaveBeenCalled();
  });

  it('can clear persisted per-model settings while offloading a model', async () => {
    await expect(offloadModel('org/model', { preserveSettings: false })).resolves.toBeUndefined();

    expect(mockedRegistry.removeModel).toHaveBeenCalledWith('org/model');
    expect(resetAllParametersForModel).toHaveBeenCalledWith('org/model');
  });

  it('unloads the active model before removing it and optionally resetting its settings', async () => {
    (llmEngineService.getState as jest.Mock).mockReturnValue({ activeModelId: 'org/model' });
    (llmEngineService.unload as jest.Mock).mockResolvedValue(undefined);

    await expect(offloadModel('org/model', { preserveSettings: false })).resolves.toBeUndefined();

    expect(llmEngineService.unload).toHaveBeenCalledTimes(1);
    expect(mockedRegistry.removeModel).toHaveBeenCalledWith('org/model');
    expect(resetAllParametersForModel).toHaveBeenCalledWith('org/model');
    expect((llmEngineService.unload as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      mockedRegistry.removeModel.mock.invocationCallOrder[0],
    );
  });
});
