import type { ContextParams } from 'llama.rn';
import type { MemoryFitResult } from '../memory/types';
import type { MemoryPressureLevel } from './SystemMetricsService';

export const DISABLED_PROMPT_STATE_CACHE_BUDGET_MB = 0;
export const LOW_PROMPT_STATE_CACHE_BUDGET_MB = 64;
export const MEDIUM_PROMPT_STATE_CACHE_BUDGET_MB = 128;
export const MAXIMUM_PROMPT_STATE_CACHE_BUDGET_MB = 160;
export const PROMPT_STATE_CACHE_MAX_CHECKPOINTS = 8;
export const PROMPT_STATE_CACHE_POLICY_VERSION = 2;
export const ENABLE_NONZERO_PROMPT_STATE_CACHE = false;

export const PROMPT_STATE_CACHE_CANDIDATE_BUDGETS_MB = Object.freeze([
  MAXIMUM_PROMPT_STATE_CACHE_BUDGET_MB,
  MEDIUM_PROMPT_STATE_CACHE_BUDGET_MB,
  LOW_PROMPT_STATE_CACHE_BUDGET_MB,
] as const);

export type ExplicitPromptStateCacheContextParams = Required<
  Pick<ContextParams, 'state_cache_budget_mb' | 'state_cache_max_checkpoints'>
>;

export type PromptStateCacheBackendMode = 'cpu' | 'gpu' | 'npu' | 'unknown';
export type PromptStateCacheEligibility = 'eligible' | 'ineligible' | 'unknown';
export type PromptStateCachePolicyReason =
  | 'maximum_safe_budget'
  | 'reduced_to_memory_fit'
  | 'no_safe_budget'
  | 'architecture_ineligible'
  | 'pure_swa_ineligible'
  | 'architecture_unknown'
  | 'unsupported_backend_architecture'
  | 'low_memory'
  | 'critical_memory_pressure'
  | 'base_fit_borderline'
  | 'base_fit_likely_oom'
  | 'base_fit_unknown'
  | 'insufficient_confidence'
  | 'safe_load_restricted'
  | 'memory_estimate_failed'
  | 'native_memory_bound_unverified';

export interface PromptStateCachePolicy {
  budgetMb: number;
  maxCheckpoints: number;
  enabled: boolean;
  eligibility: PromptStateCacheEligibility;
  reason: PromptStateCachePolicyReason;
  policyVersion: number;
  architecture: string | null;
  backendMode: PromptStateCacheBackendMode;
  finalMemoryFit: MemoryFitResult | null;
  evaluatedBudgetsMb: number[];
  source: 'runtime_accurate_memory_fit';
}

export const DISABLED_PROMPT_STATE_CACHE_CONTEXT_PARAMS: ExplicitPromptStateCacheContextParams =
  Object.freeze({
    state_cache_budget_mb: DISABLED_PROMPT_STATE_CACHE_BUDGET_MB,
    state_cache_max_checkpoints: PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
  });

// These mappings mirror llama.cpp's llm_arch_is_recurrent() and
// llm_arch_is_hybrid() predicates bundled by llama.rn 0.12.7. Keep the
// eligibility decision tied to GGUF architecture metadata, never model names.
const RECURRENT_PROMPT_STATE_CACHE_ARCHITECTURES = new Set([
  'mamba',
  'mamba2',
  'rwkv6',
  'rwkv6qwen2',
  'rwkv7',
  'arwkv7',
]);

const HYBRID_PROMPT_STATE_CACHE_ARCHITECTURES = new Set([
  'jamba',
  'falcon-h1',
  'plamo2',
  'granitehybrid',
  'lfm2',
  'lfm2moe',
  'nemotron_h',
  'nemotron_h_moe',
  'qwen3next',
  'kimi-linear',
  'qwen35',
  'qwen35moe',
]);

// Exact architecture identifiers known by the llama.cpp revision bundled in
// llama.rn 0.12.7, excluding the recurrent/hybrid allowlists above.
const KNOWN_INELIGIBLE_PROMPT_STATE_CACHE_ARCHITECTURES = new Set([
  'clip',
  'llama',
  'llama4',
  'deci',
  'falcon',
  'grok',
  'gpt2',
  'gptj',
  'gptneox',
  'mpt',
  'baichuan',
  'starcoder',
  'refact',
  'bert',
  'modern-bert',
  'nomic-bert',
  'nomic-bert-moe',
  'neo-bert',
  'jina-bert-v2',
  'jina-bert-v3',
  'eurobert',
  'bloom',
  'stablelm',
  'qwen',
  'qwen2',
  'qwen2moe',
  'qwen2vl',
  'qwen3',
  'qwen3moe',
  'qwen3vl',
  'qwen3vlmoe',
  'phi2',
  'phi3',
  'phimoe',
  'plamo',
  'plamo3',
  'codeshell',
  'orion',
  'internlm2',
  'minicpm',
  'minicpm3',
  'gemma',
  'gemma2',
  'gemma3',
  'gemma3n',
  'gemma4',
  'gemma4-assistant',
  'gemma-embedding',
  'starcoder2',
  'xverse',
  'command-r',
  'cohere2',
  'cohere2moe',
  'dbrx',
  'olmo',
  'olmo2',
  'olmoe',
  'openelm',
  'arctic',
  'deepseek',
  'deepseek2',
  'deepseek2-ocr',
  'deepseek32',
  'deepseek4',
  'chatglm',
  'glm4',
  'glm4moe',
  'glm-dsa',
  'bitnet',
  't5',
  't5encoder',
  'jais',
  'jais2',
  'nemotron',
  'exaone',
  'exaone4',
  'exaone-moe',
  'granite',
  'granitemoe',
  'chameleon',
  'wavtokenizer-dec',
  'plm',
  'bailingmoe',
  'bailingmoe2',
  'dots1',
  'arcee',
  'afmoe',
  'ernie4_5',
  'ernie4_5-moe',
  'hunyuan-moe',
  'hunyuan-dense',
  'hunyuan_vl',
  'hy_v3',
  'smollm3',
  'gpt-oss',
  'dream',
  'smallthinker',
  'llada',
  'llada-moe',
  'seed_oss',
  'grovemoe',
  'apertus',
  'minimax-m2',
  'cogvlm',
  'rnd1',
  'pangu-embedded',
  'mistral3',
  'eagle3',
  'dflash',
  'mistral4',
  'paddleocr',
  'mimo2',
  'step35',
  'llama-embed',
  'maincoder',
  'talkie',
  'mellum',
]);

function normalizeArchitecture(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function resolvePromptStateCacheArchitecture(
  ggufMetadata?: Record<string, unknown>,
): string | null {
  if (!ggufMetadata) {
    return null;
  }

  return normalizeArchitecture(ggufMetadata.architecture)
    ?? normalizeArchitecture(ggufMetadata['general.architecture']);
}

function hasPositiveNumericMetadataValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  }

  return false;
}

function hasSlidingWindowMetadata(
  architecture: string,
  ggufMetadata: Record<string, unknown> | undefined,
): boolean {
  if (!ggufMetadata) {
    return false;
  }

  return [
    'sliding_window',
    'attention.sliding_window',
    `${architecture}.attention.sliding_window`,
    `${architecture}.attention.sliding_window_pattern`,
  ].some((key) => hasPositiveNumericMetadataValue(ggufMetadata[key]));
}

function isUnsupportedBackendArchitecture(
  architecture: string,
  backendMode: PromptStateCacheBackendMode,
  backendDevices: readonly string[] | undefined,
): boolean {
  const hasHexagonOrHtpDevice = backendDevices?.some((device) => (
    typeof device === 'string' && /(?:htp|hexagon)/i.test(device)
  )) === true;
  const usesHexagonOrHtp = backendMode === 'npu' || hasHexagonOrHtpDevice;

  return usesHexagonOrHtp
    && (architecture === 'mamba2' || architecture === 'granitehybrid');
}

function isSafePromptStateCacheFit(fit: MemoryFitResult): boolean {
  return (
    fit.decision === 'fits_high_confidence'
    && fit.confidence === 'high'
    && Number.isFinite(fit.requiredBytes)
    && fit.requiredBytes > 0
    && Number.isFinite(fit.effectiveBudgetBytes)
    && fit.effectiveBudgetBytes > 0
    && fit.requiredBytes <= fit.effectiveBudgetBytes
  );
}

function buildDisabledPolicy({
  architecture,
  backendMode,
  eligibility,
  reason,
  finalMemoryFit,
  evaluatedBudgetsMb = [],
}: {
  architecture: string | null;
  backendMode: PromptStateCacheBackendMode;
  eligibility: PromptStateCacheEligibility;
  reason: PromptStateCachePolicyReason;
  finalMemoryFit: MemoryFitResult | null;
  evaluatedBudgetsMb?: number[];
}): PromptStateCachePolicy {
  return {
    budgetMb: DISABLED_PROMPT_STATE_CACHE_BUDGET_MB,
    maxCheckpoints: PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
    enabled: false,
    eligibility,
    reason,
    policyVersion: PROMPT_STATE_CACHE_POLICY_VERSION,
    architecture,
    backendMode,
    finalMemoryFit,
    evaluatedBudgetsMb,
    source: 'runtime_accurate_memory_fit',
  };
}

export function resolvePromptStateCachePolicy({
  ggufMetadata,
  backendMode,
  backendDevices,
  baseMemoryFit,
  lowMemory,
  pressureLevel,
  allowAdditionalMemory,
  estimateCandidateMemoryFit,
}: {
  ggufMetadata?: Record<string, unknown>;
  backendMode: PromptStateCacheBackendMode;
  backendDevices?: readonly string[];
  baseMemoryFit: MemoryFitResult | null;
  lowMemory: boolean;
  pressureLevel: MemoryPressureLevel | null;
  allowAdditionalMemory: boolean;
  estimateCandidateMemoryFit: (budgetMb: number) => MemoryFitResult;
}): PromptStateCachePolicy {
  const architecture = resolvePromptStateCacheArchitecture(ggufMetadata);
  if (!architecture) {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'unknown',
      reason: 'architecture_unknown',
      finalMemoryFit: baseMemoryFit,
    });
  }

  const architectureEligible = RECURRENT_PROMPT_STATE_CACHE_ARCHITECTURES.has(architecture)
    || HYBRID_PROMPT_STATE_CACHE_ARCHITECTURES.has(architecture);
  if (!architectureEligible) {
    if (!KNOWN_INELIGIBLE_PROMPT_STATE_CACHE_ARCHITECTURES.has(architecture)) {
      return buildDisabledPolicy({
        architecture,
        backendMode,
        eligibility: 'unknown',
        reason: 'architecture_unknown',
        finalMemoryFit: baseMemoryFit,
      });
    }

    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'ineligible',
      reason: hasSlidingWindowMetadata(architecture, ggufMetadata)
        ? 'pure_swa_ineligible'
        : 'architecture_ineligible',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (isUnsupportedBackendArchitecture(architecture, backendMode, backendDevices)) {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'ineligible',
      reason: 'unsupported_backend_architecture',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (lowMemory) {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'low_memory',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (pressureLevel === 'critical') {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'critical_memory_pressure',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (!allowAdditionalMemory) {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'safe_load_restricted',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (!baseMemoryFit || baseMemoryFit.decision === 'unknown') {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'base_fit_unknown',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (baseMemoryFit.decision === 'borderline') {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'base_fit_borderline',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (baseMemoryFit.decision === 'likely_oom') {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'base_fit_likely_oom',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (!isSafePromptStateCacheFit(baseMemoryFit)) {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'insufficient_confidence',
      finalMemoryFit: baseMemoryFit,
    });
  }

  if (!ENABLE_NONZERO_PROMPT_STATE_CACHE) {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'native_memory_bound_unverified',
      finalMemoryFit: baseMemoryFit,
    });
  }

  const evaluatedBudgetsMb: number[] = [];
  let lastFit = baseMemoryFit;
  try {
    for (const budgetMb of PROMPT_STATE_CACHE_CANDIDATE_BUDGETS_MB) {
      evaluatedBudgetsMb.push(budgetMb);
      const candidateFit = estimateCandidateMemoryFit(budgetMb);
      lastFit = candidateFit;
      if (!isSafePromptStateCacheFit(candidateFit)) {
        continue;
      }

      return {
        budgetMb,
        maxCheckpoints: PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
        enabled: true,
        eligibility: 'eligible',
        reason: budgetMb === MAXIMUM_PROMPT_STATE_CACHE_BUDGET_MB
          ? 'maximum_safe_budget'
          : 'reduced_to_memory_fit',
        policyVersion: PROMPT_STATE_CACHE_POLICY_VERSION,
        architecture,
        backendMode,
        finalMemoryFit: candidateFit,
        evaluatedBudgetsMb,
        source: 'runtime_accurate_memory_fit',
      };
    }
  } catch {
    return buildDisabledPolicy({
      architecture,
      backendMode,
      eligibility: 'eligible',
      reason: 'memory_estimate_failed',
      finalMemoryFit: lastFit,
      evaluatedBudgetsMb,
    });
  }

  return buildDisabledPolicy({
    architecture,
    backendMode,
    eligibility: 'eligible',
    reason: 'no_safe_budget',
    finalMemoryFit: baseMemoryFit,
    evaluatedBudgetsMb,
  });
}

export function applyPromptStateCacheSafetyGate<T extends ContextParams>(
  params: T,
): T & ExplicitPromptStateCacheContextParams {
  return {
    ...params,
    state_cache_budget_mb: ENABLE_NONZERO_PROMPT_STATE_CACHE
      ? params.state_cache_budget_mb ?? DISABLED_PROMPT_STATE_CACHE_BUDGET_MB
      : DISABLED_PROMPT_STATE_CACHE_BUDGET_MB,
    state_cache_max_checkpoints: ENABLE_NONZERO_PROMPT_STATE_CACHE
      ? params.state_cache_max_checkpoints ?? PROMPT_STATE_CACHE_MAX_CHECKPOINTS
      : PROMPT_STATE_CACHE_MAX_CHECKPOINTS,
  };
}
