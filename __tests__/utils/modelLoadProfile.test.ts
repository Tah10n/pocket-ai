import { hasPersistedLoadProfileChanges } from '../../src/utils/modelLoadProfile';

describe('modelLoadProfile utilities', () => {
  it('treats a clamped draft context size as a pending persisted change', () => {
    expect(hasPersistedLoadProfileChanges({
      draftContextSize: 8192,
      draftPersistedGpuLayers: null,
      persistedLoadParams: {
        contextSize: 32768,
        gpuLayers: null,
      },
    })).toBe(true);
  });

  it('ignores drafts that already match the persisted profile', () => {
    expect(hasPersistedLoadProfileChanges({
      draftContextSize: 8192,
      draftPersistedGpuLayers: 12,
      persistedLoadParams: {
        contextSize: 8192,
        gpuLayers: 12,
      },
    })).toBe(false);
  });
});
