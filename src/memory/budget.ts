import type { SystemMemorySnapshot } from '../services/SystemMetricsService';
import type { MemoryBudget } from './types';

export const DEFAULT_TOTAL_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
export const FITS_IN_RAM_HEADROOM_RATIO = 0.8;

const DEFAULT_OS_RESERVE_BYTES = 512 * 1024 * 1024;
const MIN_FRAGMENTATION_GUARD_BYTES = 256 * 1024 * 1024;
const FRAGMENTATION_GUARD_RATIO = 0.05;
const LOW_MEMORY_EXTRA_RESERVE_BYTES = 256 * 1024 * 1024;

export interface MemoryBudgetSnapshot {
  availableBytes: number;
  freeBytes?: number;
  thresholdBytes?: number;
  appUsedBytes?: number;
  appResidentBytes?: number;
  appPssBytes?: number;
  lowMemory?: boolean;
  pressureLevel?: SystemMemorySnapshot['pressureLevel'];
}

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

function resolveReserveBudgets({
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): { softReserveBytes: number; liveReserveBytes: number } {
  if (!systemMemorySnapshot) {
    return { softReserveBytes: 0, liveReserveBytes: 0 };
  }

  // NOTE: The live "available budget" already represents memory available to allocate
  // on top of current app + OS usage (and we also subtract system low-memory thresholds
  // inside resolveConservativeAvailableMemoryBudget). Reserving app baseline or a
  // fixed OS chunk again would double-count and collapse budgets on memory-constrained
  // devices even when there is still allocatable RAM.
  //
  // We still reserve:
  // - fragmentation guard (allocator / VA fragmentation)
  // - extra headroom under memory pressure
  //
  // For the soft total-RAM budget (0.8 * total RAM) we also keep an OS reserve, but only
  // when the platform does not report a low-memory threshold.
  const thresholdBytes = isFinitePositiveNumber(systemMemorySnapshot.thresholdBytes) ? systemMemorySnapshot.thresholdBytes : 0;
  const shouldReserveOsBytes = thresholdBytes <= 0;
  const osReserveBytes = shouldReserveOsBytes ? Math.max(DEFAULT_OS_RESERVE_BYTES, totalMemoryBytes * 0.06) : 0;
  const fragmentationGuardBytes = Math.max(MIN_FRAGMENTATION_GUARD_BYTES, totalMemoryBytes * FRAGMENTATION_GUARD_RATIO);
  const pressureReserveBytes = (
    systemMemorySnapshot.lowMemory === true
    || systemMemorySnapshot.pressureLevel === 'warning'
    || systemMemorySnapshot.pressureLevel === 'critical'
  )
    ? LOW_MEMORY_EXTRA_RESERVE_BYTES
    : 0;

  const softReserveCandidate = osReserveBytes + fragmentationGuardBytes + pressureReserveBytes;
  const liveReserveCandidate = fragmentationGuardBytes + pressureReserveBytes;
  const softReserveBytes = Number.isFinite(softReserveCandidate) && softReserveCandidate > 0 ? Math.round(softReserveCandidate) : 0;
  const liveReserveBytes = Number.isFinite(liveReserveCandidate) && liveReserveCandidate > 0 ? Math.round(liveReserveCandidate) : 0;

  return { softReserveBytes, liveReserveBytes };
}

export function createMemoryBudget({
  totalMemoryBytes,
  systemMemorySnapshot,
  learnedSafeBudgetBytes,
}: {
  totalMemoryBytes: number | null;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
  learnedSafeBudgetBytes?: number | null;
}): {
  totalBudgetBytes: number;
  availableBudgetBytes: number | null;
  effectiveBudgetBytes: number;
  softEffectiveBudgetBytes: number;
  liveEffectiveBudgetBytes: number | null;
  learnedEffectiveBudgetBytes: number | null;
  budget: MemoryBudget;
} {
  const resolvedTotalMemoryBytes = isFinitePositiveNumber(totalMemoryBytes) ? totalMemoryBytes : 0;
  const softTotalBudgetBytes = Math.floor(resolvedTotalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO);
  const availableBudgetBytes = systemMemorySnapshot
    ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot)
    : null;

  const { softReserveBytes, liveReserveBytes } = resolveReserveBudgets({
    totalMemoryBytes: resolvedTotalMemoryBytes,
    systemMemorySnapshot,
  });

  const learnedSafeBudgetCandidate = isFinitePositiveNumber(learnedSafeBudgetBytes) ? learnedSafeBudgetBytes : null;
  const softEffectiveBudgetBytes = Math.max(0, softTotalBudgetBytes - softReserveBytes);
  const liveEffectiveBudgetBytes = availableBudgetBytes === null
    ? null
    : Math.max(0, availableBudgetBytes - liveReserveBytes);
  const learnedEffectiveBudgetBytes = learnedSafeBudgetCandidate === null
    ? null
    : Math.max(0, learnedSafeBudgetCandidate - liveReserveBytes);
  const effectiveBudgetBytes = Math.min(
    ...([
      softEffectiveBudgetBytes,
      ...(liveEffectiveBudgetBytes === null ? [] : [liveEffectiveBudgetBytes]),
      ...(learnedEffectiveBudgetBytes === null ? [] : [learnedEffectiveBudgetBytes]),
    ]),
  );

  return {
    totalBudgetBytes: softTotalBudgetBytes,
    availableBudgetBytes,
    effectiveBudgetBytes,
    softEffectiveBudgetBytes,
    liveEffectiveBudgetBytes,
    learnedEffectiveBudgetBytes,
    budget: {
      totalMemoryBytes: resolvedTotalMemoryBytes,
      liveAvailableBytes: systemMemorySnapshot?.availableBytes,
      freeBytes: systemMemorySnapshot?.freeBytes,
      thresholdBytes: systemMemorySnapshot?.thresholdBytes,
      appResidentBytes: systemMemorySnapshot?.appResidentBytes,
      appPssBytes: systemMemorySnapshot?.appPssBytes,
      learnedSafeBudgetBytes: learnedSafeBudgetCandidate === null ? undefined : learnedSafeBudgetCandidate,
      effectiveBudgetBytes,
    },
  };
}
