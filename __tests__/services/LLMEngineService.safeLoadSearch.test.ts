import {
  buildIntermediateGpuLayerCandidates,
  chooseSafeLoadProfileCandidate,
} from '../../src/services/LLMEngineService.safeLoadSearch';

describe('buildIntermediateGpuLayerCandidates', () => {
  it('samples zero, quarter, half, three-quarter, and ceiling layer counts', () => {
    expect(buildIntermediateGpuLayerCandidates(12)).toEqual([0, 1, 3, 6, 9, 12]);
  });

  it('deduplicates rounded candidates for small layer ceilings', () => {
    expect(buildIntermediateGpuLayerCandidates(2)).toEqual([0, 1, 2]);
  });

  it('normalizes unavailable GPU layer ceilings to a CPU-only candidate', () => {
    expect(buildIntermediateGpuLayerCandidates(-4)).toEqual([0]);
  });
});

describe('chooseSafeLoadProfileCandidate', () => {
  it('can choose an intermediate GPU profile when it preserves nearly the best context', () => {
    const result = chooseSafeLoadProfileCandidate([
      { contextTokens: 8192, gpuLayers: 0 },
      { contextTokens: 7680, gpuLayers: 6 },
      { contextTokens: 4096, gpuLayers: 12 },
    ], 512);

    expect(result).toEqual({ contextTokens: 7680, gpuLayers: 6 });
  });

  it('keeps the maximum-context profile when GPU candidates sacrifice too much context', () => {
    const result = chooseSafeLoadProfileCandidate([
      { contextTokens: 8192, gpuLayers: 0 },
      { contextTokens: 7168, gpuLayers: 6 },
      { contextTokens: 4096, gpuLayers: 12 },
    ], 512);

    expect(result).toEqual({ contextTokens: 8192, gpuLayers: 0 });
  });

  it('prefers higher GPU layers when candidates support the same context', () => {
    const result = chooseSafeLoadProfileCandidate([
      { contextTokens: 4096, gpuLayers: 0 },
      { contextTokens: 4096, gpuLayers: 3 },
    ]);

    expect(result).toEqual({ contextTokens: 4096, gpuLayers: 3 });
  });

  it('requires at least one candidate', () => {
    expect(() => chooseSafeLoadProfileCandidate([])).toThrow(
      'Cannot choose a safe-load profile without candidates.',
    );
  });
});
