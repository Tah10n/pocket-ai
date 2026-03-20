import { llmEngineService } from '../../src/services/LLMEngineService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { updateSettings } from '../../src/services/SettingsStore';
import { EngineStatus, LifecycleStatus } from '../../src/types/models';
import * as FileSystem from 'expo-file-system';

jest.mock('llama.rn', () => ({
  initLlama: jest.fn().mockResolvedValue({ 
    completion: jest.fn(),
    stopCompletion: jest.fn()
  }),
  releaseAllLlama: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
}));

jest.mock('../../src/services/SettingsStore', () => ({
  updateSettings: jest.fn(),
}));

describe('LLMEngineService Integration', () => {
  const mockModelId = 'test/model';

  beforeEach(() => {
    jest.clearAllMocks();
    (registry.getModel as jest.Mock) = jest.fn().mockReturnValue({
      id: mockModelId,
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    (registry.getModels as jest.Mock) = jest.fn().mockReturnValue([]);
    (registry.saveModels as jest.Mock) = jest.fn();
    (registry.updateModel as jest.Mock) = jest.fn();
  });

  it('should unload model on low memory warning', async () => {
    // Load model first
    await llmEngineService.load(mockModelId);
    expect(llmEngineService.getState().status).toBe(EngineStatus.READY);
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: mockModelId });

    // Trigger memory warning
    hardwareListenerService['handleMemoryWarning']();

    // Wait for async unload
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify unloaded
    expect(llmEngineService.getState().status).toBe(EngineStatus.IDLE);
    expect(llmEngineService.getState().activeModelId).toBeUndefined();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: null });
  });
});
