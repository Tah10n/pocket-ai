import type { ModelVariant } from '../types/models';

type ModelVariantDedupeOptions = {
  activeVariantId?: string;
  resolvedFileName?: string;
};

function normalizeIdentityValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function getVariantActiveRank(
  variant: ModelVariant,
  options: ModelVariantDedupeOptions,
): number {
  const activeVariantId = normalizeIdentityValue(options.activeVariantId);
  const resolvedFileName = normalizeIdentityValue(options.resolvedFileName);

  if (activeVariantId && variant.variantId === activeVariantId) {
    return 3;
  }

  if (activeVariantId && variant.fileName === activeVariantId) {
    return 2;
  }

  if (resolvedFileName && variant.fileName === resolvedFileName) {
    return 1;
  }

  return 0;
}

function getVariantCompletenessScore(variant: ModelVariant): number {
  return (variant.isLocal === true ? 16 : 0)
    + (variant.chatModalities?.includes('vision') ? 8 : 0)
    + (variant.chatModalities?.includes('audio') ? 8 : 0)
    + (variant.projectorCandidates?.length ? 4 : 0)
    + (variant.sha256 ? 4 : 0)
    + (typeof variant.size === 'number' ? 2 : 0)
    + (variant.ramFit ? 1 : 0)
    + (variant.ramFitConfidence ? 1 : 0);
}

function mergeVariantChatModalities(
  preferred: ModelVariant['chatModalities'],
  fallback: ModelVariant['chatModalities'],
): ModelVariant['chatModalities'] {
  const source = preferred ?? fallback;
  const modalities = [...new Set(source ?? [])];
  return modalities.length > 0 ? modalities : undefined;
}

function getNativeVariantModalities(variant: ModelVariant): Set<'vision' | 'audio'> {
  return new Set((variant.chatModalities ?? []).filter((modality): modality is 'vision' | 'audio' => modality !== 'text'));
}

function canUseFallbackProjectorMetadata(preferred: ModelVariant, fallback: ModelVariant): boolean {
  if (!Array.isArray(preferred.chatModalities)) {
    return true;
  }

  const preferredNativeModalities = getNativeVariantModalities(preferred);
  if (preferredNativeModalities.size === 0) {
    return false;
  }

  if (!Array.isArray(fallback.chatModalities)) {
    return preferredNativeModalities.has('vision');
  }

  const fallbackNativeModalities = getNativeVariantModalities(fallback);
  if (fallbackNativeModalities.size === 0) {
    return false;
  }

  return Array.from(fallbackNativeModalities).every((modality) => preferredNativeModalities.has(modality));
}

function canUseFallbackVisionMetadata(preferred: ModelVariant, fallback: ModelVariant): boolean {
  if (!Array.isArray(preferred.chatModalities)) {
    return true;
  }

  if (!preferred.chatModalities.includes('vision')) {
    return false;
  }

  return !Array.isArray(fallback.chatModalities) || fallback.chatModalities.includes('vision');
}

function mergeDedupeVariantMetadata(preferred: ModelVariant, fallback: ModelVariant): ModelVariant {
  const shouldUseFallbackProjectorMetadata = canUseFallbackProjectorMetadata(preferred, fallback);
  const shouldUseFallbackVisionMetadata = canUseFallbackVisionMetadata(preferred, fallback);

  return {
    ...preferred,
    size: preferred.size ?? fallback.size,
    sha256: preferred.sha256 ?? fallback.sha256,
    ramFit: preferred.ramFit ?? fallback.ramFit,
    ramFitConfidence: preferred.ramFitConfidence ?? fallback.ramFitConfidence,
    isLocal: preferred.isLocal ?? fallback.isLocal,
    chatModalities: mergeVariantChatModalities(preferred.chatModalities, fallback.chatModalities),
    artifactRole: preferred.artifactRole ?? fallback.artifactRole,
    visionSource: preferred.visionSource ?? (shouldUseFallbackVisionMetadata ? fallback.visionSource : undefined),
    visionConfidence: preferred.visionConfidence ?? (shouldUseFallbackVisionMetadata ? fallback.visionConfidence : undefined),
    projectorCandidates: preferred.projectorCandidates ?? (
      shouldUseFallbackProjectorMetadata ? fallback.projectorCandidates : undefined
    ),
    selectedProjectorId: preferred.selectedProjectorId ?? (
      shouldUseFallbackProjectorMetadata ? fallback.selectedProjectorId : undefined
    ),
  };
}

function shouldReplaceVariant(
  current: ModelVariant,
  candidate: ModelVariant,
  options: ModelVariantDedupeOptions,
): boolean {
  const currentActiveRank = getVariantActiveRank(current, options);
  const candidateActiveRank = getVariantActiveRank(candidate, options);
  if (candidateActiveRank !== currentActiveRank) {
    return candidateActiveRank > currentActiveRank;
  }

  return getVariantCompletenessScore(candidate) > getVariantCompletenessScore(current);
}

function dedupeModelVariantsByKey(
  variants: ModelVariant[],
  getKey: (variant: ModelVariant) => string | undefined,
  options: ModelVariantDedupeOptions,
): ModelVariant[] {
  const selectedIndexes = new Map<string, number>();
  const deduped: ModelVariant[] = [];

  variants.forEach((variant) => {
    const key = getKey(variant);
    if (!key) {
      deduped.push(variant);
      return;
    }

    const existingIndex = selectedIndexes.get(key);
    if (existingIndex === undefined) {
      selectedIndexes.set(key, deduped.length);
      deduped.push(variant);
      return;
    }

    const existingVariant = deduped[existingIndex];
    if (shouldReplaceVariant(existingVariant, variant, options)) {
      deduped[existingIndex] = mergeDedupeVariantMetadata(variant, existingVariant);
    } else {
      deduped[existingIndex] = mergeDedupeVariantMetadata(existingVariant, variant);
    }
  });

  return deduped;
}

export function dedupeModelVariantsByIdentity(
  variants: ModelVariant[],
  options: ModelVariantDedupeOptions = {},
): ModelVariant[] {
  const dedupedByFileName = dedupeModelVariantsByKey(
    variants,
    (variant) => normalizeIdentityValue(variant.fileName),
    options,
  );

  return dedupeModelVariantsByKey(
    dedupedByFileName,
    (variant) => normalizeIdentityValue(variant.variantId),
    options,
  );
}
