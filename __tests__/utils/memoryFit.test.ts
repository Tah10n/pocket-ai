import { assessModelMemoryFit, estimateModelRuntimeBytes, resolveConservativeAvailableMemoryBudget } from '../../src/utils/memoryFit';
import { estimateMemoryFitFromModelSize } from '../../src/memory/estimator';

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
    const assessment = assessModelMemoryFit({
      modelSizeBytes: 100,
      totalMemoryBytes: 200,
      systemMemorySnapshot: {
        availableBytes: 100,
        freeBytes: 100,
        thresholdBytes: 0,
      },
    });

    expect(assessment).toEqual(
      expect.objectContaining({
        estimatedRuntimeBytes: 120,
        totalBudgetBytes: 160,
        availableBudgetBytes: 100,
        effectiveBudgetBytes: 100,
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
  });
});
