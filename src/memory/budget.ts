import type { SystemMemorySnapshot } from '../services/SystemMetricsService';
import type { MemoryBudget } from './types';

export const DEFAULT_TOTAL_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
export const FITS_IN_RAM_HEADROOM_RATIO = 0.8;

export type MemoryBudgetSnapshot = Pick<SystemMemorySnapshot, 'availableBytes' | 'freeBytes' | 'thresholdBytes'>;

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function resolveConservativeAvailableMemoryBudget(snapshot: MemoryBudgetSnapshot): number | null {
  if (!isFinitePositiveNumber(snapshot.availableBytes)) {
    return null;
  }

  const thresholdBytes = isFinitePositiveNumber(snapshot.thresholdBytes) ? snapshot.thresholdBytes : 0;
  const thresholdAdjustedAvailableBytes = Math.max(snapshot.availableBytes - thresholdBytes, 0);
  const strictFreeBytes = isFinitePositiveNumber(snapshot.freeBytes) ? snapshot.freeBytes : null;

  if (strictFreeBytes === null) {
    return thresholdAdjustedAvailableBytes;
  }

  return Math.min(thresholdAdjustedAvailableBytes, strictFreeBytes);
}

export function createMemoryBudget({
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): {
  totalBudgetBytes: number;
  availableBudgetBytes: number | null;
  effectiveBudgetBytes: number;
  budget: MemoryBudget;
} {
  const totalBudgetBytes = totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO;
  const availableBudgetBytes = systemMemorySnapshot
    ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot)
    : null;
  const effectiveBudgetBytes = availableBudgetBytes === null
    ? totalBudgetBytes
    : Math.min(totalBudgetBytes, availableBudgetBytes);

  return {
    totalBudgetBytes,
    availableBudgetBytes,
    effectiveBudgetBytes,
    budget: {
      totalMemoryBytes,
      liveAvailableBytes: systemMemorySnapshot?.availableBytes,
      freeBytes: systemMemorySnapshot?.freeBytes,
      thresholdBytes: systemMemorySnapshot?.thresholdBytes,
      effectiveBudgetBytes,
    },
  };
}

