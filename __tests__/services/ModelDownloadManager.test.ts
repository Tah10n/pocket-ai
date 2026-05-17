import {
  getModelDownloadManager,
  resetModelDownloadManagerForPrivateStorageReset,
  stopModelDownloadManagerForPrivateStorageBlocked,
} from '../../src/services/ModelDownloadManager';
import { useDownloadStore } from '../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, ModelMetadata } from '../../src/types/models';
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

function runDownloadModel(overrides: Partial<ModelMetadata>) {
  const jobToken = 1;
  const model: ModelMetadata = {
    ...mockModel,
    ...overrides,
  };

  (modelDownloadManager as any).activeJob = { modelId: model.id, jobToken, resumable: null };
  return (modelDownloadManager as any).downloadModel(model, jobToken);
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
    (RNFS.hash as jest.Mock).mockResolvedValue('tree-sha');
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
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Partial download candidate for test/model is a directory'));
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
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('completed model file'));
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
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('tree-sha');

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: 'tree-sha' }, 'test-dir/model.gguf'),
    ).resolves.toEqual({
      integrity: 'sha256',
      sha256: 'tree-sha',
      sizeBytes: 1000,
    });
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('normalizes sha256 digests with a sha256 prefix', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('abc123');

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: 'sha256:ABC123' }, 'test-dir/model.gguf'),
    ).resolves.toEqual({
      integrity: 'sha256',
      sha256: 'abc123',
      sizeBytes: 1000,
    });
  });

  it('converts Expo file URIs into native filesystem paths before hashing', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('tree-sha');

    await expect(
      modelDownloadManager.verifyChecksum(
        { ...mockModel, sha256: 'tree-sha' },
        'file:///test-dir/model.gguf',
      ),
    ).resolves.toEqual({
      integrity: 'sha256',
      sha256: 'tree-sha',
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

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).rejects.toThrow(
      'Size mismatch',
    );
  });

  it('fails verification when the downloaded file hash does not match the upstream digest', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('other-sha');

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: 'tree-sha' }, 'test-dir/model.gguf'),
    ).rejects.toThrow('Checksum mismatch');

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/model.gguf', { idempotent: true });
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
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Download candidate for test/model is a directory'));
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
      savable: () => ({ resumeData: 'resume-data' }),
    });

    useDownloadStore.setState({
      queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
      activeDownloadId: mockModel.id,
    });

    await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).resolves.toBeUndefined();

    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.PAUSED);
    expect(entry?.resumeData).toEqual(expect.stringContaining('resume-data'));
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

  it('does not let JSON.stringify errors break cleanup on download failure', async () => {
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
      expect(entry?.resumeData).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('persists resumeData when download fails and a resumable snapshot is available', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
        downloadAsync: jest.fn().mockRejectedValue(new Error('network error')),
        savable: () => ({ resumeData: 'resume-data' }),
      });

      useDownloadStore.setState({
        queue: [{ ...mockModel, lifecycleStatus: LifecycleStatus.QUEUED }],
        activeDownloadId: mockModel.id,
      });

      await expect(runDownloadModel({ lifecycleStatus: LifecycleStatus.QUEUED })).rejects.toThrow('network error');

      const entry = useDownloadStore.getState().queue.find((model) => model.id === mockModel.id);
      expect(entry?.lifecycleStatus).toBe(LifecycleStatus.FAILED);
      expect(entry?.downloadErrorCode).toBe('action_failed');
      expect(entry?.resumeData).toEqual(expect.stringContaining('resume-data'));
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
