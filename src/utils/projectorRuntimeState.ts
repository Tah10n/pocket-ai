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

function normalizeComparableDownloadUrl(value: string | undefined): string | undefined {
  const trimmed = normalizeComparableString(value);
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function normalizeComparableRevision(value: string | undefined): string {
  return normalizeComparableString(value) ?? 'main';
}

function valuesConflict<T>(first: T | undefined, second: T | undefined): boolean {
  return first !== undefined && second !== undefined && first !== second;
}

function projectorsShareStableArtifact(
  runtimeProjector: ProjectorArtifact,
  nextProjector: ProjectorArtifact,
): boolean {
  return normalizeComparableString(runtimeProjector.ownerModelId) === normalizeComparableString(nextProjector.ownerModelId)
    && normalizeComparableString(runtimeProjector.repoId) === normalizeComparableString(nextProjector.repoId)
    && normalizeComparableString(runtimeProjector.fileName) === normalizeComparableString(nextProjector.fileName)
    && normalizeComparableRevision(runtimeProjector.hfRevision) === normalizeComparableRevision(nextProjector.hfRevision)
    && !valuesConflict(
      normalizeComparableString(runtimeProjector.ownerVariantId),
      normalizeComparableString(nextProjector.ownerVariantId),
    );
}

function projectorsHaveCompatibleRuntimeMetadata(
  runtimeProjector: ProjectorArtifact,
  nextProjector: ProjectorArtifact,
): boolean {
  if (valuesConflict(
    normalizeComparableSha256(runtimeProjector.sha256),
    normalizeComparableSha256(nextProjector.sha256),
  )) {
    return false;
  }

  if (valuesConflict(
    normalizeComparableSize(runtimeProjector.size),
    normalizeComparableSize(nextProjector.size),
  )) {
    return false;
  }

  return !valuesConflict(
    normalizeComparableDownloadUrl(runtimeProjector.downloadUrl),
    normalizeComparableDownloadUrl(nextProjector.downloadUrl),
  );
}

export function hasCompatibleProjectorRuntimeIdentity(
  runtimeProjector: ProjectorArtifact,
  nextProjector: ProjectorArtifact,
): boolean {
  if (!projectorsShareStableArtifact(runtimeProjector, nextProjector)) {
    return false;
  }

  return projectorsHaveCompatibleRuntimeMetadata(runtimeProjector, nextProjector);
}

export type ProjectorRuntimeStateMerge = {
  projectorCandidates: ProjectorArtifact[] | undefined;
  runtimeToNextProjectorIds: Map<string, string>;
  blockedRuntimeProjectorIds: Set<string>;
  blockedNextProjectorIds: Set<string>;
  blockedRuntimeReadinessProjectorIds: Set<string>;
  blockedNextReadinessProjectorIds: Set<string>;
};

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
    downloadProgress: runtimeProjector.downloadProgress ?? nextProjector.downloadProgress,
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
): ProjectorRuntimeStateMerge {
  const runtimeToNextProjectorIds = new Map<string, string>();
  const blockedRuntimeProjectorIds = new Set<string>();
  const blockedNextProjectorIds = new Set<string>();
  const blockedRuntimeReadinessProjectorIds = new Set<string>();
  const blockedNextReadinessProjectorIds = new Set<string>();
  const buildResult = (projectorCandidates: ProjectorArtifact[] | undefined): ProjectorRuntimeStateMerge => ({
    projectorCandidates,
    runtimeToNextProjectorIds,
    blockedRuntimeProjectorIds,
    blockedNextProjectorIds,
    blockedRuntimeReadinessProjectorIds,
    blockedNextReadinessProjectorIds,
  });

  if (!nextProjectors?.length) {
    if (!runtimeProjectors?.length) {
      return buildResult(nextProjectors);
    }

    runtimeProjectors.forEach((runtimeProjector) => {
      runtimeToNextProjectorIds.set(runtimeProjector.id, runtimeProjector.id);
    });

    return buildResult(runtimeProjectors);
  }

  if (!runtimeProjectors?.length) {
    return buildResult(nextProjectors);
  }

  const usedRuntimeProjectorIds = new Set<string>();

  const projectorCandidates = nextProjectors.map((nextProjector) => {
    const exactSameIdRuntimeProjector = runtimeProjectors.find((runtimeProjector) => (
      !usedRuntimeProjectorIds.has(runtimeProjector.id)
      && runtimeProjector.id === nextProjector.id
    ));
    if (
      exactSameIdRuntimeProjector
      && !projectorsShareStableArtifact(exactSameIdRuntimeProjector, nextProjector)
    ) {
      blockedRuntimeProjectorIds.add(exactSameIdRuntimeProjector.id);
      blockedNextProjectorIds.add(nextProjector.id);
    }

    const exactMatch = runtimeProjectors.find((runtimeProjector) => (
      !usedRuntimeProjectorIds.has(runtimeProjector.id)
      && runtimeProjector.id === nextProjector.id
      && projectorsShareStableArtifact(runtimeProjector, nextProjector)
    ));
    const runtimeProjector = exactMatch ?? runtimeProjectors.find((candidate) => (
      !usedRuntimeProjectorIds.has(candidate.id)
      && candidate.id !== nextProjector.id
      && projectorsShareStableArtifact(candidate, nextProjector)
    ));

    if (!runtimeProjector) {
      return nextProjector;
    }

    usedRuntimeProjectorIds.add(runtimeProjector.id);
    runtimeToNextProjectorIds.set(runtimeProjector.id, nextProjector.id);

    if (!projectorsHaveCompatibleRuntimeMetadata(runtimeProjector, nextProjector)) {
      blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
      blockedNextReadinessProjectorIds.add(nextProjector.id);
      return nextProjector;
    }

    return mergeProjectorRuntimeState(nextProjector, runtimeProjector);
  });

  return buildResult(projectorCandidates);
}
