import { LocalStorageRegistry, registry } from '../../src/services/LocalStorageRegistry';
import { LifecycleStatus, ModelAccessState, ModelMetadata } from '../../src/types/models';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';

const mockStorage = {
  getString: jest.fn(),
  set: jest.fn(),
  remove: jest.fn(),
};

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  documentDirectory: 'test-dir/',
}));

jest.mock('../../src/services/storage', () => ({
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

  beforeAll(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    consoleWarnSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue(null);
    (registry as any).getModels = originalGetModels;
    (registry as any).getModel = originalGetModel;
    (registry as any).saveModels = originalSaveModels;
    (registry as any).cachedModels = null;
    (registry as any).cachedModelsById = null;
    (registry as any).cachedCalibrationRecordsByKey = null;
  });

  it('should remove model and delete file', async () => {
    const model = createMockModel();
    // Mock getModels to return our model
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([model]);
    (registry.getModel as jest.Mock) = jest.fn().mockReturnValue(model);
    (registry.saveModels as jest.Mock) = jest.fn();

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalled();
    expect(registry.saveModels).toHaveBeenCalledWith([]);
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

  it('hydrates the registry from storage once and serves repeated lookups from cache', () => {
    mockStorage.getString.mockReturnValue(JSON.stringify([mockModel]));
    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    const firstModel = freshRegistry.getModel(mockModel.id);
    const secondModel = freshRegistry.getModel(mockModel.id);
    const allModels = freshRegistry.getModels();

    expect(firstModel?.id).toBe(mockModel.id);
    expect(secondModel?.id).toBe(mockModel.id);
    expect(allModels).toHaveLength(1);
    expect(mockStorage.getString).toHaveBeenCalledTimes(1);
  });
});
