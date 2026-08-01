import {
  assessModelMemoryFit,
  estimateModelRuntimeBytes,
  getModelMemoryFitInputSizeBytes,
  resolveConservativeAvailableMemoryBudget,
  UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES,
} from '../../src/utils/memoryFit';
import { estimateAccurateMemoryFit, estimateFastMemoryFit, estimateMemoryFitFromModelSize } from '../../src/memory/estimator';

describe('memoryFit', () => {
  it('estimates runtime bytes with overhead', () => {
    expect(estimateModelRuntimeBytes(100)).toBe(120);
  });

  it('includes projector bytes in simple memory-fit input size', () => {
    expect(getModelMemoryFitInputSizeBytes({
      modelSizeBytes: 100,
      projectorSizeBytes: 25,
    })).toBe(125);

    expect(getModelMemoryFitInputSizeBytes({
      modelSizeBytes: 100,
      projectorSizeBytes: null,
    })).toBe(100);

    expect(getModelMemoryFitInputSizeBytes({
      modelSizeBytes: 100,
      projectorSizeBytes: null,
      hasUnknownSizeProjector: true,
    })).toBe(100 + UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES);
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
    })).toBe(80);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      freeBytes: 60,
      thresholdBytes: 20,
    }, { strictFreeCap: true })).toBe(60);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      processAvailableBytes: 70,
      freeBytes: 20,
      thresholdBytes: 10,
    })).toBe(70);
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
    const fragmentationGuardBytes = Math.round(totalMemoryBytes * 0.05);
    const expectedEffectiveBudgetBytes = availableBytes - fragmentationGuardBytes;

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

  it('assesses fits-in-ram against model plus projector bytes', () => {
    const assessment = assessModelMemoryFit({
      modelSizeBytes: 100,
      projectorSizeBytes: 25,
      totalMemoryBytes: 500,
    });

    expect(assessment).toEqual(expect.objectContaining({
      estimatedRuntimeBytes: 150,
      fitsInRam: true,
    }));
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

    const fastEstimateTotalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const fastEstimateModelSizeBytes = 2 * 1024 * 1024 * 1024;

    expect(estimateFastMemoryFit({
      modelSizeBytes: fastEstimateModelSizeBytes,
      totalMemoryBytes: fastEstimateTotalMemoryBytes,
      metadataTrust: 'trusted_remote',
    })).toEqual(expect.objectContaining({
      decision: 'fits_high_confidence',
      confidence: 'medium',
    }));

    expect(estimateFastMemoryFit({
      modelSizeBytes: fastEstimateModelSizeBytes,
      totalMemoryBytes: fastEstimateTotalMemoryBytes,
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

  it.each([
    ['stateCacheBudgetMb', 64],
    ['state_cache_budget_mb', 128],
    ['stateCacheBudgetMb', 160],
  ] as const)('accounts for the full %s hard cap exactly once at %i MiB', (alias, budgetMb) => {
    const createFit = (runtimeParams: Record<string, unknown>) => estimateAccurateMemoryFit({
      input: {
        modelSizeBytes: 1_000_000_000,
        verifiedFileSizeBytes: 1_000_000_000,
        metadataTrust: 'verified_local',
        ggufMetadata: {
          'general.architecture': 'mamba',
          'mamba.block_count': 2,
          'mamba.attention.head_count_kv': 4,
          'mamba.embedding_length': 64,
        },
        runtimeParams: {
          contextTokens: 128,
          cacheTypeK: 'f16',
          cacheTypeV: 'f16',
          gpuLayers: 0,
          useMmap: false,
          ...runtimeParams,
        },
        snapshot: {
          timestampMs: 1,
          platform: 'android',
          totalBytes: 8 * 1024 * 1024 * 1024,
          availableBytes: 6 * 1024 * 1024 * 1024,
          usedBytes: 2 * 1024 * 1024 * 1024,
          appUsedBytes: 256 * 1024 * 1024,
          lowMemory: false,
          pressureLevel: 'normal',
          thresholdBytes: 128 * 1024 * 1024,
        },
      },
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    });
    const baseFit = createFit({ stateCacheBudgetMb: 0 });
    const cacheFit = createFit({ [alias]: budgetMb });
    const expectedBytes = budgetMb * 1024 * 1024;

    expect(cacheFit.breakdown.promptStateCacheBytes).toBe(expectedBytes);
    expect(cacheFit.requiredBytes - baseFit.requiredBytes).toBe(expectedBytes);
  });

  it('does not scale the prompt state cache hard cap with calibration factors', () => {
    const fit = estimateAccurateMemoryFit({
      input: {
        modelSizeBytes: 1_000_000_000,
        verifiedFileSizeBytes: 1_000_000_000,
        metadataTrust: 'verified_local',
        ggufMetadata: {
          'general.architecture': 'mamba',
        },
        runtimeParams: {
          stateCacheBudgetMb: 160,
        },
        calibrationRecord: {
          key: 'calibrated-profile',
          sampleCount: 4,
          successCount: 4,
          failureCount: 0,
          weightsCorrectionFactor: 0.9,
          computeCorrectionFactor: 0.8,
          overheadCorrectionFactor: 0.8,
          failurePenaltyFactor: 1,
          lastObservedAtMs: Date.now(),
        },
      },
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    });

    expect(fit.breakdown.promptStateCacheBytes).toBe(160 * 1024 * 1024);
  });

  it('keeps fast catalog estimates cache-free until runtime policy is known', () => {
    const fit = estimateFastMemoryFit({
      modelSizeBytes: 1_000_000_000,
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
      metadataTrust: 'trusted_remote',
      ggufMetadata: { 'general.architecture': 'mamba' },
    });

    expect(fit.breakdown.promptStateCacheBytes).toBe(0);
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

  it('returns unknown for accurate estimates when effective budget evidence is zero', () => {
    const result = estimateAccurateMemoryFit({
      input: {
        modelSizeBytes: 1_000_000_000,
        verifiedFileSizeBytes: 1_000_000_000,
        metadataTrust: 'verified_local',
        runtimeParams: {},
        snapshot: {
          timestampMs: 0,
          platform: 'android',
          totalBytes: 8_000_000_000,
          availableBytes: 100_000_000,
          usedBytes: 7_900_000_000,
          appUsedBytes: 500_000_000,
          lowMemory: false,
          pressureLevel: 'normal',
          thresholdBytes: 100_000_000,
        },
      },
      totalMemoryBytes: 8_000_000_000,
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'unknown',
      confidence: 'low',
      effectiveBudgetBytes: 0,
    }));
  });
});
