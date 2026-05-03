import {
  createMemoryBudget,
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
} from '../memory/budget';
import type { MemoryBudgetSnapshot } from '../memory/budget';
import { isFinitePositiveNumber } from '../memory/guards';
import { estimateModelRuntimeBytes } from '../memory/estimator';

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
