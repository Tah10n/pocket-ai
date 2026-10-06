import { DEFAULT_TTS_PROFILE_ID, TTS_EXECUTION_PROFILES, estimateTtsPeakBytes,
  getTtsExecutionProfile, getTtsInitParameters } from '../../src/services/TtsExecutionProfiles';
import { TTS_LIMITS } from '../../src/types/tts';

const preferred = TTS_EXECUTION_PROFILES.find(profile => profile.id === DEFAULT_TTS_PROFILE_ID)!;

it('keeps the full legacy builtin prompt and generation in an isolated CPU context', () => {
  const params = getTtsInitParameters(preferred, '/managed/voice.gguf');
  expect(params).toMatchObject({ n_ctx: 3840, n_batch: 128, n_ubatch: 128,
    n_gpu_layers: 0, embedding: false, cache_type_k: 'f16', cache_type_v: 'f16',
    ctx_shift: false, n_parallel: 1, state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 });
  expect(preferred.contextTokens).toBe(preferred.maxPromptTokens! + preferred.generationSteps);
  expect(preferred.generationSteps).toBe(2304);
  expect(preferred.maxFrames).toBe(1200);
  expect(TTS_LIMITS).toMatchObject({ textCharacters: 240, durationSeconds: 16 });
});

it('uses exact Qwen2 KV dimensions and retains codec casts, global payload and workspace headroom', () => {
  expect(preferred.kvCache).toEqual({ heads: 2, keyDimension: 64, valueDimension: 64 });
  expect(preferred.graphReserveBytes).toBe(768 * 1024 * 1024);
  expect(estimateTtsPeakBytes(preferred)).toBe(2_378_644_640);
  // Losing the native duplicate-owner guard must restore its stored-weight cost.
  expect(estimateTtsPeakBytes({ ...preferred, codecStoredCopies: 2 }))
    .toBe(estimateTtsPeakBytes(preferred) + preferred.codec.bytes);
});

it('pins the builtin-capable legacy artifacts and upstream sampling policy', () => {
  expect(preferred).toMatchObject({ id: 'outetts-0.3-500m-q4_0-wavtokenizer-large-f16',
    family: 'outetts', promptKind: 'outetts_v0_3', flow: 'tokens', languages: ['en'],
    voiceModes: ['builtin'], builtinLanguage: 'en-us', builtinVoices: ['default'],
    maxPromptTokens: 1536, sampleRate: 24000, samplesPerFrame: 320, codebooks: 1, codebookSize: 4096,
    hiddenDimension: 896, layers: 24, codecStoredCopies: 1,
    sampling: { temperature: 0.7, top_k: 4, top_p: 0.9 },
    backbone: { repository: 'OuteAI/OuteTTS-0.3-500M-GGUF',
      revision: 'ae0577d4386cfb6f442a610a1ec5f2a27d935fc4', filename: 'OuteTTS-0.3-500M-Q4_0.gguf',
      sha256: '086667b32948d618c4ddc3a36d2bdb5f40f7afbb721e51cd32b318680543965f', bytes: 357753600 },
    codec: { repository: 'BricksDisplay/codec.cpp-gguf', revision: '4cd6ecf17367ebc03bba4b2ce8186268a6ce7436',
      filename: 'wavtokenizer-large-speech-75tokens.gguf',
      sha256: '9b08679358a172b1bf1d4f3394c8bad2779a077a9395d7cd0148dff989feb99f', bytes: 169512160 } });
  expect(preferred.sampling.penalty_repeat).toBeUndefined();
});

it('admits the preferred configuration only for its exact backbone and codec hashes', () => {
  expect(getTtsExecutionProfile(preferred.backbone.sha256, preferred.codec.sha256)).toBe(preferred);
  expect(getTtsExecutionProfile(preferred.backbone.sha256, '0'.repeat(64))).toBeNull();
  expect(getTtsExecutionProfile('0'.repeat(64), preferred.codec.sha256)).toBeNull();
});

it('retains the previous Oute 1.0 allocation policy and exact artifact lookup', () => {
  const previous = TTS_EXECUTION_PROFILES.find(profile => profile.id === 'outetts-1.0-0.6b-q4_k_m-dac-speech-f16')!;
  expect(getTtsExecutionProfile(previous.backbone.sha256, previous.codec.sha256)).toBe(previous);
  expect(getTtsInitParameters(previous, '/managed/voice.gguf')).toMatchObject({ n_ctx: 2816,
    n_batch: 128, embedding: false, cache_type_k: 'f16', cache_type_v: 'f16' });
  expect(previous.kvCache).toEqual({ heads: 8, keyDimension: 128, valueDimension: 128 });
  expect(estimateTtsPeakBytes(previous)).toBe(2_677_219_552);
});

it('retains existing conservative allocation and hidden-state policies for other families', () => {
  for (const profile of TTS_EXECUTION_PROFILES.filter(value => value.family !== 'outetts')) {
    expect(profile.kvCache).toBeUndefined();
    expect(profile.codecStoredCopies).toBeUndefined();
    expect(getTtsInitParameters(profile, '/managed/voice.gguf')).toMatchObject({
      n_ctx: 4096, n_batch: 512, embedding: true });
  }
});
