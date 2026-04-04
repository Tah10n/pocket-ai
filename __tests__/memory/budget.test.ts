import { createMemoryBudget, resolveConservativeAvailableMemoryBudget } from '../../src/memory/budget';

describe('memory/budget', () => {
  it('derives conservative available budgets using threshold and free memory', () => {
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

  it('uses the soft total-RAM budget when no live snapshot is available', () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const { totalBudgetBytes, availableBudgetBytes, effectiveBudgetBytes } = createMemoryBudget({
      totalMemoryBytes,
      systemMemorySnapshot: null,
    });

    expect(totalBudgetBytes).toBe(Math.floor(totalMemoryBytes * 0.8));
    expect(availableBudgetBytes).toBeNull();
    expect(effectiveBudgetBytes).toBe(totalBudgetBytes);
  });

  it('computes effective budget as min(...) minus reserved bytes', () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const softTotalBudgetBytes = Math.floor(totalMemoryBytes * 0.8);
    const availableBytes = 6 * 1024 * 1024 * 1024;
    const freeBytes = 5 * 1024 * 1024 * 1024;
    const thresholdBytes = 256 * 1024 * 1024;
    const appUsedBytes = 512 * 1024 * 1024;

    const { effectiveBudgetBytes, budget } = createMemoryBudget({
      totalMemoryBytes,
      learnedSafeBudgetBytes: null,
      systemMemorySnapshot: {
        availableBytes,
        freeBytes,
        thresholdBytes,
        appUsedBytes,
        lowMemory: false,
        pressureLevel: 'normal',
      },
    });

    const liveCurrentBudgetBytes = resolveConservativeAvailableMemoryBudget({
      availableBytes,
      freeBytes,
      thresholdBytes,
      appUsedBytes,
    })!;
    expect(liveCurrentBudgetBytes).toBe(freeBytes);
    expect(budget.totalMemoryBytes).toBe(totalMemoryBytes);
    expect(budget.liveAvailableBytes).toBe(availableBytes);
    expect(budget.appResidentBytes).toBeUndefined();
    expect(budget.appPssBytes).toBeUndefined();

    const osReserveBytes = 512 * 1024 * 1024;
    const fragmentationGuardBytes = Math.round(totalMemoryBytes * 0.05);
    const reservedBytes = appUsedBytes + osReserveBytes + fragmentationGuardBytes;
    const expectedRawBudgetBytes = Math.min(softTotalBudgetBytes, liveCurrentBudgetBytes);
    expect(effectiveBudgetBytes).toBe(expectedRawBudgetBytes - reservedBytes);
  });

  it('caps effective budget with learned safe budget and inflates reserve on low-memory pressure', () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const learnedSafeBudgetBytes = 4 * 1024 * 1024 * 1024;
    const availableBytes = 6 * 1024 * 1024 * 1024;
    const freeBytes = 5 * 1024 * 1024 * 1024;
    const thresholdBytes = 256 * 1024 * 1024;
    const appUsedBytes = 512 * 1024 * 1024;

    const { effectiveBudgetBytes, budget } = createMemoryBudget({
      totalMemoryBytes,
      learnedSafeBudgetBytes,
      systemMemorySnapshot: {
        availableBytes,
        freeBytes,
        thresholdBytes,
        appUsedBytes,
        lowMemory: true,
        pressureLevel: 'critical',
      },
    });

    const osReserveBytes = 512 * 1024 * 1024;
    const fragmentationGuardBytes = Math.round(totalMemoryBytes * 0.05);
    const lowMemoryExtraReserveBytes = 256 * 1024 * 1024;
    const reservedBytes = appUsedBytes + osReserveBytes + fragmentationGuardBytes + lowMemoryExtraReserveBytes;
    const expectedRawBudgetBytes = Math.min(
      Math.floor(totalMemoryBytes * 0.8),
      freeBytes,
      learnedSafeBudgetBytes,
    );

    expect(budget.learnedSafeBudgetBytes).toBe(learnedSafeBudgetBytes);
    expect(effectiveBudgetBytes).toBe(expectedRawBudgetBytes - reservedBytes);
  });
});
