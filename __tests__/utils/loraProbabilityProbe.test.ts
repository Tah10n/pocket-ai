import { compareProbabilityDistributions, firstTokenProbabilityDistribution } from '../../src/utils/loraProbabilityProbe';

const payload = () => [{ content: 'selected', probs: Array.from({ length: 10 }, (_, index) => ({ tok_str: `token-${index}`, prob: 0.01 * (index + 1) })) }];
describe('LoRA controlled first-token probability comparison', () => {
  it('compares token identity, never rank ordering', () => {
    const left = firstTokenProbabilityDistribution(payload());
    const right = firstTokenProbabilityDistribution([{ ...payload()[0], probs: payload()[0].probs.reverse() }]);
    expect(compareProbabilityDistributions(left, right)).toEqual({ sharedTokens: 10, maxDelta: 0 });
    right.set('token-1', 0.05);
    expect(compareProbabilityDistributions(left, right).maxDelta).toBeCloseTo(0.03);
  });
  it('aggregates duplicate rendered token strings and does not invent probabilities for missing tokens', () => {
    const value = payload(); value[0].probs[1].tok_str = 'token-0';
    const result = firstTokenProbabilityDistribution(value);
    expect(result.get('token-0')).toBeCloseTo(0.03); expect(result.size).toBe(9);
    const right = new Map(result); right.delete('token-0'); right.set('not-in-left', 0.5);
    expect(compareProbabilityDistributions(result, right)).toEqual({ sharedTokens: 8, maxDelta: 0 });
  });
  it('requires enough shared tokens to draw a conclusion', () => {
    expect(() => compareProbabilityDistributions(new Map([['a', 0.1], ['b', 0.2]]), new Map([['a', 0.3], ['b', 0.2]]))).toThrow(/overlap/);
  });
  it('rejects missing, non-finite, negative, incomplete or impossible distributions', () => {
    expect(() => firstTokenProbabilityDistribution(undefined)).toThrow();
    const short = payload(); short[0].probs.pop();
    expect(() => firstTokenProbabilityDistribution(short)).toThrow();
    for (const probability of [NaN, Infinity, -0.1, 1.1, 0.9]) {
      const value = payload(); value[0].probs[0].prob = probability;
      expect(() => firstTokenProbabilityDistribution(value)).toThrow();
    }
  });
});
