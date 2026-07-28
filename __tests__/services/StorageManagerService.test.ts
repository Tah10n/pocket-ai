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
  getAppCacheRootDir: () => 'test-cache/',
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
import { __getStorageManagerDirectorySizeStateForTests } from '../../src/services/StorageManagerService';
import { __measureStorageManagerDirectorySizeForTests } from '../../src/services/StorageManagerService';
import { __resetStorageManagerDirectorySizeCacheForTests } from '../../src/services/StorageManagerService';
import { offloadModel } from '../../src/services/StorageManagerService';
import { resetAppSettings } from '../../src/services/StorageManagerService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { modelCatalogService } from '../../src/services/ModelCatalogService';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';
import {
  clearLegacyChatHistory,
  resetAllParametersForModel,
  resetSettings,
  storage as settingsStorage,
} from '../../src/services/SettingsStore';
import { useChatStore } from '../../src/store/chatStore';
import { getQueuedDownloadFileNames } from '../../src/store/downloadStore';
import { storage as appStorage } from '../../src/store/storage';
import {
  CHAT_PERSISTENCE_INDEX_KEY,
  CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY,
  getChatStreamingOperationStorageKey,
  getChatStreamingProgressCheckpointStorageKey,
  getChatStreamingProgressChunkStorageKey,
  getChatStreamingProgressStorageKey,
  getChatThreadStorageKey,
} from '../../src/store/chatPersistence';
import * as FileSystem from 'expo-file-system/legacy';
import { NativeModules, Platform } from 'react-native';
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
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);
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
    NativeModules.SystemMetrics = undefined;
  });

  afterEach(() => {
    performanceMonitor.setEnabled(false);
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
        '[StorageManagerService] Failed to read clearable cache size',
        expect.objectContaining({
          pathCategory: 'cache_storage',
          scope: 'clearable_directory_size',
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

  it('counts case-distinct Android projector files independently', async () => {
    mockedRegistry.getModels.mockReturnValue([
      createDownloadedModel({
        projectorCandidates: [
          createDownloadedProjector({
            id: 'org/model:upper-projector',
            fileName: 'MMProj.gguf',
            localPath: 'MMProj.gguf',
            size: 1024,
          }),
          createDownloadedProjector({
            id: 'org/model:lower-projector',
            fileName: 'mmproj.gguf',
            localPath: 'mmproj.gguf',
            size: 2048,
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
      if (uri === 'test-models/MMProj.gguf') {
        return { exists: true, size: 1024 };
      }
      if (uri === 'test-models/mmproj.gguf') {
        return { exists: true, size: 2048 };
      }
      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.modelsBytes).toBe(4096 + 1024 + 2048);
    expect(FileSystem.getInfoAsync).toHaveBeenCalledWith('test-models/MMProj.gguf');
    expect(FileSystem.getInfoAsync).toHaveBeenCalledWith('test-models/mmproj.gguf');
  });

  it('includes and deduplicates variant-only and artifact-only projector files in storage metrics', async () => {
    const variantProjector = createDownloadedProjector({
      id: 'org/model:q4-projector',
      ownerVariantId: 'q4',
      fileName: 'variant-mmproj.gguf',
      localPath: 'variant-mmproj.gguf',
      size: 1024,
    });
    mockedRegistry.getModels.mockReturnValue([
      createDownloadedModel({
        variants: [{
          variantId: 'q4',
          fileName: 'model-q4.gguf',
          quantizationLabel: 'Q4',
          size: 4096,
          projectorCandidates: [variantProjector],
        }],
        artifacts: [
          {
            id: variantProjector.id,
            kind: 'multimodal_projector',
            requiredFor: ['image'],
            remoteFileName: variantProjector.fileName,
            downloadUrl: variantProjector.downloadUrl,
            sizeBytes: 1024,
            localPath: variantProjector.localPath,
            installState: 'installed',
          },
          {
            id: 'org/model:artifact-only-projector',
            kind: 'multimodal_projector',
            requiredFor: ['audio'],
            remoteFileName: 'artifact-only-mmproj.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/artifact-only-mmproj.gguf',
            sizeBytes: 1024,
            localPath: 'artifact-only-mmproj.gguf',
            installState: 'installed',
          },
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

      if (uri === 'test-models/variant-mmproj.gguf') {
        return { exists: true, size: 2048 };
      }

      if (uri === 'test-models/artifact-only-mmproj.gguf') {
        return { exists: true, size: 3072 };
      }

      return { exists: false };
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.modelsBytes).toBe(4096 + 2048 + 3072);
    expect(metrics.downloadedModels[0].variants?.[0].projectorCandidates?.[0].size).toBe(2048);
    expect(metrics.downloadedModels[0].artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: variantProjector.id, sizeBytes: 2048 }),
      expect.objectContaining({ id: 'org/model:artifact-only-projector', sizeBytes: 3072 }),
    ]));
    expect((FileSystem.getInfoAsync as jest.Mock).mock.calls.filter(
      ([uri]) => uri === 'test-models/variant-mmproj.gguf',
    )).toHaveLength(1);
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

  it('uses one native Android cache measurement instead of walking every cache entry over the bridge', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    NativeModules.SystemMetrics = {
      getMemorySnapshot: jest.fn(),
      getCacheDirectorySize: jest.fn().mockResolvedValue(42_000_000),
    };

    try {
      const metrics = await getAppStorageMetrics();
      const cachedMetrics = await getAppStorageMetrics();

      expect(metrics.cacheBytes).toBe(42_000_000);
      expect(cachedMetrics.cacheBytes).toBe(42_000_000);
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(1);
      expect(FileSystem.readDirectoryAsync).not.toHaveBeenCalled();
    } finally {
      NativeModules.SystemMetrics = undefined;
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it('coalesces concurrent storage metrics into one native cache scan', async () => {
    const originalPlatform = Platform.OS;
    let resolveNativeScan!: (value: number) => void;
    const nativeScan = new Promise<number>((resolve) => {
      resolveNativeScan = resolve;
    });
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    NativeModules.SystemMetrics = {
      getMemorySnapshot: jest.fn(),
      getCacheDirectorySize: jest.fn(() => nativeScan),
    };

    try {
      const metricsRequests = Array.from({ length: 6 }, () => getAppStorageMetrics());

      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(1);

      resolveNativeScan(4096);

      const metrics = await Promise.all(metricsRequests);
      expect(metrics.map((entry) => entry.cacheBytes)).toEqual(Array(6).fill(4096));
      expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
        'storage.cacheScan.deduped': 5,
        'storage.cacheScan.native': 1,
      }));
      expect(performanceMonitor.snapshot().events.filter((event) => (
        event.type === 'span' && event.name === 'storage.cacheScan'
      ))).toHaveLength(1);
    } finally {
      NativeModules.SystemMetrics = undefined;
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it('coalesces concurrent JS fallback cache scans', async () => {
    let resolveCacheRoot!: (value: { exists: boolean; isDirectory: boolean }) => void;
    const cacheRoot = new Promise<{ exists: boolean; isDirectory: boolean }>((resolve) => {
      resolveCacheRoot = resolve;
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return cacheRoot;
      }
      if (uri === 'test-cache/temporary.bin') {
        return { exists: true, isDirectory: false, size: 512 };
      }
      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-cache/' ? ['http-cache', 'temporary.bin'] : []
    ));

    const metricsRequests = Array.from({ length: 5 }, () => getAppStorageMetrics());

    await Promise.resolve();
    await Promise.resolve();

    expect((FileSystem.getInfoAsync as jest.Mock).mock.calls.filter((call) => call[0] === 'test-cache/'))
      .toHaveLength(1);

    resolveCacheRoot({ exists: true, isDirectory: true });

    const metrics = await Promise.all(metricsRequests);
    expect(metrics.map((entry) => entry.cacheBytes)).toEqual(Array(5).fill(512));
    expect((FileSystem.readDirectoryAsync as jest.Mock).mock.calls.filter((call) => call[0] === 'test-cache/'))
      .toHaveLength(1);
    expect((FileSystem.getInfoAsync as jest.Mock).mock.calls.filter((call) => call[0] === 'test-cache/temporary.bin'))
      .toHaveLength(1);
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('test-cache/http-cache');
    expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
      'storage.cacheScan.deduped': 4,
      'storage.cacheScan.jsFallback': 1,
    }));
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

  it('invalidates the cached native scan when refreshing model file quarantine', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    NativeModules.SystemMetrics = {
      getMemorySnapshot: jest.fn(),
      getCacheDirectorySize: jest.fn()
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(200),
    };

    try {
      await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 100 }));
      await expect(getAppStorageMetrics({ refreshModelFileQuarantine: true }))
        .resolves.toEqual(expect.objectContaining({ cacheBytes: 200 }));

      expect(mockedRegistry.validateRegistry).toHaveBeenCalledTimes(1);
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);
    } finally {
      NativeModules.SystemMetrics = undefined;
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatform,
      });
    }
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

  it('prevents an in-flight cache scan from restoring measurements after quarantine cleanup', async () => {
    const originalPlatform = Platform.OS;
    let resolveStaleScan!: (value: number) => void;
    let resolveFreshScan!: (value: number) => void;
    const staleScan = new Promise<number>((resolve) => {
      resolveStaleScan = resolve;
    });
    const freshScan = new Promise<number>((resolve) => {
      resolveFreshScan = resolve;
    });
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    NativeModules.SystemMetrics = {
      getMemorySnapshot: jest.fn(),
      getCacheDirectorySize: jest.fn()
        .mockImplementationOnce(() => staleScan)
        .mockImplementationOnce(() => freshScan),
    };

    try {
      const staleMetrics = getAppStorageMetrics();

      await expect(cleanupQuarantinedModelFiles()).resolves.toBe(0);

      const freshMetrics = getAppStorageMetrics();
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);

      resolveStaleScan(700);
      await expect(staleMetrics).resolves.toEqual(expect.objectContaining({ cacheBytes: 0 }));

      const dedupedFreshMetrics = getAppStorageMetrics();
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);

      resolveFreshScan(300);
      await expect(Promise.all([freshMetrics, dedupedFreshMetrics])).resolves.toEqual([
        expect.objectContaining({ cacheBytes: 300 }),
        expect.objectContaining({ cacheBytes: 300 }),
      ]);
      await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 300 }));
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);
    } finally {
      NativeModules.SystemMetrics = undefined;
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatform,
      });
    }
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

  it('counts pending commits and every V2 streaming progress artifact', async () => {
    const threadId = 'thread-streaming';
    const values = new Map<string, string>([
      [CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY, '{"pending":true}'],
      [getChatStreamingProgressStorageKey(threadId), '{"head":true}'],
      [getChatStreamingOperationStorageKey(threadId, 0), '{"operation":true}'],
      [getChatStreamingProgressCheckpointStorageKey(threadId, 0), '{"checkpoint":true}'],
      [getChatStreamingProgressChunkStorageKey(threadId, 0), '{"chunk":true}'],
    ]);
    mockedAppStorage.getAllKeys.mockReturnValue(Array.from(values.keys()));
    mockedAppStorage.getString.mockImplementation((key: string) => values.get(key));

    const metrics = await getAppStorageMetrics();
    const expectedBytes = Array.from(values).reduce(
      (total, [key, value]) => total + key.length + value.length,
      0,
    );

    expect(metrics.chatHistoryBytes).toBe(expectedBytes);
    expect(metrics.appFilesBytes).toBeGreaterThanOrEqual(expectedBytes);
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

  it('still counts orphaned progress beside an empty v2 tombstone', async () => {
    const progressKey = getChatStreamingProgressChunkStorageKey('orphan', 7);
    const progressValue = '{"orphan":true}';
    mockedAppStorage.getAllKeys.mockReturnValue([CHAT_PERSISTENCE_INDEX_KEY, progressKey]);
    mockedAppStorage.getString.mockImplementation((key: string) => {
      if (key === CHAT_PERSISTENCE_INDEX_KEY) {
        return JSON.stringify({
          schemaVersion: 2,
          activeThreadId: null,
          threadIds: [],
          updatedAt: 20,
          clearedAt: 20,
        });
      }
      return key === progressKey ? progressValue : undefined;
    });

    const metrics = await getAppStorageMetrics();

    expect(metrics.chatHistoryBytes).toBe(progressKey.length + progressValue.length);
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

  it('bounds one shared filesystem work queue across concurrent directory scans', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let releaseFileSystemTasks!: () => void;
    const fileSystemGate = new Promise<void>((resolve) => {
      releaseFileSystemTasks = resolve;
    });
    let activeFileSystemTasks = 0;
    let maxActiveFileSystemTasks = 0;
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async () => {
      activeFileSystemTasks += 1;
      maxActiveFileSystemTasks = Math.max(maxActiveFileSystemTasks, activeFileSystemTasks);
      await fileSystemGate;
      activeFileSystemTasks -= 1;
      return { exists: false };
    });
    const { limits } = __getStorageManagerDirectorySizeStateForTests();
    const scanCount = limits.maxConcurrentFileSystemTasks + limits.maxQueuedFileSystemTasks + 12;

    try {
      const scans = Array.from({ length: scanCount }, (_, index) => (
        __measureStorageManagerDirectorySizeForTests(`test-shared-queue-${index}/`)
      ));
      for (let cycle = 0; cycle < 6; cycle += 1) {
        await Promise.resolve();
      }

      expect(__getStorageManagerDirectorySizeStateForTests()).toEqual(expect.objectContaining({
        activeFileSystemTaskCount: limits.maxConcurrentFileSystemTasks,
        queuedFileSystemTaskCount: limits.maxQueuedFileSystemTasks,
      }));
      expect(maxActiveFileSystemTasks).toBeLessThanOrEqual(limits.maxConcurrentFileSystemTasks);

      releaseFileSystemTasks();
      await expect(Promise.all(scans)).resolves.toEqual(Array(scanCount).fill(0));
      expect(__getStorageManagerDirectorySizeStateForTests()).toEqual(expect.objectContaining({
        activeFileSystemTaskCount: 0,
        queuedFileSystemTaskCount: 0,
      }));
    } finally {
      releaseFileSystemTasks();
      warnSpy.mockRestore();
    }
  });

  it('evicts least-recently-used directory measurements at the cache entry limit', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    const { maxCacheEntries } = __getStorageManagerDirectorySizeStateForTests().limits;

    for (let index = 0; index < maxCacheEntries + 2; index += 1) {
      await __measureStorageManagerDirectorySizeForTests(`test-cache-root-${index}/`);
    }

    expect(__getStorageManagerDirectorySizeStateForTests().cacheEntryCount).toBe(maxCacheEntries);
    await __measureStorageManagerDirectorySizeForTests('test-cache-root-0/');
    expect((FileSystem.getInfoAsync as jest.Mock).mock.calls.filter(
      ([uri]) => uri === 'test-cache-root-0/',
    )).toHaveLength(2);
    expect(__getStorageManagerDirectorySizeStateForTests().cacheEntryCount).toBe(maxCacheEntries);
  });

  it('falls back safely before inspecting a directory with thousands of sibling entries', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { maxVisitedNodes } = __getStorageManagerDirectorySizeStateForTests().limits;
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-pathological-tree/'
        ? { exists: true, isDirectory: true }
        : { exists: true, isDirectory: true }
    ));
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue(
      Array.from({ length: maxVisitedNodes + 1 }, (_, index) => `nested-${index}`),
    );

    try {
      await expect(
        __measureStorageManagerDirectorySizeForTests('test-pathological-tree/'),
      ).resolves.toBe(0);

      expect(FileSystem.getInfoAsync).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[StorageManagerService] Failed to read directory size',
        expect.objectContaining({ errorName: 'DirectorySizeTraversalLimitError' }),
      );
      expect(__getStorageManagerDirectorySizeStateForTests().cacheEntryCount).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('bounds a deeply nested directory chain with thousands of visited nodes', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { maxVisitedNodes } = __getStorageManagerDirectorySizeStateForTests().limits;
    let directoryReadCount = 0;
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
      exists: true,
      isDirectory: true,
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async () => {
      directoryReadCount += 1;
      return ['d'];
    });

    try {
      await expect(
        __measureStorageManagerDirectorySizeForTests('test-deep-tree/'),
      ).resolves.toBe(0);

      expect(directoryReadCount).toBe(maxVisitedNodes + 1);
      expect(FileSystem.getInfoAsync).toHaveBeenCalledTimes(maxVisitedNodes + 1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[StorageManagerService] Failed to read directory size',
        expect.objectContaining({ errorName: 'DirectorySizeTraversalLimitError' }),
      );
      expect(__getStorageManagerDirectorySizeStateForTests().cacheEntryCount).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it('rejects traversal-shaped children and skips symbolic links during directory scans', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-safe-tree/') {
        return { exists: true, isDirectory: true };
      }
      if (uri === 'test-safe-tree/safe.bin') {
        return { exists: true, isDirectory: false, size: 64 };
      }
      if (uri === 'test-safe-tree/link') {
        return { exists: true, isDirectory: true, isSymbolicLink: true };
      }
      throw new Error('Unexpected directory child inspection');
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-safe-tree/'
        ? ['../escape', 'nested/escape', 'safe.bin', 'link']
        : []
    ));

    await expect(__measureStorageManagerDirectorySizeForTests('test-safe-tree/')).resolves.toBe(64);

    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith(expect.stringContaining('escape'));
    expect(FileSystem.readDirectoryAsync).not.toHaveBeenCalledWith('test-safe-tree/link/');
  });

  it('does not publish stale directory results after invalidation during traversal', async () => {
    let resolveStaleEntries!: (entries: string[]) => void;
    let markStaleReadStarted!: () => void;
    const staleEntries = new Promise<string[]>((resolve) => {
      resolveStaleEntries = resolve;
    });
    const staleReadStarted = new Promise<void>((resolve) => {
      markStaleReadStarted = resolve;
    });
    let rootReadCount = 0;
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-invalidation-tree/') {
        return { exists: true, isDirectory: true };
      }
      if (uri === 'test-invalidation-tree/fresh.bin') {
        return { exists: true, isDirectory: false, size: 128 };
      }
      if (uri === 'test-invalidation-tree/stale.bin') {
        return { exists: true, isDirectory: false, size: 512 };
      }
      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri !== 'test-invalidation-tree/') {
        return [];
      }
      rootReadCount += 1;
      if (rootReadCount === 1) {
        markStaleReadStarted();
        return staleEntries;
      }
      return ['fresh.bin'];
    });

    const staleMeasurement = __measureStorageManagerDirectorySizeForTests('test-invalidation-tree/');
    await staleReadStarted;
    __resetStorageManagerDirectorySizeCacheForTests();
    const freshMeasurement = __measureStorageManagerDirectorySizeForTests('test-invalidation-tree/');
    resolveStaleEntries(['stale.bin']);

    await expect(staleMeasurement).resolves.toBe(0);
    await expect(freshMeasurement).resolves.toBe(128);
    await expect(
      __measureStorageManagerDirectorySizeForTests('test-invalidation-tree/'),
    ).resolves.toBe(128);
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('test-invalidation-tree/stale.bin');
    expect(rootReadCount).toBe(2);
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

  it('retries a JS fallback scan after a filesystem failure', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.getInfoAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValueOnce({ exists: false });

    try {
      await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 0 }));
      await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 0 }));

      expect((FileSystem.getInfoAsync as jest.Mock).mock.calls.filter((call) => call[0] === 'test-cache/'))
        .toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('invalidates an in-flight cache measurement before clearing active cache', async () => {
    const originalPlatform = Platform.OS;
    let resolveOldScan!: (value: number) => void;
    let resolveFreshScan!: (value: number) => void;
    const oldScan = new Promise<number>((resolve) => {
      resolveOldScan = resolve;
    });
    const freshScan = new Promise<number>((resolve) => {
      resolveFreshScan = resolve;
    });
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    NativeModules.SystemMetrics = {
      getMemorySnapshot: jest.fn(),
      getCacheDirectorySize: jest.fn()
        .mockImplementationOnce(() => oldScan)
        .mockImplementationOnce(() => freshScan),
    };

    try {
      const staleMetrics = getAppStorageMetrics();

      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(1);
      await expect(clearActiveCache()).resolves.toBe(0);

      const freshMetrics = getAppStorageMetrics();
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);

      resolveOldScan(100);
      await expect(staleMetrics).resolves.toEqual(expect.objectContaining({ cacheBytes: 0 }));

      const dedupedFreshMetrics = getAppStorageMetrics();
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);

      resolveFreshScan(50);
      await expect(Promise.all([freshMetrics, dedupedFreshMetrics])).resolves.toEqual([
        expect.objectContaining({ cacheBytes: 50 }),
        expect.objectContaining({ cacheBytes: 50 }),
      ]);
      await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 50 }));
      expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);
    } finally {
      NativeModules.SystemMetrics = undefined;
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatform,
      });
    }
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

  it('does not count or delete the live React Native HTTP cache', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true, isDirectory: true };
      }
      if (uri === 'test-cache/temporary.bin') {
        return { exists: true, isDirectory: false, size: 128 };
      }
      throw new Error(`Unexpected stat: ${uri}`);
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-cache/' ? ['http-cache', 'temporary.bin'] : []
    ));

    await expect(getAppStorageMetrics()).resolves.toEqual(expect.objectContaining({ cacheBytes: 128 }));
    await expect(clearActiveCache()).resolves.toBe(1);

    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('test-cache/http-cache');
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-cache/temporary.bin', { idempotent: true });
  });

  it('rejects unsafe cache entry names without deleting outside the direct cache children', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-cache/') {
        return { exists: true, isDirectory: true };
      }
      return { exists: false };
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([
      'http-cache',
      'HTTP-CACHE',
      '%68ttp-cache',
      '%2e%2e',
      '..',
      'nested/entry',
      'temporary.bin',
    ]);

    await expect(clearActiveCache()).rejects.toThrow(
      'Cache directory returned an unsafe entry name.',
    );

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-cache/temporary.bin', {
      idempotent: true,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[StorageManagerService] Failed to delete cache entries',
      expect.objectContaining({
        pathCategory: 'cache_storage',
        scope: 'active_cache_clear',
        failedCount: 4,
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('%68ttp-cache');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('%2e%2e');

    warnSpy.mockRestore();
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
