import type { NativeCompletionTokenProb } from 'llama.rn';

/** Internal fixed-size QA data. Token strings must never be included in exported evidence. */
export function firstTokenProbabilityDistribution(payload: NativeCompletionTokenProb[] | undefined): Map<string, number> {
  const probabilities = payload?.[0]?.probs;
  if (!probabilities || probabilities.length !== 10) throw new Error('probabilities_missing');
  const distribution = new Map<string, number>();
  for (const item of probabilities) {
    if (typeof item.tok_str !== 'string' || !Number.isFinite(item.prob) || item.prob < 0 || item.prob > 1) {
      throw new Error('probabilities_invalid');
    }
    distribution.set(item.tok_str, (distribution.get(item.tok_str) ?? 0) + item.prob);
  }
  if ([...distribution.values()].reduce((sum, probability) => sum + probability, 0) > 1.00001) {
    throw new Error('probabilities_invalid');
  }
  return distribution;
}

/** Compare shared tokens, never ranks, and never invent zero for an absent top-k token. */
export function compareProbabilityDistributions(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>,
  { requireSameSupport = false }: { requireSameSupport?: boolean } = {}): {
  sharedTokens: number; maxDelta: number; supportMatched?: true;
} {
  // Baseline/recovery claims require the complete observed top-n support. Effect
  // probes may compare only shared tokens, without inventing missing probabilities.
  if (requireSameSupport && (left.size !== right.size || [...left.keys()].some(token => !right.has(token)))) {
    throw new Error('probability_support_mismatch');
  }
  let sharedTokens = 0;
  let maxDelta = 0;
  for (const [token, probability] of left) {
    const other = right.get(token);
    if (other === undefined) continue;
    sharedTokens += 1;
    maxDelta = Math.max(maxDelta, Math.abs(probability - other));
  }
  if (sharedTokens < 3) throw new Error('probability_overlap_insufficient');
  return { sharedTokens, maxDelta, ...(requireSameSupport ? { supportMatched: true as const } : {}) };
}
