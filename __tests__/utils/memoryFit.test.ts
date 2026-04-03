import { assessModelMemoryFit, estimateModelRuntimeBytes, resolveConservativeAvailableMemoryBudget } from '../../src/utils/memoryFit';

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
});
