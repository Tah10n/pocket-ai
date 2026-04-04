import type { ContextSolveResult, EstimatorInput } from './types';

export function solveMaxContextTokens(_input: EstimatorInput): ContextSolveResult {
  // Phase 7 will replace the legacy `contextWindow.ts` solver with this shared entry point.
  return {
    maxContextTokens: 0,
    reason: 'not_implemented',
    requiredBytesAtCeiling: 0,
    effectiveBudgetBytes: 0,
  };
}

