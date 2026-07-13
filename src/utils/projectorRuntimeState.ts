import type { ProjectorArtifact, ProjectorMatchStatus } from '../types/multimodal';
import { normalizeDownloadResumeData } from './downloadResumeData';
import {
  canonicalizeProjectorCandidateAliases,
  getProjectorExactScopeKey,
} from './projectorIdentity';

export type ProjectorRuntimeIdentityOptions = {
  activeVariantId?: string | null;
  activeVariantIds?: Iterable<string | null | undefined>;
};

export type ProjectorRuntimeMergeOptions = ProjectorRuntimeIdentityOptions & {
  // Effective selectors normalize both missing metadata and an explicit empty
  // list to []; callers must opt in only when the source model owned the list.
  emptyNextProjectorsAreAuthoritative?: boolean;
  nextIdentityCandidates?: readonly ProjectorArtifact[];
  runtimeIdentityCandidates?: readonly ProjectorArtifact[];
};

function getNormalizedActiveVariantIds(options: ProjectorRuntimeIdentityOptions): Set<string> {
  return new Set([
    options.activeVariantId,
    ...(options.activeVariantIds ?? []),
  ].flatMap((value) => {
    const normalized = normalizeComparableString(value ?? undefined);
    return normalized ? [normalized] : [];
  }));
}

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

function runtimeProjectorAppliesToActiveVariant(
  runtimeProjector: ProjectorArtifact,
  options: ProjectorRuntimeIdentityOptions = {},
): boolean {
  const runtimeVariantId = normalizeComparableString(runtimeProjector.ownerVariantId);
  const activeVariantIds = getNormalizedActiveVariantIds(options);
  return !runtimeVariantId || activeVariantIds.size === 0 || activeVariantIds.has(runtimeVariantId);
}

function valuesConflict<T>(first: T | undefined, second: T | undefined): boolean {
  return first !== undefined && second !== undefined && first !== second;
}

function projectorsShareStableArtifact(
  runtimeProjector: ProjectorArtifact,
  nextProjector: ProjectorArtifact,
  options: ProjectorRuntimeIdentityOptions = {},
): boolean {
  const activeVariantKeys = getNormalizedActiveVariantIds(options);
  const runtimeScopeKey = getProjectorExactScopeKey(runtimeProjector, activeVariantKeys);
  return runtimeScopeKey !== null
    && runtimeScopeKey === getProjectorExactScopeKey(nextProjector, activeVariantKeys);
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
  options: ProjectorRuntimeIdentityOptions = {},
): boolean {
  if (!projectorsShareStableArtifact(runtimeProjector, nextProjector, options)) {
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
  options: ProjectorRuntimeMergeOptions = {},
): ProjectorArtifact[] | undefined {
  return mergeProjectorCandidatesWithRuntimeStateAndIdMap(
    nextProjectors,
    runtimeProjectors,
    options,
  ).projectorCandidates;
}

export function mergeProjectorCandidatesWithRuntimeStateAndIdMap(
  nextProjectors: ProjectorArtifact[] | undefined,
  runtimeProjectors: ProjectorArtifact[] | undefined,
  options: ProjectorRuntimeMergeOptions = {},
): ProjectorRuntimeStateMerge {
  const activeVariantKeys = getNormalizedActiveVariantIds(options);
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

  if (nextProjectors?.length === 0 && options.emptyNextProjectorsAreAuthoritative) {
    runtimeProjectors?.forEach((runtimeProjector) => {
      blockedRuntimeProjectorIds.add(runtimeProjector.id);
      blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
    });
    return buildResult(nextProjectors);
  }

  if (!nextProjectors?.length) {
    if (!runtimeProjectors?.length) {
      return buildResult(nextProjectors);
    }

    const compatibleRuntimeProjectors = runtimeProjectors.filter((runtimeProjector) => {
      const canPreserveRuntimeProjector = runtimeProjectorAppliesToActiveVariant(runtimeProjector, options);
      if (!canPreserveRuntimeProjector) {
        blockedRuntimeProjectorIds.add(runtimeProjector.id);
        blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
      }

      return canPreserveRuntimeProjector;
    });
    const compatibleScopeKeys = new Set(compatibleRuntimeProjectors.flatMap((projector) => {
      const scopeKey = getProjectorExactScopeKey(projector, activeVariantKeys);
      return scopeKey ? [scopeKey] : [];
    }));
    const runtimeIdentityCandidates = [
      ...(options.runtimeIdentityCandidates ?? compatibleRuntimeProjectors),
      ...compatibleRuntimeProjectors,
    ].filter((projector) => {
      const scopeKey = getProjectorExactScopeKey(projector, activeVariantKeys);
      return scopeKey !== null
        && compatibleScopeKeys.has(scopeKey)
        && runtimeProjectorAppliesToActiveVariant(projector, options);
    });
    const incomingIdentityCandidates = (options.nextIdentityCandidates ?? [])
      .filter((projector) => runtimeProjectorAppliesToActiveVariant(projector, options));
    const canonical = canonicalizeProjectorCandidateAliases([
      ...incomingIdentityCandidates,
      ...runtimeIdentityCandidates,
    ], [], { activeVariantKeys });
    const canonicalRuntimeCandidates = canonical.candidates.filter((candidate) => {
      const scopeKey = getProjectorExactScopeKey(candidate, activeVariantKeys);
      return scopeKey !== null && compatibleScopeKeys.has(scopeKey);
    });
    const candidatesByScope = new Map(canonicalRuntimeCandidates.flatMap((candidate) => {
      const scopeKey = getProjectorExactScopeKey(candidate, activeVariantKeys);
      return scopeKey ? [[scopeKey, candidate] as const] : [];
    }));
    runtimeIdentityCandidates.forEach((runtimeProjector) => {
      if (canonical.blockedIds.has(runtimeProjector.id)) {
        blockedRuntimeProjectorIds.add(runtimeProjector.id);
        blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
        return;
      }
      const scopeKey = getProjectorExactScopeKey(runtimeProjector, activeVariantKeys);
      const canonicalProjector = scopeKey ? candidatesByScope.get(scopeKey) : undefined;
      if (canonicalProjector) {
        runtimeToNextProjectorIds.set(runtimeProjector.id, canonicalProjector.id);
      } else {
        blockedRuntimeProjectorIds.add(runtimeProjector.id);
        blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
      }
    });

    return buildResult(canonicalRuntimeCandidates.length > 0 ? canonicalRuntimeCandidates : nextProjectors);
  }

  if (!runtimeProjectors?.length) {
    const nextScopeKeys = new Set(nextProjectors.flatMap((projector) => {
      const scopeKey = getProjectorExactScopeKey(projector, activeVariantKeys);
      return scopeKey ? [scopeKey] : [];
    }));
    const nextIdentityCandidates = [
      ...(options.nextIdentityCandidates ?? nextProjectors),
      ...nextProjectors,
    ].filter((projector) => {
      const scopeKey = getProjectorExactScopeKey(projector, activeVariantKeys);
      return scopeKey !== null && nextScopeKeys.has(scopeKey);
    });
    const runtimeIdentityCandidates = (options.runtimeIdentityCandidates ?? [])
      .filter((projector) => runtimeProjectorAppliesToActiveVariant(projector, options));
    const canonical = canonicalizeProjectorCandidateAliases([
      ...nextIdentityCandidates,
      ...runtimeIdentityCandidates,
    ], [], { activeVariantKeys });
    const projectorCandidates = canonical.candidates.filter((candidate) => {
      const scopeKey = getProjectorExactScopeKey(candidate, activeVariantKeys);
      return scopeKey !== null && nextScopeKeys.has(scopeKey);
    });
    const candidatesByScope = new Map(projectorCandidates.flatMap((candidate) => {
      const scopeKey = getProjectorExactScopeKey(candidate, activeVariantKeys);
      return scopeKey ? [[scopeKey, candidate] as const] : [];
    }));
    const acceptedCanonicalIds = new Set(projectorCandidates.map((candidate) => candidate.id));
    nextIdentityCandidates.forEach((nextProjector) => {
      if (canonical.blockedIds.has(nextProjector.id) && !acceptedCanonicalIds.has(nextProjector.id)) {
        blockedNextProjectorIds.add(nextProjector.id);
        blockedNextReadinessProjectorIds.add(nextProjector.id);
        return;
      }
      const scopeKey = getProjectorExactScopeKey(nextProjector, activeVariantKeys);
      const canonicalProjector = scopeKey ? candidatesByScope.get(scopeKey) : undefined;
      if (canonicalProjector) {
        runtimeToNextProjectorIds.set(nextProjector.id, canonicalProjector.id);
      } else if (!acceptedCanonicalIds.has(nextProjector.id)) {
        blockedNextProjectorIds.add(nextProjector.id);
        blockedNextReadinessProjectorIds.add(nextProjector.id);
      }
    });
    runtimeIdentityCandidates.forEach((runtimeProjector) => {
      if (canonical.blockedIds.has(runtimeProjector.id)) {
        blockedRuntimeProjectorIds.add(runtimeProjector.id);
        blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
        return;
      }
      const scopeKey = getProjectorExactScopeKey(runtimeProjector, activeVariantKeys);
      const canonicalProjector = scopeKey ? candidatesByScope.get(scopeKey) : undefined;
      if (canonicalProjector) {
        runtimeToNextProjectorIds.set(runtimeProjector.id, canonicalProjector.id);
      } else if (!scopeKey || !canonical.candidates.some((candidate) => (
        getProjectorExactScopeKey(candidate, activeVariantKeys) === scopeKey
      ))) {
        blockedRuntimeProjectorIds.add(runtimeProjector.id);
        blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
      }
    });
    return buildResult(projectorCandidates);
  }

  const applicableRuntimeProjectors = runtimeProjectors.filter((runtimeProjector) => {
    const applies = runtimeProjectorAppliesToActiveVariant(runtimeProjector, options);
    if (!applies) {
      blockedRuntimeProjectorIds.add(runtimeProjector.id);
      blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
    }
    return applies;
  });
  const nextScopeKeys = new Set(nextProjectors.flatMap((projector) => {
    const scopeKey = getProjectorExactScopeKey(projector, activeVariantKeys);
    return scopeKey ? [scopeKey] : [];
  }));
  const nextIdentityCandidates = (options.nextIdentityCandidates ?? nextProjectors)
    .filter((projector) => runtimeProjectorAppliesToActiveVariant(projector, options));
  const runtimeIdentityCandidates = (options.runtimeIdentityCandidates ?? applicableRuntimeProjectors)
    .filter((projector) => runtimeProjectorAppliesToActiveVariant(projector, options));
  const canonical = canonicalizeProjectorCandidateAliases([
    ...nextIdentityCandidates,
    ...runtimeIdentityCandidates,
  ], [], { activeVariantKeys });
  const projectorCandidates = canonical.candidates.filter((candidate) => {
    const scopeKey = getProjectorExactScopeKey(candidate, activeVariantKeys);
    return scopeKey !== null && nextScopeKeys.has(scopeKey);
  });
  const acceptedById = new Map(projectorCandidates.map((candidate) => [candidate.id, candidate]));
  const canonicalByScope = new Map(canonical.candidates.flatMap((candidate) => {
    const scopeKey = getProjectorExactScopeKey(candidate, activeVariantKeys);
    return scopeKey ? [[scopeKey, candidate] as const] : [];
  }));

  const resolveAcceptedProjector = (projector: ProjectorArtifact): ProjectorArtifact | undefined => {
    const canonicalId = canonical.aliasToCanonicalId.get(projector.id);
    const accepted = canonicalId ? acceptedById.get(canonicalId) : undefined;
    return accepted
      && getProjectorExactScopeKey(projector, activeVariantKeys)
        === getProjectorExactScopeKey(accepted, activeVariantKeys)
      ? accepted
      : undefined;
  };

  nextProjectors.forEach((nextProjector) => {
    if (
      (canonical.blockedIds.has(nextProjector.id) && !acceptedById.has(nextProjector.id))
      || (!resolveAcceptedProjector(nextProjector)
      && !acceptedById.has(nextProjector.id)
      )
    ) {
      blockedNextProjectorIds.add(nextProjector.id);
      blockedNextReadinessProjectorIds.add(nextProjector.id);
    }
  });
  applicableRuntimeProjectors.forEach((runtimeProjector) => {
    if (canonical.blockedIds.has(runtimeProjector.id)) {
      blockedRuntimeProjectorIds.add(runtimeProjector.id);
      blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
      return;
    }
    const accepted = resolveAcceptedProjector(runtimeProjector);
    if (accepted) {
      runtimeToNextProjectorIds.set(runtimeProjector.id, accepted.id);
    } else {
      const runtimeScopeKey = getProjectorExactScopeKey(runtimeProjector, activeVariantKeys);
      if (runtimeScopeKey && canonicalByScope.has(runtimeScopeKey)) {
        return;
      }
      blockedRuntimeProjectorIds.add(runtimeProjector.id);
      blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
    }
  });
  runtimeIdentityCandidates.forEach((runtimeProjector) => {
    if (canonical.blockedIds.has(runtimeProjector.id)) {
      blockedRuntimeProjectorIds.add(runtimeProjector.id);
      blockedRuntimeReadinessProjectorIds.add(runtimeProjector.id);
    }
  });

  return buildResult(projectorCandidates);
}
