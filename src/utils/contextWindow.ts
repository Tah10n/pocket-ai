export const MIN_CONTEXT_WINDOW_TOKENS = 512;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192;
export const MAX_CONTEXT_WINDOW_TOKENS = 131072;
export const CONTEXT_WINDOW_STEP_TOKENS = 512;
export const ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR = 0.2;
export const ESTIMATED_CONTEXT_BYTES_PER_TOKEN = 2 * 1024;
const MAX_RUNTIME_MEMORY_RATIO = 0.8;

interface ContextWindowCeilingOptions {
  modelMaxContextTokens?: number | null;
  modelSizeBytes?: number | null;
  totalMemoryBytes?: number | null;
  appMaxContextTokens?: number;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function floorToContextWindowStep(tokens: number): number {
  return Math.floor(tokens / CONTEXT_WINDOW_STEP_TOKENS) * CONTEXT_WINDOW_STEP_TOKENS;
}

function normalizeContextWindowCeiling(tokens: number): number {
  if (!Number.isFinite(tokens)) {
    return MAX_CONTEXT_WINDOW_TOKENS;
  }

  const clamped = Math.min(
    MAX_CONTEXT_WINDOW_TOKENS,
    Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.round(tokens)),
  );

  return Math.max(MIN_CONTEXT_WINDOW_TOKENS, floorToContextWindowStep(clamped));
}

function resolveMemoryBoundContextWindow({
  modelSizeBytes,
  totalMemoryBytes,
}: Pick<ContextWindowCeilingOptions, 'modelSizeBytes' | 'totalMemoryBytes'>): number | null {
  if (!isFinitePositiveNumber(modelSizeBytes) || !isFinitePositiveNumber(totalMemoryBytes)) {
    return null;
  }

  const runtimeBudgetBytes =
    totalMemoryBytes * MAX_RUNTIME_MEMORY_RATIO
    - modelSizeBytes * (1 + ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR);

  if (!Number.isFinite(runtimeBudgetBytes) || runtimeBudgetBytes <= 0) {
    return MIN_CONTEXT_WINDOW_TOKENS;
  }

  return normalizeContextWindowCeiling(runtimeBudgetBytes / ESTIMATED_CONTEXT_BYTES_PER_TOKEN);
}

export function resolveContextWindowCeiling({
  modelMaxContextTokens,
  modelSizeBytes,
  totalMemoryBytes,
  appMaxContextTokens,
}: ContextWindowCeilingOptions): number {
  const requestedCeiling = isFinitePositiveNumber(appMaxContextTokens)
    ? appMaxContextTokens
    : (isFinitePositiveNumber(modelMaxContextTokens)
      ? modelMaxContextTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS);
  let ceiling = normalizeContextWindowCeiling(requestedCeiling);

  if (isFinitePositiveNumber(modelMaxContextTokens)) {
    ceiling = Math.min(ceiling, normalizeContextWindowCeiling(modelMaxContextTokens));
  }

  const memoryBoundCeiling = resolveMemoryBoundContextWindow({
    modelSizeBytes,
    totalMemoryBytes,
  });

  if (memoryBoundCeiling !== null) {
    ceiling = Math.min(ceiling, memoryBoundCeiling);
  }

  return normalizeContextWindowCeiling(ceiling);
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
