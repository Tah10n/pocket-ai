import { LocalStorageRegistry, registry } from '../../src/services/LocalStorageRegistry';
import { LifecycleStatus, ModelAccessState, ModelMetadata } from '../../src/types/models';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { assertPrivateStorageWritable, createStorage } from '../../src/services/storage';

const mockStorage = {
  getString: jest.fn(),
  set: jest.fn(),
  remove: jest.fn(),
  getAllKeys: jest.fn().mockReturnValue([]),
};

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  documentDirectory: 'test-dir/',
}));

jest.mock('../../src/services/storage', () => ({
  assertPrivateStorageWritable: jest.fn(),
  createStorage: jest.fn().mockReturnValue(mockStorage),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn(),
}));

jest.mock('../../src/services/SystemMetricsService', () => ({
  getSystemMemorySnapshot: jest.fn().mockResolvedValue(null),
}));

const originalGetModels = registry.getModels.bind(registry);
const originalGetModel = registry.getModel.bind(registry);
const originalSaveModels = registry.saveModels.bind(registry);

const mockModel: ModelMetadata = {
  id: 'test/model',
  name: 'model',
  author: 'test',
  size: 1000,
  downloadUrl: 'http://example.com/model.gguf',
  localPath: 'model.gguf',
  fitsInRam: true,
  accessState: ModelAccessState.PUBLIC,
  isGated: false,
  isPrivate: false,
  lifecycleStatus: LifecycleStatus.DOWNLOADED,
  downloadProgress: 1,
};

function createMockModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    ...mockModel,
    localPath: 'model.gguf',
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    ...overrides,
  };
}

describe('LocalStorageRegistry', () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeAll(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (assertPrivateStorageWritable as jest.Mock).mockReset();
    (assertPrivateStorageWritable as jest.Mock).mockImplementation(() => undefined);
    (createStorage as jest.Mock).mockReturnValue(mockStorage);
    mockStorage.getString.mockReset();
    mockStorage.getString.mockReturnValue(null);
    mockStorage.getAllKeys.mockReset();
    mockStorage.getAllKeys.mockReturnValue([]);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([]);
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue(null);
    (registry as any).getModels = originalGetModels;
    (registry as any).getModel = originalGetModel;
    (registry as any).saveModels = originalSaveModels;
    (registry as any).storage = mockStorage;
    (registry as any).cachedModelIds = null;
    (registry as any).cachedModelsById = null;
    (registry as any).cachedDownloadedModelsCount = null;
    (registry as any).cachedCalibrationRecordsByKey = null;
  });

  it('should remove model and delete file', async () => {
    const model = createMockModel();
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalled();
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry:model-v1:test%2Fmodel');
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry:index-v1');
  });

  it('should validate registry and reset status if file is missing', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([createMockModel()]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
  });

  it('should reset downloaded models that no longer have a local path', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        localPath: undefined,
        downloadedAt: 123,
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 1000,
          checkedAt: 10,
        },
        metadataTrust: 'verified_local',
        downloadProgress: 1,
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();

    await registry.validateRegistry();

    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadedAt).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].downloadProgress).toBe(0);
  });

  it('should normalize persisted active models back to downloaded on bootstrap', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ lifecycleStatus: LifecycleStatus.ACTIVE }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
  });

  it('hydrates unknown downloaded model sizes from the local file during registry validation', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(1024);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ size: null, fitsInRam: null }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 2048 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].size).toBe(2048);
    expect(updatedModels[0].fitsInRam).toBe(false);
    expect(updatedModels[0].metadataTrust).toBe('verified_local');
    expect(updatedModels[0].gguf).toEqual(expect.objectContaining({ totalBytes: 2048 }));
  });

  it('recomputes fitsInRam for downloaded models when legacy persisted metadata is missing the flag', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(1024);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ size: 2048, fitsInRam: null }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 2048 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].size).toBe(2048);
    expect(updatedModels[0].fitsInRam).toBe(false);
    expect(updatedModels[0].metadataTrust).toBe('verified_local');
    expect(updatedModels[0].gguf).toEqual(expect.objectContaining({ totalBytes: 2048 }));
  });

  it('falls back to the persisted size for fitsInRam when file size metadata is unavailable, without marking size verified', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(1024);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 2048,
        fitsInRam: null,
        metadataTrust: undefined,
        gguf: undefined,
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].size).toBe(2048);
    expect(updatedModels[0].fitsInRam).toBe(false);
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('uses the device total-memory budget when recomputing fitsInRam (not the live snapshot)', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 8 * 1024 * 1024 * 1024,
      availableBytes: 2_500_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: 0,
      appUsedBytes: 0,
      lowMemory: false,
      thresholdBytes: 250_000_000,
    });
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ size: 1_700_000_000, fitsInRam: false }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1_700_000_000 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].fitsInRam).toBe(true);
    expect(updatedModels[0].metadataTrust).toBe('verified_local');
    expect(updatedModels[0].gguf).toEqual(expect.objectContaining({ totalBytes: 1_700_000_000 }));
  });

  it('recomputes a RAM warning decision for large verified downloaded models', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8_000_000_000);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 3_784_824_896,
        fitsInRam: true,
        memoryFitDecision: undefined,
        metadataTrust: 'verified_local',
        gguf: {
          architecture: 'llama',
          'llama.block_count': 32,
          'llama.attention.head_count': 32,
          'llama.attention.head_count_kv': 32,
          'llama.embedding_length': 4096,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 3_784_824_896 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].fitsInRam).toBe(false);
    expect(['borderline', 'likely_oom']).toContain(updatedModels[0].memoryFitDecision);
  });

  it('clears stale likely_oom decisions when validation recomputes a safer fit', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 1_700_000_000,
        fitsInRam: false,
        memoryFitDecision: 'likely_oom',
        memoryFitConfidence: 'high',
        metadataTrust: 'verified_local',
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1_700_000_000 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].fitsInRam).toBe(true);
    expect(['fits_high_confidence', 'fits_low_confidence']).toContain(updatedModels[0].memoryFitDecision);
  });

  it('normalizes legacy persisted metadata with missing access fields and zero size', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      name: 'legacy',
      author: 'legacy',
      size: 0,
      downloadUrl: 'http://example.com/model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    });

    expect(normalized.size).toBeNull();
    expect(normalized.fitsInRam).toBeNull();
    expect(normalized.accessState).toBe(ModelAccessState.PUBLIC);
    expect(normalized.isGated).toBe(false);
    expect(normalized.isPrivate).toBe(false);
  });

  it('persists and returns calibration records keyed by configuration', () => {
    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;
    (freshRegistry as any).cachedCalibrationRecordsByKey = null;

    mockStorage.getString.mockImplementation(() => null);

    freshRegistry.saveCalibrationRecord({
      key: ' test-key ',
      sampleCount: 1,
      successCount: 1,
      failureCount: 0,
      weightsCorrectionFactor: 1,
      computeCorrectionFactor: 1,
      overheadCorrectionFactor: 1,
      failurePenaltyFactor: 1,
      lastObservedAtMs: 123,
    });

    expect(mockStorage.set).toHaveBeenCalledWith(
      'memory-fit-calibration-records-v1',
      expect.stringContaining('"key":"test-key"'),
    );

    expect(freshRegistry.getCalibrationRecord('test-key')).toMatchObject({
      key: 'test-key',
      sampleCount: 1,
      successCount: 1,
      failureCount: 0,
    });
  });

  it('hydrates calibration records stored as an object map', () => {
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'memory-fit-calibration-records-v1') {
        return JSON.stringify({
          'legacy-key': {
            key: 'legacy-key',
            sampleCount: 2,
            successCount: 2,
            failureCount: 0,
            weightsCorrectionFactor: 1,
            computeCorrectionFactor: 1,
            overheadCorrectionFactor: 1,
            failurePenaltyFactor: 1,
            lastObservedAtMs: 5,
          },
        });
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;
    (freshRegistry as any).cachedCalibrationRecordsByKey = null;

    expect(freshRegistry.getCalibrationRecord('legacy-key')).toMatchObject({
      key: 'legacy-key',
      sampleCount: 2,
      successCount: 2,
      failureCount: 0,
    });
  });

  it('does not mutate cached calibration records when private storage blocks before save', () => {
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'memory-fit-calibration-records-v1') {
        return JSON.stringify({
          existing: {
            key: 'existing',
            sampleCount: 1,
            successCount: 1,
            failureCount: 0,
            weightsCorrectionFactor: 1,
            computeCorrectionFactor: 1,
            overheadCorrectionFactor: 1,
            failurePenaltyFactor: 1,
            lastObservedAtMs: 1,
          },
        });
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;
    expect(freshRegistry.getCalibrationRecord('existing')).toMatchObject({ key: 'existing' });

    const blockedError = Object.assign(new Error('private storage blocked'), {
      name: 'PrivateStorageUnavailableError',
    });
    mockStorage.set.mockClear();
    (assertPrivateStorageWritable as jest.Mock).mockImplementationOnce(() => {
      throw blockedError;
    });

    expect(() => freshRegistry.saveCalibrationRecord({
      key: 'blocked',
      sampleCount: 1,
      successCount: 1,
      failureCount: 0,
      weightsCorrectionFactor: 1,
      computeCorrectionFactor: 1,
      overheadCorrectionFactor: 1,
      failurePenaltyFactor: 1,
      lastObservedAtMs: 2,
    })).toThrow(blockedError);

    expect(mockStorage.set).not.toHaveBeenCalled();
    expect(freshRegistry.getCalibrationRecord('blocked')).toBeUndefined();
    expect(freshRegistry.getCalibrationRecord('existing')).toMatchObject({ key: 'existing' });
  });

  it('does not mutate cached models when private storage blocks before update', () => {
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([mockModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(mockModel);
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;
    expect(freshRegistry.getModel(mockModel.id)?.name).toBe('model');

    const blockedError = Object.assign(new Error('private storage blocked'), {
      name: 'PrivateStorageUnavailableError',
    });
    mockStorage.set.mockClear();
    mockStorage.remove.mockClear();
    (assertPrivateStorageWritable as jest.Mock).mockImplementationOnce(() => {
      throw blockedError;
    });

    expect(() => freshRegistry.updateModel(createMockModel({ name: 'blocked-update' }))).toThrow(blockedError);

    expect(mockStorage.set).not.toHaveBeenCalled();
    expect(mockStorage.remove).not.toHaveBeenCalled();
    expect(freshRegistry.getModel(mockModel.id)?.name).toBe('model');
  });

  it('does not delete model files or mutate cache when private storage blocks before removal', async () => {
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([mockModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(mockModel);
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;
    expect(freshRegistry.getModel(mockModel.id)?.localPath).toBe('model.gguf');

    const blockedError = Object.assign(new Error('private storage blocked'), {
      name: 'PrivateStorageUnavailableError',
    });
    mockStorage.remove.mockClear();
    (FileSystem.deleteAsync as jest.Mock).mockClear();
    (assertPrivateStorageWritable as jest.Mock).mockImplementationOnce(() => {
      throw blockedError;
    });

    await expect(freshRegistry.removeModel(mockModel.id)).rejects.toThrow(blockedError);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(mockStorage.remove).not.toHaveBeenCalled();
    expect(freshRegistry.getModel(mockModel.id)?.localPath).toBe('model.gguf');
  });

  it('hydrates the registry from storage once and serves repeated lookups from cache', () => {
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([mockModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(mockModel);
      }

      return null;
    });
    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    const firstModel = freshRegistry.getModel(mockModel.id);
    const secondModel = freshRegistry.getModel(mockModel.id);
    const allModels = freshRegistry.getModels();

    expect(firstModel?.id).toBe(mockModel.id);
    expect(secondModel?.id).toBe(mockModel.id);
    expect(allModels).toHaveLength(1);
    expect(mockStorage.getString).toHaveBeenCalledWith('models-registry:index-v1');
    expect(mockStorage.getString).toHaveBeenCalledWith('models-registry:model-v1:test%2Fmodel');

    const callCountAfterFirstHydration = mockStorage.getString.mock.calls.length;
    freshRegistry.getModel(mockModel.id);
    freshRegistry.getModels();
    expect(mockStorage.getString.mock.calls.length).toBe(callCountAfterFirstHydration);
  });

  it('updates a single model via per-model storage keys (no full-array rewrite)', () => {
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([mockModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(mockModel);
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    freshRegistry.updateModel(createMockModel({ name: 'updated-name' }));

    expect(mockStorage.set).toHaveBeenCalledWith(
      'models-registry:model-v1:test%2Fmodel',
      expect.stringContaining('"name":"updated-name"'),
    );
    expect(mockStorage.set).not.toHaveBeenCalledWith('models-registry', expect.anything());
  });

  it('migrates the legacy array registry into index + per-model keys', () => {
    mockStorage.getAllKeys.mockReturnValue(['models-registry:model-v1:stale%2Fmodel']);
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return null;
      }

      if (key === 'models-registry') {
        return JSON.stringify([mockModel]);
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    const models = freshRegistry.getModels();

    expect(models).toHaveLength(1);
    expect(mockStorage.set).toHaveBeenCalledWith('models-registry:index-v1', JSON.stringify([mockModel.id]));
    expect(mockStorage.set).toHaveBeenCalledWith(
      'models-registry:model-v1:test%2Fmodel',
      expect.stringContaining('"id":"test/model"'),
    );
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry');
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry:model-v1:stale%2Fmodel');
  });

  it('rebuilds an invalid models index by discovering per-model keys', () => {
    mockStorage.getAllKeys.mockReturnValue(['models-registry:model-v1:test%2Fmodel']);
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify({ broken: true });
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(mockModel);
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    const models = freshRegistry.getModels();

    expect(models).toHaveLength(1);
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry:index-v1');
    expect(mockStorage.set).toHaveBeenCalledWith('models-registry:index-v1', JSON.stringify([mockModel.id]));
  });

  it('resets downloaded models when the models directory is unavailable', async () => {
    let promise: Promise<unknown> | null = null;

    jest.isolateModules(() => {
      jest.doMock('../../src/services/FileSystemSetup', () => ({
        getModelsDir: () => null,
      }));

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registry: isolatedRegistry } = require('../../src/services/LocalStorageRegistry') as typeof import('../../src/services/LocalStorageRegistry');

      (isolatedRegistry.getModels as jest.Mock) = jest.fn().mockReturnValue([
        createMockModel({ lifecycleStatus: LifecycleStatus.DOWNLOADED, localPath: 'model.gguf' }),
        createMockModel({ id: 'test/active', lifecycleStatus: LifecycleStatus.ACTIVE, localPath: 'active.gguf' }),
      ]);
      (isolatedRegistry.saveModels as jest.Mock) = jest.fn();

      promise = (async () => {
        await isolatedRegistry.validateRegistry();

        expect(isolatedRegistry.saveModels).toHaveBeenCalled();
        const updatedModels = (isolatedRegistry.saveModels as jest.Mock).mock.calls[0][0] as ModelMetadata[];
        expect(updatedModels[0].localPath).toBeUndefined();
        expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
        expect(updatedModels[1].localPath).toBeUndefined();
        expect(updatedModels[1].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
      })();
    });

    await promise;
  });

  it('quarantines orphaned files while preserving completed and queued ones', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ localPath: 'keep.gguf', lifecycleStatus: LifecycleStatus.DOWNLOADED }),
    ]);

    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'keep.gguf',
      'queued.gguf',
      'orphan.gguf',
      '../bad',
    ]);

    await registry.validateRegistry(['queued.gguf']);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const quarantinePayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(quarantinePayload).toEqual(expect.stringContaining('orphan.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('keep.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('queued.gguf'));
  });

  it('deletes quarantined model files only through explicit cleanup', async () => {
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'quarantined-model-files-v1'
        ? JSON.stringify({
          files: [
            { fileName: 'orphan.gguf', detectedAt: 1, reason: 'orphaned' },
            { fileName: 'keep.gguf', detectedAt: 2, reason: 'orphaned' },
          ],
        })
        : null
    ));

    await expect(registry.deleteQuarantinedModelFiles(['orphan.gguf'])).resolves.toBe(1);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/orphan.gguf', { idempotent: true });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/keep.gguf', expect.anything());
    const nextPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(nextPayload).toEqual(expect.stringContaining('keep.gguf'));
    expect(nextPayload).not.toEqual(expect.stringContaining('orphan.gguf'));
  });

  it('preserves model files that existed before a private storage reset', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([]);
    (FileSystem.readDirectoryAsync as jest.Mock)
      .mockResolvedValueOnce(['pre-reset.gguf', '../bad'])
      .mockResolvedValueOnce(['pre-reset.gguf', 'new-orphan.gguf']);

    await registry.preserveExistingModelFilesForPrivateStorageReset();
    const preservationPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'private-reset-preserved-model-files-v1',
    )?.[1];
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'private-reset-preserved-model-files-v1' ? preservationPayload : null
    ));

    await registry.validateRegistry([]);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const quarantinePayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(quarantinePayload).toEqual(expect.stringContaining('new-orphan.gguf'));
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/pre-reset.gguf', expect.anything());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/../bad', expect.anything());
  });

  it('suspends orphan cleanup when reset-time model file snapshot fails', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([]);
    (FileSystem.readDirectoryAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('directory temporarily unavailable'))
      .mockResolvedValueOnce(['preserved-after-rescan.gguf', 'also-preserved.gguf']);

    await registry.preserveExistingModelFilesForPrivateStorageReset();
    const preservationPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'private-reset-preserved-model-files-v1',
    )?.[1];
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'private-reset-preserved-model-files-v1' ? preservationPayload : null
    ));

    await registry.validateRegistry([]);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(mockStorage.set).toHaveBeenLastCalledWith(
      'private-reset-preserved-model-files-v1',
      expect.stringContaining('preserved-after-rescan.gguf'),
    );
  });
});
