import type { ProjectorArtifact } from '../types/multimodal';
import type { ModelMetadata } from '../types/models';

type ProjectorArtifactSizeIdentity = Pick<ProjectorArtifact, 'size'> & Partial<Pick<ProjectorArtifact, 'id' | 'localPath'>>;

export const DECIMAL_GIGABYTE = 1000 * 1000 * 1000;

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
): number {
  const seen = new Set<string>();
  return projectors.reduce((sum, projector, index) => {
    const size = normalizePositiveByteSize(projector.size);
    if (size === null) {
      return sum;
    }

    const identity = getProjectorArtifactIdentity(projector, index);
    if (seen.has(identity)) {
      return sum;
    }

    seen.add(identity);
    return sum + size;
  }, 0);
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

export function getProjectorMemoryFitSizeBytes(
  projectors: readonly (ProjectorArtifactSizeIdentity & Pick<ProjectorArtifact, 'lifecycleStatus' | 'matchStatus'>)[] | null | undefined,
  selectedProjectorId?: string,
): number {
  const candidates = projectors ?? [];
  const normalizedSelectedProjectorId = typeof selectedProjectorId === 'string' && selectedProjectorId.trim().length > 0
    ? selectedProjectorId.trim()
    : undefined;
  const selectedProjector = normalizedSelectedProjectorId
    ? candidates.find((projector) => projector.id === normalizedSelectedProjectorId)
    : undefined;
  if (selectedProjector) {
    return sumUniqueProjectorArtifactSizes([selectedProjector]);
  }

  const selectedProjectors = candidates.filter((projector) => projector.matchStatus === 'user_selected');
  if (selectedProjectors.length > 0) {
    return sumUniqueProjectorArtifactSizes(selectedProjectors);
  }

  const storedProjectors = candidates.filter(isStoredProjectorArtifact);
  if (storedProjectors.length > 0) {
    return sumUniqueProjectorArtifactSizes(storedProjectors);
  }

  const matchedProjectors = candidates.filter((projector) => projector.matchStatus === 'matched');
  if (matchedProjectors.length === 1) {
    return sumUniqueProjectorArtifactSizes(matchedProjectors);
  }

  return 0;
}

export function getModelStoredArtifactsSizeBytes(
  model: Pick<ModelMetadata, 'size' | 'projectorCandidates'>,
): number {
  return (normalizePositiveByteSize(model.size) ?? 0)
    + getStoredProjectorArtifactsSizeBytes(model.projectorCandidates);
}

export function getModelDisplayArtifactSizeBytes(
  model: Pick<ModelMetadata, 'size' | 'projectorCandidates' | 'selectedProjectorId'>,
  baseSizeBytes: number | null | undefined = model.size,
  projectorCandidates: ModelMetadata['projectorCandidates'] = model.projectorCandidates,
  selectedProjectorId: ModelMetadata['selectedProjectorId'] = model.selectedProjectorId,
): number | null {
  const normalizedBaseSize = normalizePositiveByteSize(baseSizeBytes);
  if (normalizedBaseSize === null) {
    return null;
  }

  return normalizedBaseSize + getProjectorMemoryFitSizeBytes(projectorCandidates, selectedProjectorId);
}
