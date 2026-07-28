import {
  applyFailedCalibrationObservation,
  applySuccessfulCalibrationObservation,
  createCalibrationKey,
  createEmptyCalibrationRecord,
  normalizeCalibrationRecordFactors,
  serializeCalibrationKey,
} from '../../src/memory/calibration';

describe('memory calibration', () => {
  it('creates a stable calibration key with normalized fields', () => {
    const key = createCalibrationKey({
      deviceModel: 'Pixel 7',
      osMajor: 'android:14',
      ggufMetadata: {
        'general.architecture': 'LLAMA',
        sizeLabel: 'Q4_K_M',
      },
      verifiedFileSizeBytes: 1234,
      contextTokens: 4096,
      gpuLayers: 12,
      cacheTypeK: 'F16',
      cacheTypeV: 'F32',
      useMmap: true,
      hasMmproj: false,
      stateCacheBudgetMb: 160,
      stateCacheMaxCheckpoints: 8,
      stateCachePolicyVersion: 1,
      nBatch: 0,
      nUbatch: 0,
    });

    expect(key).toEqual({
      deviceModel: 'Pixel 7',
      osMajor: 'android:14',
      architecture: 'llama',
      quantization: 'Q4_K_M',
      verifiedFileSizeBytes: 1234,
      requestedCtx: 4096,
      nBatch: 0,
      nUbatch: 0,
      cacheTypeK: 'f16',
      cacheTypeV: 'f32',
      useMmap: true,
      gpuLayers: 12,
      hasMmproj: false,
      stateCacheBudgetMb: 160,
      stateCacheMaxCheckpoints: 8,
      stateCachePolicyVersion: 1,
    });

    expect(serializeCalibrationKey(key!)).toContain('"deviceModel":"Pixel 7"');
  });

  it('returns null when required key fields are missing', () => {
    expect(
      createCalibrationKey({
        deviceModel: '',
        osMajor: 'android:14',
        verifiedFileSizeBytes: 123,
        contextTokens: 4096,
        gpuLayers: 0,
        cacheTypeK: 'f16',
        cacheTypeV: 'f16',
        useMmap: true,
        hasMmproj: false,
        stateCacheBudgetMb: 0,
        stateCacheMaxCheckpoints: 8,
        stateCachePolicyVersion: 1,
      }),
    ).toBeNull();
  });

  it('isolates disabled and enabled prompt state cache profiles and roundtrips every dimension', () => {
    const createKey = (stateCacheBudgetMb: number) => createCalibrationKey({
      deviceModel: 'Pixel 7',
      osMajor: 'android:14',
      ggufMetadata: { 'general.architecture': 'mamba' },
      verifiedFileSizeBytes: 1234,
      contextTokens: 4096,
      gpuLayers: 12,
      cacheTypeK: 'f16',
      cacheTypeV: 'f16',
      useMmap: true,
      hasMmproj: false,
      stateCacheBudgetMb,
      stateCacheMaxCheckpoints: 8,
      stateCachePolicyVersion: 1,
    });

    const disabled = createKey(0)!;
    const enabled = createKey(160)!;

    expect(serializeCalibrationKey(disabled)).not.toBe(serializeCalibrationKey(enabled));
    expect(JSON.parse(serializeCalibrationKey(enabled))).toEqual(enabled);
  });

  it('isolates the fail-closed policy version from older cache calibration records', () => {
    const createKey = (stateCachePolicyVersion: number) => createCalibrationKey({
      deviceModel: 'Pixel 7',
      osMajor: 'android:14',
      ggufMetadata: { 'general.architecture': 'mamba' },
      verifiedFileSizeBytes: 1234,
      contextTokens: 4096,
      gpuLayers: 12,
      cacheTypeK: 'f16',
      cacheTypeV: 'f16',
      useMmap: true,
      hasMmproj: false,
      stateCacheBudgetMb: 0,
      stateCacheMaxCheckpoints: 8,
      stateCachePolicyVersion,
    })!;

    expect(serializeCalibrationKey(createKey(1))).not.toBe(
      serializeCalibrationKey(createKey(2)),
    );
  });

  it('updates bounded factors on success and failure observations', () => {
    const baseline = {
      ...createEmptyCalibrationRecord('k'),
      failurePenaltyFactor: 1.2,
      lastObservedAtMs: 1,
    };

    const predictedBreakdown = {
      weightsBytes: 100,
      kvCacheBytes: 10,
      promptStateCacheBytes: 0,
      computeBytes: 50,
      multimodalBytes: 0,
      overheadBytes: 50,
      safetyMarginBytes: 20,
    };

    const success = applySuccessfulCalibrationObservation({
      record: baseline,
      predictedBreakdown,
      observedResidentDeltaBytes: 240,
      observedRawBudgetBytes: 4_000_000_000,
      nowMs: 10,
    });

    expect(success.sampleCount).toBe(1);
    expect(success.successCount).toBe(1);
    expect(success.failureCount).toBe(0);
    expect(success.learnedSafeBudgetBytes).toBe(4_000_000_000);
    expect(success.failurePenaltyFactor).toBeCloseTo(1.08, 6);
    expect(success.weightsCorrectionFactor).toBeCloseTo(1.0375, 6);
    expect(success.computeCorrectionFactor).toBeCloseTo(1.0375, 6);
    expect(success.overheadCorrectionFactor).toBeCloseTo(1.0375, 6);

    const failure = applyFailedCalibrationObservation({
      record: success,
      observedRawBudgetBytes: 3_500_000_000,
      nowMs: 20,
    });

    expect(failure.sampleCount).toBe(2);
    expect(failure.failureCount).toBe(1);
    expect(failure.learnedSafeBudgetBytes).toBe(3_500_000_000);
    expect(failure.failurePenaltyFactor).toBeCloseTo(1.2096, 6);
  });

  it('normalizes invalid factors into safe bounds', () => {
    const normalized = normalizeCalibrationRecordFactors({
      key: 'k',
      sampleCount: -1,
      successCount: 0,
      failureCount: 0,
      weightsCorrectionFactor: 999,
      computeCorrectionFactor: 0,
      overheadCorrectionFactor: Number.NaN,
      failurePenaltyFactor: -5,
      learnedSafeBudgetBytes: -1,
      lastObservedAtMs: -2,
    });

    expect(normalized.sampleCount).toBe(0);
    expect(normalized.lastObservedAtMs).toBe(0);
    expect(normalized.learnedSafeBudgetBytes).toBeUndefined();
    expect(normalized.weightsCorrectionFactor).toBeLessThanOrEqual(1.1);
    expect(normalized.weightsCorrectionFactor).toBeGreaterThanOrEqual(0.9);
    expect(normalized.computeCorrectionFactor).toBeGreaterThanOrEqual(0.8);
    expect(normalized.failurePenaltyFactor).toBeGreaterThanOrEqual(1);
  });
});

