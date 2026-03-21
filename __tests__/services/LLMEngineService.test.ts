import * as llamaRn from 'llama.rn';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getModelLoadParametersForModel, updateSettings } from '../../src/services/SettingsStore';
import { EngineStatus, LifecycleStatus } from '../../src/types/models';

jest.mock('llama.rn', () => {
  const completion = jest.fn();
  return {
    initLlama: jest.fn().mockResolvedValue({
      completion,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
    }),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
    __completionMock: completion,
  };
});

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getModelLoadParametersForModel: jest.fn().mockReturnValue({
    contextSize: 2048,
    gpuLayers: null,
  }),
  updateSettings: jest.fn(),
}));

describe('LLMEngineService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (registry.getModel as jest.Mock) = jest.fn().mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock.mockResolvedValue({ text: 'Hello back' });
  });

  it('forwards structured messages to llama.rn completion', async () => {
    await llmEngineService.load('test/model');

    expect(llmEngineService.getState().status).toBe(EngineStatus.READY);
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: 'test/model' });

    await llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
      params: {
        temperature: 0.4,
        top_p: 0.8,
        n_predict: 128,
      },
    });

    expect(llamaRn.initLlama).toHaveBeenCalled();
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.4,
        top_p: 0.8,
        n_predict: 128,
      }),
      expect.any(Function),
    );
  });

  it('passes frozen thread params through to completion even when they differ from defaults', async () => {
    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Frozen system prompt.' },
        { role: 'user', content: 'Use thread snapshot params.' },
        { role: 'assistant', content: 'Prior answer.' },
      ],
      params: {
        temperature: 1.1,
        top_p: 0.55,
        n_predict: 333,
      },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'Frozen system prompt.' },
          { role: 'user', content: 'Use thread snapshot params.' },
          { role: 'assistant', content: 'Prior answer.' },
        ],
        temperature: 1.1,
        top_p: 0.55,
        n_predict: 333,
      }),
      expect.any(Function),
    );
  });

  it('loads the model with saved context and gpu preferences', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: 4096,
        n_gpu_layers: 12,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBe(4096);
    expect(llmEngineService.getLoadedGpuLayers()).toBe(12);
  });
});
