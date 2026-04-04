import type { SystemMemorySnapshot } from '../services/SystemMetricsService';
import {
  createMemoryBudget,
  DEFAULT_TOTAL_MEMORY_BYTES,
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
} from '../memory/budget';
import { estimateModelRuntimeBytes } from '../memory/estimator';

export {
  DEFAULT_TOTAL_MEMORY_BYTES,
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
};

export { estimateModelRuntimeBytes };

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
  const { totalBudgetBytes, availableBudgetBytes, effectiveBudgetBytes } = createMemoryBudget({
    totalMemoryBytes,
    systemMemorySnapshot,
  });

  return {
    estimatedRuntimeBytes,
    totalBudgetBytes,
    availableBudgetBytes,
    effectiveBudgetBytes,
    fitsInRam: estimatedRuntimeBytes < effectiveBudgetBytes,
  };
}
