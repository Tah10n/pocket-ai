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

function resolveAppBaselineBytes(snapshot: MemoryBudgetSnapshot): number {
  const pss = isFinitePositiveNumber(snapshot.appPssBytes) ? snapshot.appPssBytes : null;
  const resident = isFinitePositiveNumber(snapshot.appResidentBytes) ? snapshot.appResidentBytes : null;
  const used = isFinitePositiveNumber(snapshot.appUsedBytes) ? snapshot.appUsedBytes : null;

  return Math.max(0, pss ?? resident ?? used ?? 0);
}

function resolveReservedBudgetBytes({
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): number {
  if (!systemMemorySnapshot) {
    return 0;
  }

  const appBaselineBytes = resolveAppBaselineBytes(systemMemorySnapshot);
  const osReserveBytes = Math.max(DEFAULT_OS_RESERVE_BYTES, totalMemoryBytes * 0.06);
  const fragmentationGuardBytes = Math.max(MIN_FRAGMENTATION_GUARD_BYTES, totalMemoryBytes * FRAGMENTATION_GUARD_RATIO);
  const pressureReserveBytes = (
    systemMemorySnapshot.lowMemory === true
    || systemMemorySnapshot.pressureLevel === 'warning'
    || systemMemorySnapshot.pressureLevel === 'critical'
  )
    ? LOW_MEMORY_EXTRA_RESERVE_BYTES
    : 0;

  const reserved = appBaselineBytes + osReserveBytes + fragmentationGuardBytes + pressureReserveBytes;
  if (!Number.isFinite(reserved) || reserved <= 0) {
    return 0;
  }

  return Math.round(reserved);
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
  budget: MemoryBudget;
} {
  const resolvedTotalMemoryBytes = isFinitePositiveNumber(totalMemoryBytes) ? totalMemoryBytes : 0;
  const softTotalBudgetBytes = Math.floor(resolvedTotalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO);
  const availableBudgetBytes = systemMemorySnapshot
    ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot)
    : null;

  const reservedBytes = resolveReservedBudgetBytes({
    totalMemoryBytes: resolvedTotalMemoryBytes,
    systemMemorySnapshot,
  });

  const learnedSafeBudgetCandidate = isFinitePositiveNumber(learnedSafeBudgetBytes) ? learnedSafeBudgetBytes : null;
  const rawBudgetBytes = Math.min(
    ...([
      softTotalBudgetBytes,
      ...(availableBudgetBytes === null ? [] : [availableBudgetBytes]),
      ...(learnedSafeBudgetCandidate === null ? [] : [learnedSafeBudgetCandidate]),
    ]),
  );
  const effectiveBudgetBytes = Math.max(0, rawBudgetBytes - reservedBytes);

  return {
    totalBudgetBytes: softTotalBudgetBytes,
    availableBudgetBytes,
    effectiveBudgetBytes,
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
