import type { ContextSolveResult, EstimatorInput } from './types';
import { estimateAccurateMemoryFit } from './estimator';

export const MIN_CONTEXT_WINDOW_TOKENS = 512;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192;
export const MAX_CONTEXT_WINDOW_TOKENS = 131072;
export const CONTEXT_WINDOW_STEP_TOKENS = 512;

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function floorToContextWindowStep(tokens: number): number {
  return Math.floor(tokens / CONTEXT_WINDOW_STEP_TOKENS) * CONTEXT_WINDOW_STEP_TOKENS;
}

export function normalizeContextWindowCeiling(tokens: number): number {
  if (!Number.isFinite(tokens)) {
    return MAX_CONTEXT_WINDOW_TOKENS;
  }

  const clamped = Math.min(
    MAX_CONTEXT_WINDOW_TOKENS,
    Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.round(tokens)),
  );

  return Math.max(MIN_CONTEXT_WINDOW_TOKENS, floorToContextWindowStep(clamped));
}

export function clampContextWindowTokens(
  requestedTokens: number | null | undefined,
  ceilingTokens: number,
): number {
  const normalizedCeiling = normalizeContextWindowCeiling(ceilingTokens);
  const normalizedRequested = isFinitePositiveNumber(requestedTokens)
    ? normalizeContextWindowCeiling(requestedTokens)
    : normalizedCeiling;

  return Math.min(normalizedRequested, normalizedCeiling);
}

export function solveMaxContextForBudget({
  input,
  totalMemoryBytes,
  maxContextTokens,
}: {
  input: EstimatorInput;
  totalMemoryBytes: number | null;
  maxContextTokens: number;
}): ContextSolveResult {
  const normalizedMaxContextTokens = normalizeContextWindowCeiling(maxContextTokens);
  const resolvedTotalMemoryBytes = isFinitePositiveNumber(totalMemoryBytes) ? totalMemoryBytes : null;
  const hasWeightsEstimate = isFinitePositiveNumber(input.verifiedFileSizeBytes) || isFinitePositiveNumber(input.modelSizeBytes);

  if (!resolvedTotalMemoryBytes) {
    return {
      maxContextTokens: normalizedMaxContextTokens,
      reason: hasWeightsEstimate ? 'unknown_budget' : 'unknown_budget_and_weights',
      requiredBytesAtCeiling: 0,
      effectiveBudgetBytes: 0,
    };
  }

  if (!hasWeightsEstimate) {
    return {
      maxContextTokens: normalizedMaxContextTokens,
      reason: 'unknown_weights',
      requiredBytesAtCeiling: 0,
      effectiveBudgetBytes: 0,
    };
  }

  const fitCache = new Map<number, number>();
  const estimateRequiredBytes = (contextTokens: number): number => {
    const normalized = normalizeContextWindowCeiling(contextTokens);
    const cached = fitCache.get(normalized);
    if (typeof cached === 'number') {
      return cached;
    }

    const fit = estimateAccurateMemoryFit({
      input: {
        ...input,
        runtimeParams: {
          ...input.runtimeParams,
          contextTokens: normalized,
        },
      },
      totalMemoryBytes: resolvedTotalMemoryBytes,
    });
    const requiredBytes = fit.requiredBytes;
    fitCache.set(normalized, requiredBytes);
    return requiredBytes;
  };

  const minFit = estimateAccurateMemoryFit({
    input: {
      ...input,
      runtimeParams: {
        ...input.runtimeParams,
        contextTokens: MIN_CONTEXT_WINDOW_TOKENS,
      },
    },
    totalMemoryBytes: resolvedTotalMemoryBytes,
  });
  const effectiveBudgetBytes = minFit.effectiveBudgetBytes;

  if (!Number.isFinite(effectiveBudgetBytes) || effectiveBudgetBytes <= 0) {
    return {
      maxContextTokens: MIN_CONTEXT_WINDOW_TOKENS,
      reason: 'no_effective_budget',
      requiredBytesAtCeiling: 0,
      effectiveBudgetBytes: 0,
    };
  }

  const minRequiredBytes = minFit.requiredBytes;
  if (!Number.isFinite(minRequiredBytes) || minRequiredBytes <= 0) {
    return {
      maxContextTokens: normalizedMaxContextTokens,
      reason: 'unknown_required_bytes',
      requiredBytesAtCeiling: 0,
      effectiveBudgetBytes,
    };
  }

  if (minRequiredBytes > effectiveBudgetBytes) {
    return {
      maxContextTokens: MIN_CONTEXT_WINDOW_TOKENS,
      reason: 'min_context_exceeds_budget',
      requiredBytesAtCeiling: minRequiredBytes,
      effectiveBudgetBytes,
    };
  }

  const maxRequiredBytes = estimateRequiredBytes(normalizedMaxContextTokens);
  if (Number.isFinite(maxRequiredBytes) && maxRequiredBytes > 0 && maxRequiredBytes <= effectiveBudgetBytes) {
    return {
      maxContextTokens: normalizedMaxContextTokens,
      reason: 'fits_under_limit',
      requiredBytesAtCeiling: maxRequiredBytes,
      effectiveBudgetBytes,
    };
  }

  const maxIndex = Math.floor((normalizedMaxContextTokens - MIN_CONTEXT_WINDOW_TOKENS) / CONTEXT_WINDOW_STEP_TOKENS);
  let low = 0;
  let high = Math.max(0, maxIndex);
  let bestTokens = MIN_CONTEXT_WINDOW_TOKENS;
  let bestRequiredBytes = minRequiredBytes;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateTokens = MIN_CONTEXT_WINDOW_TOKENS + mid * CONTEXT_WINDOW_STEP_TOKENS;
    const requiredBytes = estimateRequiredBytes(candidateTokens);

    if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) {
      high = mid - 1;
      continue;
    }

    if (requiredBytes <= effectiveBudgetBytes) {
      bestTokens = candidateTokens;
      bestRequiredBytes = requiredBytes;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return {
    maxContextTokens: normalizeContextWindowCeiling(bestTokens),
    reason: 'budget_limit',
    requiredBytesAtCeiling: bestRequiredBytes,
    effectiveBudgetBytes,
  };
}

export function solveMaxContextTokens(input: EstimatorInput): ContextSolveResult {
  const totalMemoryBytes = isFinitePositiveNumber(input.snapshot?.totalBytes) ? input.snapshot?.totalBytes : null;
  const requestedMaxContextTokens = isFinitePositiveNumber(input.runtimeParams.contextTokens)
    ? input.runtimeParams.contextTokens
    : DEFAULT_CONTEXT_WINDOW_TOKENS;

  return solveMaxContextForBudget({
    input,
    totalMemoryBytes,
    maxContextTokens: requestedMaxContextTokens,
  });
}
