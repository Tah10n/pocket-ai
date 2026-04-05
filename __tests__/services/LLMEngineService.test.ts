import * as llamaRn from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getModelLoadParametersForModel, updateSettings } from '../../src/services/SettingsStore';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';
import { EngineStatus, LifecycleStatus } from '../../src/types/models';

jest.mock('llama.rn', () => {
  const completion = jest.fn();
  const removeNativeLogListener = jest.fn();
  return {
    initLlama: jest.fn().mockResolvedValue({
      completion,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
    }),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
    toggleNativeLog: jest.fn().mockResolvedValue(undefined),
    addNativeLogListener: jest.fn().mockReturnValue({ remove: removeNativeLogListener }),
    loadLlamaModelInfo: jest.fn().mockResolvedValue({}),
    BuildInfo: { number: 'test', commit: 'test' },
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

jest.mock('../../src/services/SystemMetricsService', () => ({
  getFreshMemorySnapshot: jest.fn().mockResolvedValue(null),
}));

describe('LLMEngineService', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue(null);
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
            content: '<<SYS>>\nBe concise.\n\nConversation summary:\nEarlier context.\n<</SYS>>\n\nFirst user question.',
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

  it('clamps requested context size to the model ceiling before loading', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const safeContextSize = 4096;
    const modelSizeBytes = 2_000_000_000;

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
      maxContextTokens: safeContextSize,
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

  it('warns (does not hard-block) on borderline memory-fit results', async () => {
    const totalMemoryBytes = 4 * 1024 * 1024 * 1024;
    const modelSizeBytes = 3 * 1024 * 1024 * 1024;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).rejects.toMatchObject({
      code: 'model_memory_warning',
      details: expect.objectContaining({
        safeLoadProfile: expect.objectContaining({
          contextTokens: 512,
          gpuLayers: 0,
        }),
      }),
    });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(llmEngineService.getState().status).toBe(EngineStatus.IDLE);
  });

  it('rejects mmproj / CLIP projector GGUF files before initializing the engine', async () => {
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.type': 'mmproj',
      'general.architecture': 'clip',
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).rejects.toMatchObject({ code: 'model_incompatible' });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
  });

  it('allows an unsafe model load attempt for borderline memory-fit failures', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 6_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: 512,
        n_gpu_layers: 0,
      }),
      expect.any(Function),
    );
  });

  it('blocks unsafe model load attempts when the live memory snapshot is far below the requirement', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_700_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 2_500_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: totalMemoryBytes - 1_500_000_000,
      appUsedBytes: 500_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 250_000_000,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 2,
      n_head_kv: 4,
      n_embd_head_k: 8,
      n_embd_head_v: 8,
      sliding_window: 64,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).rejects.toMatchObject({ code: 'model_memory_insufficient' });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: null });
  });

  it('includes KV-cache bytes in model-load diagnostics when GGUF metadata is available', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 100_000_000,
      freeBytes: 100_000_000,
      usedBytes: totalMemoryBytes - 100_000_000,
      appUsedBytes: 250_000_000,
      lowMemory: false,
      pressureLevel: 'warning',
      thresholdBytes: 0,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 2,
      n_head_kv: 4,
      n_embd_head_k: 8,
      n_embd_head_v: 8,
      sliding_window: 64,
    });

    const thrown = await llmEngineService.load('test/model', { forceReload: true }).catch((error) => error);

    expect(thrown).toMatchObject({
      code: 'model_memory_insufficient',
      details: expect.objectContaining({
        memoryFit: expect.objectContaining({
          breakdown: expect.objectContaining({
            kvCacheBytes: expect.any(Number),
          }),
        }),
      }),
    });
    expect(thrown.details.memoryFit.breakdown.kvCacheBytes).toBeGreaterThan(0);
  });

  it('keeps model-load diagnostics free of raw paths and full memory snapshots', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_700_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 2_500_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: totalMemoryBytes - 1_500_000_000,
      appUsedBytes: 500_000_000,
      lowMemory: true,
      pressureLevel: 'critical',
      thresholdBytes: 250_000_000,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 2,
      n_head_kv: 4,
      n_embd_head_k: 8,
      n_embd_head_v: 8,
      sliding_window: 64,
    });

    const thrown = await llmEngineService.load('test/model', { forceReload: true }).catch((error) => error);

    expect(thrown).toMatchObject({
      code: 'model_memory_insufficient',
      details: expect.objectContaining({
        modelId: 'test/model',
        hasSystemMemorySnapshot: true,
        lowMemorySignal: true,
      }),
    });
    expect(thrown.details).toEqual(expect.not.objectContaining({
      modelPath: expect.anything(),
      localPath: expect.anything(),
      systemMemorySnapshot: expect.anything(),
    }));
  });

  it('uses the device total-memory budget for fitsInRam checks (not the live snapshot)', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 2_500_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: totalMemoryBytes - 1_500_000_000,
      appUsedBytes: 500_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 250_000_000,
    });

    await expect(llmEngineService.fitsInRam(1_700_000_000)).resolves.toMatchObject({
      decision: 'fits_low_confidence',
      confidence: 'low',
      budget: expect.objectContaining({
        totalMemoryBytes,
        liveAvailableBytes: undefined,
      }),
    });
    await expect(llmEngineService.fitsInRam(6_000_000_000)).resolves.toMatchObject({
      decision: 'borderline',
      confidence: 'low',
      budget: expect.objectContaining({
        totalMemoryBytes,
        liveAvailableBytes: undefined,
      }),
    });
  });

  it('returns unknown for fitsInRam checks when total-memory resolution fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (DeviceInfo.getTotalMemory as jest.Mock).mockRejectedValueOnce(new Error('E_TOTAL_MEM'));

    try {
      await expect(llmEngineService.fitsInRam(1_700_000_000)).resolves.toMatchObject({
        decision: 'unknown',
        confidence: 'low',
        budget: expect.objectContaining({
          totalMemoryBytes: 0,
          liveAvailableBytes: undefined,
        }),
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
