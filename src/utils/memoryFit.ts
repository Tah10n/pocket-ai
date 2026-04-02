import type { SystemMemorySnapshot } from '../services/SystemMetricsService';
import { ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR } from './contextWindow';

export const DEFAULT_TOTAL_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
export const FITS_IN_RAM_HEADROOM_RATIO = 0.8;

type MemoryBudgetSnapshot = Pick<SystemMemorySnapshot, 'availableBytes' | 'freeBytes' | 'thresholdBytes'>;

export interface MemoryFitAssessment {
  estimatedRuntimeBytes: number;
  totalBudgetBytes: number;
  availableBudgetBytes: number | null;
  effectiveBudgetBytes: number;
  fitsInRam: boolean;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function estimateModelRuntimeBytes(modelSizeBytes: number): number {
  return modelSizeBytes * (1 + ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR);
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

export function assessModelMemoryFit({
  modelSizeBytes,
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  modelSizeBytes: number;
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): MemoryFitAssessment | null {
  if (!isFinitePositiveNumber(modelSizeBytes) || !isFinitePositiveNumber(totalMemoryBytes)) {
    return null;
  }

  const estimatedRuntimeBytes = estimateModelRuntimeBytes(modelSizeBytes);
  const totalBudgetBytes = totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO;
  const availableBudgetBytes = systemMemorySnapshot
    ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot)
    : null;
  const effectiveBudgetBytes = availableBudgetBytes === null
    ? totalBudgetBytes
    : Math.min(totalBudgetBytes, availableBudgetBytes);

  return {
    estimatedRuntimeBytes,
    totalBudgetBytes,
    availableBudgetBytes,
    effectiveBudgetBytes,
    fitsInRam: estimatedRuntimeBytes < effectiveBudgetBytes,
  };
}
