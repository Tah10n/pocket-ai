import type { ContextParams } from 'llama.rn';
import { AppError } from './AppError';
import type { SystemMemorySnapshot } from './SystemMetricsService';
import { estimateAccurateMemoryFit } from '../memory/estimator';
import { resolveConservativeAvailableMemoryBudget } from '../memory/budget';

export interface ComparisonMemoryProfile {
  policy: 'text-comparison-v1';
  slots: 2;
  perRequestContextTokens: number;
  totalContextTokens: number;
  requiredBytes: number;
  availableBytes: number;
  calibration: 'uncalibrated';
}

/** This transient allocation never reads or writes single-slot calibration/last-good records. */
export function admitComparisonMemory({ params, metadata, modelBytes, loraBytes, snapshot }: {
  params: ContextParams;
  metadata: Record<string, unknown>;
  modelBytes: number;
  loraBytes: number;
  snapshot: SystemMemorySnapshot | null;
}): ComparisonMemoryProfile {
  const totalContextTokens = params.n_ctx ?? 0;
  const perRequestContextTokens = totalContextTokens / 2;
  const batch = params.n_batch ?? 512;
  const microBatch = params.n_ubatch ?? 512;
  const architecture = String(metadata['general.architecture'] ?? '');
  const width = Number(metadata[`${architecture}.embedding_length`]);
  const layers = Number(metadata[`${architecture}.block_count`]);
  if (!Number.isSafeInteger(perRequestContextTokens) || perRequestContextTokens < 256
    || params.n_parallel !== 2 || !Number.isFinite(modelBytes) || modelBytes <= 0
    || !Number.isFinite(loraBytes) || loraBytes < 0 || !snapshot || snapshot.lowMemory
    || !Number.isSafeInteger(batch) || batch < 1 || batch > 512
    || !Number.isSafeInteger(microBatch) || microBatch < 1 || microBatch > 512
    || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(layers) || layers < 1) {
    throw new AppError('model_memory_insufficient', 'Two-answer comparison requires a verified memory budget.');
  }
  const estimate = estimateAccurateMemoryFit({
    input: { modelSizeBytes: modelBytes, verifiedFileSizeBytes: modelBytes, loraSizeBytes: loraBytes,
      metadataTrust: 'verified_local', ggufMetadata: metadata,
      runtimeParams: { ...params }, snapshot },
    totalMemoryBytes: snapshot.totalBytes,
  });
  // Count the complete allocation, even for mmap. Reserve both parser/sampler/result
  // buffers and native/JS bridge copies; a shared weight file does not halve KV costs.
  // The shared estimator has no batch/ubatch graph term. This uncalibrated
  // profile reserves whole-layer activations plus batch staging separately.
  const graphReserveBytes = microBatch * width * layers * 4 + batch * width * 16;
  const requiredBytes = Object.values(estimate.breakdown).reduce((sum, value) => sum + value, 0)
    + graphReserveBytes + 64 * 1024 * 1024 + totalContextTokens * 4096;
  const strictBudget = resolveConservativeAvailableMemoryBudget(snapshot, { strictFreeCap: true });
  const availableBytes = strictBudget === null ? null : Math.min(strictBudget, estimate.effectiveBudgetBytes);
  if (estimate.confidence === 'low' || estimate.breakdown.kvCacheBytes <= 0
    || availableBytes === null || !Number.isFinite(requiredBytes) || requiredBytes > availableBytes) {
    throw new AppError('model_memory_insufficient', 'Two-answer comparison does not fit the verified memory budget.');
  }
  return { policy: 'text-comparison-v1', slots: 2, perRequestContextTokens, totalContextTokens,
    requiredBytes, availableBytes, calibration: 'uncalibrated' };
}

/** n_ctx is a total allocation in this runtime; preserve the displayed per-request budget. */
export function buildComparisonNativeProfile(params: ContextParams, perRequestContextTokens: number): ContextParams {
  if (!Number.isSafeInteger(perRequestContextTokens) || perRequestContextTokens < 256
    || perRequestContextTokens > 32768 || (params.n_parallel ?? 1) !== 1
    || (params.n_gpu_layers ?? 0) !== 0 || params.embedding || params.model_draft || params.speculative) {
    throw new AppError('action_failed', 'Two-answer comparison requires a supported CPU text profile.');
  }
  return { ...params, n_ctx: perRequestContextTokens * 2, n_parallel: 2,
    lora_list: params.lora_list?.map(adapter => ({ ...adapter })), devices: params.devices ? [...params.devices] : undefined,
    ctx_shift: false, state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 };
}
