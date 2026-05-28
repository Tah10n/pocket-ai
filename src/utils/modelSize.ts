import type { ProjectorArtifact } from '../types/multimodal';
import type { ModelMetadata } from '../types/models';

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

export function getProjectorArtifactsSizeBytes(
  projectors: readonly Pick<ProjectorArtifact, 'size'>[] | null | undefined,
): number {
  return (projectors ?? []).reduce(
    (sum, projector) => sum + (normalizePositiveByteSize(projector.size) ?? 0),
    0,
  );
}

export function getStoredProjectorArtifactsSizeBytes(
  projectors: readonly Pick<ProjectorArtifact, 'lifecycleStatus' | 'size'>[] | null | undefined,
): number {
  return getProjectorArtifactsSizeBytes((projectors ?? []).filter(isStoredProjectorArtifact));
}

export function getModelStoredArtifactsSizeBytes(
  model: Pick<ModelMetadata, 'size' | 'projectorCandidates'>,
): number {
  return (normalizePositiveByteSize(model.size) ?? 0)
    + getStoredProjectorArtifactsSizeBytes(model.projectorCandidates);
}
