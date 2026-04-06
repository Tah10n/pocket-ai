import type { CalibrationKey, CalibrationRecord, MemoryBreakdown } from './types';

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFinitePositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

const WEIGHTS_CORRECTION_BOUNDS = { min: 0.9, max: 1.1 };
const COMPUTE_CORRECTION_BOUNDS = { min: 0.8, max: 1.35 };
const OVERHEAD_CORRECTION_BOUNDS = { min: 0.8, max: 1.5 };
const FAILURE_PENALTY_BOUNDS = { min: 1, max: 1.6 };
const SUCCESS_FACTOR_EMA_ALPHA = 0.25;
const SUCCESS_PENALTY_DECAY = 0.9;
const FAILURE_PENALTY_INFLATION = 1.12;
const CALIBRATION_STALENESS_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STALENESS_FACTOR_DECAY = 0.5; // Halve the distance from default when stale

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function resolveBoundedFactor(
  value: unknown,
  bounds: { min: number; max: number },
  fallback: number,
): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (candidate === null) {
    return fallback;
  }

  return clamp(candidate, bounds.min, bounds.max);
}

export function resolveCalibrationArchitectureLabel(ggufMetadata?: Record<string, unknown>): string {
  if (!ggufMetadata) {
    return 'unknown';
  }

  const direct = normalizeNonEmptyString(ggufMetadata.architecture);
  if (direct) {
    return direct.toLowerCase();
  }

  const general = normalizeNonEmptyString(ggufMetadata['general.architecture']);
  return general ? general.toLowerCase() : 'unknown';
}

export function resolveCalibrationQuantizationLabel(ggufMetadata?: Record<string, unknown>): string {
  if (!ggufMetadata) {
    return 'unknown';
  }

  const sizeLabel = normalizeNonEmptyString(ggufMetadata.sizeLabel ?? ggufMetadata.size_label);
  return sizeLabel ? sizeLabel : 'unknown';
}

export function serializeCalibrationKey(key: CalibrationKey): string {
  // Keep the key stable and readable for now; later phases can replace with a compact hash.
  return JSON.stringify(key);
}

export function createCalibrationKey({
  deviceModel,
  osMajor,
  ggufMetadata,
  verifiedFileSizeBytes,
  contextTokens,
  gpuLayers,
  cacheTypeK,
  cacheTypeV,
  useMmap,
  hasMmproj,
  nBatch = 0,
  nUbatch = 0,
}: {
  deviceModel: string;
  osMajor: string;
  ggufMetadata?: Record<string, unknown>;
  verifiedFileSizeBytes: number;
  contextTokens: number;
  gpuLayers: number;
  cacheTypeK: string;
  cacheTypeV: string;
  useMmap: boolean;
  hasMmproj: boolean;
  nBatch?: number;
  nUbatch?: number;
}): CalibrationKey | null {
  const normalizedDevice = normalizeNonEmptyString(deviceModel);
  const normalizedOsMajor = normalizeNonEmptyString(osMajor);
  const verifiedSize = normalizeFinitePositiveNumber(verifiedFileSizeBytes);
  const requestedCtx = normalizeFinitePositiveNumber(contextTokens);
  const gpuLayerCount = normalizeFiniteNonNegativeNumber(gpuLayers);
  const normalizedCacheTypeK = normalizeNonEmptyString(cacheTypeK);
  const normalizedCacheTypeV = normalizeNonEmptyString(cacheTypeV);
  const normalizedBatch = normalizeFiniteNonNegativeNumber(nBatch);
  const normalizedUbatch = normalizeFiniteNonNegativeNumber(nUbatch);

  if (
    !normalizedDevice
    || !normalizedOsMajor
    || verifiedSize === null
    || requestedCtx === null
    || gpuLayerCount === null
    || normalizedCacheTypeK === null
    || normalizedCacheTypeV === null
    || normalizedBatch === null
    || normalizedUbatch === null
  ) {
    return null;
  }

  const architecture = resolveCalibrationArchitectureLabel(ggufMetadata);
  const quantization = resolveCalibrationQuantizationLabel(ggufMetadata);

  return {
    deviceModel: normalizedDevice,
    osMajor: normalizedOsMajor,
    architecture,
    quantization,
    verifiedFileSizeBytes: Math.round(verifiedSize),
    requestedCtx: Math.round(requestedCtx),
    nBatch: Math.round(normalizedBatch),
    nUbatch: Math.round(normalizedUbatch),
    cacheTypeK: normalizedCacheTypeK.toLowerCase(),
    cacheTypeV: normalizedCacheTypeV.toLowerCase(),
    useMmap: useMmap === true,
    gpuLayers: Math.round(gpuLayerCount),
    hasMmproj: hasMmproj === true,
  };
}

export function createEmptyCalibrationRecord(key: string): CalibrationRecord {
  return {
    key,
    sampleCount: 0,
    successCount: 0,
    failureCount: 0,
    weightsCorrectionFactor: 1,
    computeCorrectionFactor: 1,
    overheadCorrectionFactor: 1,
    failurePenaltyFactor: 1,
    learnedSafeBudgetBytes: undefined,
    lastObservedAtMs: Date.now(),
  };
}

export function applyCalibrationToBreakdown(
  breakdown: MemoryBreakdown,
  record: CalibrationRecord | undefined,
): MemoryBreakdown {
  if (!record) {
    return breakdown;
  }

  const weightsFactor = resolveBoundedFactor(record.weightsCorrectionFactor, WEIGHTS_CORRECTION_BOUNDS, 1);
  const computeFactor = resolveBoundedFactor(record.computeCorrectionFactor, COMPUTE_CORRECTION_BOUNDS, 1);
  const overheadFactor = resolveBoundedFactor(record.overheadCorrectionFactor, OVERHEAD_CORRECTION_BOUNDS, 1);
  const failurePenaltyFactor = resolveBoundedFactor(record.failurePenaltyFactor, FAILURE_PENALTY_BOUNDS, 1);

  const weightsBytes = Math.round(Math.max(0, breakdown.weightsBytes * weightsFactor));
  const computeBytes = Math.round(Math.max(0, breakdown.computeBytes * computeFactor));
  const overheadBytes = Math.round(Math.max(0, breakdown.overheadBytes * overheadFactor));
  const safetyMarginBytes = Math.round(Math.max(0, breakdown.safetyMarginBytes * failurePenaltyFactor));

  return {
    ...breakdown,
    weightsBytes,
    computeBytes,
    overheadBytes,
    safetyMarginBytes,
  };
}

function decayStaleFactorTowardsDefault(factor: number, defaultValue: number): number {
  return defaultValue + (factor - defaultValue) * STALENESS_FACTOR_DECAY;
}

export function normalizeCalibrationRecordFactors(record: CalibrationRecord, nowMs?: number): CalibrationRecord {
  const lastObservedAtMs = Math.max(0, Math.floor(record.lastObservedAtMs));
  const resolvedNowMs = nowMs ?? Date.now();
  const isStale = lastObservedAtMs > 0 && (resolvedNowMs - lastObservedAtMs) > CALIBRATION_STALENESS_THRESHOLD_MS;

  let weightsCorrectionFactor = resolveBoundedFactor(record.weightsCorrectionFactor, WEIGHTS_CORRECTION_BOUNDS, 1);
  let computeCorrectionFactor = resolveBoundedFactor(record.computeCorrectionFactor, COMPUTE_CORRECTION_BOUNDS, 1);
  let overheadCorrectionFactor = resolveBoundedFactor(record.overheadCorrectionFactor, OVERHEAD_CORRECTION_BOUNDS, 1);
  let failurePenaltyFactor = resolveBoundedFactor(record.failurePenaltyFactor, FAILURE_PENALTY_BOUNDS, 1);

  if (isStale) {
    weightsCorrectionFactor = clamp(decayStaleFactorTowardsDefault(weightsCorrectionFactor, 1), WEIGHTS_CORRECTION_BOUNDS.min, WEIGHTS_CORRECTION_BOUNDS.max);
    computeCorrectionFactor = clamp(decayStaleFactorTowardsDefault(computeCorrectionFactor, 1), COMPUTE_CORRECTION_BOUNDS.min, COMPUTE_CORRECTION_BOUNDS.max);
    overheadCorrectionFactor = clamp(decayStaleFactorTowardsDefault(overheadCorrectionFactor, 1), OVERHEAD_CORRECTION_BOUNDS.min, OVERHEAD_CORRECTION_BOUNDS.max);
    failurePenaltyFactor = clamp(decayStaleFactorTowardsDefault(failurePenaltyFactor, 1), FAILURE_PENALTY_BOUNDS.min, FAILURE_PENALTY_BOUNDS.max);
  }

  return {
    ...record,
    sampleCount: Math.max(0, Math.floor(record.sampleCount)),
    successCount: Math.max(0, Math.floor(record.successCount)),
    failureCount: Math.max(0, Math.floor(record.failureCount)),
    weightsCorrectionFactor,
    computeCorrectionFactor,
    overheadCorrectionFactor,
    failurePenaltyFactor,
    learnedSafeBudgetBytes: typeof record.learnedSafeBudgetBytes === 'number' && Number.isFinite(record.learnedSafeBudgetBytes) && record.learnedSafeBudgetBytes > 0
      ? record.learnedSafeBudgetBytes
      : undefined,
    lastObservedAtMs,
  };
}

function sumPositiveByteCounts(...values: number[]): number {
  return values.reduce((acc, value) => {
    if (!Number.isFinite(value) || value <= 0) {
      return acc;
    }
    return acc + value;
  }, 0);
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function updateEmaFactor({
  current,
  target,
  bounds,
  alpha,
}: {
  current: number;
  target: number;
  bounds: { min: number; max: number };
  alpha: number;
}): number {
  const normalizedAlpha = clamp(alpha, 0, 1);
  const candidate = current * (1 - normalizedAlpha) + target * normalizedAlpha;
  return clamp(candidate, bounds.min, bounds.max);
}

export function applySuccessfulCalibrationObservation({
  record,
  predictedBreakdown,
  observedResidentDeltaBytes,
  observedRawBudgetBytes,
  nowMs = Date.now(),
}: {
  record: CalibrationRecord;
  predictedBreakdown: MemoryBreakdown;
  observedResidentDeltaBytes: number | null;
  observedRawBudgetBytes: number | null;
  nowMs?: number;
}): CalibrationRecord {
  const resolvedNowMs = nowMs ?? Date.now();
  const normalized = normalizeCalibrationRecordFactors(record, resolvedNowMs);
  const predictedAdjustableBytes = sumPositiveByteCounts(
    predictedBreakdown.weightsBytes,
    predictedBreakdown.computeBytes,
    predictedBreakdown.overheadBytes,
  );
  const predictedOtherBytes = sumPositiveByteCounts(
    predictedBreakdown.kvCacheBytes,
    predictedBreakdown.multimodalBytes,
  );

  let updated = {
    ...normalized,
    sampleCount: normalized.sampleCount + 1,
    successCount: normalized.successCount + 1,
    lastObservedAtMs: Math.max(0, Math.floor(resolvedNowMs)),
    failurePenaltyFactor: clamp(normalized.failurePenaltyFactor * SUCCESS_PENALTY_DECAY, FAILURE_PENALTY_BOUNDS.min, FAILURE_PENALTY_BOUNDS.max),
  };

  if (isFinitePositiveNumber(observedRawBudgetBytes)) {
    updated = {
      ...updated,
      learnedSafeBudgetBytes: updated.learnedSafeBudgetBytes
        ? Math.min(updated.learnedSafeBudgetBytes, observedRawBudgetBytes)
        : observedRawBudgetBytes,
    };
  }

  if (
    !isFinitePositiveNumber(observedResidentDeltaBytes)
    || !isFinitePositiveNumber(predictedAdjustableBytes)
  ) {
    return normalizeCalibrationRecordFactors(updated, resolvedNowMs);
  }

  const observedAdjustableBytes = Math.max(0, observedResidentDeltaBytes - predictedOtherBytes);
  if (!Number.isFinite(observedAdjustableBytes) || observedAdjustableBytes <= 0) {
    return normalizeCalibrationRecordFactors(updated, resolvedNowMs);
  }

  const ratio = observedAdjustableBytes / predictedAdjustableBytes;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return normalizeCalibrationRecordFactors(updated, resolvedNowMs);
  }

  return normalizeCalibrationRecordFactors({
    ...updated,
    weightsCorrectionFactor: updateEmaFactor({
      current: updated.weightsCorrectionFactor,
      target: ratio,
      bounds: WEIGHTS_CORRECTION_BOUNDS,
      alpha: SUCCESS_FACTOR_EMA_ALPHA,
    }),
    computeCorrectionFactor: updateEmaFactor({
      current: updated.computeCorrectionFactor,
      target: ratio,
      bounds: COMPUTE_CORRECTION_BOUNDS,
      alpha: SUCCESS_FACTOR_EMA_ALPHA,
    }),
    overheadCorrectionFactor: updateEmaFactor({
      current: updated.overheadCorrectionFactor,
      target: ratio,
      bounds: OVERHEAD_CORRECTION_BOUNDS,
      alpha: SUCCESS_FACTOR_EMA_ALPHA,
    }),
  }, resolvedNowMs);
}

export function applyFailedCalibrationObservation({
  record,
  observedRawBudgetBytes,
  nowMs = Date.now(),
}: {
  record: CalibrationRecord;
  observedRawBudgetBytes: number | null;
  nowMs?: number;
}): CalibrationRecord {
  const resolvedNowMs = nowMs ?? Date.now();
  const normalized = normalizeCalibrationRecordFactors(record, resolvedNowMs);
  let updated: CalibrationRecord = {
    ...normalized,
    sampleCount: normalized.sampleCount + 1,
    failureCount: normalized.failureCount + 1,
    lastObservedAtMs: Math.max(0, Math.floor(resolvedNowMs)),
    failurePenaltyFactor: clamp(
      normalized.failurePenaltyFactor * FAILURE_PENALTY_INFLATION,
      FAILURE_PENALTY_BOUNDS.min,
      FAILURE_PENALTY_BOUNDS.max,
    ),
  };

  if (isFinitePositiveNumber(observedRawBudgetBytes)) {
    updated = {
      ...updated,
      learnedSafeBudgetBytes: updated.learnedSafeBudgetBytes
        ? Math.min(updated.learnedSafeBudgetBytes, observedRawBudgetBytes)
        : observedRawBudgetBytes,
    };
  }

  return normalizeCalibrationRecordFactors(updated, resolvedNowMs);
}
