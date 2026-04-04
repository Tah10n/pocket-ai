import type { MemoryFitConfidence, MemoryFitDecision, MemoryFitResult, MemoryBreakdown } from './types';
import { createMemoryBudget, type MemoryBudgetSnapshot } from './budget';

export const ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR = 0.2;

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sumBreakdown(breakdown: MemoryBreakdown): number {
  return (
    breakdown.weightsBytes
    + breakdown.kvCacheBytes
    + breakdown.computeBytes
    + breakdown.multimodalBytes
    + breakdown.overheadBytes
    + breakdown.safetyMarginBytes
  );
}

function createBaseBreakdownForModelSize(modelSizeBytes: number): MemoryBreakdown {
  const weightsBytes = modelSizeBytes;
  const overheadBytes = modelSizeBytes * ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR;
  return {
    weightsBytes,
    kvCacheBytes: 0,
    computeBytes: 0,
    multimodalBytes: 0,
    overheadBytes,
    safetyMarginBytes: 0,
  };
}

function decisionForBudgetFit({
  requiredBytes,
  effectiveBudgetBytes,
}: {
  requiredBytes: number;
  effectiveBudgetBytes: number;
}): MemoryFitDecision {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) {
    return 'unknown';
  }

  if (!Number.isFinite(effectiveBudgetBytes) || effectiveBudgetBytes <= 0) {
    return 'unknown';
  }

  const overBudgetRatio = requiredBytes / effectiveBudgetBytes;
  if (!Number.isFinite(overBudgetRatio) || overBudgetRatio <= 0) {
    return 'unknown';
  }

  if (requiredBytes <= effectiveBudgetBytes) {
    return overBudgetRatio <= 0.75 ? 'fits_high_confidence' : 'fits_low_confidence';
  }

  return overBudgetRatio < 1.25 ? 'borderline' : 'likely_oom';
}

function confidenceForInputs(hasLiveBudget: boolean): MemoryFitConfidence {
  return hasLiveBudget ? 'high' : 'medium';
}

function recommendationsForDecision(decision: MemoryFitDecision): string[] {
  if (decision === 'borderline') {
    return [
      'Try lowering the context size.',
      'Try reducing GPU layers or disabling GPU offload.',
    ];
  }

  if (decision === 'likely_oom') {
    return [
      'Use a smaller model or a more memory-efficient quantization.',
      'Lower the context size and disable GPU offload.',
    ];
  }

  if (decision === 'unknown') {
    return [
      'Try downloading the model first so the app can verify its file size.',
    ];
  }

  return [];
}

export function estimateModelRuntimeBytes(modelSizeBytes: number): number {
  return modelSizeBytes * (1 + ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR);
}

export function estimateMemoryFitFromModelSize({
  modelSizeBytes,
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  modelSizeBytes: number;
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): MemoryFitResult {
  if (!isFinitePositiveNumber(modelSizeBytes) || !isFinitePositiveNumber(totalMemoryBytes)) {
    return {
      decision: 'unknown',
      confidence: 'low',
      requiredBytes: 0,
      effectiveBudgetBytes: 0,
      breakdown: {
        weightsBytes: 0,
        kvCacheBytes: 0,
        computeBytes: 0,
        multimodalBytes: 0,
        overheadBytes: 0,
        safetyMarginBytes: 0,
      },
      budget: {
        totalMemoryBytes: isFinitePositiveNumber(totalMemoryBytes) ? totalMemoryBytes : 0,
        effectiveBudgetBytes: 0,
      },
      recommendations: recommendationsForDecision('unknown'),
    };
  }

  const breakdown = createBaseBreakdownForModelSize(modelSizeBytes);
  const requiredBytes = sumBreakdown(breakdown);
  const { effectiveBudgetBytes, budget } = createMemoryBudget({
    totalMemoryBytes,
    systemMemorySnapshot,
  });

  const decision = decisionForBudgetFit({ requiredBytes, effectiveBudgetBytes });
  const confidence = confidenceForInputs(Boolean(systemMemorySnapshot));

  return {
    decision,
    confidence,
    requiredBytes,
    effectiveBudgetBytes,
    breakdown,
    budget,
    recommendations: recommendationsForDecision(decision),
  };
}
