import type { ModelMetadata, ModelVariant } from '../types/models';

export type ActiveModelVariantInput = Partial<Pick<
  ModelMetadata,
  'activeVariantId' | 'resolvedFileName' | 'variants'
>>;

function normalizeVariantIdentity(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveActiveModelVariant(model: ActiveModelVariantInput): ModelVariant | undefined {
  const activeVariantId = normalizeVariantIdentity(model.activeVariantId);
  if (activeVariantId !== null) {
    // An exact variant id is authoritative over another variant whose filename
    // happens to equal that id. This mirrors the selection ranking contract.
    const activeVariant = model.variants?.find((variant) => variant.variantId === activeVariantId)
      ?? model.variants?.find((variant) => variant.fileName === activeVariantId);
    if (activeVariant) {
      return activeVariant;
    }
  }

  const resolvedFileName = normalizeVariantIdentity(model.resolvedFileName);
  return resolvedFileName === null
    ? undefined
    : model.variants?.find((variant) => variant.fileName === resolvedFileName)
      ?? model.variants?.find((variant) => variant.variantId === resolvedFileName);
}

export function getActiveModelVariantKeys(model: ActiveModelVariantInput): ReadonlySet<string> {
  const activeVariant = resolveActiveModelVariant(model);
  if (activeVariant) {
    return new Set([activeVariant.variantId, activeVariant.fileName]);
  }

  // Without a variant record there is no trustworthy evidence that two
  // different values are aliases. The explicit active id is authoritative;
  // treating a stale resolved file name as a second active key can leak Q4
  // runtime state into an incoming Q8 selection (and vice versa).
  const activeVariantId = normalizeVariantIdentity(model.activeVariantId);
  if (activeVariantId !== null) {
    return new Set([activeVariantId]);
  }

  const resolvedFileName = normalizeVariantIdentity(model.resolvedFileName);
  return resolvedFileName === null ? new Set() : new Set([resolvedFileName]);
}
