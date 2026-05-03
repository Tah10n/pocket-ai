import type { MemoryFitResult } from '../memory/types';
import { FITS_IN_RAM_HEADROOM_RATIO, resolveConservativeAvailableMemoryBudget } from '../memory/budget';
import type { MemoryPressureLevel } from './SystemMetricsService';
import { MIN_CONTEXT_WINDOW_TOKENS } from '../utils/contextWindow';
import { AppError } from './AppError';
import { canAutoUseSafeLoadProfile, shouldHardBlockSafeLoad } from './LLMEngineService.helpers';

export type SafeLoadProfile = { contextTokens: number; gpuLayers: number };

type SafeLoadBudgetValidationInput = {
  predictedFitForLoad: MemoryFitResult | null;
  requestedMemoryFit: MemoryFitResult | null;
};

type SafeLoadBudgetValidationResult = { unsafeMemoryBypassedHardBlock: boolean };

export function resolveSafeLoadPolicyOrThrow({
  modelId,
  allowUnsafeMemoryLoad,
  memoryFit,
  resolvedModelSizeBytes,
  resolvedTotalMemoryBytes,
  systemMemorySnapshot,
  lowMemorySignal,
  resolvedContextSize,
  requestedGpuLayers,
  configuredContextCeilingTokens,
  modelContextCeilingTokens,
  computeSafeProfile,
  onHardBlock,
}: {
  modelId: string;
  allowUnsafeMemoryLoad: boolean;
  memoryFit: MemoryFitResult;
  resolvedModelSizeBytes: number;
  resolvedTotalMemoryBytes: number | null;
  systemMemorySnapshot: {
    availableBytes?: number | null;
    freeBytes?: number | null;
    processAvailableBytes?: number | null;
    thresholdBytes?: number | null;
    lowMemory?: boolean | null;
    pressureLevel?: MemoryPressureLevel | null;
    totalBytes?: number | null;
  } | null;
  lowMemorySignal: boolean;
  resolvedContextSize: number;
  requestedGpuLayers: number;
  configuredContextCeilingTokens: number;
  modelContextCeilingTokens: number | null;
  computeSafeProfile: () => { safeLoadProfile: SafeLoadProfile; safeMemoryFit: MemoryFitResult };
  onHardBlock: (confidence: 'high' | 'medium') => void;
}): {
  exceedsEffectiveBudget: boolean;
  overBudgetRatio: number;
  availableBudgetBytes: number | null;
  safeLoadProfile: SafeLoadProfile | null;
  safeMemoryFit: MemoryFitResult | null;
  shouldAutoUseSafeLoadProfile: boolean;
  shouldUseSafeLoadProfile: boolean;
  finalContextSize: number;
  gpuLayers: number;
  shouldUseLowMemoryContextParams: boolean;
  validateBudgetOrThrow: (input: SafeLoadBudgetValidationInput) => SafeLoadBudgetValidationResult;
} {
  const overBudgetRatio = memoryFit.effectiveBudgetBytes > 0
    ? memoryFit.requiredBytes / memoryFit.effectiveBudgetBytes
    : Number.POSITIVE_INFINITY;
  const hasTrustedBudget = memoryFit.budget.totalMemoryBytes > 0;

  const exceedsEffectiveBudget = (
    memoryFit.requiredBytes > 0
    && memoryFit.effectiveBudgetBytes > 0
    && memoryFit.requiredBytes >= memoryFit.effectiveBudgetBytes
  );
  const availableBudgetBytes = systemMemorySnapshot
    ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot as any)
    : null;

  const shouldHardBlock = (
    hasTrustedBudget
    && memoryFit.decision === 'likely_oom'
    && memoryFit.confidence === 'high'
  );

  if (shouldHardBlock && !allowUnsafeMemoryLoad) {
    onHardBlock('high');
    throw new AppError('model_memory_insufficient', 'Not enough memory to load this model.', {
      details: {
        modelId,
        modelSizeBytes: resolvedModelSizeBytes,
        estimatedRuntimeBytes: memoryFit.requiredBytes,
        totalMemoryBytes: resolvedTotalMemoryBytes,
        availableMemoryBytes: systemMemorySnapshot?.availableBytes,
        freeMemoryBytes: systemMemorySnapshot?.freeBytes,
        thresholdBytes: systemMemorySnapshot?.thresholdBytes,
        totalBudgetBytes: memoryFit.budget.totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO,
        availableBudgetBytes,
        effectiveAvailableBudgetBytes: memoryFit.effectiveBudgetBytes,
        lowMemory: lowMemorySignal,
        allowUnsafeMemoryLoad,
        overBudgetRatio,
        decision: memoryFit.decision,
        confidence: memoryFit.confidence,
        memoryFit,
      },
    });
  }

  let safeLoadProfile: SafeLoadProfile | null = null;
  let safeMemoryFit: MemoryFitResult | null = null;

  if (exceedsEffectiveBudget) {
    ({ safeLoadProfile, safeMemoryFit } = computeSafeProfile());

    const effectiveContextCeilingTokens = modelContextCeilingTokens === null
      ? configuredContextCeilingTokens
      : Math.min(configuredContextCeilingTokens, modelContextCeilingTokens);

    if (
      safeLoadProfile.contextTokens === MIN_CONTEXT_WINDOW_TOKENS
      && effectiveContextCeilingTokens > MIN_CONTEXT_WINDOW_TOKENS
    ) {
      onHardBlock('high');
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

  const shouldAutoUseSafeLoadProfile = (!allowUnsafeMemoryLoad && exceedsEffectiveBudget)
    ? canAutoUseSafeLoadProfile({
        memoryFit: safeMemoryFit ?? undefined,
        availableBudgetBytes,
        lowMemorySignal,
      })
    : false;

  if (!allowUnsafeMemoryLoad && exceedsEffectiveBudget && !shouldAutoUseSafeLoadProfile) {
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

  const shouldUseSafeLoadProfile = Boolean(
    (allowUnsafeMemoryLoad || shouldAutoUseSafeLoadProfile)
    && exceedsEffectiveBudget,
  );
  const resolvedSafeLoadProfile = safeLoadProfile ?? { contextTokens: MIN_CONTEXT_WINDOW_TOKENS, gpuLayers: 0 };
  const finalContextSize = shouldUseSafeLoadProfile ? resolvedSafeLoadProfile.contextTokens : resolvedContextSize;
  const gpuLayers = shouldUseSafeLoadProfile ? resolvedSafeLoadProfile.gpuLayers : requestedGpuLayers;
  const shouldUseLowMemoryContextParams = Boolean(
    shouldUseSafeLoadProfile
    || memoryFit.decision === 'fits_low_confidence'
    || memoryFit.decision === 'borderline'
    || memoryFit.decision === 'likely_oom'
  );

  return {
    exceedsEffectiveBudget,
    overBudgetRatio,
    availableBudgetBytes,
    safeLoadProfile,
    safeMemoryFit,
    shouldAutoUseSafeLoadProfile,
    shouldUseSafeLoadProfile,
    finalContextSize,
    gpuLayers,
    shouldUseLowMemoryContextParams,
    validateBudgetOrThrow: ({ predictedFitForLoad, requestedMemoryFit }: SafeLoadBudgetValidationInput) => {
      return validateSafeLoadBudgetOrThrowInternal({
        modelId,
        allowUnsafeMemoryLoad,
        predictedFitForLoad,
        requestedMemoryFit,
        resolvedModelSizeBytes,
        resolvedTotalMemoryBytes,
        systemMemorySnapshot,
        availableBudgetBytes,
        lowMemorySignal,
        shouldUseSafeLoadProfile,
        requestedLoadProfile: { contextTokens: resolvedContextSize, gpuLayers: requestedGpuLayers },
        attemptedLoadProfile: { contextTokens: finalContextSize, gpuLayers },
      });
    },
  };
}

function validateSafeLoadBudgetOrThrowInternal({
  modelId,
  allowUnsafeMemoryLoad,
  predictedFitForLoad,
  requestedMemoryFit,
  resolvedModelSizeBytes,
  resolvedTotalMemoryBytes,
  systemMemorySnapshot,
  availableBudgetBytes,
  lowMemorySignal,
  shouldUseSafeLoadProfile,
  requestedLoadProfile,
  attemptedLoadProfile,
}: {
  modelId: string;
  allowUnsafeMemoryLoad: boolean;
  predictedFitForLoad: MemoryFitResult | null;
  requestedMemoryFit: MemoryFitResult | null;
  resolvedModelSizeBytes: number | null;
  resolvedTotalMemoryBytes: number | null;
  systemMemorySnapshot: {
    availableBytes?: number | null;
    freeBytes?: number | null;
    thresholdBytes?: number | null;
  } | null;
  availableBudgetBytes: number | null;
  lowMemorySignal: boolean;
  shouldUseSafeLoadProfile: boolean;
  requestedLoadProfile: { contextTokens: number; gpuLayers: number };
  attemptedLoadProfile: { contextTokens: number; gpuLayers: number };
}): SafeLoadBudgetValidationResult {
  if (!shouldUseSafeLoadProfile || !predictedFitForLoad) {
    return { unsafeMemoryBypassedHardBlock: false };
  }

  const safeLoadStillExceedsBudget = shouldHardBlockSafeLoad({
    memoryFit: predictedFitForLoad,
    availableBudgetBytes,
    lowMemorySignal,
  });

  if (!safeLoadStillExceedsBudget) {
    return { unsafeMemoryBypassedHardBlock: false };
  }

  if (allowUnsafeMemoryLoad) {
    return { unsafeMemoryBypassedHardBlock: true };
  }

  throw new AppError('model_memory_insufficient', 'Not enough memory to load this model.', {
    details: {
      modelId,
      modelSizeBytes: resolvedModelSizeBytes,
      estimatedRuntimeBytes: predictedFitForLoad.requiredBytes,
      totalMemoryBytes: resolvedTotalMemoryBytes,
      availableMemoryBytes: systemMemorySnapshot?.availableBytes,
      freeMemoryBytes: systemMemorySnapshot?.freeBytes,
      thresholdBytes: systemMemorySnapshot?.thresholdBytes,
      totalBudgetBytes: predictedFitForLoad.budget.totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO,
      availableBudgetBytes,
      effectiveAvailableBudgetBytes: predictedFitForLoad.effectiveBudgetBytes,
      lowMemory: lowMemorySignal,
      allowUnsafeMemoryLoad,
      decision: predictedFitForLoad.decision,
      confidence: predictedFitForLoad.confidence,
      memoryFit: predictedFitForLoad,
      requestedMemoryFit,
      requestedLoadProfile,
      attemptedLoadProfile,
    },
  });
}
