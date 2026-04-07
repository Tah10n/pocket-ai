import type { ModelLoadParameters } from '../services/SettingsStore';

interface PersistedLoadProfileDiffOptions {
  draftContextSize: number;
  draftPersistedGpuLayers: number | null;
  draftKvCacheType: ModelLoadParameters['kvCacheType'];
  persistedLoadParams: Pick<ModelLoadParameters, 'contextSize' | 'gpuLayers' | 'kvCacheType'>;
}

export function hasPersistedLoadProfileChanges({
  draftContextSize,
  draftPersistedGpuLayers,
  draftKvCacheType,
  persistedLoadParams,
}: PersistedLoadProfileDiffOptions): boolean {
  return (
    draftContextSize !== persistedLoadParams.contextSize
    || draftPersistedGpuLayers !== (persistedLoadParams.gpuLayers ?? null)
    || draftKvCacheType !== persistedLoadParams.kvCacheType
  );
}
