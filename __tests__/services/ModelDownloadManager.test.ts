import { modelDownloadManager } from '../../src/services/ModelDownloadManager';
import { useDownloadStore } from '../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, ModelMetadata } from '../../src/types/models';
import * as FileSystem from 'expo-file-system/legacy';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import { registry } from '../../src/services/LocalStorageRegistry';

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
    (huggingFaceTokenService.getToken as jest.Mock).mockResolvedValue(null);
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
    (modelDownloadManager as any).isProcessing = false;
    await new Promise(r => setTimeout(r, 10)); // Yield tick
  });

  it('should add model to queue and start download', async () => {
    useDownloadStore.getState().addToQueue(mockModel);
    await new Promise(r => setTimeout(r, 0));

    expect(FileSystem.createDownloadResumable).toHaveBeenCalled();
  });

  it('verifies a downloaded file when the size matches', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });

    await expect(modelDownloadManager.verifyChecksum(mockModel, 'test-dir/model.gguf')).resolves.toBeUndefined();
  });

  it('preserves a real checksum when size validation succeeds', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1000 });

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, sha256: 'tree-sha' }, 'test-dir/model.gguf'),
    ).resolves.toBe('tree-sha');
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

  it('skips size mismatch verification when the expected size is unknown', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 42 });

    await expect(
      modelDownloadManager.verifyChecksum({ ...mockModel, size: null }, 'test-dir/model.gguf'),
    ).resolves.toBeUndefined();
  });

  it('rejects downloads that still have unknown size at preflight time', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });

    await expect(
      (modelDownloadManager as any).downloadModel({ ...mockModel, size: null }),
    ).rejects.toThrow('MODEL_SIZE_UNKNOWN');

    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });

  it('allows unknown-size downloads after an explicit warning confirmation', async () => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });

    await expect(
      (modelDownloadManager as any).downloadModel({
        ...mockModel,
        size: null,
        allowUnknownSizeDownload: true,
      }),
    ).resolves.toBeUndefined();

    expect(FileSystem.getFreeDiskStorageAsync).toHaveBeenCalled();
    expect(FileSystem.createDownloadResumable).toHaveBeenCalled();
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test/model',
        size: null,
        sha256: undefined,
      }),
    );
  });

  it('attaches the bearer token when downloading gated Hugging Face models', async () => {
    (huggingFaceTokenService.getToken as jest.Mock).mockResolvedValue('hf_secret_token');

    await (modelDownloadManager as any).downloadModel({
      ...mockModel,
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
});
