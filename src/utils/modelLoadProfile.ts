import type { ModelLoadParameters } from '../services/SettingsStore';

interface PersistedLoadProfileDiffOptions {
  draftContextSize: number;
  draftPersistedGpuLayers: number | null;
  draftKvCacheType: ModelLoadParameters['kvCacheType'];
  draftBackendPolicy: ModelLoadParameters['backendPolicy'] | null;
  persistedLoadParams: Pick<
    ModelLoadParameters,
    'contextSize' | 'gpuLayers' | 'kvCacheType' | 'backendPolicy'
  >;
}

type NormalizedBackendPolicy = Exclude<ModelLoadParameters['backendPolicy'], 'auto'> | undefined;

function normalizeBackendPolicy(policy: ModelLoadParameters['backendPolicy'] | null | undefined): NormalizedBackendPolicy {
  if (!policy || policy === 'auto') {
    return undefined;
  }

  return policy;
}

export function hasPersistedLoadProfileChanges({
  draftContextSize,
  draftPersistedGpuLayers,
  draftKvCacheType,
  draftBackendPolicy,
  persistedLoadParams,
}: PersistedLoadProfileDiffOptions): boolean {
  const persistedBackendPolicy = normalizeBackendPolicy(persistedLoadParams.backendPolicy);
  const nextBackendPolicy = normalizeBackendPolicy(draftBackendPolicy);

  return (
    draftContextSize !== persistedLoadParams.contextSize
    || draftPersistedGpuLayers !== (persistedLoadParams.gpuLayers ?? null)
    || draftKvCacheType !== persistedLoadParams.kvCacheType
    || nextBackendPolicy !== persistedBackendPolicy
  );
}
