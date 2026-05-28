import {
  createMemoryBudget,
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
} from '../memory/budget';
import type { MemoryBudgetSnapshot } from '../memory/budget';
import { isFinitePositiveNumber } from '../memory/guards';
import { estimateModelRuntimeBytes } from '../memory/estimator';
import { normalizePositiveByteSize } from './modelSize';

export {
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
};

export { estimateModelRuntimeBytes };

export interface MemoryFitAssessment {
  estimatedRuntimeBytes: number;
  totalBudgetBytes: number;
  availableBudgetBytes: number | null;
  effectiveBudgetBytes: number;
  fitsInRam: boolean;
}

export function getModelMemoryFitInputSizeBytes({
  modelSizeBytes,
  projectorSizeBytes,
}: {
  modelSizeBytes: number;
  projectorSizeBytes?: number | null;
}): number | null {
  const normalizedModelSize = normalizePositiveByteSize(modelSizeBytes);
  if (normalizedModelSize === null) {
    return null;
  }

  return normalizedModelSize + (normalizePositiveByteSize(projectorSizeBytes) ?? 0);
}

export function assessModelMemoryFit({
  modelSizeBytes,
  projectorSizeBytes,
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  modelSizeBytes: number;
  projectorSizeBytes?: number | null;
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): MemoryFitAssessment | null {
  const memoryFitInputSizeBytes = getModelMemoryFitInputSizeBytes({
    modelSizeBytes,
    projectorSizeBytes,
  });
  if (memoryFitInputSizeBytes === null || !isFinitePositiveNumber(totalMemoryBytes)) {
    return null;
  }

  const estimatedRuntimeBytes = estimateModelRuntimeBytes(memoryFitInputSizeBytes);
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
