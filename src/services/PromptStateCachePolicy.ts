import type { ContextParams } from 'llama.rn';

export const DISABLED_PROMPT_STATE_CACHE_BUDGET_MB = 0;
export const PROMPT_STATE_CACHE_MAX_CHECKPOINTS = 8;

export type ExplicitPromptStateCacheContextParams = Required<
  Pick<ContextParams, 'state_cache_budget_mb' | 'state_cache_max_checkpoints'>
>;

export const DISABLED_PROMPT_STATE_CACHE_CONTEXT_PARAMS: ExplicitPromptStateCacheContextParams =
  Object.freeze({
    state_cache_budget_mb: DISABLED_PROMPT_STATE_CACHE_BUDGET_MB,
    state_cache_max_checkpoints: PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
  });

export function applyPromptStateCacheSafetyGate<T extends ContextParams>(
  params: T,
): T & ExplicitPromptStateCacheContextParams {
  return {
    ...params,
    state_cache_budget_mb:
      params.state_cache_budget_mb ?? DISABLED_PROMPT_STATE_CACHE_BUDGET_MB,
    state_cache_max_checkpoints:
      params.state_cache_max_checkpoints ?? PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
  };
}
