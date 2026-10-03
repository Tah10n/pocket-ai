export type TtsFlow = 'tokens' | 'continuous_embd';
export type TtsPhase = 'checking' | 'loading' | 'synthesizing' | 'decoding' | 'releasing' | 'restoring'
  | 'ready' | 'starting' | 'playing' | 'paused' | 'stopping' | 'stopped' | 'error';
export type TtsErrorCode = 'selection_missing' | 'selection_changed' | 'files_missing' | 'integrity_failed'
  | 'profile_unverified' | 'codec_incompatible' | 'prerequisite_missing' | 'voice_unavailable'
  | 'language_unsupported' | 'memory_unknown' | 'memory_insufficient' | 'busy' | 'cancelled'
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
  operation: 'vocoder_init' | 'completion' | 'completion_stop' | 'decode' | 'vocoder_release';
  phase: 'started' | 'settled';
  flow?: TtsFlow;
  elementCount?: number;
  sampleRate?: number;
  sampleCount?: number;
  tokensPredicted?: number;
  tokensEvaluated?: number;
  interrupted?: boolean;
  stoppedEos?: boolean;
}
