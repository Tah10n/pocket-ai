import type { ProjectorArtifact } from '../types/multimodal';
import type { ModelMetadata, ModelVariant } from '../types/models';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from './projectorRuntimeState';

type ProjectorArtifactSizeIdentity = Pick<ProjectorArtifact, 'size'> & Partial<Pick<ProjectorArtifact, 'id' | 'localPath'>>;
type ProjectorArtifactDisplayIdentity = ProjectorArtifactSizeIdentity & Partial<Pick<ProjectorArtifact, 'ownerVariantId'>>;
type ModelDisplayArtifactSizeInput = Pick<ModelMetadata, 'size' | 'projectorCandidates' | 'selectedProjectorId'> & Partial<Pick<
  ModelMetadata,
  'activeVariantId' | 'resolvedFileName' | 'variants'
>>;
type ModelDisplayProjectorCandidatesResult = {
  candidates: ModelMetadata['projectorCandidates'];
  runtimeToDisplayProjectorIds: Map<string, string>;
};

export const DECIMAL_GIGABYTE = 1000 * 1000 * 1000;
export const UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES = DECIMAL_GIGABYTE;

export function normalizePositiveByteSize(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

export function formatModelFileSize(
  value: number | null | undefined,
  unknownLabel: string,
): string {
  const normalizedValue = normalizePositiveByteSize(value);
  if (normalizedValue === null) {
    return unknownLabel;
  }

  return `${(normalizedValue / DECIMAL_GIGABYTE).toFixed(2)} GB`;
}

export function isStoredProjectorArtifact(
  projector: Pick<ProjectorArtifact, 'lifecycleStatus'>,
): boolean {
  return projector.lifecycleStatus === 'downloaded' || projector.lifecycleStatus === 'active';
}

export function hasTrackableProjectorLocalFile(
  projector: Pick<ProjectorArtifact, 'lifecycleStatus' | 'localPath'>,
): boolean {
  return (
    typeof projector.localPath === 'string'
    && projector.localPath.trim().length > 0
    && (
      projector.lifecycleStatus === 'downloaded'
      || projector.lifecycleStatus === 'active'
      || projector.lifecycleStatus === 'downloading'
      || projector.lifecycleStatus === 'paused'
      || projector.lifecycleStatus === 'failed'
    )
  );
}

function getProjectorArtifactIdentity(projector: Partial<Pick<ProjectorArtifact, 'id' | 'localPath'>>, fallbackIndex: number): string {
  return typeof projector.localPath === 'string' && projector.localPath.trim().length > 0
    ? `path:${projector.localPath.trim()}`
    : `id:${projector.id ?? `anonymous:${fallbackIndex}`}`;
}

function sumUniqueProjectorArtifactSizes(
  projectors: readonly ProjectorArtifactSizeIdentity[],
  options: { includeUnknownSizeFallback?: boolean } = {},
): number {
  const seen = new Set<string>();
  return projectors.reduce((sum, projector, index) => {
    const identity = getProjectorArtifactIdentity(projector, index);
    if (seen.has(identity)) {
      return sum;
    }

    seen.add(identity);
    const size = normalizePositiveByteSize(projector.size);
    if (size === null) {
      return options.includeUnknownSizeFallback === true
        ? sum + UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES
        : sum;
    }

    return sum + size;
  }, 0);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveActiveVariant(
  model: Pick<ModelDisplayArtifactSizeInput, 'activeVariantId' | 'resolvedFileName' | 'variants'>,
): ModelVariant | undefined {
  const variants = model.variants ?? [];
  if (variants.length === 0) {
    return undefined;
  }

  const activeVariantId = normalizeOptionalString(model.activeVariantId);
  const resolvedFileName = normalizeOptionalString(model.resolvedFileName);

  return variants.find((variant) => activeVariantId !== null && variant.variantId === activeVariantId)
    ?? variants.find((variant) => resolvedFileName !== null && variant.fileName === resolvedFileName)
    ?? variants[0];
}

function getVariantIdentityKeys(
  model: ModelDisplayArtifactSizeInput,
  activeVariant: ModelVariant | undefined,
): Set<string> {
  return new Set([
    normalizeOptionalString(model.activeVariantId),
    normalizeOptionalString(model.resolvedFileName),
    normalizeOptionalString(activeVariant?.variantId),
    normalizeOptionalString(activeVariant?.fileName),
  ].filter((value): value is string => value !== null));
}

function isProjectorCompatibleWithVariant(
  projector: ProjectorArtifactDisplayIdentity,
  activeVariantKeys: Set<string>,
): boolean {
  const ownerVariantId = normalizeOptionalString(projector.ownerVariantId);
  return ownerVariantId === null || activeVariantKeys.size === 0 || activeVariantKeys.has(ownerVariantId);
}

function resolveActiveVariantProjectorRuntimeScopeKey(
  model: ModelDisplayArtifactSizeInput,
  activeVariant: ModelVariant,
): string | undefined {
  return normalizeOptionalString(activeVariant.variantId)
    ?? normalizeOptionalString(activeVariant.fileName)
    ?? normalizeOptionalString(model.activeVariantId)
    ?? normalizeOptionalString(model.resolvedFileName)
    ?? undefined;
}

function filterProjectorsForActiveVariant(
  candidates: ModelMetadata['projectorCandidates'],
  model: ModelDisplayArtifactSizeInput,
  activeVariant: ModelVariant | undefined,
): ModelMetadata['projectorCandidates'] {
  if (!activeVariant || !candidates || candidates.length === 0) {
    return candidates;
  }

  const activeVariantKeys = getVariantIdentityKeys(model, activeVariant);
  return candidates.filter((projector) => isProjectorCompatibleWithVariant(projector, activeVariantKeys));
}

function resolveModelDisplayProjectorCandidates(
  model: ModelDisplayArtifactSizeInput,
  projectorCandidates?: ModelMetadata['projectorCandidates'],
): ModelDisplayProjectorCandidatesResult {
  const activeVariant = resolveActiveVariant(model);
  const emptyIdMap = new Map<string, string>();

  if (projectorCandidates) {
    const mergedProjectorIds = activeVariant && model.projectorCandidates?.length
      ? mergeProjectorCandidatesWithRuntimeStateAndIdMap(
        projectorCandidates,
        model.projectorCandidates,
        { activeVariantId: resolveActiveVariantProjectorRuntimeScopeKey(model, activeVariant) },
      ).runtimeToNextProjectorIds
      : emptyIdMap;

    return {
      candidates: filterProjectorsForActiveVariant(projectorCandidates, model, activeVariant),
      runtimeToDisplayProjectorIds: mergedProjectorIds,
    };
  }

  if (activeVariant?.projectorCandidates?.length) {
    const mergedProjectors = mergeProjectorCandidatesWithRuntimeStateAndIdMap(
      activeVariant.projectorCandidates,
      model.projectorCandidates,
      { activeVariantId: resolveActiveVariantProjectorRuntimeScopeKey(model, activeVariant) },
    );

    return {
      candidates: filterProjectorsForActiveVariant(
        mergedProjectors.projectorCandidates ?? activeVariant.projectorCandidates,
        model,
        activeVariant,
      ),
      runtimeToDisplayProjectorIds: mergedProjectors.runtimeToNextProjectorIds,
    };
  }

  return {
    candidates: filterProjectorsForActiveVariant(model.projectorCandidates, model, activeVariant),
    runtimeToDisplayProjectorIds: emptyIdMap,
  };
}

export function getModelDisplayProjectorCandidates(
  model: ModelDisplayArtifactSizeInput,
  projectorCandidates?: ModelMetadata['projectorCandidates'],
): ModelMetadata['projectorCandidates'] {
  return resolveModelDisplayProjectorCandidates(model, projectorCandidates).candidates;
}

function resolveDisplaySelectedProjectorId(
  model: ModelDisplayArtifactSizeInput,
  candidates: ModelMetadata['projectorCandidates'],
  selectedProjectorId?: string,
  runtimeToDisplayProjectorIds: Map<string, string> = new Map(),
): string | undefined {
  const activeVariant = resolveActiveVariant(model);
  if (!activeVariant) {
    const normalizedSelectedProjectorId = normalizeOptionalString(selectedProjectorId ?? model.selectedProjectorId);
    return normalizedSelectedProjectorId
      ? runtimeToDisplayProjectorIds.get(normalizedSelectedProjectorId) ?? normalizedSelectedProjectorId
      : undefined;
  }

  const activeVariantSelectedProjectorId = normalizeOptionalString(activeVariant.selectedProjectorId);
  const activeVariantKeys = getVariantIdentityKeys(model, activeVariant);
  if (activeVariantSelectedProjectorId !== null) {
    const activeVariantSelectedProjector = candidates?.find((projector) => projector.id === activeVariantSelectedProjectorId);
    if (
      activeVariantSelectedProjector
      && isProjectorCompatibleWithVariant(activeVariantSelectedProjector, activeVariantKeys)
    ) {
      return activeVariantSelectedProjectorId;
    }
  }

  const normalizedRuntimeSelectedProjectorId = normalizeOptionalString(selectedProjectorId ?? model.selectedProjectorId);
  if (normalizedRuntimeSelectedProjectorId === null) {
    return undefined;
  }

  const normalizedSelectedProjectorId = runtimeToDisplayProjectorIds.get(normalizedRuntimeSelectedProjectorId)
    ?? normalizedRuntimeSelectedProjectorId;
  const selectedProjector = candidates?.find((projector) => projector.id === normalizedSelectedProjectorId);
  return selectedProjector && isProjectorCompatibleWithVariant(selectedProjector, activeVariantKeys)
    ? normalizedSelectedProjectorId
    : undefined;
}

export function getModelDisplaySelectedProjectorId(
  model: ModelDisplayArtifactSizeInput,
  projectorCandidates?: ModelMetadata['projectorCandidates'],
): ModelMetadata['selectedProjectorId'] {
  const displayProjectors = resolveModelDisplayProjectorCandidates(model, projectorCandidates);
  return resolveDisplaySelectedProjectorId(
    model,
    displayProjectors.candidates,
    undefined,
    displayProjectors.runtimeToDisplayProjectorIds,
  );
}

export function getProjectorArtifactsSizeBytes(
  projectors: readonly Pick<ProjectorArtifact, 'size'>[] | null | undefined,
): number {
  return (projectors ?? []).reduce(
    (sum, projector) => sum + (normalizePositiveByteSize(projector.size) ?? 0),
    0,
  );
}

export function getStoredProjectorArtifactsSizeBytes(
  projectors: readonly (ProjectorArtifactSizeIdentity & Pick<ProjectorArtifact, 'lifecycleStatus'>)[] | null | undefined,
): number {
  return sumUniqueProjectorArtifactSizes((projectors ?? []).filter(isStoredProjectorArtifact));
}

export function getStoredProjectorMemoryFitSizeBytes(
  projectors: readonly (ProjectorArtifactSizeIdentity & Pick<ProjectorArtifact, 'lifecycleStatus'>)[] | null | undefined,
): number {
  return sumUniqueProjectorArtifactSizes((projectors ?? []).filter(isStoredProjectorArtifact), {
    includeUnknownSizeFallback: true,
  });
}

export function getProjectorMemoryFitSizeBytes(
  projectors: readonly (ProjectorArtifactSizeIdentity & Pick<ProjectorArtifact, 'lifecycleStatus' | 'matchStatus'>)[] | null | undefined,
  selectedProjectorId?: string,
  options: { includeUnknownSizeFallback?: boolean } = { includeUnknownSizeFallback: true },
): number {
  const candidates = projectors ?? [];
  const normalizedSelectedProjectorId = typeof selectedProjectorId === 'string' && selectedProjectorId.trim().length > 0
    ? selectedProjectorId.trim()
    : undefined;
  const selectedProjector = normalizedSelectedProjectorId
    ? candidates.find((projector) => projector.id === normalizedSelectedProjectorId)
    : undefined;
  if (selectedProjector) {
    return sumUniqueProjectorArtifactSizes([selectedProjector], options);
  }

  const selectedProjectors = candidates.filter((projector) => projector.matchStatus === 'user_selected');
  if (selectedProjectors.length > 0) {
    return sumUniqueProjectorArtifactSizes(selectedProjectors, options);
  }

  const storedProjectors = candidates.filter(isStoredProjectorArtifact);
  if (storedProjectors.length > 0) {
    return sumUniqueProjectorArtifactSizes(storedProjectors, options);
  }

  const matchedProjectors = candidates.filter((projector) => projector.matchStatus === 'matched');
  if (matchedProjectors.length === 1) {
    return sumUniqueProjectorArtifactSizes(matchedProjectors, options);
  }

  return 0;
}

export function getModelStoredArtifactsSizeBytes(
  model: Pick<ModelMetadata, 'size' | 'projectorCandidates'>,
): number {
  return (normalizePositiveByteSize(model.size) ?? 0)
    + getStoredProjectorArtifactsSizeBytes(model.projectorCandidates);
}

export function getModelStoredMemoryFitSizeBytes(
  model: Pick<ModelMetadata, 'size' | 'projectorCandidates'>,
): number | null {
  const normalizedModelSize = normalizePositiveByteSize(model.size);
  if (normalizedModelSize === null) {
    return null;
  }

  return normalizedModelSize + getStoredProjectorMemoryFitSizeBytes(model.projectorCandidates);
}

export function getModelDisplayArtifactSizeBytes(
  model: ModelDisplayArtifactSizeInput,
  baseSizeBytes?: number | null,
  projectorCandidates?: ModelMetadata['projectorCandidates'],
  selectedProjectorId?: ModelMetadata['selectedProjectorId'],
): number | null {
  const activeVariant = resolveActiveVariant(model);
  const resolvedBaseSizeBytes = baseSizeBytes !== undefined
    ? baseSizeBytes
    : (activeVariant?.size ?? model.size);
  const normalizedBaseSize = normalizePositiveByteSize(
    resolvedBaseSizeBytes,
  );
  if (normalizedBaseSize === null) {
    return null;
  }

  const displayProjectors = resolveModelDisplayProjectorCandidates(model, projectorCandidates);
  const displaySelectedProjectorId = resolveDisplaySelectedProjectorId(
    model,
    displayProjectors.candidates,
    selectedProjectorId,
    displayProjectors.runtimeToDisplayProjectorIds,
  );

  return normalizedBaseSize + getProjectorMemoryFitSizeBytes(displayProjectors.candidates, displaySelectedProjectorId, {
    includeUnknownSizeFallback: false,
  });
}
