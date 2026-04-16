export type ReasoningEffort = 'off' | 'auto' | 'low' | 'medium' | 'high';

export type ResolvedReasoningEffort = Exclude<ReasoningEffort, 'auto'>;

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'auto';

export function normalizeReasoningEffort(
  value: unknown,
  legacyReasoningEnabled?: unknown,
): ReasoningEffort {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (normalized === 'off' || normalized === 'auto' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }

  if (legacyReasoningEnabled === true) {
    return 'medium';
  }

  if (legacyReasoningEnabled === false) {
    return 'off';
  }

  return DEFAULT_REASONING_EFFORT;
}
