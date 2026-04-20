import { initLlama, releaseAllLlama } from 'llama.rn';
import { readLastGoodInferenceProfile } from '../../src/services/InferenceLastGoodProfileStore';

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModel: jest.fn(),
    updateModel: jest.fn(),
    getModels: jest.fn().mockReturnValue([]),
    saveModels: jest.fn(),
    getCalibrationRecord: jest.fn().mockReturnValue(undefined),
    setCalibrationRecord: jest.fn(),
  },
}));

jest.mock('../../src/services/InferenceBackendService', () => ({
  inferenceBackendService: {
    getCapabilitiesSummary: jest.fn().mockResolvedValue({
      discoveryUnavailable: false,
      cpu: { available: true },
      gpu: { available: true },
      npu: { available: true },
      rawDevices: [],
    }),
  },
}));

jest.mock('../../src/services/InferenceLastGoodProfileStore', () => ({
  readLastGoodInferenceProfile: jest.fn(),
  writeLastGoodInferenceProfile: jest.fn(),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
}));

jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
  releaseAllLlama: jest.fn().mockResolvedValue(undefined),
  toggleNativeLog: jest.fn().mockResolvedValue(undefined),
  addNativeLogListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  loadLlamaModelInfo: jest.fn().mockResolvedValue({}),
  getBackendDevicesInfo: jest.fn().mockResolvedValue([
    {
      type: 'gpu',
      backend: 'OpenCL',
      deviceName: 'QUALCOMM Adreno(TM) 740',
      maxMemorySize: 0,
    },
  ]),
  BuildInfo: { number: 'test', commit: 'test' },
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 1024 }),
  documentDirectory: 'test-dir/',
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getModelLoadParametersForModel: jest.fn().mockReturnValue({
    contextSize: 2048,
    kvCacheType: 'f16',
    gpuLayers: 40,
    backendPolicy: 'gpu',
  }),
  updateSettings: jest.fn(),
}));

function createMockContext(options?: { n_gpu_layers?: number; devices?: string[] }) {
  const layers = options?.n_gpu_layers ?? 0;
  const accelerated = layers > 0;
  return {
    completion: jest.fn().mockResolvedValue({ text: '' }),
    stopCompletion: jest.fn().mockResolvedValue(undefined),
    gpu: accelerated,
    devices: options?.devices ?? (accelerated ? ['Adreno GPU'] : []),
    reasonNoGPU: accelerated ? '' : 'GPU disabled',
    systemInfo: 'Android test device',
    androidLib: accelerated ? 'libOpenCL.so' : null,
  };
}

describe('LLMEngineService last-good warmup', () => {
  async function runWithFreshService<T>(run: (svc: any) => Promise<T>): Promise<T> {
    let promise: Promise<T> | null = null;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { llmEngineService } = require('../../src/services/LLMEngineService') as typeof import('../../src/services/LLMEngineService');
      promise = run(llmEngineService);
    });
    return await promise!;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    (initLlama as jest.Mock).mockImplementation(async (options?: any) => createMockContext(options));
    (releaseAllLlama as jest.Mock).mockResolvedValue(undefined);
  });

  it('prepends a warmup candidate based on last-good profile when preferLastWorkingProfile is true', async () => {
    (readLastGoodInferenceProfile as jest.Mock).mockReturnValue({
      backendMode: 'gpu',
      nGpuLayers: 10,
    });

    await runWithFreshService(async (llmEngineService) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registry } = require('../../src/services/LocalStorageRegistry') as typeof import('../../src/services/LocalStorageRegistry');
      (registry.getModel as jest.Mock).mockReturnValue({
        id: 'repo/model',
        localPath: 'model.gguf',
        lifecycleStatus: 'downloaded',
        size: 1024,
      });

      await llmEngineService.load('repo/model', {
        preferLastWorkingProfile: true,
        loadParamsOverride: {
          backendPolicy: 'gpu',
          gpuLayers: 40,
        },
      });
    });

    expect(readLastGoodInferenceProfile).toHaveBeenCalled();
    expect(initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_gpu_layers: 10,
      }),
      expect.any(Function),
    );
  });

  it('falls back to a CPU warmup candidate when stored GPU layers are non-positive', async () => {
    (readLastGoodInferenceProfile as jest.Mock).mockReturnValue({
      backendMode: 'gpu',
      nGpuLayers: 0,
    });

    const reasons = await runWithFreshService(async (llmEngineService) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registry } = require('../../src/services/LocalStorageRegistry') as typeof import('../../src/services/LocalStorageRegistry');
      (registry.getModel as jest.Mock).mockReturnValue({
        id: 'repo/model',
        localPath: 'model.gguf',
        lifecycleStatus: 'downloaded',
        size: 1024,
      });

      await llmEngineService.load('repo/model', {
        preferLastWorkingProfile: true,
        loadParamsOverride: {
          backendPolicy: 'gpu',
          gpuLayers: 40,
        },
      });

      return llmEngineService.getState().diagnostics?.backendPolicyReasons ?? [];
    });

    expect(initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_gpu_layers: 0,
        flash_attn_type: 'off',
      }),
      expect.any(Function),
    );

    expect(reasons).toEqual(expect.arrayContaining(['inference.backendPolicyReason.warmupPreferringLastGood']));
  });

  it('falls back to CPU when a GPU candidate initializes but reports CPU runtime', async () => {
    (readLastGoodInferenceProfile as jest.Mock).mockReturnValue(null);

    (initLlama as jest.Mock).mockImplementation(async (options?: any) => {
      const layers = options?.n_gpu_layers ?? 0;
      if (layers > 0) {
        return {
          completion: jest.fn().mockResolvedValue({ text: '' }),
          stopCompletion: jest.fn().mockResolvedValue(undefined),
          gpu: false,
          devices: [],
          reasonNoGPU: 'GPU disabled',
          systemInfo: 'Android test device',
          androidLib: null,
        };
      }
      return createMockContext({ n_gpu_layers: 0, devices: [] });
    });

    const effectivePolicy = await runWithFreshService(async (llmEngineService) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registry } = require('../../src/services/LocalStorageRegistry') as typeof import('../../src/services/LocalStorageRegistry');
      (registry.getModel as jest.Mock).mockReturnValue({
        id: 'repo/model',
        localPath: 'model.gguf',
        lifecycleStatus: 'downloaded',
        size: 1024,
      });

      await llmEngineService.load('repo/model', {
        loadParamsOverride: {
          backendPolicy: 'gpu',
          gpuLayers: 12,
        },
      });
      return llmEngineService.getState().diagnostics?.effectiveBackendPolicy;
    });

    expect(releaseAllLlama).toHaveBeenCalled();
    expect(effectivePolicy).toBe('cpu');
  });

  it('records skipped backend init attempts when discovery blocks the requested policy', async () => {
    const attempts = await runWithFreshService(async (llmEngineService) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registry } = require('../../src/services/LocalStorageRegistry') as typeof import('../../src/services/LocalStorageRegistry');
      (registry.getModel as jest.Mock).mockReturnValue({
        id: 'repo/model',
        localPath: 'model.gguf',
        lifecycleStatus: 'downloaded',
        size: 1024,
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { inferenceBackendService } = require('../../src/services/InferenceBackendService') as typeof import('../../src/services/InferenceBackendService');
      (inferenceBackendService.getCapabilitiesSummary as jest.Mock).mockResolvedValueOnce({
        discoveryUnavailable: false,
        cpu: { available: true },
        gpu: { available: true },
        npu: { available: false },
        rawDevices: [],
      });

      await llmEngineService.load('repo/model', {
        loadParamsOverride: {
          backendPolicy: 'npu',
          gpuLayers: 12,
          selectedBackendDevices: ['HTP*'],
        },
      });

      return llmEngineService.getState().diagnostics?.backendInitAttempts ?? [];
    });
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidate: 'npu',
        outcome: 'skipped',
        devices: ['HTP*'],
      }),
    ]));
  });
});
