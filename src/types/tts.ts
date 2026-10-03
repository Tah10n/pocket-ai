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

/** Never exposes native error messages, input, audio payloads or private paths. */
export class TtsError extends Error {
  constructor(readonly code: TtsErrorCode) { super(code); this.name = 'TtsError'; }
}

/** Preserves a sanitized primary failure alongside a distinct codec cleanup failure. */
export class TtsCleanupError extends TtsError {
  readonly cleanupError = new TtsError('release_failed');
  constructor(readonly operationError: TtsError) { super(operationError.code); this.name = 'TtsCleanupError'; }
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

export interface TtsObservation {
  operation: 'vocoder_init' | 'speaker_create' | 'speaker_bake' | 'speaker_release'
    | 'phonemizer' | 'formatter' | 'completion' | 'completion_stop' | 'decode' | 'vocoder_release';
  phase: 'started' | 'settled';
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
