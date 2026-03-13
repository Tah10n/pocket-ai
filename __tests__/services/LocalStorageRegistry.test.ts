import RNFS from 'react-native-fs';
import { localStorageRegistry, storage } from '../../src/services/LocalStorageRegistry';

describe('LocalStorageRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (storage as any).clearAll?.();
    storage.remove('downloaded_models_registry');
    storage.remove('active_model_id');
  });

  it('resets corrupted downloaded models payload', () => {
    storage.set('downloaded_models_registry', '{');
    expect(localStorageRegistry.getDownloadedModels()).toEqual([]);
    expect(storage.getString('downloaded_models_registry')).toBeUndefined();
  });

  it('sets and clears active model id', () => {
    localStorageRegistry.setActiveModelId('m1');
    expect(localStorageRegistry.getActiveModelId()).toBe('m1');
    localStorageRegistry.setActiveModelId(null);
    expect(localStorageRegistry.getActiveModelId()).toBeNull();
  });

  it('clears active model id when removing that model', async () => {
    const model = {
      id: 'repo/model',
      name: 'Model',
      parameters: '7B',
      contextWindow: 2048,
      sizeBytes: 123,
      downloadUrl: 'https://example.com/model.gguf',
    };

    localStorageRegistry.addModel(model);
    localStorageRegistry.setActiveModelId(model.id);

    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);

    await localStorageRegistry.removeModel(model.id);

    expect(localStorageRegistry.getActiveModelId()).toBeNull();
  });

  it('notifies subscribers on changes', () => {
    const listener = jest.fn();
    const unsub = localStorageRegistry.subscribe(listener);

    localStorageRegistry.setActiveModelId('m2');
    localStorageRegistry.addModel({
      id: 'a',
      name: 'A',
      parameters: '3B',
      contextWindow: 2048,
      sizeBytes: 1,
      downloadUrl: 'https://example.com/a.gguf',
    });

    expect(listener).toHaveBeenCalled();
    unsub();
  });
});

