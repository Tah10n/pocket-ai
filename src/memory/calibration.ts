import type { CalibrationKey, CalibrationRecord } from './types';

export function serializeCalibrationKey(key: CalibrationKey): string {
  // Keep the key stable and readable for now; later phases can replace with a compact hash.
  return JSON.stringify(key);
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

