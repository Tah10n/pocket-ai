import type { CompletionParams, LlamaContext, LlamaSpeaker, SpeakerPayload } from 'llama.rn';
import { TTS_LIMITS, TtsError, TtsCleanupError, type TtsFlow, type TtsObservation, type TtsOperation, type TtsFailureStage, type TtsPhase, type TtsVoiceSelection } from '../types/tts';
import type { TtsExecutionProfile } from './TtsExecutionProfiles';
import { requireLlamaModule } from './llamaRnModule';
import { getCompletionPromptTokenCount } from './LlamaPromptTokenCount';
import { runCompletionOnContext, type LlamaCompletionResult } from './LlamaRuntimeAdapter';
import { phonemizeSpeech } from './TtsPhonemizer';

export interface TtsRuntimeOptions {
  text: string;
  language: string;
  speaker?: string;
  voice?: TtsVoiceSelection;
  referenceAudio?: { samples: number[]; sampleRate: number };
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
  if (flow === 'tokens' || flow === 'talker_embd') {
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
  let failureStage: TtsFailureStage = 'tts_setup';
  let failureObserved = false;
  const observeFailure = (stage: TtsFailureStage) => {
    if (failureObserved) return;
    failureObserved = true;
    observe({ operation: 'first_failure', phase: 'failed', failureStage: stage });
  };
  const observed = async <T>(operation: TtsOperation, call: () => Promise<T>): Promise<T> => {
    failureStage = operation;
    observe({ operation, phase: 'started' });
    try { return await call(); }
    catch (error) { observeFailure(operation); throw error; }
    finally { observe({ operation, phase: 'settled' }); }
  };
  check();
  if (!options.text.trim() || options.text.length > TTS_LIMITS.textCharacters) throw new TtsError('input_too_large');
  if (!profile.languages.includes(options.language)) throw new TtsError('language_unsupported');
  let initIssued = false;
  let primaryError: unknown;
  let stopFailed = false;
  let stopping: Promise<void> | undefined;
  let completionActive = false;
  let ownedSpeaker: LlamaSpeaker | undefined;
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
    failureStage = 'getTTSCapabilities';
    const capabilities = await context.getTTSCapabilities();
    check();
    if (typeof capabilities.requiresPhonemes !== 'boolean') throw new TtsError('codec_incompatible');
    if (capabilities.requiresPhonemes && !profile.phonemizerLanguage) throw new TtsError('prerequisite_missing');
    if (capabilities.family !== profile.family || capabilities.promptKind !== profile.promptKind) throw new TtsError('codec_incompatible');
    if (Boolean(profile.phonemizerLanguage) !== capabilities.requiresPhonemes) throw new TtsError('codec_incompatible');
    const voice = options.voice ?? (options.speaker === undefined ? { kind: 'speakerless' as const }
      : { kind: 'builtin' as const, voice: options.speaker });
    const modes = profile.voiceModes ?? ['speakerless'];
    if (!modes.includes(voice.kind)) throw new TtsError('voice_unavailable');
    const phonemizer = profile.phonemizerLanguage ? async (text: string, language: string) => {
      const started = Date.now();
      observe({ operation: 'phonemizer', phase: 'started' });
      try { return await phonemizeSpeech(text, language, check); }
      catch (error) { observeFailure('phonemizer'); throw error; }
      finally { observe({ operation: 'phonemizer', phase: 'settled', elapsedMs: Math.max(0, Date.now() - started) }); }
    } : undefined;
    let speaker: SpeakerPayload | LlamaSpeaker | undefined;
    if (voice.kind === 'builtin') {
      failureStage = 'builtin_voice_lookup';
      const llama = requireLlamaModule();
      const language = profile.builtinLanguage;
      if (!language || !profile.builtinVoices?.includes(voice.voice)
        || !llama.listTTSLanguages(capabilities.family).includes(language)
        || !llama.listTTSVoices(capabilities.family, language).includes(voice.voice)) {
        throw new TtsError('voice_unavailable');
      }
      const payload = llama.getTTSVoice(capabilities.family, voice.voice, language);
      if (!payload || typeof payload !== 'object') throw new TtsError('voice_unavailable');
      const copied = { ...payload } as Record<string, unknown>;
      if (profile.family === 'neutts') {
        if (!Array.isArray(copied.ref_codes) || !copied.ref_codes.length || copied.ref_codes.length > 800
          || copied.ref_codes.some(value => !Number.isSafeInteger(value) || value < 0 || value >= 65536)) {
          throw new TtsError('voice_unavailable');
        }
        // The handle path skips upstream ref_text phonemization. Payload references are
        // explicitly prepared here, while exact pre-baked IPA is retained unchanged.
        if (!copied.ref_phones && typeof copied.ref_text === 'string' && phonemizer) {
          copied.ref_phones = await phonemizer(copied.ref_text, profile.phonemizerLanguage!);
          check();
        }
        if (typeof copied.ref_phones !== 'string' || !copied.ref_phones.trim() || copied.ref_phones.length > 4096) {
          throw new TtsError('prerequisite_missing');
        }
      }
      speaker = copied as SpeakerPayload;
    } else if (voice.kind === 'reference') {
      const reference = options.referenceAudio;
      const policy = profile.reference;
      if (!policy || !reference || reference.sampleRate !== policy.sampleRate
        || !Array.isArray(reference.samples) || reference.samples.length < policy.sampleRate / 5
        || reference.samples.length > policy.maxSamples
        || reference.samples.some(value => !Number.isFinite(value) || value < -1 || value > 1)) {
        throw new TtsError('reference_invalid');
      }
      if (voice.source.kind === 'temporary' && voice.source.consent !== true) throw new TtsError('consent_required');
      ownedSpeaker = await observed('speaker_create', () => context.createSpeaker({
        refAudio: reference.samples, refAudioSampleRate: reference.sampleRate, bake: false,
      }));
      check();
      if (!Number.isSafeInteger(ownedSpeaker.id) || ownedSpeaker.id < 0 || ownedSpeaker.family !== profile.family) {
        throw new TtsError('reference_invalid');
      }
      if (voice.bake !== 'lazy') {
        await observed('speaker_bake', () => ownedSpeaker!.bake());
        check();
        // rc.3 bake resolves even when native encoding failed; rows/baked are authoritative.
        if (ownedSpeaker.baked !== true || ownedSpeaker.rows !== policy.rows) throw new TtsError('reference_invalid');
      }
      speaker = ownedSpeaker;
    }
    check();
    const format = async () => {
      failureStage = 'formatter';
      observe({ operation: 'formatter', phase: 'started' });
      let response: Awaited<ReturnType<LlamaContext['getFormattedAudioCompletion']>> | undefined;
      try {
        response = await context.getFormattedAudioCompletion({ prompt: options.text,
          language: profile.phonemizerLanguage ?? profile.builtinLanguage ?? options.language,
          ...(speaker === undefined ? {} : { speaker }), ...(phonemizer ? { phonemizer } : {}) });
        return response;
      } catch (error) { observeFailure('formatter'); throw error; }
      finally {
        const receipt = response as { speakerRows?: unknown; speakerBaked?: unknown } | undefined;
        observe({ operation: 'formatter', phase: 'settled',
          ...(typeof receipt?.speakerRows === 'number' && Number.isSafeInteger(receipt.speakerRows)
            && receipt.speakerRows >= 0 && receipt.speakerRows <= 1024 ? { speakerRows: receipt.speakerRows } : {}),
          ...(typeof receipt?.speakerBaked === 'boolean' ? { speakerBaked: receipt.speakerBaked } : {}) });
      }
    };
    const formatted = await format();
    check();
    if (ownedSpeaker) {
      // The guarded bridge copies the native registry receipt after lazy autoBakeSpeaker.
      // JS handle fields do not update when baking happens inside the formatter.
      const receipt = formatted as typeof formatted & { speakerId?: unknown; speakerRows?: unknown; speakerBaked?: unknown };
      if (receipt.speakerId !== ownedSpeaker.id || receipt.speakerBaked !== true
        || receipt.speakerRows !== profile.reference!.rows) throw new TtsError('reference_invalid');
    }
    // A narrow runtime check admits the real Qwen flow omitted from rc.3's TS declaration.
    const flow = String(formatted.flow) as TtsFlow;
    if (!['tokens', 'continuous_embd', 'talker_embd'].includes(flow) || flow !== profile.flow
      || typeof formatted.embedding !== 'boolean' || ((flow === 'continuous_embd' || flow === 'talker_embd') && !formatted.embedding)
      || typeof formatted.prompt !== 'string' || (flow === 'talker_embd' ? formatted.prompt !== '' : !formatted.prompt)
      || formatted.prompt.length > TTS_LIMITS.promptCharacters
      || (formatted.grammar !== undefined && typeof formatted.grammar !== 'string')) throw new TtsError('codec_incompatible');
    // Qwen's prefix is owned by native; tokenizing the empty returned prompt is meaningless.
    // Bound payload text and reserve the fixed role/speaker prefix without manufacturing one.
    failureStage = 'prompt_prepare';
    const tokenized = await context.tokenize(flow === 'talker_embd' ? options.text : formatted.prompt);
    check();
    const promptTokens = getCompletionPromptTokenCount(context, tokenized);
    if (promptTokens > (profile.maxPromptTokens ?? TTS_LIMITS.promptTokens)
      || promptTokens + profile.generationSteps + (flow === 'talker_embd' ? 32 : 0) > profile.contextTokens) throw new TtsError('input_too_large');
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
    failureStage = 'completion';
    let result: LlamaCompletionResult;
    observe({ operation: 'completion', phase: 'started', flow });
    try {
      result = await runCompletionOnContext({ context, params });
      observe({ operation: 'completion', phase: 'settled', flow,
        elementCount: flow === 'continuous_embd' ? result.embeddings?.length : result.audio_tokens?.length,
        tokensPredicted: result.tokens_predicted, tokensEvaluated: result.tokens_evaluated,
        interrupted: result.interrupted, stoppedEos: result.stopped_eos });
    } catch (error) { observeFailure('completion'); observe({ operation: 'completion', phase: 'settled', flow }); throw error; }
    finally { completionActive = false; await stopping; }
    failureStage = 'completion';
    check();
    if (stopFailed) throw new TtsError('native_failed');
    validateTtsCompletion(result);
    const payload = validateTtsAudioPayload(result, flow, profile, sampleRate);
    options.onPhase?.('decoding');
    check();
    failureStage = 'decode';
    observe({ operation: 'decode', phase: 'started', flow, elementCount: payload.elements.length });
    let samples: number[];
    try {
      samples = await (flow === 'continuous_embd' ? context.decodeAudioEmbeddings(payload.elements, payload.dimension!)
        : context.decodeAudioTokens(payload.elements));
    } catch (error) {
      observeFailure('decode');
      observe({ operation: 'decode', phase: 'settled', flow });
      throw error;
    }
    observe({ operation: 'decode', phase: 'settled', flow, elementCount: payload.elements.length,
      sampleRate, sampleCount: Array.isArray(samples) ? samples.length : undefined });
    check();
    if (!Array.isArray(samples) || !samples.length || samples.length > TTS_LIMITS.pcmSamples
      || samples.length / sampleRate > TTS_LIMITS.durationSeconds
      || samples.some(value => !Number.isFinite(value))) throw new TtsError('decode_failed');
    return { samples, sampleRate, flow, audioElements: payload.elements.length, promptTokens };
  } catch (error) {
    observeFailure(failureStage);
    primaryError = error instanceof TtsError ? error : new TtsError('native_failed');
    throw primaryError;
  } finally {
    options.signal?.removeEventListener('abort', stop);
    await stopping;
    let speakerCleanupFailed = false;
    if (ownedSpeaker) {
      // No reusable handle escapes this context epoch; release while the vocoder is live.
      try { await observed('speaker_release', () => ownedSpeaker!.release()); }
      catch { speakerCleanupFailed = true; }
      if (!speakerCleanupFailed) ownedSpeaker = undefined;
    }
    // An uncertain speaker release retains ownership for the engine's confirmed
    // context destruction. The guarded destructor clears its registry before codecs.
    if (initIssued && !speakerCleanupFailed) {
      options.onPhase?.('releasing');
      try { await observed('vocoder_release', () => context.releaseVocoder()); }
      catch {
        // Engine still confirms context.release (whose destructor destroys any retained codec).
        // A failed context teardown enters its existing quarantine. Preserve the original cause.
        if (primaryError instanceof TtsError) throw new TtsCleanupError(primaryError);
        throw new TtsError('release_failed');
      }
    }
    if (speakerCleanupFailed) {
      if (primaryError instanceof TtsError) throw new TtsCleanupError(primaryError);
      throw new TtsError('release_failed');
    }
    if (!primaryError) check();
  }
}
