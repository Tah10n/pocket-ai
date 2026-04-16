import { EngineStatus } from '../../src/types/models';
import { createStorage } from '../../src/services/storage';
import { readAutotuneResult } from '../../src/services/InferenceAutotuneStore';
import * as autotuneStore from '../../src/services/InferenceAutotuneStore';
import { inferenceAutotuneService } from '../../src/services/InferenceAutotuneService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { inferenceBackendService } from '../../src/services/InferenceBackendService';
import { getModelLoadParametersForModel } from '../../src/services/SettingsStore';

jest.mock('../../src/services/InferenceAutotuneStore', () => {
  const actual = jest.requireActual('../../src/services/InferenceAutotuneStore');
  return {
    ...actual,
    writeAutotuneResult: jest.fn(actual.writeAutotuneResult),
  };
});

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    hasActiveCompletion: jest.fn(),
    getState: jest.fn(),
    unload: jest.fn(),
    load: jest.fn(),
    getRecommendedLoadProfile: jest.fn(),
    chatCompletion: jest.fn(),
  },
}));

jest.mock('../../src/services/InferenceBackendService', () => ({
  inferenceBackendService: {
    getCapabilitiesSummary: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => {
  const actual = jest.requireActual('../../src/services/SettingsStore');
  return {
    ...actual,
    getModelLoadParametersForModel: jest.fn(),
  };
});

function clearAutotuneStorage() {
  createStorage('pocket-ai-autotune', { tier: 'private' }).clearAll();
}

describe('InferenceAutotuneService', () => {
  let state: any;
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    clearAutotuneStorage();

    let now = 0;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      now += 100;
      return now;
    });

    state = {
      status: EngineStatus.READY,
      activeModelId: 'prev/model',
      diagnostics: {
        backendMode: 'cpu',
        backendDevices: [],
      },
    };

    (llmEngineService.hasActiveCompletion as jest.Mock).mockReturnValue(false);
    (llmEngineService.getState as jest.Mock).mockImplementation(() => state);
    (llmEngineService.unload as jest.Mock).mockImplementation(async () => {
      state = {
        status: EngineStatus.IDLE,
        activeModelId: undefined,
        diagnostics: undefined,
      };
    });

    (getModelLoadParametersForModel as jest.Mock).mockReturnValue({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    (llmEngineService.getRecommendedLoadProfile as jest.Mock).mockResolvedValue({
      recommendedGpuLayers: 12,
      gpuLayersCeiling: 18,
    });

    (inferenceBackendService.getCapabilitiesSummary as jest.Mock).mockResolvedValue({
      discoveryUnavailable: false,
      cpu: { available: true },
      gpu: { available: true },
      npu: { available: true },
      rawDevices: [],
    });

    let activeCandidateMode: 'cpu' | 'gpu' | 'npu' = 'cpu';
    (llmEngineService.load as jest.Mock).mockImplementation(async (_modelId: string, options?: any) => {
      const policy = options?.loadParamsOverride?.backendPolicy;
      const initGpuLayers = options?.loadParamsOverride?.gpuLayers ?? 0;

      activeCandidateMode = policy === 'gpu' ? 'gpu' : policy === 'npu' ? 'npu' : 'cpu';

      state = {
        status: EngineStatus.READY,
        activeModelId: _modelId,
        diagnostics: {
          backendMode: activeCandidateMode,
          backendDevices: activeCandidateMode === 'npu' ? ['HTP0'] : activeCandidateMode === 'gpu' ? ['Adreno GPU'] : [],
          actualGpuAccelerated: activeCandidateMode !== 'cpu',
          initGpuLayers,
          initDevices: activeCandidateMode === 'npu' ? ['HTP0'] : activeCandidateMode === 'gpu' ? ['Adreno GPU'] : [],
          loadedGpuLayers: activeCandidateMode !== 'cpu' ? initGpuLayers : 0,
          reasonNoGPU: activeCandidateMode === 'cpu' ? 'CPU only' : undefined,
        },
      };
    });

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(async (options?: any) => {
      const onToken = typeof options?.onToken === 'function' ? (options.onToken as () => void) : null;
      const initGpuLayers = typeof state?.diagnostics?.initGpuLayers === 'number' ? state.diagnostics.initGpuLayers : 0;
      const tokenCountTarget =
        state?.diagnostics?.backendMode === 'gpu'
          ? Math.max(1, Math.round(initGpuLayers * 2))
          : state?.diagnostics?.backendMode === 'npu'
            ? Math.max(1, Math.round(initGpuLayers * 2))
            : 10;

      for (let i = 0; i < tokenCountTarget; i += 1) {
        onToken?.();
      }
    });
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it('runs autotune, persists best-stable, and restores the previous model', async () => {
    const result = await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    expect(result.bestStable).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      nGpuLayers: 18,
      devices: ['Adreno GPU'],
    }));

    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    })?.bestStable).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      nGpuLayers: 18,
    }));

    expect(llmEngineService.load).toHaveBeenLastCalledWith('prev/model', {
      forceReload: true,
      loadParamsOverride: {
        backendPolicy: 'cpu',
        gpuLayers: 0,
        selectedBackendDevices: null,
      },
    });
  });

  it('throws when the engine is busy generating', async () => {
    (llmEngineService.hasActiveCompletion as jest.Mock).mockReturnValue(true);

    await expect(inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    })).rejects.toThrow('Engine is busy generating a response.');
  });

  it('throws when the engine is initializing', async () => {
    state = {
      status: EngineStatus.INITIALIZING,
      activeModelId: 'test/model',
      diagnostics: undefined,
    };

    await expect(inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    })).rejects.toThrow('Engine is initializing. Try again in a moment.');
  });

  it('does not attempt NPU candidates when no NPU is available', async () => {
    (inferenceBackendService.getCapabilitiesSummary as jest.Mock).mockResolvedValue({
      discoveryUnavailable: false,
      cpu: { available: true },
      gpu: { available: true },
      npu: { available: false },
      rawDevices: [],
    });

    await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    const loadCalls = (llmEngineService.load as jest.Mock).mock.calls;
    const attemptedPolicies = loadCalls
      .map((call) => call[1]?.loadParamsOverride?.backendPolicy)
      .filter(Boolean);

    expect(attemptedPolicies).not.toEqual(expect.arrayContaining(['npu']));
  });

  it('does not attempt GPU candidates when no GPU is available', async () => {
    (inferenceBackendService.getCapabilitiesSummary as jest.Mock).mockResolvedValue({
      discoveryUnavailable: false,
      cpu: { available: true },
      gpu: { available: false },
      npu: { available: false },
      rawDevices: [],
    });

    await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    const loadCalls = (llmEngineService.load as jest.Mock).mock.calls;
    const attemptedPolicies = loadCalls
      .map((call) => call[1]?.loadParamsOverride?.backendPolicy)
      .filter(Boolean);

    expect(attemptedPolicies).not.toEqual(expect.arrayContaining(['gpu']));
  });

  it('benchmarks in-place when only CPU is available and the target model is already loaded', async () => {
    state = {
      status: EngineStatus.READY,
      activeModelId: 'test/model',
      diagnostics: {
        backendMode: 'cpu',
        backendDevices: [],
        actualGpuAccelerated: false,
        loadedGpuLayers: 0,
      },
    };
    (llmEngineService.getState as jest.Mock).mockImplementation(() => state);

    (inferenceBackendService.getCapabilitiesSummary as jest.Mock).mockResolvedValue({
      discoveryUnavailable: false,
      cpu: { available: true },
      gpu: { available: false },
      npu: { available: false },
      rawDevices: [],
    });

    const result = await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    expect(llmEngineService.unload).not.toHaveBeenCalled();
    expect(llmEngineService.load).not.toHaveBeenCalled();
    expect(llmEngineService.chatCompletion).toHaveBeenCalled();
    expect(result.bestStable).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      nGpuLayers: 0,
    }));
  });

  it('restores the previous model using an explicit GPU policy when it was running on GPU', async () => {
    state = {
      status: EngineStatus.READY,
      activeModelId: 'prev/model',
      diagnostics: {
        backendMode: 'gpu',
        backendDevices: ['Adreno GPU'],
        actualGpuAccelerated: true,
        loadedGpuLayers: 12,
      },
    };
    (llmEngineService.getState as jest.Mock).mockImplementation(() => state);

    await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    expect(llmEngineService.load).toHaveBeenLastCalledWith('prev/model', expect.objectContaining({
      forceReload: true,
      loadParamsOverride: {
        backendPolicy: 'gpu',
        gpuLayers: 12,
        selectedBackendDevices: null,
      },
    }));
  });

  it('restores the previous model using an explicit NPU policy when it was running on NPU', async () => {
    state = {
      status: EngineStatus.READY,
      activeModelId: 'prev/model',
      diagnostics: {
        backendMode: 'npu',
        backendDevices: ['HTP0'],
        actualGpuAccelerated: true,
        loadedGpuLayers: 12,
        initDevices: ['HTP0'],
      },
    };
    (llmEngineService.getState as jest.Mock).mockImplementation(() => state);

    await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    expect(llmEngineService.load).toHaveBeenLastCalledWith('prev/model', expect.objectContaining({
      forceReload: true,
      loadParamsOverride: {
        backendPolicy: 'npu',
        gpuLayers: 12,
        selectedBackendDevices: ['HTP0'],
      },
    }));
  });

  it('does not unload the previous model when an early prerequisite throws', async () => {
    (llmEngineService.getRecommendedLoadProfile as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await expect(inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    })).rejects.toThrow('boom');

    expect(llmEngineService.unload).not.toHaveBeenCalled();
  });

  it('restores the previous model even if persisting the autotune result fails', async () => {
    (autotuneStore.writeAutotuneResult as jest.Mock).mockImplementationOnce(() => {
      throw new Error('storage failed');
    });

    await expect(inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    })).rejects.toThrow('storage failed');

    expect(llmEngineService.load).toHaveBeenLastCalledWith('prev/model', expect.objectContaining({
      forceReload: true,
      loadParamsOverride: expect.objectContaining({
        backendPolicy: 'cpu',
        gpuLayers: 0,
      }),
    }));
  });

  it('preserves the previous best-stable profile when a rerun finds no eligible candidates', async () => {
    autotuneStore.writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      bestStable: {
        backendMode: 'gpu',
        nGpuLayers: 18,
        devices: ['Adreno GPU'],
      },
      candidates: [],
    });

    (llmEngineService.load as jest.Mock).mockImplementation(async (modelId: string) => {
      if (modelId === 'test/model') {
        throw new Error('candidate failed');
      }

      state = {
        status: EngineStatus.READY,
        activeModelId: modelId,
        diagnostics: {
          backendMode: 'cpu',
          backendDevices: [],
          actualGpuAccelerated: false,
          loadedGpuLayers: 0,
        },
      };
    });

    const result = await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    expect(result.bestStable).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      nGpuLayers: 18,
      devices: ['Adreno GPU'],
    }));
    expect(result.candidates.every((candidate) => candidate.success === false)).toBe(true);
    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    })?.bestStable).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      nGpuLayers: 18,
      devices: ['Adreno GPU'],
    }));
    expect(llmEngineService.load).toHaveBeenLastCalledWith('prev/model', expect.objectContaining({
      forceReload: true,
      loadParamsOverride: expect.objectContaining({
        backendPolicy: 'cpu',
        gpuLayers: 0,
      }),
    }));
  });

  it('clears selectedBackendDevices for CPU/GPU benchmark candidates', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      selectedBackendDevices: ['stale-device'],
    });

    await inferenceAutotuneService.runBackendAutotune({
      modelId: 'test/model',
    });

    const loadCalls = (llmEngineService.load as jest.Mock).mock.calls
      .filter((call) => call[0] === 'test/model')
      .map((call) => call[1]?.loadParamsOverride)
      .filter(Boolean);

    const cpuGpuCalls = loadCalls.filter((override) => override.backendPolicy === 'cpu' || override.backendPolicy === 'gpu');
    expect(cpuGpuCalls.length).toBeGreaterThan(0);
    for (const override of cpuGpuCalls) {
      expect(override.selectedBackendDevices).toBeNull();
    }
  });

  it('reports restorationError when previous-model reload fails after autotune', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    (llmEngineService.load as jest.Mock).mockImplementation(async (modelId: string, options?: any) => {
      if (modelId === 'prev/model') {
        throw new Error('native reload crashed');
      }
      const policy = options?.loadParamsOverride?.backendPolicy;
      const activeMode: 'cpu' | 'gpu' | 'npu' = policy === 'gpu' ? 'gpu' : policy === 'npu' ? 'npu' : 'cpu';
      const initGpuLayers = options?.loadParamsOverride?.gpuLayers ?? 0;
      state = {
        status: EngineStatus.READY,
        activeModelId: modelId,
        diagnostics: {
          backendMode: activeMode,
          backendDevices: activeMode === 'npu' ? ['HTP0'] : activeMode === 'gpu' ? ['Adreno GPU'] : [],
          actualGpuAccelerated: activeMode !== 'cpu',
          initGpuLayers,
          initDevices: activeMode === 'npu' ? ['HTP0'] : activeMode === 'gpu' ? ['Adreno GPU'] : [],
          loadedGpuLayers: activeMode !== 'cpu' ? initGpuLayers : 0,
          reasonNoGPU: activeMode === 'cpu' ? 'CPU only' : undefined,
        },
      };
    });

    const result = await inferenceAutotuneService.runBackendAutotune({ modelId: 'test/model' });

    expect(result.restorationError).toBe('native reload crashed');
    expect(warnSpy).toHaveBeenCalledWith(
      '[InferenceAutotune] Failed to restore previously loaded model',
      expect.any(Error),
    );

    const persisted = readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.restorationError).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('does not persist a new CPU best-stable result when backend discovery is unavailable', async () => {
    (inferenceBackendService.getCapabilitiesSummary as jest.Mock).mockResolvedValue({
      discoveryUnavailable: true,
      cpu: { available: true },
      gpu: { available: false },
      npu: { available: false },
      rawDevices: [],
    });

    const result = await inferenceAutotuneService.runBackendAutotune({ modelId: 'test/model' });

    expect(result.backendDiscoveryKnown).toBe(false);
    expect(result.bestStable).toBeUndefined();

    const persisted = readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.backendDiscoveryKnown).toBe(false);
    expect(persisted?.bestStable).toBeUndefined();
  });
});
