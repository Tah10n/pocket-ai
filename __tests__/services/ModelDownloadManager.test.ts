import { getModelDownloadManager } from '../../src/services/ModelDownloadManager';
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

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let modelDownloadManager: ReturnType<typeof getModelDownloadManager>;

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
  createDownloadResumable: jest.fn().mockReturnValue({ downloadAsync: jest.fn().mockResolvedValue({ status: 200 }) }),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(10 * 1024 * 1024 * 1024),
  documentDirectory: 'test-dir/',
  cacheDirectory: 'test-cache/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 1000 }),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  makeDirectoryAsync: jest.fn(),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
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
    (RNFS.hash as jest.Mock).mockResolvedValue('tree-sha');
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue(null);
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

  it('verifies a downloaded file when the size matches', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).resolves.toBeUndefined();
  });

  it('preserves a real checksum when size validation succeeds', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('tree-sha');

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: 'tree-sha' }, 'test-dir/model.gguf'),
    ).resolves.toBe('tree-sha');
  });

  it('normalizes sha256 digests with a sha256 prefix', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('abc123');

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: 'sha256:ABC123' }, 'test-dir/model.gguf'),
    ).resolves.toBe('abc123');
  });

  it('converts Expo file URIs into native filesystem paths before hashing', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('tree-sha');

    await expect(
      modelDownloadManager.verifyChecksum(
        { ...mockModel, sha256: 'tree-sha' },
        'file:///test-dir/model.gguf',
      ),
    ).resolves.toBe('tree-sha');

    expect(RNFS.hash).toHaveBeenCalledWith('/test-dir/model.gguf', 'sha256');
  });

  it('fails verification when the downloaded file is missing', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: false, size: 0 });

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).rejects.toThrow(
      'File does not exist after download',
    );
  });

  it('fails verification when the downloaded file size is too different', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: (mockModel.size ?? 0) + 2 * 1024 * 1024,
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

  it('skips size mismatch verification when the expected size is unknown', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 42 });

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, size: null }, 'test-dir/model.gguf'),
    ).resolves.toBeUndefined();
  });

  it('rejects downloads that still have unknown size at preflight time', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });

    await expect(
      runDownloadModel({ size: null }),
    ).rejects.toThrow('MODEL_SIZE_UNKNOWN');

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });

  it('rejects downloads when the GGUF filename still needs a tree probe', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });

    await expect(
      runDownloadModel({ requiresTreeProbe: true, resolvedFileName: undefined }),
    ).rejects.toThrow('MODEL_METADATA_UNAVAILABLE');

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });

  it('allows unknown-size downloads after an explicit warning confirmation', async () => {
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
});
