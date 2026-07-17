import {
  createMemoryBudget,
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
} from '../memory/budget';
import type { MemoryBudgetSnapshot } from '../memory/budget';
import { isFinitePositiveNumber } from '../memory/guards';
import { estimateModelRuntimeBytes } from '../memory/estimator';
import {
  UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES,
  UNKNOWN_SPECULATIVE_DRAFT_MEMORY_FIT_FALLBACK_BYTES,
  normalizePositiveByteSize,
} from './modelSize';

export {
  UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES,
  UNKNOWN_SPECULATIVE_DRAFT_MEMORY_FIT_FALLBACK_BYTES,
};

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
  speculativeDraftSizeBytes,
  hasUnknownSizeProjector = false,
  hasUnknownSizeSpeculativeDraft = false,
}: {
  modelSizeBytes: number;
  projectorSizeBytes?: number | null;
  speculativeDraftSizeBytes?: number | null;
  hasUnknownSizeProjector?: boolean;
  hasUnknownSizeSpeculativeDraft?: boolean;
}): number | null {
  const normalizedModelSize = normalizePositiveByteSize(modelSizeBytes);
  if (normalizedModelSize === null) {
    return null;
  }

  const normalizedProjectorSize = normalizePositiveByteSize(projectorSizeBytes);
  const projectorMemoryFitSize = normalizedProjectorSize
    ?? (hasUnknownSizeProjector ? UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES : 0);
  const normalizedSpeculativeDraftSize = normalizePositiveByteSize(speculativeDraftSizeBytes);
  const speculativeDraftMemoryFitSize = normalizedSpeculativeDraftSize
    ?? (hasUnknownSizeSpeculativeDraft ? UNKNOWN_SPECULATIVE_DRAFT_MEMORY_FIT_FALLBACK_BYTES : 0);
  return normalizedModelSize + projectorMemoryFitSize + speculativeDraftMemoryFitSize;
}

export function assessModelMemoryFit({
  modelSizeBytes,
  projectorSizeBytes,
  speculativeDraftSizeBytes,
  hasUnknownSizeProjector,
  hasUnknownSizeSpeculativeDraft,
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  modelSizeBytes: number;
  projectorSizeBytes?: number | null;
  speculativeDraftSizeBytes?: number | null;
  hasUnknownSizeProjector?: boolean;
  hasUnknownSizeSpeculativeDraft?: boolean;
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): MemoryFitAssessment | null {
  const memoryFitInputSizeBytes = getModelMemoryFitInputSizeBytes({
    modelSizeBytes,
    projectorSizeBytes,
    speculativeDraftSizeBytes,
    hasUnknownSizeProjector,
    hasUnknownSizeSpeculativeDraft,
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
