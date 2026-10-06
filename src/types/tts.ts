// rc.3 returns talker_embd for Qwen3 even though its public formatter type omits it.
export type TtsFlow = 'tokens' | 'continuous_embd' | 'talker_embd';
export type TtsReferenceSource =
  | { readonly kind: 'temporary'; readonly sourceUri: string; readonly sourceSha256: string;
      readonly durationMs: number; readonly consent: true }
  | { readonly kind: 'saved'; readonly voiceId: string; readonly sourceSha256: string };
export type TtsVoiceSelection = { readonly kind: 'speakerless' }
  | { readonly kind: 'builtin'; readonly voice: string }
  | { readonly kind: 'reference'; readonly source: TtsReferenceSource; readonly bake?: 'lazy' | 'eager' };
export type TtsPhase = 'checking' | 'loading' | 'synthesizing' | 'decoding' | 'releasing' | 'restoring'
  | 'ready' | 'starting' | 'playing' | 'paused' | 'stopping' | 'stopped' | 'error';
export type TtsErrorCode = 'selection_missing' | 'selection_changed' | 'files_missing' | 'integrity_failed'
  | 'profile_unverified' | 'codec_incompatible' | 'prerequisite_missing' | 'voice_unavailable'
  | 'language_unsupported' | 'phonemizer_failed' | 'reference_invalid' | 'consent_required'
  | 'memory_unknown' | 'memory_insufficient' | 'busy' | 'cancelled'
  | 'input_too_large' | 'generation_incomplete' | 'payload_invalid' | 'decode_failed'
  | 'audio_focus_failed' | 'audio_focus_delayed' | 'playback_start_timeout'
  | 'native_failed' | 'release_failed' | 'restore_failed' | 'storage_failed' | 'playback_failed';

export type PhonemizerFailureReason = 'module_init' | 'conversion' | 'deadline' | 'invalid_output';
export interface PhonemizerFailure {
  readonly reason: PhonemizerFailureReason;
  readonly elapsedMs?: number;
  readonly moduleInitMs?: number;
}
/** Diagnostic bound only; this never changes the phonemizer's execution deadline. */
export const PHONEMIZER_DIAGNOSTIC_MAX_MS = 300_000;
export function sanitizePhonemizerFailure(value: unknown): PhonemizerFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  if (!['module_init', 'conversion', 'deadline', 'invalid_output'].includes(source.reason as string)) return undefined;
  for (const key of ['elapsedMs', 'moduleInitMs']) {
    if (source[key] !== undefined && (!Number.isSafeInteger(source[key])
      || (source[key] as number) < 0 || (source[key] as number) > PHONEMIZER_DIAGNOSTIC_MAX_MS)) return undefined;
  }
  if (typeof source.elapsedMs === 'number' && typeof source.moduleInitMs === 'number'
    && source.moduleInitMs > source.elapsedMs) return undefined;
  return Object.freeze({ reason: source.reason as PhonemizerFailureReason,
    ...(source.elapsedMs === undefined ? {} : { elapsedMs: source.elapsedMs as number }),
    ...(source.moduleInitMs === undefined ? {} : { moduleInitMs: source.moduleInitMs as number }) });
}

export interface TtsNativeCompletion {
  readonly tokensPredicted?: number;
  readonly tokensEvaluated?: number;
  readonly elapsedMs?: number;
}
/** Closed numeric diagnostics only; these bounds do not change native admission. */
export function sanitizeTtsNativeCompletion(value: unknown): TtsNativeCompletion | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const bounded = (field: unknown, maximum: number): number | undefined => typeof field === 'number'
    && Number.isSafeInteger(field) && field >= 0 && field <= maximum ? field : undefined;
  const result = { tokensPredicted: bounded(source.tokensPredicted, 1_000_000),
    tokensEvaluated: bounded(source.tokensEvaluated, 1_000_000), elapsedMs: bounded(source.elapsedMs, 300_000) };
  if (Object.values(result).every(field => field === undefined)) return undefined;
  return Object.freeze(result);
}

/** Never exposes native error messages, input, audio payloads or private paths. */
export class TtsError extends Error {
  readonly phonemizerFailure?: PhonemizerFailure;
  constructor(readonly code: TtsErrorCode, phonemizerFailure?: PhonemizerFailure) {
    super(code); this.name = 'TtsError';
    if (code === 'phonemizer_failed') this.phonemizerFailure = sanitizePhonemizerFailure(phonemizerFailure);
  }
}

/** Preserves a sanitized primary failure alongside a distinct codec cleanup failure. */
export class TtsCleanupError extends TtsError {
  readonly cleanupError = new TtsError('release_failed');
  constructor(readonly operationError: TtsError) {
    super(operationError.code, operationError.phonemizerFailure); this.name = 'TtsCleanupError';
  }
}

export const TTS_LIMITS = Object.freeze({
  textCharacters: 240,
  promptTokens: 512,
  promptCharacters: 32_768,
  durationSeconds: 16,
  pcmSamples: 768_000,
  wavBytes: 1_536_044,
  queuedJobs: 0,
  temporaryClips: 1,
});

/** One closed diagnostic stage; never carries an exception or speech data. */
export const TTS_FAILURE_STAGES = [
  'adapter_prepare', 'base_lora_load', 'tts_fixture_prepare', 'tts_admission', 'tts_setup', 'tts_detach',
  'tts_backbone_init', 'vocoder_init', 'getTTSCapabilities', 'builtin_voice_lookup', 'phonemizer',
  'speaker_create', 'speaker_bake', 'formatter', 'prompt_prepare', 'completion', 'completion_stop',
  'decode', 'wav_encode', 'speaker_release', 'vocoder_release', 'context_release', 'restore', 'qa_voice_sequence',
] as const;
export type TtsFailureStage = typeof TTS_FAILURE_STAGES[number];
export function isTtsFailureStage(value: unknown): value is TtsFailureStage {
  return typeof value === 'string' && TTS_FAILURE_STAGES.includes(value as TtsFailureStage);
}
export type TtsOperation = 'vocoder_init' | 'speaker_create' | 'speaker_bake' | 'speaker_release'
  | 'phonemizer' | 'formatter' | 'completion' | 'completion_stop' | 'decode' | 'vocoder_release';
export interface TtsObservation {
  operation: TtsOperation | 'first_failure';
  phase: 'started' | 'settled' | 'failed';
  failureStage?: TtsFailureStage;
  flow?: TtsFlow;
  elementCount?: number;
  sampleRate?: number;
  sampleCount?: number;
  tokensPredicted?: number;
  tokensEvaluated?: number;
  interrupted?: boolean;
  stoppedEos?: boolean;
  speakerRows?: number;
  speakerBaked?: boolean;
  elapsedMs?: number;
}
