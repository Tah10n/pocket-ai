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
  readonly graphReserveBytes: number;
  readonly sampling: Readonly<{ temperature: number; top_k: number; top_p: number; penalty_repeat: number }>;
}

const MiB = 1024 * 1024;
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
    contextTokens: 4096, hiddenDimension: 1024, layers: 28,
    graphReserveBytes: 768 * MiB,
    sampling: Object.freeze({ temperature: 0.4, top_k: 40, top_p: 0.9, penalty_repeat: 1.1 }),
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
]);

export function getTtsExecutionProfile(backboneSha: unknown, codecSha: unknown): TtsExecutionProfile | null {
  const backbone = typeof backboneSha === 'string' ? normalizeSha256Digest(backboneSha) : null;
  const codec = typeof codecSha === 'string' ? normalizeSha256Digest(codecSha) : null;
  return TTS_EXECUTION_PROFILES.find(profile => profile.backbone.sha256 === backbone && profile.codec.sha256 === codec) ?? null;
}

export function getTtsInitParameters(profile: TtsExecutionProfile, path: string): ContextParams {
  // Codec-LM and continuous backbones need hidden states; this is not retrieval embedding().
  return { model: path, n_ctx: profile.contextTokens, n_batch: 512, n_ubatch: 128, n_threads: 4,
    n_gpu_layers: 0, embedding: true, embd_normalize: -1, pooling_type: 'none', ctx_shift: false,
    use_mmap: true, use_mlock: false, n_parallel: 1,
    state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 };
}

export function estimateTtsPeakBytes(profile: TtsExecutionProfile): number {
  // rc.3 loads codec weights twice through codec + audio_lm. Reserve additional dequantization,
  // working graphs, KV/hidden states, native output + JS number[] + encoded WAV + player buffers.
  // This is deliberately low-confidence; unknown artifact pairs receive no estimate/admission.
  const kvAndHiddens = profile.contextTokens * profile.hiddenDimension * profile.layers * 8;
  const payload = TTS_LIMITS.pcmSamples * (4 + 8 + 2 + 8) + 16 * MiB;
  return Math.ceil(profile.backbone.bytes * 2 + profile.codec.bytes * 4
    + profile.graphReserveBytes + kvAndHiddens + payload + 256 * MiB);
}

export function getTtsProfileIdentity(profile: TtsExecutionProfile, runtimeIdentity: unknown): string {
  return JSON.stringify([profile, getTtsInitParameters(profile, '<managed-backbone>'),
    { use_gpu: false, n_batch: 512 }, TTS_LIMITS, runtimeIdentity]);
}
