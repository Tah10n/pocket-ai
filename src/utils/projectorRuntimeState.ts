import type { ProjectorArtifact, ProjectorMatchStatus } from '../types/multimodal';
import { normalizeDownloadResumeData } from './downloadResumeData';

function normalizeComparableString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeComparableSha256(value: string | undefined): string | undefined {
  return normalizeComparableString(value)?.toLowerCase();
}

function normalizeComparableSize(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalizeComparableRevision(value: string | undefined): string {
  return normalizeComparableString(value) ?? 'main';
}

function valuesConflict<T>(first: T | undefined, second: T | undefined): boolean {
  return first !== undefined && second !== undefined && first !== second;
}

function hasProjectorIdentityConflict(
  runtimeProjector: ProjectorArtifact,
  nextProjector: ProjectorArtifact,
): boolean {
  if (
    normalizeComparableString(runtimeProjector.ownerModelId) !== normalizeComparableString(nextProjector.ownerModelId)
    || normalizeComparableString(runtimeProjector.repoId) !== normalizeComparableString(nextProjector.repoId)
    || normalizeComparableString(runtimeProjector.fileName) !== normalizeComparableString(nextProjector.fileName)
    || normalizeComparableString(runtimeProjector.downloadUrl) !== normalizeComparableString(nextProjector.downloadUrl)
    || normalizeComparableRevision(runtimeProjector.hfRevision) !== normalizeComparableRevision(nextProjector.hfRevision)
  ) {
    return true;
  }

  if (valuesConflict(
    normalizeComparableString(runtimeProjector.ownerVariantId),
    normalizeComparableString(nextProjector.ownerVariantId),
  )) {
    return true;
  }

  if (valuesConflict(
    normalizeComparableSha256(runtimeProjector.sha256),
    normalizeComparableSha256(nextProjector.sha256),
  )) {
    return true;
  }

  return valuesConflict(
    normalizeComparableSize(runtimeProjector.size),
    normalizeComparableSize(nextProjector.size),
  );
}

function projectorsShareStableArtifact(
  runtimeProjector: ProjectorArtifact,
  nextProjector: ProjectorArtifact,
): boolean {
  return normalizeComparableString(runtimeProjector.ownerModelId) === normalizeComparableString(nextProjector.ownerModelId)
    && normalizeComparableString(runtimeProjector.repoId) === normalizeComparableString(nextProjector.repoId)
    && normalizeComparableString(runtimeProjector.fileName) === normalizeComparableString(nextProjector.fileName)
    && normalizeComparableString(runtimeProjector.downloadUrl) === normalizeComparableString(nextProjector.downloadUrl)
    && normalizeComparableRevision(runtimeProjector.hfRevision) === normalizeComparableRevision(nextProjector.hfRevision)
    && !valuesConflict(
      normalizeComparableString(runtimeProjector.ownerVariantId),
      normalizeComparableString(nextProjector.ownerVariantId),
    );
}

export function hasCompatibleProjectorRuntimeIdentity(
  runtimeProjector: ProjectorArtifact,
  nextProjector: ProjectorArtifact,
): boolean {
  if (hasProjectorIdentityConflict(runtimeProjector, nextProjector)) {
    return false;
  }

  if (runtimeProjector.id === nextProjector.id) {
    return true;
  }

  return projectorsShareStableArtifact(runtimeProjector, nextProjector);
}

function hasRuntimeMatchState(
  matchStatus: ProjectorMatchStatus,
  matchReason: string | undefined,
): boolean {
  return matchStatus === 'failed'
    || matchStatus === 'user_selected'
    || matchReason === 'user_selected_projector'
    || matchReason === 'unselected_projector_candidate';
}

export function mergeProjectorRuntimeState(
  nextProjector: ProjectorArtifact,
  runtimeProjector: ProjectorArtifact,
): ProjectorArtifact {
  const resumeData = normalizeDownloadResumeData(runtimeProjector.resumeData);
  const nextResumeData = normalizeDownloadResumeData(nextProjector.resumeData);
  const shouldPreserveLifecycleStatus = runtimeProjector.lifecycleStatus !== 'available';
  const shouldPreserveMatchState = hasRuntimeMatchState(
    runtimeProjector.matchStatus,
    runtimeProjector.matchReason,
  );

  return {
    ...nextProjector,
    sha256: nextProjector.sha256 ?? runtimeProjector.sha256,
    size: nextProjector.size ?? runtimeProjector.size,
    localPath: runtimeProjector.localPath ?? nextProjector.localPath,
    resumeData: resumeData ?? nextResumeData,
    lifecycleStatus: shouldPreserveLifecycleStatus
      ? runtimeProjector.lifecycleStatus
      : nextProjector.lifecycleStatus,
    matchStatus: shouldPreserveMatchState
      ? runtimeProjector.matchStatus
      : nextProjector.matchStatus,
    matchReason: shouldPreserveMatchState
      ? runtimeProjector.matchReason
      : nextProjector.matchReason,
  };
}

export function mergeProjectorCandidatesWithRuntimeState(
  nextProjectors: ProjectorArtifact[] | undefined,
  runtimeProjectors: ProjectorArtifact[] | undefined,
): ProjectorArtifact[] | undefined {
  return mergeProjectorCandidatesWithRuntimeStateAndIdMap(
    nextProjectors,
    runtimeProjectors,
  ).projectorCandidates;
}

export function mergeProjectorCandidatesWithRuntimeStateAndIdMap(
  nextProjectors: ProjectorArtifact[] | undefined,
  runtimeProjectors: ProjectorArtifact[] | undefined,
): {
  projectorCandidates: ProjectorArtifact[] | undefined;
  runtimeToNextProjectorIds: Map<string, string>;
} {
  const runtimeToNextProjectorIds = new Map<string, string>();

  if (!nextProjectors?.length) {
    if (!runtimeProjectors?.length) {
      return { projectorCandidates: nextProjectors, runtimeToNextProjectorIds };
    }

    runtimeProjectors.forEach((runtimeProjector) => {
      runtimeToNextProjectorIds.set(runtimeProjector.id, runtimeProjector.id);
    });

    return {
      projectorCandidates: runtimeProjectors,
      runtimeToNextProjectorIds,
    };
  }

  if (!runtimeProjectors?.length) {
    return { projectorCandidates: nextProjectors, runtimeToNextProjectorIds };
  }

  const usedRuntimeProjectorIds = new Set<string>();

  const projectorCandidates = nextProjectors.map((nextProjector) => {
    const exactMatch = runtimeProjectors.find((runtimeProjector) => (
      !usedRuntimeProjectorIds.has(runtimeProjector.id)
      && runtimeProjector.id === nextProjector.id
      && hasCompatibleProjectorRuntimeIdentity(runtimeProjector, nextProjector)
    ));
    const runtimeProjector = exactMatch ?? runtimeProjectors.find((candidate) => (
      !usedRuntimeProjectorIds.has(candidate.id)
      && candidate.id !== nextProjector.id
      && hasCompatibleProjectorRuntimeIdentity(candidate, nextProjector)
    ));

    if (!runtimeProjector) {
      return nextProjector;
    }

    usedRuntimeProjectorIds.add(runtimeProjector.id);
    runtimeToNextProjectorIds.set(runtimeProjector.id, nextProjector.id);
    return mergeProjectorRuntimeState(nextProjector, runtimeProjector);
  });

  return { projectorCandidates, runtimeToNextProjectorIds };
}
