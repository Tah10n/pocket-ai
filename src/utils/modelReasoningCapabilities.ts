import type { ModelMetadata } from '@/types/models';
import type { ReasoningEffort, ResolvedReasoningEffort } from '@/types/reasoning';

type ReasoningModelMetadata = Pick<
  ModelMetadata,
  'id' | 'name' | 'modelType' | 'architectures' | 'baseModels' | 'tags'
>;

export interface ModelReasoningCapability {
  supportsReasoning: boolean;
  requiresReasoning: boolean;
  autoEffort: ResolvedReasoningEffort;
  preferredReasoningFormat: 'auto' | 'deepseek';
}

export interface ReasoningRuntimeConfig {
  selectedEffort: ReasoningEffort;
  effectiveEffort: ResolvedReasoningEffort;
  enableThinking: boolean;
  reasoningFormat: 'none' | 'auto' | 'deepseek';
  thinkingBudgetTokens: number;
  responseReserveTokens: number;
}

const REQUIRED_REASONING_PATTERNS = [
  /deepseek[\s/_-]?r1/i,
  /(^|[\s/_-])qwq($|[\s/_-])/i,
  /(^|[\s/_-])r1($|[\s/_-])/i,
  /\breasoner\b/i,
  /\breasoning[-\s]?model\b/i,
  /\bthinking[-\s]?model\b/i,
];

const DEEPSEEK_REASONING_FORMAT_PATTERNS = [
  /deepseek[\s/_-]?r1/i,
];

const SUPPORTED_REASONING_PATTERNS = [
  /\breasoning\b/i,
  /\bthinking\b/i,
  /\breasoner\b/i,
  /qwen3/i,
  /deepseek[\s/_-]?r1/i,
  /(^|[\s/_-])qwq($|[\s/_-])/i,
  /(^|[\s/_-])r1($|[\s/_-])/i,
];

const AUTO_ENABLED_REASONING_PATTERNS = [
  /\breasoning\b/i,
  /\bthinking\b/i,
  /\breasoner\b/i,
  /deepseek[\s/_-]?r1/i,
  /(^|[\s/_-])qwq($|[\s/_-])/i,
  /(^|[\s/_-])r1($|[\s/_-])/i,
];

const GENERIC_MODEL_TAGS = new Set(['gguf', 'chat']);
const KNOWN_NON_REASONING_MODEL_TYPES = new Set(['gemma2', 'llama']);
const VALID_REASONING_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(['off', 'auto', 'low', 'medium', 'high']);
const REASONING_BUDGET_SPECS: Record<Exclude<ResolvedReasoningEffort, 'off'>, {
  ratio: number;
  min: number;
  max: number;
}> = {
  low: {
    ratio: 0.25,
    min: 64,
    max: 128,
  },
  medium: {
    ratio: 0.75,
    min: 160,
    max: 384,
  },
  high: {
    ratio: 1.5,
    min: 256,
    max: 768,
  },
};

function collectReasoningSources(
  model: ReasoningModelMetadata | undefined,
  fallbackLabels: (string | null | undefined)[],
): string[] {
  if (!model) {
    return fallbackLabels.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  return [
    model.id,
    model.name,
    model.modelType,
    ...(model.architectures ?? []),
    ...(model.baseModels ?? []),
    ...(model.tags ?? []),
    ...fallbackLabels,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function hasStructuredReasoningMetadata(model: ReasoningModelMetadata | undefined): boolean {
  if (!model) {
    return false;
  }

  const normalizedModelType = typeof model.modelType === 'string'
    ? model.modelType.trim().toLowerCase()
    : '';
  if (normalizedModelType && KNOWN_NON_REASONING_MODEL_TYPES.has(normalizedModelType)) {
    return true;
  }

  if (Array.isArray(model.architectures) && model.architectures.length > 0) {
    return true;
  }

  if (Array.isArray(model.baseModels) && model.baseModels.length > 0) {
    return true;
  }

  if (Array.isArray(model.tags) && model.tags.length > 0) {
    const hasNonGenericTag = model.tags.some((tag) => {
      const normalized = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
      return normalized.length > 0 && !GENERIC_MODEL_TAGS.has(normalized);
    });
    return hasNonGenericTag;
  }

  return false;
}

function matchesAnyPattern(sources: string[], patterns: RegExp[]): boolean {
  return patterns.some((pattern) => sources.some((source) => pattern.test(source)));
}

function resolveThinkingBudgetTokens(maxTokens: number, effectiveEffort: ResolvedReasoningEffort): number {
  if (effectiveEffort === 'off') {
    return 0;
  }

  const spec = REASONING_BUDGET_SPECS[effectiveEffort];
  const visibleBudget = Math.max(1, Math.round(maxTokens));
  const scaledBudget = Math.round(visibleBudget * spec.ratio);

  return Math.min(spec.max, Math.max(spec.min, scaledBudget));
}

export function resolveModelReasoningCapability(
  model: ReasoningModelMetadata | undefined,
  ...fallbackLabels: (string | null | undefined)[]
): ModelReasoningCapability {
  const sources = collectReasoningSources(model, fallbackLabels);

  const preferredReasoningFormat = matchesAnyPattern(sources, DEEPSEEK_REASONING_FORMAT_PATTERNS)
    ? 'deepseek' as const
    : 'auto' as const;

  if (sources.length === 0) {
    return {
      supportsReasoning: false,
      requiresReasoning: false,
      autoEffort: 'off',
      preferredReasoningFormat,
    };
  }

  const requiresReasoning = matchesAnyPattern(sources, REQUIRED_REASONING_PATTERNS);
  const supportsFromPatterns = matchesAnyPattern(sources, SUPPORTED_REASONING_PATTERNS);
  const autoEnabledFromPatterns = requiresReasoning || matchesAnyPattern(sources, AUTO_ENABLED_REASONING_PATTERNS);
  const supportsReasoning = requiresReasoning || supportsFromPatterns;

  if (!supportsReasoning && !hasStructuredReasoningMetadata(model)) {
    return {
      supportsReasoning: false,
      requiresReasoning: false,
      autoEffort: 'off',
      preferredReasoningFormat,
    };
  }

  return {
    supportsReasoning,
    requiresReasoning,
    autoEffort: supportsReasoning && autoEnabledFromPatterns ? 'medium' : 'off',
    preferredReasoningFormat,
  };
}

export function clampReasoningEffort(
  reasoningEffort: ReasoningEffort | undefined,
  capability: ModelReasoningCapability,
): ReasoningEffort {
  if (!capability.supportsReasoning) {
    return 'auto';
  }

  const normalized = reasoningEffort && VALID_REASONING_EFFORTS.has(reasoningEffort)
    ? reasoningEffort
    : 'auto';

  if (capability.requiresReasoning && normalized === 'off') {
    return 'auto';
  }

  return normalized;
}

export function resolveEffectiveReasoningEffort(
  reasoningEffort: ReasoningEffort | undefined,
  capability: ModelReasoningCapability,
): ResolvedReasoningEffort {
  const selectedEffort = clampReasoningEffort(reasoningEffort, capability);

  if (!capability.supportsReasoning) {
    return 'off';
  }

  if (selectedEffort === 'auto') {
    return capability.autoEffort;
  }

  return selectedEffort;
}

export function resolveReasoningRuntimeConfig({
  reasoningEffort,
  capability,
  maxTokens,
}: {
  reasoningEffort: ReasoningEffort | undefined;
  capability: ModelReasoningCapability;
  maxTokens: number;
}): ReasoningRuntimeConfig {
  const selectedEffort = clampReasoningEffort(reasoningEffort, capability);
  const effectiveEffort = resolveEffectiveReasoningEffort(selectedEffort, capability);
  const thinkingBudgetTokens = resolveThinkingBudgetTokens(maxTokens, effectiveEffort);
  const enableThinking = effectiveEffort !== 'off';
  const visibleBudget = Math.max(1, Math.round(maxTokens));

  return {
    selectedEffort,
    effectiveEffort,
    enableThinking,
    reasoningFormat: enableThinking ? capability.preferredReasoningFormat : 'none',
    thinkingBudgetTokens,
    responseReserveTokens: visibleBudget + thinkingBudgetTokens,
  };
}

export function normalizeReasoningPreference<T extends { reasoningEffort?: ReasoningEffort }>(
  params: T,
  capability: ModelReasoningCapability,
): T {
  const nextReasoningEffort = clampReasoningEffort(params.reasoningEffort, capability);

  if (params.reasoningEffort === nextReasoningEffort) {
    return params;
  }

  return {
    ...params,
    reasoningEffort: nextReasoningEffort,
  };
}
