import { DEFAULT_TTS_PROFILE_ID, TTS_EXECUTION_PROFILES, estimateTtsPeakBytes,
  getTtsExecutionProfile, getTtsInitParameters } from '../../src/services/TtsExecutionProfiles';
import { TTS_LIMITS } from '../../src/types/tts';

const preferred = TTS_EXECUTION_PROFILES.find(profile => profile.id === DEFAULT_TTS_PROFILE_ID)!;
const legacy = TTS_EXECUTION_PROFILES.find(profile => profile.promptKind === 'outetts_v0_3')!;

it.each([preferred, legacy])('keeps the complete $promptKind prompt and generation in one CPU context', profile => {
  expect(getTtsInitParameters(profile, '/managed/voice.gguf')).toMatchObject({ n_ctx: profile.contextTokens,
    n_batch: 128, n_ubatch: 128, n_gpu_layers: 0, embedding: false,
    cache_type_k: 'f16', cache_type_v: 'f16', no_extra_bufts: true,
    use_mmap: true, use_mlock: false, ctx_shift: false, n_parallel: 1,
    state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 });
  expect(profile.contextTokens).toBe((profile.maxPromptTokens ?? 512) + profile.generationSteps);
  expect(profile.generationSteps).toBe(2304);
  expect(profile.maxFrames).toBe(1200);
  expect(TTS_LIMITS).toMatchObject({ textCharacters: 240, durationSeconds: 16 });
});

it('selects the previously content-verified speakerless Oute1.0 pair with its accepted sampler', () => {
  expect(preferred).toMatchObject({ id: 'outetts-1.0-0.6b-q4_k_m-dac-speech-f16',
    family: 'outetts', promptKind: 'outetts_v1_0', flow: 'tokens', languages: ['en'],
    sampleRate: 24000, samplesPerFrame: 320, codebooks: 2, codebookSize: 1024,
    contextTokens: 2816, hiddenDimension: 1024, layers: 28, codecStoredCopies: 1,
    sampling: { temperature: 0.4, top_k: 40, top_p: 0.9, penalty_repeat: 1.1 },
    backbone: { repository: 'OuteAI/OuteTTS-1.0-0.6B-GGUF',
      revision: '7e8de3b4d95e100812fd7e6f4372510d0830a798', filename: 'OuteTTS-1.0-0.6B-Q4_K_M.gguf',
      sha256: 'a0e2afa131b8a5029de0c653d55b71aab99744226234fcf1d80c55dade21020b', bytes: 401741952 },
    codec: { repository: 'BricksDisplay/codec.cpp-gguf', revision: '4cd6ecf17367ebc03bba4b2ce8186268a6ce7436',
      filename: 'ibm-research--DAC.speech.gguf',
      sha256: 'f58e57eabef8d574f4d08828f0116d93341bd91a26413390b780c6f1e8491337', bytes: 147786400 } });
  expect(preferred.voiceModes).toBeUndefined();
  expect(preferred.builtinLanguage).toBeUndefined();
  expect(preferred.kvCache).toEqual({ heads: 8, keyDimension: 128, valueDimension: 128 });
  expect(preferred.graphReserveBytes).toBe(768 * 1024 * 1024);
  expect(estimateTtsPeakBytes(preferred)).toBe(2_275_477_600);
  expect(estimateTtsPeakBytes({ ...preferred, codecStoredCopies: 2 }))
    .toBe(estimateTtsPeakBytes(preferred) + preferred.codec.bytes);
});

it.each([undefined, false])('restores both full-file backbone allowances without the native opt-in: %s', flag => {
  for (const profile of [preferred, legacy]) {
    const fallback = { ...profile, backboneNoExtraBufferTypes: flag };
    expect(getTtsInitParameters(fallback, '/managed/voice.gguf')).not.toHaveProperty('no_extra_bufts');
    expect(estimateTtsPeakBytes(fallback) - estimateTtsPeakBytes(profile)).toBe(profile.backbone.bytes);
  }
  expect(estimateTtsPeakBytes({ ...preferred, backboneNoExtraBufferTypes: flag })).toBe(2_677_219_552);
  expect(estimateTtsPeakBytes({ ...legacy, backboneNoExtraBufferTypes: flag })).toBe(2_378_644_640);
});

it('limits CPU mapping opt-in to the two exact plain-code Oute artifact profiles', () => {
  for (const profile of TTS_EXECUTION_PROFILES.filter(value => value !== preferred && value !== legacy)) {
    expect(profile.backboneNoExtraBufferTypes).toBeUndefined();
    expect(getTtsInitParameters(profile, '/managed/voice.gguf')).not.toHaveProperty('no_extra_bufts');
  }
});

it('retains the legacy builtin artifacts and exact Qwen2 geometry separately from the default', () => {
  expect(legacy).toMatchObject({ voiceModes: ['builtin'], builtinLanguage: 'en-us', builtinVoices: ['default'],
    maxPromptTokens: 1536, contextTokens: 3840, codebooks: 1, codebookSize: 4096,
    hiddenDimension: 896, layers: 24, codecStoredCopies: 1, backboneNoExtraBufferTypes: true,
    sampling: { temperature: 0.1, top_k: 4, top_p: 0.9, penalty_repeat: 1.1 } });
  expect(legacy.kvCache).toEqual({ heads: 2, keyDimension: 64, valueDimension: 64 });
  expect(estimateTtsPeakBytes(legacy)).toBe(2_020_891_040);
});

it.each([preferred, legacy])('admits $promptKind only for its exact backbone and codec hashes', profile => {
  expect(getTtsExecutionProfile(profile.backbone.sha256, profile.codec.sha256)).toBe(profile);
  expect(getTtsExecutionProfile(profile.backbone.sha256, '0'.repeat(64))).toBeNull();
  expect(getTtsExecutionProfile('0'.repeat(64), profile.codec.sha256)).toBeNull();
});

it('retains existing conservative allocation and hidden-state policies for other families', () => {
  for (const profile of TTS_EXECUTION_PROFILES.filter(value => value.family !== 'outetts')) {
    expect(profile.kvCache).toBeUndefined();
    expect(profile.codecStoredCopies).toBeUndefined();
    expect(getTtsInitParameters(profile, '/managed/voice.gguf')).toMatchObject({
      n_ctx: 4096, n_batch: 512, embedding: true });
  }
});
