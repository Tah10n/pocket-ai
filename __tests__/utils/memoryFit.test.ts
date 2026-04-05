import { assessModelMemoryFit, estimateModelRuntimeBytes, resolveConservativeAvailableMemoryBudget } from '../../src/utils/memoryFit';
import { estimateAccurateMemoryFit, estimateFastMemoryFit, estimateMemoryFitFromModelSize } from '../../src/memory/estimator';

describe('memoryFit', () => {
  it('estimates runtime bytes with overhead', () => {
    expect(estimateModelRuntimeBytes(100)).toBe(120);
  });

  it('derives conservative available memory budgets', () => {
    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 0,
      freeBytes: 10,
      thresholdBytes: 1,
    })).toBeNull();

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      freeBytes: undefined,
      thresholdBytes: 20,
    })).toBe(80);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      freeBytes: 60,
      thresholdBytes: 20,
    })).toBe(60);
  });

  it('assesses fits-in-ram using total and available budgets', () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const availableBytes = 5 * 1024 * 1024 * 1024;
    const modelSizeBytes = 6 * 1024 * 1024 * 1024;
    const assessment = assessModelMemoryFit({
      modelSizeBytes,
      totalMemoryBytes,
      systemMemorySnapshot: {
        availableBytes,
        freeBytes: availableBytes,
        thresholdBytes: 0,
      },
    });

    const softTotalBudgetBytes = Math.floor(totalMemoryBytes * 0.8);
    const osReserveBytes = 512 * 1024 * 1024;
    const fragmentationGuardBytes = Math.round(totalMemoryBytes * 0.05);
    const reservedBytes = osReserveBytes + fragmentationGuardBytes;
    const expectedEffectiveBudgetBytes = availableBytes - reservedBytes;

    expect(assessment).toEqual(
      expect.objectContaining({
        estimatedRuntimeBytes: expect.any(Number),
        totalBudgetBytes: softTotalBudgetBytes,
        availableBudgetBytes: availableBytes,
        effectiveBudgetBytes: expectedEffectiveBudgetBytes,
        fitsInRam: false,
      }),
    );
  });

  it('returns null for invalid inputs', () => {
    expect(assessModelMemoryFit({
      modelSizeBytes: 0,
      totalMemoryBytes: 10,
    })).toBeNull();

    expect(assessModelMemoryFit({
      modelSizeBytes: 10,
      totalMemoryBytes: 0,
    })).toBeNull();
  });

  it('returns a structured decision model for fast estimates', () => {
    expect(estimateMemoryFitFromModelSize({
      modelSizeBytes: 100,
      totalMemoryBytes: 200,
      systemMemorySnapshot: null,
    })).toEqual(expect.objectContaining({
      decision: 'fits_high_confidence',
      confidence: 'medium',
    }));

    expect(estimateFastMemoryFit({
      modelSizeBytes: 100,
      totalMemoryBytes: 200,
      metadataTrust: 'trusted_remote',
    })).toEqual(expect.objectContaining({
      decision: 'fits_high_confidence',
      confidence: 'medium',
    }));

    expect(estimateFastMemoryFit({
      modelSizeBytes: 100,
      totalMemoryBytes: 200,
      metadataTrust: 'inferred',
    })).toEqual(expect.objectContaining({
      decision: 'fits_low_confidence',
      confidence: 'low',
    }));

    expect(estimateMemoryFitFromModelSize({
      modelSizeBytes: 100,
      totalMemoryBytes: 130,
      systemMemorySnapshot: null,
    })).toEqual(expect.objectContaining({
      decision: 'borderline',
    }));

    expect(estimateMemoryFitFromModelSize({
      modelSizeBytes: 100,
      totalMemoryBytes: 100,
      systemMemorySnapshot: null,
    })).toEqual(expect.objectContaining({
      decision: 'likely_oom',
    }));

    expect(estimateMemoryFitFromModelSize({
      modelSizeBytes: 0,
      totalMemoryBytes: 200,
      systemMemorySnapshot: null,
    })).toEqual(expect.objectContaining({
      decision: 'unknown',
      confidence: 'low',
    }));

    expect(estimateFastMemoryFit({
      modelSizeBytes: null,
      totalMemoryBytes: 200,
      metadataTrust: 'unknown',
    })).toEqual(expect.objectContaining({
      decision: 'unknown',
      confidence: 'low',
    }));
  });

  it('computes a component breakdown for accurate preflight estimates', () => {
    const result = estimateAccurateMemoryFit({
      input: {
        modelSizeBytes: 1_000_000_000,
        verifiedFileSizeBytes: 1_000_000_000,
        multimodalSizeBytes: 100_000_000,
        metadataTrust: 'verified_local',
        ggufMetadata: {
          n_layers: 2,
          n_head_kv: 4,
          n_embd_head_k: 8,
          n_embd_head_v: 8,
          sliding_window: 64,
        },
        runtimeParams: {
          contextTokens: 128,
          cacheTypeK: 'f16',
          cacheTypeV: 'f16',
          gpuLayers: 0,
        },
      },
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'fits_high_confidence',
      confidence: 'medium',
      requiredBytes: expect.any(Number),
      breakdown: expect.objectContaining({
        weightsBytes: 1_000_000_000,
        kvCacheBytes: 16384, // 64 * 2 * 4 * (8*2 + 8*2)
        multimodalBytes: 100_000_000,
      }),
    }));
  });

  it('returns unknown for accurate estimates when total memory is missing', () => {
    const result = estimateAccurateMemoryFit({
      input: {
        modelSizeBytes: 1_000_000_000,
        metadataTrust: 'unknown',
        runtimeParams: {},
      },
      totalMemoryBytes: null,
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'unknown',
      confidence: 'low',
      budget: expect.objectContaining({
        totalMemoryBytes: 0,
      }),
    }));
  });
});
