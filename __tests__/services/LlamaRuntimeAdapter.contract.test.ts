import type { JinjaFormattedChatResult, LlamaContext, NativeCompletionResult, TokenData } from 'llama.rn';
import {
  normalizeCompletionResult, normalizeFormattedChatResult, normalizeTokenData,
  runCompletionOnContext,
} from '../../src/services/LlamaRuntimeAdapter';

// These fixtures are checked by tsc against installed declarations, independently
// of Jest's runtime mock. Include every declared final-result field deliberately.
const finalFixture = {
  text: 'raw', content: '', reasoning_content: '', tool_calls: [], chat_format: 0,
  tokens_predicted: 2, tokens_evaluated: 3, draft_tokens: 4, draft_tokens_accepted: 2,
  truncated: false, stopped_eos: false, stopped_word: '', stopped_limit: 0,
  stopping_word: '', context_full: false, interrupted: false, tokens_cached: 3,
  timings: { cache_n: 3, prompt_n: 3, prompt_ms: 4, prompt_per_token_ms: 4 / 3,
    prompt_per_second: 750, predicted_n: 2, predicted_ms: 10,
    predicted_per_token_ms: 5, predicted_per_second: 200 },
  completion_probabilities: [], embeddings: [0.1, 0.2], embedding_dim: 2, audio_tokens: [1, 2],
} satisfies NativeCompletionResult;
// A newly declared result field must be accounted for in this contract test.
type AssertNever<T extends never> = T;
export type CoveredCompletionFields = AssertNever<Exclude<keyof NativeCompletionResult, keyof typeof finalFixture>>;

const streamFixture = {
  token: '', content: '', reasoning_content: 'plan', accumulated_text: '<think>plan',
  requestId: 0, tool_calls: [{ type: 'function', id: '', function: { name: 'lookup', arguments: '{"q":' } }],
  completion_probabilities: [{ content: '', probs: [{ tok_str: '', prob: 0 }] }],
} satisfies TokenData;
export type CoveredTokenFields = AssertNever<Exclude<keyof TokenData, keyof typeof streamFixture>>;

const formatFixture = {
  type: 'jinja', prompt: '', has_media: false, media_paths: [], additional_stops: [' ', ''],
  chat_format: 0, grammar: '', grammar_lazy: false, grammar_triggers: [], generation_prompt: '',
  thinking_forced_open: false, thinking_start_tag: '', thinking_end_tag: '',
  preserved_tokens: ['', ' '], chat_parser: '',
} satisfies JinjaFormattedChatResult;
export type CoveredFormatFields = AssertNever<Exclude<keyof JinjaFormattedChatResult, keyof typeof formatFixture>>;

describe('installed llama.rn result contracts', () => {
  it('preserves streaming tool arguments without parsing incomplete JSON', () => {
    expect(normalizeTokenData(streamFixture)).toEqual(streamFixture);
    expect(normalizeTokenData(streamFixture).tool_calls).toBe(streamFixture.tool_calls);
  });

  it('preserves native null IDs as distinct from absent and empty IDs', () => {
    const calls = [undefined, null, ''].map((id) => ({
      type: 'function', function: { name: '', arguments: '' }, ...(id !== undefined ? { id } : {}),
    }));
    expect(normalizeTokenData({ token: '', tool_calls: calls }).tool_calls).toEqual(calls);
    expect(normalizeCompletionResult({ tool_calls: calls }).tool_calls).toEqual(calls);
  });

  it('keeps empty arrays, empty text and missing fields distinct', () => {
    expect(normalizeTokenData({ token: '' })).toEqual({ token: '' });
    expect(normalizeTokenData({ token: '', tool_calls: [], content: '', reasoning_content: '', accumulated_text: '' }))
      .toEqual({ token: '', tool_calls: [], content: '', reasoning_content: '', accumulated_text: '' });
    expect(normalizeCompletionResult({ tool_calls: [], audio_tokens: [], embeddings: [] }))
      .toEqual({ tool_calls: [], audio_tokens: [], embeddings: [] });
  });

  it.each([null, {}, [{ type: 'function', function: { name: 'lookup', arguments: {} } }],
    [{ type: 'function', id: 4, function: { name: 'lookup', arguments: '{}' } }]])(
    'rejects malformed tool calls without exposing their contents', (tool_calls) => {
      expect(() => normalizeTokenData({ tool_calls })).toThrow('token tool_calls');
      expect(() => normalizeCompletionResult({ tool_calls })).toThrow('completion tool_calls');
    },
  );

  it('preserves every formatted field, including whitespace and empty stop sequences', () => {
    expect(normalizeFormattedChatResult(formatFixture)).toEqual(formatFixture);
    expect(normalizeFormattedChatResult({ prompt: '', additional_stops: [1, ' stop ', ''] }).additional_stops)
      .toEqual([' stop ', '']);
  });

  it('preserves final telemetry and nontext arrays without allocating copies', () => {
    const input = { ...finalFixture, requestId: 27, stopped_word: false, stopped_limit: true };
    const result = normalizeCompletionResult(input);
    expect(result).toEqual(input);
    expect(result.embeddings).toBe(input.embeddings);
    expect(result.audio_tokens).toBe(input.audio_tokens);
    expect(result.timings).toBe(input.timings);
    expect(normalizeTokenData({ token: 'x', embeddings: input.embeddings, audio_tokens: input.audio_tokens }))
      .toEqual({ token: 'x' });
  });

  it.each([NaN, 1.5, '1', null])('rejects invalid request identity %p', (requestId) => {
    expect(() => normalizeTokenData({ requestId })).toThrow('requestId');
    expect(() => normalizeCompletionResult({ requestId })).toThrow('requestId');
  });

  it('rejects malformed probabilities, timing counters and nontext payloads', () => {
    expect(() => normalizeTokenData({ completion_probabilities: [{}] })).toThrow('probabilities');
    expect(() => normalizeCompletionResult({ timings: { predicted_ms: NaN } })).toThrow('timings');
    expect(() => normalizeCompletionResult({ embeddings: ['payload'] })).toThrow('embeddings');
    expect(() => normalizeCompletionResult({ audio_tokens: null })).toThrow('audio_tokens');
  });

  it('catches callback errors, stops the captured context and drains completion', async () => {
    let deliver: ((data: TokenData) => void) | undefined;
    let finish!: (value: NativeCompletionResult) => void;
    const nativeResult = new Promise<NativeCompletionResult>((resolve) => { finish = resolve; });
    const completion: LlamaContext['completion'] = jest.fn((_params, callback) => {
      deliver = callback;
      return nativeResult;
    });
    const stopCompletion = jest.fn(async () => { finish(finalFixture); });
    const failure = new Error('consumer failed');
    const onToken = jest.fn(() => { throw failure; });
    const result = runCompletionOnContext({ context: { completion, stopCompletion }, params: { prompt: 'fixture' }, onToken });
    const rejected = expect(result).rejects.toBe(failure);
    expect(() => deliver?.(streamFixture)).not.toThrow();
    deliver?.(streamFixture);
    await rejected;
    deliver?.(streamFixture);
    expect(stopCompletion).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it('ignores callbacks arriving after native completion has settled', async () => {
    let deliver: ((data: TokenData) => void) | undefined;
    const completion: LlamaContext['completion'] = jest.fn(async (_params, callback) => {
      deliver = callback;
      return finalFixture;
    });
    const onToken = jest.fn();
    await runCompletionOnContext({ context: { completion, stopCompletion: jest.fn() }, params: { prompt: 'fixture' }, onToken });
    deliver?.(streamFixture);
    expect(onToken).not.toHaveBeenCalled();
  });

  it('reports a missing completion method explicitly', async () => {
    await expect(runCompletionOnContext({
      // Deliberately malformed runtime boundary, not a declaration fixture.
      context: {} as never, params: { prompt: 'fixture' },
    })).rejects.toThrow('llama.rn feature is unavailable: completion');
  });
});
