import { resolveInferenceProfileCandidates } from '../../src/services/resolveInferenceProfile';
import type { BackendCapabilitiesSummary } from '../../src/services/InferenceBackendService';

describe('resolveInferenceProfileCandidates', () => {
  const baseProfile = {
    flashAttnType: 'auto' as const,
    useMmap: true,
    useMlock: false,
    nParallel: 1,
  };

  const capabilitiesBoth: BackendCapabilitiesSummary = {
    discoveryUnavailable: false,
    cpu: { kind: 'cpu', label: 'CPU', available: true, deviceNames: [], backendNames: [], notes: [] },
    gpu: { kind: 'gpu', label: 'GPU', available: true, deviceNames: ['Adreno GPU'], backendNames: ['OpenCL'], notes: [] },
    npu: { kind: 'npu', label: 'NPU', available: true, deviceNames: ['HTP0'], backendNames: ['HTP'], notes: [] },
    rawDevices: [
      { backend: 'OpenCL', type: 'gpu', deviceName: 'Adreno GPU', maxMemorySize: 0 },
      { backend: 'HTP', type: 'gpu', deviceName: 'HTP0', maxMemorySize: 0 },
    ],
  };

  it('forces CPU when gpuLayers is 0', () => {
    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesBoth,
      loadParams: { backendPolicy: undefined, selectedBackendDevices: null },
      gpuLayers: 0,
      baseProfile,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        backendMode: 'cpu',
        nGpuLayers: 0,
        flashAttnType: 'off',
      }),
    ]);
  });

  it('returns NPU then CPU candidates for explicit NPU policy', () => {
    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesBoth,
      loadParams: { backendPolicy: 'npu', selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('npu');
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['npu', 'cpu']);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      backendMode: 'npu',
      nGpuLayers: 12,
      devices: ['HTP0'],
    }));
  });

  it('falls back to CPU for explicit NPU policy when NPU is unavailable (even if devices are discovered)', () => {
    const capabilitiesUntestedNpu: BackendCapabilitiesSummary = {
      discoveryUnavailable: false,
      cpu: { kind: 'cpu', label: 'CPU', available: true, deviceNames: [], backendNames: [], notes: [] },
      gpu: { kind: 'gpu', label: 'GPU', available: false, deviceNames: [], backendNames: [], notes: [] },
      npu: { kind: 'npu', label: 'NPU', available: false, deviceNames: ['HTP0'], backendNames: ['HTP'], notes: [] },
      rawDevices: [
        { backend: 'HTP', type: 'gpu', deviceName: 'HTP0 SM8350', maxMemorySize: 0 },
      ],
    };

    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesUntestedNpu,
      loadParams: { backendPolicy: 'npu', selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('auto');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'inference.backendPolicyReason.npuNotSupportedOnDevice',
    ]));
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['cpu']);
  });

  it('uses explicit selected devices for explicit NPU policy', () => {
    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesBoth,
      loadParams: { backendPolicy: 'npu', selectedBackendDevices: ['HTP0'] },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.candidates[0]).toEqual(expect.objectContaining({
      backendMode: 'npu',
      nGpuLayers: 12,
      devices: ['HTP0'],
    }));
  });

  it('returns GPU then CPU candidates for explicit GPU policy', () => {
    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesBoth,
      loadParams: { backendPolicy: 'gpu', selectedBackendDevices: ['Adreno GPU'] },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('gpu');
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['gpu', 'cpu']);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      nGpuLayers: 12,
    }));
  });

  it('falls back to CPU for explicit GPU policy when GPU is unavailable (even if devices are discovered)', () => {
    const capabilitiesUntestedGpu: BackendCapabilitiesSummary = {
      discoveryUnavailable: false,
      cpu: { kind: 'cpu', label: 'CPU', available: true, deviceNames: [], backendNames: [], notes: [] },
      gpu: { kind: 'gpu', label: 'GPU', available: false, deviceNames: ['GPUOpenCL'], backendNames: ['OpenCL'], notes: [] },
      npu: { kind: 'npu', label: 'NPU', available: false, deviceNames: [], backendNames: [], notes: [] },
      rawDevices: [
        { backend: 'OpenCL', type: 'gpu', deviceName: 'Adreno 660', maxMemorySize: 0 },
      ],
    };

    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesUntestedGpu,
      loadParams: { backendPolicy: 'gpu', selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('cpu');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'inference.backendPolicyReason.gpuNotSupportedOnDevice',
    ]));
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['cpu']);
  });

  it('returns CPU-only candidates for explicit GPU policy when GPU is known unavailable', () => {
    const capabilitiesNpuOnly: BackendCapabilitiesSummary = {
      discoveryUnavailable: false,
      cpu: { kind: 'cpu', label: 'CPU', available: true, deviceNames: [], backendNames: [], notes: [] },
      gpu: { kind: 'gpu', label: 'GPU', available: false, deviceNames: [], backendNames: [], notes: [] },
      npu: { kind: 'npu', label: 'NPU', available: true, deviceNames: ['HTP0'], backendNames: ['HTP'], notes: [] },
      rawDevices: [
        { backend: 'HTP', type: 'gpu', deviceName: 'HTP0', maxMemorySize: 0 },
      ],
    };

    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesNpuOnly,
      loadParams: { backendPolicy: 'gpu', selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('cpu');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'inference.backendPolicyReason.gpuRequestedNoDevicesDiscovered',
    ]));
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['cpu']);
  });

  it('falls back to AUTO (GPU-first) when NPU policy requested but unavailable', () => {
    const capabilitiesGpuOnly = {
      ...capabilitiesBoth,
      npu: { ...capabilitiesBoth.npu, available: false },
      rawDevices: [{ backend: 'OpenCL', type: 'gpu', deviceName: 'Adreno GPU', maxMemorySize: 0 }],
    };

    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesGpuOnly,
      loadParams: { backendPolicy: 'npu', selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('auto');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'inference.backendPolicyReason.npuNotSupportedOnDevice',
    ]));
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['gpu', 'cpu']);
  });

  it('returns NPU-first candidates for AUTO when NPU is available', () => {
    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesBoth,
      loadParams: { backendPolicy: undefined, selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('auto');
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['npu', 'gpu', 'cpu']);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      backendMode: 'npu',
      devices: ['HTP0'],
    }));
  });

  it('does not include GPU candidates for AUTO when GPU is known unavailable', () => {
    const capabilitiesNpuOnly: BackendCapabilitiesSummary = {
      discoveryUnavailable: false,
      cpu: { kind: 'cpu', label: 'CPU', available: true, deviceNames: [], backendNames: [], notes: [] },
      gpu: { kind: 'gpu', label: 'GPU', available: false, deviceNames: [], backendNames: [], notes: [] },
      npu: { kind: 'npu', label: 'NPU', available: true, deviceNames: ['HTP0'], backendNames: ['HTP'], notes: [] },
      rawDevices: [
        { backend: 'HTP', type: 'gpu', deviceName: 'HTP0', maxMemorySize: 0 },
      ],
    };

    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesNpuOnly,
      loadParams: { backendPolicy: undefined, selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('auto');
    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['npu', 'cpu']);
  });

  it('returns GPU-first candidates for AUTO when NPU is not available', () => {
    const capabilitiesGpuOnly = {
      ...capabilitiesBoth,
      npu: { ...capabilitiesBoth.npu, available: false },
      rawDevices: [{ backend: 'OpenCL', type: 'gpu', deviceName: 'Adreno GPU', maxMemorySize: 0 }],
    };

    const result = resolveInferenceProfileCandidates({
      capabilities: capabilitiesGpuOnly,
      loadParams: { backendPolicy: undefined, selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.candidates.map((candidate) => candidate.backendMode)).toEqual(['gpu', 'cpu']);
  });

  it('forces CPU and reports effective CPU when backend discovery is unavailable', () => {
    const result = resolveInferenceProfileCandidates({
      capabilities: null,
      loadParams: { backendPolicy: 'gpu', selectedBackendDevices: null },
      gpuLayers: 12,
      baseProfile,
    });

    expect(result.effectiveBackendPolicy).toBe('cpu');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'inference.backendPolicyReason.backendDiscoveryUnavailable',
    ]));
    expect(result.candidates).toEqual([
      expect.objectContaining({
        backendMode: 'cpu',
        nGpuLayers: 0,
        flashAttnType: 'off',
      }),
    ]);
  });
});
