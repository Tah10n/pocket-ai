import type { BackendCapabilitiesSummary } from './InferenceBackendService';
import type { ModelLoadParameters } from './SettingsStore';

export type ResolvedBackendMode = 'cpu' | 'gpu' | 'npu';

export interface ResolvedInferenceProfile {
  backendMode: ResolvedBackendMode;
  devices?: string[];
  nGpuLayers: number;
  nThreads?: number;
  cpuMask?: string;
  cpuStrict?: boolean;
  flashAttnType: 'auto' | 'on' | 'off';
  useMmap: boolean;
  useMlock: boolean;
  nBatch?: number;
  nUbatch?: number;
  kvUnified?: boolean;
  nParallel: number;
}

type NormalizedBackendPolicy = 'auto' | 'cpu' | 'gpu' | 'npu';

function normalizeBackendPolicy(policy: ModelLoadParameters['backendPolicy'] | null | undefined): NormalizedBackendPolicy {
  if (!policy || policy === 'auto') {
    return 'auto';
  }

  if (policy === 'cpu' || policy === 'gpu' || policy === 'npu') {
    return policy;
  }

  return 'auto';
}

function isSafeBackendDeviceSelector(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  // Device selectors are typically compact tokens like HTP0 / HTP*.
  // Avoid treating human-readable labels (often containing whitespace) as selectors.
  return !/\s/.test(normalized);
}

function clampNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

export function resolveInferenceProfileCandidates({
  capabilities,
  loadParams,
  gpuLayers,
  baseProfile,
}: {
  capabilities: BackendCapabilitiesSummary | null;
  loadParams: Pick<ModelLoadParameters, 'backendPolicy' | 'selectedBackendDevices'>;
  gpuLayers: number;
  baseProfile: Omit<ResolvedInferenceProfile, 'backendMode' | 'devices' | 'nGpuLayers'>;
}): {
  effectiveBackendPolicy: NormalizedBackendPolicy;
  candidates: ResolvedInferenceProfile[];
  reasons: string[];
} {
  const normalizedGpuLayers = clampNonNegativeInt(gpuLayers);
  const requestedBackendPolicy = normalizeBackendPolicy(loadParams.backendPolicy);
  const normalizedSelectedBackendDevices = Array.isArray(loadParams.selectedBackendDevices)
    ? loadParams.selectedBackendDevices
        .filter((device): device is string => typeof device === 'string')
        .map((device) => device.trim())
        .filter((device) => device.length > 0)
    : [];
  const uniqueSelectedBackendDevices = normalizedSelectedBackendDevices.length > 0
    ? Array.from(new Set(normalizedSelectedBackendDevices))
    : [];
  const resolvedSelectedNpuDevices = uniqueSelectedBackendDevices.filter(isSafeBackendDeviceSelector);
  const selectedNpuDevices = resolvedSelectedNpuDevices.length > 0 ? resolvedSelectedNpuDevices : null;

  // Capabilities are considered "known" when backend discovery ran and returned a definitive
  // availability snapshot (including the case where no accelerator devices exist).
  // When discovery is unavailable, we treat accelerator availability as unknown and avoid
  // attempting GPU/NPU init because some devices can crash natively.
  const discoveryUnavailable = capabilities?.discoveryUnavailable === true;
  const capabilitiesKnown = Boolean(capabilities && !discoveryUnavailable);
  const npuAvailable = capabilities?.npu.available === true;
  const gpuAvailable = capabilities?.gpu.available === true;

  const discoveredNpuDeviceNames = Array.isArray(capabilities?.npu.deviceNames)
    ? capabilities.npu.deviceNames
        .filter((device): device is string => typeof device === 'string')
        .map((device) => device.trim())
        .filter((device) => device.length > 0)
    : [];
  const normalizedDiscoveredNpu = Array.from(new Set(discoveredNpuDeviceNames));
  const hasDiscoveredNpuDevices = normalizedDiscoveredNpu.length > 0;
  const discoveredNpuSelectors = normalizedDiscoveredNpu.filter(isSafeBackendDeviceSelector);
  const defaultNpuDevices = discoveredNpuSelectors.length > 0 ? discoveredNpuSelectors : ['HTP*'];

  const discoveredGpuDeviceNames = Array.isArray(capabilities?.gpu.deviceNames)
    ? capabilities.gpu.deviceNames
        .filter((device): device is string => typeof device === 'string')
        .map((device) => device.trim())
        .filter((device) => device.length > 0)
    : [];
  const normalizedDiscoveredGpu = Array.from(new Set(discoveredGpuDeviceNames));
  const hasDiscoveredGpuDevices = normalizedDiscoveredGpu.length > 0;

  const reasons: string[] = [];
  let effectiveBackendPolicy: NormalizedBackendPolicy = requestedBackendPolicy;

  const shouldExplainDiscoveryUnavailable = !capabilitiesKnown
    && normalizedGpuLayers > 0
    && (
      requestedBackendPolicy === 'auto'
      || requestedBackendPolicy === 'gpu'
      || requestedBackendPolicy === 'npu'
    );

  if (shouldExplainDiscoveryUnavailable) {
    reasons.push('inference.backendPolicyReason.backendDiscoveryUnavailable');
  }

  // Normalize away explicit NPU preferences when we know the device does not expose an NPU backend.
  // When discovery is unavailable, the NPU attempt is skipped later for safety.
  if (requestedBackendPolicy === 'npu' && capabilitiesKnown && !npuAvailable) {
    reasons.push(hasDiscoveredNpuDevices
      ? 'inference.backendPolicyReason.npuNotSupportedOnDevice'
      : 'inference.backendPolicyReason.npuRequestedNoDevicesDiscovered');
    effectiveBackendPolicy = 'auto';
  }

  if (shouldExplainDiscoveryUnavailable) {
    return {
      // Backend discovery is unavailable (or failed), so we cannot safely attempt GPU/NPU init.
      // Force CPU as the effective policy to reflect what will actually be attempted.
      effectiveBackendPolicy: 'cpu',
      candidates: [
        {
          ...baseProfile,
          backendMode: 'cpu',
          nGpuLayers: 0,
          flashAttnType: 'off',
        },
      ],
      reasons,
    };
  }

  if (normalizedGpuLayers <= 0 || effectiveBackendPolicy === 'cpu') {
    return {
      effectiveBackendPolicy: 'cpu',
      candidates: [
        {
          ...baseProfile,
          backendMode: 'cpu',
          nGpuLayers: 0,
          flashAttnType: 'off',
        },
      ],
      reasons,
    };
  }

  const candidates: ResolvedInferenceProfile[] = [];

  if (effectiveBackendPolicy === 'npu') {
    if (!npuAvailable) {
      // Discovery is unavailable or confirmed no NPU devices: avoid attempting NPU init.
      if (capabilitiesKnown) {
        reasons.push(hasDiscoveredNpuDevices
          ? 'inference.backendPolicyReason.npuNotSupportedOnDevice'
          : 'inference.backendPolicyReason.npuRequestedNoDevicesDiscovered');
      }
      effectiveBackendPolicy = 'auto';
    } else {
      candidates.push({
        ...baseProfile,
        backendMode: 'npu',
        devices: selectedNpuDevices ?? defaultNpuDevices,
        nGpuLayers: normalizedGpuLayers,
      });
    }

    if (candidates.length > 0) {
      candidates.push({
        ...baseProfile,
        backendMode: 'cpu',
        nGpuLayers: 0,
        flashAttnType: 'off',
      });

      return { effectiveBackendPolicy, candidates, reasons };
    }
  }

  if (effectiveBackendPolicy === 'gpu') {
    if (!gpuAvailable) {
      // Discovery is unavailable or confirmed no GPU devices: avoid attempting GPU init.
      if (capabilitiesKnown) {
        reasons.push(hasDiscoveredGpuDevices
          ? 'inference.backendPolicyReason.gpuNotSupportedOnDevice'
          : 'inference.backendPolicyReason.gpuRequestedNoDevicesDiscovered');
      }
      return {
        // GPU policy cannot be satisfied on this device, so reflect the CPU fallback.
        effectiveBackendPolicy: 'cpu',
        candidates: [
          {
            ...baseProfile,
            backendMode: 'cpu',
            nGpuLayers: 0,
            flashAttnType: 'off',
          },
        ],
        reasons,
      };
    }

    candidates.push({
      ...baseProfile,
      backendMode: 'gpu',
      nGpuLayers: normalizedGpuLayers,
    });
    candidates.push({
      ...baseProfile,
      backendMode: 'cpu',
      nGpuLayers: 0,
      flashAttnType: 'off',
    });

    return { effectiveBackendPolicy, candidates, reasons };
  }

  // Auto: prefer NPU (when available), then GPU, then CPU.
  if (npuAvailable) {
    candidates.push({
      ...baseProfile,
      backendMode: 'npu',
      devices: defaultNpuDevices,
      nGpuLayers: normalizedGpuLayers,
    });
  }

  // Include a GPU candidate in AUTO only when backend discovery has confirmed the GPU path is
  // available. Some older devices can crash natively when initializing unsupported GPU backends.
  if (gpuAvailable) {
    candidates.push({
      ...baseProfile,
      backendMode: 'gpu',
      nGpuLayers: normalizedGpuLayers,
    });
  }
  candidates.push({
    ...baseProfile,
    backendMode: 'cpu',
    nGpuLayers: 0,
    flashAttnType: 'off',
  });

  return { effectiveBackendPolicy, candidates, reasons };
}
