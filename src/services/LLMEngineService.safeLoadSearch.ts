import { CONTEXT_WINDOW_STEP_TOKENS } from '../utils/contextWindow';

export type SafeLoadProfileCandidate = {
  contextTokens: number;
  gpuLayers: number;
};

const INTERMEDIATE_GPU_LAYER_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

export function buildIntermediateGpuLayerCandidates(gpuLayersCeiling: number): number[] {
  const normalizedCeiling = Math.max(0, Math.round(gpuLayersCeiling));
  if (normalizedCeiling === 0) {
    return [0];
  }

  const candidates = new Set<number>();
  for (const fraction of INTERMEDIATE_GPU_LAYER_FRACTIONS) {
    candidates.add(Math.round(normalizedCeiling * fraction));
  }
  candidates.add(1);
  candidates.add(normalizedCeiling);

  return Array.from(candidates)
    .map((gpuLayers) => Math.max(0, Math.min(normalizedCeiling, gpuLayers)))
    .sort((left, right) => left - right);
}

export function chooseSafeLoadProfileCandidate(
  candidates: readonly SafeLoadProfileCandidate[],
  contextTradeoffWindowTokens = CONTEXT_WINDOW_STEP_TOKENS,
): SafeLoadProfileCandidate {
  if (candidates.length === 0) {
    throw new Error('Cannot choose a safe-load profile without candidates.');
  }

  const contextWindow = Math.max(0, Math.round(contextTradeoffWindowTokens));
  const maxContextTokens = candidates.reduce(
    (bestContextTokens, candidate) => Math.max(bestContextTokens, candidate.contextTokens),
    candidates[0].contextTokens,
  );
  const minimumTradeoffContextTokens = maxContextTokens - contextWindow;

  return candidates.reduce((bestCandidate, candidate) => {
    const bestWithinTradeoffWindow = bestCandidate.contextTokens >= minimumTradeoffContextTokens;
    const candidateWithinTradeoffWindow = candidate.contextTokens >= minimumTradeoffContextTokens;

    if (candidateWithinTradeoffWindow && !bestWithinTradeoffWindow) {
      return candidate;
    }
    if (!candidateWithinTradeoffWindow) {
      return bestCandidate;
    }
    if (candidate.gpuLayers > bestCandidate.gpuLayers) {
      return candidate;
    }
    if (
      candidate.gpuLayers === bestCandidate.gpuLayers
      && candidate.contextTokens > bestCandidate.contextTokens
    ) {
      return candidate;
    }
    return bestCandidate;
  }, candidates[0]);
}
