import type { CompletionParams, LlamaContext } from 'llama.rn';
import { TTS_LIMITS, TtsError, TtsCleanupError, type TtsFlow, type TtsObservation, type TtsPhase } from '../types/tts';
import type { TtsExecutionProfile } from './TtsExecutionProfiles';
import { requireLlamaModule } from './llamaRnModule';
import { getCompletionPromptTokenCount } from './LlamaPromptTokenCount';
import { runCompletionOnContext, type LlamaCompletionResult } from './LlamaRuntimeAdapter';

export interface TtsRuntimeOptions {
  text: string;
  language: string;
  speaker?: string;
  codecPath: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  onPhase?: (phase: TtsPhase) => void;
  observe?: (event: TtsObservation) => void;
}
export interface TtsPcmResult {
  samples: number[];
  sampleRate: number;
  flow: TtsFlow;
  audioElements: number;
  promptTokens: number;
}

export function validateTtsCompletion(result: LlamaCompletionResult): void {
  // Continuous/codec-AR limit exits in rc.3 may leave stopped_limit=false. Only EOS proves
  // natural termination. Hook errors can still return partial latent/code arrays.
  if (result.interrupted || result.context_full || result.truncated || result.stopped_limit
    || result.stopped_word || result.stopped_eos !== true) throw new TtsError('generation_incomplete');
}

export function validateTtsAudioPayload(
  result: LlamaCompletionResult, flow: TtsFlow, profile: TtsExecutionProfile, sampleRate: number,
): { elements: number[]; dimension?: number; frames: number } {
  let elements: number[] | undefined;
  let frames: number;
  let dimension: number | undefined;
  if (flow === 'tokens') {
    elements = result.audio_tokens;
    const codebooks = profile.codebooks;
    if (!codebooks || !profile.codebookSize || !Array.isArray(elements) || !elements.length
      || elements.length > profile.maxFrames * codebooks || elements.length % codebooks
      || elements.some(value => !Number.isSafeInteger(value) || value < 0 || value >= profile.codebookSize!)) {
      throw new TtsError('payload_invalid');
    }
    frames = elements.length / codebooks;
  } else {
    elements = result.embeddings;
    dimension = result.embedding_dim;
    if (!Number.isSafeInteger(dimension) || !dimension || dimension < 1
      || dimension !== profile.latentDimension || !Array.isArray(elements) || !elements.length
      || elements.length > profile.maxFrames * dimension || elements.length % dimension
      || elements.some(value => !Number.isFinite(value))) throw new TtsError('payload_invalid');
    frames = elements.length / dimension;
  }
  // Known codec metadata bounds decode allocation before calling native, including Blue's
  // decode hop (1920 at 48k), which differs from its encoder hop (640 at 16k).
  const predictedSamples = frames * profile.samplesPerFrame;
  if (!Number.isSafeInteger(predictedSamples) || predictedSamples > TTS_LIMITS.pcmSamples
    || predictedSamples / sampleRate > TTS_LIMITS.durationSeconds) throw new TtsError('input_too_large');
  return { elements, dimension, frames };
}

export async function synthesizeTtsOnContext(
  context: LlamaContext, profile: TtsExecutionProfile, options: TtsRuntimeOptions,
): Promise<TtsPcmResult> {
  const check = () => { options.assertCurrent(); if (options.signal?.aborted) throw new TtsError('cancelled'); };
  const observe = (event: TtsObservation) => { try { options.observe?.(event); } catch { /* Observation cannot alter ownership. */ } };
  const observed = async <T>(operation: TtsObservation['operation'], call: () => Promise<T>): Promise<T> => {
    observe({ operation, phase: 'started' });
    try { return await call(); } finally { observe({ operation, phase: 'settled' }); }
  };
  check();
  if (!options.text.trim() || options.text.length > TTS_LIMITS.textCharacters) throw new TtsError('input_too_large');
  if (!profile.languages.includes(options.language)) throw new TtsError('language_unsupported');
  let initIssued = false;
  let primaryError: unknown;
  let stopFailed = false;
  let stopping: Promise<void> | undefined;
  let completionActive = false;
  const stop = () => {
    if (completionActive && !stopping) {
      stopping = Promise.resolve().then(() => observed('completion_stop', () => context.stopCompletion())).catch(() => { stopFailed = true; });
    }
  };
  options.signal?.addEventListener('abort', stop);
  try {
    options.onPhase?.('loading');
    initIssued = true;
    const initialized = await observed('vocoder_init', () => context.initVocoder({ path: options.codecPath, n_batch: 512, use_gpu: false }));
    check();
    if (!initialized || !await context.isVocoderEnabled()) throw new TtsError('codec_incompatible');
    check();
    const capabilities = await context.getTTSCapabilities();
    check();
    if (typeof capabilities.requiresPhonemes !== 'boolean') throw new TtsError('codec_incompatible');
    if (capabilities.requiresPhonemes) throw new TtsError('prerequisite_missing');
    if (capabilities.family !== profile.family || capabilities.promptKind !== profile.promptKind) throw new TtsError('codec_incompatible');
    // These helpers enumerate JS voice payloads, not supported speech languages. Empty voices
    // are valid for both admitted speaker-less profiles. Never manufacture speaker:'default'.
    if (options.speaker !== undefined) {
      const llama = requireLlamaModule();
      const voices = llama.listTTSVoices(capabilities.family, options.language);
      if (!voices.includes(options.speaker) || !llama.getTTSVoice(capabilities.family, options.speaker, options.language)) {
        throw new TtsError('voice_unavailable');
      }
    }
    const formatted = await context.getFormattedAudioCompletion({ prompt: options.text, language: options.language,
      ...(options.speaker === undefined ? {} : { speaker: options.speaker }) });
    check();
    if ((formatted.flow !== 'tokens' && formatted.flow !== 'continuous_embd') || formatted.flow !== profile.flow
      || typeof formatted.embedding !== 'boolean' || (formatted.flow === 'continuous_embd' && !formatted.embedding)
      || typeof formatted.prompt !== 'string' || !formatted.prompt || formatted.prompt.length > TTS_LIMITS.promptCharacters
      || (formatted.grammar !== undefined && typeof formatted.grammar !== 'string')) throw new TtsError('codec_incompatible');
    const tokenized = await context.tokenize(formatted.prompt);
    check();
    const promptTokens = getCompletionPromptTokenCount(context, tokenized);
    if (promptTokens > TTS_LIMITS.promptTokens || promptTokens + profile.generationSteps > profile.contextTokens) throw new TtsError('input_too_large');
    const sampleRate = await context.getAudioSampleRate();
    check();
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || sampleRate !== profile.sampleRate) throw new TtsError('codec_incompatible');
    const params: CompletionParams = {
      prompt: formatted.prompt, ...(formatted.grammar === undefined ? {} : { grammar: formatted.grammar }),
      embedding: formatted.embedding, n_predict: profile.generationSteps, ...profile.sampling,
      n_threads: 4, seed: 42, min_p: profile.family === 'outetts' ? 0.05 : 0, typical_p: 1, penalty_last_n: 64, penalty_freq: 0, penalty_present: 0,
      mirostat: 0, mirostat_tau: 5, mirostat_eta: 0.1, xtc_probability: 0, xtc_threshold: 0.1,
      dry_multiplier: 0, dry_base: 1.75, dry_allowed_length: 2, dry_penalty_last_n: -1,
      dry_sequence_breakers: [], top_n_sigma: -1, ignore_eos: false, logit_bias: [], stop: [], n_probs: 0,
      chat_format: 0, chat_parser: '', generation_prompt: '', prefill_text: '', grammar_lazy: false,
      grammar_triggers: [], preserved_tokens: [], enable_thinking: false, reasoning_format: 'none',
      thinking_budget_tokens: -1, thinking_budget_message: '',
    };
    options.onPhase?.('synthesizing');
    check();
    completionActive = true;
    let result: LlamaCompletionResult;
    observe({ operation: 'completion', phase: 'started', flow: formatted.flow });
    try {
      result = await runCompletionOnContext({ context, params });
      observe({ operation: 'completion', phase: 'settled', flow: formatted.flow,
        elementCount: formatted.flow === 'tokens' ? result.audio_tokens?.length : result.embeddings?.length,
        tokensPredicted: result.tokens_predicted, tokensEvaluated: result.tokens_evaluated,
        interrupted: result.interrupted, stoppedEos: result.stopped_eos });
    } catch (error) { observe({ operation: 'completion', phase: 'settled', flow: formatted.flow }); throw error; }
    finally { completionActive = false; await stopping; }
    check();
    if (stopFailed) throw new TtsError('native_failed');
    validateTtsCompletion(result);
    const payload = validateTtsAudioPayload(result, formatted.flow, profile, sampleRate);
    options.onPhase?.('decoding');
    check();
    observe({ operation: 'decode', phase: 'started', flow: formatted.flow, elementCount: payload.elements.length });
    let samples: number[];
    try {
      samples = await (formatted.flow === 'tokens' ? context.decodeAudioTokens(payload.elements)
        : context.decodeAudioEmbeddings(payload.elements, payload.dimension!));
    } catch (error) {
      observe({ operation: 'decode', phase: 'settled', flow: formatted.flow });
      throw error;
    }
    observe({ operation: 'decode', phase: 'settled', flow: formatted.flow, elementCount: payload.elements.length,
      sampleRate, sampleCount: Array.isArray(samples) ? samples.length : undefined });
    check();
    if (!Array.isArray(samples) || !samples.length || samples.length > TTS_LIMITS.pcmSamples
      || samples.length / sampleRate > TTS_LIMITS.durationSeconds
      || samples.some(value => !Number.isFinite(value))) throw new TtsError('decode_failed');
    return { samples, sampleRate, flow: formatted.flow, audioElements: payload.elements.length, promptTokens };
  } catch (error) {
    primaryError = error instanceof TtsError ? error : new TtsError('native_failed');
    throw primaryError;
  } finally {
    options.signal?.removeEventListener('abort', stop);
    await stopping;
    if (initIssued) {
      options.onPhase?.('releasing');
      try { await observed('vocoder_release', () => context.releaseVocoder()); }
      catch {
        // Engine still confirms context.release (whose destructor destroys any retained codec).
        // A failed context teardown enters its existing quarantine. Preserve the original cause.
        if (primaryError instanceof TtsError) throw new TtsCleanupError(primaryError);
        throw new TtsError('release_failed');
      }
    }
    if (!primaryError) check();
  }
}
