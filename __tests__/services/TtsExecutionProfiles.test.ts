import { DEFAULT_TTS_PROFILE_ID, TTS_EXECUTION_PROFILES, estimateTtsPeakBytes,
  getTtsExecutionProfile, getTtsInitParameters } from '../../src/services/TtsExecutionProfiles';
import { TTS_LIMITS } from '../../src/types/tts';

const preferred = TTS_EXECUTION_PROFILES.find(profile => profile.id === DEFAULT_TTS_PROFILE_ID)!;

it('keeps the full bounded Oute prompt and generation in an isolated CPU context', () => {
  const params = getTtsInitParameters(preferred, '/managed/voice.gguf');
  expect(params).toMatchObject({ n_ctx: 2816, n_batch: 128, n_ubatch: 128,
    n_gpu_layers: 0, embedding: false, cache_type_k: 'f16', cache_type_v: 'f16',
    ctx_shift: false, n_parallel: 1, state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 });
  expect(preferred.contextTokens).toBeGreaterThanOrEqual(TTS_LIMITS.promptTokens + preferred.generationSteps);
  expect(preferred.generationSteps).toBe(2304);
  expect(preferred.maxFrames).toBe(1200);
  expect(TTS_LIMITS).toMatchObject({ textCharacters: 240, durationSeconds: 16 });
});

it('uses exact Qwen3 KV dimensions and retains codec casts and workspace headroom', () => {
  expect(preferred.kvCache).toEqual({ heads: 8, keyDimension: 128, valueDimension: 128 });
  expect(preferred.graphReserveBytes).toBe(768 * 1024 * 1024);
  expect(estimateTtsPeakBytes(preferred)).toBe(2_677_219_552);
  // Losing the native duplicate-owner guard must restore its stored-weight cost.
  expect(estimateTtsPeakBytes({ ...preferred, codecStoredCopies: 2 }))
    .toBe(estimateTtsPeakBytes(preferred) + preferred.codec.bytes);
});

it('admits the preferred configuration only for its exact backbone and codec hashes', () => {
  expect(getTtsExecutionProfile(preferred.backbone.sha256, preferred.codec.sha256)).toBe(preferred);
  expect(getTtsExecutionProfile(preferred.backbone.sha256, '0'.repeat(64))).toBeNull();
  expect(getTtsExecutionProfile('0'.repeat(64), preferred.codec.sha256)).toBeNull();
});

it('retains existing conservative allocation and hidden-state policies for other families', () => {
  for (const profile of TTS_EXECUTION_PROFILES.filter(value => value.id !== DEFAULT_TTS_PROFILE_ID)) {
    expect(profile.kvCache).toBeUndefined();
    expect(profile.codecStoredCopies).toBeUndefined();
    expect(getTtsInitParameters(profile, '/managed/voice.gguf')).toMatchObject({
      n_ctx: 4096, n_batch: 512, embedding: true });
  }
});
