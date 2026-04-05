import type {
  EstimatorInput,
  MemoryFitConfidence,
  MemoryFitDecision,
  MemoryFitResult,
  MemoryBreakdown,
  MemoryMetadataTrust,
} from './types';
import { createMemoryBudget, FITS_IN_RAM_HEADROOM_RATIO, type MemoryBudgetSnapshot } from './budget';
import { normalizeCalibrationRecordFactors } from './calibration';

export const ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR = 0.2;
const DEFAULT_KV_CACHE_BYTES_PER_ELEMENT = 2; // f16
const DEFAULT_SAFETY_MARGIN_BYTES = 256 * 1024 * 1024;
const MAX_SAFETY_MARGIN_BYTES = 1024 * 1024 * 1024;
const FAST_ESTIMATE_DEFAULT_CONTEXT_TOKENS = 4096;
const FAST_ESTIMATE_MIN_APP_BASELINE_BYTES = 256 * 1024 * 1024;
const FAST_ESTIMATE_DEFAULT_THRESHOLD_BYTES = 432 * 1024 * 1024;
const UNKNOWN_BREAKDOWN: MemoryBreakdown = {
  weightsBytes: 0,
  kvCacheBytes: 0,
  computeBytes: 0,
  multimodalBytes: 0,
  overheadBytes: 0,
  safetyMarginBytes: 0,
};

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toFinitePositiveNumber(value: unknown): number | null {
  return isFinitePositiveNumber(value) ? value : null;
}

function readNumericMetadata(metadata: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!metadata) {
    return null;
  }

  for (const key of keys) {
    const value = toFinitePositiveNumber(metadata[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function readStringRuntimeParam(runtimeParams: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = runtimeParams[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
}

function readNumericRuntimeParam(runtimeParams: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFinitePositiveNumber(runtimeParams[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function sumBreakdown(breakdown: MemoryBreakdown): number {
  return (
    breakdown.weightsBytes
    + breakdown.kvCacheBytes
    + breakdown.computeBytes
    + breakdown.multimodalBytes
    + breakdown.overheadBytes
    + breakdown.safetyMarginBytes
  );
}

function createBaseBreakdownForModelSize(modelSizeBytes: number): MemoryBreakdown {
  const weightsBytes = modelSizeBytes;
  const overheadBytes = modelSizeBytes * ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR;
  return {
    weightsBytes,
    kvCacheBytes: 0,
    computeBytes: 0,
    multimodalBytes: 0,
    overheadBytes,
    safetyMarginBytes: 0,
  };
}

function bytesPerKvElement(cacheType: string | null): number {
  if (!cacheType) {
    return DEFAULT_KV_CACHE_BYTES_PER_ELEMENT;
  }

  const normalized = cacheType.trim().toLowerCase();
  if (normalized.includes('f32') || normalized.includes('fp32')) {
    return 4;
  }

  if (normalized.includes('bf16')) {
    return 2;
  }

  if (normalized.includes('f16') || normalized.includes('fp16')) {
    return 2;
  }

  if (normalized.startsWith('q8')) {
    return 1;
  }

  if (normalized.startsWith('q6')) {
    return 0.75;
  }

  if (normalized.startsWith('q5')) {
    return 0.625;
  }

  if (normalized.startsWith('q4')) {
    return 0.5;
  }

  if (normalized.startsWith('q3')) {
    return 0.375;
  }

  if (normalized.startsWith('q2')) {
    return 0.25;
  }

  return DEFAULT_KV_CACHE_BYTES_PER_ELEMENT;
}

function resolveKvCacheTokens({
  requestedContextTokens,
  slidingWindowTokens,
}: {
  requestedContextTokens: number | null;
  slidingWindowTokens: number | null;
}): number | null {
  if (!requestedContextTokens || requestedContextTokens <= 0) {
    return null;
  }

  if (slidingWindowTokens && slidingWindowTokens > 0) {
    return Math.max(0, Math.min(requestedContextTokens, slidingWindowTokens));
  }

  return requestedContextTokens;
}

function estimateKvCacheBytes({
  ggufMetadata,
  runtimeParams,
}: {
  ggufMetadata: Record<string, unknown> | undefined;
  runtimeParams: Record<string, unknown>;
}): { kvCacheBytes: number; hasKvMetadata: boolean } {
  const requestedContextTokens = readNumericRuntimeParam(runtimeParams, ['contextTokens', 'contextSize', 'n_ctx', 'nCtx']);
  const slidingWindowTokens = readNumericMetadata(ggufMetadata, ['slidingWindowTokens', 'sliding_window', 'slidingWindow']);
  const kvCacheTokens = resolveKvCacheTokens({ requestedContextTokens, slidingWindowTokens });

  const nLayers = readNumericMetadata(ggufMetadata, ['nLayers', 'n_layers', 'n_layer']);
  const nHeadKv = readNumericMetadata(ggufMetadata, ['nHeadKv', 'n_head_kv']);
  const nEmbdHeadK = readNumericMetadata(ggufMetadata, ['nEmbdHeadK', 'n_embd_head_k']);
  const nEmbdHeadV = readNumericMetadata(ggufMetadata, ['nEmbdHeadV', 'n_embd_head_v']) ?? nEmbdHeadK;

  if (
    kvCacheTokens === null
    || nLayers === null
    || nHeadKv === null
    || nEmbdHeadK === null
    || nEmbdHeadV === null
    || kvCacheTokens <= 0
    || nLayers <= 0
    || nHeadKv <= 0
    || nEmbdHeadK <= 0
    || nEmbdHeadV <= 0
  ) {
    return { kvCacheBytes: 0, hasKvMetadata: false };
  }

  const cacheTypeK = readStringRuntimeParam(runtimeParams, ['cacheTypeK', 'cache_type_k']);
  const cacheTypeV = readStringRuntimeParam(runtimeParams, ['cacheTypeV', 'cache_type_v']);
  const bytesPerElementK = bytesPerKvElement(cacheTypeK);
  const bytesPerElementV = bytesPerKvElement(cacheTypeV);
  const bytesPerToken = (
    nHeadKv
    * (nEmbdHeadK * bytesPerElementK + nEmbdHeadV * bytesPerElementV)
  );

  const kvBytes = kvCacheTokens * nLayers * bytesPerToken;
  if (!Number.isFinite(kvBytes) || kvBytes <= 0) {
    return { kvCacheBytes: 0, hasKvMetadata: false };
  }

  return { kvCacheBytes: Math.round(kvBytes), hasKvMetadata: true };
}

function estimateComputeBufferBytes({
  architecture,
  weightsBytes,
  kvCacheBytes,
  runtimeParams,
}: {
  architecture: string | null;
  weightsBytes: number;
  kvCacheBytes: number;
  runtimeParams: Record<string, unknown>;
}): number {
  const gpuLayers = readNumericRuntimeParam(runtimeParams, ['gpuLayers', 'n_gpu_layers', 'nGpuLayers']) ?? 0;
  const contextTokens = readNumericRuntimeParam(runtimeParams, ['contextTokens', 'contextSize', 'n_ctx', 'nCtx']) ?? 0;

  const normalizedArchitecture = architecture?.trim().toLowerCase() ?? '';
  const architectureFactor = normalizedArchitecture.includes('qwen')
    ? 1.12
    : normalizedArchitecture.includes('mistral')
      ? 1.07
      : normalizedArchitecture.includes('llama')
        ? 1.05
        : 1;

  const contextFactor = contextTokens >= 8192 ? 1.2 : contextTokens >= 4096 ? 1.1 : 1;
  const gpuFactor = gpuLayers > 0 ? 1.08 : 1;

  const baselineBytes = (
    weightsBytes * 0.05
    + kvCacheBytes * 0.02
  );
  const estimatedBytes = baselineBytes * architectureFactor * contextFactor * gpuFactor;

  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) {
    return 0;
  }

  return Math.round(Math.max(0, Math.min(estimatedBytes, 768 * 1024 * 1024)));
}

function estimateRuntimeOverheadBytes({
  weightsBytes,
  multimodalBytes,
}: {
  weightsBytes: number;
  multimodalBytes: number;
}): number {
  const overhead = weightsBytes * ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR + multimodalBytes * 0.05;
  if (!Number.isFinite(overhead) || overhead <= 0) {
    return 0;
  }

  return Math.round(overhead);
}

function estimateSafetyMarginBytes({
  baseBytes,
  snapshotLowMemory,
}: {
  baseBytes: number;
  snapshotLowMemory: boolean;
}): number {
  const percentMargin = Math.round(baseBytes * 0.03);
  const lowMemoryExtra = snapshotLowMemory ? 256 * 1024 * 1024 : 0;
  const margin = DEFAULT_SAFETY_MARGIN_BYTES + percentMargin + lowMemoryExtra;

  if (!Number.isFinite(margin) || margin <= 0) {
    return DEFAULT_SAFETY_MARGIN_BYTES;
  }

  return Math.round(Math.min(Math.max(margin, DEFAULT_SAFETY_MARGIN_BYTES), MAX_SAFETY_MARGIN_BYTES));
}

function createComponentBreakdown(input: EstimatorInput): {
  breakdown: MemoryBreakdown;
  hasKvMetadata: boolean;
  usedVerifiedWeights: boolean;
} {
  const verifiedWeights = toFinitePositiveNumber(input.verifiedFileSizeBytes);
  const modelSize = toFinitePositiveNumber(input.modelSizeBytes);
  const weightsResidentBytes = verifiedWeights ?? modelSize ?? 0;
  const usedVerifiedWeights = verifiedWeights !== null;

  if (weightsResidentBytes <= 0) {
    return { breakdown: UNKNOWN_BREAKDOWN, hasKvMetadata: false, usedVerifiedWeights: false };
  }

  const multimodalProjectionBytes = toFinitePositiveNumber(input.multimodalSizeBytes) ?? 0;
  const ggufMetadata = input.ggufMetadata;
  const architecture = (
    typeof ggufMetadata?.architecture === 'string'
      ? ggufMetadata.architecture
      : typeof ggufMetadata?.['general.architecture'] === 'string'
        ? ggufMetadata['general.architecture']
        : null
  );
  const { kvCacheBytes, hasKvMetadata } = estimateKvCacheBytes({ ggufMetadata, runtimeParams: input.runtimeParams });
  const computeBufferBytes = estimateComputeBufferBytes({
    architecture,
    weightsBytes: weightsResidentBytes,
    kvCacheBytes,
    runtimeParams: input.runtimeParams,
  });
  const runtimeOverheadBytes = estimateRuntimeOverheadBytes({
    weightsBytes: weightsResidentBytes,
    multimodalBytes: multimodalProjectionBytes,
  });

  const calibration = input.calibrationRecord
    ? normalizeCalibrationRecordFactors(input.calibrationRecord)
    : null;
  const weightsCorrectionFactor = calibration?.weightsCorrectionFactor ?? 1;
  const computeCorrectionFactor = calibration?.computeCorrectionFactor ?? 1;
  const overheadCorrectionFactor = calibration?.overheadCorrectionFactor ?? 1;
  const failurePenaltyFactor = calibration?.failurePenaltyFactor ?? 1;

  const calibratedWeightsResidentBytes = Math.round(Math.max(0, weightsResidentBytes * weightsCorrectionFactor));
  const calibratedComputeBufferBytes = Math.round(Math.max(0, computeBufferBytes * computeCorrectionFactor));
  const calibratedRuntimeOverheadBytes = Math.round(Math.max(0, runtimeOverheadBytes * overheadCorrectionFactor));

  const baseBytes = (
    calibratedWeightsResidentBytes
    + kvCacheBytes
    + calibratedComputeBufferBytes
    + multimodalProjectionBytes
    + calibratedRuntimeOverheadBytes
  );
  const rawSafetyMarginBytes = estimateSafetyMarginBytes({
    baseBytes,
    snapshotLowMemory: input.snapshot?.lowMemory === true,
  });
  const safetyMarginBytes = Math.round(Math.max(0, rawSafetyMarginBytes * failurePenaltyFactor));

  return {
    breakdown: {
      weightsBytes: calibratedWeightsResidentBytes,
      kvCacheBytes,
      computeBytes: calibratedComputeBufferBytes,
      multimodalBytes: multimodalProjectionBytes,
      overheadBytes: calibratedRuntimeOverheadBytes,
      safetyMarginBytes,
    },
    hasKvMetadata,
    usedVerifiedWeights,
  };
}

function decisionForBudgetFit({
  requiredBytes,
  effectiveBudgetBytes,
}: {
  requiredBytes: number;
  effectiveBudgetBytes: number;
}): MemoryFitDecision {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) {
    return 'unknown';
  }

  if (!Number.isFinite(effectiveBudgetBytes) || effectiveBudgetBytes <= 0) {
    return requiredBytes > 0 ? 'likely_oom' : 'unknown';
  }

  const overBudgetRatio = requiredBytes / effectiveBudgetBytes;
  if (!Number.isFinite(overBudgetRatio) || overBudgetRatio <= 0) {
    return 'unknown';
  }

  if (requiredBytes <= effectiveBudgetBytes) {
    return overBudgetRatio <= 0.75 ? 'fits_high_confidence' : 'fits_low_confidence';
  }

  return overBudgetRatio < 1.25 ? 'borderline' : 'likely_oom';
}

function confidenceForInputs(hasLiveBudget: boolean): MemoryFitConfidence {
  return hasLiveBudget ? 'high' : 'medium';
}

function recommendationsForDecision(decision: MemoryFitDecision): string[] {
  if (decision === 'borderline') {
    return [
      'Try lowering the context size.',
      'Try reducing GPU layers or disabling GPU offload.',
    ];
  }

  if (decision === 'likely_oom') {
    return [
      'Use a smaller model or a more memory-efficient quantization.',
      'Lower the context size and disable GPU offload.',
    ];
  }

  if (decision === 'unknown') {
    return [
      'Try downloading the model first so the app can verify its file size.',
    ];
  }

  return [];
}

function confidenceForFastEstimate(metadataTrust: MemoryMetadataTrust | undefined): MemoryFitConfidence {
  if (metadataTrust === 'verified_local' || metadataTrust === 'trusted_remote') {
    return 'medium';
  }

  return 'low';
}

function suggestGpuLayersForFastEstimate(totalMemoryBytes: number): number {
  const totalGB = totalMemoryBytes / 1_000_000_000;

  if (totalGB >= 12) return 35;
  if (totalGB >= 8) return 20;
  if (totalGB >= 6) return 10;
  return 0;
}

export function estimateModelRuntimeBytes(modelSizeBytes: number): number {
  return modelSizeBytes * (1 + ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR);
}

export function estimateMemoryFitFromModelSize({
  modelSizeBytes,
  totalMemoryBytes,
  systemMemorySnapshot,
}: {
  modelSizeBytes: number;
  totalMemoryBytes: number;
  systemMemorySnapshot?: MemoryBudgetSnapshot | null;
}): MemoryFitResult {
  if (!isFinitePositiveNumber(modelSizeBytes) || !isFinitePositiveNumber(totalMemoryBytes)) {
    return {
      decision: 'unknown',
      confidence: 'low',
      requiredBytes: 0,
      effectiveBudgetBytes: 0,
      breakdown: UNKNOWN_BREAKDOWN,
      budget: {
        totalMemoryBytes: isFinitePositiveNumber(totalMemoryBytes) ? totalMemoryBytes : 0,
        effectiveBudgetBytes: 0,
      },
      recommendations: recommendationsForDecision('unknown'),
    };
  }

  const breakdown = createBaseBreakdownForModelSize(modelSizeBytes);
  const requiredBytes = sumBreakdown(breakdown);
  const { effectiveBudgetBytes, budget } = createMemoryBudget({
    totalMemoryBytes,
    systemMemorySnapshot,
  });

  const decision = decisionForBudgetFit({ requiredBytes, effectiveBudgetBytes });
  const confidence = confidenceForInputs(Boolean(systemMemorySnapshot));

  return {
    decision,
    confidence,
    requiredBytes,
    effectiveBudgetBytes,
    breakdown,
    budget,
    recommendations: recommendationsForDecision(decision),
  };
}

function confidenceForAccurateEstimate({
  hasLiveSnapshot,
  hasKvMetadata,
  metadataTrust,
  usedVerifiedWeights,
  hasTrustedTotalMemory,
  needsKvMetadata,
}: {
  hasLiveSnapshot: boolean;
  hasKvMetadata: boolean;
  metadataTrust: MemoryMetadataTrust | undefined;
  usedVerifiedWeights: boolean;
  hasTrustedTotalMemory: boolean;
  needsKvMetadata: boolean;
}): MemoryFitConfidence {
  if (!hasTrustedTotalMemory) {
    return 'low';
  }

  const trustHigh = metadataTrust === 'verified_local' || metadataTrust === 'trusted_remote';
  const trustMedium = trustHigh || metadataTrust === 'inferred';
  const kvOk = !needsKvMetadata || hasKvMetadata;

  if (hasLiveSnapshot && trustHigh && usedVerifiedWeights && kvOk) {
    return 'high';
  }

  if (trustMedium && usedVerifiedWeights && kvOk) {
    return 'medium';
  }

  return 'low';
}

export function estimateAccurateMemoryFit({
  input,
  totalMemoryBytes,
}: {
  input: EstimatorInput;
  totalMemoryBytes: number | null;
}): MemoryFitResult {
  const resolvedTotalMemoryBytes = toFinitePositiveNumber(input.snapshot?.totalBytes) ?? toFinitePositiveNumber(totalMemoryBytes);
  const hasLiveSnapshot = Boolean(input.snapshot);
  const { breakdown, hasKvMetadata, usedVerifiedWeights } = createComponentBreakdown(input);
  const requiredBytes = sumBreakdown(breakdown);
  const needsKvMetadata = Boolean(
    readNumericRuntimeParam(input.runtimeParams, ['contextTokens', 'contextSize', 'n_ctx', 'nCtx']),
  );

  const { effectiveBudgetBytes, budget } = createMemoryBudget({
    totalMemoryBytes: resolvedTotalMemoryBytes,
    systemMemorySnapshot: input.snapshot ?? null,
    learnedSafeBudgetBytes: input.calibrationRecord?.learnedSafeBudgetBytes,
  });

  const hasTrustedBudget = budget.totalMemoryBytes > 0;
  const decision = hasTrustedBudget
    ? decisionForBudgetFit({ requiredBytes, effectiveBudgetBytes })
    : 'unknown';

  let confidence = confidenceForAccurateEstimate({
    hasLiveSnapshot,
    hasKvMetadata,
    metadataTrust: input.metadataTrust,
    usedVerifiedWeights,
    hasTrustedTotalMemory: hasTrustedBudget,
    needsKvMetadata,
  });

  let normalizedDecision = decision;
  if (confidence === 'low' && normalizedDecision === 'fits_high_confidence') {
    normalizedDecision = 'fits_low_confidence';
  }

  if (normalizedDecision === 'unknown') {
    confidence = 'low';
  }

  return {
    decision: normalizedDecision,
    confidence,
    requiredBytes,
    effectiveBudgetBytes,
    breakdown,
    budget,
    recommendations: recommendationsForDecision(normalizedDecision),
  };
}

export function estimateFastMemoryFit({
  modelSizeBytes,
  totalMemoryBytes,
  metadataTrust,
  ggufMetadata,
}: {
  modelSizeBytes: number | null;
  totalMemoryBytes: number | null;
  metadataTrust?: MemoryMetadataTrust;
  ggufMetadata?: Record<string, unknown>;
}): MemoryFitResult {
  if (!isFinitePositiveNumber(modelSizeBytes) || !isFinitePositiveNumber(totalMemoryBytes)) {
    return estimateMemoryFitFromModelSize({
      modelSizeBytes: 0,
      totalMemoryBytes: isFinitePositiveNumber(totalMemoryBytes) ? totalMemoryBytes : 0,
      systemMemorySnapshot: null,
    });
  }

  const previewAvailableBytes = Math.floor(totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO);
  const previewThresholdBytes = Math.min(
    previewAvailableBytes,
    FAST_ESTIMATE_DEFAULT_THRESHOLD_BYTES,
  );
  const previewAppBaselineBytes = Math.max(
    FAST_ESTIMATE_MIN_APP_BASELINE_BYTES,
    Math.floor(totalMemoryBytes * 0.05),
  );
  const { breakdown } = createComponentBreakdown({
    modelSizeBytes,
    metadataTrust: metadataTrust ?? 'unknown',
    ggufMetadata,
    runtimeParams: {
      contextTokens: FAST_ESTIMATE_DEFAULT_CONTEXT_TOKENS,
      gpuLayers: suggestGpuLayersForFastEstimate(totalMemoryBytes),
      cacheTypeK: 'f16',
      cacheTypeV: 'f16',
      useMmap: true,
    },
    snapshot: {
      totalBytes: totalMemoryBytes,
      availableBytes: previewAvailableBytes,
      usedBytes: Math.max(totalMemoryBytes - previewAvailableBytes, 0),
      appUsedBytes: previewAppBaselineBytes,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: previewThresholdBytes,
      timestampMs: 0,
      platform: 'android',
    },
  });
  const requiredBytes = sumBreakdown(breakdown);
  const { effectiveBudgetBytes, budget } = createMemoryBudget({
    totalMemoryBytes,
    systemMemorySnapshot: {
      availableBytes: previewAvailableBytes,
      thresholdBytes: previewThresholdBytes,
      appUsedBytes: previewAppBaselineBytes,
      lowMemory: false,
      pressureLevel: 'normal',
    },
  });
  const baseDecision = decisionForBudgetFit({ requiredBytes, effectiveBudgetBytes });

  const confidence = confidenceForFastEstimate(metadataTrust);
  const decision = confidence === 'low' && baseDecision === 'fits_high_confidence'
    ? 'fits_low_confidence'
    : baseDecision;

  return {
    decision,
    confidence,
    requiredBytes,
    effectiveBudgetBytes,
    breakdown,
    budget,
    recommendations: recommendationsForDecision(decision),
  };
}
