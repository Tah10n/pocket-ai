import {
  getModelDownloadManager,
  resetModelDownloadManagerForPrivateStorageReset,
  stopModelDownloadManagerForPrivateStorageBlocked,
} from '../../src/services/ModelDownloadManager';
import { useDownloadStore } from '../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import DeviceInfo from 'react-native-device-info';
import { AppState } from 'react-native';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { backgroundTaskService } from '../../src/services/BackgroundTaskService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { updateSettings } from '../../src/services/SettingsStore';
import { notificationService } from '../../src/services/NotificationService';
import { AppError } from '../../src/services/AppError';
import {
  PrivateStorageUnavailableError,
  getPrivateStorageHealthSnapshot,
  isPrivateStorageWritable,
} from '../../src/services/storage';
import { UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES } from '../../src/utils/modelSize';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../../src/utils/modelProjectors';
import { llmEngineService } from '../../src/services/LLMEngineService';

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let modelDownloadManager: ReturnType<typeof getModelDownloadManager>;

const mockValidGgufHeaderBase64 = Buffer.from([
  0x47, 0x47, 0x55, 0x46, // GGUF
  0x03, 0x00, 0x00, 0x00, // version 3
  0x01, 0x00, 0x00, 0x00, // tensor count low bits
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, // metadata kv count
  0x00, 0x00, 0x00, 0x00,
]).toString('base64');
const VALID_SHA256 = 'a'.repeat(64);
const OTHER_VALID_SHA256 = 'b'.repeat(64);

function runDownloadModel(overrides: Partial<ModelMetadata>) {
  const jobToken = 1;
  const model: ModelMetadata = {
    ...mockModel,
    ...overrides,
  };

  (modelDownloadManager as any).activeJob = { modelId: model.id, jobToken, resumable: null };
  return (modelDownloadManager as any).downloadModel(model, jobToken);
}

function stringifyMockCalls(spy: jest.SpyInstance): string {
  return JSON.stringify(spy.mock.calls);
}

function expectNoSensitiveDownloadPathLeak(serialized: string) {
  expect(serialized).not.toContain('test-dir/models');
  expect(serialized).not.toContain('file://');
  expect(serialized).not.toContain('localUri');
  expect(serialized).not.toContain('uri');
}

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

jest.mock('expo-file-system', () => ({
  Paths: {
    availableDiskSpace: 10 * 1024 * 1024 * 1024,
  }
}));

jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  createDownloadResumable: jest.fn().mockReturnValue({ downloadAsync: jest.fn().mockResolvedValue({ status: 200 }) }),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(10 * 1024 * 1024 * 1024),
  documentDirectory: 'test-dir/',
  cacheDirectory: 'test-cache/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 1000 }),
  readAsStringAsync: jest.fn().mockResolvedValue(mockValidGgufHeaderBase64),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  makeDirectoryAsync: jest.fn(),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModels: jest.fn().mockReturnValue([]),
    updateModel: jest.fn(),
  },
}));

jest.mock('../../src/services/HuggingFaceTokenService', () => ({
  huggingFaceTokenService: {
    getToken: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn(),
}));

jest.mock('../../src/services/SystemMetricsService', () => ({
  getSystemMemorySnapshot: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/services/storage', () => {
  const actual = jest.requireActual('../../src/services/storage');
  return {
    ...actual,
    getPrivateStorageHealthSnapshot: jest.fn(() => ({
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.encryptedOpenFailed',
      lastUpdatedAt: 1,
    })),
    isPrivateStorageWritable: jest.fn(() => true),
  };
});

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    requestActiveMultimodalReadinessRefresh: jest.fn(),
  },
}));

const mockModel: ModelMetadata = {
  id: 'test/model',
  name: 'model',
  author: 'test',
  size: 1000,
  downloadUrl: 'http://example.com/model.gguf',
  fitsInRam: true,
  accessState: ModelAccessState.PUBLIC,
  isGated: false,
  isPrivate: false,
  lifecycleStatus: LifecycleStatus.AVAILABLE,
  downloadProgress: 0,
};

const mockProjector: ProjectorArtifact = {
  id: buildProjectorArtifactId({
    repoId: 'test/model',
    hfRevision: 'main',
    fileName: 'mmproj-model.gguf',
  }),
  ownerModelId: 'test/model',
  repoId: 'test/model',
  fileName: 'mmproj-model.gguf',
  downloadUrl: 'http://example.com/mmproj-model.gguf',
  hfRevision: 'main',
  size: 1000,
  lifecycleStatus: 'available',
  matchStatus: 'matched',
  matchReason: 'single_projector_candidate',
};

function buildVariantOnlyAudioModel(
  projector: ProjectorArtifact = {
    ...mockProjector,
    id: buildProjectorArtifactId({
      repoId: mockProjector.repoId,
      hfRevision: mockProjector.hfRevision,
      ownerVariantId: 'audio-q4',
      fileName: mockProjector.fileName,
    }),
    ownerVariantId: 'audio-q4',
  },
): ModelMetadata {
  return {
    ...mockModel,
    resolvedFileName: 'model-audio.gguf',
    activeVariantId: 'audio-q4',
    // Parent metadata deliberately remains vision-capable. Artifact requirements
    // must still come from the effective active variant.
    chatModalities: ['text', 'vision'],
    variants: [{
      variantId: 'audio-q4',
      fileName: 'model-audio.gguf',
      quantizationLabel: 'Q4_K_M',
      size: 1000,
      chatModalities: ['text', 'audio'],
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
    }],
  };
}

const mockedRegistry = registry as jest.Mocked<typeof registry>;

describe('ModelDownloadManager Basic', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    modelDownloadManager = getModelDownloadManager();
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
    });
    (huggingFaceTokenService.getToken as jest.Mock).mockResolvedValue(null);
    (mockedRegistry.getModels as jest.Mock).mockReturnValue([]);
    (RNFS.hash as jest.Mock).mockResolvedValue(VALID_SHA256);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1000 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(mockValidGgufHeaderBase64);
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue(null);
    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue({
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.encryptedOpenFailed',
      lastUpdatedAt: 1,
    });
    (isPrivateStorageWritable as jest.Mock).mockReturnValue(true);
    updateSettings({ allowCellularDownloads: false });
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
    (modelDownloadManager as any).isProcessing = false;
    (modelDownloadManager as any).activeJob = null;
    await backgroundTaskService.stopBackgroundTask();
    await new Promise((r) => setTimeout(r, 10)); // Yield tick
  });

  it('should add model to queue and start download', async () => {
    const startBackgroundDownloadSpy = jest.spyOn(backgroundTaskService, 'startBackgroundDownload');

    useDownloadStore.getState().addToQueue(mockModel);
    await new Promise(r => setTimeout(r, 0));

    expect(startBackgroundDownloadSpy).toHaveBeenCalledWith({
      type: 'downloadProgress',
      modelName: 'model',
      progressPercent: 0,
    });
    expect(FileSystem.createDownloadResumable).toHaveBeenCalled();
  });

  it('does not start queued downloads while private storage is blocked', async () => {
    (isPrivateStorageWritable as jest.Mock).mockReturnValue(false);

    useDownloadStore.getState().addToQueue(mockModel);
    await new Promise(r => setTimeout(r, 0));

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(backgroundTaskService.isTaskActive('download')).toBe(false);
  });

  it('clears the in-memory active job if persisting active download fails before start', async () => {
    const originalSetActiveDownload = useDownloadStore.getState().setActiveDownload;

    try {
      (modelDownloadManager as any).queueProcessingHoldCount = 1;
      useDownloadStore.setState({
        queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
        activeDownloadId: null,
      });
      useDownloadStore.setState({
        setActiveDownload: jest.fn(() => {
          originalSetActiveDownload(mockModel.id);
          throw new Error('persist failed');
        }),
      });
      (modelDownloadManager as any).queueProcessingHoldCount = 0;

      await expect((modelDownloadManager as any).processQueue()).rejects.toThrow('persist failed');

      expect((modelDownloadManager as any).activeJob).toBeNull();
      expect((modelDownloadManager as any).isProcessing).toBe(false);
      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    } finally {
      (modelDownloadManager as any).queueProcessingHoldCount = 0;
      useDownloadStore.setState({
        setActiveDownload: originalSetActiveDownload,
        queue: [],
        activeDownloadId: null,
      });
    }
  });

  it('invalidates an active job during private storage reset', async () => {
    const pauseAsync = jest.fn().mockResolvedValue(undefined);
    const jobToken = 42;
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken,
      resumable: { pauseAsync },
      stopReason: null,
    };
    (modelDownloadManager as any).isProcessing = true;
    useDownloadStore.setState({
      queue: [
        { ...mockModel, lifecycleStatus: LifecycleStatus.DOWNLOADING },
        { ...mockModel, id: 'test/queued-model', lifecycleStatus: LifecycleStatus.QUEUED },
      ],
      activeDownloadId: mockModel.id,
    });
    await backgroundTaskService.startBackgroundDownload({ type: 'downloadProgress', modelName: mockModel.name, progressPercent: 10 });

    await resetModelDownloadManagerForPrivateStorageReset();

    expect(pauseAsync).toHaveBeenCalledTimes(1);
    expect((modelDownloadManager as any).activeJob).toBeNull();
    expect((modelDownloadManager as any).isProcessing).toBe(false);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([]);
    expect(backgroundTaskService.isTaskActive('download')).toBe(false);

    await Promise.resolve();
    expect((modelDownloadManager as any).activeJob).toBeNull();

    await expect((modelDownloadManager as any).downloadModel(mockModel, jobToken)).resolves.toBeUndefined();
    expect(mockedRegistry.updateModel).not.toHaveBeenCalled();
  });

  it('continues private storage reset and invalidates active ownership when pauseAsync rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const pauseAsync = jest.fn().mockRejectedValue(new Error('pause failed'));
    const activeJob = {
      modelId: mockModel.id,
      jobToken: 142,
      resumable: { pauseAsync },
      stopReason: null,
    };
    (modelDownloadManager as any).activeJob = activeJob;
    (modelDownloadManager as any).isProcessing = true;
    useDownloadStore.setState({
      queue: [
        { ...mockModel, lifecycleStatus: LifecycleStatus.DOWNLOADING },
        { ...mockModel, id: 'test/queued-model', lifecycleStatus: LifecycleStatus.QUEUED },
      ],
      activeDownloadId: mockModel.id,
    });
    await backgroundTaskService.startBackgroundDownload({ type: 'downloadProgress', modelName: mockModel.name, progressPercent: 10 });

    try {
      await expect(resetModelDownloadManagerForPrivateStorageReset()).resolves.toBeUndefined();

      expect(pauseAsync).toHaveBeenCalledTimes(1);
      expect(activeJob.stopReason).toBe('cancel');
      expect((modelDownloadManager as any).activeJob).toBeNull();
      expect((modelDownloadManager as any).isProcessing).toBe(false);
      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      expect(useDownloadStore.getState().queue).toEqual([]);
      expect(backgroundTaskService.isTaskActive('download')).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        `[ModelDownloadManager] Failed to pause active download during private storage reset for ${mockModel.id}`,
        expect.any(Object),
      );
    } finally {
      warnSpy.mockRestore();
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
      useDownloadStore.setState({ queue: [], activeDownloadId: null });
      await backgroundTaskService.stopBackgroundTask('download');
    }
  });

  it('ignores native completion after private reset invalidates a job when pauseAsync rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveDownload: (value: { status: number }) => void = () => undefined;
    const activeModel = {
      ...mockModel,
      localPath: 'active-reset.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    const pauseAsync = jest.fn().mockRejectedValue(new Error('pause failed'));
    const downloadAsync = jest.fn().mockImplementation(() => new Promise<{ status: number }>((resolve) => {
      resolveDownload = resolve;
    }));
    const jobToken = 143;

    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValueOnce({
      downloadAsync,
      pauseAsync,
      savable: jest.fn(),
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active-reset.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });

    try {
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken,
        resumable: null,
        stopReason: null,
      };
      (modelDownloadManager as any).isProcessing = true;
      useDownloadStore.setState({
        queue: [activeModel],
        activeDownloadId: mockModel.id,
      });

      const downloadPromise = (modelDownloadManager as any).runDownloadJob(activeModel, jobToken);

      for (let i = 0; i < 10 && downloadAsync.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(downloadAsync).toHaveBeenCalledTimes(1);

      await expect(resetModelDownloadManagerForPrivateStorageReset()).resolves.toBeUndefined();

      expect(pauseAsync).toHaveBeenCalledTimes(1);
      expect((modelDownloadManager as any).activeJob).toBeNull();
      expect((modelDownloadManager as any).isProcessing).toBe(false);
      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      expect(useDownloadStore.getState().queue).toEqual([]);

      resolveDownload({ status: 200 });
      await downloadPromise;

      expect((modelDownloadManager as any).activeJob).toBeNull();
      expect((modelDownloadManager as any).isProcessing).toBe(false);
      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      expect(useDownloadStore.getState().queue).toEqual([]);
      expect(mockedRegistry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({
        id: mockModel.id,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
      }));
    } finally {
      warnSpy.mockRestore();
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
      useDownloadStore.setState({ queue: [], activeDownloadId: null });
    }
  });

  it('stops an active job without clearing queued downloads when private storage blocks', async () => {
    const pauseAsync = jest.fn().mockResolvedValue(undefined);
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 43,
      resumable: { pauseAsync },
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [
        { ...mockModel, lifecycleStatus: LifecycleStatus.DOWNLOADING, downloadProgress: 0.5 },
        { ...mockModel, id: 'test/queued-model', lifecycleStatus: LifecycleStatus.QUEUED },
      ],
      activeDownloadId: mockModel.id,
    });
    await backgroundTaskService.startBackgroundDownload({ type: 'downloadProgress', modelName: mockModel.name, progressPercent: 50 });

    await stopModelDownloadManagerForPrivateStorageBlocked();

    expect(pauseAsync).toHaveBeenCalledTimes(1);
    expect((modelDownloadManager as any).activeJob).toBeNull();
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([
      expect.objectContaining({ id: mockModel.id, lifecycleStatus: LifecycleStatus.QUEUED, downloadProgress: 0 }),
      expect.objectContaining({ id: 'test/queued-model', lifecycleStatus: LifecycleStatus.QUEUED }),
    ]);
    expect(backgroundTaskService.isTaskActive('download')).toBe(false);
  });

  it('resumes queued downloads after private storage becomes writable again', async () => {
    const pauseAsync = jest.fn().mockResolvedValue(undefined);
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 44,
      resumable: { pauseAsync },
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.DOWNLOADING, downloadProgress: 0.5 }],
      activeDownloadId: mockModel.id,
    });

    (isPrivateStorageWritable as jest.Mock).mockReturnValue(false);
    await stopModelDownloadManagerForPrivateStorageBlocked();
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();

    (isPrivateStorageWritable as jest.Mock).mockReturnValue(true);
    modelDownloadManager.resumeQueueIfStorageReady();
    await new Promise(r => setTimeout(r, 0));

    expect(FileSystem.createDownloadResumable).toHaveBeenCalled();
  });

  it('stops without completing registry writes when private storage blocks mid-download', async () => {
    const pauseAsync = jest.fn().mockResolvedValue(undefined);
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValueOnce({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      pauseAsync,
      savable: jest.fn(() => 'resume-data'),
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });
    (isPrivateStorageWritable as jest.Mock)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(runDownloadModel({})).resolves.toBeUndefined();

    expect(mockedRegistry.updateModel).not.toHaveBeenCalled();
    expect(pauseAsync).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([
      expect.objectContaining({
        id: mockModel.id,
        lifecycleStatus: LifecycleStatus.QUEUED,
        downloadProgress: 0,
      }),
    ]);
  });

  it('does not write AVAILABLE resume state when registry persistence reports private storage unavailable', async () => {
    const pauseAsync = jest.fn().mockResolvedValue(undefined);
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValueOnce({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      pauseAsync,
      savable: jest.fn(() => 'resume-data'),
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });
    mockedRegistry.updateModel.mockImplementationOnce(() => {
      throw new PrivateStorageUnavailableError('encrypted_open_failed', getPrivateStorageHealthSnapshot());
    });

    await expect(runDownloadModel({})).resolves.toBeUndefined();

    expect(mockedRegistry.updateModel).toHaveBeenCalledTimes(1);
    expect(pauseAsync).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([
      expect.objectContaining({
        id: mockModel.id,
        lifecycleStatus: LifecycleStatus.QUEUED,
        downloadProgress: 0,
      }),
    ]);
  });

  it('does not persist PAUSED for queued downloads when private storage blocks before pause', async () => {
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: null,
    });
    (isPrivateStorageWritable as jest.Mock).mockReturnValue(false);

    await modelDownloadManager.pauseDownload(mockModel.id);

    expect(useDownloadStore.getState().queue).toEqual([
      expect.objectContaining({
        id: mockModel.id,
        lifecycleStatus: LifecycleStatus.QUEUED,
      }),
    ]);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('does not remove queued downloads or delete partial files when private storage blocks before cancel', async () => {
    const pauseAsync = jest.fn().mockResolvedValue(undefined);
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 45,
      resumable: { pauseAsync },
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.DOWNLOADING, downloadProgress: 0.4 }],
      activeDownloadId: mockModel.id,
    });
    (isPrivateStorageWritable as jest.Mock).mockReturnValue(false);

    await modelDownloadManager.cancelDownload(mockModel.id);

    expect(pauseAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([
      expect.objectContaining({
        id: mockModel.id,
        lifecycleStatus: LifecycleStatus.QUEUED,
        downloadProgress: 0,
      }),
    ]);
  });

  it('deletes selected projector partial files when cancelling its queued model', async () => {
    const queuedModel = {
      ...mockModel,
      localPath: 'model-partial.gguf',
      projectorCandidates: [{ ...mockProjector, localPath: 'mmproj-partial.gguf', lifecycleStatus: 'downloading' as const }],
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    useDownloadStore.setState({
      queue: [queuedModel],
      activeDownloadId: null,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model-partial.gguf' || uri === 'test-dir/models/mmproj-partial.gguf') {
        return { exists: true, size: 1000 };
      }

      return { exists: false, size: 0 };
    });

    await modelDownloadManager.cancelDownload(mockModel.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/model-partial.gguf', { idempotent: true });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/mmproj-partial.gguf', { idempotent: true });
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('deletes a variant-only selected projector partial when cancelling its queued model', async () => {
    const variantProjector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        ownerVariantId: 'audio-q4',
        fileName: mockProjector.fileName,
      }),
      ownerVariantId: 'audio-q4',
      localPath: 'variant-mmproj-partial.gguf',
      lifecycleStatus: 'downloading' as const,
    };
    const queuedModel = {
      ...buildVariantOnlyAudioModel(variantProjector),
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    useDownloadStore.setState({ queue: [queuedModel], activeDownloadId: null });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-dir/models/variant-mmproj-partial.gguf'
        ? { exists: true, size: 1000 }
        : { exists: false, size: 0 }
    ));

    await modelDownloadManager.cancelDownload(mockModel.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'test-dir/models/variant-mmproj-partial.gguf',
      { idempotent: true },
    );
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('protects completed projector files from cancel cleanup', async () => {
    const queuedModel = {
      ...mockModel,
      projectorCandidates: [{ ...mockProjector, localPath: 'shared-mmproj.gguf', lifecycleStatus: 'downloading' as const }],
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    (mockedRegistry.getModels as jest.Mock).mockReturnValue([
      {
        ...mockModel,
        id: 'test/downloaded-model',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        localPath: 'downloaded-model.gguf',
        projectorCandidates: [{ ...mockProjector, localPath: 'shared-mmproj.gguf', lifecycleStatus: 'downloaded' }],
      },
    ]);
    useDownloadStore.setState({
      queue: [queuedModel],
      activeDownloadId: null,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-dir/models/shared-mmproj.gguf'
        ? { exists: true, size: 200 }
        : { exists: false, size: 0 }
    ));

    await modelDownloadManager.cancelDownload(mockModel.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/shared-mmproj.gguf', expect.anything());
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('protects projector files still owned by another queued download from cancel cleanup', async () => {
    const sharedProjectorPath = 'shared-mmproj.gguf';
    const targetModel = {
      ...mockModel,
      projectorCandidates: [{ ...mockProjector, localPath: sharedProjectorPath, lifecycleStatus: 'downloading' as const }],
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    const otherModel = {
      ...mockModel,
      id: 'test/other-model',
      name: 'other model',
      projectorCandidates: [{
        ...mockProjector,
        id: 'test/other-model::main::mmproj-model.gguf',
        ownerModelId: 'test/other-model',
        localPath: sharedProjectorPath,
        lifecycleStatus: 'paused' as const,
      }],
      lifecycleStatus: LifecycleStatus.PAUSED,
    };
    useDownloadStore.setState({
      queue: [targetModel, otherModel],
      activeDownloadId: null,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === `test-dir/models/${sharedProjectorPath}`
        ? { exists: true, size: 1000 }
        : { exists: false, size: 0 }
    ));

    await modelDownloadManager.cancelDownload(mockModel.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(`test-dir/models/${sharedProjectorPath}`, expect.anything());
    expect(useDownloadStore.getState().queue).toEqual([expect.objectContaining({ id: 'test/other-model' })]);
  });

  it.each([
    ['resumable', { pauseAsync: jest.fn().mockResolvedValue(undefined) }],
    ['non-resumable', null],
  ])('does not delete a verified base checkpoint while canceling an active %s projector', async (_mode, resumable) => {
    const pauseAsync = resumable?.pauseAsync;
    const activeModel = {
      ...mockModel,
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      localPath: 'verified-base.gguf',
      downloadProgress: 1,
      downloadIntegrity: {
        kind: 'sha256' as const,
        sha256: VALID_SHA256,
        sizeBytes: 1000,
        checkedAt: 1,
      },
      metadataTrust: 'verified_local' as const,
      projectorCandidates: [{
        ...mockProjector,
        localPath: 'mmproj-partial.gguf',
        lifecycleStatus: 'downloading' as const,
      }],
    };

    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 46,
      resumable,
      activeArtifact: 'projector',
      activeProjectorId: mockProjector.id,
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [activeModel],
      activeDownloadId: mockModel.id,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/verified-base.gguf' || uri === 'test-dir/models/mmproj-partial.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });

    await modelDownloadManager.cancelDownload(mockModel.id);

    if (pauseAsync) {
      expect(pauseAsync).toHaveBeenCalledTimes(1);
    }
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/verified-base.gguf', expect.anything());
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/mmproj-partial.gguf', { idempotent: true });
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it.each([
    ['model', 'model' as const],
    ['undefined', undefined],
  ])('does not delete a verified base checkpoint while canceling during the base-to-projector transition with activeArtifact %s', async (_mode, activeArtifact) => {
    const activeModel = {
      ...mockModel,
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      localPath: 'verified-base.gguf',
      downloadProgress: 1,
      downloadIntegrity: {
        kind: 'sha256' as const,
        sha256: VALID_SHA256,
        sizeBytes: 1000,
        checkedAt: 1,
      },
      projectorCandidates: [{
        ...mockProjector,
        localPath: 'mmproj-partial.gguf',
        lifecycleStatus: 'downloading' as const,
      }],
    };

    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 47,
      resumable: null,
      activeArtifact,
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [activeModel],
      activeDownloadId: mockModel.id,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/verified-base.gguf' || uri === 'test-dir/models/mmproj-partial.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });

    await modelDownloadManager.cancelDownload(mockModel.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/verified-base.gguf', expect.anything());
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/mmproj-partial.gguf', { idempotent: true });
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('holds queue processing while active cancel deletes a same-file partial before requeue starts', async () => {
    let resolveDelete: () => void = () => {};
    let deletedPartial = false;
    let downloadStarted = false;
    const activeModel = {
      ...mockModel,
      localPath: 'active.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
    };
    const pauseAsync = jest.fn().mockResolvedValue(undefined);

    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 46,
      resumable: { pauseAsync },
      stopReason: null,
    };
    (modelDownloadManager as any).isProcessing = false;
    useDownloadStore.setState({
      queue: [activeModel],
      activeDownloadId: mockModel.id,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active.gguf') {
        return { exists: !deletedPartial || downloadStarted, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    (FileSystem.deleteAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveDelete = () => {
        deletedPartial = true;
        resolve();
      };
    }));
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((...args: any[]) => {
      downloadStarted = true;
      return {
        downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        savable: jest.fn(),
        args,
      };
    });

    const cancelPromise = modelDownloadManager.cancelDownload(mockModel.id);

    for (let i = 0; i < 10 && (FileSystem.deleteAsync as jest.Mock).mock.calls.length === 0; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(pauseAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/active.gguf', { idempotent: true });

    useDownloadStore.getState().addToQueue({ ...mockModel, localPath: 'active.gguf' });
    await new Promise((r) => setTimeout(r, 0));

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();

    resolveDelete();
    await cancelPromise;

    for (let i = 0; i < 10 && (FileSystem.createDownloadResumable as jest.Mock).mock.calls.length === 0; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      'http://example.com/model.gguf',
      'test-dir/models/active.gguf',
      {},
      expect.any(Function),
      undefined,
    );
  });

  it('defers partial cleanup and queue restart when active cancel cannot pause the native download', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveDownload: (value: { status: number }) => void = () => undefined;
    let deletedPartial = false;
    const activeModel = {
      ...mockModel,
      localPath: 'active.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    const pauseAsync = jest.fn().mockRejectedValue(new Error('pause failed'));
    const downloadAsync = jest.fn().mockImplementation(() => new Promise<{ status: number }>((resolve) => {
      resolveDownload = resolve;
    }));
    const nextDownloadAsync = jest.fn(() => new Promise(() => undefined));
    const jobToken = 48;

    (FileSystem.createDownloadResumable as jest.Mock)
      .mockReturnValueOnce({
        downloadAsync,
        pauseAsync,
        savable: jest.fn(),
      })
      .mockReturnValueOnce({
        downloadAsync: nextDownloadAsync,
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        savable: jest.fn(),
      });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active.gguf') {
        return { exists: !deletedPartial, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    (FileSystem.deleteAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active.gguf') {
        deletedPartial = true;
      }
    });

    try {
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken,
        resumable: null,
        stopReason: null,
      };
      (modelDownloadManager as any).isProcessing = true;
      useDownloadStore.setState({
        queue: [activeModel],
        activeDownloadId: mockModel.id,
      });

      const downloadPromise = (modelDownloadManager as any).runDownloadJob(activeModel, jobToken);

      for (let i = 0; i < 10 && downloadAsync.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(downloadAsync).toHaveBeenCalledTimes(1);

      await modelDownloadManager.cancelDownload(mockModel.id);

      expect(pauseAsync).toHaveBeenCalledTimes(1);
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/active.gguf', { idempotent: true });
      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);

      useDownloadStore.getState().addToQueue({ ...mockModel, localPath: 'active.gguf' });
      await new Promise((r) => setTimeout(r, 0));

      expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);

      resolveDownload({ status: 200 });
      await downloadPromise;

      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/active.gguf', { idempotent: true });

      for (let i = 0; i < 10 && (FileSystem.createDownloadResumable as jest.Mock).mock.calls.length < 2; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(FileSystem.createDownloadResumable).toHaveBeenLastCalledWith(
        'http://example.com/model.gguf',
        'test-dir/models/active.gguf',
        {},
        expect.any(Function),
        undefined,
      );
    } finally {
      warnSpy.mockRestore();
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
      useDownloadStore.setState({ queue: [], activeDownloadId: null });
    }
  });

  it('restarts the queue if a pause-failed cancel settles while queue processing is held', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const originalSetActiveDownload = useDownloadStore.getState().setActiveDownload;
    let resolveDownload: (value: { status: number }) => void = () => undefined;
    let deletedActivePartial = false;
    const activeModel = {
      ...mockModel,
      localPath: 'active.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    const queuedModel = {
      ...mockModel,
      id: 'test/queued-model',
      name: 'queued model',
      downloadUrl: 'http://example.com/queued.gguf',
      localPath: 'queued.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    const pauseAsync = jest.fn().mockRejectedValue(new Error('pause failed'));
    const downloadAsync = jest.fn().mockImplementation(() => new Promise<{ status: number }>((resolve) => {
      resolveDownload = resolve;
    }));
    const queuedDownloadAsync = jest.fn(() => new Promise(() => undefined));
    const jobToken = 49;

    (FileSystem.createDownloadResumable as jest.Mock)
      .mockReturnValueOnce({
        downloadAsync,
        pauseAsync,
        savable: jest.fn(),
      })
      .mockReturnValueOnce({
        downloadAsync: queuedDownloadAsync,
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        savable: jest.fn(),
      });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active.gguf') {
        return { exists: !deletedActivePartial, size: 1000 };
      }
      if (uri === 'test-dir/models/queued.gguf') {
        return { exists: false, size: 0 };
      }
      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    (FileSystem.deleteAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active.gguf') {
        deletedActivePartial = true;
      }
    });

    try {
      useDownloadStore.setState({
        setActiveDownload: jest.fn((modelId: string | null) => {
          originalSetActiveDownload(modelId);
          if (modelId === null) {
            resolveDownload({ status: 200 });
          }
        }),
      });
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken,
        resumable: null,
        stopReason: null,
      };
      (modelDownloadManager as any).isProcessing = true;
      useDownloadStore.setState({
        queue: [activeModel, queuedModel],
        activeDownloadId: mockModel.id,
      });

      const downloadPromise = (modelDownloadManager as any).runDownloadJob(activeModel, jobToken);

      for (let i = 0; i < 10 && downloadAsync.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(downloadAsync).toHaveBeenCalledTimes(1);

      await modelDownloadManager.cancelDownload(mockModel.id);
      await downloadPromise;

      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/active.gguf', { idempotent: true });

      for (let i = 0; i < 10 && (FileSystem.createDownloadResumable as jest.Mock).mock.calls.length < 2; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(FileSystem.createDownloadResumable).toHaveBeenLastCalledWith(
        'http://example.com/queued.gguf',
        'test-dir/models/queued.gguf',
        {},
        expect.any(Function),
        undefined,
      );
    } finally {
      warnSpy.mockRestore();
      useDownloadStore.setState({
        setActiveDownload: originalSetActiveDownload,
        queue: [],
        activeDownloadId: null,
      });
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
    }
  });

  it('defers paused-item cancel cleanup when the previous pause did not stop the native download', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveDownload: (value: { status: number }) => void = () => undefined;
    let deletedPartial = false;
    const activeModel = {
      ...mockModel,
      localPath: 'active.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    const pauseAsync = jest.fn().mockRejectedValue(new Error('pause failed'));
    const downloadAsync = jest.fn().mockImplementation(() => new Promise<{ status: number }>((resolve) => {
      resolveDownload = resolve;
    }));
    const nextDownloadAsync = jest.fn(() => new Promise(() => undefined));
    const jobToken = 50;

    (FileSystem.createDownloadResumable as jest.Mock)
      .mockReturnValueOnce({
        downloadAsync,
        pauseAsync,
        savable: jest.fn(() => ({ resumeData: 'resume-data' })),
      })
      .mockReturnValueOnce({
        downloadAsync: nextDownloadAsync,
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        savable: jest.fn(),
      });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active.gguf') {
        return { exists: !deletedPartial, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    (FileSystem.deleteAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/active.gguf') {
        deletedPartial = true;
      }
    });

    try {
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken,
        resumable: null,
        stopReason: null,
      };
      (modelDownloadManager as any).isProcessing = true;
      useDownloadStore.setState({
        queue: [activeModel],
        activeDownloadId: mockModel.id,
      });

      const downloadPromise = (modelDownloadManager as any).runDownloadJob(activeModel, jobToken);

      for (let i = 0; i < 10 && downloadAsync.mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(downloadAsync).toHaveBeenCalledTimes(1);

      await modelDownloadManager.pauseDownload(mockModel.id);

      expect(pauseAsync).toHaveBeenCalledTimes(1);
      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      expect(useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)?.lifecycleStatus).toBe(LifecycleStatus.PAUSED);

      await modelDownloadManager.cancelDownload(mockModel.id);

      expect(pauseAsync).toHaveBeenCalledTimes(2);
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/active.gguf', { idempotent: true });

      useDownloadStore.getState().addToQueue({ ...mockModel, localPath: 'active.gguf' });
      await new Promise((r) => setTimeout(r, 0));

      expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);

      resolveDownload({ status: 200 });
      await downloadPromise;

      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/active.gguf', { idempotent: true });

      for (let i = 0; i < 10 && (FileSystem.createDownloadResumable as jest.Mock).mock.calls.length < 2; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(FileSystem.createDownloadResumable).toHaveBeenLastCalledWith(
        'http://example.com/model.gguf',
        'test-dir/models/active.gguf',
        {},
        expect.any(Function),
        undefined,
      );
    } finally {
      warnSpy.mockRestore();
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
      useDownloadStore.setState({ queue: [], activeDownloadId: null });
    }
  });

  it('does not delete partials but resumes queue when cancel persistence throws after queue mutation', async () => {
    const originalRemoveFromQueue = useDownloadStore.getState().removeFromQueue;
    const activeModel = {
      ...mockModel,
      localPath: 'active.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
    };
    const queuedModel = {
      ...mockModel,
      id: 'test/queued-model',
      name: 'queued model',
      downloadUrl: 'http://example.com/queued.gguf',
      localPath: 'queued.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };

    try {
      useDownloadStore.setState({
        queue: [activeModel, queuedModel],
        activeDownloadId: mockModel.id,
        removeFromQueue: jest.fn((modelId: string) => {
          originalRemoveFromQueue(modelId);
          throw new Error('remove persist failed');
        }),
      });
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken: 47,
        resumable: { pauseAsync: jest.fn().mockResolvedValue(undefined) },
        stopReason: null,
      };
      (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
        if (uri === 'test-dir/models/active.gguf') {
          return { exists: true, size: 1000 };
        }
        if (uri.startsWith('test-dir/models/')) {
          return { exists: false, size: 0 };
        }

        return { exists: true, size: 1000 };
      });
      (FileSystem.createDownloadResumable as jest.Mock).mockClear();

      await expect(modelDownloadManager.cancelDownload(mockModel.id)).rejects.toThrow('remove persist failed');

      await new Promise((r) => setTimeout(r, 0));

      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/active.gguf', { idempotent: true });
      expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
        'http://example.com/queued.gguf',
        'test-dir/models/queued.gguf',
        {},
        expect.any(Function),
        undefined,
      );
    } finally {
      useDownloadStore.setState({
        removeFromQueue: originalRemoveFromQueue,
        queue: [],
        activeDownloadId: null,
      });
    }
  });

  it('does not delete directory paths while canceling queued partial downloads', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'nested-cache',
        lifecycleStatus: LifecycleStatus.PAUSED,
      }],
      activeDownloadId: null,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/nested-cache') {
        return { exists: true, isDirectory: true };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });

    try {
      await modelDownloadManager.cancelDownload(mockModel.id);

      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/nested-cache', expect.anything());
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[ModelDownloadManager] Partial download candidate is a directory, skipping',
        expect.objectContaining({
          artifactKind: 'model',
          pathCategory: 'model_storage',
        }),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('nested-cache');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not delete completed model files while canceling queued partial downloads', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    useDownloadStore.setState({
      queue: [
        {
          ...mockModel,
          lifecycleStatus: LifecycleStatus.QUEUED,
          localPath: 'completed.gguf',
        },
      ],
      activeDownloadId: null,
    });
    (mockedRegistry.getModels as jest.Mock).mockReturnValue([
      {
        ...mockModel,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        localPath: 'completed.gguf',
      },
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-dir/models/completed.gguf'
        ? { exists: true, size: 1000 }
        : { exists: false, size: 0 }
    ));

    try {
      await modelDownloadManager.cancelDownload(mockModel.id);

      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/completed.gguf', expect.anything());
      expect(warnSpy).toHaveBeenCalledWith(
        '[ModelDownloadManager] Partial download candidate is a completed model file, skipping',
        expect.objectContaining({
          artifactKind: 'model',
          pathCategory: 'model_storage',
        }),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('completed.gguf');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips completed model files when resolving a download target', async () => {
    (mockedRegistry.getModels as jest.Mock).mockReturnValue([
      {
        ...mockModel,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        localPath: 'completed.gguf',
      },
    ]);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-dir/models/completed.gguf'
        ? { exists: true, size: 1000 }
        : { exists: false, size: 0 }
    ));

    const resolvedFileName = await (modelDownloadManager as any).resolveDownloadFileName(
      { ...mockModel, localPath: 'completed.gguf' },
      'test-dir/models/',
    );

    expect(resolvedFileName).not.toBe('completed.gguf');
  });

  it('skips model files still owned by another queued download when resolving a download target', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        id: 'test/other-model',
        lifecycleStatus: LifecycleStatus.PAUSED,
        localPath: 'shared-partial.gguf',
      }],
      activeDownloadId: null,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri === 'test-dir/models/shared-partial.gguf'
        ? { exists: true, size: 1000 }
        : { exists: false, size: 0 }
    ));

    try {
      const resolvedFileName = await (modelDownloadManager as any).resolveDownloadFileName(
        { ...mockModel, localPath: 'shared-partial.gguf' },
        'test-dir/models/',
      );

      expect(resolvedFileName).not.toBe('shared-partial.gguf');
      expect(warnSpy).toHaveBeenCalledWith(
        '[ModelDownloadManager] Download candidate is still owned by another queued download, skipping',
        expect.objectContaining({
          artifactKind: 'model',
          pathCategory: 'model_storage',
        }),
      );
      expect(stringifyMockCalls(warnSpy)).not.toContain('shared-partial.gguf');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not delete completed model files when corrupted verification cleanup runs', async () => {
    (mockedRegistry.getModels as jest.Mock).mockReturnValue([
      {
        ...mockModel,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        localPath: 'completed.gguf',
      },
    ]);

    await (modelDownloadManager as any).deleteCorruptedDownload('test-dir/models/completed.gguf', mockModel.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/completed.gguf', expect.anything());
  });

  it('does not delete model files still owned by another queued download when corrupted verification cleanup runs', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        id: 'test/other-model',
        lifecycleStatus: LifecycleStatus.PAUSED,
        localPath: 'shared-partial.gguf',
      }],
      activeDownloadId: null,
    });

    try {
      await (modelDownloadManager as any).deleteCorruptedDownload('test-dir/models/shared-partial.gguf', mockModel.id);

      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/shared-partial.gguf', expect.anything());
      expect(warnSpy).toHaveBeenCalledWith(
        '[ModelDownloadManager] Corrupted download path for test/model is still owned by another queued download, skipping delete',
      );
      expect(stringifyMockCalls(warnSpy)).not.toContain('test-dir/models/shared-partial.gguf');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('verifies a downloaded file when the size matches', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).resolves.toEqual({
      integrity: 'size',
      sizeBytes: 1000,
    });
  });

  it('fails and deletes no-sha downloads when the GGUF header is invalid HTML', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce(
      Buffer.from('<html><body>not a GGUF file').toString('base64'),
    );

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).rejects.toMatchObject({
      name: 'AppError',
      code: 'download_verification_failed',
    });

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/model.gguf', { idempotent: true });
    expect(RNFS.hash).not.toHaveBeenCalled();
  });

  it('sanitizes GGUF verification error details without dropping useful context', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce(
      Buffer.from('<html><body>not a GGUF file').toString('base64'),
    );

    let thrownError: AppError | undefined;
    try {
      await modelDownloadManager.verifyChecksum(mockModel, 'file://test-dir/models/model.gguf');
    } catch (error) {
      thrownError = error as AppError;
    }

    expect(thrownError?.code).toBe('download_verification_failed');
    expect(thrownError?.message).toBe('GGUF header magic is invalid');
    expect(thrownError?.details).toEqual(expect.objectContaining({
      modelId: mockModel.id,
      artifactKind: 'model',
      pathCategory: 'local_file',
      reason: 'invalid_magic',
    }));
    expect(thrownError?.details).not.toEqual(expect.objectContaining({
      artifactId: expect.anything(),
    }));
    expectNoSensitiveDownloadPathLeak(JSON.stringify(thrownError?.details ?? {}));
  });

  it('fails and deletes sha-backed downloads when the GGUF header is invalid', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce(
      Buffer.from('<html><body>not a GGUF file').toString('base64'),
    );

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: VALID_SHA256 }, 'test-dir/model.gguf'),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'download_verification_failed',
    });

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/model.gguf', { idempotent: true });
    expect(RNFS.hash).not.toHaveBeenCalled();
  });

  it('fails and deletes no-sha downloads that are too small to be GGUF files', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 128 });

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, size: 128 }, 'test-dir/model.gguf'),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'download_verification_failed',
    });

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/model.gguf', { idempotent: true });
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
    expect(RNFS.hash).not.toHaveBeenCalled();
  });

  it('fails no-sha verification without deleting when the GGUF header cannot be read', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (FileSystem.readAsStringAsync as jest.Mock).mockRejectedValueOnce(new Error('read failed'));

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).rejects.toMatchObject({
      name: 'AppError',
      code: 'download_verification_failed',
    });

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(RNFS.hash).not.toHaveBeenCalled();
  });

  it('preserves a real checksum when size validation succeeds', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce(VALID_SHA256);

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: VALID_SHA256 }, 'test-dir/model.gguf'),
    ).resolves.toEqual({
      integrity: 'sha256',
      sha256: VALID_SHA256,
      sizeBytes: 1000,
    });
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('test-dir/model.gguf', {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 24,
    });
  });

  it('normalizes sha256 digests with a sha256 prefix', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce(VALID_SHA256);

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: `sha256:${VALID_SHA256.toUpperCase()}` }, 'test-dir/model.gguf'),
    ).resolves.toEqual({
      integrity: 'sha256',
      sha256: VALID_SHA256,
      sizeBytes: 1000,
    });
  });

  it('treats malformed expected sha256 digests as no-sha downloads', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: 'sha256:' }, 'test-dir/model.gguf'),
    ).resolves.toEqual({
      integrity: 'size',
      sizeBytes: 1000,
    });
    expect(FileSystem.readAsStringAsync).toHaveBeenCalled();
    expect(RNFS.hash).not.toHaveBeenCalled();
  });

  it('converts Expo file URIs into native filesystem paths before hashing', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce(VALID_SHA256);

    await expect(
      modelDownloadManager.verifyChecksum(
        { ...mockModel, sha256: VALID_SHA256 },
        'file:///test-dir/model.gguf',
      ),
    ).resolves.toEqual({
      integrity: 'sha256',
      sha256: VALID_SHA256,
      sizeBytes: 1000,
    });

    expect(RNFS.hash).toHaveBeenCalledWith('/test-dir/model.gguf', 'sha256');
  });

  it('fails verification when the downloaded file is missing', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: false, size: 0 });

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).rejects.toThrow(
      'File does not exist after download',
    );
  });

  it('fails verification without deleting when the download path is a directory', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, isDirectory: true, size: 0 });

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).rejects.toThrow(
      'Downloaded path is a directory, not a model file',
    );

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(RNFS.hash).not.toHaveBeenCalled();
  });

  it('fails verification when the downloaded file size differs from the trusted expected size', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: (mockModel.size ?? 0) + 1,
    });

    let thrownError: AppError | undefined;
    try {
      await modelDownloadManager.verifyChecksum(mockModel, 'test-dir/models/model.gguf');
    } catch (error) {
      thrownError = error as AppError;
    }

    expect(thrownError?.code).toBe('download_verification_failed');
    expect(thrownError?.message).toEqual(expect.stringContaining('Size mismatch'));
    expect(thrownError?.details).toEqual(expect.objectContaining({
      modelId: mockModel.id,
      artifactKind: 'model',
      pathCategory: 'model_storage',
      expectedSize: mockModel.size,
      downloadedSize: (mockModel.size ?? 0) + 1,
    }));
    expect(thrownError?.details).not.toEqual(expect.objectContaining({
      artifactId: expect.anything(),
    }));
    expectNoSensitiveDownloadPathLeak(JSON.stringify(thrownError?.details ?? {}));
  });

  it('fails verification when the downloaded file hash does not match the upstream digest', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce(OTHER_VALID_SHA256);

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: VALID_SHA256 }, 'test-dir/model.gguf'),
    ).rejects.toThrow('Checksum mismatch');

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/model.gguf', { idempotent: true });
  });

  it('sanitizes native verification dependency error messages', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockRejectedValueOnce(
      new Error('Hash failed for file://test-dir/models/Private Models/private model.gguf and /data/user/0/app/files/models/Private Models/private model.gguf'),
    );

    let thrownError: AppError | undefined;
    try {
      await modelDownloadManager.verifyChecksum({ ...mockModel, sha256: VALID_SHA256 }, 'test-dir/models/model.gguf');
    } catch (error) {
      thrownError = error as AppError;
    }

    expect(thrownError).toMatchObject({
      code: 'download_verification_failed',
      message: 'Hash failed for [path] and [path]',
    });
    expectNoSensitiveDownloadPathLeak(JSON.stringify(thrownError ?? {}));
    expect(JSON.stringify(thrownError ?? {})).not.toContain('Private Models');
    expect(JSON.stringify(thrownError ?? {})).not.toContain('private model.gguf');
    expect(JSON.stringify(thrownError ?? {})).not.toContain('/data/user');
  });

  it('marks no-sha downloads as unverified when the expected size is unknown', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, size: null }, 'test-dir/model.gguf'),
    ).resolves.toEqual({
      integrity: 'unverified',
      sizeBytes: 1000,
    });
  });

  it('rejects downloads that still have unknown size at preflight time', async () => {
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({ size: null }),
    ).rejects.toThrow('MODEL_SIZE_UNKNOWN');

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.downloadErrorCode).toBe('download_size_unknown');
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('accounts for selected projector bytes in low-storage preflight', async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_000_000 + 1_000 + 1_000 - 1);
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({ projectorCandidates: [mockProjector] }),
    ).rejects.toMatchObject({
      code: 'download_disk_space_low',
      details: expect.objectContaining({
        requiredBytes: 1_000_002_000,
        artifactKind: 'projector',
      }),
    });

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: mockProjector.id,
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: 'download_disk_space_low',
    }));
  });

  it('checks known projector bytes for unknown-size base downloads', async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_000_000 + 1_000 - 1);
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        size: null,
        allowUnknownSizeDownload: true,
        projectorCandidates: [mockProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({
        size: null,
        allowUnknownSizeDownload: true,
        projectorCandidates: [mockProjector],
      }),
    ).rejects.toMatchObject({
      code: 'download_disk_space_low',
      details: expect.objectContaining({
        requiredBytes: 1_000_001_000,
        artifactKind: 'projector',
      }),
    });

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: mockProjector.id,
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: 'download_disk_space_low',
    }));
  });

  it('checks the required buffer for unknown-size projector preflight when the base model is reusable', async () => {
    const unknownSizeProjector: ProjectorArtifact = {
      ...mockProjector,
      size: null,
    };
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_000_000 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf') {
        return { exists: true, size: 1000 };
      }

      return uri.startsWith('test-dir/models/')
        ? { exists: false, size: 0 }
        : { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [unknownSizeProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [unknownSizeProjector],
      }),
    ).rejects.toMatchObject({
      code: 'download_disk_space_low',
      details: expect.objectContaining({
        requiredBytes: 1_000_000_000,
        artifactKind: 'projector',
      }),
    });

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });

  it('uses remaining model bytes and preserves valid resume data on low-storage preflight failure', async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_000_600 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/partial-model.gguf') {
        return { exists: true, size: 400 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'partial-model.gguf',
        resumeData: 'model-resume-data',
        downloadProgress: 0.4,
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({
        localPath: 'partial-model.gguf',
        resumeData: 'model-resume-data',
        downloadProgress: 0.4,
      }),
    ).rejects.toMatchObject({
      code: 'download_disk_space_low',
      details: expect.objectContaining({
        requiredBytes: 1_000_000_600,
      }),
    });

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.resumeData).toBe('model-resume-data');
    expect(entry?.downloadProgress).toBe(0.4);
  });

  it('uses full model bytes and clears resume data when the resumable partial is missing', async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_001_000 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri.startsWith('test-dir/models/')
        ? { exists: false, size: 0 }
        : { exists: true, size: 1000 }
    ));
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'missing-partial-model.gguf',
        resumeData: 'stale-model-resume-data',
        downloadProgress: 0.4,
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({
        localPath: 'missing-partial-model.gguf',
        resumeData: 'stale-model-resume-data',
        downloadProgress: 0.4,
      }),
    ).rejects.toMatchObject({
      code: 'download_disk_space_low',
      details: expect.objectContaining({
        requiredBytes: 1_000_001_000,
      }),
    });

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.resumeData).toBeUndefined();
    expect(entry?.downloadProgress).toBe(0);
  });

  it('uses remaining projector bytes and preserves valid projector resume data on low-storage preflight failure', async () => {
    const resumableProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'paused',
      localPath: 'partial-mmproj.gguf',
      resumeData: 'projector-resume-data',
      downloadProgress: 0.4,
    };
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_001_600 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/partial-mmproj.gguf') {
        return { exists: true, size: 400 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [resumableProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({ projectorCandidates: [resumableProjector] }),
    ).rejects.toMatchObject({
      code: 'download_disk_space_low',
      details: expect.objectContaining({
        requiredBytes: 1_000_001_600,
        artifactKind: 'projector',
      }),
    });

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: mockProjector.id,
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: 'download_disk_space_low',
      resumeData: 'projector-resume-data',
      downloadProgress: 0.4,
    }));
  });

  it('uses full projector bytes and clears projector resume data when its partial is missing', async () => {
    const missingPartialProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'paused',
      localPath: 'missing-mmproj.gguf',
      resumeData: 'stale-projector-resume-data',
      downloadProgress: 0.4,
    };
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_002_000 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri.startsWith('test-dir/models/')
        ? { exists: false, size: 0 }
        : { exists: true, size: 1000 }
    ));
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [missingPartialProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({ projectorCandidates: [missingPartialProjector] }),
    ).rejects.toMatchObject({
      code: 'download_disk_space_low',
      details: expect.objectContaining({
        requiredBytes: 1_000_002_000,
        artifactKind: 'projector',
      }),
    });

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    const projector = entry?.projectorCandidates?.[0];
    expect(projector).toEqual(expect.objectContaining({
      id: mockProjector.id,
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: 'download_disk_space_low',
    }));
    expect(projector?.resumeData).toBeUndefined();
    expect(projector?.downloadProgress).toBeUndefined();
    expect(projector?.localPath).toBeUndefined();
  });

  it.each(['missing', 'oversized'] as const)(
    'starts a clean full model download without stale resume data when the %s partial has sufficient disk',
    async (partialState) => {
      const partialFileName = `${partialState}-partial-model.gguf`;
      let modelDownloaded = false;
      (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
        downloadAsync: jest.fn().mockImplementation(async () => {
          modelDownloaded = true;
          return { status: 200 };
        }),
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        savable: jest.fn(),
      }));
      (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
        if (!uri.startsWith('test-dir/models/')) {
          return { exists: true, size: 1000 };
        }

        if (uri === `test-dir/models/${partialFileName}`) {
          if (modelDownloaded) {
            return { exists: true, size: 1000 };
          }

          return partialState === 'missing'
            ? { exists: false, size: 0 }
            : { exists: true, size: 1001 };
        }

        return { exists: false, size: 0 };
      });
      useDownloadStore.setState({
        queue: [{
          ...mockModel,
          localPath: partialFileName,
          resumeData: 'stale-model-resume-data',
          downloadProgress: 0.4,
          lifecycleStatus: LifecycleStatus.QUEUED,
        }],
        activeDownloadId: mockModel.id,
      });

      await expect(runDownloadModel({
        localPath: partialFileName,
        resumeData: 'stale-model-resume-data',
        downloadProgress: 0.4,
      })).resolves.toBeUndefined();

      expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
        mockModel.downloadUrl,
        `test-dir/models/${partialFileName}`,
        {},
        expect.any(Function),
        undefined,
      );
    },
  );

  it.each(['missing', 'oversized'] as const)(
    'starts a clean full projector download without stale resume data when the %s partial has sufficient disk',
    async (partialState) => {
      const partialFileName = `${partialState}-partial-mmproj.gguf`;
      const pausedProjector: ProjectorArtifact = {
        ...mockProjector,
        lifecycleStatus: 'paused',
        localPath: partialFileName,
        resumeData: 'stale-projector-resume-data',
        downloadProgress: 0.4,
      };
      let projectorDownloaded = false;
      (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
        downloadAsync: jest.fn().mockImplementation(async () => {
          projectorDownloaded = true;
          return { status: 200 };
        }),
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        savable: jest.fn(),
      }));
      (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
        if (!uri.startsWith('test-dir/models/')) {
          return { exists: true, size: 1000 };
        }

        if (uri === 'test-dir/models/model.gguf') {
          return { exists: true, size: 1000 };
        }

        if (uri === `test-dir/models/${partialFileName}`) {
          if (projectorDownloaded) {
            return { exists: true, size: 1000 };
          }

          return partialState === 'missing'
            ? { exists: false, size: 0 }
            : { exists: true, size: 1001 };
        }

        return { exists: false, size: 0 };
      });
      useDownloadStore.setState({
        queue: [{
          ...mockModel,
          localPath: 'model.gguf',
          downloadProgress: 1,
          projectorCandidates: [pausedProjector],
          lifecycleStatus: LifecycleStatus.QUEUED,
        }],
        activeDownloadId: mockModel.id,
      });

      await expect(runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [pausedProjector],
      })).resolves.toBeUndefined();

      expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
      expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
        mockProjector.downloadUrl,
        `test-dir/models/${partialFileName}`,
        {},
        expect.any(Function),
        undefined,
      );
    },
  );

  it('does not resume a stale model partial that points at a completed protected file', async () => {
    const protectedFileName = 'protected-completed-model.gguf';
    let modelDownloaded = false;
    mockedRegistry.getModels.mockReturnValue([{
      ...mockModel,
      id: 'other/completed-model',
      localPath: protectedFileName,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    }]);
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        modelDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri === `test-dir/models/${protectedFileName}`) {
        return { exists: true, size: 400 };
      }
      return modelDownloaded
        ? { exists: true, size: 1000 }
        : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: protectedFileName,
        resumeData: 'stale-protected-model-resume-data',
        downloadProgress: 0.4,
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      localPath: protectedFileName,
      resumeData: 'stale-protected-model-resume-data',
      downloadProgress: 0.4,
    })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      mockModel.downloadUrl,
      expect.not.stringContaining(protectedFileName),
      {},
      expect.any(Function),
      undefined,
    );
  });

  it('does not resume a stale projector partial that points at a completed protected file', async () => {
    const protectedFileName = 'protected-completed-mmproj.gguf';
    const pausedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'paused',
      localPath: protectedFileName,
      resumeData: 'stale-protected-projector-resume-data',
      downloadProgress: 0.4,
    };
    let projectorDownloaded = false;
    mockedRegistry.getModels.mockReturnValue([{
      ...mockModel,
      id: 'other/completed-projector-owner',
      localPath: 'other-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      projectorCandidates: [{
        ...mockProjector,
        id: 'other-projector',
        ownerModelId: 'other/completed-projector-owner',
        lifecycleStatus: 'downloaded',
        localPath: protectedFileName,
      }],
    }]);
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        projectorDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri === 'test-dir/models/model.gguf') {
        return { exists: true, size: 1000 };
      }
      if (uri === `test-dir/models/${protectedFileName}`) {
        return { exists: true, size: 400 };
      }
      return projectorDownloaded
        ? { exists: true, size: 1000 }
        : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [pausedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      localPath: 'model.gguf',
      downloadProgress: 1,
      projectorCandidates: [pausedProjector],
    })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      mockProjector.downloadUrl,
      expect.not.stringContaining(protectedFileName),
      {},
      expect.any(Function),
      undefined,
    );
  });

  it('resumes a later safe model partial after skipping an unsafe protected candidate', async () => {
    const protectedFileName = 'protected-completed-model.gguf';
    mockedRegistry.getModels.mockReturnValue([{
      ...mockModel,
      id: 'other/completed-model',
      localPath: protectedFileName,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    }]);
    let modelDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        modelDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri === `test-dir/models/${protectedFileName}`) {
        return { exists: true, size: 400 };
      }
      return { exists: true, size: modelDownloaded ? 1000 : 400 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: protectedFileName,
        resumeData: 'valid-later-model-resume-data',
        downloadProgress: 0.4,
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      localPath: protectedFileName,
      resumeData: 'valid-later-model-resume-data',
      downloadProgress: 0.4,
    })).resolves.toBeUndefined();

    const modelDownloadCall = (FileSystem.createDownloadResumable as jest.Mock).mock.calls.find(
      ([url]) => url === mockModel.downloadUrl,
    );
    expect(modelDownloadCall).toEqual([
      mockModel.downloadUrl,
      expect.not.stringContaining(protectedFileName),
      {},
      expect.any(Function),
      'valid-later-model-resume-data',
    ]);
  });

  it('resumes a later safe projector partial after skipping an unsafe protected candidate', async () => {
    const protectedFileName = 'protected-completed-mmproj.gguf';
    const pausedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'paused',
      localPath: protectedFileName,
      resumeData: 'valid-later-projector-resume-data',
      downloadProgress: 0.4,
    };
    mockedRegistry.getModels.mockReturnValue([{
      ...mockModel,
      id: 'other/completed-projector-owner',
      localPath: 'other-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      projectorCandidates: [{
        ...mockProjector,
        id: 'other-projector',
        ownerModelId: 'other/completed-projector-owner',
        lifecycleStatus: 'downloaded',
        localPath: protectedFileName,
      }],
    }]);
    let projectorDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        projectorDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri === 'test-dir/models/model.gguf') {
        return { exists: true, size: 1000 };
      }
      if (uri === `test-dir/models/${protectedFileName}`) {
        return { exists: true, size: 400 };
      }
      return { exists: true, size: projectorDownloaded ? 1000 : 400 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [pausedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      localPath: 'model.gguf',
      downloadProgress: 1,
      projectorCandidates: [pausedProjector],
    })).resolves.toBeUndefined();

    const projectorDownloadCall = (FileSystem.createDownloadResumable as jest.Mock).mock.calls.find(
      ([url]) => url === mockProjector.downloadUrl,
    );
    expect(projectorDownloadCall).toEqual([
      mockProjector.downloadUrl,
      expect.not.stringContaining(protectedFileName),
      {},
      expect.any(Function),
      'valid-later-projector-resume-data',
    ]);
  });

  it('does not count reusable projector bytes during preflight disk planning', async () => {
    const storedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      resumeData: 'stale-projector-resume-data',
      downloadProgress: 0.4,
      size: 1000,
      sha256: VALID_SHA256,
    };
    let modelDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        modelDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1_000_000_000 + 1_000 + 1_000 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true, size: 1000 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [storedProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(
      runDownloadModel({ projectorCandidates: [storedProjector] }),
    ).resolves.toBeUndefined();

    expect(RNFS.hash).toHaveBeenCalledWith('test-dir/models/mmproj-model.gguf', 'sha256');
    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      mockModel.downloadUrl,
      expect.stringContaining('test-dir/models/'),
      {},
      expect.any(Function),
      undefined,
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: mockModel.id,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      projectorCandidates: [expect.objectContaining({
        id: mockProjector.id,
        lifecycleStatus: 'downloaded',
        localPath: 'mmproj-model.gguf',
        downloadProgress: 1,
      })],
    }));
    const completedProjector = (mockedRegistry.updateModel as jest.Mock).mock.calls.at(-1)?.[0]?.projectorCandidates?.[0];
    expect(completedProjector?.resumeData).toBeUndefined();
  });

  it('counts unknown-size reusable projector fallback in memory fit without persisting the fallback size', async () => {
    const storedUnknownSizeProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      size: null,
    };
    const resolveMemoryFitSpy = jest.spyOn(modelDownloadManager as any, 'resolveMemoryFit').mockResolvedValue({
      fitsInRam: false,
      decision: 'likely_oom',
      confidence: 'low',
    });
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockImplementation(async (artifact) => (
      artifact.id === storedUnknownSizeProjector.id
        ? { integrity: 'unverified', sizeBytes: 0 }
        : { integrity: 'size', sizeBytes: 1000 }
    ));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true };
      }

      return { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedUnknownSizeProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedUnknownSizeProjector],
      })).resolves.toBeUndefined();

      expect(resolveMemoryFitSpy.mock.calls.some(
        ([sizeBytes]) => sizeBytes === 1000 + UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES,
      )).toBe(true);
      const completedModel = (mockedRegistry.updateModel as jest.Mock).mock.calls.at(-1)?.[0];
      expect(completedModel?.projectorCandidates?.[0]?.size).not.toBe(UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES);
    } finally {
      verifySpy.mockRestore();
      resolveMemoryFitSpy.mockRestore();
    }
  });

  it('downloads and persists the selected projector with the owning model', async () => {
    let modelDownloaded = false;
    let projectorDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(2);
    expect(FileSystem.createDownloadResumable).toHaveBeenNthCalledWith(
      2,
      mockProjector.downloadUrl,
      expect.stringMatching(/^test-dir\/models\/model-mmproj-model-main-[a-z0-9]+\.gguf$/),
      {},
      expect.any(Function),
      undefined,
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockModel.id,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            kind: 'main_model',
            installState: 'installed',
            localPath: expect.stringMatching(/^model-main-[a-z0-9]+\.gguf$/),
            downloadProgress: 1,
            integrity: expect.objectContaining({ kind: 'size', sizeBytes: 1000 }),
          }),
          expect.objectContaining({
            id: mockProjector.id,
            kind: 'multimodal_projector',
            installState: 'installed',
            localPath: expect.stringMatching(/^model-mmproj-model-main-[a-z0-9]+\.gguf$/),
            sizeBytes: 1000,
          }),
        ]),
        projectorCandidates: [
          expect.objectContaining({
            id: mockProjector.id,
            lifecycleStatus: 'downloaded',
            matchStatus: 'matched',
            localPath: expect.stringMatching(/^model-mmproj-model-main-[a-z0-9]+\.gguf$/),
            size: 1000,
          }),
        ],
      }),
    );
    expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);
  });

  it('completes a variant-only audio projector and derives its exact installed artifact', async () => {
    const variantProjector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        ownerVariantId: 'audio-q4',
        fileName: mockProjector.fileName,
      }),
      ownerVariantId: 'audio-q4',
    };
    const variantModel = buildVariantOnlyAudioModel(variantProjector);
    let modelDownloaded = false;
    let projectorDownloaded = false;
    let projectorProgressState: ProjectorArtifact | undefined;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string, _options: unknown, onProgress?: (progress: unknown) => void) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === variantProjector.downloadUrl || localUri.includes('mmproj')) {
          onProgress?.({ totalBytesWritten: 500, totalBytesExpectedToWrite: 1000 });
          projectorProgressState = useDownloadStore.getState().queue[0]
            ?.variants?.[0].projectorCandidates?.[0];
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }
      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...variantModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: variantModel.id,
    });

    await expect(runDownloadModel(variantModel)).resolves.toBeUndefined();

    expect(projectorProgressState).toEqual(expect.objectContaining({
      id: variantProjector.id,
      lifecycleStatus: 'downloading',
      downloadProgress: 0.5,
    }));
    const completedModel = (mockedRegistry.updateModel as jest.Mock).mock.calls.at(-1)?.[0] as ModelMetadata;
    expect(completedModel.projectorCandidates).toBeUndefined();
    expect(completedModel.selectedProjectorId).toBeUndefined();
    expect(completedModel.variants?.[0]).toEqual(expect.objectContaining({
      selectedProjectorId: variantProjector.id,
      projectorCandidates: [expect.objectContaining({
        id: variantProjector.id,
        fileName: variantProjector.fileName,
        lifecycleStatus: 'downloaded',
        localPath: expect.stringMatching(/mmproj.*\.gguf$/),
      })],
    }));
    const installedProjectorArtifact = completedModel.artifacts?.find((artifact) => artifact.id === variantProjector.id);
    expect(installedProjectorArtifact).toEqual(expect.objectContaining({
      id: variantProjector.id,
      kind: 'multimodal_projector',
      remoteFileName: variantProjector.fileName,
      installState: 'installed',
      requiredFor: ['audio'],
      localPath: expect.stringMatching(/mmproj.*\.gguf$/),
    }));
    expect(installedProjectorArtifact?.requiredFor).not.toContain('image');
  });

  it('records a variant-only projector failure on the active variant after the base model is ready', async () => {
    const variantProjector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        ownerVariantId: 'audio-q4',
        fileName: mockProjector.fileName,
      }),
      ownerVariantId: 'audio-q4',
    };
    const variantModel = buildVariantOnlyAudioModel(variantProjector);
    let modelDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === variantProjector.downloadUrl) {
          throw new Error('variant projector transport failed');
        }
        modelDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri.includes('mmproj')
        ? { exists: false, size: 0 }
        : modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 }
    ));
    useDownloadStore.setState({
      queue: [{ ...variantModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: variantModel.id,
    });

    await expect(runDownloadModel(variantModel)).rejects.toThrow('variant projector transport failed');

    const failedModel = (mockedRegistry.updateModel as jest.Mock).mock.calls.at(-1)?.[0] as ModelMetadata;
    expect(failedModel.lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(failedModel.projectorCandidates).toBeUndefined();
    expect(failedModel.variants?.[0].projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: variantProjector.id,
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
    }));
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('keeps separate persisted projector requirements within active mixed modalities', () => {
    const imageProjector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        fileName: 'mmproj-image.gguf',
      }),
      fileName: 'mmproj-image.gguf',
      downloadUrl: 'http://example.com/mmproj-image.gguf',
    };
    const audioProjector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        fileName: 'mmproj-audio.gguf',
      }),
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'http://example.com/mmproj-audio.gguf',
    };
    const synchronized = (modelDownloadManager as any).withSynchronizedArtifacts({
      ...mockModel,
      activeVariantId: 'mixed-q4',
      resolvedFileName: 'model-mixed.gguf',
      variants: [{
        variantId: 'mixed-q4',
        fileName: 'model-mixed.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1000,
        chatModalities: ['text', 'vision', 'audio'],
        projectorCandidates: [imageProjector, audioProjector],
      }],
      artifacts: [
        {
          id: imageProjector.id,
          kind: 'multimodal_projector',
          requiredFor: ['image'],
          remoteFileName: imageProjector.fileName,
          downloadUrl: imageProjector.downloadUrl,
          sizeBytes: imageProjector.size,
          installState: 'remote',
        },
        {
          id: audioProjector.id,
          kind: 'multimodal_projector',
          requiredFor: ['audio'],
          remoteFileName: audioProjector.fileName,
          downloadUrl: audioProjector.downloadUrl,
          sizeBytes: audioProjector.size,
          installState: 'remote',
        },
      ],
    }) as ModelMetadata;

    expect(synchronized.artifacts?.find((artifact) => artifact.id === imageProjector.id)?.requiredFor).toEqual(['image']);
    expect(synchronized.artifacts?.find((artifact) => artifact.id === audioProjector.id)?.requiredFor).toEqual(['audio']);
  });

  it('does not restore projector requirements from a persisted artifact with another remote identity', () => {
    const projector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        fileName: 'projectors/mmproj-audio.gguf',
      }),
      fileName: 'projectors/mmproj-audio.gguf',
      downloadUrl: 'http://example.com/projectors/mmproj-audio.gguf',
    };
    const synchronized = (modelDownloadManager as any).withSynchronizedArtifacts({
      ...mockModel,
      activeVariantId: 'mixed-q4',
      resolvedFileName: 'model-mixed.gguf',
      variants: [{
        variantId: 'mixed-q4',
        fileName: 'model-mixed.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1000,
        chatModalities: ['text', 'vision', 'audio'],
        projectorCandidates: [projector],
      }],
      artifacts: [{
        id: projector.id,
        kind: 'multimodal_projector',
        requiredFor: ['audio'],
        remoteFileName: projector.fileName,
        downloadUrl: 'http://example.com/stale/mmproj-audio.gguf',
        sizeBytes: projector.size,
        installState: 'remote',
      }],
    }) as ModelMetadata;

    expect(synchronized.artifacts?.find((artifact) => artifact.id === projector.id)).toBeUndefined();
  });

  it('keeps an exact installed projector artifact owned by an inactive variant', () => {
    const activeProjector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        ownerVariantId: 'variant-a',
        fileName: 'active/mmproj-audio.gguf',
      }),
      ownerVariantId: 'variant-a',
      fileName: 'active/mmproj-audio.gguf',
      downloadUrl: 'http://example.com/active/mmproj-audio.gguf',
    };
    const inactiveProjector = {
      ...mockProjector,
      id: buildProjectorArtifactId({
        repoId: mockProjector.repoId,
        hfRevision: mockProjector.hfRevision,
        ownerVariantId: 'variant-b',
        fileName: 'inactive/mmproj-audio.gguf',
      }),
      ownerVariantId: 'variant-b',
      fileName: 'inactive/mmproj-audio.gguf',
      downloadUrl: 'http://example.com/inactive/mmproj-audio.gguf',
    };
    const inactiveArtifact = {
      id: inactiveProjector.id,
      kind: 'multimodal_projector' as const,
      requiredFor: ['audio' as const],
      hfRevision: inactiveProjector.hfRevision,
      remoteFileName: inactiveProjector.fileName,
      downloadUrl: inactiveProjector.downloadUrl,
      sizeBytes: inactiveProjector.size,
      localPath: 'file:///models/inactive-mmproj-audio.gguf',
      installState: 'installed' as const,
    };

    const synchronized = (modelDownloadManager as any).withSynchronizedArtifacts({
      ...mockModel,
      activeVariantId: 'variant-a',
      resolvedFileName: 'model-a.gguf',
      variants: [
        {
          variantId: 'variant-a',
          fileName: 'model-a.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1000,
          chatModalities: ['text', 'audio'],
          projectorCandidates: [activeProjector],
        },
        {
          variantId: 'variant-b',
          fileName: 'model-b.gguf',
          quantizationLabel: 'Q8_0',
          size: 1000,
          chatModalities: ['text', 'audio'],
          projectorCandidates: [inactiveProjector],
        },
      ],
      artifacts: [inactiveArtifact],
    }) as ModelMetadata;

    expect(synchronized.artifacts?.find((artifact) => artifact.id === inactiveProjector.id))
      .toEqual(inactiveArtifact);
    expect(synchronized.artifacts?.find((artifact) => artifact.id === activeProjector.id))
      .toEqual(expect.objectContaining({ requiredFor: ['audio'] }));
  });

  it.each(['current-first', 'legacy-first'] as const)(
    'blocks conflicting current and legacy projector requirements independent of artifact order (%s)',
    (artifactOrder) => {
      const projector = {
        ...mockProjector,
        id: buildProjectorArtifactId({
          repoId: mockProjector.repoId,
          hfRevision: mockProjector.hfRevision,
          fileName: 'Projectors/MMProj-Audio.GGUF',
        }),
        fileName: 'Projectors/MMProj-Audio.GGUF',
        downloadUrl: 'http://example.com/Projectors/MMProj-Audio.GGUF',
      };
      const currentArtifact = {
        id: projector.id,
        kind: 'multimodal_projector' as const,
        requiredFor: ['image' as const],
        hfRevision: projector.hfRevision,
        remoteFileName: projector.fileName,
        downloadUrl: projector.downloadUrl,
        sizeBytes: projector.size,
        installState: 'remote' as const,
      };
      const legacyArtifact = {
        ...currentArtifact,
        id: buildLegacyProjectorArtifactId({
          repoId: projector.repoId,
          hfRevision: projector.hfRevision,
          fileName: projector.fileName,
        }),
        requiredFor: ['audio' as const],
      };
      const synchronized = (modelDownloadManager as any).withSynchronizedArtifacts({
        ...mockModel,
        activeVariantId: 'mixed-q4',
        resolvedFileName: 'model-mixed.gguf',
        variants: [{
          variantId: 'mixed-q4',
          fileName: 'model-mixed.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1000,
          chatModalities: ['text', 'vision', 'audio'],
          projectorCandidates: [projector],
        }],
        artifacts: artifactOrder === 'current-first'
          ? [currentArtifact, legacyArtifact]
          : [legacyArtifact, currentArtifact],
      }) as ModelMetadata;

      expect(synchronized.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector'))
        .not.toBe(true);
    },
  );

  it.each(['legacy-first', 'current-first'] as const)(
    'blocks conflicting requirements when the active candidate still has the legacy id (%s)',
    (artifactOrder) => {
      const identity = {
        repoId: mockModel.id,
        hfRevision: 'main',
        ownerVariantId: 'mixed-q4',
        fileName: 'Projectors/MMProj-Audio.GGUF',
      };
      const currentId = buildProjectorArtifactId(identity);
      const legacyId = buildLegacyProjectorArtifactId(identity);
      expect(currentId).not.toBe(legacyId);
      const projector = {
        ...mockProjector,
        ...identity,
        id: legacyId,
        ownerModelId: mockModel.id,
        downloadUrl: `https://huggingface.co/${mockModel.id}/resolve/main/${identity.fileName}`,
      };
      const legacyArtifact = {
        id: legacyId,
        kind: 'multimodal_projector' as const,
        requiredFor: ['audio' as const],
        hfRevision: projector.hfRevision,
        remoteFileName: projector.fileName,
        downloadUrl: projector.downloadUrl,
        sizeBytes: projector.size,
        installState: 'remote' as const,
      };
      const currentArtifact = {
        ...legacyArtifact,
        id: currentId,
        requiredFor: ['image' as const],
      };
      const synchronized = (modelDownloadManager as any).withSynchronizedArtifacts({
        ...mockModel,
        activeVariantId: 'mixed-q4',
        resolvedFileName: 'model-mixed.gguf',
        variants: [{
          variantId: 'mixed-q4',
          fileName: 'model-mixed.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1000,
          chatModalities: ['text', 'vision', 'audio'],
          projectorCandidates: [projector],
        }],
        artifacts: artifactOrder === 'legacy-first'
          ? [legacyArtifact, currentArtifact]
          : [currentArtifact, legacyArtifact],
      }) as ModelMetadata;

      expect(synchronized.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector'))
        .not.toBe(true);
    },
  );

  it.each(['current-first', 'legacy-first'] as const)(
    'ignores an ambiguous legacy alias when restoring projector requirements (%s)',
    (artifactOrder) => {
      const sharedIdentity = {
        repoId: mockModel.id,
        hfRevision: 'main',
        ownerVariantId: 'mixed-q4',
      };
      const upperProjector = {
        ...mockProjector,
        ...sharedIdentity,
        id: buildProjectorArtifactId({
          ...sharedIdentity,
          fileName: 'Adapters/MMProj.GGUF',
        }),
        ownerModelId: mockModel.id,
        fileName: 'Adapters/MMProj.GGUF',
        downloadUrl: `https://huggingface.co/${mockModel.id}/resolve/main/Adapters/MMProj.GGUF`,
      };
      const lowerProjector = {
        ...upperProjector,
        id: buildProjectorArtifactId({
          ...sharedIdentity,
          fileName: 'adapters/mmproj.gguf',
        }),
        fileName: 'adapters/mmproj.gguf',
        downloadUrl: `https://huggingface.co/${mockModel.id}/resolve/main/adapters/mmproj.gguf`,
      };
      const currentArtifact = {
        id: upperProjector.id,
        kind: 'multimodal_projector' as const,
        requiredFor: ['image' as const],
        hfRevision: upperProjector.hfRevision,
        remoteFileName: upperProjector.fileName,
        downloadUrl: upperProjector.downloadUrl,
        sizeBytes: upperProjector.size,
        installState: 'remote' as const,
      };
      const ambiguousLegacyArtifact = {
        ...currentArtifact,
        id: buildLegacyProjectorArtifactId({
          ...sharedIdentity,
          fileName: upperProjector.fileName,
        }),
        requiredFor: ['audio' as const],
      };
      const synchronized = (modelDownloadManager as any).withSynchronizedArtifacts({
        ...mockModel,
        activeVariantId: 'mixed-q4',
        resolvedFileName: 'model-mixed.gguf',
        variants: [{
          variantId: 'mixed-q4',
          fileName: 'model-mixed.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1000,
          chatModalities: ['text', 'vision', 'audio'],
          projectorCandidates: [upperProjector, lowerProjector],
        }],
        artifacts: artifactOrder === 'current-first'
          ? [currentArtifact, ambiguousLegacyArtifact]
          : [ambiguousLegacyArtifact, currentArtifact],
      }) as ModelMetadata;

      expect(synchronized.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({
          id: upperProjector.id,
          requiredFor: ['image'],
        })]);
    },
  );

  it.each(['legacy-first', 'current-first'] as const)(
    'does not treat an ambiguous legacy candidate id as current (%s)',
    (candidateOrder) => {
      const sharedIdentity = {
        repoId: mockModel.id,
        hfRevision: 'main',
        ownerVariantId: 'mixed-q4',
      };
      const legacyCandidate = {
        ...mockProjector,
        ...sharedIdentity,
        id: buildLegacyProjectorArtifactId({
          ...sharedIdentity,
          fileName: 'Adapters/MMProj.GGUF',
        }),
        ownerModelId: mockModel.id,
        fileName: 'Adapters/MMProj.GGUF',
        downloadUrl: `https://huggingface.co/${mockModel.id}/resolve/main/Adapters/MMProj.GGUF`,
      };
      const currentCandidate = {
        ...legacyCandidate,
        id: buildProjectorArtifactId({
          ...sharedIdentity,
          fileName: 'adapters/mmproj.gguf',
        }),
        fileName: 'adapters/mmproj.gguf',
        downloadUrl: `https://huggingface.co/${mockModel.id}/resolve/main/adapters/mmproj.gguf`,
      };
      expect(currentCandidate.id).toBe(legacyCandidate.id);
      const projectorCandidates = candidateOrder === 'legacy-first'
        ? [legacyCandidate, currentCandidate]
        : [currentCandidate, legacyCandidate];
      const synchronized = (modelDownloadManager as any).withSynchronizedArtifacts({
        ...mockModel,
        activeVariantId: 'mixed-q4',
        resolvedFileName: 'model-mixed.gguf',
        variants: [{
          variantId: 'mixed-q4',
          fileName: 'model-mixed.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1000,
          chatModalities: ['text', 'vision', 'audio'],
          projectorCandidates,
        }],
      }) as ModelMetadata;

      expect(synchronized.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({
          id: currentCandidate.id,
          remoteFileName: currentCandidate.fileName,
        })]);
    },
  );

  it('requests active multimodal readiness refresh after successful projector completion', async () => {
    let modelDownloaded = false;
    let projectorDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).resolves.toBeUndefined();

    expect(llmEngineService.requestActiveMultimodalReadinessRefresh).toHaveBeenCalledTimes(1);
    expect(llmEngineService.requestActiveMultimodalReadinessRefresh).toHaveBeenCalledWith(mockModel.id);
  });

  it('downloads a projector to the generated filename when the raw upstream filename already exists', async () => {
    let modelDownloaded = false;
    let projectorDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenNthCalledWith(
      2,
      mockProjector.downloadUrl,
      expect.stringMatching(/^test-dir\/models\/model-mmproj-model-main-[a-z0-9]+\.gguf$/),
      {},
      expect.any(Function),
      undefined,
    );
    expect(FileSystem.createDownloadResumable).not.toHaveBeenNthCalledWith(
      2,
      mockProjector.downloadUrl,
      'test-dir/models/mmproj-model.gguf',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: mockModel.id,
      projectorCandidates: [expect.objectContaining({
        id: mockProjector.id,
        localPath: expect.stringMatching(/^model-mmproj-model-main-[a-z0-9]+\.gguf$/),
      })],
    }));
  });

  it('deletes the current queued projector file when projector verification fails', async () => {
    let modelDownloaded = false;
    let projectorDownloaded = false;
    let projectorLocalUri = '';
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
          projectorLocalUri = localUri;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 999 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).rejects.toMatchObject({
      code: 'download_verification_failed',
    });

    expect(projectorLocalUri).toMatch(/^test-dir\/models\/model-mmproj-model-main-[a-z0-9]+\.gguf$/);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(projectorLocalUri, { idempotent: true });
    expect(mockedRegistry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({
      id: mockModel.id,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      projectorCandidates: [expect.objectContaining({ lifecycleStatus: 'downloaded' })],
    }));
  });

  it('does not let projector download progress overwrite the completed base checkpoint', async () => {
    let modelDownloaded = false;
    let projectorDownloaded = false;
    let progressBeforeProjectorCallback: number | undefined;
    let progressAfterProjectorCallback: number | undefined;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string, _options: unknown, onProgress?: (progress: unknown) => void) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          progressBeforeProjectorCallback = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)?.downloadProgress;
          onProgress?.({ totalBytesWritten: 250, totalBytesExpectedToWrite: 1000 });
          progressAfterProjectorCallback = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)?.downloadProgress;
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).resolves.toBeUndefined();

    expect(progressBeforeProjectorCallback).toBe(1);
    expect(progressAfterProjectorCallback).toBe(1);
    expect(FileSystem.createDownloadResumable).toHaveBeenNthCalledWith(
      2,
      mockProjector.downloadUrl,
      expect.stringMatching(/^test-dir\/models\/model-mmproj-model-main-[a-z0-9]+\.gguf$/),
      {},
      expect.any(Function),
      undefined,
    );
  });

  it('does not apply a stale projector progress callback to a conflicting same-id artifact', () => {
    const replacementProjector: ProjectorArtifact = {
      ...mockProjector,
      fileName: 'mmproj-model-v2.gguf',
      downloadUrl: 'http://example.com/mmproj-model-v2.gguf',
    };
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        lifecycleStatus: LifecycleStatus.DOWNLOADING,
        selectedProjectorId: replacementProjector.id,
        projectorCandidates: [replacementProjector],
      }],
      activeDownloadId: mockModel.id,
    });
    const jobToken = 91;
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken,
      resumable: null,
      activeArtifact: 'projector',
      activeProjectorId: mockProjector.id,
      activeProjector: mockProjector,
      stopReason: null,
    };

    const onProgress = (modelDownloadManager as any).createProjectorProgressCallback(
      { ...mockModel, projectorCandidates: [mockProjector] },
      mockProjector,
      jobToken,
    );
    onProgress({ totalBytesWritten: 500, totalBytesExpectedToWrite: 1000 });

    expect(useDownloadStore.getState().queue[0].projectorCandidates).toEqual([replacementProjector]);
    expect(useDownloadStore.getState().queue[0].projectorCandidates?.[0]).not.toHaveProperty('downloadProgress');
  });

  it('cancels promptly during projector verification and ignores stale verification completion', async () => {
    const projectorWithChecksum: ProjectorArtifact = {
      ...mockProjector,
      sha256: VALID_SHA256,
    };
    const queuedModel = {
      ...mockModel,
      id: 'test/queued-model',
      name: 'queued model',
      downloadUrl: 'http://example.com/queued.gguf',
      localPath: 'queued.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    let modelDownloaded = false;
    let projectorDownloaded = false;
    let resolveProjectorHash: (value: string) => void = () => undefined;
    const nextDownloadAsync = jest.fn(() => new Promise(() => undefined));
    const jobToken = 51;

    (RNFS.hash as jest.Mock).mockImplementation((nativePath: string) => {
      if (nativePath.includes('mmproj')) {
        return new Promise<string>((resolve) => {
          resolveProjectorHash = resolve;
        });
      }

      return Promise.resolve(VALID_SHA256);
    });
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: url === queuedModel.downloadUrl
        ? nextDownloadAsync
        : jest.fn().mockImplementation(async () => {
          if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
            projectorDownloaded = true;
          } else {
            modelDownloaded = true;
          }
          return { status: 200 };
        }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/queued.gguf') {
        return { exists: false, size: 0 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });

    try {
      const activeModel = {
        ...mockModel,
        projectorCandidates: [projectorWithChecksum],
        lifecycleStatus: LifecycleStatus.QUEUED,
      };
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken,
        resumable: null,
        stopReason: null,
      };
      (modelDownloadManager as any).isProcessing = true;
      useDownloadStore.setState({
        queue: [activeModel, queuedModel],
        activeDownloadId: mockModel.id,
      });

      const downloadPromise = (modelDownloadManager as any).runDownloadJob(activeModel, jobToken);

      for (let i = 0; i < 10 && (RNFS.hash as jest.Mock).mock.calls.length === 0; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(RNFS.hash).toHaveBeenCalledWith(expect.stringContaining('mmproj'), 'sha256');
      expect(useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)?.lifecycleStatus).toBe(LifecycleStatus.VERIFYING);

      await modelDownloadManager.cancelDownload(mockModel.id);

      expect(useDownloadStore.getState().activeDownloadId).not.toBe(mockModel.id);
      expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);

      for (let i = 0; i < 10 && (FileSystem.createDownloadResumable as jest.Mock).mock.calls.length < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(FileSystem.createDownloadResumable).toHaveBeenLastCalledWith(
        queuedModel.downloadUrl,
        expect.stringMatching(/^test-dir\/models\/queued-model-main-[a-z0-9]+\.gguf$/),
        {},
        expect.any(Function),
        undefined,
      );
      expect(useDownloadStore.getState().activeDownloadId).toBe(queuedModel.id);

      resolveProjectorHash(VALID_SHA256);
      await downloadPromise;

      expect(mockedRegistry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: mockModel.id }));
      expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);
      expect(useDownloadStore.getState().activeDownloadId).toBe(queuedModel.id);
    } finally {
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
      useDownloadStore.setState({ queue: [], activeDownloadId: null });
    }
  });

  it('cancels promptly while verifying a reusable projector after a fresh base download', async () => {
    const reusableProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      sha256: VALID_SHA256,
      size: 1000,
    };
    const queuedModel = {
      ...mockModel,
      id: 'test/queued-after-reusable-projector',
      name: 'queued after reusable projector',
      downloadUrl: 'http://example.com/queued-after-reusable-projector.gguf',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    let modelDownloaded = false;
    let resolveProjectorHash: (value: string) => void = () => undefined;
    const nextDownloadAsync = jest.fn(() => new Promise(() => undefined));
    const jobToken = 52;

    (mockedRegistry.getModels as jest.Mock).mockReturnValue([{ ...mockModel, lifecycleStatus: LifecycleStatus.DOWNLOADED, projectorCandidates: [reusableProjector] }]);
    (RNFS.hash as jest.Mock).mockImplementation((nativePath: string) => {
      if (nativePath.includes('mmproj-model')) {
        return new Promise<string>((resolve) => {
          resolveProjectorHash = resolve;
        });
      }

      return Promise.resolve(VALID_SHA256);
    });
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: url === queuedModel.downloadUrl
        ? nextDownloadAsync
        : jest.fn().mockImplementation(async () => {
          modelDownloaded = true;
          return { status: 200 };
        }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('queued-after-reusable-projector')) {
        return { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });

    try {
      const activeModel = {
        ...mockModel,
        projectorCandidates: [reusableProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      };
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken,
        resumable: null,
        stopReason: null,
      };
      (modelDownloadManager as any).isProcessing = true;
      useDownloadStore.setState({
        queue: [activeModel, queuedModel],
        activeDownloadId: mockModel.id,
      });

      const downloadPromise = (modelDownloadManager as any).runDownloadJob(activeModel, jobToken);

      for (let i = 0; i < 10 && (RNFS.hash as jest.Mock).mock.calls.length === 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(RNFS.hash).toHaveBeenCalledWith('test-dir/models/mmproj-model.gguf', 'sha256');
      expect(useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)?.lifecycleStatus).toBe(LifecycleStatus.DOWNLOADING);

      await modelDownloadManager.cancelDownload(mockModel.id);

      expect(useDownloadStore.getState().activeDownloadId).not.toBe(mockModel.id);
      expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);

      for (let i = 0; i < 10 && (FileSystem.createDownloadResumable as jest.Mock).mock.calls.length < 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(FileSystem.createDownloadResumable).toHaveBeenLastCalledWith(
        queuedModel.downloadUrl,
        expect.stringMatching(/^test-dir\/models\/queued-after-reusable-projector-main-[a-z0-9]+\.gguf$/),
        {},
        expect.any(Function),
        undefined,
      );
      expect(useDownloadStore.getState().activeDownloadId).toBe(queuedModel.id);

      resolveProjectorHash(VALID_SHA256);
      await downloadPromise;

      expect(mockedRegistry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: mockModel.id }));
      expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);
      expect(useDownloadStore.getState().activeDownloadId).toBe(queuedModel.id);
    } finally {
      resolveProjectorHash(VALID_SHA256);
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
      useDownloadStore.setState({ queue: [], activeDownloadId: null });
    }
  });

  it('ignores pause while verifying a reusable projector after a fresh base download', async () => {
    const reusableProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      sha256: VALID_SHA256,
      size: 1000,
    };
    let modelDownloaded = false;
    let resolveProjectorHash: (value: string) => void = () => undefined;
    const basePauseAsync = jest.fn().mockResolvedValue({ resumeData: 'stale-base-resume' });
    const jobToken = 53;

    (RNFS.hash as jest.Mock).mockImplementation((nativePath: string) => {
      if (nativePath.includes('mmproj-model')) {
        return new Promise<string>((resolve) => {
          resolveProjectorHash = resolve;
        });
      }

      return Promise.resolve(VALID_SHA256);
    });
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        modelDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: basePauseAsync,
      savable: jest.fn(() => ({ resumeData: 'stale-base-resume' })),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true, size: 1000 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });

    try {
      const activeModel = {
        ...mockModel,
        projectorCandidates: [reusableProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      };
      (modelDownloadManager as any).activeJob = {
        modelId: mockModel.id,
        jobToken,
        resumable: null,
        stopReason: null,
      };
      (modelDownloadManager as any).isProcessing = true;
      useDownloadStore.setState({
        queue: [activeModel],
        activeDownloadId: mockModel.id,
      });

      const downloadPromise = (modelDownloadManager as any).runDownloadJob(activeModel, jobToken);

      for (let i = 0; i < 10 && (RNFS.hash as jest.Mock).mock.calls.length === 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(RNFS.hash).toHaveBeenCalledWith('test-dir/models/mmproj-model.gguf', 'sha256');

      await modelDownloadManager.pauseDownload(mockModel.id);

      const entryAfterPause = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
      expect(basePauseAsync).not.toHaveBeenCalled();
      expect(entryAfterPause?.lifecycleStatus).not.toBe(LifecycleStatus.PAUSED);
      expect(entryAfterPause?.resumeData).toBeUndefined();
      expect(entryAfterPause?.projectorCandidates?.[0]).not.toEqual(expect.objectContaining({
        lifecycleStatus: 'paused',
      }));
      expect(useDownloadStore.getState().activeDownloadId).toBe(mockModel.id);

      resolveProjectorHash(VALID_SHA256);
      await downloadPromise;
    } finally {
      resolveProjectorHash(VALID_SHA256);
      (modelDownloadManager as any).activeJob = null;
      (modelDownloadManager as any).isProcessing = false;
      useDownloadStore.setState({ queue: [], activeDownloadId: null });
    }
  });

  it('verifies an existing projector at the projector stage without preflight hashing', async () => {
    const storedProjector = {
      ...mockProjector,
      lifecycleStatus: 'downloaded' as const,
      localPath: 'mmproj-model.gguf',
      size: 1000,
      sha256: VALID_SHA256,
    } as ProjectorArtifact & { sha256: string };
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf' || uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true, size: 1000 };
      }

      return { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      localPath: 'model.gguf',
      downloadProgress: 1,
      projectorCandidates: [storedProjector],
    })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    expect(RNFS.hash).toHaveBeenCalledTimes(1);
    expect(RNFS.hash).toHaveBeenCalledWith('test-dir/models/mmproj-model.gguf', 'sha256');
    const projectorInfoCalls = (FileSystem.getInfoAsync as jest.Mock).mock.calls.filter(
      ([uri]) => uri === 'test-dir/models/mmproj-model.gguf',
    );
    expect(projectorInfoCalls).toHaveLength(2);
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      projectorCandidates: [
        expect.objectContaining({
          id: mockProjector.id,
          lifecycleStatus: 'downloaded',
          localPath: 'mmproj-model.gguf',
          size: 1000,
        }),
      ],
    }));
  });

  it('does not schedule a second projector download after a downloaded legacy id migrates to the current id', async () => {
    const identity = {
      repoId: mockProjector.repoId,
      hfRevision: mockProjector.hfRevision,
      fileName: 'Projectors/MMProj.GGUF',
    };
    const currentId = buildProjectorArtifactId(identity);
    const legacyId = buildLegacyProjectorArtifactId(identity);
    expect(currentId).not.toBe(legacyId);

    const legacyDownloadedProjector: ProjectorArtifact = {
      ...mockProjector,
      ...identity,
      id: legacyId,
      downloadUrl: 'http://example.com/Projectors/MMProj.GGUF',
      lifecycleStatus: 'downloaded',
      localPath: 'installed-mmproj.gguf',
      sha256: VALID_SHA256,
    };
    const freshCurrentProjector: ProjectorArtifact = {
      ...legacyDownloadedProjector,
      id: currentId,
      lifecycleStatus: 'available',
      localPath: undefined,
    };

    (modelDownloadManager as any).isProcessing = true;
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        lifecycleStatus: LifecycleStatus.PAUSED,
        projectorCandidates: [legacyDownloadedProjector],
        selectedProjectorId: legacyId,
        multimodalReadiness: {
          modelId: mockModel.id,
          status: 'ready',
          projectorId: legacyId,
          support: ['vision'],
          checkedAt: 123,
        },
      }],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...mockModel,
      projectorCandidates: [freshCurrentProjector],
      selectedProjectorId: currentId,
    });

    const queued = useDownloadStore.getState().queue[0];
    expect(queued.projectorCandidates).toEqual([
      expect.objectContaining({
        id: currentId,
        lifecycleStatus: 'downloaded',
        localPath: 'installed-mmproj.gguf',
      }),
    ]);
    expect(queued.selectedProjectorId).toBe(currentId);
    expect(queued.multimodalReadiness?.projectorId).toBe(currentId);

    useDownloadStore.setState({ activeDownloadId: mockModel.id });
    await expect(runDownloadModel(queued)).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    expect(RNFS.hash).toHaveBeenCalledWith('test-dir/models/installed-mmproj.gguf', 'sha256');
  });

  it('falls back to downloading when a reusable projector disappears after preflight', async () => {
    const storedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      size: 1000,
    };
    let modelDownloaded = false;
    let projectorDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        if (projectorDownloaded) {
          return { exists: true, size: 1000 };
        }

        return modelDownloaded ? { exists: false, size: 0 } : { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [storedProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [storedProjector] })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(2);
    expect(FileSystem.createDownloadResumable).toHaveBeenNthCalledWith(
      2,
      mockProjector.downloadUrl,
      'test-dir/models/mmproj-model.gguf',
      {},
      expect.any(Function),
      undefined,
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      projectorCandidates: [
        expect.objectContaining({
          id: mockProjector.id,
          lifecycleStatus: 'downloaded',
          localPath: 'mmproj-model.gguf',
          size: 1000,
        }),
      ],
    }));
  });

  it('revalidates existing projector files before reusing them', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const storedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      size: 1000,
    };
    let staleProjectorExists = true;
    let rejectedReusableProjector = false;
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockImplementation(async (artifact, localUri) => {
      if (!rejectedReusableProjector && artifact.id === storedProjector.id && localUri.endsWith('/mmproj-model.gguf')) {
        rejectedReusableProjector = true;
        staleProjectorExists = false;
        throw new AppError('download_verification_failed', 'Projector checksum mismatch', {
          details: {
            modelId: mockModel.id,
            projectorId: storedProjector.id,
            reason: 'checksum_mismatch',
            localUri,
            uri: localUri,
          },
        });
      }

      return { integrity: 'size', sizeBytes: 1000 };
    });
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        return staleProjectorExists ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
      })).resolves.toBeUndefined();

      expect(verifySpy).toHaveBeenCalledWith(
        storedProjector,
        'test-dir/models/mmproj-model.gguf',
        expect.objectContaining({
          cleanupProtection: { excludeProjector: storedProjector },
        }),
      );
      expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
      expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
        mockProjector.downloadUrl,
        'test-dir/models/mmproj-model.gguf',
        {},
        expect.any(Function),
        undefined,
      );
      expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
        projectorCandidates: [
          expect.objectContaining({
            id: mockProjector.id,
            lifecycleStatus: 'downloaded',
            localPath: 'mmproj-model.gguf',
          }),
        ],
      }));
      const warningCalls = stringifyMockCalls(warnSpy);
      expect(warningCalls).toContain('download_verification_failed');
      expect(warningCalls).toContain('Projector checksum mismatch');
      expect(warningCalls).toContain(mockModel.id);
      expect(warningCalls).toContain('checksum_mismatch');
      expect(warningCalls).not.toContain(storedProjector.id);
      expectNoSensitiveDownloadPathLeak(warningCalls);
    } finally {
      verifySpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('deletes and retries the same corrupted stored projector target for the same artifact', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const storedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      size: 1000,
    };
    let corruptedProjectorDeleted = false;
    let projectorDownloaded = false;
    mockedRegistry.getModels.mockReturnValue([
      {
        ...mockModel,
        localPath: 'model.gguf',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        projectorCandidates: [storedProjector],
      },
      {
        ...mockModel,
        id: 'other/completed-model',
        localPath: 'other-completed.gguf',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
      },
    ]);
    (FileSystem.deleteAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/mmproj-model.gguf') {
        corruptedProjectorDeleted = true;
      }
    });
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.endsWith('/mmproj-model.gguf')) {
          projectorDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-model.gguf') {
        if (projectorDownloaded) {
          return { exists: true, size: 1000 };
        }

        return corruptedProjectorDeleted
          ? { exists: false, size: 0 }
          : { exists: true, size: 999 };
      }

      if (uri === 'test-dir/models/other-completed.gguf') {
        return { exists: true, size: 1000 };
      }

      return uri.startsWith('test-dir/models/')
        ? { exists: false, size: 0 }
        : { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
      })).resolves.toBeUndefined();

      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/models/mmproj-model.gguf', { idempotent: true });
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/models/other-completed.gguf', expect.anything());
      expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
        mockProjector.downloadUrl,
        'test-dir/models/mmproj-model.gguf',
        {},
        expect.any(Function),
        undefined,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('checks disk space before fallback projector download after reusable projector is rejected', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const storedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      size: 1000,
    };
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockImplementation(async (artifact, localUri) => {
      if (artifact.id === storedProjector.id && localUri.endsWith('/mmproj-model.gguf')) {
        throw new AppError('download_verification_failed', 'Projector checksum mismatch', {
          details: { modelId: mockModel.id, projectorId: storedProjector.id },
        });
      }

      return { integrity: 'size', sizeBytes: 1000 };
    });
    (FileSystem.getFreeDiskStorageAsync as jest.Mock)
      .mockResolvedValueOnce(10 * 1024 * 1024 * 1024)
      .mockResolvedValueOnce(1_000_000_000 + 1_000 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf' || uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true, size: 1000 };
      }

      return { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
      })).rejects.toMatchObject({
        code: 'download_disk_space_low',
        details: expect.objectContaining({
          modelId: mockModel.id,
          artifactKind: 'projector',
          requiredBytes: 1_000_001_000,
        }),
      });

      expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
      expect(FileSystem.getFreeDiskStorageAsync).toHaveBeenCalledTimes(2);
      expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        projectorCandidates: [expect.objectContaining({
          id: mockProjector.id,
          lifecycleStatus: 'failed',
          matchStatus: 'failed',
          matchReason: 'download_disk_space_low',
        })],
      }));
    } finally {
      verifySpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('checks the required buffer before fallback download for rejected unknown-size reusable projectors', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const storedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'downloaded',
      localPath: 'mmproj-model.gguf',
      size: null,
    };
    let rejectedReusableProjector = false;
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockImplementation(async (artifact, localUri) => {
      if (!rejectedReusableProjector && artifact.id === storedProjector.id && localUri.endsWith('/mmproj-model.gguf')) {
        rejectedReusableProjector = true;
        throw new AppError('download_verification_failed', 'Projector checksum mismatch', {
          details: { modelId: mockModel.id, projectorId: storedProjector.id },
        });
      }

      return { integrity: 'size', sizeBytes: 1000 };
    });
    (FileSystem.getFreeDiskStorageAsync as jest.Mock)
      .mockResolvedValueOnce(10 * 1024 * 1024 * 1024)
      .mockResolvedValueOnce(1_000_000_000 - 1);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf' || uri === 'test-dir/models/mmproj-model.gguf') {
        return { exists: true, size: 1000 };
      }

      return { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [storedProjector],
      })).rejects.toMatchObject({
        code: 'download_disk_space_low',
        details: expect.objectContaining({
          modelId: mockModel.id,
          artifactKind: 'projector',
          requiredBytes: 1_000_000_000,
        }),
      });

      expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
      expect(FileSystem.getFreeDiskStorageAsync).toHaveBeenCalledTimes(2);
    } finally {
      verifySpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('marks only the projector failed when its companion download fails after the model verifies', async () => {
    let modelDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          return { status: 500 };
        }
        modelDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(() => ({ resumeData: 'resume-data' })),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).rejects.toMatchObject({
      code: 'download_http_error',
    });

    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: expect.stringMatching(/^model-main-[a-z0-9]+\.gguf$/),
      downloadProgress: 1,
      downloadIntegrity: expect.objectContaining({ kind: 'size', sizeBytes: 1000 }),
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          kind: 'main_model',
          installState: 'installed',
          localPath: expect.stringMatching(/^model-main-[a-z0-9]+\.gguf$/),
          downloadProgress: 1,
          integrity: expect.objectContaining({ kind: 'size', sizeBytes: 1000 }),
        }),
        expect.objectContaining({
          id: mockProjector.id,
          kind: 'multimodal_projector',
          installState: 'failed',
          errorMessage: 'download_http_error',
        }),
      ]),
      projectorCandidates: [expect.objectContaining({
        id: mockProjector.id,
        lifecycleStatus: 'failed',
        matchStatus: 'failed',
        matchReason: 'download_http_error',
      })],
    }));
    expect(useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)).toBeUndefined();
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('preserves failed projector localPath when HTTP failure has no resume snapshot', async () => {
    let modelDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          return { status: 500 };
        }
        modelDownloaded = true;
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(() => undefined),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).rejects.toMatchObject({
      code: 'download_http_error',
    });

    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      projectorCandidates: [expect.objectContaining({
        id: mockProjector.id,
        lifecycleStatus: 'failed',
        matchStatus: 'failed',
        matchReason: 'download_http_error',
        localPath: expect.stringMatching(/^model-mmproj-model-main-[a-z0-9]+\.gguf$/),
        resumeData: undefined,
        downloadProgress: undefined,
      })],
    }));
  });

  it('preserves the verified base checkpoint when projector verification fails', async () => {
    let modelDownloaded = false;
    let projectorDownloaded = false;
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockImplementation(async (_artifact, localUri) => {
      if (localUri.includes('mmproj')) {
        throw new AppError('download_verification_failed', 'Projector checksum mismatch');
      }

      return { integrity: 'sha256', sha256: VALID_SHA256, sizeBytes: 1000 };
    });
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(() => ({ resumeData: 'resume-data' })),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }
      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, sha256: VALID_SHA256, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({ sha256: VALID_SHA256, projectorCandidates: [mockProjector] })).rejects.toMatchObject({
        code: 'download_verification_failed',
      });

      expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        localPath: expect.stringMatching(/^model-main-[a-z0-9]+\.gguf$/),
        downloadProgress: 1,
        metadataTrust: 'verified_local',
        resumeData: undefined,
        downloadErrorAt: undefined,
        downloadErrorCode: undefined,
        downloadErrorMessage: undefined,
        projectorCandidates: [expect.objectContaining({
          id: mockProjector.id,
          lifecycleStatus: 'failed',
          matchStatus: 'failed',
          matchReason: 'download_verification_failed',
          resumeData: undefined,
        })],
      }));
      const completedModel = mockedRegistry.updateModel.mock.calls[mockedRegistry.updateModel.mock.calls.length - 1]?.[0];
      expect(completedModel?.downloadIntegrity).toEqual(expect.objectContaining({
        kind: 'sha256',
        sha256: VALID_SHA256,
        sizeBytes: 1000,
      }));
      expect(useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)).toBeUndefined();
      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('logs sanitized projector verification failures without downloaded paths', async () => {
    let modelDownloaded = false;
    let projectorDownloaded = false;
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockImplementation(async (artifact, localUri) => {
      if (artifact.id === mockProjector.id) {
        throw new AppError('download_verification_failed', 'Projector checksum mismatch', {
          details: {
            modelId: mockModel.id,
            projectorId: mockProjector.id,
            reason: 'invalid_magic',
            localUri,
            uri: localUri,
          },
        });
      }

      return { integrity: 'sha256', sha256: VALID_SHA256, sizeBytes: 1000 };
    });
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(() => ({ resumeData: 'resume-data' })),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }
      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, sha256: VALID_SHA256, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({ sha256: VALID_SHA256, projectorCandidates: [mockProjector] })).rejects.toMatchObject({
        code: 'download_verification_failed',
        message: 'Projector checksum mismatch',
      });

      const errorCalls = stringifyMockCalls(errorSpy);
      expect(errorCalls).toContain('download_verification_failed');
      expect(errorCalls).toContain('Projector checksum mismatch');
      expect(errorCalls).toContain(mockModel.id);
      expect(errorCalls).toContain('invalid_magic');
      expect(errorCalls).not.toContain(mockProjector.id);
      expectNoSensitiveDownloadPathLeak(errorCalls);
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('preserves base progress and integrity when projector verification reports a missing file', async () => {
    let modelDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url !== mockProjector.downloadUrl && !localUri.includes('mmproj')) {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(() => ({ resumeData: 'resume-data' })),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }
      if (uri.includes('mmproj')) {
        return { exists: false, size: 0 };
      }
      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).rejects.toMatchObject({
      code: 'download_file_missing',
    });

    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      downloadIntegrity: expect.objectContaining({ kind: 'size', sizeBytes: 1000 }),
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      projectorCandidates: [expect.objectContaining({
        id: mockProjector.id,
        lifecycleStatus: 'failed',
        matchStatus: 'failed',
        matchReason: 'download_file_missing',
        resumeData: undefined,
      })],
    }));
    expect(useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)).toBeUndefined();
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('retries failed selected projector artifacts with a fresh companion download', async () => {
    const failedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: 'download_http_error',
    };
    let modelDownloaded = false;
    let projectorDownloaded = false;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        } else {
          modelDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return modelDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [failedProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ projectorCandidates: [failedProjector] })).resolves.toBeUndefined();

    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        projectorCandidates: [
          expect.objectContaining({
            id: mockProjector.id,
            lifecycleStatus: 'downloaded',
            matchStatus: 'matched',
            matchReason: 'single_projector_candidate',
          }),
        ],
      }),
    );
  });

  it('retries a failed projector from a verified base-model checkpoint without redownloading the base model', async () => {
    const failedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: 'download_http_error',
    };
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string) => ({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
      url,
    }));
    (RNFS.hash as jest.Mock).mockResolvedValue(OTHER_VALID_SHA256);
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        metadataTrust: 'verified_local',
        downloadIntegrity: {
          kind: 'sha256',
          sha256: OTHER_VALID_SHA256,
          sizeBytes: 1000,
          checkedAt: 123,
        },
        sha256: OTHER_VALID_SHA256,
        gguf: {
          totalBytes: 1000,
          contextLengthTokens: 4096,
          architecture: 'llama',
        },
        maxContextTokens: 4096,
        hasVerifiedContextWindow: true,
        projectorCandidates: [failedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      localPath: 'model.gguf',
      downloadProgress: 1,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sha256: OTHER_VALID_SHA256,
        sizeBytes: 1000,
        checkedAt: 123,
      },
      sha256: OTHER_VALID_SHA256,
      gguf: {
        totalBytes: 1000,
        contextLengthTokens: 4096,
        architecture: 'llama',
      },
      maxContextTokens: 4096,
      hasVerifiedContextWindow: true,
      projectorCandidates: [failedProjector],
    })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      mockProjector.downloadUrl,
      expect.stringMatching(/^test-dir\/models\/model-mmproj-model-main-[a-z0-9]+\.gguf$/),
      {},
      expect.any(Function),
      undefined,
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      metadataTrust: 'verified_local',
      downloadIntegrity: expect.objectContaining({
        kind: 'sha256',
        sha256: OTHER_VALID_SHA256,
        sizeBytes: 1000,
      }),
      sha256: OTHER_VALID_SHA256,
      gguf: expect.objectContaining({
        totalBytes: 1000,
        contextLengthTokens: 4096,
        architecture: 'llama',
      }),
      maxContextTokens: 4096,
      hasVerifiedContextWindow: true,
    }));
  });

  it('pauses projector downloads with projector-scoped resume data', async () => {
    const pauseAsync = jest.fn().mockResolvedValue({
      url: mockProjector.downloadUrl,
      fileUri: 'test-dir/models/mmproj-model.gguf',
      options: { headers: { Authorization: 'Bearer projector-secret' } },
      resumeData: 'projector-resume-data',
    });
    const downloadingProjector = { ...mockProjector, lifecycleStatus: 'downloading' as const };
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 51,
      resumable: { pauseAsync },
      activeArtifact: 'projector',
      activeProjectorId: mockProjector.id,
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        projectorCandidates: [downloadingProjector],
        lifecycleStatus: LifecycleStatus.DOWNLOADING,
      }],
      activeDownloadId: mockModel.id,
    });

    await modelDownloadManager.pauseDownload(mockModel.id);

    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.PAUSED);
    expect(entry?.resumeData).toBeUndefined();
    expect(entry?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: mockProjector.id,
      lifecycleStatus: 'paused',
      resumeData: 'projector-resume-data',
    }));
    expect(entry?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: mockProjector.id,
        kind: 'multimodal_projector',
        installState: 'downloading',
        resumeData: 'projector-resume-data',
      }),
    ]));
    expect(JSON.stringify(entry)).not.toMatch(/Authorization|Bearer/);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('ignores pause requests while verifying a completed projector download', async () => {
    const projectorPauseAsync = jest.fn().mockResolvedValue({ resumeData: 'stale-projector-resume' });
    let projectorDownloaded = false;
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockImplementation(async (artifact) => {
      if (artifact.id === mockProjector.id) {
        const entryBeforePause = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
        expect(entryBeforePause?.lifecycleStatus).toBe(LifecycleStatus.VERIFYING);
        expect(entryBeforePause?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
          id: mockProjector.id,
          downloadProgress: 1,
        }));
        expect(entryBeforePause?.projectorCandidates?.[0]).not.toHaveProperty('resumeData');

        await modelDownloadManager.pauseDownload(mockModel.id);

        const entryAfterPause = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
        expect(entryAfterPause?.lifecycleStatus).toBe(LifecycleStatus.VERIFYING);
        expect(entryAfterPause?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
          id: mockProjector.id,
        }));
        expect(entryAfterPause?.projectorCandidates?.[0]).not.toHaveProperty('resumeData');
        expect(useDownloadStore.getState().activeDownloadId).toBe(mockModel.id);

        return { integrity: 'size', sizeBytes: 1000 };
      }

      return { integrity: 'size', sizeBytes: 1000 };
    });

    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((url: string, localUri: string) => ({
      downloadAsync: jest.fn().mockImplementation(async () => {
        if (url === mockProjector.downloadUrl || localUri.includes('mmproj')) {
          projectorDownloaded = true;
        }
        return { status: 200 };
      }),
      pauseAsync: url === mockProjector.downloadUrl ? projectorPauseAsync : jest.fn().mockResolvedValue(undefined),
      savable: () => ({ resumeData: 'stale-projector-resume' }),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.startsWith('test-dir/models/')) {
        return { exists: true, size: 1000 };
      }

      if (uri.includes('mmproj')) {
        return projectorDownloaded ? { exists: true, size: 1000 } : { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, projectorCandidates: [mockProjector], lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({ projectorCandidates: [mockProjector] })).resolves.toBeUndefined();

      expect(projectorPauseAsync).not.toHaveBeenCalled();
      expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);
      expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
        projectorCandidates: [
          expect.objectContaining({
            id: mockProjector.id,
            lifecycleStatus: 'downloaded',
          }),
        ],
      }));
      const completedProjector = (mockedRegistry.updateModel as jest.Mock).mock.calls.at(-1)?.[0]?.projectorCandidates?.[0];
      expect(completedProjector?.resumeData).toBeUndefined();
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('pauses model downloads with only opaque resume data from savable snapshots', async () => {
    const pauseAsync = jest.fn().mockResolvedValue({
      url: 'https://huggingface.co/org/model/resolve/main/model.gguf',
      fileUri: 'test-dir/models/model.gguf',
      options: { headers: { Authorization: 'Bearer pause-secret' } },
      resumeData: 'model-resume-data',
    });
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 52,
      resumable: { pauseAsync },
      activeArtifact: 'model',
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.DOWNLOADING }],
      activeDownloadId: mockModel.id,
    });

    await modelDownloadManager.pauseDownload(mockModel.id);

    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.PAUSED);
    expect(entry?.resumeData).toBe('model-resume-data');
    expect(JSON.stringify(entry)).not.toMatch(/Authorization|Bearer/);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('pauses the queued selected projector when pausing during the base model download', async () => {
    const pauseAsync = jest.fn().mockResolvedValue({ resumeData: 'model-resume-data' });
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken: 54,
      resumable: { pauseAsync },
      activeArtifact: 'model',
      stopReason: null,
    };
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        lifecycleStatus: LifecycleStatus.DOWNLOADING,
        projectorCandidates: [{
          ...mockProjector,
          lifecycleStatus: 'queued',
        }],
      }],
      activeDownloadId: mockModel.id,
    });

    await modelDownloadManager.pauseDownload(mockModel.id);

    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.PAUSED,
      resumeData: 'model-resume-data',
    }));
    expect(entry?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: mockProjector.id,
      lifecycleStatus: 'paused',
    }));
    expect(entry?.projectorCandidates?.[0]?.resumeData).toBeUndefined();
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('passes projector-scoped resume data back to the projector resumable', async () => {
    const pausedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'paused',
      resumeData: JSON.stringify({ resumeData: 'projector-inner-resume' }),
    };
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [pausedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      localPath: 'model.gguf',
      downloadProgress: 1,
      projectorCandidates: [pausedProjector],
    })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      mockProjector.downloadUrl,
      expect.stringMatching(/^test-dir\/models\/model-mmproj-model-main-[a-z0-9]+\.gguf$/),
      {},
      expect.any(Function),
      'projector-inner-resume',
    );
  });

  it('reuses a completed unknown-size base checkpoint when retrying a paused projector', async () => {
    const pausedProjector: ProjectorArtifact = {
      ...mockProjector,
      lifecycleStatus: 'paused',
      localPath: 'mmproj-partial.gguf',
      resumeData: JSON.stringify({ resumeData: 'projector-inner-resume' }),
    };
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri === 'test-dir/models/mmproj-partial.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });
    useDownloadStore.setState({
      queue: [{
        ...mockModel,
        size: null,
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [pausedProjector],
        lifecycleStatus: LifecycleStatus.QUEUED,
      }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      size: null,
      localPath: 'model.gguf',
      downloadProgress: 1,
      projectorCandidates: [pausedProjector],
    })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      mockProjector.downloadUrl,
      'test-dir/models/mmproj-partial.gguf',
      {},
      expect.any(Function),
      'projector-inner-resume',
    );
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalledWith(
      mockModel.downloadUrl,
      expect.any(String),
      expect.anything(),
      expect.any(Function),
      expect.anything(),
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      localPath: 'model.gguf',
      downloadProgress: 1,
      downloadIntegrity: undefined,
      size: 1000,
      projectorCandidates: [
        expect.objectContaining({
          id: mockProjector.id,
          localPath: 'mmproj-partial.gguf',
          lifecycleStatus: 'downloaded',
        }),
      ],
    }));
  });

  it.each(['available', 'queued', 'downloading', 'failed'] as const)(
    'does not pass stale projector resume data for non-paused %s projector downloads',
    async (lifecycleStatus) => {
      const projectorWithStaleResumeData: ProjectorArtifact = {
        ...mockProjector,
        lifecycleStatus,
        resumeData: JSON.stringify({ resumeData: `stale-${lifecycleStatus}-projector-resume` }),
      };
      (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
        downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        savable: jest.fn(),
      }));
      useDownloadStore.setState({
        queue: [{
          ...mockModel,
          localPath: 'model.gguf',
          downloadProgress: 1,
          projectorCandidates: [projectorWithStaleResumeData],
          lifecycleStatus: LifecycleStatus.QUEUED,
        }],
        activeDownloadId: mockModel.id,
      });

      await expect(runDownloadModel({
        localPath: 'model.gguf',
        downloadProgress: 1,
        projectorCandidates: [projectorWithStaleResumeData],
      })).resolves.toBeUndefined();

      expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
        mockProjector.downloadUrl,
        expect.any(String),
        {},
        expect.any(Function),
        undefined,
      );
    },
  );

  it('marks setup failures as failed instead of leaving queued downloads in a retry loop', async () => {
    const jobToken = 99;
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken,
      resumable: null,
      stopReason: null,
    };
    (modelDownloadManager as any).isProcessing = true;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementationOnce(() => {
      throw new Error('cannot create download');
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect((modelDownloadManager as any).runDownloadJob(mockModel, jobToken)).resolves.toBeUndefined();

    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.downloadErrorCode).toBe('action_failed');
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect((modelDownloadManager as any).activeJob).toBeNull();
    expect((modelDownloadManager as any).isProcessing).toBe(false);
  });

  it('does not overwrite failed resume data in the runDownloadJob safety net', async () => {
    const jobToken = 100;
    (modelDownloadManager as any).activeJob = {
      modelId: mockModel.id,
      jobToken,
      resumable: null,
      stopReason: null,
    };
    (modelDownloadManager as any).isProcessing = true;
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValueOnce({
      downloadAsync: jest.fn().mockRejectedValue(new Error('network error')),
      savable: () => ({ resumeData: 'resume-data' }),
    });
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect((modelDownloadManager as any).runDownloadJob(mockModel, jobToken)).resolves.toBeUndefined();

    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.downloadErrorCode).toBe('action_failed');
    expect(entry?.resumeData).toEqual(expect.stringContaining('resume-data'));
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it('does not complete when the verified file disappears before the final registry write', async () => {
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockResolvedValue({
      integrity: 'size',
      sizeBytes: 1000,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false, size: 0 });
    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    try {
      await expect(runDownloadModel({})).rejects.toThrow('Downloaded file disappeared before completion');

      expect(mockedRegistry.updateModel).not.toHaveBeenCalled();
      const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
      expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
      expect(entry?.downloadErrorCode).toBe('download_file_missing');
      expect(entry?.downloadProgress).toBe(0);
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('rejects downloads when the GGUF filename still needs a tree probe', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });

    await expect(
      runDownloadModel({ requiresTreeProbe: true, resolvedFileName: undefined }),
    ).rejects.toThrow('MODEL_METADATA_UNAVAILABLE');

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });

  it('allows valid unknown-size GGUF downloads but does not mark them verified locally', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });

    await expect(
      runDownloadModel({ size: null, allowUnknownSizeDownload: true }),
    ).resolves.toBeUndefined();

    expect(FileSystem.getFreeDiskStorageAsync).toHaveBeenCalled();
    expect(FileSystem.createDownloadResumable).toHaveBeenCalled();
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test/model',
        size: 1000,
        fitsInRam: true,
        allowUnknownSizeDownload: false,
        metadataTrust: undefined,
        downloadIntegrity: undefined,
        sha256: undefined,
      }),
    );
  });

  it('marks the downloaded model based on the device total-memory budget (not the live snapshot)', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 8 * 1024 * 1024 * 1024,
      availableBytes: 1_500,
      freeBytes: 900,
      usedBytes: 0,
      appUsedBytes: 0,
      lowMemory: false,
      thresholdBytes: 0,
    });

    await expect(
      runDownloadModel({ size: 1_000 }),
    ).resolves.toBeUndefined();

    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test/model',
        size: 1_000,
        fitsInRam: true,
        metadataTrust: undefined,
        downloadIntegrity: expect.objectContaining({
          kind: 'size',
          sizeBytes: 1_000,
        }),
      }),
    );
  });

  it('does not preserve stale verified_local trust for no-sha size-only downloads', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });

    await expect(
      runDownloadModel({
        size: 1_000,
        metadataTrust: 'verified_local',
        gguf: { architecture: 'llama', totalBytes: 1_000 },
        fitsInRam: false,
        memoryFitDecision: 'likely_oom',
        memoryFitConfidence: 'high',
      }),
    ).resolves.toBeUndefined();

    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test/model',
        metadataTrust: undefined,
        gguf: undefined,
        downloadIntegrity: expect.objectContaining({
          kind: 'size',
          sizeBytes: 1_000,
        }),
      }),
    );
  });

  it('attaches the bearer token when downloading gated Hugging Face models', async () => {
    (huggingFaceTokenService.getToken as jest.Mock).mockResolvedValue('hf_secret_token');

    await runDownloadModel({
      id: 'org/model',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
      accessState: ModelAccessState.AUTHORIZED,
      isGated: true,
    });

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      'https://huggingface.co/org/model/resolve/main/model.gguf',
      expect.any(String),
      {
        headers: {
          Authorization: 'Bearer hf_secret_token',
        },
      },
      expect.any(Function),
      undefined,
    );
  });

  it('does not send base Hugging Face auth headers to non-HF projector URLs', async () => {
    const nonHfProjector: ProjectorArtifact = {
      ...mockProjector,
      id: 'org/model::main::mmproj-model.gguf',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      downloadUrl: 'https://example.invalid/mmproj-model.gguf',
    };
    (huggingFaceTokenService.getToken as jest.Mock).mockResolvedValue('hf_secret_token');
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation(() => ({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      savable: jest.fn(),
    }));

    await runDownloadModel({
      id: 'org/model',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
      accessState: ModelAccessState.AUTHORIZED,
      isGated: true,
      projectorCandidates: [nonHfProjector],
    });

    expect(FileSystem.createDownloadResumable).toHaveBeenNthCalledWith(
      1,
      'https://huggingface.co/org/model/resolve/main/model.gguf',
      expect.any(String),
      {
        headers: {
          Authorization: 'Bearer hf_secret_token',
        },
      },
      expect.any(Function),
      undefined,
    );
    expect(FileSystem.createDownloadResumable).toHaveBeenNthCalledWith(
      2,
      nonHfProjector.downloadUrl,
      expect.any(String),
      {},
      expect.any(Function),
      undefined,
    );
    expect(huggingFaceTokenService.getToken).toHaveBeenCalledTimes(1);
  });

  it('reuses legacy partial download filenames when resuming queued downloads from older builds', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === 'test-dir/models/test_model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });

    await expect(
      runDownloadModel({ resumeData: 'resume-data' }),
    ).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      'http://example.com/model.gguf',
      'test-dir/models/test_model.gguf',
      {},
      expect.any(Function),
      'resume-data',
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: 'test_model.gguf',
      }),
    );
  });

  it('skips directory download candidates while preserving legacy partial resume', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (/^test-dir\/models\/model-main-[a-z0-9]+\.gguf$/.test(uri)) {
        return { exists: true, isDirectory: true };
      }

      if (uri === 'test-dir/models/test_model.gguf') {
        return { exists: true, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });

    try {
      await expect(
        runDownloadModel({ resumeData: 'resume-data' }),
      ).resolves.toBeUndefined();

      expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
        'http://example.com/model.gguf',
        'test-dir/models/test_model.gguf',
        {},
        expect.any(Function),
        'resume-data',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[ModelDownloadManager] Download candidate is a directory, skipping',
        expect.objectContaining({
          artifactKind: 'model',
          pathCategory: 'model_storage',
        }),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('model-main-');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reuses previous generated partial filenames with dotted repo labels', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (/^test-dir\/models\/Qwen2\.5-0\.5B-main-[a-z0-9]+\.gguf$/.test(uri)) {
        return { exists: true, size: 1000 };
      }

      if (uri.startsWith('test-dir/models/')) {
        return { exists: false, size: 0 };
      }

      return { exists: true, size: 1000 };
    });

    await expect(
      runDownloadModel({
        id: 'Qwen/Qwen2.5-0.5B',
        name: 'Qwen2.5 0.5B',
        resolvedFileName: 'weights/model-Q4_K_M.GGUF',
        resumeData: 'resume-data',
      }),
    ).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      'http://example.com/model.gguf',
      expect.stringMatching(/^test-dir\/models\/Qwen2\.5-0\.5B-main-[a-z0-9]+\.gguf$/),
      {},
      expect.any(Function),
      'resume-data',
    );
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: expect.stringMatching(/^Qwen2\.5-0\.5B-main-[a-z0-9]+\.gguf$/),
      }),
    );
  });

  it('keeps the background download task alive when Wi-Fi-only pauses a queued download in the background', async () => {
    const activeModel = {
      ...mockModel,
      id: 'test/active',
      name: 'Active model',
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
    };
    const queuedModel = {
      ...mockModel,
      id: 'test/queued',
      name: 'Queued model',
      lifecycleStatus: LifecycleStatus.QUEUED,
    };
    const pauseAsync = jest.fn().mockResolvedValue({ resumeData: 'resume-data' });
    const startBackgroundDownloadSpy = jest.spyOn(backgroundTaskService, 'startBackgroundDownload').mockResolvedValue(undefined);
    const stopBackgroundTaskSpy = jest.spyOn(backgroundTaskService, 'stopBackgroundTask');
    jest.spyOn(hardwareListenerService, 'getCurrentStatus').mockReturnValue({
      isLowMemory: false,
      networkType: 'cellular',
      isConnected: true,
      thermalState: 'nominal',
    });

    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'background',
    });

    (modelDownloadManager as any).activeJob = {
      modelId: activeModel.id,
      jobToken: 1,
      resumable: {
        pauseAsync,
      },
    };
    useDownloadStore.setState({
      queue: [activeModel, queuedModel],
      activeDownloadId: activeModel.id,
    });

    await (modelDownloadManager as any).handleHardwareStatusChange({
      isLowMemory: false,
      networkType: 'cellular',
      isConnected: true,
      thermalState: 'nominal',
    });

    expect(pauseAsync).toHaveBeenCalled();
    expect(startBackgroundDownloadSpy).toHaveBeenCalledWith({ type: 'downloadPaused' });
    expect(stopBackgroundTaskSpy).not.toHaveBeenCalled();
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue.find((model) => model.id === activeModel.id)?.lifecycleStatus).toBe(LifecycleStatus.PAUSED);
  });

  it('does not override PAUSED when a paused download later errors', async () => {
    let rejectDownload: (error: unknown) => void = () => {};
    const downloadAsync = jest.fn().mockImplementation(() => new Promise((_, reject) => {
      rejectDownload = reject;
    }));
    const pauseAsync = jest.fn().mockResolvedValue({ resumeData: 'resume-data' });
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync,
      pauseAsync,
      savable: () => ({ resumeData: 'resume-data' }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    const downloadPromise = runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED });

    for (let i = 0; i < 10 && downloadAsync.mock.calls.length === 0; i++) {
      // Let the async pipeline advance until it hits downloadAsync()
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(downloadAsync).toHaveBeenCalled();

    await modelDownloadManager.pauseDownload(mockModel.id);

    rejectDownload(new Error('network error'));

    await expect(downloadPromise).resolves.toBeUndefined();

    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue.find((model) => model.id === mockModel.id)?.lifecycleStatus).toBe(LifecycleStatus.PAUSED);
  });

  it('does not mark a cancelled download as AVAILABLE when it errors after cancellation', async () => {
    let rejectDownload: (error: unknown) => void = () => {};
    const downloadAsync = jest.fn().mockImplementation(() => new Promise((_, reject) => {
      rejectDownload = reject;
    }));
    const pauseAsync = jest.fn().mockResolvedValue({ resumeData: 'resume-data' });
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync,
      pauseAsync,
      savable: () => ({ resumeData: 'resume-data' }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    const downloadPromise = runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED });

    for (let i = 0; i < 10 && downloadAsync.mock.calls.length === 0; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(downloadAsync).toHaveBeenCalled();

    await modelDownloadManager.cancelDownload(mockModel.id);

    rejectDownload(new Error('network error'));

    await expect(downloadPromise).resolves.toBeUndefined();

    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue.some((model) => model.id === mockModel.id)).toBe(false);
  });

  it('marks downloads as PAUSED when downloadAsync resolves undefined without a stop reason', async () => {
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(undefined),
      savable: () => ({
        url: 'https://huggingface.co/org/model/resolve/main/model.gguf',
        fileUri: 'test-dir/models/model.gguf',
        options: { headers: { Authorization: 'Bearer undefined-secret' } },
        resumeData: 'resume-data',
      }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).resolves.toBeUndefined();

    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.PAUSED);
    expect(entry?.resumeData).toBe('resume-data');
    expect(JSON.stringify(entry)).not.toMatch(/Authorization|Bearer/);
  });

  it('does not let resumable.savable() errors break cleanup on download failure', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
        downloadAsync: jest.fn().mockRejectedValue(new Error('network error')),
        savable: () => {
          throw new Error('savable failed');
        },
      });

      useDownloadStore.setState({
        queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
        activeDownloadId: mockModel.id,
      });

      await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).rejects.toThrow('network error');

      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
      expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
      expect(entry?.downloadErrorCode).toBe('action_failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('extracts resume data from circular savable snapshots on download failure', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const circular: any = { resumeData: 'resume-data' };
      circular.self = circular;

      (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
        downloadAsync: jest.fn().mockRejectedValue(new Error('network error')),
        savable: () => circular,
      });

      useDownloadStore.setState({
        queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
        activeDownloadId: mockModel.id,
      });

      await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).rejects.toThrow('network error');

      expect(useDownloadStore.getState().activeDownloadId).toBeNull();
      const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
      expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
      expect(entry?.downloadErrorCode).toBe('action_failed');
      expect(entry?.resumeData).toBe('resume-data');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('persists resumeData when download fails and a resumable snapshot is available', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
        downloadAsync: jest.fn().mockRejectedValue(new Error('network error')),
        savable: () => ({
          url: 'https://huggingface.co/org/model/resolve/main/model.gguf',
          fileUri: 'test-dir/models/model.gguf',
          options: { headers: { Authorization: 'Bearer error-secret' } },
          resumeData: 'resume-data',
        }),
      });

      useDownloadStore.setState({
        queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
        activeDownloadId: mockModel.id,
      });

      await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).rejects.toThrow('network error');

      const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
      expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
      expect(entry?.downloadErrorCode).toBe('action_failed');
      expect(entry?.resumeData).toBe('resume-data');
      expect(JSON.stringify(entry)).not.toMatch(/Authorization|Bearer/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('extracts nested resumeData from persisted pause snapshots', async () => {
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ resumeData: JSON.stringify({ resumeData: 'inner-resume' }) })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      'http://example.com/model.gguf',
      expect.any(String),
      {},
      expect.any(Function),
      'inner-resume',
    );
  });

  it('omits Hugging Face auth headers when token is missing', async () => {
    (huggingFaceTokenService.getToken as jest.Mock).mockResolvedValueOnce(null);

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({
      id: 'org/model',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
      accessState: ModelAccessState.AUTHORIZED,
      isGated: true,
    })).resolves.toBeUndefined();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      'https://huggingface.co/org/model/resolve/main/model.gguf',
      expect.any(String),
      {},
      expect.any(Function),
      undefined,
    );
  });

  it('sends storageFull error notification in background when download reports disk space low', async () => {
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'background',
    });

    const sendErrorSpy = jest.spyOn(notificationService, 'sendErrorNotification').mockResolvedValue(undefined as any);

    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockRejectedValue(new AppError('download_disk_space_low', 'DISK_SPACE_LOW')),
      savable: () => ({ resumeData: 'resume-data' }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).rejects.toMatchObject({
      name: 'AppError',
      code: 'download_disk_space_low',
    });

    expect(sendErrorSpy).toHaveBeenCalledWith({ modelName: 'model', reason: 'storageFull' });
    sendErrorSpy.mockRestore();
  });

  it('sends verificationFailed error notification in background when checksum fails', async () => {
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'background',
    });

    const sendErrorSpy = jest.spyOn(notificationService, 'sendErrorNotification').mockResolvedValue(undefined as any);
    const verifySpy = jest.spyOn(modelDownloadManager, 'verifyChecksum').mockRejectedValue(
      new AppError('download_verification_failed', 'Checksum mismatch'),
    );

    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
      savable: () => ({ resumeData: 'resume-data' }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED, downloadProgress: 0.8 }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).rejects.toMatchObject({
      name: 'AppError',
      code: 'download_verification_failed',
    });

    expect(sendErrorSpy).toHaveBeenCalledWith({ modelName: 'model', reason: 'verificationFailed' });
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
    expect(entry?.downloadErrorCode).toBe('download_verification_failed');
    expect(entry?.resumeData).toBeUndefined();
    expect(entry?.downloadProgress).toBe(0);
    sendErrorSpy.mockRestore();
    verifySpy.mockRestore();
  });

  it('sends connectionLost error notification in background on HTTP failures', async () => {
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'background',
    });

    const sendErrorSpy = jest.spyOn(notificationService, 'sendErrorNotification').mockResolvedValue(undefined as any);

    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue({ status: 500 }),
      savable: () => ({ resumeData: 'resume-data' }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).rejects.toMatchObject({
      name: 'AppError',
      code: 'download_http_error',
    });
    expect(sendErrorSpy).toHaveBeenCalledWith({ modelName: 'model', reason: 'connectionLost' });
    sendErrorSpy.mockRestore();
  });
});
