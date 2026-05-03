import type { SystemMemorySnapshot } from '../services/SystemMetricsService';

export type MemoryFitDecision =
  | 'fits_high_confidence'
  | 'fits_low_confidence'
  | 'borderline'
  | 'likely_oom'
  | 'unknown';

export type MemoryFitConfidence = 'high' | 'medium' | 'low';

export type MemoryMetadataTrust = 'verified_local' | 'trusted_remote' | 'inferred' | 'unknown';

export interface MemoryBreakdown {
  weightsBytes: number;
  kvCacheBytes: number;
  computeBytes: number;
  multimodalBytes: number;
  overheadBytes: number;
  safetyMarginBytes: number;
}

export interface MemoryBudget {
  totalMemoryBytes: number;
  liveAvailableBytes?: number;
  freeBytes?: number;
  processAvailableBytes?: number;
  advertisedMemoryBytes?: number;
  thresholdBytes?: number;
  appResidentBytes?: number;
  appPssBytes?: number;
  learnedSafeBudgetBytes?: number;
  effectiveBudgetBytes: number;
}

export interface MemoryFitResult {
  decision: MemoryFitDecision;
  confidence: MemoryFitConfidence;
  requiredBytes: number;
  effectiveBudgetBytes: number;
  breakdown: MemoryBreakdown;
  budget: MemoryBudget;
  recommendations: string[];
}

export interface CalibrationKey {
  deviceModel: string;
  osMajor: string;
  architecture: string;
  quantization: string;
  verifiedFileSizeBytes: number;
  requestedCtx: number;
  nBatch: number;
  nUbatch: number;
  cacheTypeK: string;
  cacheTypeV: string;
  useMmap: boolean;
  gpuLayers: number;
  hasMmproj: boolean;
}

export interface CalibrationRecord {
  key: string;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  weightsCorrectionFactor: number;
  computeCorrectionFactor: number;
  overheadCorrectionFactor: number;
  failurePenaltyFactor: number;
  learnedSafeBudgetBytes?: number;
  lastObservedAtMs: number;
}

export interface EstimatorInput {
  modelSizeBytes: number | null;
  verifiedFileSizeBytes?: number;
  multimodalSizeBytes?: number;
  metadataTrust: MemoryMetadataTrust;
  ggufMetadata?: Record<string, unknown>;
  runtimeParams: Record<string, unknown>;
  snapshot?: SystemMemorySnapshot;
  calibrationRecord?: CalibrationRecord;
}

export interface ContextSolveResult {
  maxContextTokens: number;
  reason: string;
  requiredBytesAtCeiling: number;
  effectiveBudgetBytes: number;
}

