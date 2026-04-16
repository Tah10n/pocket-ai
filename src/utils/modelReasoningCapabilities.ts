import type { ModelMetadata } from '@/types/models';

type ReasoningModelMetadata = Pick<
  ModelMetadata,
  'id' | 'name' | 'modelType' | 'architectures' | 'baseModels' | 'tags'
>;

export interface ModelReasoningCapability {
  supportsReasoning: boolean;
  requiresReasoning: boolean;
}

const REQUIRED_REASONING_PATTERNS = [
  /deepseek[\s/_-]?r1/i,
  /(^|[\s/_-])qwq($|[\s/_-])/i,
  /(^|[\s/_-])r1($|[\s/_-])/i,
  /\breasoner\b/i,
  /\breasoning[-\s]?model\b/i,
  /\bthinking[-\s]?model\b/i,
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

const GENERIC_MODEL_TAGS = new Set(['gguf', 'chat']);
const KNOWN_NON_REASONING_MODEL_TYPES = new Set(['gemma2', 'llama']);

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

export function resolveModelReasoningCapability(
  model: ReasoningModelMetadata | undefined,
  ...fallbackLabels: (string | null | undefined)[]
): ModelReasoningCapability {
  const sources = collectReasoningSources(model, fallbackLabels);

  if (sources.length === 0) {
    return {
      supportsReasoning: true,
      requiresReasoning: false,
    };
  }

  const requiresReasoning = REQUIRED_REASONING_PATTERNS.some((pattern) => sources.some((source) => pattern.test(source)));
  const supportsFromPatterns = SUPPORTED_REASONING_PATTERNS.some((pattern) => sources.some((source) => pattern.test(source)));
  const supportsReasoning = requiresReasoning || supportsFromPatterns;

  if (!supportsReasoning && !hasStructuredReasoningMetadata(model)) {
    // If we don't have reliable metadata to classify the model, avoid force-disabling
    // reasoning. This preserves user preferences for custom / side-loaded models and
    // prevents silent clobbering when the registry entry is missing or incomplete.
    return {
      supportsReasoning: true,
      requiresReasoning: false,
    };
  }

  // If the model has structured metadata and we can't positively identify a reasoning-capable
  // family, default to disabling the dedicated reasoning stream to avoid enabling a feature
  // that many standard chat models won't support.

  return {
    supportsReasoning,
    requiresReasoning,
  };
}

export function clampReasoningEnabled(
  reasoningEnabled: boolean | undefined,
  capability: ModelReasoningCapability,
): boolean {
  if (capability.requiresReasoning) {
    return true;
  }

  if (!capability.supportsReasoning) {
    return false;
  }

  return reasoningEnabled === true;
}

export function normalizeReasoningPreference<T extends { reasoningEnabled?: boolean }>(
  params: T,
  capability: ModelReasoningCapability,
): T {
  const nextReasoningEnabled = clampReasoningEnabled(params.reasoningEnabled, capability);

  if (params.reasoningEnabled === nextReasoningEnabled) {
    return params;
  }

  return {
    ...params,
    reasoningEnabled: nextReasoningEnabled,
  };
}
