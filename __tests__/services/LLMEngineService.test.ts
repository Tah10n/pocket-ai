import * as llamaRn from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { inferenceBackendService } from '../../src/services/InferenceBackendService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { writeAutotuneResult } from '../../src/services/InferenceAutotuneStore';
import { createStorage } from '../../src/services/storage';
import { getModelLoadParametersForModel, updateSettings } from '../../src/services/SettingsStore';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';
import { EngineStatus, LifecycleStatus } from '../../src/types/models';

jest.mock('llama.rn', () => {
  const completion = jest.fn();
  const removeNativeLogListener = jest.fn();
  return {
    initLlama: jest.fn().mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
      completion,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: (options?.n_gpu_layers ?? 0) > 0 ? ['Adreno GPU'] : [],
      reasonNoGPU: (options?.n_gpu_layers ?? 0) > 0 ? '' : 'GPU disabled',
      systemInfo: 'Android test device',
      androidLib: (options?.n_gpu_layers ?? 0) > 0 ? 'libOpenCL.so' : null,
    })),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
    toggleNativeLog: jest.fn().mockResolvedValue(undefined),
    addNativeLogListener: jest.fn().mockReturnValue({ remove: removeNativeLogListener }),
    loadLlamaModelInfo: jest.fn().mockResolvedValue({
      'general.architecture': 'llama',
      'general.type': 'model',
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.embedding_length': 4096,
    }),
    getBackendDevicesInfo: jest.fn().mockResolvedValue([]),
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

function getBackendDevicesInfoMock(): jest.Mock {
  return (llamaRn as unknown as { getBackendDevicesInfo: jest.Mock }).getBackendDevicesInfo;
}

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
    createStorage('pocket-ai-autotune', { tier: 'private' }).clearAll();
    inferenceBackendService.clearCache();
    getBackendDevicesInfoMock().mockResolvedValue([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue(null);
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: (options?.n_gpu_layers ?? 0) > 0 ? ['Adreno GPU'] : [],
      reasonNoGPU: (options?.n_gpu_layers ?? 0) > 0 ? '' : 'GPU disabled',
      systemInfo: 'Android test device',
      androidLib: (options?.n_gpu_layers ?? 0) > 0 ? 'libOpenCL.so' : null,
    }));
    (registry.getModel as jest.Mock) = jest.fn().mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    (registry.updateModel as jest.Mock) = jest.fn();
    (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock.mockResolvedValue({ text: 'Hello back' });

    // Ensure each test starts with a realistic, non-empty GGUF metadata payload.
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValue({
      'general.architecture': 'llama',
      'general.type': 'model',
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.embedding_length': 4096,
    });
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

  it('blocks prompt token counting while a completion is in flight', async () => {
    await llmEngineService.load('test/model');

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    completionMock.mockImplementationOnce(async () => {
      // Keep the completion promise in-flight for at least one tick.
      await Promise.resolve();
      return { text: 'Done' };
    });

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 1 },
    });

    await expect(
      llmEngineService.countPromptTokens({ messages: [{ role: 'user', content: 'Hello' }] }),
    ).rejects.toMatchObject({ code: 'engine_busy' });

    await completionPromise;
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
      kvCacheType: 'f16',
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

  it('reports requested and loaded GPU layers separately after retrying with fewer layers', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => {
      if ((options?.n_gpu_layers ?? 0) >= 12) {
        throw new Error('GPU OOM');
      }

      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: (options?.n_gpu_layers ?? 0) > 0,
        devices: ['Adreno GPU'],
        reasonNoGPU: '',
        systemInfo: 'Android test device',
        androidLib: 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getLoadedGpuLayers()).toBe(9);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 9,
      actualGpuAccelerated: true,
      backendDevices: ['Adreno GPU'],
    }));
  });

  it('reports CPU runtime honestly when upstream does not enable GPU acceleration', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => {
      const layers = options?.n_gpu_layers ?? 0;
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: false,
        devices: [],
        reasonNoGPU: layers > 0 ? 'OpenCL backend unavailable' : 'CPU fallback',
        systemInfo: 'Android test device',
        androidLib: null,
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[0][0]?.n_gpu_layers ?? 0)).toBeGreaterThan(0);
    expect(calls[1][0]?.n_gpu_layers ?? 0).toBe(0);
    expect(llmEngineService.getLoadedGpuLayers()).toBe(0);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 0,
      actualGpuAccelerated: false,
      reasonNoGPU: 'CPU fallback',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: false, reasonNoGPU: 'OpenCL backend unavailable' }),
        expect.objectContaining({ candidate: 'cpu', outcome: 'success', actualGpu: false }),
      ]),
    }));
  });

  it('does not attempt GPU init when no accelerator devices exist', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    const attemptedGpu = calls.some((call) => (call[0]?.n_gpu_layers ?? 0) > 0);
    expect(attemptedGpu).toBe(false);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 0,
    }));
  });

  it('classifies HTP as NPU-only and uses offload layers for NPU loads', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'npu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: options?.devices?.includes('HTP0') ? ['HTP0'] : [],
      reasonNoGPU: '',
      systemInfo: 'Android Hexagon test device',
      androidLib: 'libQnnHtp.so',
    }));

    const availability = await llmEngineService.getBackendAvailability();
    expect(availability).toEqual(expect.objectContaining({
      gpuBackendAvailable: false,
      npuBackendAvailable: true,
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: 4096,
        n_gpu_layers: 12,
        devices: ['HTP0'],
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getLoadedGpuLayers()).toBe(12);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'npu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 12,
      actualGpuAccelerated: true,
      backendDevices: ['HTP0'],
    }));
  });

  it('reports both GPU and NPU availability when upstream lists both device types', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);

    await expect(llmEngineService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: true,
      npuBackendAvailable: true,
    }));
  });

  it('auto falls back from NPU to GPU when NPU init returns CPU runtime', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      const isNpuCandidate = Array.isArray(options?.devices) && options.devices.some((device) => device.toUpperCase().startsWith('HTP'));
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: !isNpuCandidate && (options?.n_gpu_layers ?? 0) > 0,
        devices: isNpuCandidate ? ['HTP0'] : ['Adreno GPU'],
        reasonNoGPU: isNpuCandidate ? 'HTP acceleration disabled' : '',
        systemInfo: isNpuCandidate ? 'Android Hexagon test device' : 'Android test device',
        androidLib: isNpuCandidate ? 'libQnnHtp.so' : 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();

    expect(llmEngineService.getLoadedGpuLayers()).toBe(12);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'success', actualGpu: false }),
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: true }),
      ]),
    }));
  });

  it('does not fall back from NPU to GPU when GPU is unavailable', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      const isNpuCandidate = Array.isArray(options?.devices) && options.devices.some((device) => device.toUpperCase().startsWith('HTP'));
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: !isNpuCandidate && (options?.n_gpu_layers ?? 0) > 0,
        devices: isNpuCandidate ? ['HTP0'] : ['Adreno GPU'],
        reasonNoGPU: isNpuCandidate ? 'HTP acceleration disabled' : '',
        systemInfo: isNpuCandidate ? 'Android Hexagon test device' : 'Android test device',
        androidLib: isNpuCandidate ? 'libQnnHtp.so' : 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();
    expect(llmEngineService.getLoadedGpuLayers()).toBe(0);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'success', actualGpu: false }),
        expect.objectContaining({ candidate: 'cpu', outcome: 'success', actualGpu: false }),
      ]),
    }));
  });

  it('auto falls back from NPU to GPU when NPU init throws', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      if (Array.isArray(options?.devices) && options.devices.some((device) => device.toUpperCase().startsWith('HTP'))) {
        throw new Error('NPU init failed');
      }

      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: (options?.n_gpu_layers ?? 0) > 0,
        devices: ['Adreno GPU'],
        reasonNoGPU: '',
        systemInfo: 'Android test device',
        androidLib: 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'error' }),
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: true }),
      ]),
    }));
  });

  it('explicit NPU policy does not fall back to GPU when NPU init returns CPU runtime', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'npu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: false,
      devices: options?.devices?.includes('HTP0') ? ['HTP0'] : [],
      reasonNoGPU: 'HTP acceleration disabled',
      systemInfo: 'Android Hexagon test device',
      androidLib: 'libQnnHtp.so',
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();
    expect(llmEngineService.getLoadedGpuLayers()).toBe(0);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedBackendPolicy: 'npu',
      effectiveBackendPolicy: 'cpu',
      reasonNoGPU: 'HTP acceleration disabled',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'success', actualGpu: false }),
        expect.objectContaining({ candidate: 'cpu', outcome: 'success', actualGpu: false }),
      ]),
    }));
  });

  it('records a skipped NPU attempt and falls back to GPU when NPU policy is requested but no HTP devices exist', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'npu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: ['Adreno GPU'],
      reasonNoGPU: '',
      systemInfo: 'Android test device',
      androidLib: 'libOpenCL.so',
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      requestedBackendPolicy: 'npu',
      effectiveBackendPolicy: 'auto',
      backendPolicyReasons: expect.arrayContaining([
        'inference.backendPolicyReason.npuRequestedNoDevicesDiscovered',
      ]),
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'skipped' }),
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: true }),
      ]),
    }));
  });

  it('records a skipped GPU attempt when GPU policy is requested but no non-HTP devices exist', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'gpu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: false,
      devices: options?.devices?.includes('HTP*') ? ['HTP0'] : [],
      reasonNoGPU: 'OpenCL backend unavailable',
      systemInfo: 'Android Hexagon test device',
      androidLib: 'libQnnHtp.so',
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedBackendPolicy: 'gpu',
      effectiveBackendPolicy: 'cpu',
      backendPolicyReasons: expect.arrayContaining([
        'inference.backendPolicyReason.gpuRequestedNoDevicesDiscovered',
      ]),
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'gpu', outcome: 'skipped' }),
      ]),
    }));
  });

  it('prefers the saved best-stable autotune profile when auto policy is enabled', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      bestStable: {
        backendMode: 'gpu',
        nGpuLayers: 12,
      },
      candidates: [],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect((llamaRn.initLlama as jest.Mock).mock.calls).toHaveLength(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0].devices).toBeUndefined();
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      backendPolicyReasons: expect.arrayContaining([
        'inference.backendPolicyReason.autotunePreferringGpu',
      ]),
    }));
  });

  it('ignores a saved autotune profile when the model sha no longer matches', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      sha256: 'live-sha',
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      modelSha256: 'stale-sha',
      bestStable: {
        backendMode: 'gpu',
        nGpuLayers: 12,
      },
      candidates: [],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect((llamaRn.initLlama as jest.Mock).mock.calls).toHaveLength(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0].devices).toEqual(['HTP0']);
    expect(llmEngineService.getState().diagnostics?.backendPolicyReasons ?? []).not.toContain(
      'inference.backendPolicyReason.autotunePreferringGpu',
    );
  });

  it('applies advanced load parameters to init options and diagnostics', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
    });
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      cpuThreads: 6,
      cpuMask: '4,5',
      cpuStrict: true,
      flashAttention: 'on',
      useMmap: false,
      useMlock: true,
      parallelSlots: 2,
      nBatch: 96,
      nUbatch: 48,
      kvUnified: true,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_ctx: 4096,
        n_gpu_layers: 12,
        n_threads: 6,
        cpu_mask: '4,5',
        cpu_strict: true,
        n_parallel: 2,
        flash_attn_type: 'on',
        use_mmap: false,
        use_mlock: true,
        n_batch: 96,
        n_ubatch: 48,
        kv_unified: true,
      }),
      expect.any(Function),
    );

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      initFlashAttnType: 'on',
      initUseMmap: false,
      initUseMlock: true,
      initNParallel: 2,
      initNThreads: 6,
      initCpuMask: '4,5',
      initCpuStrict: true,
      initNBatch: 96,
      initNUbatch: 48,
      initKvUnified: true,
    }));
  });

  it('forces flash attention auto when V cache is quantized', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
    });
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 0,
      backendPolicy: 'cpu',
      kvCacheType: 'q8_0',
      flashAttention: 'off',
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_gpu_layers: 0,
        cache_type_v: 'q8_0',
        flash_attn_type: 'auto',
      }),
      expect.any(Function),
    );

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      initFlashAttnType: 'auto',
    }));
  });

  it('falls back to f16 KV cache when quantized head dims are incompatible', async () => {
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_embd_head_k: 48,
      n_embd_head_v: 48,
    });

    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 0,
      backendPolicy: 'cpu',
      kvCacheType: 'q8_0',
      flashAttention: 'off',
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_gpu_layers: 0,
        cache_type_k: 'f16',
        cache_type_v: 'f16',
        flash_attn_type: 'off',
      }),
      expect.any(Function),
    );

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      initCacheTypeK: 'f16',
      initCacheTypeV: 'f16',
    }));
  });

  it('retries with discovered NPU devices when a saved autotune selector is stale and records actual runtime devices', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      sha256: 'live-sha',
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      modelSha256: 'live-sha',
      bestStable: {
        backendMode: 'npu',
        nGpuLayers: 12,
        devices: ['HTP9'],
      },
      candidates: [],
    });

    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      if (options?.devices?.includes('HTP9')) {
        throw new Error('stale NPU selector');
      }

      const isNpuCandidate = options?.devices?.includes('HTP0');
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: (options?.n_gpu_layers ?? 0) > 0,
        devices: isNpuCandidate ? ['HTP0'] : ['Adreno GPU'],
        reasonNoGPU: '',
        systemInfo: isNpuCandidate ? 'Android Hexagon test device' : 'Android test device',
        androidLib: isNpuCandidate ? 'libQnnHtp.so' : 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls[0][0].devices).toEqual(['HTP9']);
    expect(calls[1][0].devices).toEqual(['HTP0']);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'npu',
      initDevices: ['HTP0'],
    }));
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

  it('blocks models that only fit at the minimum context window', async () => {
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
      code: 'model_load_blocked',
      details: expect.objectContaining({
        safeLoadProfile: expect.objectContaining({
          contextTokens: 512,
          gpuLayers: 0,
        }),
      }),
    });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(llmEngineService.getState().status).toBe(EngineStatus.IDLE);
    expect(registry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'test/model',
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
    }));
  });

  it('allows an unsafe retry for registry-marked likely_oom models', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelSizeBytes,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      fitsInRam: false,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: 'test/model' });
  });

  it('does not hard-block persisted likely_oom flags unless confidence is high', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelSizeBytes,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'medium',
      fitsInRam: false,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: 'test/model' });
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

  it('clamps an aggressive saved load profile back under the memory ceiling before loading', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 4_705_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 8192,
      gpuLayers: 35,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 32,
      n_head_kv: 8,
      n_embd_head_k: 128,
      n_embd_head_v: 128,
      sliding_window: 8192,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect(llmEngineService.getContextSize()).toBeLessThan(8192);
    expect(llmEngineService.getContextSize()).toBeGreaterThan(512);
  });

  it('does not attempt unsafe loads when the only safe profile hits the minimum context window', async () => {
    const totalMemoryBytes = 8_000_000_000;
    const modelSizeBytes = 1_708_582_752;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 900_000_000,
      freeBytes: 800_000_000,
      usedBytes: totalMemoryBytes - 900_000_000,
      appUsedBytes: 480_309_248,
      appResidentBytes: 480_309_248,
      appPssBytes: 395_870_208,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 200_000_000,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.architecture': 'gemma2',
      'general.type': 'model',
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).rejects.toMatchObject({
      code: 'model_load_blocked',
      details: expect.objectContaining({
        safeLoadProfile: expect.objectContaining({
          contextTokens: 512,
          gpuLayers: 0,
        }),
      }),
    });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: 'test/model' });
  });

  it('loads normally when low-confidence estimates still fit within conservative live availability', async () => {
    const totalMemoryBytes = 8_000_000_000;
    const modelSizeBytes = 1_708_582_752;
    const getCalibrationRecordSpy = jest.spyOn(registry, 'getCalibrationRecord');

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 3_639_033_856,
      freeBytes: undefined,
      usedBytes: totalMemoryBytes - 3_639_033_856,
      appUsedBytes: 480_309_248,
      appResidentBytes: 480_309_248,
      appPssBytes: 395_870_208,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 452_984_832,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.architecture': 'gemma2',
      'general.type': 'model',
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: 2048,
        n_gpu_layers: 20,
      }),
      expect.any(Function),
    );

    const lowMemoryCalibrationLookup = getCalibrationRecordSpy.mock.calls
      .map(([key]) => key)
      .find((key): key is string => {
        if (typeof key !== 'string') {
          return false;
        }

        try {
          const parsed = JSON.parse(key) as { nBatch?: number; nUbatch?: number };
          return parsed.nBatch === 256 && parsed.nUbatch === 128;
        } catch {
          return false;
        }
      });
    expect(lowMemoryCalibrationLookup).toBeDefined();

    getCalibrationRecordSpy.mockRestore();
  });

  it('clamps context size to fit within current memory limits without forcing safe mode', async () => {
    const totalMemoryBytes = 8_000_000_000;
    const availableBytes = 1_600_000_000;
    const modelSizeBytes = 2_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes,
      freeBytes: availableBytes,
      usedBytes: totalMemoryBytes - availableBytes,
      appUsedBytes: 500_000_000,
      appResidentBytes: 500_000_000,
      appPssBytes: 400_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValue({
      n_layers: 32,
      n_head_kv: 8,
      n_embd_head_k: 128,
      n_embd_head_v: 128,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).resolves.toBeUndefined();

    const safeLimits = llmEngineService.getSafeModeLoadLimits();
    expect(safeLimits).toBeNull();

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: expect.any(Number),
        n_gpu_layers: 12,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBeLessThan(4096);
    expect(llmEngineService.getContextSize()).toBeGreaterThan(512);
  });

  it('blocks unsafe loads when safe mode hits the minimum context window', async () => {
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
      availableBytes: 900_000_000,
      freeBytes: 700_000_000,
      usedBytes: totalMemoryBytes - 900_000_000,
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
    ).rejects.toMatchObject({
      code: 'model_load_blocked',
      details: expect.objectContaining({
        safeLoadProfile: expect.objectContaining({
          contextTokens: 512,
          gpuLayers: 0,
        }),
      }),
    });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: 'test/model' });
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
