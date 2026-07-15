import type { ModelArtifactMetadata } from '../types/models';
import type { ProjectorArtifact, ProjectorLifecycleStatus, ProjectorMatchStatus } from '../types/multimodal';
import { normalizeDownloadResumeData } from './downloadResumeData';
import {
  buildHuggingFaceResolveUrl,
  hasConsistentRemoteProjectorIdentity,
  hasHuggingFaceHostname,
  normalizeHuggingFaceFilePath,
  normalizeHuggingFaceRepoId,
  resolveHuggingFaceRevision,
} from './huggingFaceUrls';
import { buildLegacyProjectorArtifactId, buildProjectorArtifactId } from './modelProjectors';
import { normalizeSha256Digest } from './sha256';

export type ExactProjectorScope = {
  ownerModelId: string;
  ownerVariantId?: string;
  repoId: string;
  revision: string;
  filePath: string;
};

export type CanonicalProjectorCandidatesResult = {
  candidates: ProjectorArtifact[];
  artifacts: ModelArtifactMetadata[];
  aliasToCanonicalId: Map<string, string>;
  blockedIds: Set<string>;
  blockedScopeKeys: Set<string>;
};

export type CanonicalProjectorCandidatesOptions = {
  activeVariantKeys?: ReadonlySet<string>;
  preserveRuntimeState?: boolean;
};

type CandidateRecord = {
  candidate: ProjectorArtifact;
  scope: ExactProjectorScope;
  scopeKey: string;
  currentId: string;
  legacyId: string;
};

const PROJECTOR_REQUIRED_INPUTS = new Set(['image', 'audio']);

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveSize(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function valuesConflict<T>(values: readonly (T | undefined)[]): boolean {
  return new Set(values.filter((value): value is T => value !== undefined)).size > 1;
}

function normalizeComparableOrdinaryDownloadUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function projectorDownloadUrlsAreCompatible(left: string, right: string): boolean {
  const leftIsHuggingFace = hasHuggingFaceHostname(left);
  const rightIsHuggingFace = hasHuggingFaceHostname(right);
  if (leftIsHuggingFace || rightIsHuggingFace) {
    return leftIsHuggingFace && rightIsHuggingFace;
  }

  const normalizedLeft = normalizeComparableOrdinaryDownloadUrl(left);
  return normalizedLeft !== undefined
    && normalizedLeft === normalizeComparableOrdinaryDownloadUrl(right);
}

export function resolveExactProjectorScope(
  projector: Pick<
    ProjectorArtifact,
    'downloadUrl' | 'fileName' | 'hfRevision' | 'ownerModelId' | 'ownerVariantId' | 'repoId'
  >,
): ExactProjectorScope | null {
  const ownerModelId = normalizeOptionalString(projector.ownerModelId);
  const repoId = normalizeHuggingFaceRepoId(projector.repoId);
  const filePath = normalizeHuggingFaceFilePath(projector.fileName);
  const revision = resolveHuggingFaceRevision(projector.hfRevision);
  if (
    !ownerModelId
    || !repoId
    || !filePath
    || !hasConsistentRemoteProjectorIdentity({
      repoId,
      revision,
      filePath,
      downloadUrl: projector.downloadUrl,
    })
  ) {
    return null;
  }

  const ownerVariantId = normalizeOptionalString(projector.ownerVariantId);
  return {
    ownerModelId,
    ...(ownerVariantId ? { ownerVariantId } : {}),
    repoId,
    revision,
    filePath,
  };
}

export function getExactProjectorScopeKey(scope: ExactProjectorScope): string {
  return JSON.stringify([
    scope.ownerModelId,
    scope.ownerVariantId ?? '',
    scope.repoId,
    scope.revision,
    scope.filePath,
  ]);
}

export function getProjectorExactScopeKey(
  projector: Pick<
    ProjectorArtifact,
    'downloadUrl' | 'fileName' | 'hfRevision' | 'ownerModelId' | 'ownerVariantId' | 'repoId'
  >,
  activeVariantKeys?: ReadonlySet<string>,
): string | null {
  const resolvedScope = resolveExactProjectorScope(projector);
  const canonicalActiveVariantId = activeVariantKeys?.values().next().value as string | undefined;
  const scope = resolvedScope?.ownerVariantId
    && canonicalActiveVariantId
    && activeVariantKeys?.has(resolvedScope.ownerVariantId)
    ? { ...resolvedScope, ownerVariantId: canonicalActiveVariantId }
    : resolvedScope;
  return scope ? getExactProjectorScopeKey(scope) : null;
}

function getScopeIdInput(scope: ExactProjectorScope) {
  return {
    repoId: scope.repoId,
    hfRevision: scope.revision,
    fileName: scope.filePath,
    ...(scope.ownerVariantId ? { ownerVariantId: scope.ownerVariantId } : {}),
  };
}

function addToSetMap(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(value);
  index.set(key, values);
}

function lifecycleRank(status: ProjectorLifecycleStatus): number {
  switch (status) {
    case 'active': return 7;
    case 'downloaded': return 6;
    case 'downloading': return 5;
    case 'paused': return 4;
    case 'queued': return 3;
    case 'failed': return 2;
    case 'available':
    default: return 1;
  }
}

function matchRank(status: ProjectorMatchStatus, reason: string | undefined): number {
  if (status === 'user_selected' || reason === 'user_selected_projector') {
    return 5;
  }

  switch (status) {
    case 'matched': return 4;
    case 'failed': return 3;
    case 'ambiguous': return 2;
    case 'missing':
    default: return 1;
  }
}

function compareRuntimeCandidates(left: CandidateRecord, right: CandidateRecord): number {
  const lifecycleDifference = lifecycleRank(right.candidate.lifecycleStatus)
    - lifecycleRank(left.candidate.lifecycleStatus);
  if (lifecycleDifference !== 0) {
    return lifecycleDifference;
  }

  const matchDifference = matchRank(right.candidate.matchStatus, right.candidate.matchReason)
    - matchRank(left.candidate.matchStatus, left.candidate.matchReason);
  if (matchDifference !== 0) {
    return matchDifference;
  }

  const localPathDifference = Number(Boolean(right.candidate.localPath))
    - Number(Boolean(left.candidate.localPath));
  if (localPathDifference !== 0) {
    return localPathDifference;
  }

  const progressDifference = (right.candidate.downloadProgress ?? -1)
    - (left.candidate.downloadProgress ?? -1);
  if (progressDifference !== 0) {
    return progressDifference;
  }

  return JSON.stringify([
    left.candidate.id,
    left.candidate.localPath ?? '',
    left.candidate.resumeData ?? '',
  ]).localeCompare(JSON.stringify([
    right.candidate.id,
    right.candidate.localPath ?? '',
    right.candidate.resumeData ?? '',
  ]));
}

function mergeCandidateGroup(
  records: readonly CandidateRecord[],
  preserveRuntimeState: boolean,
): ProjectorArtifact {
  const first = records[0] as CandidateRecord;
  const current = records.find((record) => record.candidate.id === record.currentId);
  const catalogSource = current ?? [...records].sort((left, right) => (
    left.candidate.id.localeCompare(right.candidate.id)
  ))[0] as CandidateRecord;
  const runtimeSource = preserveRuntimeState
    ? [...records].sort(compareRuntimeCandidates)[0] as CandidateRecord
    : catalogSource;
  const sha256 = records
    .map((record) => normalizeSha256Digest(record.candidate.sha256))
    .find((value) => value !== undefined);
  const size = records
    .map((record) => normalizePositiveSize(record.candidate.size))
    .find((value) => value !== undefined) ?? null;
  const resumeData = normalizeDownloadResumeData(runtimeSource.candidate.resumeData)
    ?? normalizeDownloadResumeData(catalogSource.candidate.resumeData);

  return {
    ...catalogSource.candidate,
    id: first.currentId,
    ownerModelId: first.scope.ownerModelId,
    ...(first.scope.ownerVariantId
      ? { ownerVariantId: first.scope.ownerVariantId }
      : { ownerVariantId: undefined }),
    repoId: first.scope.repoId,
    hfRevision: first.scope.revision,
    fileName: first.scope.filePath,
    downloadUrl: hasHuggingFaceHostname(catalogSource.candidate.downloadUrl)
      ? buildHuggingFaceResolveUrl(
          first.scope.repoId,
          first.scope.filePath,
          first.scope.revision,
        )
      : catalogSource.candidate.downloadUrl.trim(),
    ...(sha256 ? { sha256 } : { sha256: undefined }),
    size,
    ...(preserveRuntimeState
      ? {
          ...((runtimeSource.candidate.localPath ?? catalogSource.candidate.localPath)
            ? { localPath: runtimeSource.candidate.localPath ?? catalogSource.candidate.localPath }
            : {}),
          ...(resumeData ? { resumeData } : {}),
          ...((runtimeSource.candidate.downloadProgress ?? catalogSource.candidate.downloadProgress) !== undefined
            ? {
                downloadProgress: runtimeSource.candidate.downloadProgress
                  ?? catalogSource.candidate.downloadProgress,
              }
            : {}),
          lifecycleStatus: runtimeSource.candidate.lifecycleStatus,
          matchStatus: runtimeSource.candidate.matchStatus,
          ...(runtimeSource.candidate.matchReason
            ? { matchReason: runtimeSource.candidate.matchReason }
            : {}),
        }
      : null),
  };
}

function normalizeArtifactRequiredFor(
  artifact: ModelArtifactMetadata,
): readonly ('image' | 'audio')[] | null {
  if (
    artifact.kind !== 'multimodal_projector'
    || artifact.requiredFor.length === 0
    || artifact.requiredFor.some((input) => !PROJECTOR_REQUIRED_INPUTS.has(input))
  ) {
    return null;
  }

  return [...new Set(artifact.requiredFor as ('image' | 'audio')[])].sort();
}

function resolveArtifactRequiredFor(
  artifacts: readonly ModelArtifactMetadata[],
): readonly ('image' | 'audio')[] | null {
  const requirements = artifacts.map(normalizeArtifactRequiredFor);
  if (requirements.some((value) => value === null)) {
    return null;
  }

  const normalized = requirements as readonly (readonly ('image' | 'audio')[])[];
  const uniqueKeys = new Set(normalized.map((value) => JSON.stringify(value)));
  if (uniqueKeys.size === 1) {
    return normalized[0] ?? null;
  }

  const union = [...new Set(normalized.flat())].sort() as ('image' | 'audio')[];
  const unionKey = JSON.stringify(union);
  return union.length > 1 && normalized.some((value) => JSON.stringify(value) === unionKey)
    ? union
    : null;
}

function artifactInstallRank(state: ModelArtifactMetadata['installState']): number {
  switch (state) {
    case 'installed': return 7;
    case 'verifying': return 6;
    case 'downloading': return 5;
    case 'queued': return 4;
    case 'failed': return 3;
    case 'missing': return 2;
    case 'remote':
    default: return 1;
  }
}

function compareArtifactRuntime(left: ModelArtifactMetadata, right: ModelArtifactMetadata): number {
  const installDifference = artifactInstallRank(right.installState) - artifactInstallRank(left.installState);
  if (installDifference !== 0) {
    return installDifference;
  }

  const localPathDifference = Number(Boolean(right.localPath)) - Number(Boolean(left.localPath));
  if (localPathDifference !== 0) {
    return localPathDifference;
  }

  const progressDifference = (right.downloadProgress ?? -1) - (left.downloadProgress ?? -1);
  if (progressDifference !== 0) {
    return progressDifference;
  }

  return left.id.localeCompare(right.id);
}

function mergeArtifactGroup(
  candidate: ProjectorArtifact,
  artifacts: readonly ModelArtifactMetadata[],
  requiredFor: readonly ('image' | 'audio')[],
  preserveRuntimeState: boolean,
): ModelArtifactMetadata {
  const current = artifacts.find((artifact) => artifact.id === candidate.id);
  const catalogSource = current ?? (
    [...artifacts].sort((left, right) => left.id.localeCompare(right.id))[0] as ModelArtifactMetadata
  );
  const runtimeSource = preserveRuntimeState
    ? ([...artifacts].sort(compareArtifactRuntime)[0] as ModelArtifactMetadata)
    : catalogSource;
  const sha256 = normalizeSha256Digest(candidate.sha256)
    ?? artifacts.map((artifact) => normalizeSha256Digest(artifact.sha256))
      .find((value) => value !== undefined);
  const sizeBytes = normalizePositiveSize(candidate.size)
    ?? artifacts.map((artifact) => normalizePositiveSize(artifact.sizeBytes))
      .find((value) => value !== undefined)
    ?? null;

  return {
    ...catalogSource,
    id: candidate.id,
    kind: 'multimodal_projector',
    requiredFor: [...requiredFor],
    hfRevision: candidate.hfRevision,
    remoteFileName: candidate.fileName,
    downloadUrl: candidate.downloadUrl,
    sizeBytes,
    ...(sha256 ? { sha256 } : { sha256: undefined }),
    ...(preserveRuntimeState
      ? {
          localPath: runtimeSource.localPath ?? catalogSource.localPath,
          installState: runtimeSource.installState,
          downloadProgress: runtimeSource.downloadProgress ?? catalogSource.downloadProgress,
          resumeData: normalizeDownloadResumeData(runtimeSource.resumeData)
            ?? normalizeDownloadResumeData(catalogSource.resumeData),
          integrity: runtimeSource.integrity ?? catalogSource.integrity,
          errorCode: runtimeSource.errorCode ?? catalogSource.errorCode,
          errorMessage: runtimeSource.errorMessage ?? catalogSource.errorMessage,
          updatedAt: runtimeSource.updatedAt ?? catalogSource.updatedAt,
        }
      : null),
  };
}

export function canonicalizeProjectorCandidateAliases(
  candidates: readonly ProjectorArtifact[],
  artifacts: readonly ModelArtifactMetadata[] = [],
  options: CanonicalProjectorCandidatesOptions = {},
): CanonicalProjectorCandidatesResult {
  const blockedIds = new Set<string>();
  const blockedScopeKeys = new Set<string>();
  const discardedRecords = new Set<CandidateRecord>();
  const records: CandidateRecord[] = [];
  const recordsByScope = new Map<string, CandidateRecord[]>();
  const rawIdScopes = new Map<string, Set<string>>();
  const currentIdScopes = new Map<string, Set<string>>();
  const legacyIdScopes = new Map<string, Set<string>>();
  const canonicalActiveVariantId = options.activeVariantKeys?.values().next().value as string | undefined;

  for (const candidate of candidates) {
    const resolvedScope = resolveExactProjectorScope(candidate);
    if (!resolvedScope) {
      blockedIds.add(candidate.id);
      continue;
    }
    const scope = resolvedScope.ownerVariantId
      && canonicalActiveVariantId
      && options.activeVariantKeys?.has(resolvedScope.ownerVariantId)
      ? { ...resolvedScope, ownerVariantId: canonicalActiveVariantId }
      : resolvedScope;

    const scopeKey = getExactProjectorScopeKey(scope);
    const idInput = getScopeIdInput(scope);
    const record: CandidateRecord = {
      candidate,
      scope,
      scopeKey,
      currentId: buildProjectorArtifactId(idInput),
      legacyId: buildLegacyProjectorArtifactId(idInput),
    };
    records.push(record);
    recordsByScope.set(scopeKey, [...(recordsByScope.get(scopeKey) ?? []), record]);
    addToSetMap(rawIdScopes, candidate.id, scopeKey);
    addToSetMap(currentIdScopes, record.currentId, scopeKey);
    addToSetMap(legacyIdScopes, record.legacyId, scopeKey);
  }

  for (const [currentId, scopeKeys] of currentIdScopes) {
    if (scopeKeys.size > 1) {
      blockedIds.add(currentId);
      scopeKeys.forEach((scopeKey) => blockedScopeKeys.add(scopeKey));
    }
  }

  for (const [rawId, scopeKeys] of rawIdScopes) {
    if (scopeKeys.size <= 1) {
      continue;
    }

    const claimants = records.filter((record) => record.candidate.id === rawId);
    const currentClaimants = claimants.filter((record) => record.currentId === rawId);
    const currentClaimantScopeKeys = new Set(
      currentClaimants.map((record) => record.scopeKey),
    );
    const nonCurrentAreLegacy = claimants
      .filter((record) => record.currentId !== rawId)
      .every((record) => record.legacyId === rawId);
    if (currentClaimantScopeKeys.size === 1 && nonCurrentAreLegacy) {
      claimants.filter((record) => record.currentId !== rawId).forEach((record) => {
        const hasSeparateCurrentRepresentation = recordsByScope.get(record.scopeKey)?.some((entry) => (
          entry !== record && entry.candidate.id === entry.currentId
        )) === true;
        if (hasSeparateCurrentRepresentation) {
          discardedRecords.add(record);
        } else {
          blockedScopeKeys.add(record.scopeKey);
        }
      });
      continue;
    }

    blockedIds.add(rawId);
    scopeKeys.forEach((scopeKey) => blockedScopeKeys.add(scopeKey));
  }

  for (const [scopeKey, scopeRecords] of recordsByScope) {
    const activeScopeRecords = scopeRecords.filter((record) => !discardedRecords.has(record));
    if (valuesConflict(activeScopeRecords.map((record) => normalizeSha256Digest(record.candidate.sha256)))
      || valuesConflict(activeScopeRecords.map((record) => normalizePositiveSize(record.candidate.size)))
      || activeScopeRecords.some((record) => !projectorDownloadUrlsAreCompatible(
        activeScopeRecords[0]?.candidate.downloadUrl ?? '',
        record.candidate.downloadUrl,
      ))) {
      blockedScopeKeys.add(scopeKey);
      scopeRecords.forEach((record) => blockedIds.add(record.candidate.id));
    }
  }

  const artifactGroups = new Map<string, ModelArtifactMetadata[]>();
  for (const artifact of artifacts) {
    if (artifact.kind !== 'multimodal_projector') {
      continue;
    }

    const referencedRecords = records.filter((record) => !discardedRecords.has(record) && (
      artifact.id === record.candidate.id
      || artifact.id === record.currentId
      || artifact.id === record.legacyId
    ));
    const artifactPath = normalizeHuggingFaceFilePath(artifact.remoteFileName);
    const artifactRevision = resolveHuggingFaceRevision(artifact.hfRevision);
    const sameIdentityRecords = records.filter((record) => (
      !discardedRecords.has(record)
      && artifactPath === record.scope.filePath
      && artifactRevision === record.scope.revision
      && hasConsistentRemoteProjectorIdentity({
        repoId: record.scope.repoId,
        revision: artifactRevision,
        filePath: artifactPath,
        downloadUrl: artifact.downloadUrl,
      })
      && projectorDownloadUrlsAreCompatible(record.candidate.downloadUrl, artifact.downloadUrl)
    ));
    if (sameIdentityRecords.length === 0) {
      referencedRecords.forEach((record) => {
        blockedScopeKeys.add(record.scopeKey);
        blockedIds.add(record.candidate.id);
      });
      blockedIds.add(artifact.id);
      continue;
    }

    const currentScopeOwners = currentIdScopes.get(artifact.id);
    if (currentScopeOwners?.size === 1) {
      const currentScopeKey = [...currentScopeOwners][0] as string;
      const matchesCurrentIdentity = sameIdentityRecords.some((record) => (
        record.scopeKey === currentScopeKey
      ));
      if (!matchesCurrentIdentity) {
        blockedScopeKeys.add(currentScopeKey);
        (recordsByScope.get(currentScopeKey) ?? []).forEach((record) => {
          blockedIds.add(record.candidate.id);
        });
        blockedIds.add(artifact.id);
        continue;
      }
    }

    const idMatchedScopeKeys = new Set(sameIdentityRecords.filter((record) => (
      artifact.id === record.candidate.id
      || artifact.id === record.currentId
      || artifact.id === record.legacyId
    )).map((record) => record.scopeKey));
    let matchingScopeKeys = idMatchedScopeKeys;
    if (matchingScopeKeys.size > 1) {
      const currentMatchedScopeKeys = new Set(sameIdentityRecords.filter((record) => (
        artifact.id === record.currentId
      )).map((record) => record.scopeKey));
      const nonCurrentMatchesAreLegacy = sameIdentityRecords
        .filter((record) => artifact.id !== record.currentId)
        .filter((record) => (
          artifact.id === record.candidate.id || artifact.id === record.legacyId
        ))
        .every((record) => artifact.id === record.legacyId);
      if (currentMatchedScopeKeys.size === 1 && nonCurrentMatchesAreLegacy) {
        matchingScopeKeys = currentMatchedScopeKeys;
      }
    }
    if (matchingScopeKeys.size !== 1) {
      const affectedRecords = referencedRecords.length > 0 ? referencedRecords : sameIdentityRecords;
      affectedRecords.forEach((record) => {
        blockedScopeKeys.add(record.scopeKey);
        blockedIds.add(record.candidate.id);
      });
      blockedIds.add(artifact.id);
      continue;
    }

    const scopeKey = [...matchingScopeKeys][0] as string;
    artifactGroups.set(scopeKey, [...(artifactGroups.get(scopeKey) ?? []), artifact]);
  }

  const artifactRequiredForByScope = new Map<string, readonly ('image' | 'audio')[]>();
  for (const [scopeKey, scopeArtifacts] of artifactGroups) {
    const scopeRecords = (recordsByScope.get(scopeKey) ?? [])
      .filter((record) => !discardedRecords.has(record));
    const requiredFor = resolveArtifactRequiredFor(scopeArtifacts);
    const candidateShaValues = scopeRecords.map((record) => normalizeSha256Digest(record.candidate.sha256));
    const candidateSizeValues = scopeRecords.map((record) => normalizePositiveSize(record.candidate.size));
    const artifactShaValues = scopeArtifacts.map((artifact) => normalizeSha256Digest(artifact.sha256));
    const artifactSizeValues = scopeArtifacts.map((artifact) => normalizePositiveSize(artifact.sizeBytes));
    if (
      requiredFor === null
      || valuesConflict([...candidateShaValues, ...artifactShaValues])
      || valuesConflict([...candidateSizeValues, ...artifactSizeValues])
    ) {
      blockedScopeKeys.add(scopeKey);
      scopeRecords.forEach((record) => blockedIds.add(record.candidate.id));
      scopeArtifacts.forEach((artifact) => blockedIds.add(artifact.id));
    } else {
      artifactRequiredForByScope.set(scopeKey, requiredFor);
    }
  }

  const preserveRuntimeState = options.preserveRuntimeState !== false;
  const canonicalCandidates: ProjectorArtifact[] = [];
  const canonicalCandidateByScope = new Map<string, ProjectorArtifact>();
  for (const [scopeKey, scopeRecords] of recordsByScope) {
    if (blockedScopeKeys.has(scopeKey)) {
      continue;
    }

    const activeScopeRecords = scopeRecords.filter((record) => !discardedRecords.has(record));
    if (activeScopeRecords.length === 0) {
      continue;
    }

    const candidate = mergeCandidateGroup(activeScopeRecords, preserveRuntimeState);
    canonicalCandidates.push(candidate);
    canonicalCandidateByScope.set(scopeKey, candidate);
  }

  canonicalCandidates.sort((left, right) => {
    const leftKey = getProjectorExactScopeKey(left) ?? left.id;
    const rightKey = getProjectorExactScopeKey(right) ?? right.id;
    return leftKey.localeCompare(rightKey);
  });

  const aliasToCanonicalId = new Map<string, string>();
  for (const [scopeKey, scopeRecords] of recordsByScope) {
    const canonical = canonicalCandidateByScope.get(scopeKey);
    if (!canonical) {
      continue;
    }

    aliasToCanonicalId.set(canonical.id, canonical.id);
    const currentScopeOwners = currentIdScopes.get(canonical.id);
    if ((currentScopeOwners?.size ?? 0) !== 1) {
      continue;
    }

    for (const record of scopeRecords.filter((entry) => !discardedRecords.has(entry))) {
      const rawOwners = rawIdScopes.get(record.candidate.id);
      const currentOwners = currentIdScopes.get(record.candidate.id);
      const hasOtherCurrentOwner = currentOwners !== undefined
        && (currentOwners.size > 1 || !currentOwners.has(scopeKey));
      if ((rawOwners?.size ?? 0) === 1 && !hasOtherCurrentOwner && !blockedIds.has(record.candidate.id)) {
        aliasToCanonicalId.set(record.candidate.id, canonical.id);
      }

      const legacyOwners = legacyIdScopes.get(record.legacyId);
      const legacyCurrentOwners = currentIdScopes.get(record.legacyId);
      const legacyCollidesWithOtherCurrent = legacyCurrentOwners !== undefined
        && (legacyCurrentOwners.size > 1 || !legacyCurrentOwners.has(scopeKey));
      if ((legacyOwners?.size ?? 0) === 1 && !legacyCollidesWithOtherCurrent) {
        aliasToCanonicalId.set(record.legacyId, canonical.id);
      } else if (record.legacyId !== canonical.id) {
        blockedIds.add(record.legacyId);
      }
    }
  }

  const canonicalArtifacts: ModelArtifactMetadata[] = [];
  for (const [scopeKey, scopeArtifacts] of artifactGroups) {
    const candidate = canonicalCandidateByScope.get(scopeKey);
    const requiredFor = artifactRequiredForByScope.get(scopeKey) ?? null;
    if (!candidate || !requiredFor) {
      continue;
    }

    canonicalArtifacts.push(mergeArtifactGroup(
      candidate,
      scopeArtifacts,
      requiredFor,
      preserveRuntimeState,
    ));
  }
  canonicalArtifacts.sort((left, right) => left.id.localeCompare(right.id));

  return {
    candidates: canonicalCandidates,
    artifacts: canonicalArtifacts,
    aliasToCanonicalId,
    blockedIds,
    blockedScopeKeys,
  };
}

export function remapProjectorAliasId(
  projectorId: string | null | undefined,
  result: Pick<CanonicalProjectorCandidatesResult, 'aliasToCanonicalId'>,
): string | undefined {
  const normalized = normalizeOptionalString(projectorId);
  return normalized ? result.aliasToCanonicalId.get(normalized) : undefined;
}
