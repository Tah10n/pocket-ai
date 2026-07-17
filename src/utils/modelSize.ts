import type { ProjectorArtifact } from '../types/multimodal';
import type { ModelArtifactMetadata, ModelMetadata, ModelVariant } from '../types/models';
import { getActiveModelVariantKeys, resolveActiveModelVariant } from './activeModelVariant';
import {
  filterProjectorCandidatesForEffectiveActiveVariant,
  getEffectiveActiveVariantProjectorCandidates,
  remapProjectorIdToEffectiveCandidate,
} from './modelCapabilities';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from './projectorRuntimeState';
import { getSelectedMtpDraftArtifact } from './modelSpeculativeDecoding';

type ProjectorArtifactSizeIdentity = Pick<ProjectorArtifact, 'size'> & Partial<Pick<ProjectorArtifact, 'id' | 'localPath'>>;
type ProjectorArtifactDisplayIdentity = ProjectorArtifactSizeIdentity & Partial<Pick<ProjectorArtifact, 'ownerVariantId'>>;
type ModelDisplayArtifactSizeInput = Pick<ModelMetadata, 'size' | 'projectorCandidates' | 'selectedProjectorId'> & Partial<Pick<
  ModelMetadata,
  'activeVariantId' | 'artifacts' | 'id' | 'resolvedFileName' | 'speculativeDecoding' | 'variants'
>>;
type ModelDisplayProjectorCandidatesResult = {
  candidates: ModelMetadata['projectorCandidates'];
  runtimeToDisplayProjectorIds: Map<string, string>;
};

export const DECIMAL_GIGABYTE = 1000 * 1000 * 1000;
export const UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES = DECIMAL_GIGABYTE;
export const UNKNOWN_SPECULATIVE_DRAFT_MEMORY_FIT_FALLBACK_BYTES = DECIMAL_GIGABYTE;

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

function getVariantIdentityKeys(
  model: ModelDisplayArtifactSizeInput,
): Set<string> {
  return new Set(getActiveModelVariantKeys(model));
}

function isProjectorCompatibleWithVariant(
  projector: ProjectorArtifactDisplayIdentity,
  activeVariantKeys: Set<string>,
): boolean {
  const ownerVariantId = normalizeOptionalString(projector.ownerVariantId);
  return ownerVariantId === null || activeVariantKeys.size === 0 || activeVariantKeys.has(ownerVariantId);
}

function filterProjectorsForActiveVariant(
  candidates: ModelMetadata['projectorCandidates'],
  model: ModelDisplayArtifactSizeInput,
  activeVariant: ModelVariant | undefined,
): ModelMetadata['projectorCandidates'] {
  if (!activeVariant || !candidates || candidates.length === 0) {
    return candidates;
  }

  const activeVariantKeys = getVariantIdentityKeys(model);
  return candidates.filter((projector) => isProjectorCompatibleWithVariant(projector, activeVariantKeys));
}

function filterDisplayProjectorsForEffectiveModality(
  candidates: ModelMetadata['projectorCandidates'],
  model: ModelDisplayArtifactSizeInput,
): ModelMetadata['projectorCandidates'] {
  if (!candidates?.length) {
    return undefined;
  }

  const filtered = filterProjectorCandidatesForEffectiveActiveVariant(model, candidates);
  return filtered.length > 0 ? filtered : undefined;
}

function resolveModelDisplayProjectorCandidates(
  model: ModelDisplayArtifactSizeInput,
  projectorCandidates?: ModelMetadata['projectorCandidates'],
): ModelDisplayProjectorCandidatesResult {
  const activeVariant = resolveActiveModelVariant(model);
  const emptyIdMap = new Map<string, string>();

  if (projectorCandidates) {
    const mergedProjectorIds = activeVariant && model.projectorCandidates?.length
      ? mergeProjectorCandidatesWithRuntimeStateAndIdMap(
        projectorCandidates,
        model.projectorCandidates,
        { activeVariantIds: getVariantIdentityKeys(model) },
      ).runtimeToNextProjectorIds
      : emptyIdMap;

    return {
      candidates: filterDisplayProjectorsForEffectiveModality(
        filterProjectorsForActiveVariant(projectorCandidates, model, activeVariant),
        model,
      ),
      runtimeToDisplayProjectorIds: mergedProjectorIds,
    };
  }

  if (activeVariant?.projectorCandidates?.length) {
    const mergedProjectors = mergeProjectorCandidatesWithRuntimeStateAndIdMap(
      activeVariant.projectorCandidates,
      model.projectorCandidates,
      { activeVariantIds: getVariantIdentityKeys(model) },
    );
    const effectiveCandidates = getEffectiveActiveVariantProjectorCandidates(model);

    return {
      // The effective set can contain both variant-owned projectors and
      // independently compatible model-wide projectors. The merge above is
      // still needed for runtime-id remapping, but its candidate list contains
      // only the variant-owned side and would hide a valid model-wide choice.
      candidates: effectiveCandidates.length > 0 ? effectiveCandidates : undefined,
      runtimeToDisplayProjectorIds: mergedProjectors.runtimeToNextProjectorIds,
    };
  }

  return {
    candidates: filterDisplayProjectorsForEffectiveModality(
      filterProjectorsForActiveVariant(model.projectorCandidates, model, activeVariant),
      model,
    ),
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
  const effectiveCandidates = candidates ?? [];
  const resolveCanonicalSelection = (projectorId: string): string => (
    runtimeToDisplayProjectorIds.get(projectorId)
    ?? remapProjectorIdToEffectiveCandidate(model, projectorId, effectiveCandidates)
    ?? projectorId
  );
  const activeVariant = resolveActiveModelVariant(model);
  if (!activeVariant) {
    const normalizedSelectedProjectorId = normalizeOptionalString(selectedProjectorId ?? model.selectedProjectorId);
    return normalizedSelectedProjectorId
      ? resolveCanonicalSelection(normalizedSelectedProjectorId)
      : undefined;
  }

  const activeVariantSelectedProjectorId = normalizeOptionalString(activeVariant.selectedProjectorId);
  const activeVariantKeys = getVariantIdentityKeys(model);
  if (activeVariantSelectedProjectorId !== null) {
    const effectiveActiveVariantSelectedProjectorId = resolveCanonicalSelection(activeVariantSelectedProjectorId);
    const activeVariantSelectedProjector = candidates?.find(
      (projector) => projector.id === effectiveActiveVariantSelectedProjectorId,
    );
    if (
      activeVariantSelectedProjector
      && isProjectorCompatibleWithVariant(activeVariantSelectedProjector, activeVariantKeys)
    ) {
      return effectiveActiveVariantSelectedProjectorId;
    }
  }

  const normalizedRuntimeSelectedProjectorId = normalizeOptionalString(selectedProjectorId ?? model.selectedProjectorId);
  if (normalizedRuntimeSelectedProjectorId === null) {
    return undefined;
  }

  const normalizedSelectedProjectorId = resolveCanonicalSelection(normalizedRuntimeSelectedProjectorId);
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
  model: Pick<ModelMetadata, 'size' | 'projectorCandidates'> & Partial<Pick<ModelMetadata, 'artifacts'>>,
): number {
  return (normalizePositiveByteSize(model.size) ?? 0)
    + getStoredProjectorArtifactsSizeBytes(model.projectorCandidates)
    + getInstalledSpeculativeDraftArtifactsSizeBytes(model.artifacts);
}

export function getModelStoredMemoryFitSizeBytes(
  model: ModelDisplayArtifactSizeInput,
  options: { mtpEnabledOverride?: boolean } = {},
): number | null {
  const normalizedModelSize = normalizePositiveByteSize(model.size);
  if (normalizedModelSize === null) {
    return null;
  }

  return normalizedModelSize
    + getStoredProjectorMemoryFitSizeBytes(model.projectorCandidates)
    + getSpeculativeDraftMemoryFitSizeBytes(model, {
      requireInstalled: true,
      enabledOverride: options.mtpEnabledOverride,
    });
}

export function getInstalledSpeculativeDraftArtifactsSizeBytes(
  artifacts: readonly ModelArtifactMetadata[] | null | undefined,
): number {
  const seen = new Set<string>();
  return (artifacts ?? []).reduce((sum, artifact, index) => {
    if (artifact.kind !== 'speculative_draft' || artifact.installState !== 'installed') {
      return sum;
    }

    const identity = normalizeOptionalString(artifact.localPath)
      ? `path:${artifact.localPath!.trim()}`
      : `id:${artifact.id || `anonymous:${index}`}`;
    if (seen.has(identity)) {
      return sum;
    }

    seen.add(identity);
    return sum + (normalizePositiveByteSize(artifact.sizeBytes) ?? 0);
  }, 0);
}

export function getSpeculativeDraftMemoryFitSizeBytes(
  model: ModelDisplayArtifactSizeInput,
  options: {
    enabledOverride?: boolean;
    includeUnknownSizeFallback?: boolean;
    requireInstalled?: boolean;
  } = { includeUnknownSizeFallback: true },
): number {
  const artifact = getSelectedMtpDraftArtifact(model, options.enabledOverride);
  if (!artifact || (options.requireInstalled === true && artifact.installState !== 'installed')) {
    return 0;
  }

  return normalizePositiveByteSize(artifact.sizeBytes)
    ?? (options.includeUnknownSizeFallback !== false
      ? UNKNOWN_SPECULATIVE_DRAFT_MEMORY_FIT_FALLBACK_BYTES
      : 0);
}

export function getModelDisplayArtifactSizeBytes(
  model: ModelDisplayArtifactSizeInput,
  baseSizeBytes?: number | null,
  projectorCandidates?: ModelMetadata['projectorCandidates'],
  selectedProjectorId?: ModelMetadata['selectedProjectorId'],
  mtpEnabledOverride?: boolean,
): number | null {
  const activeVariant = resolveActiveModelVariant(model);
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

  return normalizedBaseSize
    + getProjectorMemoryFitSizeBytes(displayProjectors.candidates, displaySelectedProjectorId, {
      includeUnknownSizeFallback: false,
    })
    + getSpeculativeDraftMemoryFitSizeBytes(model, {
      includeUnknownSizeFallback: false,
      enabledOverride: mtpEnabledOverride,
    });
}
