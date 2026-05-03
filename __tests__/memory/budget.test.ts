import { createMemoryBudget, resolveConservativeAvailableMemoryBudget } from '../../src/memory/budget';

describe('memory/budget', () => {
  it('derives normal available budgets from reclaimable availability instead of free memory', () => {
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
  });

  it('uses free memory as a strict cap only for explicit or emergency budgets', () => {
    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      freeBytes: 60,
      thresholdBytes: 20,
    }, { strictFreeCap: true })).toBe(60);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      freeBytes: 0,
      thresholdBytes: 20,
    }, { strictFreeCap: true })).toBe(0);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      freeBytes: 60,
      thresholdBytes: 20,
      lowMemory: true,
      pressureLevel: 'normal',
    })).toBe(60);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      freeBytes: 60,
      thresholdBytes: 20,
      lowMemory: false,
      pressureLevel: 'critical',
    })).toBe(60);
  });

  it('caps normal live budgets by process-specific availability when present', () => {
    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      processAvailableBytes: 70,
      freeBytes: 20,
      thresholdBytes: 10,
      lowMemory: false,
      pressureLevel: 'normal',
    })).toBe(70);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      processAvailableBytes: 120,
      freeBytes: 20,
      thresholdBytes: 10,
      lowMemory: false,
      pressureLevel: 'normal',
    })).toBe(90);

    expect(resolveConservativeAvailableMemoryBudget({
      availableBytes: 100,
      processAvailableBytes: 0,
      freeBytes: 20,
      thresholdBytes: 10,
      lowMemory: false,
      pressureLevel: 'normal',
    })).toBe(90);
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
    expect(liveCurrentBudgetBytes).toBe(availableBytes - thresholdBytes);
    expect(budget.totalMemoryBytes).toBe(totalMemoryBytes);
    expect(budget.liveAvailableBytes).toBe(availableBytes);
    expect(budget.appResidentBytes).toBeUndefined();
    expect(budget.appPssBytes).toBeUndefined();

    const fragmentationGuardBytes = Math.round(totalMemoryBytes * 0.05);
    const reservedBytes = fragmentationGuardBytes;
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

    const fragmentationGuardBytes = Math.round(totalMemoryBytes * 0.05);
    const lowMemoryExtraReserveBytes = 256 * 1024 * 1024;
    const reservedBytes = fragmentationGuardBytes + lowMemoryExtraReserveBytes;
    const expectedRawBudgetBytes = Math.min(
      Math.floor(totalMemoryBytes * 0.8),
      freeBytes,
      learnedSafeBudgetBytes,
    );

    expect(budget.learnedSafeBudgetBytes).toBe(learnedSafeBudgetBytes);
    expect(effectiveBudgetBytes).toBe(expectedRawBudgetBytes - reservedBytes);
  });

  it('inflates warning-pressure reserve without hard-capping by free memory', () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const availableBytes = 6 * 1024 * 1024 * 1024;
    const freeBytes = 512 * 1024 * 1024;
    const thresholdBytes = 256 * 1024 * 1024;

    const { availableBudgetBytes, effectiveBudgetBytes } = createMemoryBudget({
      totalMemoryBytes,
      systemMemorySnapshot: {
        availableBytes,
        freeBytes,
        thresholdBytes,
        lowMemory: false,
        pressureLevel: 'warning',
      },
    });

    const liveCurrentBudgetBytes = availableBytes - thresholdBytes;
    const fragmentationGuardBytes = Math.round(totalMemoryBytes * 0.05);
    const lowMemoryExtraReserveBytes = 256 * 1024 * 1024;

    expect(availableBudgetBytes).toBe(liveCurrentBudgetBytes);
    expect(effectiveBudgetBytes).toBe(
      liveCurrentBudgetBytes - fragmentationGuardBytes - lowMemoryExtraReserveBytes,
    );
  });
});
