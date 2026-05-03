import type { MemoryFitResult } from '../../src/memory/types';
import { resolveSafeLoadPolicyOrThrow } from '../../src/services/LLMEngineService.safeLoadPolicy';

function createMemoryFit(overrides: Partial<MemoryFitResult> = {}): MemoryFitResult {
  return {
    decision: 'borderline',
    confidence: 'medium',
    requiredBytes: 1_500_000_000,
    effectiveBudgetBytes: 1_000_000_000,
    breakdown: {
      weightsBytes: 1_000_000_000,
      kvCacheBytes: 100_000_000,
      computeBytes: 100_000_000,
      multimodalBytes: 0,
      overheadBytes: 100_000_000,
      safetyMarginBytes: 200_000_000,
      ...overrides.breakdown,
    },
    budget: {
      totalMemoryBytes: 8_000_000_000,
      effectiveBudgetBytes: 1_000_000_000,
      ...overrides.budget,
    },
    recommendations: [],
    ...overrides,
  };
}

describe('resolveSafeLoadPolicyOrThrow', () => {
  const baseInput = {
    modelId: 'test/model',
    allowUnsafeMemoryLoad: false,
    resolvedModelSizeBytes: 1_000_000_000,
    resolvedTotalMemoryBytes: 8_000_000_000,
    lowMemorySignal: false,
    resolvedContextSize: 4096,
    requestedGpuLayers: 12,
    configuredContextCeilingTokens: 8192,
    modelContextCeilingTokens: 8192,
    onHardBlock: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto-selects a safe profile when reclaimable availability fits despite low free memory', () => {
    const result = resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      memoryFit: createMemoryFit(),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 2_000_000_000,
        freeBytes: 100_000_000,
        thresholdBytes: 0,
        lowMemory: false,
        pressureLevel: 'normal',
      },
      computeSafeProfile: () => ({
        safeLoadProfile: { contextTokens: 1024, gpuLayers: 0 },
        safeMemoryFit: createMemoryFit({
          decision: 'fits_low_confidence',
          requiredBytes: 1_000_000_000,
          effectiveBudgetBytes: 1_500_000_000,
        }),
      }),
    });

    expect(result.availableBudgetBytes).toBe(2_000_000_000);
    expect(result.shouldAutoUseSafeLoadProfile).toBe(true);
    expect(result.shouldUseSafeLoadProfile).toBe(true);
  });

  it('keeps critical pressure strict by capping the safe-load budget to free memory', () => {
    expect(() => resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      memoryFit: createMemoryFit(),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 2_000_000_000,
        freeBytes: 100_000_000,
        thresholdBytes: 0,
        lowMemory: false,
        pressureLevel: 'critical',
      },
      computeSafeProfile: () => ({
        safeLoadProfile: { contextTokens: 1024, gpuLayers: 0 },
        safeMemoryFit: createMemoryFit({
          decision: 'fits_low_confidence',
          requiredBytes: 1_000_000_000,
          effectiveBudgetBytes: 1_500_000_000,
        }),
      }),
    })).toThrow('Model may not fit in memory.');
  });

  it('caps safe-load decisions by process availability when the platform provides it', () => {
    expect(() => resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      memoryFit: createMemoryFit(),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 2_000_000_000,
        processAvailableBytes: 700_000_000,
        freeBytes: 2_000_000_000,
        thresholdBytes: 0,
        lowMemory: false,
        pressureLevel: 'normal',
      },
      computeSafeProfile: () => ({
        safeLoadProfile: { contextTokens: 1024, gpuLayers: 0 },
        safeMemoryFit: createMemoryFit({
          decision: 'fits_low_confidence',
          requiredBytes: 1_000_000_000,
          effectiveBudgetBytes: 1_500_000_000,
        }),
      }),
    })).toThrow('Model may not fit in memory.');
  });
});
