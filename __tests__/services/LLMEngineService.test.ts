import * as llamaRn from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getModelLoadParametersForModel, updateSettings } from '../../src/services/SettingsStore';
import { EngineStatus, LifecycleStatus } from '../../src/types/models';
import { ESTIMATED_CONTEXT_BYTES_PER_TOKEN } from '../../src/utils/contextWindow';

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

  it('retries strict alternation failures with normalized chat history', async () => {
    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    completionMock
      .mockRejectedValueOnce(new Error('Conversation roles must alternate user/assistant'))
      .mockResolvedValueOnce({ text: 'Recovered reply' });

    await llmEngineService.load('test/model', { forceReload: true });

    await expect(llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'system', content: 'Conversation summary:\nEarlier context.' },
        { role: 'assistant', content: 'Leading assistant draft.' },
        { role: 'user', content: 'First user question.' },
        { role: 'assistant', content: 'First assistant reply.' },
        { role: 'assistant', content: 'Extra assistant details.' },
        { role: 'user', content: 'Latest user question.' },
      ],
      params: {
        temperature: 0.25,
        n_predict: 64,
      },
    })).resolves.toEqual({ text: 'Recovered reply' });

    expect(completionMock).toHaveBeenCalledTimes(2);
    expect(completionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: 'Be concise.\n\nConversation summary:\nEarlier context.\n\nFirst user question.',
          },
          {
            role: 'assistant',
            content: 'First assistant reply.\n\nExtra assistant details.',
          },
          {
            role: 'user',
            content: 'Latest user question.',
          },
        ],
        temperature: 0.25,
        n_predict: 64,
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

  it('loads contexts larger than 8192 when the model supports them', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      maxContextTokens: 32768,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 16384,
      gpuLayers: 0,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_ctx: 16384,
        n_gpu_layers: 0,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBe(16384);
  });

  it('clamps requested context size to the safe device ceiling before loading', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const safeContextSize = 4096;
    const modelSizeBytes = Math.floor(
      ((totalMemoryBytes * 0.8) - safeContextSize * ESTIMATED_CONTEXT_BYTES_PER_TOKEN) / 1.2,
    );

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelSizeBytes,
      maxContextTokens: 8192,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 8192,
      gpuLayers: 0,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_ctx: safeContextSize,
        n_gpu_layers: 0,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBe(safeContextSize);
  });
});
