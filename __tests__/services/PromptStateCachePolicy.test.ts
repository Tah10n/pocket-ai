import type { MemoryFitDecision, MemoryFitResult } from '../../src/memory/types';
import {
  ENABLE_NONZERO_PROMPT_STATE_CACHE,
  PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
  PROMPT_STATE_CACHE_POLICY_VERSION,
  resolvePromptStateCachePolicy,
} from '../../src/services/PromptStateCachePolicy';

const MIB = 1024 * 1024;

function createMemoryFit({
  decision = 'fits_high_confidence',
  confidence = 'high',
  budgetMb = 0,
}: {
  decision?: MemoryFitDecision;
  confidence?: MemoryFitResult['confidence'];
  budgetMb?: number;
} = {}): MemoryFitResult {
  const promptStateCacheBytes = budgetMb * MIB;
  const effectiveBudgetBytes = 1_000 * MIB;
  const requiredBytes = decision === 'likely_oom'
    ? 1_300 * MIB
    : decision === 'borderline'
      ? 1_100 * MIB
      : decision === 'unknown'
        ? 0
        : decision === 'fits_low_confidence'
          ? 800 * MIB
          : 500 * MIB + promptStateCacheBytes;

  return {
    decision,
    confidence,
    requiredBytes,
    effectiveBudgetBytes,
    breakdown: {
      weightsBytes: 200 * MIB,
      kvCacheBytes: 50 * MIB,
      promptStateCacheBytes,
      computeBytes: 50 * MIB,
      multimodalBytes: 0,
      overheadBytes: 50 * MIB,
      safetyMarginBytes: 150 * MIB,
    },
    budget: {
      totalMemoryBytes: 8_000 * MIB,
      effectiveBudgetBytes,
    },
    recommendations: [],
  };
}

function resolvePolicy(overrides: Partial<Parameters<typeof resolvePromptStateCachePolicy>[0]> = {}) {
  return resolvePromptStateCachePolicy({
    ggufMetadata: { 'general.architecture': 'mamba' },
    backendMode: 'cpu',
    baseMemoryFit: createMemoryFit(),
    lowMemory: false,
    pressureLevel: 'normal',
    allowAdditionalMemory: true,
    estimateCandidateMemoryFit: (budgetMb) => createMemoryFit({ budgetMb }),
    ...overrides,
  });
}

describe('PromptStateCachePolicy', () => {
  it.each([
    ['mamba', 'cpu'],
    ['rwkv7', 'gpu'],
    ['jamba', 'npu'],
    ['qwen3next', 'gpu'],
  ] as const)('keeps eligible %s fail-closed on %s even with ample memory', (
    architecture,
    backendMode,
  ) => {
    const estimateCandidateMemoryFit = jest.fn(
      (budgetMb: number) => createMemoryFit({ budgetMb }),
    );
    const policy = resolvePolicy({
      ggufMetadata: { 'general.architecture': architecture },
      backendMode,
      estimateCandidateMemoryFit,
    });

    expect(ENABLE_NONZERO_PROMPT_STATE_CACHE).toBe(false);
    expect(policy).toEqual(expect.objectContaining({
      budgetMb: 0,
      maxCheckpoints: PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
      enabled: false,
      eligibility: 'eligible',
      reason: 'native_memory_bound_unverified',
      policyVersion: PROMPT_STATE_CACHE_POLICY_VERSION,
      architecture,
      backendMode,
      evaluatedBudgetsMb: [],
    }));
    expect(policy.finalMemoryFit?.breakdown.promptStateCacheBytes).toBe(0);
    expect(estimateCandidateMemoryFit).not.toHaveBeenCalled();
  });

  it.each([
    ['borderline', 'base_fit_borderline'],
    ['likely_oom', 'base_fit_likely_oom'],
    ['unknown', 'base_fit_unknown'],
  ] as const)('disables cache for a %s base fit', (decision, reason) => {
    expect(resolvePolicy({
      baseMemoryFit: createMemoryFit({ decision }),
    })).toEqual(expect.objectContaining({
      budgetMb: 0,
      enabled: false,
      reason,
    }));
  });

  it.each([
    createMemoryFit({ confidence: 'medium' }),
    createMemoryFit({ decision: 'fits_low_confidence', confidence: 'high' }),
  ])('requires a high-confidence, high-headroom accurate base fit', (baseMemoryFit) => {
    expect(resolvePolicy({ baseMemoryFit })).toEqual(expect.objectContaining({
      budgetMb: 0,
      enabled: false,
      reason: 'insufficient_confidence',
    }));
  });

  it('disables cache on low-memory and critical-pressure signals', () => {
    expect(resolvePolicy({ lowMemory: true })).toEqual(expect.objectContaining({
      budgetMb: 0,
      reason: 'low_memory',
    }));
    expect(resolvePolicy({ pressureLevel: 'critical' })).toEqual(expect.objectContaining({
      budgetMb: 0,
      reason: 'critical_memory_pressure',
    }));
  });

  it('respects a safe-load decision that forbids optional memory', () => {
    expect(resolvePolicy({ allowAdditionalMemory: false })).toEqual(expect.objectContaining({
      budgetMb: 0,
      enabled: false,
      reason: 'safe_load_restricted',
    }));
  });

  it('distinguishes pure attention, pure SWA, and unknown architectures', () => {
    expect(resolvePolicy({
      ggufMetadata: { 'general.architecture': 'llama' },
    })).toEqual(expect.objectContaining({
      budgetMb: 0,
      eligibility: 'ineligible',
      reason: 'architecture_ineligible',
    }));
    expect(resolvePolicy({
      ggufMetadata: {
        'general.architecture': 'llama',
        'llama.attention.sliding_window': 4096,
      },
    })).toEqual(expect.objectContaining({
      budgetMb: 0,
      eligibility: 'ineligible',
      reason: 'pure_swa_ineligible',
    }));
    expect(resolvePolicy({
      ggufMetadata: { 'general.architecture': 'future-model-architecture' },
    })).toEqual(expect.objectContaining({
      budgetMb: 0,
      eligibility: 'unknown',
      reason: 'architecture_unknown',
    }));
  });

  it.each([
    ['mamba2', 'npu', undefined],
    ['granitehybrid', 'npu', ['HTP0']],
    ['mamba2', 'gpu', ['Hexagon accelerator']],
  ] as const)('disables %s state restore on Hexagon/HTP profiles', (
    architecture,
    backendMode,
    backendDevices,
  ) => {
    expect(resolvePolicy({
      ggufMetadata: { 'general.architecture': architecture },
      backendMode,
      backendDevices,
    })).toEqual(expect.objectContaining({
      budgetMb: 0,
      enabled: false,
      eligibility: 'ineligible',
      reason: 'unsupported_backend_architecture',
    }));
  });

  it('does not classify all Qwen architectures as hybrid', () => {
    expect(resolvePolicy({
      ggufMetadata: { 'general.architecture': 'qwen2' },
    })).toEqual(expect.objectContaining({
      budgetMb: 0,
      reason: 'architecture_ineligible',
    }));
    expect(resolvePolicy({
      ggufMetadata: { 'general.architecture': 'qwen3next' },
    })).toEqual(expect.objectContaining({
      budgetMb: 0,
      enabled: false,
      reason: 'native_memory_bound_unverified',
    }));
  });
});
