import { modelDownloadManager } from '../../src/services/ModelDownloadManager';
import { useDownloadStore } from '../../src/store/downloadStore';
import { LifecycleStatus, ModelMetadata } from '../../src/types/models';
import * as FileSystem from 'expo-file-system/legacy';

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

const mockModel: ModelMetadata = {
  id: 'test/model',
  name: 'model',
  author: 'test',
  size: 1000,
  downloadUrl: 'http://example.com/model.gguf',
  fitsInRam: true,
  lifecycleStatus: LifecycleStatus.AVAILABLE,
  downloadProgress: 0,
};

describe('ModelDownloadManager Basic', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    useDownloadStore.setState({ queue: [], activeModelId: null });
    (modelDownloadManager as any).isProcessing = false;
    await new Promise(r => setTimeout(r, 10)); // Yield tick
  });

  it('should add model to queue and start download', async () => {
    useDownloadStore.getState().addToQueue(mockModel);
    await (modelDownloadManager as any).processQueue();

    expect(FileSystem.createDownloadResumable).toHaveBeenCalled();
  });
});
