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
    + (variant.sha256 ? 4 : 0)
    + (typeof variant.size === 'number' ? 2 : 0)
    + (variant.ramFit ? 1 : 0)
    + (variant.ramFitConfidence ? 1 : 0);
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

    if (shouldReplaceVariant(deduped[existingIndex], variant, options)) {
      deduped[existingIndex] = variant;
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
