import { LocalStorageRegistry, registry } from '../../src/services/LocalStorageRegistry';
import {
  LifecycleStatus,
  ModelAccessState,
  ModelMetadata,
  type ModelArtifactMetadata,
} from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { assertPrivateStorageWritable, createStorage } from '../../src/services/storage';
import { UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES } from '../../src/utils/modelSize';

const mockStorage = {
  getString: jest.fn(),
  set: jest.fn(),
  remove: jest.fn(),
  getAllKeys: jest.fn().mockReturnValue([]),
};

const mockValidGgufHeaderBase64 = Buffer.from(Uint8Array.from([
  0x47, 0x47, 0x55, 0x46, // GGUF
  0x03, 0x00, 0x00, 0x00, // version 3
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // tensor count
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // metadata kv count
])).toString('base64');

const mockInvalidGgufHeaderBase64 = Buffer.from(Uint8Array.from([
  0x42, 0x41, 0x44, 0x21, // invalid magic
  0x03, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])).toString('base64');
const VALID_SHA256 = 'a'.repeat(64);
const OTHER_VALID_SHA256 = 'b'.repeat(64);

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 1000 }),
  readAsStringAsync: jest.fn().mockResolvedValue(mockValidGgufHeaderBase64),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  documentDirectory: 'test-dir/',
  EncodingType: { Base64: 'base64' },
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

function createProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'projector-test-model-main-mmproj-model.gguf',
    ownerModelId: mockModel.id,
    repoId: mockModel.id,
    fileName: 'mmproj-model.gguf',
    downloadUrl: 'http://example.com/mmproj-model.gguf',
    size: 1000,
    lifecycleStatus: 'downloaded',
    matchStatus: 'matched',
    localPath: 'mmproj-model.gguf',
    ...overrides,
  };
}

function createProjectorArtifact(
  overrides: Partial<ModelArtifactMetadata> = {},
): ModelArtifactMetadata {
  return {
    id: 'projector-test-model-main-mmproj-model.gguf',
    kind: 'multimodal_projector',
    requiredFor: ['image'],
    remoteFileName: 'mmproj-model.gguf',
    downloadUrl: 'http://example.com/mmproj-model.gguf',
    sizeBytes: 1000,
    localPath: 'mmproj-model.gguf',
    installState: 'installed',
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
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1000 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(mockValidGgufHeaderBase64);
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

  it('removes downloaded projector files with the owning model', async () => {
    const model = createMockModel({
      projectorCandidates: [createProjector()],
    });
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

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/model.gguf');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/mmproj-model.gguf');
  });

  it('removes failed projector partial files with the owning model', async () => {
    const model = createMockModel({
      projectorCandidates: [createProjector({
        lifecycleStatus: 'failed',
        matchStatus: 'failed',
        localPath: 'mmproj-partial.gguf',
        resumeData: 'projector-resume-data',
      })],
    });
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

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/model.gguf');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/mmproj-partial.gguf');
  });

  it('removes variant-only and artifact-only projector files exactly once with the owning model', async () => {
    const variantProjector = createProjector({
      id: 'test/model:q4-projector',
      ownerVariantId: 'q4',
      fileName: 'variant-mmproj.gguf',
      localPath: 'variant-mmproj.gguf',
    });
    const model = createMockModel({
      variants: [{
        variantId: 'q4',
        fileName: 'model-q4.gguf',
        quantizationLabel: 'Q4',
        size: 1000,
        projectorCandidates: [variantProjector],
      }],
      artifacts: [
        createProjectorArtifact({
          id: variantProjector.id,
          remoteFileName: variantProjector.fileName,
          localPath: variantProjector.localPath,
        }),
        createProjectorArtifact({
          id: 'test/model:artifact-only-projector',
          remoteFileName: 'artifact-only-mmproj.gguf',
          localPath: 'artifact-only-mmproj.gguf',
        }),
      ],
    });
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

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/variant-mmproj.gguf');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/artifact-only-mmproj.gguf');
    expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      ([uri]) => uri === 'test-dir/models/variant-mmproj.gguf',
    )).toHaveLength(1);
  });

  it('protects projector files referenced only by a remaining variant or artifact', async () => {
    const model = createMockModel({
      projectorCandidates: [
        createProjector({ localPath: 'variant-shared-mmproj.gguf' }),
        createProjector({
          id: 'test/model:artifact-shared-projector',
          fileName: 'artifact-shared-mmproj.gguf',
          localPath: 'artifact-shared-mmproj.gguf',
        }),
      ],
    });
    const otherModel = createMockModel({
      id: 'test/other-model',
      localPath: 'other-model.gguf',
      variants: [{
        variantId: 'q4',
        fileName: 'other-model-q4.gguf',
        quantizationLabel: 'Q4',
        size: 1000,
        projectorCandidates: [createProjector({
          id: 'test/other-model:q4-projector',
          ownerModelId: 'test/other-model',
          ownerVariantId: 'q4',
          fileName: 'variant-shared-mmproj.gguf',
          localPath: 'variant-shared-mmproj.gguf',
        })],
      }],
      artifacts: [createProjectorArtifact({
        id: 'test/other-model:artifact-projector',
        remoteFileName: 'artifact-shared-mmproj.gguf',
        localPath: 'artifact-shared-mmproj.gguf',
      })],
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id, otherModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      if (key === 'models-registry:model-v1:test%2Fother-model') {
        return JSON.stringify(otherModel);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/variant-shared-mmproj.gguf');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/artifact-shared-mmproj.gguf');
  });

  it('keeps a downloaded projector file when another model association still references it', async () => {
    const sharedProjector = createProjector();
    const model = createMockModel({
      projectorCandidates: [sharedProjector],
    });
    const otherModel = createMockModel({
      id: 'test/other-model',
      localPath: 'other-model.gguf',
      projectorCandidates: [
        createProjector({
          id: 'projector-test-other-main-mmproj-model.gguf',
          ownerModelId: 'test/other-model',
          localPath: sharedProjector.localPath,
        }),
      ],
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id, otherModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      if (key === 'models-registry:model-v1:test%2Fother-model') {
        return JSON.stringify(otherModel);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/model.gguf');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/mmproj-model.gguf');
  });

  it('keeps a projector file when another model localPath still references it', async () => {
    const model = createMockModel({
      projectorCandidates: [createProjector({ localPath: 'shared-cross-asset.gguf' })],
    });
    const otherModel = createMockModel({
      id: 'test/other-model',
      localPath: 'shared-cross-asset.gguf',
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id, otherModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      if (key === 'models-registry:model-v1:test%2Fother-model') {
        return JSON.stringify(otherModel);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/model.gguf');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/shared-cross-asset.gguf');
  });

  it('keeps a model file when another model projector still references it', async () => {
    const model = createMockModel({ localPath: 'shared-cross-asset.gguf' });
    const otherModel = createMockModel({
      id: 'test/other-model',
      localPath: 'other-model.gguf',
      projectorCandidates: [
        createProjector({
          id: 'projector-test-other-main-shared-cross-asset.gguf',
          ownerModelId: 'test/other-model',
          localPath: 'shared-cross-asset.gguf',
        }),
      ],
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id, otherModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      if (key === 'models-registry:model-v1:test%2Fother-model') {
        return JSON.stringify(otherModel);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/shared-cross-asset.gguf');
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry:model-v1:test%2Fmodel');
  });

  it('deletes a model file when only stale available model metadata still references it', async () => {
    const model = createMockModel({ localPath: 'stale-available-model.gguf' });
    const otherModel = createMockModel({
      id: 'test/other-model',
      localPath: 'stale-available-model.gguf',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id, otherModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      if (key === 'models-registry:model-v1:test%2Fother-model') {
        return JSON.stringify(otherModel);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/stale-available-model.gguf');
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry:model-v1:test%2Fmodel');
  });

  it('deletes a projector file when only stale available projector metadata still references it', async () => {
    const model = createMockModel({
      projectorCandidates: [createProjector({ localPath: 'stale-available-projector.gguf' })],
    });
    const otherModel = createMockModel({
      id: 'test/other-model',
      localPath: 'other-model.gguf',
      projectorCandidates: [
        createProjector({
          id: 'projector-test-other-main-stale-available-projector.gguf',
          ownerModelId: 'test/other-model',
          lifecycleStatus: 'available',
          localPath: 'stale-available-projector.gguf',
        }),
      ],
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id, otherModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      if (key === 'models-registry:model-v1:test%2Fother-model') {
        return JSON.stringify(otherModel);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/model.gguf');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/stale-available-projector.gguf');
  });

  it('keeps a failed projector partial when another model association still references it', async () => {
    const sharedProjector = createProjector({
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      localPath: 'shared-mmproj-partial.gguf',
    });
    const model = createMockModel({
      projectorCandidates: [sharedProjector],
    });
    const otherModel = createMockModel({
      id: 'test/other-model',
      localPath: 'other-model.gguf',
      projectorCandidates: [
        createProjector({
          id: 'projector-test-other-main-mmproj-model.gguf',
          ownerModelId: 'test/other-model',
          lifecycleStatus: 'paused',
          localPath: sharedProjector.localPath,
        }),
      ],
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id, otherModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      if (key === 'models-registry:model-v1:test%2Fother-model') {
        return JSON.stringify(otherModel);
      }

      return null;
    });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/model.gguf');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/shared-mmproj-partial.gguf');
  });

  it('should remove model metadata without deleting a directory localPath', async () => {
    const model = createMockModel({ localPath: 'nested-cache' });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      return null;
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, isDirectory: true });

    await registry.removeModel(model.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(mockStorage.remove).toHaveBeenCalledWith('models-registry:model-v1:test%2Fmodel');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[LocalStorageRegistry] Model asset localPath points to a directory, skipping file deletion',
      expect.objectContaining({
        fileKind: 'model',
        pathCategory: 'model_storage',
        scope: 'model_asset_delete',
      }),
    );
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain(model.id);
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain(model.localPath ?? '');
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

  it('should reset downloaded models whose local path points to a directory', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ localPath: 'nested-cache' }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: true });

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
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
        resumeData: 'stale-resume-data',
        downloadErrorAt: 456,
        downloadErrorCode: 'download_http_error',
        downloadErrorMessage: 'HTTP status 500',
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
    expect(updatedModels[0].resumeData).toBeUndefined();
    expect(updatedModels[0].downloadErrorAt).toBeUndefined();
    expect(updatedModels[0].downloadErrorCode).toBeUndefined();
    expect(updatedModels[0].downloadErrorMessage).toBeUndefined();
  });

  it('resets downloaded projector associations when the projector file is missing', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        projectorCandidates: [createProjector()],
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri.endsWith('/model.gguf')) {
        return { exists: true, size: 1000 };
      }

      if (uri.endsWith('/mmproj-model.gguf')) {
        return { exists: false };
      }

      return { exists: true, size: 1000 };
    });

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      localPath: undefined,
      matchStatus: 'matched',
    }));
  });

  it('resets missing variant-only and artifact-only projector runtime state together', async () => {
    const variantProjector = createProjector({
      id: 'test/model:q4-projector',
      ownerVariantId: 'q4',
      fileName: 'variant-missing-mmproj.gguf',
      localPath: 'variant-missing-mmproj.gguf',
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: 'stale failure',
    });
    const model = createMockModel({
      variants: [{
        variantId: 'q4',
        fileName: 'model-q4.gguf',
        quantizationLabel: 'Q4',
        size: 1000,
        projectorCandidates: [variantProjector],
      }],
      artifacts: [
        createProjectorArtifact({
          id: variantProjector.id,
          remoteFileName: variantProjector.fileName,
          localPath: variantProjector.localPath,
        }),
        createProjectorArtifact({
          id: 'test/model:artifact-only-projector',
          remoteFileName: 'artifact-only-missing-mmproj.gguf',
          localPath: 'artifact-only-missing-mmproj.gguf',
          errorCode: 'STALE_ERROR',
          errorMessage: 'stale artifact failure',
          updatedAt: 123,
        }),
      ],
      multimodalReadiness: {
        modelId: mockModel.id,
        status: 'ready',
        support: ['vision'],
        projectorId: variantProjector.id,
        projectorSize: 1000,
        checkedAt: 1,
      },
    });
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([model]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri.endsWith('/model.gguf')
        ? { exists: true, size: 1000 }
        : { exists: false }
    ));

    await registry.validateRegistry();

    const updatedModel = (registry.saveModels as jest.Mock).mock.calls[0][0][0] as ModelMetadata;
    expect(updatedModel.variants?.[0].projectorCandidates?.[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      localPath: undefined,
      matchStatus: 'matched',
      matchReason: undefined,
    }));
    expect(updatedModel.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: variantProjector.id, installState: 'missing', localPath: undefined }),
      expect.objectContaining({
        id: 'test/model:artifact-only-projector',
        installState: 'missing',
        localPath: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        updatedAt: undefined,
      }),
    ]));
    expect(updatedModel.multimodalReadiness).toBeUndefined();
  });

  it('does not reset a conflicting same-id artifact without the same physical path', async () => {
    const variantProjector = createProjector({
      id: 'test/model:q4-projector',
      ownerVariantId: 'q4',
      fileName: 'variant-missing-mmproj.gguf',
      localPath: undefined,
    });
    const conflictingArtifact = createProjectorArtifact({
      id: variantProjector.id,
      remoteFileName: 'different-mmproj.gguf',
      downloadUrl: 'http://example.com/different-mmproj.gguf',
      localPath: 'different-mmproj.gguf',
    });
    const model = createMockModel({
      variants: [{
        variantId: 'q4',
        fileName: 'model-q4.gguf',
        quantizationLabel: 'Q4',
        size: 1000,
        projectorCandidates: [variantProjector],
      }],
      artifacts: [conflictingArtifact],
    });
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([model]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri.endsWith('/different-mmproj.gguf') || uri.endsWith('/model.gguf')
        ? { exists: true, size: 1000 }
        : { exists: false }
    ));

    await registry.validateRegistry();

    const updatedModel = (registry.saveModels as jest.Mock).mock.calls[0]?.[0]?.[0] ?? model;
    expect(updatedModel.variants?.[0].projectorCandidates?.[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      localPath: undefined,
    }));
    expect(updatedModel.artifacts?.[0]).toEqual(expect.objectContaining({
      id: conflictingArtifact.id,
      installState: 'installed',
      localPath: 'different-mmproj.gguf',
    }));
  });

  it('resets downloaded projector associations when localPath is missing', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        projectorCandidates: [createProjector({ localPath: undefined })],
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      localPath: undefined,
      matchStatus: 'matched',
    }));
  });

  it('clears ready multimodal readiness when a matching downloaded projector localPath is missing', async () => {
    const projector = createProjector({ localPath: undefined });
    const model = createMockModel({
      projectorCandidates: [projector],
      multimodalReadiness: {
        modelId: mockModel.id,
        status: 'ready',
        projectorId: projector.id,
        projectorSize: 1000,
        support: ['vision'],
        checkedAt: 123,
      },
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([model.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(model);
      }

      return null;
    });
    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    await freshRegistry.validateRegistry();

    const updatedModel = freshRegistry.getModel(model.id);
    expect(updatedModel?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
    }));
    expect(updatedModel?.projectorCandidates?.[0].localPath).toBeUndefined();
    expect(updatedModel?.multimodalReadiness).toBeUndefined();

    const persistedModelCall = mockStorage.set.mock.calls.find(([key]) => (
      key === 'models-registry:model-v1:test%2Fmodel'
    ));
    expect(persistedModelCall).toBeDefined();
    expect(JSON.parse(persistedModelCall?.[1] as string).multimodalReadiness).toBeUndefined();
  });

  it('resets active projector associations when localPath is missing', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        projectorCandidates: [createProjector({ lifecycleStatus: 'active', localPath: undefined })],
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      localPath: undefined,
      matchStatus: 'matched',
    }));
  });

  it.each(['queued', 'downloading', 'paused', 'failed'] as const)(
    'preserves %s projector associations when localPath is missing',
    async (lifecycleStatus) => {
      const projector = createProjector({ lifecycleStatus, localPath: undefined });
      const model = createMockModel({
        projectorCandidates: [projector],
      });
      (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([model]);
      (registry.saveModels as jest.Mock) = jest.fn();

      await registry.validateRegistry();

      const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0]?.[0] ?? [model];
      expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
        lifecycleStatus,
        localPath: undefined,
        matchStatus: 'matched',
      }));
    },
  );

  it('preserves downloaded projector associations when localPath is valid', async () => {
    const projector = createProjector();
    const model = createMockModel({
      projectorCandidates: [projector],
    });
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([model]);
    (registry.saveModels as jest.Mock) = jest.fn();

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0]?.[0] ?? [model];
    expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      matchStatus: 'matched',
    }));
  });

  it('resets downloaded projector associations when the local projector size no longer matches metadata', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        projectorCandidates: [createProjector({ size: 2048 })],
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri.endsWith('/model.gguf')) {
        return { exists: true, size: 1000 };
      }

      if (uri.endsWith('/mmproj-model.gguf')) {
        return { exists: true, size: 1000 };
      }

      return { exists: true, size: 1000 };
    });

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      localPath: undefined,
      matchStatus: 'matched',
    }));
  });

  it('resets downloaded projector associations when projector GGUF validation fails', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        projectorCandidates: [createProjector({ resumeData: 'stale-projector-resume-data' })],
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri.endsWith('/model.gguf')) {
        return { exists: true, size: 1000 };
      }

      if (uri.endsWith('/mmproj-model.gguf')) {
        return { exists: true, size: 1000 };
      }

      return { exists: true, size: 1000 };
    });
    (FileSystem.readAsStringAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri.endsWith('/mmproj-model.gguf')
        ? mockInvalidGgufHeaderBase64
        : mockValidGgufHeaderBase64
    ));

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      localPath: undefined,
      resumeData: undefined,
      matchStatus: 'matched',
    }));
  });

  it('preserves downloaded projector associations when projector GGUF header cannot be read transiently', async () => {
    const projector = createProjector();
    const model = createMockModel({
      projectorCandidates: [projector],
    });
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      model,
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri.endsWith('/model.gguf')) {
        return { exists: true, size: 1000 };
      }

      if (uri.endsWith('/mmproj-model.gguf')) {
        return { exists: true, size: 1000 };
      }

      return { exists: true, size: 1000 };
    });
    (FileSystem.readAsStringAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri.endsWith('/mmproj-model.gguf')) {
        throw new Error('transient read failed');
      }

      return mockValidGgufHeaderBase64;
    });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0]?.[0] ?? [model];
    expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      matchStatus: 'matched',
    }));
  });

  it('clears stale local paths for non-downloaded registry entries before quarantine scans', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        localPath: 'stale.gguf',
        downloadedAt: 123,
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 1000,
          checkedAt: 10,
        },
        metadataTrust: 'verified_local',
        downloadProgress: 1,
        resumeData: 'stale-resume-data',
        downloadErrorAt: 456,
        downloadErrorCode: 'download_http_error',
        downloadErrorMessage: 'HTTP status 500',
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce(['stale.gguf']);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1000 });

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadedAt).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].downloadProgress).toBe(0);
    expect(updatedModels[0].resumeData).toBeUndefined();
    expect(updatedModels[0].downloadErrorAt).toBeUndefined();
    expect(updatedModels[0].downloadErrorCode).toBeUndefined();
    expect(updatedModels[0].downloadErrorMessage).toBeUndefined();

    const quarantinePayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(quarantinePayload).toEqual(expect.stringContaining('stale.gguf'));
  });

  it('should normalize persisted active models back to downloaded on bootstrap', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ lifecycleStatus: LifecycleStatus.ACTIVE }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1000 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
  });

  it('hydrates valid no-marker local files without promoting metadata trust or fabricating OOM', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(1024);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ size: null, fitsInRam: null, metadataTrust: undefined, gguf: undefined }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 2048 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].size).toBe(2048);
    expect(updatedModels[0].fitsInRam).toBeNull();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('resets no-marker downloaded local files that fail GGUF validation', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 2048,
        downloadedAt: 123,
        metadataTrust: 'verified_local',
        downloadProgress: 1,
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 2048 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(mockInvalidGgufHeaderBase64);

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadedAt).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].downloadProgress).toBe(0);
  });

  it('resets downloaded state when the local file no longer matches its integrity marker size', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 1000,
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
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 999 });

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadedAt).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].downloadProgress).toBe(0);
  });

  it('keeps matching size integrity markers limited without fabricating OOM', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(1024);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 2048,
        fitsInRam: null,
        metadataTrust: 'verified_local',
        gguf: undefined,
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 2048,
          checkedAt: 10,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 2048 });

    await registry.validateRegistry();

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('test-dir/models/model.gguf', expect.objectContaining({
      encoding: FileSystem.EncodingType.Base64,
    }));
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].size).toBe(2048);
    expect(updatedModels[0].fitsInRam).toBeNull();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('resets matching size integrity markers when GGUF header validation fails', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 2048,
        metadataTrust: 'verified_local',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 2048 },
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 2048,
          checkedAt: 10,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 2048 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(mockInvalidGgufHeaderBase64);

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].fitsInRam).toBeNull();
    expect(updatedModels[0].memoryFitDecision).toBeUndefined();
    expect(updatedModels[0].memoryFitConfidence).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('keeps matching sha256 integrity markers verified_local after lightweight registry validation', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        sha256: VALID_SHA256,
        metadataTrust: 'verified_local',
        gguf: { architecture: 'llama' },
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
          sha256: `sha256:${VALID_SHA256.toUpperCase()}`,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });

    await registry.validateRegistry();

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('test-dir/models/model.gguf', expect.objectContaining({
      encoding: FileSystem.EncodingType.Base64,
    }));
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].sha256).toBe(VALID_SHA256);
    expect(updatedModels[0].downloadIntegrity).toEqual(expect.objectContaining({
      kind: 'sha256',
      sha256: VALID_SHA256,
    }));
    expect(updatedModels[0].metadataTrust).toBe('verified_local');
    expect(updatedModels[0].gguf).toEqual(expect.objectContaining({
      architecture: 'llama',
      totalBytes: 4096,
    }));
  });

  it('resets matching sha256 integrity markers when GGUF header validation fails', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        sha256: VALID_SHA256,
        metadataTrust: 'verified_local',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
          sha256: VALID_SHA256,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(mockInvalidGgufHeaderBase64);

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].fitsInRam).toBeNull();
    expect(updatedModels[0].memoryFitDecision).toBeUndefined();
    expect(updatedModels[0].memoryFitConfidence).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('resets matching sha256 integrity markers when the digest is missing', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        metadataTrust: 'verified_local',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].fitsInRam).toBeNull();
    expect(updatedModels[0].memoryFitDecision).toBeUndefined();
    expect(updatedModels[0].memoryFitConfidence).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('resets sha256 integrity markers when the digest is malformed', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        sha256: VALID_SHA256,
        metadataTrust: 'verified_local',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
          sha256: 'abc123',
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
    expect(updatedModels[0].maxContextTokens).toBeUndefined();
    expect(updatedModels[0].hasVerifiedContextWindow).toBeUndefined();
  });

  it('resets sha256 integrity markers when the expected digest changes', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        sha256: OTHER_VALID_SHA256,
        metadataTrust: 'verified_local',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
          sha256: VALID_SHA256,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].downloadIntegrity).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
    expect(updatedModels[0].maxContextTokens).toBeUndefined();
    expect(updatedModels[0].hasVerifiedContextWindow).toBeUndefined();
  });

  it('keeps valid sha256 markers downloaded but untrusted when no expected digest is available', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        sha256: undefined,
        metadataTrust: 'verified_local',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
          sha256: VALID_SHA256,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(updatedModels[0].localPath).toBe('model.gguf');
    expect(updatedModels[0].downloadIntegrity).toEqual(expect.objectContaining({
      kind: 'sha256',
      sha256: VALID_SHA256,
    }));
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('preserves downloaded state but downgrades trust when GGUF header cannot be read during registry validation', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        sha256: VALID_SHA256,
        metadataTrust: 'verified_local',
        localPath: 'model.gguf',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
          sha256: VALID_SHA256,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });
    (FileSystem.readAsStringAsync as jest.Mock).mockRejectedValue(new Error('read failed'));

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0]).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'model.gguf',
      metadataTrust: undefined,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
      gguf: undefined,
    }));
  });

  it('does not rehash sha256 integrity markers during registry validation', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        sha256: VALID_SHA256,
        metadataTrust: 'verified_local',
        localPath: 'model.gguf',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4096,
          checkedAt: 10,
          sha256: VALID_SHA256,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0]?.[0] ?? registry.getModels();
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(updatedModels[0].localPath).toBe('model.gguf');
    expect(updatedModels[0].downloadIntegrity).toEqual(expect.objectContaining({ kind: 'sha256' }));
    expect(updatedModels[0].metadataTrust).toBe('verified_local');
    expect(updatedModels[0].fitsInRam).toBe(true);
    expect(updatedModels[0].memoryFitDecision).toBe('fits_high_confidence');
    expect(updatedModels[0].memoryFitConfidence).toBe('medium');
    expect(updatedModels[0].gguf).toEqual(expect.objectContaining({ architecture: 'llama', totalBytes: 4096 }));
  });

  it('preserves trusted remote metadata when GGUF header cannot be read', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 4096,
        metadataTrust: 'trusted_remote',
        localPath: 'model.gguf',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        gguf: { architecture: 'llama', totalBytes: 4096 },
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 4096,
          checkedAt: 10,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096 });
    (FileSystem.readAsStringAsync as jest.Mock).mockRejectedValue(new Error('read failed'));

    await registry.validateRegistry();

    expect(registry.saveModels).not.toHaveBeenCalled();
    expect(registry.getModels()[0]).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'model.gguf',
      metadataTrust: 'trusted_remote',
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      gguf: { architecture: 'llama', totalBytes: 4096 },
    }));
  });

  it('clears stale GGUF metadata before recomputing size-only models with missing trust', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 1_700_000_000,
        metadataTrust: undefined,
        localPath: 'model.gguf',
        fitsInRam: false,
        memoryFitDecision: 'likely_oom',
        memoryFitConfidence: 'high',
        gguf: {
          architecture: 'llama',
          'llama.block_count': 120,
          'llama.embedding_length': 8192,
          totalBytes: 1_700_000_000,
        },
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 1_700_000_000,
          checkedAt: 10,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1_700_000_000 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
    expect(updatedModels[0].fitsInRam).toBe(true);
    expect(updatedModels[0].memoryFitDecision).toBe('fits_low_confidence');
    expect(updatedModels[0].memoryFitConfidence).toBe('low');
  });

  it('resets no-marker downloaded files when local file size metadata is unavailable', async () => {
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
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].downloadProgress).toBe(0);
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
      createMockModel({
        size: 1_700_000_000,
        fitsInRam: false,
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 1_700_000_000,
          checkedAt: 10,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1_700_000_000 });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].fitsInRam).toBe(true);
    expect(updatedModels[0].metadataTrust).toBeUndefined();
    expect(updatedModels[0].gguf).toBeUndefined();
  });

  it('includes downloaded projector bytes when recomputing memory fit', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(2_000_000_000);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 100_000_000,
        metadataTrust: 'trusted_remote',
        localPath: 'model.gguf',
        fitsInRam: true,
        memoryFitDecision: 'fits_high_confidence',
        memoryFitConfidence: 'high',
        activeVariantId: 'q4',
        variants: [{
          variantId: 'q4',
          fileName: 'model-q4.gguf',
          quantizationLabel: 'Q4',
          size: 100_000_000,
          projectorCandidates: [createProjector({
            ownerVariantId: 'q4',
            size: 1_600_000_000,
            localPath: 'mmproj-model.gguf',
            lifecycleStatus: 'downloaded',
          })],
        }],
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 100_000_000,
          checkedAt: 10,
        },
      }),
    ]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri.endsWith('/model.gguf')) {
        return { exists: true, size: 100_000_000 };
      }

      if (uri.endsWith('/mmproj-model.gguf')) {
        return { exists: true, size: 1_600_000_000 };
      }

      return { exists: false };
    });

    await registry.validateRegistry();

    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].variants[0].projectorCandidates[0].size).toBe(1_600_000_000);
    expect(updatedModels[0].fitsInRam).toBe(false);
    expect(updatedModels[0].memoryFitDecision).toBe('likely_oom');
  });

  it.each(['downloaded', 'active'] as const)(
    'uses the unknown %s projector fallback only for memory-fit recalculation',
    async (lifecycleStatus) => {
      const modelSizeBytes = 100_000_000;
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(2_000_000_000);
      (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
        createMockModel({
          size: modelSizeBytes,
          metadataTrust: 'trusted_remote',
          localPath: 'model.gguf',
          fitsInRam: true,
          memoryFitDecision: 'fits_high_confidence',
          memoryFitConfidence: 'high',
          projectorCandidates: [createProjector({
            size: null,
            localPath: 'mmproj-model.gguf',
            lifecycleStatus,
          })],
          downloadIntegrity: {
            kind: 'size',
            sizeBytes: modelSizeBytes,
            checkedAt: 10,
          },
        }),
      ]);
      (registry.saveModels as jest.Mock) = jest.fn();
      (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
        if (uri.endsWith('/model.gguf')) {
          return { exists: true, size: modelSizeBytes };
        }

        if (uri.endsWith('/mmproj-model.gguf')) {
          return { exists: true, size: UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES * 2 };
        }

        return { exists: false };
      });
      (FileSystem.readAsStringAsync as jest.Mock).mockImplementation(async (uri: string) => {
        if (uri.endsWith('/mmproj-model.gguf')) {
          throw new Error('transient projector read failed');
        }

        return mockValidGgufHeaderBase64;
      });

      await registry.validateRegistry();

      const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
      expect(updatedModels[0].size).toBe(modelSizeBytes);
      expect(updatedModels[0].projectorCandidates[0].size).toBeNull();
      expect(updatedModels[0].projectorCandidates[0].lifecycleStatus).toBe('downloaded');
      expect(updatedModels[0].fitsInRam).toBe(false);
      expect(updatedModels[0].memoryFitDecision).toBe('likely_oom');
    },
  );

  it('recomputes a RAM warning decision for large verified downloaded models', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8_000_000_000);
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        size: 3_784_824_896,
        sha256: VALID_SHA256,
        fitsInRam: true,
        memoryFitDecision: undefined,
        metadataTrust: 'verified_local',
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 3_784_824_896,
          checkedAt: 10,
          sha256: VALID_SHA256,
        },
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
        sha256: VALID_SHA256,
        fitsInRam: false,
        memoryFitDecision: 'likely_oom',
        memoryFitConfidence: 'high',
        metadataTrust: 'verified_local',
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 1_700_000_000,
          checkedAt: 10,
          sha256: VALID_SHA256,
        },
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

  it('persists and deep-clones projector associations on model records', () => {
    const projector = createProjector({ localPath: 'mmproj-model.gguf' });
    const projectorArtifact = {
      id: 'projector-extra-artifact',
      kind: 'multimodal_projector' as const,
      requiredFor: ['image' as const],
      remoteFileName: projector.fileName,
      downloadUrl: projector.downloadUrl,
      sizeBytes: projector.size,
      localPath: projector.localPath,
      installState: 'installed' as const,
      integrity: {
        kind: 'size' as const,
        sizeBytes: 1000,
        checkedAt: 10,
      },
    };
    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    freshRegistry.updateModel(createMockModel({
      chatModalities: ['text', 'vision'],
      inputCapabilities: {
        detectedAt: 100,
        declared: {
          image: 'supported',
          audio: 'unknown',
          video: 'unsupported',
        },
        evidence: [
          { source: 'projector', value: projector.id, confidence: 'high' },
        ],
      },
      artifacts: [projectorArtifact],
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
    }));

    expect(mockStorage.set).toHaveBeenCalledWith(
      'models-registry:model-v1:test%2Fmodel',
      expect.stringContaining('"localPath":"mmproj-model.gguf"'),
    );

    const firstRead = freshRegistry.getModel(mockModel.id);
    firstRead?.projectorCandidates?.push(createProjector({ id: 'mutated-projector' }));
    firstRead?.artifacts?.[0]?.requiredFor.push('audio');
    if (firstRead?.artifacts?.[0]?.integrity) {
      firstRead.artifacts[0].integrity.checkedAt = 999;
    }
    if (firstRead?.inputCapabilities) {
      firstRead.inputCapabilities.declared.image = 'unsupported';
      firstRead.inputCapabilities.evidence.push({
        source: 'runtime',
        value: 'mutated',
        confidence: 'low',
      });
    }

    const secondRead = freshRegistry.getModel(mockModel.id);
    const secondReadArtifact = secondRead?.artifacts?.find((
      artifact: NonNullable<ModelMetadata['artifacts']>[number],
    ) => artifact.id === projectorArtifact.id);
    expect(secondRead?.projectorCandidates).toHaveLength(1);
    expect(secondRead?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: projector.id,
      localPath: 'mmproj-model.gguf',
      lifecycleStatus: 'downloaded',
    }));
    expect(secondReadArtifact).toEqual(expect.objectContaining({
      id: projectorArtifact.id,
      requiredFor: ['image'],
      integrity: {
        kind: 'size',
        sizeBytes: 1000,
        checkedAt: 10,
      },
    }));
    expect(secondRead?.inputCapabilities).toEqual(expect.objectContaining({
      declared: {
        image: 'supported',
        audio: 'unknown',
        video: 'unsupported',
      },
      evidence: [
        { source: 'projector', value: projector.id, confidence: 'high' },
      ],
    }));
  });

  it('updates the downloaded count only for completed local model files', () => {
    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    freshRegistry.updateModel(createMockModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      localPath: 'stale.gguf',
    }));
    expect(freshRegistry.getDownloadedModelsCount()).toBe(0);

    freshRegistry.updateModel(createMockModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'model.gguf',
    }));
    expect(freshRegistry.getDownloadedModelsCount()).toBe(1);

    freshRegistry.updateModel(createMockModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      localPath: 'model.gguf',
    }));
    expect(freshRegistry.getDownloadedModelsCount()).toBe(0);
  });

  it('does not count stale available localPath metadata as a downloaded model', () => {
    const staleModel = createMockModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      localPath: 'stale.gguf',
    });
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'models-registry:index-v1') {
        return JSON.stringify([staleModel.id]);
      }

      if (key === 'models-registry:model-v1:test%2Fmodel') {
        return JSON.stringify(staleModel);
      }

      return null;
    });

    const freshRegistry = new (LocalStorageRegistry as any)();
    (freshRegistry as any).storage = mockStorage;

    expect(freshRegistry.getModel(staleModel.id)?.localPath).toBe('stale.gguf');
    expect(freshRegistry.getDownloadedModelsCount()).toBe(0);
    expect(freshRegistry.hasAnyDownloadedModels()).toBe(false);
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
        createMockModel({
          id: 'test/stale',
          lifecycleStatus: LifecycleStatus.AVAILABLE,
          localPath: 'stale.gguf',
          downloadedAt: 123,
          downloadIntegrity: {
            kind: 'size',
            sizeBytes: 1000,
            checkedAt: 10,
          },
          metadataTrust: 'verified_local',
          downloadProgress: 1,
          resumeData: 'stale-resume-data',
          downloadErrorAt: 456,
          downloadErrorCode: 'download_http_error',
          downloadErrorMessage: 'HTTP status 500',
        }),
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
        expect(updatedModels[2].localPath).toBeUndefined();
        expect(updatedModels[2].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
        expect(updatedModels[2].downloadedAt).toBeUndefined();
        expect(updatedModels[2].downloadIntegrity).toBeUndefined();
        expect(updatedModels[2].metadataTrust).toBeUndefined();
        expect(updatedModels[2].downloadProgress).toBe(0);
        expect(updatedModels[2].resumeData).toBeUndefined();
        expect(updatedModels[2].downloadErrorAt).toBeUndefined();
        expect(updatedModels[2].downloadErrorCode).toBeUndefined();
        expect(updatedModels[2].downloadErrorMessage).toBeUndefined();
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
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[LocalStorageRegistry] Quarantined orphaned model files',
      expect.objectContaining({
        pathCategory: 'model_storage',
        scope: 'orphan_quarantine_scan',
        count: 1,
      }),
    );
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain('orphan.gguf');
  });

  it('preserves downloaded projector files during orphan quarantine scans', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        localPath: 'keep.gguf',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        projectorCandidates: [createProjector({ localPath: 'mmproj-model.gguf' })],
      }),
    ]);

    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'keep.gguf',
      'mmproj-model.gguf',
      'orphan.gguf',
    ]);

    await registry.validateRegistry([]);

    const quarantinePayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(quarantinePayload).toEqual(expect.stringContaining('orphan.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('keep.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('mmproj-model.gguf'));
  });

  it.each(['paused', 'failed', 'downloading'] as const)(
    'preserves %s projector partial localPath and resumeData during validation and quarantine scans',
    async (lifecycleStatus) => {
      const projector = createProjector({
        lifecycleStatus,
        localPath: 'mmproj-partial.gguf',
        resumeData: 'projector-resume-data',
      });
      const model = createMockModel({
        localPath: 'keep.gguf',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        projectorCandidates: [projector],
      });
      (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([model]);
      (registry.saveModels as jest.Mock) = jest.fn();
      (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
        'keep.gguf',
        'mmproj-partial.gguf',
        'orphan.gguf',
      ]);
      (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
        if (uri.endsWith('/keep.gguf') || uri.endsWith('/mmproj-partial.gguf') || uri.endsWith('/orphan.gguf')) {
          return { exists: true, size: 1000 };
        }

        return { exists: true, size: 1000 };
      });

      await registry.validateRegistry([]);

      const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0]?.[0] ?? [model];
      expect(updatedModels[0].projectorCandidates[0]).toEqual(expect.objectContaining({
        lifecycleStatus,
        localPath: 'mmproj-partial.gguf',
        resumeData: 'projector-resume-data',
      }));

      const quarantinePayload = mockStorage.set.mock.calls.find(
        ([key]) => key === 'quarantined-model-files-v1',
      )?.[1];
      expect(quarantinePayload).toEqual(expect.stringContaining('orphan.gguf'));
      expect(quarantinePayload).not.toEqual(expect.stringContaining('mmproj-partial.gguf'));
    },
  );

  it.each([
    ['missing', { exists: false }],
    ['directory', { exists: true, isDirectory: true }],
  ] as const)(
    'resets resumable projector partial state when the stored partial file is %s',
    async (_caseName, partialInfo) => {
      const projector = createProjector({
        lifecycleStatus: 'paused',
        localPath: 'mmproj-missing-partial.gguf',
        resumeData: 'projector-resume-data',
        downloadProgress: 0.42,
      });
      const model = createMockModel({
        localPath: 'keep.gguf',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        projectorCandidates: [projector],
      });
      (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([model]);
      (registry.saveModels as jest.Mock) = jest.fn();
      (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
        'keep.gguf',
        'orphan.gguf',
      ]);
      (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
        if (uri.endsWith('/mmproj-missing-partial.gguf')) {
          return partialInfo;
        }
        if (uri.endsWith('/keep.gguf') || uri.endsWith('/orphan.gguf')) {
          return { exists: true, size: 1000 };
        }

        return { exists: true, size: 1000 };
      });

      await registry.validateRegistry([]);

      const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0]?.[0];
      expect(updatedModels?.[0].projectorCandidates[0]).toEqual(expect.objectContaining({
        lifecycleStatus: 'available',
        localPath: undefined,
        resumeData: undefined,
        downloadProgress: undefined,
      }));

      const quarantinePayload = mockStorage.set.mock.calls.find(
        ([key]) => key === 'quarantined-model-files-v1',
      )?.[1];
      expect(quarantinePayload).toEqual(expect.stringContaining('orphan.gguf'));
      expect(quarantinePayload ?? '').not.toEqual(expect.stringContaining('mmproj-missing-partial.gguf'));
    },
  );

  it('does not quarantine model directory subdirectories', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([]);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'orphan.gguf',
      'nested-cache',
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: true,
      isDirectory: uri.endsWith('/nested-cache'),
    }));

    await registry.validateRegistry();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const quarantinePayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(quarantinePayload).toEqual(expect.stringContaining('orphan.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('nested-cache'));
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
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'orphan.gguf',
      'keep.gguf',
    ]);

    await expect(registry.deleteQuarantinedModelFiles(['orphan.gguf'])).resolves.toBe(1);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/orphan.gguf', { idempotent: true });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/keep.gguf', expect.anything());
    const nextPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(nextPayload).toEqual(expect.stringContaining('keep.gguf'));
    expect(nextPayload).not.toEqual(expect.stringContaining('orphan.gguf'));
  });

  it('rechecks queued filenames before each quarantined file deletion', async () => {
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'quarantined-model-files-v1'
        ? JSON.stringify({
          files: [
            { fileName: 'first.gguf', detectedAt: 1, reason: 'orphaned' },
            { fileName: 'second.gguf', detectedAt: 2, reason: 'orphaned' },
          ],
        })
        : null
    ));
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'first.gguf',
      'second.gguf',
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 1024 });
    const getQueuedFileNames = jest.fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce(['second.gguf']);

    await expect(
      registry.deleteQuarantinedModelFiles(['first.gguf', 'second.gguf'], getQueuedFileNames),
    ).resolves.toBe(1);

    expect(getQueuedFileNames).toHaveBeenCalledTimes(2);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/first.gguf', { idempotent: true });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/second.gguf', expect.anything());
    const nextPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(nextPayload).not.toEqual(expect.stringContaining('first.gguf'));
    expect(nextPayload).not.toEqual(expect.stringContaining('second.gguf'));
  });

  it('removes quarantined directory markers without deleting directories', async () => {
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'quarantined-model-files-v1'
        ? JSON.stringify({
          files: [
            { fileName: 'nested-cache', detectedAt: 1, reason: 'orphaned' },
            { fileName: 'orphan.gguf', detectedAt: 2, reason: 'orphaned' },
          ],
        })
        : null
    ));
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'nested-cache',
      'orphan.gguf',
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: true,
      isDirectory: uri.endsWith('/nested-cache'),
    }));

    await expect(registry.deleteQuarantinedModelFiles(['nested-cache'])).resolves.toBe(0);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/nested-cache', expect.anything());
    const nextPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(nextPayload).toEqual(expect.stringContaining('orphan.gguf'));
    expect(nextPayload).not.toEqual(expect.stringContaining('nested-cache'));
  });

  it('keeps quarantined markers when file inspection fails during cleanup', async () => {
    const inspectError = new Error('stat failed');
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'quarantined-model-files-v1'
        ? JSON.stringify({
          files: [
            { fileName: 'orphan.gguf', detectedAt: 1, reason: 'orphaned' },
          ],
        })
        : null
    ));
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce(['orphan.gguf']);
    (FileSystem.getInfoAsync as jest.Mock).mockRejectedValueOnce(inspectError);

    await expect(registry.deleteQuarantinedModelFiles(['orphan.gguf'])).resolves.toBe(0);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(mockStorage.set).not.toHaveBeenCalledWith('quarantined-model-files-v1', expect.anything());
    expect(mockStorage.remove).not.toHaveBeenCalledWith('quarantined-model-files-v1');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[LocalStorageRegistry] Failed to inspect model directory entry',
      expect.objectContaining({
        pathCategory: 'model_storage',
        scope: 'quarantined model cleanup',
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain('orphan.gguf');
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain(inspectError.message);
  });

  it('does not delete quarantined model files when the directory cannot be scanned', async () => {
    const scanError = new Error('scan failed');
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'quarantined-model-files-v1'
        ? JSON.stringify({
          files: [
            { fileName: 'queued.gguf', detectedAt: 1, reason: 'orphaned' },
            { fileName: 'orphan.gguf', detectedAt: 2, reason: 'orphaned' },
          ],
        })
        : null
    ));
    (FileSystem.readDirectoryAsync as jest.Mock).mockRejectedValueOnce(scanError);

    await expect(registry.deleteQuarantinedModelFiles(undefined, ['queued.gguf'])).rejects.toBe(scanError);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(mockStorage.set).not.toHaveBeenCalledWith('quarantined-model-files-v1', expect.anything());
    expect(mockStorage.remove).not.toHaveBeenCalledWith('quarantined-model-files-v1');
  });

  it('keeps queued and completed files safe during final quarantine deletion', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({ localPath: 'keep.gguf', lifecycleStatus: LifecycleStatus.DOWNLOADED }),
    ]);
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'quarantined-model-files-v1'
        ? JSON.stringify({
          files: [
            { fileName: 'queued.gguf', detectedAt: 1, reason: 'orphaned' },
            { fileName: 'keep.gguf', detectedAt: 2, reason: 'orphaned' },
            { fileName: 'orphan.gguf', detectedAt: 3, reason: 'orphaned' },
          ],
        })
        : null
    ));
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'queued.gguf',
      'keep.gguf',
      'orphan.gguf',
    ]);

    await expect(registry.deleteQuarantinedModelFiles(undefined, ['queued.gguf'])).resolves.toBe(1);

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/orphan.gguf', { idempotent: true });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/queued.gguf', expect.anything());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/keep.gguf', expect.anything());
    expect(mockStorage.remove).toHaveBeenCalledWith('quarantined-model-files-v1');
  });

  it('keeps legacy private-reset-preserved files safe during final quarantine deletion', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([]);
    mockStorage.getString.mockImplementation((key: string) => {
      if (key === 'private-reset-preserved-model-files-v1') {
        return JSON.stringify({
          fileNames: ['preserved.gguf'],
          scanComplete: true,
        });
      }

      if (key === 'quarantined-model-files-v1') {
        return JSON.stringify({
          files: [
            { fileName: 'preserved.gguf', detectedAt: 1, reason: 'orphaned' },
            { fileName: 'orphan.gguf', detectedAt: 2, reason: 'orphaned' },
          ],
        });
      }

      return null;
    });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'preserved.gguf',
      'orphan.gguf',
    ]);

    await expect(registry.deleteQuarantinedModelFiles()).resolves.toBe(1);

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/preserved.gguf', expect.anything());
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/orphan.gguf', { idempotent: true });
  });

  it('preserves completed model and projector files before a private storage reset', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([
      createMockModel({
        localPath: 'verified-model.gguf',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadIntegrity: {
          kind: 'size',
          sizeBytes: 1000,
          checkedAt: 123,
        },
        projectorCandidates: [
          createProjector({
            localPath: 'verified-mmproj.gguf',
            lifecycleStatus: 'downloaded',
            size: 1000,
          }),
          createProjector({
            id: 'projector-test-model-main-mmproj-partial.gguf',
            localPath: 'partial-mmproj.gguf',
            lifecycleStatus: 'paused',
            resumeData: 'projector-resume-data',
          }),
        ],
        variants: [{
          variantId: 'q4',
          fileName: 'model-q4.gguf',
          quantizationLabel: 'Q4',
          size: 1000,
          projectorCandidates: [createProjector({
            id: 'projector-test-model-q4-private-reset',
            ownerVariantId: 'q4',
            fileName: 'variant-private-reset-mmproj.gguf',
            localPath: 'variant-private-reset-mmproj.gguf',
            lifecycleStatus: 'downloaded',
          })],
        }],
        artifacts: [createProjectorArtifact({
          id: 'projector-test-model-artifact-private-reset',
          remoteFileName: 'artifact-private-reset-mmproj.gguf',
          localPath: 'artifact-private-reset-mmproj.gguf',
          installState: 'installed',
        })],
      }),
      createMockModel({
        id: 'test/partial',
        localPath: 'partial-model.gguf',
        lifecycleStatus: LifecycleStatus.PAUSED,
        resumeData: 'model-resume-data',
      }),
      createMockModel({
        id: 'test/completed-limited-verification',
        localPath: 'limited-verification-model.gguf',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadIntegrity: undefined,
        metadataTrust: undefined,
      }),
    ]);
    (FileSystem.readDirectoryAsync as jest.Mock)
      .mockResolvedValueOnce([
        'verified-model.gguf',
        'verified-mmproj.gguf',
        'variant-private-reset-mmproj.gguf',
        'artifact-private-reset-mmproj.gguf',
        'partial-model.gguf',
        'partial-mmproj.gguf',
        'limited-verification-model.gguf',
        'new-orphan.gguf',
      ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (
        uri.endsWith('/verified-model.gguf')
        || uri.endsWith('/verified-mmproj.gguf')
        || uri.endsWith('/variant-private-reset-mmproj.gguf')
        || uri.endsWith('/artifact-private-reset-mmproj.gguf')
        || uri.endsWith('/partial-model.gguf')
        || uri.endsWith('/partial-mmproj.gguf')
        || uri.endsWith('/limited-verification-model.gguf')
        || uri.endsWith('/new-orphan.gguf')
      ) {
        return { exists: true, size: 1000 };
      }

      return { exists: false, size: 0 };
    });

    await registry.preserveExistingModelFilesForPrivateStorageReset();
    const preservationPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'private-reset-preserved-model-files-v1',
    )?.[1];
    expect(preservationPayload).toEqual(expect.stringContaining('verified-model.gguf'));
    expect(preservationPayload).toEqual(expect.stringContaining('verified-mmproj.gguf'));
    expect(preservationPayload).toEqual(expect.stringContaining('variant-private-reset-mmproj.gguf'));
    expect(preservationPayload).toEqual(expect.stringContaining('artifact-private-reset-mmproj.gguf'));
    expect(preservationPayload).toEqual(expect.stringContaining('limited-verification-model.gguf'));
    expect(preservationPayload).not.toEqual(expect.stringContaining('partial-model.gguf'));
    expect(preservationPayload).not.toEqual(expect.stringContaining('partial-mmproj.gguf'));
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'private-reset-preserved-model-files-v1' ? preservationPayload : null
    ));
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([]);

    await registry.validateRegistry([]);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const quarantinePayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(quarantinePayload).toEqual(expect.stringContaining('new-orphan.gguf'));
    expect(quarantinePayload).toEqual(expect.stringContaining('partial-model.gguf'));
    expect(quarantinePayload).toEqual(expect.stringContaining('partial-mmproj.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('verified-model.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('verified-mmproj.gguf'));
    expect(quarantinePayload).not.toEqual(expect.stringContaining('limited-verification-model.gguf'));
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('fails closed when reset-time completed file snapshot cannot read the private registry', async () => {
    (registry.getModels as jest.Mock) = jest.fn(() => {
      throw new Error('private registry unavailable');
    });
    (FileSystem.readDirectoryAsync as jest.Mock)
      .mockResolvedValueOnce(['preserved-after-rescan.gguf', 'also-preserved.gguf']);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1000 });

    await registry.preserveExistingModelFilesForPrivateStorageReset();
    const preservationPayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'private-reset-preserved-model-files-v1',
    )?.[1];
    expect(preservationPayload).toEqual(expect.stringContaining('"scanComplete":false'));
    expect(preservationPayload).toEqual(expect.stringContaining('"completedOnly":false'));
    mockStorage.getString.mockImplementation((key: string) => (
      key === 'private-reset-preserved-model-files-v1' ? preservationPayload : null
    ));
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([]);

    await registry.validateRegistry([]);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    const quarantinePayload = mockStorage.set.mock.calls.find(
      ([key]) => key === 'quarantined-model-files-v1',
    )?.[1];
    expect(quarantinePayload ?? '').not.toEqual(expect.stringContaining('preserved-after-rescan.gguf'));
    expect(quarantinePayload ?? '').not.toEqual(expect.stringContaining('also-preserved.gguf'));
  });
});
