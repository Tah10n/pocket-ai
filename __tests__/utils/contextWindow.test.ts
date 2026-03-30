import {
  ESTIMATED_CONTEXT_BYTES_PER_TOKEN,
  resolveContextWindowCeiling,
  clampContextWindowTokens,
} from '../../src/utils/contextWindow';

describe('contextWindow utilities', () => {
  it('respects the model-reported context ceiling', () => {
    expect(resolveContextWindowCeiling({
      modelMaxContextTokens: 4096,
      modelSizeBytes: 512 * 1024 * 1024,
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    })).toBe(4096);
  });

  it('reduces the ceiling when RAM headroom is tighter than the model limit', () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const desiredCeiling = 4096;
    const modelSizeBytes = Math.floor(
      ((totalMemoryBytes * 0.8) - desiredCeiling * ESTIMATED_CONTEXT_BYTES_PER_TOKEN) / 1.2,
    );

    expect(resolveContextWindowCeiling({
      modelMaxContextTokens: 8192,
      modelSizeBytes,
      totalMemoryBytes,
    })).toBe(desiredCeiling);
  });

  it('allows ceilings above 8192 when the model and RAM support it', () => {
    expect(resolveContextWindowCeiling({
      modelMaxContextTokens: 32768,
      modelSizeBytes: 512 * 1024 * 1024,
      totalMemoryBytes: 12 * 1024 * 1024 * 1024,
    })).toBe(32768);
  });

  it('clamps requested values down to the resolved ceiling', () => {
    expect(clampContextWindowTokens(8192, 4096)).toBe(4096);
    expect(clampContextWindowTokens(3000, 4096)).toBe(2560);
  });
});
