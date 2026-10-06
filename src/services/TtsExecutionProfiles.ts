import type { ContextParams, TTSCapabilities } from 'llama.rn';
import { normalizeSha256Digest } from '../utils/sha256';
import { TTS_LIMITS, type TtsFlow } from '../types/tts';

export interface TtsSourceIdentity {
  readonly repository: string;
  readonly revision: string;
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Exact artifact compatibility and conservative allocation policy; not a speech receipt. */
export interface TtsExecutionProfile {
  readonly id: string;
  readonly backbone: TtsSourceIdentity;
  readonly codec: TtsSourceIdentity;
  readonly family: TTSCapabilities['family'];
  readonly promptKind: TTSCapabilities['promptKind'];
  readonly flow: TtsFlow;
  readonly languages: readonly string[];
  readonly voiceModes?: readonly ('speakerless' | 'builtin' | 'reference')[];
  /** Keys for the JS builtin table and offline phonemizer, separate from speech admission. */
  readonly builtinLanguage?: string;
  readonly phonemizerLanguage?: string;
  readonly builtinVoices?: readonly string[];
  readonly maxPromptTokens?: number;
  readonly reference?: Readonly<{ sampleRate: number; maxSeconds: number; maxSamples: number; rows: number }>;
  readonly sampleRate: number;
  readonly samplesPerFrame: number;
  readonly codebooks?: number;
  readonly codebookSize?: number;
  readonly latentDimension?: number;
  readonly latentFramesPerStep?: number;
  readonly generationSteps: number;
  readonly maxFrames: number;
  readonly contextTokens: number;
  readonly hiddenDimension: number;
  readonly layers: number;
  /** Exact GGUF attention dimensions; the init below pins both caches to F16. */
  readonly kvCache?: Readonly<{ heads: number; keyDimension: number; valueDimension: number }>;
  readonly backboneEmbeddings?: boolean;
  readonly backboneBatchTokens?: number;
  /** Disable native extra buffer types for the validated CPU mmap backbone policy. */
  readonly backboneNoExtraBufferTypes?: boolean;
  /** Stored codec owners in the guarded native build, separate from decode casts. */
  readonly codecStoredCopies?: 1 | 2;
  readonly graphReserveBytes: number;
  readonly sampling: Readonly<{ temperature: number; top_k: number; top_p: number; penalty_repeat?: number }>;
}

const MiB = 1024 * 1024;
export const DEFAULT_TTS_PROFILE_ID = 'outetts-0.3-500m-q4_0-wavtokenizer-large-f16';
export const TTS_EXECUTION_PROFILES: readonly TtsExecutionProfile[] = Object.freeze([
  Object.freeze({
    id: 'outetts-1.0-0.6b-q4_k_m-dac-speech-f16',
    backbone: Object.freeze({ repository: 'OuteAI/OuteTTS-1.0-0.6B-GGUF',
      revision: '7e8de3b4d95e100812fd7e6f4372510d0830a798', filename: 'OuteTTS-1.0-0.6B-Q4_K_M.gguf',
      sha256: 'a0e2afa131b8a5029de0c653d55b71aab99744226234fcf1d80c55dade21020b', bytes: 401741952 }),
    codec: Object.freeze({ repository: 'BricksDisplay/codec.cpp-gguf',
      revision: '4cd6ecf17367ebc03bba4b2ce8186268a6ce7436', filename: 'ibm-research--DAC.speech.gguf',
      sha256: 'f58e57eabef8d574f4d08828f0116d93341bd91a26413390b780c6f1e8491337', bytes: 147786400 }),
    family: 'outetts' as const, promptKind: 'outetts_v1_0' as const, flow: 'tokens' as const,
    languages: Object.freeze(['en']), sampleRate: 24000, samplesPerFrame: 320,
    codebooks: 2, codebookSize: 1024, generationSteps: 2304, maxFrames: 1200,
    // Complete prompt (512) + generation (2304), with no context shifting.
    contextTokens: 2816, hiddenDimension: 1024, layers: 28,
    kvCache: Object.freeze({ heads: 8, keyDimension: 128, valueDimension: 128 }),
    // CODEC_CODES uses sampled codes, not retained backbone hidden states.
    backboneEmbeddings: false, backboneBatchTokens: 128,
    // Guarded rc.3 patch skips the unused audio_lm owner for plain DAC metadata.
    codecStoredCopies: 1,
    graphReserveBytes: 768 * MiB,
    sampling: Object.freeze({ temperature: 0.4, top_k: 40, top_p: 0.9, penalty_repeat: 1.1 }),
  }),
  Object.freeze({
    id: 'outetts-0.3-500m-q4_0-wavtokenizer-large-f16',
    backbone: Object.freeze({ repository: 'OuteAI/OuteTTS-0.3-500M-GGUF',
      revision: 'ae0577d4386cfb6f442a610a1ec5f2a27d935fc4', filename: 'OuteTTS-0.3-500M-Q4_0.gguf',
      sha256: '086667b32948d618c4ddc3a36d2bdb5f40f7afbb721e51cd32b318680543965f', bytes: 357753600 }),
    codec: Object.freeze({ repository: 'BricksDisplay/codec.cpp-gguf',
      revision: '4cd6ecf17367ebc03bba4b2ce8186268a6ce7436', filename: 'wavtokenizer-large-speech-75tokens.gguf',
      sha256: '9b08679358a172b1bf1d4f3394c8bad2779a077a9395d7cd0148dff989feb99f', bytes: 169512160 }),
    family: 'outetts' as const, promptKind: 'outetts_v0_3' as const, flow: 'tokens' as const,
    languages: Object.freeze(['en']), voiceModes: Object.freeze(['builtin'] as const),
    builtinLanguage: 'en-us', builtinVoices: Object.freeze(['default']),
    maxPromptTokens: 1536, sampleRate: 24000, samplesPerFrame: 320,
    codebooks: 1, codebookSize: 4096, generationSteps: 2304, maxFrames: 1200,
    // Pinned Qwen2 metadata: 896 hidden dimensions, 24 layers, 14 heads and 2 KV heads.
    // The complete legacy builtin prompt allowance (1536) plus generation (2304) fits exactly.
    contextTokens: 3840, hiddenDimension: 896, layers: 24,
    kvCache: Object.freeze({ heads: 2, keyDimension: 64, valueDimension: 64 }),
    backboneEmbeddings: false, backboneBatchTokens: 128,
    // rc.3 CPU mmap wraps the existing mapping; no_extra_bufts prevents CPU_REPACK copies.
    backboneNoExtraBufferTypes: true,
    // Guarded rc.3 skips the unused audio_lm owner for plain WavTokenizer metadata.
    codecStoredCopies: 1, graphReserveBytes: 768 * MiB,
    // Pinned rc.3 TTS example uses top_k=4 and leaves repetition at its native default.
    sampling: Object.freeze({ temperature: 0.7, top_k: 4, top_p: 0.9 }),
  }),
  Object.freeze({
    id: 'bluemagpie-barbet-1b-q4_k_m-audiovae-q8_0',
    backbone: Object.freeze({ repository: 'BricksDisplay/BlueMagpie-TTS-GGUF',
      revision: '1f195f06506314c1de4a4d35cad2e77b28cfe7db', filename: 'BlueMagpie-Barbet-1B-q4_k_m.gguf',
      sha256: '5bfa46f44936cad36eaf670da4b7a162c5d5ab44cf75827d1c09e78a03d82bde', bytes: 693008608 }),
    codec: Object.freeze({ repository: 'BricksDisplay/BlueMagpie-TTS-GGUF',
      revision: '1f195f06506314c1de4a4d35cad2e77b28cfe7db', filename: 'BlueMagpie-AudioVAE-q8_0.gguf',
      sha256: '7b4c9ac08723984616e5d132ebcf99f57fec2d8aff181c24bb351a72943930f1', bytes: 1089523904 }),
    family: 'bluemagpie' as const, promptKind: 'bluemagpie' as const, flow: 'continuous_embd' as const,
    languages: Object.freeze(['zh-tw']), sampleRate: 48000, samplesPerFrame: 1920,
    latentDimension: 64, latentFramesPerStep: 4, generationSteps: 100, maxFrames: 400,
    contextTokens: 4096, hiddenDimension: 1536, layers: 28,
    graphReserveBytes: 1536 * MiB,
    sampling: Object.freeze({ temperature: 1, top_k: 40, top_p: 0.9, penalty_repeat: 1 }),
  }),
  Object.freeze({
    id: 'neutts-nano-q4_k_m-neucodec-q8_0',
    backbone: Object.freeze({ repository: 'BricksDisplay/NeuTTS-Nano-GGUF',
      revision: '857e272b903daf826606567c9ceaef574bfa793b', filename: 'neutts-nano-q4_k_m.gguf',
      sha256: '14049f27cd9fac6bc703d06bbfd2580ec6fdc2b23780533bb416ddaf236d993f', bytes: 209571776 }),
    codec: Object.freeze({ repository: 'BricksDisplay/NeuTTS-Nano-GGUF',
      revision: '857e272b903daf826606567c9ceaef574bfa793b', filename: 'codec-q8_0.gguf',
      sha256: '9972d7cabd38582f0425ba898abffc6f92166154ce046a4f392654dbdad5fafa', bytes: 341719168 }),
    family: 'neutts' as const, promptKind: 'neutts' as const, flow: 'tokens' as const,
    languages: Object.freeze(['en']), voiceModes: Object.freeze(['builtin'] as const),
    builtinLanguage: 'en-us', phonemizerLanguage: 'en-us', builtinVoices: Object.freeze(['default', 'dave', 'jo']),
    // Jo has 653 immutable reference codes. This new profile's allowance includes builtin
    // reference overhead; existing profiles retain the 512-token admission unchanged.
    maxPromptTokens: 1536, sampleRate: 24000, samplesPerFrame: 480,
    codebooks: 1, codebookSize: 65536, generationSteps: 801, maxFrames: 800,
    // Pinned GGUF metadata: llama.embedding_length=576 and llama.block_count=24.
    contextTokens: 4096, hiddenDimension: 576, layers: 24, graphReserveBytes: 768 * MiB,
    sampling: Object.freeze({ temperature: 1, top_k: 50, top_p: 1, penalty_repeat: 1 }),
  }),
  Object.freeze({
    id: 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0',
    backbone: Object.freeze({ repository: 'BricksDisplay/Qwen3-TTS-12Hz-0.6B-GGUF',
      revision: 'f585ae3ca470e59ef9405d6317a6f11bc6c7ca1f', filename: 'qwen3-tts-0.6b-q4_k_m.gguf',
      sha256: 'e3ba7aed5d7147dea8745da98218f2a57d5ca5b4ee408ac2146bead0b4c62f30', bytes: 396700064 }),
    codec: Object.freeze({ repository: 'BricksDisplay/Qwen3-TTS-12Hz-0.6B-GGUF',
      revision: 'f585ae3ca470e59ef9405d6317a6f11bc6c7ca1f', filename: 'codec-q8_0.gguf',
      sha256: 'c10e65ef981e8452c841b008892f35e1dca9cf18abd47843acad4316d5bb9b8c', bytes: 1278191520 }),
    family: 'qwen3_tts' as const, promptKind: 'qwen3_tts' as const, flow: 'talker_embd' as const,
    languages: Object.freeze(['en']), voiceModes: Object.freeze(['speakerless', 'reference'] as const),
    reference: Object.freeze({ sampleRate: 24000, maxSeconds: 8, maxSamples: 192000, rows: 1 }),
    sampleRate: 24000, samplesPerFrame: 1920, codebooks: 16, codebookSize: 2048,
    generationSteps: 201, maxFrames: 200, contextTokens: 4096, hiddenDimension: 1024,
    layers: 28, graphReserveBytes: 1536 * MiB,
    sampling: Object.freeze({ temperature: 0.9, top_k: 50, top_p: 1, penalty_repeat: 1.05 }),
  }),
]);

export function getTtsExecutionProfile(backboneSha: unknown, codecSha: unknown): TtsExecutionProfile | null {
  const backbone = typeof backboneSha === 'string' ? normalizeSha256Digest(backboneSha) : null;
  const codec = typeof codecSha === 'string' ? normalizeSha256Digest(codecSha) : null;
  return TTS_EXECUTION_PROFILES.find(profile => profile.backbone.sha256 === backbone && profile.codec.sha256 === codec) ?? null;
}

export function getTtsInitParameters(profile: TtsExecutionProfile, path: string): ContextParams {
  // Codec-LM and continuous backbones need hidden states. Plain Oute DAC uses codes.
  return { model: path, n_ctx: profile.contextTokens, n_batch: profile.backboneBatchTokens ?? 512, n_ubatch: 128, n_threads: 4,
    n_gpu_layers: 0, embedding: profile.backboneEmbeddings ?? true, embd_normalize: -1, pooling_type: 'none', ctx_shift: false,
    ...(profile.kvCache ? { cache_type_k: 'f16' as const, cache_type_v: 'f16' as const } : {}),
    ...(profile.backboneNoExtraBufferTypes === true ? { no_extra_bufts: true } : {}),
    use_mmap: true, use_mlock: false, n_parallel: 1,
    state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 };
}

export function estimateTtsPeakBytes(profile: TtsExecutionProfile): number {
  // Guarded plain DAC/WavTokenizer decoders retain one codec; other rc.3 paths retain two.
  // Reserve full-file F32 casts in addition to stored F16 weights for DAC decode,
  // working graphs, KV/hidden states, native output + JS number[] + encoded WAV + player buffers.
  // This is deliberately low-confidence; unknown artifact pairs receive no estimate/admission.
  const initParams = getTtsInitParameters(profile, '<managed-backbone>');
  const backboneCopies = profile.backboneNoExtraBufferTypes === true
    && initParams.no_extra_bufts === true && initParams.n_gpu_layers === 0
    && initParams.use_mmap === true && initParams.use_mlock === false ? 1 : 2;
  const kvAndHiddens = profile.kvCache
    ? profile.contextTokens * profile.layers * profile.kvCache.heads
      * (profile.kvCache.keyDimension + profile.kvCache.valueDimension) * 2
      + (profile.backboneEmbeddings === false ? 0
        : (profile.contextTokens + profile.generationSteps) * profile.hiddenDimension * 16)
    : profile.contextTokens * profile.hiddenDimension * profile.layers * 8;
  const payload = TTS_LIMITS.pcmSamples * (4 + 8 + 2 + 8) + 16 * MiB;
  // Saved materialization/preparation can overlap A and is admitted separately. During
  // TTS, account for retained PCM + JSON/F32 bridge copies and ECAPA/bake workspace too.
  // The profile graph reserve still covers full codec/LM working graphs and possible F32 weights.
  const reference = profile.reference ? profile.reference.maxSamples * 64 + 64 * MiB : 0;
  return Math.ceil(profile.backbone.bytes * backboneCopies + profile.codec.bytes * ((profile.codecStoredCopies ?? 2) + 2)
    + profile.graphReserveBytes + kvAndHiddens + payload + reference + 256 * MiB);
}

export function getTtsProfileIdentity(profile: TtsExecutionProfile, runtimeIdentity: unknown): string {
  return JSON.stringify([profile, getTtsInitParameters(profile, '<managed-backbone>'),
    { use_gpu: false, n_batch: 512 }, TTS_LIMITS, runtimeIdentity]);
}
