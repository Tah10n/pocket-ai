import type { LlamaContext, NativeCompletionResult, TTSCapabilities } from 'llama.rn';
import { synthesizeTtsOnContext, validateTtsAudioPayload, validateTtsCompletion } from '../../src/services/TtsSynthesisRuntime';
import { TTS_EXECUTION_PROFILES, type TtsExecutionProfile } from '../../src/services/TtsExecutionProfiles';
import { TTS_LIMITS, TtsError, type TtsPhase } from '../../src/types/tts';
import { requireLlamaModule } from '../../src/services/llamaRnModule';
import type { LlamaCompletionResult } from '../../src/services/LlamaRuntimeAdapter';

jest.mock('../../src/services/llamaRnModule', () => ({ requireLlamaModule: jest.fn() }));

type FormattedAudio = Awaited<ReturnType<LlamaContext['getFormattedAudioCompletion']>>;
const tokensProfile = TTS_EXECUTION_PROFILES.find(profile => profile.flow === 'tokens')!;
const continuousProfile = TTS_EXECUTION_PROFILES.find(profile => profile.flow === 'continuous_embd')!;

function completed(overrides: Partial<NativeCompletionResult> = {}): NativeCompletionResult {
  return {
    text: '<|c1_1|><|c2_2|>', content: '', reasoning_content: '', tool_calls: [], chat_format: 0,
    tokens_predicted: 4, tokens_evaluated: 3, draft_tokens: 0, draft_tokens_accepted: 0,
    truncated: false, stopped_eos: true, stopped_word: '', stopped_limit: 0, stopping_word: '',
    context_full: false, interrupted: false, tokens_cached: 0,
    timings: { cache_n: 0, prompt_n: 3, prompt_ms: 1, prompt_per_token_ms: 1,
      prompt_per_second: 3, predicted_n: 4, predicted_ms: 1, predicted_per_token_ms: 1, predicted_per_second: 4 },
    audio_tokens: [1, 2, 3, 4], ...overrides,
  };
}

function capabilities(profile: TtsExecutionProfile): TTSCapabilities {
  return { type: 1, family: profile.family, promptKind: profile.promptKind,
    requiresPhonemes: false, defaultLanguage: profile.languages[0] };
}

function nativeContext(profile: TtsExecutionProfile = tokensProfile) {
  const native = {
    model: { metadata: { 'general.architecture': 'qwen2', 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.pre': 'qwen2' } },
    initVocoder: jest.fn(async (_params: Parameters<LlamaContext['initVocoder']>[0]) => true),
    isVocoderEnabled: jest.fn(async () => true),
    getTTSCapabilities: jest.fn(async () => capabilities(profile)),
    getFormattedAudioCompletion: jest.fn(async (_options: Parameters<LlamaContext['getFormattedAudioCompletion']>[0]): Promise<FormattedAudio> => ({
      prompt: 'native speech prompt', grammar: 'native audio grammar', embedding: profile.flow === 'continuous_embd', flow: profile.flow,
    })),
    tokenize: jest.fn(async (_text: string) => ({ tokens: [5, 6, 7], has_media: false })),
    getAudioSampleRate: jest.fn(async () => profile.sampleRate),
    completion: jest.fn(async (_params: Parameters<LlamaContext['completion']>[0]) => completed()),
    stopCompletion: jest.fn(async () => undefined),
    decodeAudioTokens: jest.fn(async (_codes: number[]) => [0.25, -0.5, 0.75]),
    decodeAudioEmbeddings: jest.fn(async (_values: number[], _dimension: number) => [0.25, -0.5, 0.75]),
    releaseVocoder: jest.fn(async () => undefined),
  };
  // The sole cast is the native mock boundary; method inputs/results use installed llama.rn types.
  const context = native as unknown as LlamaContext;
  return { native, context };
}

function options(profile: TtsExecutionProfile = tokensProfile) {
  return { text: 'Please speak this exact text.', language: profile.languages[0], codecPath: '/private/codec.gguf', assertCurrent: jest.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 200 && !predicate(); index++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requireLlamaModule).mockReturnValue({
    listTTSVoices: jest.fn(() => []), getTTSVoice: jest.fn(() => undefined), listTTSLanguages: jest.fn(() => []),
  } as unknown as ReturnType<typeof requireLlamaModule>);
});

it('maps the formatter prompt/grammar/embedding to one completion and decodes only its actual audio_tokens', async () => {
  const { native, context } = nativeContext();
  const source = completed({ text: '<|c1_999|><|c2_998|>', audio_tokens: [11, 12, 13, 14] });
  native.completion.mockResolvedValue(source);
  const phases: TtsPhase[] = [];
  const request = options();
  const result = await synthesizeTtsOnContext(context, tokensProfile, { ...request, onPhase: phase => phases.push(phase) });

  expect(native.getFormattedAudioCompletion).toHaveBeenCalledWith({ prompt: request.text, language: request.language });
  expect(native.completion).toHaveBeenCalledTimes(1);
  expect(native.completion.mock.calls[0][0]).toMatchObject({
    prompt: 'native speech prompt', grammar: 'native audio grammar', embedding: false,
    n_predict: tokensProfile.generationSteps, temperature: tokensProfile.sampling.temperature,
    stop: [], logit_bias: [], ignore_eos: false, n_probs: 0, prefill_text: '', enable_thinking: false,
  });
  expect(native.completion.mock.calls[0][0]).not.toHaveProperty('messages');
  expect(native.completion.mock.calls[0][0]).not.toHaveProperty('tools');
  expect(native.decodeAudioTokens).toHaveBeenCalledWith(source.audio_tokens);
  expect(native.decodeAudioEmbeddings).not.toHaveBeenCalled();
  expect(result).toEqual({ samples: [0.25, -0.5, 0.75], sampleRate: 24000, flow: 'tokens', audioElements: 4, promptTokens: 3 });
  expect(phases).toEqual(['loading', 'synthesizing', 'decoding', 'releasing']);
  expect(native.releaseVocoder).toHaveBeenCalledTimes(1);
});

it('passes frame-major continuous embeddings and returned embedding_dim unchanged without retrieval normalization', async () => {
  const { native, context } = nativeContext(continuousProfile);
  const embeddings = Array.from({ length: continuousProfile.latentDimension! * 2 }, (_, index) => index % 2 ? -4 : 5);
  native.completion.mockResolvedValue(completed({ audio_tokens: undefined, embeddings, embedding_dim: continuousProfile.latentDimension }));
  const result = await synthesizeTtsOnContext(context, continuousProfile, options(continuousProfile));
  expect(native.completion.mock.calls[0][0]).toMatchObject({ embedding: true, prompt: 'native speech prompt', grammar: 'native audio grammar' });
  expect(native.decodeAudioEmbeddings).toHaveBeenCalledWith(embeddings, continuousProfile.latentDimension);
  expect(native.decodeAudioTokens).not.toHaveBeenCalled();
  expect(result).toMatchObject({ flow: 'continuous_embd', audioElements: embeddings.length, sampleRate: 48000 });
});

it('does not manufacture grammar when the formatter omits it', async () => {
  const { native, context } = nativeContext();
  native.getFormattedAudioCompletion.mockResolvedValue({ prompt: 'exact prompt', embedding: false, flow: 'tokens' });
  await synthesizeTtsOnContext(context, tokensProfile, options());
  expect(native.completion.mock.calls[0][0]).not.toHaveProperty('grammar');
});

it('permits speaker-less synthesis with an empty voice list and rejects explicit unknown default', async () => {
  const { native, context } = nativeContext();
  await synthesizeTtsOnContext(context, tokensProfile, options());
  expect(native.getFormattedAudioCompletion.mock.calls[0][0]).not.toHaveProperty('speaker');
  expect(requireLlamaModule).not.toHaveBeenCalled();
  native.getFormattedAudioCompletion.mockClear();
  native.completion.mockClear();
  await expect(synthesizeTtsOnContext(context, tokensProfile, { ...options(), speaker: 'default' }))
    .rejects.toMatchObject({ code: 'voice_unavailable' });
  expect(native.getFormattedAudioCompletion).not.toHaveBeenCalled();
  expect(native.completion).not.toHaveBeenCalled();
});

it('fails requiresPhonemes before formatting or completion without a ready phonemizer', async () => {
  const { native, context } = nativeContext();
  native.getTTSCapabilities.mockResolvedValue({ ...capabilities(tokensProfile), requiresPhonemes: true });
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'prerequisite_missing' });
  expect(native.getFormattedAudioCompletion).not.toHaveBeenCalled();
  expect(native.completion).not.toHaveBeenCalled();
  expect(native.releaseVocoder).toHaveBeenCalledTimes(1);
});

it.each(['', 'unknown', 'continuous_embd'])('rejects unknown or profile-incompatible formatter flow %s', async flow => {
  const { native, context } = nativeContext();
  native.getFormattedAudioCompletion.mockResolvedValue({ prompt: 'native prompt', embedding: false, flow } as FormattedAudio);
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'codec_incompatible' });
  expect(native.completion).not.toHaveBeenCalled();
  expect(native.decodeAudioTokens).not.toHaveBeenCalled();
});

it('rejects continuous flow without the formatter embedding flag', async () => {
  const { native, context } = nativeContext(continuousProfile);
  native.getFormattedAudioCompletion.mockResolvedValue({ prompt: 'native prompt', embedding: false, flow: 'continuous_embd' });
  await expect(synthesizeTtsOnContext(context, continuousProfile, options(continuousProfile))).rejects.toMatchObject({ code: 'codec_incompatible' });
  expect(native.completion).not.toHaveBeenCalled();
});

it.each([
  { stopped_eos: false, stopped_limit: false },
  { stopped_eos: undefined }, { interrupted: true }, { context_full: true },
  { truncated: true }, { stopped_limit: true }, { stopped_word: true },
] satisfies LlamaCompletionResult[])('rejects partial completion flags %j before decode', async flags => {
  expect(() => validateTtsCompletion({ ...completed(), ...flags })).toThrow('generation_incomplete');
});

it('rejects limit-like completion with all stop flags false when EOS is absent', async () => {
  const { native, context } = nativeContext();
  native.completion.mockResolvedValue(completed({ stopped_eos: false, stopped_limit: 0, stopped_word: '' }));
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'generation_incomplete' });
  expect(native.decodeAudioTokens).not.toHaveBeenCalled();
});

it.each([undefined, [], [1], [-1, 1], [1024, 1], [0.5, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1]])
('rejects invalid token payload %j without decoder repair', audio_tokens => {
  expect(() => validateTtsAudioPayload({ audio_tokens }, 'tokens', tokensProfile, tokensProfile.sampleRate)).toThrow('payload_invalid');
});

it.each([
  { embeddings: [], embedding_dim: 64 }, { embeddings: [1], embedding_dim: 64 },
  { embeddings: [1, 2], embedding_dim: 0 }, { embeddings: [1, 2], embedding_dim: undefined },
  { embeddings: [1, 2], embedding_dim: 1.5 }, { embeddings: [1, 2], embedding_dim: 384 },
  { embeddings: Array(64).fill(Number.NaN), embedding_dim: 64 },
  { embeddings: Array(64).fill(Number.POSITIVE_INFINITY), embedding_dim: 64 },
] satisfies LlamaCompletionResult[])('rejects malformed continuous payload %j', result => {
  expect(() => validateTtsAudioPayload(result, 'continuous_embd', continuousProfile, continuousProfile.sampleRate)).toThrow('payload_invalid');
});

it('rejects a native non-array audio payload through the real completion adapter', async () => {
  const { native, context } = nativeContext();
  native.completion.mockResolvedValue({ ...completed(), audio_tokens: '1,2,3,4' } as unknown as NativeCompletionResult);
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'native_failed' });
  expect(native.decodeAudioTokens).not.toHaveBeenCalled();
});

it('bounds code count before native decode', async () => {
  const { native, context } = nativeContext();
  native.completion.mockResolvedValue(completed({ audio_tokens: Array((tokensProfile.maxFrames + 1) * tokensProfile.codebooks!).fill(1) }));
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'payload_invalid' });
  expect(native.decodeAudioTokens).not.toHaveBeenCalled();
});

it('bounds predicted PCM and duration from frame count before decoder allocation', async () => {
  const profile = { ...continuousProfile, maxFrames: 500 };
  const { native, context } = nativeContext(profile);
  native.completion.mockResolvedValue(completed({ audio_tokens: undefined, embeddings: Array(profile.latentDimension! * 401).fill(0.25), embedding_dim: profile.latentDimension }));
  await expect(synthesizeTtsOnContext(context, profile, options(profile))).rejects.toMatchObject({ code: 'input_too_large' });
  expect(native.decodeAudioEmbeddings).not.toHaveBeenCalled();
});

it.each([8000, 16000, 44100, 96000])('uses codec-reported sample rate %s when the execution profile agrees', async sampleRate => {
  const profile = { ...tokensProfile, sampleRate };
  const { context } = nativeContext(profile);
  await expect(synthesizeTtsOnContext(context, profile, options(profile))).resolves.toMatchObject({ sampleRate });
});

it.each([0, Number.NaN, 24000.5, 48000, 192001])('rejects invalid or profile-mismatched sample rate %s before generation', async sampleRate => {
  const { native, context } = nativeContext();
  native.getAudioSampleRate.mockResolvedValue(sampleRate);
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'codec_incompatible' });
  expect(native.completion).not.toHaveBeenCalled();
});

it.each([[], [Number.NaN], [Number.POSITIVE_INFINITY], new Array(TTS_LIMITS.pcmSamples + 1)].map(samples => ({ samples })))
('rejects empty, nonfinite or oversized decoded PCM', async ({ samples }) => {
  const { native, context } = nativeContext();
  native.decodeAudioTokens.mockResolvedValue(samples);
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'decode_failed' });
  expect(native.releaseVocoder).toHaveBeenCalledTimes(1);
});

it('rejects decoded duration beyond the current sample rate bound', async () => {
  const profile = { ...tokensProfile, sampleRate: 8000 };
  const { native, context } = nativeContext(profile);
  native.decodeAudioTokens.mockResolvedValue(new Array(profile.sampleRate * TTS_LIMITS.durationSeconds + 1));
  await expect(synthesizeTtsOnContext(context, profile, options(profile))).rejects.toMatchObject({ code: 'decode_failed' });
});

it.each(['', 'a'.repeat(TTS_LIMITS.textCharacters + 1)])('rejects empty or oversized text before init', async text => {
  const { native, context } = nativeContext();
  await expect(synthesizeTtsOnContext(context, tokensProfile, { ...options(), text })).rejects.toMatchObject({ code: 'input_too_large' });
  expect(native.initVocoder).not.toHaveBeenCalled();
});

it('rejects unsupported language before init', async () => {
  const { native, context } = nativeContext();
  await expect(synthesizeTtsOnContext(context, tokensProfile, { ...options(), language: 'ru' })).rejects.toMatchObject({ code: 'language_unsupported' });
  expect(native.initVocoder).not.toHaveBeenCalled();
});

it('checks the complete formatted token budget before completion', async () => {
  const { native, context } = nativeContext();
  native.tokenize.mockResolvedValue({ tokens: Array(TTS_LIMITS.promptTokens + 1).fill(1), has_media: false });
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'input_too_large' });
  expect(native.completion).not.toHaveBeenCalled();
});

it('keeps Stop during codec init pending until the real init and release settle', async () => {
  const { native, context } = nativeContext();
  const init = deferred<boolean>();
  native.initVocoder.mockReturnValueOnce(init.promise);
  const abort = new AbortController();
  const result = synthesizeTtsOnContext(context, tokensProfile, { ...options(), signal: abort.signal });
  const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
  await until(() => native.initVocoder.mock.calls.length === 1);
  abort.abort(); await flush();
  expect(native.releaseVocoder).not.toHaveBeenCalled();
  expect(native.stopCompletion).not.toHaveBeenCalled();
  init.resolve(true); await rejected;
  expect(native.completion).not.toHaveBeenCalled();
  expect(native.releaseVocoder).toHaveBeenCalledTimes(1);
});

it('uses native completion Stop and drains both completion and stop before releasing codec', async () => {
  const { native, context } = nativeContext();
  const completion = deferred<NativeCompletionResult>();
  const stopping = deferred<undefined>();
  native.completion.mockReturnValueOnce(completion.promise);
  native.stopCompletion.mockReturnValueOnce(stopping.promise);
  const abort = new AbortController();
  const result = synthesizeTtsOnContext(context, tokensProfile, { ...options(), signal: abort.signal });
  const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
  await until(() => native.completion.mock.calls.length === 1);
  abort.abort(); await until(() => native.stopCompletion.mock.calls.length === 1);
  completion.resolve(completed()); await flush();
  expect(native.releaseVocoder).not.toHaveBeenCalled();
  stopping.resolve(undefined); await rejected;
  expect(native.decodeAudioTokens).not.toHaveBeenCalled();
  expect(native.releaseVocoder).toHaveBeenCalledTimes(1);
});

it('awaits a noncancellable decode after Stop, discards late PCM and allows a later fresh synthesis', async () => {
  const { native, context } = nativeContext();
  const decoding = deferred<number[]>();
  native.decodeAudioTokens.mockReturnValueOnce(decoding.promise);
  const abort = new AbortController();
  const result = synthesizeTtsOnContext(context, tokensProfile, { ...options(), signal: abort.signal });
  const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
  await until(() => native.decodeAudioTokens.mock.calls.length === 1);
  abort.abort(); await flush();
  expect(native.releaseVocoder).not.toHaveBeenCalled();
  expect(native.stopCompletion).not.toHaveBeenCalled();
  decoding.resolve([0.8, -0.8]); await rejected;
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).resolves.toMatchObject({ samples: [0.25, -0.5, 0.75] });
  expect(native.releaseVocoder).toHaveBeenCalledTimes(2);
});

it('retains codec release ownership and rejects a late ready result after Stop during release', async () => {
  const { native, context } = nativeContext();
  const releasing = deferred<undefined>();
  native.releaseVocoder.mockReturnValueOnce(releasing.promise);
  const abort = new AbortController();
  let settled = false;
  const result = synthesizeTtsOnContext(context, tokensProfile, { ...options(), signal: abort.signal });
  void result.then(() => { settled = true; }, () => { settled = true; });
  const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
  await until(() => native.releaseVocoder.mock.calls.length === 1);
  abort.abort(); await flush();
  expect(settled).toBe(false);
  expect(native.stopCompletion).not.toHaveBeenCalled();
  releasing.resolve(undefined); await rejected;
});

it('invalidates stale request selection during decode without returning a clip', async () => {
  const { native, context } = nativeContext();
  const decoding = deferred<number[]>();
  native.decodeAudioTokens.mockReturnValueOnce(decoding.promise);
  let selected = true;
  const assertCurrent = () => { if (!selected) throw new TtsError('selection_changed'); };
  const result = synthesizeTtsOnContext(context, tokensProfile, { ...options(), assertCurrent });
  const rejected = expect(result).rejects.toMatchObject({ code: 'selection_changed' });
  await until(() => native.decodeAudioTokens.mock.calls.length === 1);
  selected = false;
  decoding.resolve([0.7]); await rejected;
  expect(native.releaseVocoder).toHaveBeenCalledTimes(1);
});

it('retains the primary controlled failure when codec release also rejects', async () => {
  const { native, context } = nativeContext();
  const primary = new TtsError('payload_invalid');
  native.completion.mockRejectedValue(primary);
  native.releaseVocoder.mockRejectedValue(new Error('private native cleanup detail'));
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({
    code: 'payload_invalid', operationError: primary, cleanupError: { code: 'release_failed' },
  });
  expect(native.releaseVocoder).toHaveBeenCalledTimes(1);
});

it('sanitizes an unexpected native failure and reports release failure when synthesis otherwise succeeded', async () => {
  const { native, context } = nativeContext();
  native.completion.mockRejectedValueOnce(new Error('private text /private/path'));
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'native_failed', message: 'native_failed' });
  native.releaseVocoder.mockRejectedValueOnce(new Error('private native cleanup detail'));
  await expect(synthesizeTtsOnContext(context, tokensProfile, options())).rejects.toMatchObject({ code: 'release_failed', message: 'release_failed' });
});
