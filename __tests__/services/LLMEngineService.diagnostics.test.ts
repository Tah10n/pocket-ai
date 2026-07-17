import { buildInferenceCompletionTelemetry } from '../../src/services/LLMEngineService.diagnostics';

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
