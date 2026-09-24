import type { CompletionParams } from 'llama.rn';
import {
  advancedGenerationIdentity,
  freezeGenerationParameters,
  generationFormattingIdentity,
  getPreparedTemplateNow,
  resolveAdvancedSampling,
  sanitizeAdvancedGenerationParameters,
  sanitizeChatTemplate,
  sanitizeLogitBias,
} from '../../src/utils/generationControls';

describe('generation controls for llama.rn 0.13.0-rc.3', () => {
  it('freezes automatic clock across engine refreezing without persisting an explicit override', () => {
    const frozen = freezeGenerationParameters({ template: { jinja: false } }, 100);
    expect(frozen.template?.now).toBeUndefined();
    expect(getPreparedTemplateNow(frozen)).toBe(100);
    expect(getPreparedTemplateNow(freezeGenerationParameters(frozen, 200))).toBe(100);
    expect(JSON.parse(JSON.stringify(frozen))).toEqual({ template: { jinja: false } });
    expect(generationFormattingIdentity(frozen)).not.toBe(generationFormattingIdentity(freezeGenerationParameters({ template: { jinja: false } }, 101)));
    const explicit = freezeGenerationParameters({ template: { now: 0 } }, 100);
    expect(explicit.template?.now).toBe(0);
    expect(getPreparedTemplateNow(explicit)).toBe(0);
  });
  it('preserves absence separately from meaningful zero, false and empty lists', () => {
    expect(sanitizeAdvancedGenerationParameters({})).toEqual({});
    const input = { nProbs: 0, penaltyLastN: 0, mirostat: 0, ignoreEos: false,
      stop: [], logitBias: [], drySequenceBreakers: [], template: { jinja: false, now: 0, kwargs: {} } };
    expect(sanitizeAdvancedGenerationParameters(input)).toEqual(input);
    expect(advancedGenerationIdentity(input)).not.toBe(advancedGenerationIdentity({}));
  });

  it('clones nested arrays and preserves significant whitespace', () => {
    const input = { stop: [' end ', '\n'], drySequenceBreakers: [' '], logitBias: [[5, 0]] };
    const sanitized = sanitizeAdvancedGenerationParameters(input);
    sanitized.stop?.push('extra');
    sanitized.logitBias![0][1] = 1;
    expect(input.stop).toEqual([' end ', '\n']);
    expect(input.logitBias).toEqual([[5, 0]]);
    expect(sanitized.drySequenceBreakers).toEqual([' ']);
  });

  it('uses numeric token pairs only, not unsupported comment aliases', () => {
    for (const logitBias of [[['word', -1]], [[4, false]], [[4, Infinity]], [[-1, 1]], [[4, 1, 2]]]) {
      expect(sanitizeAdvancedGenerationParameters({ logitBias }).logitBias).toBeUndefined();
    }
    expect(sanitizeAdvancedGenerationParameters({ logitBias: [[0, -100], [5, 0]] }).logitBias)
      .toEqual([[0, -100], [5, 0]]);
  });

  it('canonicalizes numeric bias pairs with last duplicate winning and independent storage', () => {
    const pairs = [[7, 2], [0, -100], [7, 0], [2, 100]];
    expect(sanitizeLogitBias(pairs)).toEqual([[0, -100], [2, 100], [7, 0]]);
    expect(advancedGenerationIdentity({ logitBias: pairs }))
      .toBe(advancedGenerationIdentity({ logitBias: [[7, 0], [2, 100], [0, -100]] }));
    expect(pairs).toEqual([[7, 2], [0, -100], [7, 0], [2, 100]]);
    expect(sanitizeLogitBias([])).toEqual([]);
    expect(sanitizeLogitBias([[2147483647, 0]])).toEqual([[2147483647, 0]]);
    for (const value of [[[0.5, 1]], [[2147483648, 1]], [[0, 100.1]], [[0, -100.1]],
      [[0, NaN]], [[0, '1']], Array.from({ length: 129 }, () => [0, 1])]) {
      expect(sanitizeLogitBias(value)).toBeUndefined();
    }
  });

  it('does not coerce null, booleans or strings into native numbers', () => {
    expect(sanitizeAdvancedGenerationParameters({ nProbs: true, penaltyLastN: null, typicalP: '0.8',
      mirostat: 3, dryMultiplier: NaN, ignoreEos: 'false' })).toEqual({});
    expect(sanitizeAdvancedGenerationParameters({ nProbs: 200, penaltyLastN: -20, typicalP: 9 }))
      .toEqual({ nProbs: 10, penaltyLastN: -1, typicalP: 1 });
  });

  it('maps every mutable native sampler explicitly and resets after another chat', () => {
    const first: CompletionParams = resolveAdvancedSampling({ nProbs: 3, mirostat: 2,
      dryMultiplier: 1, typicalP: 0.7, xtcProbability: 0.4, frequencyPenalty: -0.5 });
    const second: CompletionParams = resolveAdvancedSampling({});
    expect(first).toMatchObject({ n_probs: 3, mirostat: 2, dry_multiplier: 1,
      typical_p: 0.7, xtc_probability: 0.4, penalty_freq: -0.5 });
    expect(second).toMatchObject({ n_probs: 0, mirostat: 0, dry_multiplier: 0,
      typical_p: 1, xtc_probability: 0, penalty_freq: 0, top_n_sigma: -1,
      ignore_eos: false, logit_bias: [], dry_sequence_breakers: ['\n', ':', '"', '*'] });
    expect(resolveAdvancedSampling({ drySequenceBreakers: [], penaltyLastN: 0 }))
      .toMatchObject({ dry_sequence_breakers: [], penalty_last_n: 0 });
  });

  it('rejects EOS suppression with explicit output constraints before native grammar exhaustion', () => {
    for (const output of [{ mode: 'json_object' as const }, { mode: 'json_schema' as const, schema: '{}' },
      { mode: 'gbnf' as const, grammar: 'root ::= "yes"' }]) {
      expect(() => resolveAdvancedSampling({ ignoreEos: true, output })).toThrow('structured output constraints');
    }
  });

  it('maps EOS suppression and canonical numeric biases to the patched pinned bridge', () => {
    const input = { ignoreEos: true, logitBias: [[5, 10], [0, -100], [5, 0]] as [number, number][] };
    const request: CompletionParams = resolveAdvancedSampling(input);
    expect(request).toMatchObject({ ignore_eos: true, logit_bias: [[0, -100], [5, 0]] });
    request.logit_bias![0][1] = 99;
    expect(input.logitBias).toEqual([[5, 10], [0, -100], [5, 0]]);
    expect(resolveAdvancedSampling({})).toMatchObject({ ignore_eos: false, logit_bias: [] });
  });

  it('accepts bounded template data only without changing content', () => {
    const template = { chatTemplate: ' {{ messages }} ', prefillText: '\n{', now: '123.5',
      kwargs: { flag: false, count: 0, content: ' hello ' }, forcePureContent: false, addGenerationPrompt: false };
    expect(sanitizeChatTemplate(template)).toEqual(template);
    expect(sanitizeChatTemplate({ now: 'yesterday', kwargs: { nested: {} } })).toEqual({});
    expect(sanitizeChatTemplate({ kwargs: JSON.parse('{"__proto__":"bad"}') })).toEqual({});
  });

  it('keeps one explicit output constraint and never combines schema and grammar', () => {
    expect(sanitizeAdvancedGenerationParameters({ output: { mode: 'json_schema', schema: '{bad', grammar: 'x' } }))
      .toEqual({ output: { mode: 'json_schema', schema: '{bad' } });
  });
});
