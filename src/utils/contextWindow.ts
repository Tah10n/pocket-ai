import type { EstimatorInput } from '../memory/types';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  normalizeContextWindowCeiling,
  solveMaxContextForBudget,
} from '../memory/context';

export {
  clampContextWindowTokens,
  CONTEXT_WINDOW_STEP_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
} from '../memory/context';

export const ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR = 0.2;
export const ESTIMATED_CONTEXT_BYTES_PER_TOKEN = 2 * 1024;

interface ContextWindowCeilingOptions {
  modelMaxContextTokens?: number | null;
  totalMemoryBytes?: number | null;
  appMaxContextTokens?: number;
  input: EstimatorInput;
}

export function resolveContextWindowCeiling({
  modelMaxContextTokens,
  totalMemoryBytes,
  appMaxContextTokens,
  input,
}: ContextWindowCeilingOptions): number {
  const requestedCeiling = typeof appMaxContextTokens === 'number' && Number.isFinite(appMaxContextTokens) && appMaxContextTokens > 0
    ? appMaxContextTokens
    : (typeof modelMaxContextTokens === 'number' && Number.isFinite(modelMaxContextTokens) && modelMaxContextTokens > 0
      ? modelMaxContextTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS);
  let ceiling = normalizeContextWindowCeiling(requestedCeiling);

  if (typeof modelMaxContextTokens === 'number' && Number.isFinite(modelMaxContextTokens) && modelMaxContextTokens > 0) {
    ceiling = Math.min(ceiling, normalizeContextWindowCeiling(modelMaxContextTokens));
  }

  return solveMaxContextForBudget({
    input,
    totalMemoryBytes: typeof totalMemoryBytes === 'number' && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
      ? totalMemoryBytes
      : null,
    maxContextTokens: ceiling,
  }).maxContextTokens;
}
