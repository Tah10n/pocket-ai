import type { ModelLoadParameters } from '../services/SettingsStore';

interface PersistedLoadProfileDiffOptions {
  draftContextSize: number;
  draftPersistedGpuLayers: number | null;
  persistedLoadParams: Pick<ModelLoadParameters, 'contextSize' | 'gpuLayers'>;
}

export function hasPersistedLoadProfileChanges({
  draftContextSize,
  draftPersistedGpuLayers,
  persistedLoadParams,
}: PersistedLoadProfileDiffOptions): boolean {
  return (
    draftContextSize !== persistedLoadParams.contextSize
    || draftPersistedGpuLayers !== (persistedLoadParams.gpuLayers ?? null)
  );
}
