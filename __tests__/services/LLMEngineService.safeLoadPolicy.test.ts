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

  it('hard-blocks high-confidence likely OOM only with positive effective budget evidence', () => {
    const computeSafeProfile = jest.fn(() => ({
      safeLoadProfile: { contextTokens: 1024, gpuLayers: 0 },
      safeMemoryFit: createMemoryFit(),
    }));

    expect(() => resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      memoryFit: createMemoryFit({
        decision: 'likely_oom',
        confidence: 'high',
        requiredBytes: 1_500_000_000,
        effectiveBudgetBytes: 1_000_000_000,
      }),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 1_000_000_000,
        thresholdBytes: 0,
        lowMemory: false,
        pressureLevel: 'normal',
      },
      computeSafeProfile,
    })).toThrow('Not enough memory to load this model.');

    expect(baseInput.onHardBlock).toHaveBeenCalledWith('high');
    expect(computeSafeProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['non-finite', Number.NaN],
  ])('soft-warns instead of hard-blocking high-confidence likely OOM with %s effective budget evidence', (_caseName, effectiveBudgetBytes) => {
    const computeSafeProfile = jest.fn(() => ({
      safeLoadProfile: { contextTokens: 1024, gpuLayers: 0 },
      safeMemoryFit: createMemoryFit({
        decision: 'borderline',
        confidence: 'medium',
        requiredBytes: 1_000_000_000,
        effectiveBudgetBytes: 800_000_000,
      }),
    }));

    let thrown: unknown;
    try {
      resolveSafeLoadPolicyOrThrow({
        ...baseInput,
        memoryFit: createMemoryFit({
          decision: 'likely_oom',
          confidence: 'high',
          requiredBytes: 1_500_000_000,
          effectiveBudgetBytes,
          budget: {
            totalMemoryBytes: 8_000_000_000,
            effectiveBudgetBytes,
          },
        }),
        systemMemorySnapshot: {
          totalBytes: 8_000_000_000,
          availableBytes: 900_000_000,
          thresholdBytes: 100_000_000,
          lowMemory: false,
          pressureLevel: 'normal',
        },
        computeSafeProfile,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'model_memory_warning' });
    expect(baseInput.onHardBlock).not.toHaveBeenCalled();
    expect(computeSafeProfile).toHaveBeenCalledTimes(1);
  });

  it('treats an exact effective-budget fit as safe without computing a safe profile', () => {
    const computeSafeProfile = jest.fn(() => ({
      safeLoadProfile: { contextTokens: 1024, gpuLayers: 0 },
      safeMemoryFit: createMemoryFit({
        decision: 'fits_low_confidence',
        requiredBytes: 800_000_000,
        effectiveBudgetBytes: 1_000_000_000,
      }),
    }));

    const result = resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      memoryFit: createMemoryFit({
        requiredBytes: 1_000_000_000,
        effectiveBudgetBytes: 1_000_000_000,
      }),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 1_000_000_000,
        thresholdBytes: 0,
        lowMemory: false,
        pressureLevel: 'normal',
      },
      computeSafeProfile,
    });

    expect(result.exceedsEffectiveBudget).toBe(false);
    expect(result.safeLoadProfile).toBeNull();
    expect(result.safeMemoryFit).toBeNull();
    expect(result.shouldAutoUseSafeLoadProfile).toBe(false);
    expect(result.shouldUseSafeLoadProfile).toBe(false);
    expect(result.finalContextSize).toBe(baseInput.resolvedContextSize);
    expect(result.gpuLayers).toBe(baseInput.requestedGpuLayers);
    expect(computeSafeProfile).not.toHaveBeenCalled();
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

  it('uses recently-unloaded model reclaim credit for safe-load decisions', () => {
    const result = resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      memoryFit: createMemoryFit(),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 900_000_000,
        reclaimableBytes: 350_000_000,
        thresholdBytes: 100_000_000,
        lowMemory: false,
        pressureLevel: 'normal',
      },
      computeSafeProfile: () => ({
        safeLoadProfile: { contextTokens: 1024, gpuLayers: 0 },
        safeMemoryFit: createMemoryFit({
          decision: 'fits_low_confidence',
          requiredBytes: 1_000_000_000,
          effectiveBudgetBytes: 1_100_000_000,
        }),
      }),
    });

    expect(result.availableBudgetBytes).toBe(1_150_000_000);
    expect(result.shouldAutoUseSafeLoadProfile).toBe(true);
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

  it('ignores a zero process availability value instead of treating it as a hard cap', () => {
    const result = resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      memoryFit: createMemoryFit(),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 2_000_000_000,
        processAvailableBytes: 0,
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
    });

    expect(result.availableBudgetBytes).toBe(2_000_000_000);
    expect(result.shouldAutoUseSafeLoadProfile).toBe(true);
  });

  it('hard-blocks a minimum-context-only safe profile unless unsafe load is allowed', () => {
    let thrown: unknown;
    try {
      resolveSafeLoadPolicyOrThrow({
        ...baseInput,
        memoryFit: createMemoryFit({
          decision: 'borderline',
          confidence: 'high',
        }),
        systemMemorySnapshot: {
          totalBytes: 8_000_000_000,
          availableBytes: 900_000_000,
          thresholdBytes: 100_000_000,
          lowMemory: false,
          pressureLevel: 'normal',
        },
        computeSafeProfile: () => ({
          safeLoadProfile: { contextTokens: 512, gpuLayers: 0 },
          safeMemoryFit: createMemoryFit({
            decision: 'fits_low_confidence',
            confidence: 'medium',
            requiredBytes: 900_000_000,
            effectiveBudgetBytes: 1_000_000_000,
          }),
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'model_load_blocked',
      message: 'Loading is disabled for this model because it only fits at the minimum context window.',
    });
    expect(baseInput.onHardBlock).toHaveBeenCalledWith('high');
  });

  it('allows unsafe loading to continue with a minimum-context-only safe profile', () => {
    const result = resolveSafeLoadPolicyOrThrow({
      ...baseInput,
      allowUnsafeMemoryLoad: true,
      memoryFit: createMemoryFit({
        decision: 'borderline',
        confidence: 'high',
      }),
      systemMemorySnapshot: {
        totalBytes: 8_000_000_000,
        availableBytes: 900_000_000,
        thresholdBytes: 100_000_000,
        lowMemory: false,
        pressureLevel: 'normal',
      },
      computeSafeProfile: () => ({
        safeLoadProfile: { contextTokens: 512, gpuLayers: 0 },
        safeMemoryFit: createMemoryFit({
          decision: 'fits_low_confidence',
          confidence: 'medium',
          requiredBytes: 900_000_000,
          effectiveBudgetBytes: 1_000_000_000,
        }),
      }),
    });

    expect(result.shouldUseSafeLoadProfile).toBe(true);
    expect(result.safeLoadProfile).toEqual({ contextTokens: 512, gpuLayers: 0 });
    expect(result.finalContextSize).toBe(512);
    expect(result.gpuLayers).toBe(0);
    expect(baseInput.onHardBlock).not.toHaveBeenCalled();
  });

  it('reports insufficient memory when the minimum-context safe profile still exceeds budget', () => {
    let thrown: unknown;
    try {
      resolveSafeLoadPolicyOrThrow({
        ...baseInput,
        allowUnsafeMemoryLoad: true,
        memoryFit: createMemoryFit({
          decision: 'borderline',
          confidence: 'high',
        }),
        systemMemorySnapshot: {
          totalBytes: 8_000_000_000,
          availableBytes: 900_000_000,
          thresholdBytes: 100_000_000,
          lowMemory: false,
          pressureLevel: 'normal',
        },
        computeSafeProfile: () => ({
          safeLoadProfile: { contextTokens: 512, gpuLayers: 0 },
          safeMemoryFit: createMemoryFit({
            decision: 'borderline',
            confidence: 'high',
            requiredBytes: 1_000_000_000,
            effectiveBudgetBytes: 800_000_000,
          }),
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'model_memory_insufficient',
      message: 'Not enough memory to load this model, even at the minimum context window.',
    });
  });

  it('reports insufficient memory when the effective context ceiling is already the minimum', () => {
    let thrown: unknown;
    try {
      resolveSafeLoadPolicyOrThrow({
        ...baseInput,
        allowUnsafeMemoryLoad: true,
        resolvedContextSize: 512,
        configuredContextCeilingTokens: 512,
        modelContextCeilingTokens: 512,
        memoryFit: createMemoryFit({
          decision: 'borderline',
          confidence: 'high',
        }),
        systemMemorySnapshot: {
          totalBytes: 8_000_000_000,
          availableBytes: 900_000_000,
          thresholdBytes: 100_000_000,
          lowMemory: false,
          pressureLevel: 'normal',
        },
        computeSafeProfile: () => ({
          safeLoadProfile: { contextTokens: 512, gpuLayers: 0 },
          safeMemoryFit: createMemoryFit({
            decision: 'borderline',
            confidence: 'high',
            requiredBytes: 1_000_000_000,
            effectiveBudgetBytes: 800_000_000,
          }),
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'model_memory_insufficient',
      details: expect.objectContaining({
        safeLoadProfile: { contextTokens: 512, gpuLayers: 0 },
      }),
    });
  });

  it('soft-warns instead of hard-blocking a minimum-context profile without positive effective budget evidence', () => {
    let thrown: unknown;
    try {
      resolveSafeLoadPolicyOrThrow({
        ...baseInput,
        memoryFit: createMemoryFit({
          decision: 'borderline',
          confidence: 'high',
        }),
        systemMemorySnapshot: {
          totalBytes: 8_000_000_000,
          availableBytes: 900_000_000,
          thresholdBytes: 100_000_000,
          lowMemory: false,
          pressureLevel: 'normal',
        },
        computeSafeProfile: () => ({
          safeLoadProfile: { contextTokens: 512, gpuLayers: 0 },
          safeMemoryFit: createMemoryFit({
            decision: 'likely_oom',
            confidence: 'high',
            requiredBytes: 1_000_000_000,
            effectiveBudgetBytes: 0,
            budget: {
              totalMemoryBytes: 8_000_000_000,
              effectiveBudgetBytes: 0,
            },
          }),
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'model_memory_warning' });
    expect(baseInput.onHardBlock).not.toHaveBeenCalled();
  });
});
