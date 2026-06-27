jest.mock('../../src/store/chatStore', () => ({
  useChatStore: {
    getState: jest.fn(),
  },
}));

jest.mock('../../src/store/downloadStore', () => ({
  getQueuedDownloadFileNames: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/store/storage', () => ({
  storage: {
    getAllKeys: jest.fn().mockReturnValue([]),
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
    ensurePersistedCapabilitySnapshot: jest.fn().mockReturnValue(null),
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
    validateRegistry: jest.fn().mockResolvedValue(undefined),
    getQuarantinedModelFileNames: jest.fn().mockReturnValue([]),
    deleteQuarantinedModelFiles: jest.fn().mockResolvedValue(0),
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
import { cleanupQuarantinedModelFiles } from '../../src/services/StorageManagerService';
import { getAppStorageMetrics } from '../../src/services/StorageManagerService';
import { __resetStorageManagerDirectorySizeCacheForTests } from '../../src/services/StorageManagerService';
import { offloadModel } from '../../src/services/StorageManagerService';
import { resetAppSettings } from '../../src/services/StorageManagerService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { modelCatalogService } from '../../src/services/ModelCatalogService';
import {
  clearLegacyChatHistory,
  resetAllParametersForModel,
  resetSettings,
  storage as settingsStorage,
} from '../../src/services/SettingsStore';
import { useChatStore } from '../../src/store/chatStore';
import { getQueuedDownloadFileNames } from '../../src/store/downloadStore';
import { storage as appStorage } from '../../src/store/storage';
import { CHAT_PERSISTENCE_INDEX_KEY, getChatThreadStorageKey } from '../../src/store/chatPersistence';
import * as FileSystem from 'expo-file-system/legacy';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

const mockedRegistry = registry as jest.Mocked<typeof registry>;
const mockedModelCatalogService = modelCatalogService as jest.Mocked<typeof modelCatalogService>;
const mockedAppStorage = appStorage as jest.Mocked<typeof appStorage>;
const mockedSettingsStorage = settingsStorage as jest.Mocked<typeof settingsStorage>;
const mockedGetQueuedDownloadFileNames = getQueuedDownloadFileNames as jest.MockedFunction<typeof getQueuedDownloadFileNames>;

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

function createDownloadedProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'org/model:projector',
    ownerModelId: 'org/model',
    repoId: 'org/model',
    fileName: 'mmproj-model.gguf',
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model.gguf',
    size: 1024,
    localPath: 'mmproj-model.gguf',
    lifecycleStatus: 'downloaded',
    matchStatus: 'matched',
    ...overrides,
  };
}

describe('StorageManagerService', () => {
  const mockClearAllThreads = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    __resetStorageManagerDirectorySizeCacheForTests();
    mockClearAllThreads.mockReturnValue(2);
    (clearLegacyChatHistory as jest.Mock).mockReturnValue(3);
    (useChatStore.getState as jest.Mock).mockReturnValue({
      clearAllThreads: mockClearAllThreads,
    });
    mockedRegistry.getModels.mockReturnValue([]);
    mockedRegistry.getModel.mockReturnValue(undefined);
    mockedRegistry.validateRegistry.mockResolvedValue(undefined);
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue([]);
    mockedRegistry.deleteQuarantinedModelFiles.mockResolvedValue(0);
    mockedGetQueuedDownloadFileNames.mockReturnValue([]);
    mockedModelCatalogService.getPersistentCacheBytes.mockReturnValue(0);
    mockedAppStorage.getAllKeys.mockReturnValue([]);
    mockedAppStorage.getString.mockReturnValue(undefined);
    mockedSettingsStorage.getAllKeys.mockReturnValue([]);
    mockedSettingsStorage.getString.mockReturnValue(undefined);
    (FileSystem.deleteAsync as jest.Mock).mockReset().mockResolvedValue(undefined);
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

  it('logs directory size failures without raw paths or throwable objects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.getInfoAsync as jest.Mock).mockRejectedValueOnce(new Error('secret test-cache/cache-entry.bin'));

    try {
      const metrics = await getAppStorageMetrics();

      expect(metrics.cacheBytes).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        '[StorageManagerService] Failed to read directory size',
        expect.objectContaining({
          pathCategory: 'cache_storage',
          scope: 'directory_size',
          errorName: 'Error',
        }),
      );
      expect(warnSpy.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('test-cache/cache-entry.bin');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('test-cache/');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('includes downloaded projector file sizes in model storage metrics', async () => {
    mockedRegistry.getModels.mockReturnValue([
      createDownloadedModel({
        projectorCandidates: [
          createDownloadedProjector({ size: 1024, localPath: 'mmproj-model.gguf' }),
          createDownloadedProjector({
            id: 'org/model:remote-projector',
            fileName: 'remote-mmproj.gguf',
            localPath: undefined,
            size: 8192,
            lifecycleStatus: 'available',
          }),
        ],
      }),
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/org_model.gguf') {
        return { exists: true, size: 4096 };
      }

      if (uri === 'test-models/mmproj-model.gguf') {
        return { exists: true, size: 2048 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(FileSystem.getInfoAsync).toHaveBeenCalledWith('test-models/mmproj-model.gguf');
    expect(metrics.downloadedModels[0].size).toBe(4096);
    expect(metrics.modelsBytes).toBe(6144);
    expect(metrics.downloadedModels[0].projectorCandidates?.[0]).toEqual(
      expect.objectContaining({
        id: 'org/model:projector',
        size: 2048,
      }),
    );
  });

  it('includes existing failed projector partial files in model storage metrics', async () => {
    mockedRegistry.getModels.mockReturnValue([
      createDownloadedModel({
        projectorCandidates: [
          createDownloadedProjector({
            id: 'org/model:failed-projector',
            lifecycleStatus: 'failed',
            matchStatus: 'failed',
            localPath: 'mmproj-partial.gguf',
            size: 1024,
            resumeData: 'projector-resume-data',
          }),
        ],
      }),
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/org_model.gguf') {
        return { exists: true, size: 4096 };
      }

      if (uri === 'test-models/mmproj-partial.gguf') {
        return { exists: true, size: 1536 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(FileSystem.getInfoAsync).toHaveBeenCalledWith('test-models/mmproj-partial.gguf');
    expect(metrics.modelsBytes).toBe(5632);
    expect(metrics.downloadedModels[0].projectorCandidates?.[0]).toEqual(
      expect.objectContaining({
        id: 'org/model:failed-projector',
        size: 1536,
        localPath: 'mmproj-partial.gguf',
      }),
    );
  });

  it('does not count missing failed projector partial files in model storage metrics', async () => {
    mockedRegistry.getModels.mockReturnValue([
      createDownloadedModel({
        projectorCandidates: [
          createDownloadedProjector({
            id: 'org/model:failed-projector',
            lifecycleStatus: 'failed',
            matchStatus: 'failed',
            localPath: 'mmproj-missing-partial.gguf',
            size: 4096,
          }),
        ],
      }),
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/org_model.gguf') {
        return { exists: true, size: 4096 };
      }

      if (uri === 'test-models/mmproj-missing-partial.gguf') {
        return { exists: false };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.modelsBytes).toBe(4096);
    expect(metrics.downloadedModels[0].projectorCandidates?.[0]?.id).toBe('org/model:failed-projector');
    expect(metrics.downloadedModels[0].projectorCandidates?.[0]?.localPath).toBeUndefined();
  });

  it('deduplicates shared downloaded projector files across model storage metrics', async () => {
    mockedRegistry.getModels.mockReturnValue([
      createDownloadedModel({
        id: 'org/model-a',
        localPath: undefined,
        size: 1000,
        projectorCandidates: [
          createDownloadedProjector({
            id: 'org/model-a:projector',
            ownerModelId: 'org/model-a',
            localPath: 'shared-mmproj.gguf',
            size: 500,
          }),
        ],
      }),
      createDownloadedModel({
        id: 'org/model-b',
        localPath: undefined,
        size: 2000,
        projectorCandidates: [
          createDownloadedProjector({
            id: 'org/model-b:projector',
            ownerModelId: 'org/model-b',
            localPath: 'shared-mmproj.gguf',
            size: 500,
          }),
        ],
      }),
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/shared-mmproj.gguf') {
        return { exists: true, size: 500 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.modelsBytes).toBe(3500);
  });

  it('limits concurrent model and projector file stats while resolving storage metrics', async () => {
    const modelCount = 12;
    const downloadedModels = Array.from({ length: modelCount }, (_, index) => createDownloadedModel({
      id: `org/model-${index}`,
      localPath: `org_model_${index}.gguf`,
      projectorCandidates: [
        createDownloadedProjector({
          id: `org/model-${index}:projector`,
          ownerModelId: `org/model-${index}`,
          localPath: `mmproj-model-${index}.gguf`,
          fileName: `mmproj-model-${index}.gguf`,
        }),
      ],
    }));
    let activeArtifactStats = 0;
    let maxActiveArtifactStats = 0;

    mockedRegistry.getModels.mockReturnValue(downloadedModels);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      const modelMatch = uri.match(/^test-models\/org_model_(\d+)\.gguf$/);
      const projectorMatch = uri.match(/^test-models\/mmproj-model-(\d+)\.gguf$/);
      const artifactIndex = modelMatch?.[1] ?? projectorMatch?.[1];
      if (artifactIndex === undefined) {
        return { exists: false };
      }

      activeArtifactStats += 1;
      maxActiveArtifactStats = Math.max(maxActiveArtifactStats, activeArtifactStats);
      await Promise.resolve();
      activeArtifactStats -= 1;

      const index = Number(artifactIndex);
      return {
        exists: true,
        size: modelMatch ? 1000 + index : 100 + index,
      };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.downloadedModels).toHaveLength(modelCount);
    expect(metrics.modelsBytes).toBe(13332);
    expect(maxActiveArtifactStats).toBeLessThanOrEqual(8);
  });

  it('falls back to persisted model size when the localPath is unsafe', async () => {
    mockedRegistry.getModels.mockReturnValue([createDownloadedModel({
      localPath: '../org_model.gguf',
      size: 2048,
    })]);

    const metrics = await getAppStorageMetrics();

    expect(metrics.downloadedModels).toHaveLength(1);
    expect(metrics.downloadedModels[0].size).toBe(2048);
    expect(metrics.modelsBytes).toBe(2048);

    const invokedUris = (FileSystem.getInfoAsync as jest.Mock).mock.calls.map((call) => call[0]);
    expect(invokedUris.some((uri) => typeof uri === 'string' && uri.includes('..'))).toBe(false);
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

  it('includes quarantined model files in app file metrics without counting them as downloaded models', async () => {
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(['missing.gguf', 'orphan.gguf']);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/orphan.gguf') {
        return { exists: true, size: 2048 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.downloadedModels).toHaveLength(0);
    expect(metrics.modelsBytes).toBe(0);
    expect(metrics.quarantinedModelFiles).toEqual({
      fileNames: ['missing.gguf', 'orphan.gguf'],
      count: 2,
      bytes: 2048,
    });
    expect(metrics.appFilesBytes).toBe(2060);
  });

  it('limits concurrent quarantined model file stats while resolving storage metrics', async () => {
    const quarantinedFileNames = Array.from({ length: 24 }, (_, index) => `orphan-${index}.gguf`);
    let activeQuarantineStats = 0;
    let maxActiveQuarantineStats = 0;

    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(quarantinedFileNames);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      const quarantineMatch = uri.match(/^test-models\/orphan-(\d+)\.gguf$/);
      if (!quarantineMatch) {
        return { exists: false };
      }

      activeQuarantineStats += 1;
      maxActiveQuarantineStats = Math.max(maxActiveQuarantineStats, activeQuarantineStats);
      await Promise.resolve();
      activeQuarantineStats -= 1;

      return {
        exists: true,
        size: Number(quarantineMatch[1]) + 1,
      };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.quarantinedModelFiles).toEqual({
      fileNames: quarantinedFileNames,
      count: quarantinedFileNames.length,
      bytes: 300,
    });
    expect(maxActiveQuarantineStats).toBeLessThanOrEqual(8);
  });

  it('refreshes model file quarantine before building metrics when requested', async () => {
    mockedGetQueuedDownloadFileNames.mockReturnValue(['queued.gguf']);
    mockedRegistry.validateRegistry.mockImplementation(async () => {
      mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(['fresh-orphan.gguf']);
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/fresh-orphan.gguf') {
        return { exists: true, size: 1024 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics({ refreshModelFileQuarantine: true });

    expect(mockedRegistry.validateRegistry).toHaveBeenCalledWith(['queued.gguf']);
    expect(mockedRegistry.validateRegistry.mock.invocationCallOrder[0]).toBeLessThan(
      mockedRegistry.getQuarantinedModelFileNames.mock.invocationCallOrder[0],
    );
    expect(metrics.quarantinedModelFiles).toEqual({
      fileNames: ['fresh-orphan.gguf'],
      count: 1,
      bytes: 1024,
    });
    expect(metrics.appFilesBytes).toBe(1036);
  });

  it('does not mutate registry validation state for default metrics callers', async () => {
    await getAppStorageMetrics();

    expect(mockedRegistry.validateRegistry).not.toHaveBeenCalled();
  });

  it('keeps returning metrics when quarantine refresh fails', async () => {
    const refreshError = new Error('scan failed');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedRegistry.validateRegistry.mockRejectedValue(refreshError);
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(['known-orphan.gguf']);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/known-orphan.gguf') {
        return { exists: true, size: 512 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics({ refreshModelFileQuarantine: true });

    expect(metrics.quarantinedModelFiles).toEqual({
      fileNames: ['known-orphan.gguf'],
      count: 1,
      bytes: 512,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[StorageManagerService] Failed to refresh model file quarantine',
      expect.objectContaining({
        pathCategory: 'model_storage',
        scope: 'orphan_quarantine_refresh',
        errorName: 'Error',
      }),
    );
    expect(warnSpy.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);

    warnSpy.mockRestore();
  });

  it('validates queued downloads before deleting quarantined model files', async () => {
    mockedGetQueuedDownloadFileNames.mockReturnValue(['queued.gguf']);
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(['orphan-a.gguf', 'orphan-b.gguf']);
    mockedRegistry.deleteQuarantinedModelFiles
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    await expect(cleanupQuarantinedModelFiles()).resolves.toBe(2);

    expect(mockedRegistry.validateRegistry).toHaveBeenCalledWith(['queued.gguf']);
    expect(mockedRegistry.deleteQuarantinedModelFiles).toHaveBeenNthCalledWith(
      1,
      ['orphan-a.gguf'],
      expect.any(Function),
    );
    expect(mockedRegistry.deleteQuarantinedModelFiles).toHaveBeenNthCalledWith(
      2,
      ['orphan-b.gguf'],
      expect.any(Function),
    );
    const queuedProvider = mockedRegistry.deleteQuarantinedModelFiles.mock.calls[0][1] as () => string[];
    expect(queuedProvider()).toEqual(['queued.gguf']);
  });

  it('passes queued projector downloads into quarantine validation and deletion guards', async () => {
    mockedGetQueuedDownloadFileNames.mockReturnValue(['queued-main.gguf', 'queued-mmproj.gguf']);
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(['queued-mmproj.gguf']);

    await expect(cleanupQuarantinedModelFiles()).resolves.toBe(0);

    expect(mockedRegistry.validateRegistry).toHaveBeenCalledWith(['queued-main.gguf', 'queued-mmproj.gguf']);
    const queuedProvider = mockedRegistry.deleteQuarantinedModelFiles.mock.calls[0][1] as () => string[];
    expect(queuedProvider()).toEqual(['queued-main.gguf', 'queued-mmproj.gguf']);
  });

  it('passes the latest queued downloads into final quarantine deletion guard', async () => {
    mockedGetQueuedDownloadFileNames
      .mockReturnValueOnce(['queued-before-validation.gguf'])
      .mockReturnValueOnce(['queued-at-delete.gguf']);
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(['queued-at-delete.gguf']);

    await expect(cleanupQuarantinedModelFiles()).resolves.toBe(0);

    expect(mockedRegistry.validateRegistry).toHaveBeenCalledWith(['queued-before-validation.gguf']);
    expect(mockedRegistry.deleteQuarantinedModelFiles).toHaveBeenCalledWith(
      ['queued-at-delete.gguf'],
      expect.any(Function),
    );
    const queuedProvider = mockedRegistry.deleteQuarantinedModelFiles.mock.calls[0][1] as () => string[];
    expect(queuedProvider()).toEqual(['queued-at-delete.gguf']);
  });

  it('skips quarantine deletion when validation leaves no quarantined model files', async () => {
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue([]);

    await expect(cleanupQuarantinedModelFiles()).resolves.toBe(0);

    expect(mockedRegistry.validateRegistry).toHaveBeenCalledWith([]);
    expect(mockedRegistry.deleteQuarantinedModelFiles).not.toHaveBeenCalled();
  });

  it('attempts remaining quarantine cleanup entries after one deletion fails', async () => {
    const deleteError = new Error('locked');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedRegistry.getQuarantinedModelFileNames.mockReturnValue(['locked.gguf', 'free.gguf']);
    mockedRegistry.deleteQuarantinedModelFiles
      .mockRejectedValueOnce(deleteError)
      .mockResolvedValueOnce(1);

    await expect(cleanupQuarantinedModelFiles()).rejects.toBe(deleteError);

    expect(mockedRegistry.deleteQuarantinedModelFiles).toHaveBeenCalledTimes(2);
    expect(mockedRegistry.deleteQuarantinedModelFiles).toHaveBeenNthCalledWith(
      2,
      ['free.gguf'],
      expect.any(Function),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[StorageManagerService] Failed to delete quarantined model files',
      expect.objectContaining({
        pathCategory: 'model_storage',
        scope: 'quarantined_model_cleanup',
        failedCount: 1,
        errorName: 'Error',
      }),
    );
    expect(warnSpy.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('locked.gguf');

    warnSpy.mockRestore();
  });

  it('treats an empty persisted chat-store payload as zero chat history bytes', async () => {
    mockedAppStorage.getAllKeys.mockReturnValue(['chat-store']);
    mockedAppStorage.getString.mockImplementation((key: string) => (
      key === 'chat-store'
        ? JSON.stringify({ state: { threads: {}, activeThreadId: null }, version: 0 })
        : undefined
    ));

    const metrics = await getAppStorageMetrics();

    expect(metrics.chatHistoryBytes).toBe(0);
  });

  it('counts corrupted persisted chat-store payload bytes instead of dropping them', async () => {
    mockedAppStorage.getAllKeys.mockReturnValue(['chat-store']);
    mockedAppStorage.getString.mockImplementation((key: string) => (
      key === 'chat-store' ? '{corrupted-json' : undefined
    ));

    const metrics = await getAppStorageMetrics();

    expect(metrics.chatHistoryBytes).toBeGreaterThan(0);
  });

  it('counts v2 chat persistence index and per-thread record bytes', async () => {
    const threadKey = getChatThreadStorageKey('thread-1');
    const indexPayload = JSON.stringify({
      schemaVersion: 2,
      activeThreadId: 'thread-1',
      threadIds: ['thread-1'],
      updatedAt: 10,
    });
    const threadPayload = JSON.stringify({
      schemaVersion: 2,
      thread: { id: 'thread-1', messages: [] },
      persistedAt: 11,
    });

    mockedAppStorage.getAllKeys.mockReturnValue([CHAT_PERSISTENCE_INDEX_KEY, threadKey]);
    mockedAppStorage.getString.mockImplementation((key: string) => {
      if (key === CHAT_PERSISTENCE_INDEX_KEY) {
        return indexPayload;
      }

      if (key === threadKey) {
        return threadPayload;
      }

      return undefined;
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.chatHistoryBytes).toBe(
      CHAT_PERSISTENCE_INDEX_KEY.length +
      indexPayload.length +
      threadKey.length +
      threadPayload.length
    );
  });

  it('treats an empty v2 chat persistence tombstone as zero chat history bytes', async () => {
    mockedAppStorage.getAllKeys.mockReturnValue([CHAT_PERSISTENCE_INDEX_KEY]);
    mockedAppStorage.getString.mockImplementation((key: string) => (
      key === CHAT_PERSISTENCE_INDEX_KEY
        ? JSON.stringify({
          schemaVersion: 2,
          activeThreadId: null,
          threadIds: [],
          updatedAt: 20,
          clearedAt: 20,
        })
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

  it('counts corrupted legacy chat history index bytes instead of dropping them', async () => {
    mockedSettingsStorage.getAllKeys.mockReturnValue(['chat_history_index']);
    mockedSettingsStorage.getString.mockImplementation((key: string) => (
      key === 'chat_history_index' ? '{corrupted-index' : undefined
    ));

    const metrics = await getAppStorageMetrics();

    expect(metrics.chatHistoryBytes).toBeGreaterThan(0);
  });

  it('recursively sums nested cache directory sizes', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true };
      }

      if (uri === 'test-cache/root.bin') {
        return { exists: true, size: 128 };
      }

      if (uri === 'test-cache/nested') {
        return { exists: true, isDirectory: true };
      }

      if (uri === 'test-cache/nested/') {
        return { exists: true };
      }

      if (uri === 'test-cache/nested/child.bin') {
        return { exists: true, size: 256 };
      }

      if (uri === 'test-cache/nested/missing.bin') {
        return { exists: false };
      }

      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return ['root.bin', 'nested'];
      }

      if (uri === 'test-cache/nested/') {
        return ['child.bin', 'missing.bin'];
      }

      return [];
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.cacheBytes).toBe(384);
  });

  it('limits concurrent file stats while measuring cache directory size', async () => {
    const entryNames = Array.from({ length: 20 }, (_, index) => `entry-${index}.bin`);
    let activeStats = 0;
    let maxActiveStats = 0;

    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true };
      }

      activeStats += 1;
      maxActiveStats = Math.max(maxActiveStats, activeStats);
      await Promise.resolve();
      activeStats -= 1;

      if (uri.startsWith('test-cache/entry-')) {
        return { exists: true, size: 1 };
      }

      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-cache/' ? entryNames : []
    ));

    const metrics = await getAppStorageMetrics();

    expect(metrics.cacheBytes).toBe(20);
    expect(maxActiveStats).toBeLessThanOrEqual(8);
  });

  it('reuses a recent cache directory size measurement', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true };
      }

      if (uri === 'test-cache/cache.bin') {
        return { exists: true, size: 128 };
      }

      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-cache/' ? ['cache.bin'] : []
    ));

    await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 128 }));
    await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 128 }));

    expect((FileSystem.readDirectoryAsync as jest.Mock).mock.calls.filter((call) => call[0] === 'test-cache/'))
      .toHaveLength(1);
    expect((FileSystem.getInfoAsync as jest.Mock).mock.calls.filter((call) => call[0] === 'test-cache/cache.bin'))
      .toHaveLength(1);
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

  it('includes downloaded projector bytes when estimating active model memory usage', async () => {
    const downloadedModel = createDownloadedModel({
      id: 'org/active-model',
      localPath: 'org_model.gguf',
      projectorCandidates: [
        createDownloadedProjector({
          ownerModelId: 'org/active-model',
          localPath: 'active-mmproj.gguf',
          size: 512,
        }),
      ],
    });
    mockedRegistry.getModels.mockReturnValue([downloadedModel]);
    mockedRegistry.getModel.mockReturnValue(downloadedModel);
    (llmEngineService.getState as jest.Mock).mockReturnValue({ activeModelId: 'org/active-model' });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: false };
      }

      if (uri === 'test-models/org_model.gguf') {
        return { exists: true, size: 4096 };
      }

      if (uri === 'test-models/active-mmproj.gguf') {
        return { exists: true, size: 512 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.activeModelEstimateBytes).toBe(
      Math.round((4096 + 512) * 1.2 + 64 * 1024 * 1024),
    );
  });

  it('clears persisted catalog cache even when the file cache directory is empty', async () => {
    await expect(clearActiveCache()).resolves.toBe(0);

    expect(mockedModelCatalogService.clearCache).toHaveBeenCalledTimes(1);
    expect(mockedModelCatalogService.clearCache).toHaveBeenCalledWith('manual');
  });

  it('retries cache entry deletion once before succeeding', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true };
      }

      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue(['stale.bin']);
    (FileSystem.deleteAsync as jest.Mock)
      .mockReset()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);

    await expect(clearActiveCache()).resolves.toBe(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
  });

  it('throws the first cache deletion error after attempting cleanup', async () => {
    const deleteError = new Error('delete failed');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true };
      }

      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue(['broken.bin']);
    (FileSystem.deleteAsync as jest.Mock).mockReset().mockRejectedValue(deleteError);

    await expect(clearActiveCache()).rejects.toBe(deleteError);

    expect(mockedModelCatalogService.clearCache).toHaveBeenCalledWith('manual');
    expect(warnSpy).toHaveBeenCalledWith(
      '[StorageManagerService] Failed to delete cache entries',
      expect.objectContaining({
        pathCategory: 'cache_storage',
        scope: 'active_cache_clear',
        failedCount: 1,
        errorName: 'Error',
      }),
    );
    expect(warnSpy.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('broken.bin');

    warnSpy.mockRestore();
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

  it('unloads the active model before resetting app settings', async () => {
    (llmEngineService.getState as jest.Mock).mockReturnValue({ activeModelId: 'org/model' });
    (resetSettings as jest.Mock).mockReturnValue('reset-result');

    await expect(resetAppSettings()).resolves.toBe('reset-result');

    expect(llmEngineService.unload).toHaveBeenCalledTimes(1);
    expect(resetSettings).toHaveBeenCalledTimes(1);
    expect((llmEngineService.unload as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (resetSettings as jest.Mock).mock.invocationCallOrder[0],
    );
  });
});
