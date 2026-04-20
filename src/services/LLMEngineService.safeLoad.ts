import type { MemoryFitResult } from '../memory/types';
import { MIN_CONTEXT_WINDOW_TOKENS } from '../utils/contextWindow';
import { AppError } from './AppError';
import { canAutoUseSafeLoadProfile } from './LLMEngineService.helpers';

// Note: this module intentionally contains only *small, pure* pieces of the safe-load policy.
// The broader safe-load decision flow remains in LLMEngineService.initializeModel.

export function throwIfSafeLoadOnlyFitsAtMinimumContext({
  modelId,
  resolvedContextSize,
  requestedGpuLayers,
  safeLoadProfile,
  safeMemoryFit,
  memoryFit,
  configuredContextCeilingTokens,
  modelContextCeilingTokens,
  onHardBlock,
}: {
  modelId: string;
  resolvedContextSize: number;
  requestedGpuLayers: number;
  safeLoadProfile: { contextTokens: number; gpuLayers: number };
  safeMemoryFit: MemoryFitResult;
  memoryFit: MemoryFitResult;
  configuredContextCeilingTokens: number;
  modelContextCeilingTokens: number | null;
  onHardBlock: () => void;
}): void {
  const effectiveContextCeilingTokens = modelContextCeilingTokens === null
    ? configuredContextCeilingTokens
    : Math.min(configuredContextCeilingTokens, modelContextCeilingTokens);

  if (
    safeLoadProfile.contextTokens === MIN_CONTEXT_WINDOW_TOKENS
    && effectiveContextCeilingTokens > MIN_CONTEXT_WINDOW_TOKENS
  ) {
    onHardBlock();
    throw new AppError(
      'model_load_blocked',
      'Loading is disabled for this model because it only fits at the minimum context window.',
      {
        details: {
          modelId,
          requestedLoadProfile: {
            contextTokens: resolvedContextSize,
            gpuLayers: requestedGpuLayers,
          },
          safeLoadProfile,
          safeMemoryFit,
          memoryFit,
        },
      },
    );
  }
}

export function resolveAutoSafeLoadProfileOrThrowWarning({
  modelId,
  resolvedContextSize,
  requestedGpuLayers,
  allowUnsafeMemoryLoad,
  exceedsEffectiveBudget,
  memoryFit,
  safeLoadProfile,
  safeMemoryFit,
  availableBudgetBytes,
  lowMemorySignal,
  overBudgetRatio,
}: {
  modelId: string;
  resolvedContextSize: number;
  requestedGpuLayers: number;
  allowUnsafeMemoryLoad: boolean;
  exceedsEffectiveBudget: boolean;
  memoryFit: MemoryFitResult;
  safeLoadProfile: { contextTokens: number; gpuLayers: number } | null;
  safeMemoryFit: MemoryFitResult | null;
  availableBudgetBytes: number | null;
  lowMemorySignal: boolean;
  overBudgetRatio: number;
}): boolean {
  if (allowUnsafeMemoryLoad || !exceedsEffectiveBudget) {
    return false;
  }

  const shouldAutoUse = canAutoUseSafeLoadProfile({
    memoryFit: safeMemoryFit ?? undefined,
    availableBudgetBytes,
    lowMemorySignal,
  });

  if (shouldAutoUse) {
    return true;
  }

  throw new AppError('model_memory_warning', 'Model may not fit in memory.', {
    details: {
      modelId,
      decision: memoryFit.decision,
      confidence: memoryFit.confidence,
      overBudgetRatio,
      memoryFit,
      safeLoadProfile,
      safeMemoryFit: safeMemoryFit ?? undefined,
      requestedLoadProfile: {
        contextTokens: resolvedContextSize,
        gpuLayers: requestedGpuLayers,
      },
    },
  });
}
