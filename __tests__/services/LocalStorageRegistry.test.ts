import { registry } from '../../src/services/LocalStorageRegistry';
import { LifecycleStatus, ModelMetadata } from '../../src/types/models';
import * as FileSystem from 'expo-file-system/legacy';

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  documentDirectory: 'test-dir/',
}));

jest.mock('../../src/services/storage', () => ({
  createStorage: jest.fn().mockReturnValue({
    getString: jest.fn(),
    set: jest.fn(),
  }),
}));

const mockModel: ModelMetadata = {
  id: 'test/model',
  name: 'model',
  author: 'test',
  size: 1000,
  downloadUrl: 'http://example.com/model.gguf',
  localPath: 'model.gguf',
  fitsInRam: true,
  lifecycleStatus: LifecycleStatus.DOWNLOADED,
  downloadProgress: 1,
};

describe('LocalStorageRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should remove model and delete file', async () => {
    // Mock getModels to return our model
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([mockModel]);
    (registry.getModel as jest.Mock) = jest.fn().mockReturnValue(mockModel);
    (registry.saveModels as jest.Mock) = jest.fn();

    await registry.removeModel(mockModel.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalled();
    expect(registry.saveModels).toHaveBeenCalledWith([]);
  });

  it('should validate registry and reset status if file is missing', async () => {
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([mockModel]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });

    await registry.validateRegistry();

    expect(registry.saveModels).toHaveBeenCalled();
    const updatedModels = (registry.saveModels as jest.Mock).mock.calls[0][0];
    expect(updatedModels[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(updatedModels[0].localPath).toBeUndefined();
  });
});
