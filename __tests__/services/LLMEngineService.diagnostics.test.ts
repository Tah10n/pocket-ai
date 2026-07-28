import {
  buildEngineDiagnosticsSnapshot,
  buildInferenceCompletionTelemetry,
} from '../../src/services/LLMEngineService.diagnostics';
import type { PromptStateCachePolicy } from '../../src/services/PromptStateCachePolicy';

describe('LLMEngineService MTP diagnostics', () => {
  it('preserves native throughput and computes draft acceptance', () => {
    expect(buildInferenceCompletionTelemetry({
      result: {
        tokens_predicted: 120,
        tokens_evaluated: 31,
        draft_tokens: 80,
        draft_tokens_accepted: 36,
        timings: {
          predicted_per_second: 7.25,
          prompt_per_second: 18.5,
        },
      },
      mtpRequested: true,
      mtpAttempted: true,
      mtpFallbackUsed: false,
      timeToFirstTokenMs: 913,
    })).toEqual({
      tokensPredicted: 120,
      tokensEvaluated: 31,
      predictedPerSecond: 7.25,
      promptPerSecond: 18.5,
      timeToFirstTokenMs: 913,
      mtp: {
        requested: true,
        attempted: true,
        fallbackUsed: false,
        draftTokens: 80,
        draftTokensAccepted: 36,
        acceptanceRate: 0.45,
        fallbackReason: undefined,
      },
    });
  });

  it('sanitizes invalid native counters and records completion fallback', () => {
    expect(buildInferenceCompletionTelemetry({
      result: {
        tokens_predicted: Number.NaN,
        tokens_evaluated: -1,
        draft_tokens: 0,
        draft_tokens_accepted: 0,
        timings: {
          predicted_per_second: -5,
          prompt_per_second: Number.POSITIVE_INFINITY,
        },
      },
      mtpRequested: true,
      mtpAttempted: true,
      mtpFallbackUsed: true,
      fallbackReason: 'completion_failed',
    })).toEqual({
      tokensPredicted: 0,
      tokensEvaluated: 0,
      predictedPerSecond: undefined,
      promptPerSecond: undefined,
      timeToFirstTokenMs: undefined,
      mtp: {
        requested: true,
        attempted: true,
        fallbackUsed: true,
        draftTokens: 0,
        draftTokensAccepted: 0,
        acceptanceRate: undefined,
        fallbackReason: 'completion_failed',
      },
    });
  });
});

describe('LLMEngineService prompt state cache diagnostics', () => {
  it('reports only policy and reserved-memory facts supplied by the runtime policy', () => {
    const policy: PromptStateCachePolicy = {
      budgetMb: 160,
      maxCheckpoints: 8,
      enabled: true,
      eligibility: 'eligible',
      reason: 'maximum_safe_budget',
      policyVersion: 1,
      architecture: 'mamba',
      backendMode: 'gpu',
      finalMemoryFit: {
        decision: 'fits_high_confidence',
        confidence: 'high',
        requiredBytes: 2_000,
        effectiveBudgetBytes: 4_000,
        breakdown: {
          weightsBytes: 1_000,
          kvCacheBytes: 100,
          promptStateCacheBytes: 160 * 1024 * 1024,
          computeBytes: 100,
          multimodalBytes: 0,
          overheadBytes: 100,
          safetyMarginBytes: 100,
        },
        budget: {
          totalMemoryBytes: 8_000,
          effectiveBudgetBytes: 4_000,
        },
        recommendations: [],
      },
      evaluatedBudgetsMb: [160],
      source: 'runtime_accurate_memory_fit',
    };
    const snapshot = buildEngineDiagnosticsSnapshot({
      activeBackendMode: 'gpu',
      activeBackendDevices: ['private-device-name'],
      activeBackendReasonNoGpu: null,
      activeBackendSystemInfo: null,
      activeBackendAndroidLib: null,
      requestedGpuLayers: 12,
      activeGpuLayers: 12,
      actualGpuAccelerated: true,
      requestedBackendPolicy: 'gpu',
      effectiveBackendPolicy: 'gpu',
      backendPolicyReasons: [],
      backendInitAttemptsSnapshot: [{
        candidate: 'gpu',
        nGpuLayers: 12,
        contextSize: 4096,
        cacheTypeK: 'f16',
        cacheTypeV: 'f16',
        stateCacheBudgetMb: 160,
        stateCacheMaxCheckpoints: 8,
        stateCacheEnabled: true,
        stateCacheEligibility: 'eligible',
        stateCachePolicyReason: 'maximum_safe_budget',
        stateCachePolicyVersion: 1,
        promptStateCacheBytes: 160 * 1024 * 1024,
        stateCacheArchitecture: 'mamba',
        speculativeEnabled: false,
        profileSource: 'requested',
        probableOom: false,
        durationMs: 10,
        outcome: 'success',
      }],
      initGpuLayers: 12,
      initDevices: ['private-device-name'],
      initCacheTypeK: 'f16',
      initCacheTypeV: 'f16',
      initFlashAttnType: 'on',
      initUseMmap: true,
      initUseMlock: false,
      initNParallel: 1,
      initNThreads: 4,
      initCpuMask: null,
      initCpuStrict: null,
      initNBatch: 512,
      initNUbatch: 256,
      initKvUnified: false,
      lastLifecycleEvent: null,
      lastLifecycleError: null,
      multimodalDiagnostics: null,
      speculativeDecodingDiagnostics: null,
      activePromptStateCachePolicy: policy,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      stateCacheBudgetMb: 160,
      stateCacheMaxCheckpoints: 8,
      stateCacheEnabled: true,
      stateCacheEligibility: 'eligible',
      stateCachePolicyReason: 'maximum_safe_budget',
      stateCachePolicyVersion: 1,
      promptStateCacheBytes: 160 * 1024 * 1024,
      stateCacheArchitecture: 'mamba',
    }));
    expect(snapshot.backendDevices).toEqual(['gpu']);
    expect(snapshot.backendInitAttempts?.[0]).toEqual(expect.objectContaining({
      stateCacheBudgetMb: 160,
      stateCacheArchitecture: 'mamba',
    }));
    expect(snapshot).not.toHaveProperty('stateCacheHits');
    expect(snapshot).not.toHaveProperty('stateCacheTokens');
  });
});
