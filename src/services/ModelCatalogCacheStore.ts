import {
  LifecycleStatus,
  ModelAccessState,
  type ModelArtifactMetadata,
  type ModelArtifactRequiredInput,
  type ModelMetadata,
  type ModelVariant,
} from '../types/models';
import type {
  CapabilityEvidence,
  ModelInputCapabilitySnapshot,
  NativeInputModality,
} from '../types/modelInputCapabilities';
import type { ProjectorArtifact, ProjectorMatchStatus, VisionCapabilitySource } from '../types/multimodal';
import {
  buildHuggingFaceResolveUrl,
  normalizeHuggingFaceRepoId,
  normalizeHuggingFaceFilePath,
  remoteProjectorIdentitiesEqual,
  remoteProjectorIdentityKey,
  resolveCatalogProjectorEvidenceIdentity,
  resolveHuggingFaceRevision,
  resolveHuggingFaceResolveIdentity,
  resolveRemoteProjectorIdentity,
  type RemoteProjectorIdentity,
} from '../utils/huggingFaceUrls';
import { buildMainModelArtifactId } from '../utils/modelArtifacts';
import {
  projectorArtifactMatchesCandidate,
  projectorArtifactUsesLegacyAlias,
} from '../utils/modelCapabilities';
import {
  getInputCapabilityEvidenceModalities,
  mergeCapabilityEvidence,
} from '../utils/modelInputCapabilities';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../utils/modelProjectors';
import {
  isExplicitMtpDraftFileName,
  isMtpGgufFileName,
} from '../utils/modelSpeculativeDecoding';
import {
  canonicalizeProjectorCandidateAliases,
  getExactProjectorScopeKey,
} from '../utils/projectorIdentity';
import { CATALOG_SEARCH_VARIANT_LIMIT, limitModelVariants } from './ModelCatalogFileSelector';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { createStorage } from './storage';

export type CatalogCacheAuthScope = 'anon' | 'auth';
export type CatalogCacheSort = 'downloads' | 'likes' | 'lastModified' | null;

export type CatalogCacheScope = {
  query: string;
  cursor: string | null;
  pageSize: number;
  sort: CatalogCacheSort;
  authScope: CatalogCacheAuthScope;
  gated?: boolean | null;
};

export type CatalogCacheResult = {
  models: ModelMetadata[];
  hasMore: boolean;
  nextCursor: string | null;
};

type SearchCacheEntry = {
  key: string;
  timestamp: number;
  scope: CatalogCacheScope;
  result: CatalogCacheResult;
};

type SnapshotCacheEntry = {
  key: string;
  id: string;
  authScope: CatalogCacheAuthScope;
  timestamp: number;
  model: ModelMetadata;
};

type PersistedPayload<T> = {
  version: number;
  sanitized?: boolean;
  entries: T[];
};

type ParsedPayload<T> = {
  status: 'empty' | 'invalid' | 'oversized' | 'ok';
  entries: T[];
  needsRewrite: boolean;
};

export type ModelCatalogCacheStoreOptions = {
  hydrateOnCreate?: boolean;
};

const STORAGE_ID = 'model-catalog-cache';
const SEARCH_CACHE_KEY = 'catalog-search-cache-v1';
const SNAPSHOT_CACHE_KEY = 'catalog-snapshot-cache-v1';
// Cache-tier persistence is intentionally limited to anonymous catalog data.
// Auth-scoped searches/snapshots can include gated/private access state, so
// they stay memory-only and anonymous snapshots are sanitized before storage.
export const MODEL_CATALOG_CACHE_PERSISTED_VERSION = 9;
export const MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES = 512_000;
// v8 payloads could grow large enough that their repeated migration audit
// blocked the JS thread for minutes on memory-constrained Android devices. Drop
// that optional cache before parsing; older compact payloads still migrate.
const SUPPORTED_PERSISTED_CACHE_VERSIONS = new Set([3, 4, 5, 6, 7, MODEL_CATALOG_CACHE_PERSISTED_VERSION]);
const MAX_PERSISTED_SEARCH_ENTRIES = 6;
const MAX_PERSISTED_SNAPSHOT_ENTRIES = 40;
const PERSISTED_CACHE_KEYS = [SEARCH_CACHE_KEY, SNAPSHOT_CACHE_KEY] as const;
const CATALOG_SAFE_VISION_SOURCES = new Set<VisionCapabilitySource>(['catalog_metadata', 'tree_probe']);
const CATALOG_SAFE_ARTIFACT_REQUIRED_INPUTS = new Set<ModelArtifactRequiredInput>(['text', 'image', 'audio']);

type CatalogVisionRuntimeSource = Pick<ModelMetadata | ModelVariant, 'visionSource'> & Partial<Pick<
  ModelMetadata | ModelVariant,
  'chatModalities' | 'projectorCandidates' | 'visionConfidence'
>> & Partial<Pick<ModelMetadata, 'artifacts' | 'inputCapabilities' | 'id'>>;

export type CatalogSafeNativeCapabilityContext = {
  vision: boolean;
  audio: boolean;
  projectorEvidenceFileNames: ReadonlySet<string>;
  projectorEvidenceIdentityKeys: ReadonlySet<string>;
  projectorCandidateScopeIds: ReadonlySet<string>;
};

type CatalogSanitizationOptions = {
  persistedVersion?: number;
  rawModel?: unknown;
};

type CatalogProjectorIdentityAudit = {
  identitiesByKey: ReadonlyMap<string, RemoteProjectorIdentity>;
  candidateIdentityKeys: ReadonlySet<string>;
  identityKeysByFoldedPath: ReadonlyMap<string, ReadonlySet<string>>;
  identityKeysByFoldedBasename: ReadonlyMap<string, ReadonlySet<string>>;
  candidateIdsByLegacyAlias: ReadonlyMap<string, ReadonlySet<string>>;
  candidateScopeIdsById: ReadonlyMap<string, ReadonlySet<string>>;
  poisonedCandidateScopeIds: ReadonlySet<string>;
  poisonedFoldedPaths: ReadonlySet<string>;
  poisonedFoldedBasenames: ReadonlySet<string>;
  evidenceIdentityKeys: ReadonlySet<string>;
};

function isPublicAnonymousModel(model: ModelMetadata): boolean {
  return model.accessState === ModelAccessState.PUBLIC
    && model.isGated !== true
    && model.isPrivate !== true;
}

function hasSafeAnonymousPersistedAccessState(model: ModelMetadata): boolean {
  return model.isPrivate !== true && (
    isPublicAnonymousModel(model)
    || model.accessState === ModelAccessState.AUTH_REQUIRED
  );
}

function sanitizeCatalogProjectorMatchStatus(projector: ProjectorArtifact): ProjectorMatchStatus {
  if (projector.matchStatus === 'failed' || projector.matchStatus === 'user_selected') {
    return 'missing';
  }

  if (projector.matchReason === 'multiple_projector_candidates') {
    return 'ambiguous';
  }

  if (projector.matchReason === 'single_projector_candidate') {
    return 'matched';
  }

  return projector.matchStatus;
}

function sanitizeCatalogProjectorMatchReason(projector: ProjectorArtifact): string | undefined {
  return projector.matchReason === 'single_projector_candidate'
    || projector.matchReason === 'deterministic_filename_affinity'
    || projector.matchReason === 'multiple_projector_candidates'
    ? projector.matchReason
    : undefined;
}

function modelHasCatalogSafeVisionSource(model: Pick<ModelMetadata, 'visionSource'>): boolean {
  return Boolean(model.visionSource && CATALOG_SAFE_VISION_SOURCES.has(model.visionSource));
}

function modelArtifactsRequireAudioProjector(artifacts: ModelMetadata['artifacts']): boolean {
  return artifacts?.some((artifact) => (
    artifact.kind === 'multimodal_projector' && artifact.requiredFor.includes('audio')
  )) === true;
}

function modelHasCatalogAudioCapabilitySignal(
  model: Partial<Pick<ModelMetadata, 'artifacts' | 'chatModalities' | 'inputCapabilities'>>,
): boolean {
  return model.chatModalities?.includes('audio') === true
    || model.inputCapabilities?.declared.audio === 'supported'
    || modelArtifactsRequireAudioProjector(model.artifacts);
}

function modelHasCatalogSafeAudioCapabilityEvidence(
  model: Partial<Pick<ModelMetadata, 'inputCapabilities'>>,
): boolean {
  return model.inputCapabilities?.evidence.some((entry) => {
    if (entry.source === 'runtime' || entry.source === 'projector') {
      return false;
    }

    return getInputCapabilityEvidenceModalities(entry).includes('audio');
  }) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addIdentityToIndex(
  index: Map<string, Set<string>>,
  alias: string,
  identityKey: string,
): void {
  const keys = index.get(alias) ?? new Set<string>();
  keys.add(identityKey);
  index.set(alias, keys);
}

function getFoldedProjectorBasename(filePath: string): string {
  return filePath.split('/').pop()?.toLowerCase() ?? filePath.toLowerCase();
}

function getCatalogProjectorCandidateScopeId(
  identity: RemoteProjectorIdentity,
  ownerVariantId: unknown,
  ownerModelId: string,
): string {
  return getExactProjectorScopeKey({
    ownerModelId,
    ...(typeof ownerVariantId === 'string' && ownerVariantId.trim()
      ? { ownerVariantId: ownerVariantId.trim() }
      : {}),
    repoId: identity.repoId,
    revision: identity.revision,
    filePath: identity.filePath,
  });
}

function normalizeConservativePoisonedProjectorPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const segments = value.trim()
    .replace(/\\+/gu, '/')
    .replace(/\/+/gu, '/')
    .split('/')
    .map((segment) => segment.replace(/[\u0000-\u001f\u007f]/gu, '').trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  return segments.length > 0 ? segments.join('/') : null;
}

function resolveCatalogProjectorArtifactIdentity(
  artifact: Partial<ModelArtifactMetadata>,
): RemoteProjectorIdentity | null {
  const identity = resolveHuggingFaceResolveIdentity(artifact.downloadUrl);
  const remoteFileName = normalizeHuggingFaceFilePath(artifact.remoteFileName);
  if (
    (artifact.kind !== 'multimodal_projector' && artifact.kind !== 'speculative_draft')
    || !identity
    || remoteFileName !== identity.filePath
    || resolveHuggingFaceRevision(artifact.hfRevision) !== identity.revision
  ) {
    return null;
  }

  return identity;
}

function resolveCatalogProjectorCandidateIdentity(
  projector: Partial<ProjectorArtifact>,
  ownerModelId: string,
): RemoteProjectorIdentity | null {
  if (projector.ownerModelId !== ownerModelId) {
    return null;
  }

  return resolveRemoteProjectorIdentity({
    repoId: projector.repoId,
    revision: projector.hfRevision,
    filePath: projector.fileName,
    downloadUrl: projector.downloadUrl,
  });
}

function getRawProjectorCandidates(rawModel: unknown): Partial<ProjectorArtifact>[] {
  if (!isRecord(rawModel)) {
    return [];
  }

  const modelCandidates = Array.isArray(rawModel.projectorCandidates)
    ? rawModel.projectorCandidates.filter(isRecord)
    : [];
  const variantCandidates = Array.isArray(rawModel.variants)
    ? rawModel.variants.filter(isRecord).flatMap((variant) => (
      Array.isArray(variant.projectorCandidates)
        ? variant.projectorCandidates.filter(isRecord)
        : []
    ))
    : [];
  return [...modelCandidates, ...variantCandidates] as Partial<ProjectorArtifact>[];
}

function getRawProjectorArtifacts(rawModel: unknown): Partial<ModelArtifactMetadata>[] {
  if (!isRecord(rawModel) || !Array.isArray(rawModel.artifacts)) {
    return [];
  }

  return rawModel.artifacts.filter((artifact) => (
    isRecord(artifact) && artifact.kind === 'multimodal_projector'
  )) as Partial<ModelArtifactMetadata>[];
}

function getRawProjectorEvidence(rawModel: unknown): CapabilityEvidence[] {
  if (!isRecord(rawModel) || !isRecord(rawModel.inputCapabilities)) {
    return [];
  }

  return Array.isArray(rawModel.inputCapabilities.evidence)
    ? rawModel.inputCapabilities.evidence.filter(isRecord) as unknown as CapabilityEvidence[]
    : [];
}

function buildCatalogProjectorIdentityAudit(
  model: ModelMetadata,
  options: CatalogSanitizationOptions,
): CatalogProjectorIdentityAudit {
  const rawModel = options.rawModel ?? model;
  const owningRepoId = normalizeHuggingFaceRepoId(model.id);
  const owningRevision = resolveHuggingFaceRevision(model.hfRevision);
  const identitiesByKey = new Map<string, RemoteProjectorIdentity>();
  const candidateIdentityKeys = new Set<string>();
  const identityKeysByFoldedPath = new Map<string, Set<string>>();
  const identityKeysByFoldedBasename = new Map<string, Set<string>>();
  const candidateIdsByLegacyAlias = new Map<string, Set<string>>();
  const candidateScopeIdsById = new Map<string, Set<string>>();
  const poisonedCandidateScopeIds = new Set<string>();
  const poisonedFoldedPaths = new Set<string>();
  const poisonedFoldedBasenames = new Set<string>();

  const recordPoisonedPath = (value: unknown): void => {
    const filePath = normalizeHuggingFaceFilePath(value)
      ?? normalizeConservativePoisonedProjectorPath(value);
    if (!filePath) {
      return;
    }

    poisonedFoldedPaths.add(filePath.toLowerCase());
    poisonedFoldedBasenames.add(getFoldedProjectorBasename(filePath));
  };
  const recordIdentity = (identity: RemoteProjectorIdentity): string => {
    const identityKey = remoteProjectorIdentityKey(identity);
    identitiesByKey.set(identityKey, identity);
    addIdentityToIndex(identityKeysByFoldedPath, identity.filePath.toLowerCase(), identityKey);
    addIdentityToIndex(
      identityKeysByFoldedBasename,
      getFoldedProjectorBasename(identity.filePath),
      identityKey,
    );
    return identityKey;
  };

  const candidateRecords: {
    projector: ProjectorArtifact;
    identity: RemoteProjectorIdentity;
    currentScopeId: string;
    currentId: string;
    legacyId: string;
  }[] = [];
  for (const projector of getRawProjectorCandidates(rawModel)) {
    const candidateRepoId = normalizeHuggingFaceRepoId(projector.repoId);
    const belongsToOwningRepository = projector.ownerModelId === model.id
      && owningRepoId !== null
      && candidateRepoId === owningRepoId;
    if (!belongsToOwningRepository) {
      continue;
    }

    const identity = resolveCatalogProjectorCandidateIdentity(projector, model.id);
    if (!identity) {
      recordPoisonedPath(projector.fileName);
      continue;
    }

    const identityKey = recordIdentity(identity);
    if (identity.revision === owningRevision) {
      candidateIdentityKeys.add(identityKey);
    }
    const idInput = {
      repoId: identity.repoId,
      hfRevision: identity.revision,
      fileName: identity.filePath,
      ...(typeof projector.ownerVariantId === 'string' && projector.ownerVariantId.trim()
        ? { ownerVariantId: projector.ownerVariantId.trim() }
        : {}),
    };
    const currentScopeId = getCatalogProjectorCandidateScopeId(
      identity,
      idInput.ownerVariantId,
      model.id,
    );
    const currentId = buildProjectorArtifactId(idInput);
    const legacyId = buildLegacyProjectorArtifactId(idInput);
    addIdentityToIndex(
      candidateIdsByLegacyAlias,
      legacyId,
      currentScopeId,
    );
    if (typeof projector.id === 'string' && projector.id.trim()) {
      const canonicalProjector = {
        ...projector,
        id: projector.id.trim(),
      } as ProjectorArtifact;
      addIdentityToIndex(candidateScopeIdsById, canonicalProjector.id, currentScopeId);
      addIdentityToIndex(candidateScopeIdsById, currentId, currentScopeId);
      candidateRecords.push({
        projector: canonicalProjector,
        identity,
        currentScopeId,
        currentId,
        legacyId,
      });
    }
  }

  const artifactRecords = getRawProjectorArtifacts(rawModel).map((rawArtifact) => {
    const artifact = {
      ...rawArtifact,
      ...(typeof rawArtifact.id === 'string' ? { id: rawArtifact.id.trim() } : {}),
    };
    return {
      artifact,
      identity: resolveCatalogProjectorArtifactIdentity(artifact),
    };
  });
  for (const candidateRecord of candidateRecords) {
    const legacyAliasIsUnique = (candidateIdsByLegacyAlias.get(candidateRecord.legacyId)?.size ?? 0) === 1;
    let relatedRequiredForKey: string | undefined;
    for (const artifactRecord of artifactRecords) {
      const artifact = artifactRecord.artifact;
      const isRelated = artifact.id === candidateRecord.projector.id
        || artifact.id === candidateRecord.currentId
        || artifact.id === candidateRecord.legacyId
        || Boolean(
          artifactRecord.identity
          && remoteProjectorIdentitiesEqual(artifactRecord.identity, candidateRecord.identity),
        );
      if (!isRelated) {
        continue;
      }

      const normalizedRequiredFor = Array.isArray(artifact.requiredFor)
        ? [...new Set(artifact.requiredFor.filter((entry) => entry === 'image' || entry === 'audio'))]
          .sort()
        : [];
      const requiredForKey = JSON.stringify(normalizedRequiredFor);
      if (
        normalizedRequiredFor.length === 0
        || (relatedRequiredForKey !== undefined && relatedRequiredForKey !== requiredForKey)
      ) {
        poisonedCandidateScopeIds.add(candidateRecord.currentScopeId);
      } else {
        relatedRequiredForKey = requiredForKey;
      }

      if (
        (projectorArtifactUsesLegacyAlias(
          artifact as ModelArtifactMetadata,
          candidateRecord.projector,
        ) && !legacyAliasIsUnique)
        || !projectorArtifactMatchesCandidate(
          artifact as ModelArtifactMetadata,
          candidateRecord.projector,
        )
      ) {
        poisonedCandidateScopeIds.add(candidateRecord.currentScopeId);
      }
    }
  }

  const isLegacyPayload = typeof options.persistedVersion === 'number'
    && options.persistedVersion < MODEL_CATALOG_CACHE_PERSISTED_VERSION;
  const evidenceIdentityKeys = new Set<string>();
  for (const evidence of getRawProjectorEvidence(rawModel)) {
    if (evidence.source !== 'projector' || typeof evidence.value !== 'string') {
      continue;
    }

    const evidenceIdentity = resolveCatalogProjectorEvidenceIdentity(model, evidence.value);
    if (!evidenceIdentity) {
      continue;
    }

    if (!isLegacyPayload) {
      const identityKey = remoteProjectorIdentityKey(evidenceIdentity);
      if (candidateIdentityKeys.has(identityKey)) {
        evidenceIdentityKeys.add(identityKey);
      }
      continue;
    }

    const normalizedPath = evidenceIdentity.filePath;
    const isFullPathEvidence = /[\\/]/u.test(evidence.value.trim());
    const alias = isFullPathEvidence
      ? normalizedPath.toLowerCase()
      : getFoldedProjectorBasename(normalizedPath);
    const identityKeys = isFullPathEvidence
      ? identityKeysByFoldedPath.get(alias)
      : identityKeysByFoldedBasename.get(alias);
    const isPoisoned = isFullPathEvidence
      ? poisonedFoldedPaths.has(alias)
      : poisonedFoldedBasenames.has(alias);
    if (!isPoisoned && identityKeys?.size === 1) {
      const identityKey = [...identityKeys][0] as string;
      if (candidateIdentityKeys.has(identityKey)) {
        evidenceIdentityKeys.add(identityKey);
      }
    }
  }

  return {
    identitiesByKey,
    candidateIdentityKeys,
    identityKeysByFoldedPath,
    identityKeysByFoldedBasename,
    candidateIdsByLegacyAlias,
    candidateScopeIdsById,
    poisonedCandidateScopeIds,
    poisonedFoldedPaths,
    poisonedFoldedBasenames,
    evidenceIdentityKeys,
  };
}

function canonicalizeCatalogProjectorCandidate(
  projector: ProjectorArtifact,
  ownerModelId: string,
): ProjectorArtifact | null {
  const identity = resolveCatalogProjectorCandidateIdentity(projector, ownerModelId);
  if (!identity) {
    return null;
  }

  const idInput = {
    repoId: identity.repoId,
    hfRevision: identity.revision,
    fileName: identity.filePath,
    ...(projector.ownerVariantId?.trim() ? { ownerVariantId: projector.ownerVariantId.trim() } : {}),
  };
  return {
    ...projector,
    id: projector.id.trim(),
    ownerModelId,
    ...(idInput.ownerVariantId ? { ownerVariantId: idInput.ownerVariantId } : { ownerVariantId: undefined }),
    repoId: identity.repoId,
    hfRevision: identity.revision,
    fileName: identity.filePath,
    downloadUrl: buildHuggingFaceResolveUrl(identity.repoId, identity.filePath, identity.revision),
  };
}

function artifactIsRelatedToProjector(
  artifact: ModelArtifactMetadata,
  projector: ProjectorArtifact,
  identity: RemoteProjectorIdentity,
): boolean {
  if (artifact.kind !== 'multimodal_projector') {
    return false;
  }

  const artifactIdentity = resolveCatalogProjectorArtifactIdentity(artifact);
  const idInput = {
    repoId: identity.repoId,
    hfRevision: identity.revision,
    fileName: identity.filePath,
    ownerVariantId: projector.ownerVariantId,
  };
  const currentId = buildProjectorArtifactId(idInput);
  const legacyId = buildLegacyProjectorArtifactId(idInput);
  return artifact.id === projector.id
    || artifact.id === currentId
    || artifact.id === legacyId
    || Boolean(artifactIdentity && remoteProjectorIdentitiesEqual(artifactIdentity, identity));
}

function catalogProjectorRepresentationSupportsInput(
  model: CatalogVisionRuntimeSource,
  projector: ProjectorArtifact,
  identity: RemoteProjectorIdentity,
  input: 'image' | 'audio',
  audit: CatalogProjectorIdentityAudit,
): boolean {
  const relatedArtifacts = model.artifacts?.filter((artifact) => (
    artifactIsRelatedToProjector(artifact, projector, identity)
  )) ?? [];
  if (relatedArtifacts.length === 0) {
    return true;
  }

  const legacyId = buildLegacyProjectorArtifactId({
    repoId: identity.repoId,
    hfRevision: identity.revision,
    fileName: identity.filePath,
    ownerVariantId: projector.ownerVariantId,
  });
  const currentScopeId = getCatalogProjectorCandidateScopeId(
    identity,
    projector.ownerVariantId,
    projector.ownerModelId,
  );
  const legacyAliasIsUnique = (audit.candidateIdsByLegacyAlias.get(legacyId)?.size ?? 0) === 1;
  const allCompatible = relatedArtifacts.every((artifact) => (
    !(projectorArtifactUsesLegacyAlias(artifact, projector) && !legacyAliasIsUnique)
    && (
      projectorArtifactMatchesCandidate(artifact, projector)
      || audit.candidateScopeIdsById.get(artifact.id)?.has(currentScopeId) === true
    )
  ));
  return allCompatible && relatedArtifacts.some((artifact) => artifact.requiredFor.includes(input));
}

function createCatalogSafeNativeCapabilityContext(
  model: CatalogVisionRuntimeSource,
  ownerModelId: string,
  audit: CatalogProjectorIdentityAudit,
): CatalogSafeNativeCapabilityContext {
  const hasExplicitChatModalities = Array.isArray(model.chatModalities);
  const permitsVision = !hasExplicitChatModalities || model.chatModalities?.includes('vision') === true;
  const permitsAudio = !hasExplicitChatModalities || model.chatModalities?.includes('audio') === true;
  const vision = permitsVision && modelHasCatalogSafeVisionSource(model);
  const hasCatalogSafeAudioSignal = permitsAudio
    && modelHasCatalogAudioCapabilitySignal(model)
    && modelHasCatalogSafeAudioCapabilityEvidence(model);
  const candidates = model.projectorCandidates?.flatMap((projector) => {
    const canonical = canonicalizeCatalogProjectorCandidate(projector, ownerModelId);
    return canonical ? [canonical] : [];
  }) ?? [];
  const visionIdentityKeys = new Set<string>();
  const audioIdentityKeys = new Set<string>();
  const visionCandidateScopeIds = new Set<string>();
  const audioCandidateScopeIds = new Set<string>();
  for (const projector of candidates) {
    const identity = resolveCatalogProjectorCandidateIdentity(projector, ownerModelId);
    if (!identity) {
      continue;
    }

    const identityKey = remoteProjectorIdentityKey(identity);
    if (
      !audit.evidenceIdentityKeys.has(identityKey)
      || (audit.candidateScopeIdsById.get(projector.id)?.size ?? 0) !== 1
    ) {
      continue;
    }
    const currentScopeId = getCatalogProjectorCandidateScopeId(
      identity,
      projector.ownerVariantId,
      ownerModelId,
    );
    if (audit.poisonedCandidateScopeIds.has(currentScopeId)) {
      continue;
    }
    if (vision && catalogProjectorRepresentationSupportsInput(model, projector, identity, 'image', audit)) {
      visionIdentityKeys.add(identityKey);
      visionCandidateScopeIds.add(currentScopeId);
    }
    if (
      hasCatalogSafeAudioSignal
      && catalogProjectorRepresentationSupportsInput(model, projector, identity, 'audio', audit)
    ) {
      audioIdentityKeys.add(identityKey);
      audioCandidateScopeIds.add(currentScopeId);
    }
  }
  const projectorEvidenceIdentityKeys = new Set([...visionIdentityKeys, ...audioIdentityKeys]);
  const projectorCandidateScopeIds = new Set([
    ...visionCandidateScopeIds,
    ...audioCandidateScopeIds,
  ]);
  const projectorEvidenceFileNames = new Set(
    [...projectorEvidenceIdentityKeys].flatMap((identityKey) => {
      const identity = audit.identitiesByKey.get(identityKey);
      return identity ? [identity.filePath] : [];
    }),
  );
  const audio = audioIdentityKeys.size > 0;

  return {
    vision,
    audio,
    projectorEvidenceFileNames,
    projectorEvidenceIdentityKeys,
    projectorCandidateScopeIds,
  };
}

function mergeCatalogSafeNativeCapabilityContexts(
  contexts: readonly CatalogSafeNativeCapabilityContext[],
): CatalogSafeNativeCapabilityContext {
  return {
    vision: contexts.some((context) => context.vision),
    audio: contexts.some((context) => context.audio),
    projectorEvidenceFileNames: new Set(
      contexts.flatMap((context) => [...context.projectorEvidenceFileNames]),
    ),
    projectorEvidenceIdentityKeys: new Set(
      contexts.flatMap((context) => [...context.projectorEvidenceIdentityKeys]),
    ),
    projectorCandidateScopeIds: new Set(
      contexts.flatMap((context) => [...context.projectorCandidateScopeIds]),
    ),
  };
}

function normalizeArtifactRequiredFor(requiredFor: ModelArtifactMetadata['requiredFor']): ModelArtifactRequiredInput[] {
  return [...new Set(requiredFor.filter((entry): entry is ModelArtifactRequiredInput => (
    CATALOG_SAFE_ARTIFACT_REQUIRED_INPUTS.has(entry)
  )))];
}

function resolveCatalogMainModelIdentity(
  model: Pick<ModelMetadata, 'downloadUrl' | 'hfRevision' | 'id' | 'resolvedFileName'>,
): RemoteProjectorIdentity | null {
  return resolveRemoteProjectorIdentity({
    repoId: model.id,
    revision: model.hfRevision,
    filePath: model.resolvedFileName,
    downloadUrl: model.downloadUrl,
  });
}

function sanitizeCatalogArtifactRequiredFor(
  artifact: ModelArtifactMetadata,
  context: CatalogSafeNativeCapabilityContext,
  projectorIdentity?: RemoteProjectorIdentity,
): ModelArtifactRequiredInput[] {
  return normalizeArtifactRequiredFor(artifact.requiredFor).filter((requiredInput) => {
    if (requiredInput === 'text') {
      return artifact.kind === 'main_model' || artifact.kind === 'speculative_draft';
    }

    if (requiredInput === 'image') {
      return context.vision && (
        artifact.kind === 'main_model'
        || Boolean(
          projectorIdentity
          && context.projectorEvidenceIdentityKeys.has(remoteProjectorIdentityKey(projectorIdentity)),
        )
      );
    }

    return context.audio && (
      artifact.kind === 'main_model'
      || Boolean(
        projectorIdentity
        && context.projectorEvidenceIdentityKeys.has(remoteProjectorIdentityKey(projectorIdentity)),
      )
    );
  });
}

function sanitizeCatalogModelArtifacts(
  model: ModelMetadata,
  context: CatalogSafeNativeCapabilityContext,
  projectorCandidates: readonly ProjectorArtifact[],
  audit: CatalogProjectorIdentityAudit,
  resolveProjectorContext: (projector: ProjectorArtifact) => CatalogSafeNativeCapabilityContext,
): ModelMetadata['artifacts'] {
  const artifacts: ModelArtifactMetadata[] = [];
  const mainIdentity = resolveCatalogMainModelIdentity(model);
  if (mainIdentity) {
    const persistedMainArtifact = model.artifacts?.find((artifact) => artifact.kind === 'main_model');
    const persistedMainIdentity = persistedMainArtifact
      ? resolveRemoteProjectorIdentity({
        repoId: model.id,
        revision: persistedMainArtifact.hfRevision,
        filePath: persistedMainArtifact.remoteFileName,
        downloadUrl: persistedMainArtifact.downloadUrl,
      })
      : null;
    const canonicalMainArtifact: ModelArtifactMetadata = {
      id: buildMainModelArtifactId(model),
      kind: 'main_model',
      requiredFor: ['text'],
      hfRevision: mainIdentity.revision,
      remoteFileName: mainIdentity.filePath,
      downloadUrl: buildHuggingFaceResolveUrl(
        mainIdentity.repoId,
        mainIdentity.filePath,
        mainIdentity.revision,
      ),
      sizeBytes: model.size,
      installState: 'remote',
    };
    const requiredForSource = persistedMainArtifact
      && persistedMainIdentity
      && remoteProjectorIdentitiesEqual(persistedMainIdentity, mainIdentity)
      ? persistedMainArtifact
      : canonicalMainArtifact;
    const requiredFor = [
      'text' as const,
      ...sanitizeCatalogArtifactRequiredFor(requiredForSource, context)
        .filter((requiredInput) => requiredInput !== 'text'),
    ];
    if (requiredFor.length > 0) {
      artifacts.push({
        id: buildMainModelArtifactId(model),
        kind: 'main_model',
        requiredFor,
        hfRevision: mainIdentity.revision,
        remoteFileName: mainIdentity.filePath,
        downloadUrl: buildHuggingFaceResolveUrl(
          mainIdentity.repoId,
          mainIdentity.filePath,
          mainIdentity.revision,
        ),
        sizeBytes: model.size,
        ...(model.metadataTrust !== 'verified_local' && model.sha256 ? { sha256: model.sha256 } : {}),
        installState: 'remote',
      });
    }
  }

  for (const artifact of model.artifacts ?? []) {
    if (artifact.kind === 'speculative_draft') {
      const artifactIdentity = resolveCatalogProjectorArtifactIdentity(artifact);
      const owningRepoId = normalizeHuggingFaceRepoId(model.id);
      const owningRevision = resolveHuggingFaceRevision(model.hfRevision);
      if (
        artifactIdentity
        && owningRepoId
        && artifactIdentity.repoId === owningRepoId
        && artifactIdentity.revision === owningRevision
        && (
          isMtpGgufFileName(artifactIdentity.filePath)
          || (
            artifactIdentity.filePath.toLowerCase().endsWith('.gguf')
            && isExplicitMtpDraftFileName(artifactIdentity.filePath)
          )
        )
      ) {
        artifacts.push({
          id: artifact.id,
          kind: 'speculative_draft',
          requiredFor: ['text'],
          hfRevision: artifactIdentity.revision,
          remoteFileName: artifactIdentity.filePath,
          downloadUrl: buildHuggingFaceResolveUrl(
            artifactIdentity.repoId,
            artifactIdentity.filePath,
            artifactIdentity.revision,
          ),
          sizeBytes: artifact.sizeBytes,
          ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
          installState: 'remote',
        });
      }
      continue;
    }

    if (artifact.kind !== 'multimodal_projector') {
      continue;
    }

    const artifactIdentity = resolveCatalogProjectorArtifactIdentity(artifact);
    if (!artifactIdentity) {
      continue;
    }

    const matchingCandidates = projectorCandidates.filter((projector) => {
      const projectorIdentity = resolveCatalogProjectorCandidateIdentity(projector, model.id);
      if (!projectorIdentity || !remoteProjectorIdentitiesEqual(projectorIdentity, artifactIdentity)) {
        return false;
      }

      const legacyId = buildLegacyProjectorArtifactId({
        repoId: projectorIdentity.repoId,
        hfRevision: projectorIdentity.revision,
        fileName: projectorIdentity.filePath,
        ownerVariantId: projector.ownerVariantId,
      });
      const legacyAliasIsUnique = (audit.candidateIdsByLegacyAlias.get(legacyId)?.size ?? 0) === 1;
      const candidateScopeId = getCatalogProjectorCandidateScopeId(
        projectorIdentity,
        projector.ownerVariantId,
        model.id,
      );
      return (!projectorArtifactUsesLegacyAlias(artifact, projector) || legacyAliasIsUnique)
        && (
          projectorArtifactMatchesCandidate(artifact, projector)
          || audit.candidateScopeIdsById.get(artifact.id)?.has(candidateScopeId) === true
        );
    });
    if (matchingCandidates.length !== 1) {
      continue;
    }

    const projector = matchingCandidates[0] as ProjectorArtifact;
    const projectorContext = resolveProjectorContext(projector);
    const requiredFor = sanitizeCatalogArtifactRequiredFor(
      artifact,
      projectorContext,
      artifactIdentity,
    );
    if (requiredFor.length === 0) {
      continue;
    }

    artifacts.push({
      id: projector.id,
      kind: 'multimodal_projector',
      requiredFor,
      hfRevision: artifactIdentity.revision,
      remoteFileName: artifactIdentity.filePath,
      downloadUrl: buildHuggingFaceResolveUrl(
        artifactIdentity.repoId,
        artifactIdentity.filePath,
        artifactIdentity.revision,
      ),
      sizeBytes: projector.size,
      ...(projector.sha256 ? { sha256: projector.sha256 } : {}),
      installState: 'remote',
    });
  }

  return artifacts.length > 0 ? artifacts : undefined;
}

function isCatalogEvidenceModalitySafe(
  modality: NativeInputModality,
  context: CatalogSafeNativeCapabilityContext,
): boolean {
  return modality === 'video'
    || (modality === 'image' && context.vision)
    || (modality === 'audio' && context.audio);
}

function getCatalogSafeEvidenceValue(
  source: CapabilityEvidence['source'],
  modality: NativeInputModality,
): string {
  if (source === 'pipeline_tag') {
    return modality === 'image'
      ? 'image-text-to-text'
      : modality === 'audio' ? 'audio-text-to-text' : 'video-text-to-text';
  }

  return modality === 'image' ? 'vision' : modality;
}

function sanitizeCatalogCapabilityEvidence(
  entry: CapabilityEvidence,
  context: CatalogSafeNativeCapabilityContext,
): CapabilityEvidence[] {
  if (entry.source === 'runtime') {
    return [];
  }

  if (entry.source === 'projector') {
    return [...context.projectorEvidenceFileNames].map((fileName) => ({
      ...entry,
      value: fileName,
    }));
  }

  const modalities = getInputCapabilityEvidenceModalities(entry);
  if (modalities.length === 0) {
    return [entry];
  }

  const safeModalities = modalities.filter((modality) => (
    isCatalogEvidenceModalitySafe(modality, context)
  ));
  if (safeModalities.length === 0) {
    return [];
  }

  if (safeModalities.length === modalities.length) {
    return [entry];
  }

  return safeModalities.map((modality) => ({
    ...entry,
    value: getCatalogSafeEvidenceValue(entry.source, modality),
  }));
}

export function sanitizeCatalogInputCapabilities(
  snapshot: ModelInputCapabilitySnapshot | undefined,
  context: CatalogSafeNativeCapabilityContext,
): ModelInputCapabilitySnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  const evidence = mergeCapabilityEvidence(snapshot.evidence.flatMap((entry) => (
    sanitizeCatalogCapabilityEvidence(entry, context)
  )));
  const hasCatalogVideoEvidence = evidence.some((entry) => (
    entry.source !== 'runtime'
    && getInputCapabilityEvidenceModalities(entry).includes('video')
  ));
  const declared: ModelInputCapabilitySnapshot['declared'] = {
    ...snapshot.declared,
    image: context.vision ? snapshot.declared.image : 'unknown',
    audio: context.audio ? snapshot.declared.audio : 'unknown',
    video: snapshot.declared.video === 'supported' && !hasCatalogVideoEvidence
      ? 'unknown'
      : snapshot.declared.video,
  };
  const hasUsefulDeclaration = Object.values(declared).some((state) => state !== 'unknown');
  if (!hasUsefulDeclaration && evidence.length === 0) {
    return undefined;
  }

  return {
    detectedAt: snapshot.detectedAt,
    declared,
    evidence,
  };
}

function sanitizeCatalogChatModalities(
  chatModalities: ModelMetadata['chatModalities'],
  context: CatalogSafeNativeCapabilityContext,
): ModelMetadata['chatModalities'] {
  if (!Array.isArray(chatModalities)) {
    return chatModalities;
  }

  const sanitized = chatModalities.filter((modality) => (
    modality === 'text'
    || (modality === 'vision' && context.vision)
    || (modality === 'audio' && context.audio)
  ));

  return sanitized.length > 0 ? sanitized : undefined;
}

export function sanitizeCatalogProjectorRuntimeState(
  projectors: ModelMetadata['projectorCandidates'],
  context: CatalogSafeNativeCapabilityContext,
  ownerModelId: string,
  artifacts: ModelMetadata['artifacts'],
  resolveContext: (
    projector: ProjectorArtifact,
  ) => CatalogSafeNativeCapabilityContext = () => context,
): ModelMetadata['projectorCandidates'] {
  if (!Array.isArray(projectors)) {
    return undefined;
  }

  if (projectors.length === 0) {
    return [];
  }

  const sanitized = projectors.flatMap((projector): ProjectorArtifact[] => {
    const canonicalProjector = canonicalizeCatalogProjectorCandidate(projector, ownerModelId);
    if (!canonicalProjector) {
      return [];
    }

    const identity = resolveCatalogProjectorCandidateIdentity(canonicalProjector, ownerModelId);
    const projectorContext = resolveContext(canonicalProjector);
    const candidateScopeId = identity
      ? getCatalogProjectorCandidateScopeId(
          identity,
          canonicalProjector.ownerVariantId,
          ownerModelId,
        )
      : null;
    if (
      !identity
      || !candidateScopeId
      || !projectorContext.projectorEvidenceIdentityKeys.has(remoteProjectorIdentityKey(identity))
      || !projectorContext.projectorCandidateScopeIds.has(candidateScopeId)
    ) {
      return [];
    }

    return [{
      ...canonicalProjector,
      localPath: undefined,
      resumeData: undefined,
      downloadProgress: undefined,
      lifecycleStatus: 'available' as const,
      matchStatus: sanitizeCatalogProjectorMatchStatus(canonicalProjector),
      matchReason: sanitizeCatalogProjectorMatchReason(canonicalProjector),
    }];
  });

  if (sanitized.length === 0) {
    return undefined;
  }

  const canonical = canonicalizeProjectorCandidateAliases(
    sanitized,
    artifacts,
    { preserveRuntimeState: false },
  );
  return canonical.candidates.length > 0 ? canonical.candidates : undefined;
}

type CatalogSafeVariantCapability = {
  context: CatalogSafeNativeCapabilityContext;
  projectorCandidates: readonly ProjectorArtifact[];
};

function getVariantIdentityKeys(variant: ModelVariant): ReadonlySet<string> {
  return new Set([variant.variantId.trim(), variant.fileName.trim()].filter(Boolean));
}

function isProjectorCompatibleWithVariant(
  projector: ProjectorArtifact,
  variant: ModelVariant,
): boolean {
  const ownerVariantId = projector.ownerVariantId?.trim();
  return !ownerVariantId || getVariantIdentityKeys(variant).has(ownerVariantId);
}

function projectorCandidatesShareIdentity(
  left: ProjectorArtifact,
  right: ProjectorArtifact,
): boolean {
  const leftIdentity = resolveRemoteProjectorIdentity({
    repoId: left.repoId,
    revision: left.hfRevision,
    filePath: left.fileName,
    downloadUrl: left.downloadUrl,
  });
  const rightIdentity = resolveRemoteProjectorIdentity({
    repoId: right.repoId,
    revision: right.hfRevision,
    filePath: right.fileName,
    downloadUrl: right.downloadUrl,
  });
  return Boolean(
    leftIdentity
    && rightIdentity
    && left.ownerModelId === right.ownerModelId
    && left.ownerVariantId === right.ownerVariantId
    && remoteProjectorIdentitiesEqual(leftIdentity, rightIdentity),
  );
}

function getVariantCompatibleProjectorCandidates(
  variant: ModelVariant,
  model: ModelMetadata,
): ProjectorArtifact[] {
  const candidates = [
    ...(variant.projectorCandidates ?? []),
    ...(model.projectorCandidates ?? []),
  ].filter((projector) => isProjectorCompatibleWithVariant(projector, variant));
  const uniqueCandidates: ProjectorArtifact[] = [];
  for (const candidate of candidates) {
    if (!uniqueCandidates.some((entry) => projectorCandidatesShareIdentity(entry, candidate))) {
      uniqueCandidates.push(candidate);
    }
  }

  return uniqueCandidates;
}

function createCatalogSafeVariantCapability(
  variant: ModelVariant,
  model: ModelMetadata,
  audit: CatalogProjectorIdentityAudit,
): CatalogSafeVariantCapability {
  const projectorCandidates = getVariantCompatibleProjectorCandidates(variant, model);

  return {
    context: createCatalogSafeNativeCapabilityContext({
      ...variant,
      id: model.id,
      visionSource: variant.visionSource ?? model.visionSource,
      artifacts: model.artifacts,
      chatModalities: variant.chatModalities ?? model.chatModalities,
      inputCapabilities: model.inputCapabilities,
      projectorCandidates,
    }, model.id, audit),
    projectorCandidates,
  };
}

function resolveCatalogSafeProjectorContext(
  projector: ProjectorArtifact,
  modelContext: CatalogSafeNativeCapabilityContext,
  variants: readonly CatalogSafeVariantCapability[],
): CatalogSafeNativeCapabilityContext {
  const contexts: CatalogSafeNativeCapabilityContext[] = [];
  if (!projector.ownerVariantId?.trim()) {
    contexts.push(modelContext);
  }

  for (const variant of variants) {
    if (variant.projectorCandidates.some((candidate) => (
      projectorCandidatesShareIdentity(candidate, projector)
    ))) {
      contexts.push(variant.context);
    }
  }

  return mergeCatalogSafeNativeCapabilityContexts(contexts);
}

function sanitizeCatalogVariantRuntimeState(
  variant: ModelVariant,
  context: CatalogSafeNativeCapabilityContext,
  ownerModelId: string,
  artifacts: ModelMetadata['artifacts'],
): ModelVariant {
  return {
    ...variant,
    isLocal: undefined,
    chatModalities: sanitizeCatalogChatModalities(variant.chatModalities, context),
    visionSource: context.vision ? variant.visionSource : undefined,
    visionConfidence: context.vision ? variant.visionConfidence : undefined,
    selectedProjectorId: undefined,
    projectorCandidates: sanitizeCatalogProjectorRuntimeState(
      variant.projectorCandidates,
      context,
      ownerModelId,
      artifacts,
    ),
  };
}

export function sanitizeCatalogModelRuntimeState(
  model: ModelMetadata,
  options: CatalogSanitizationOptions = {},
): ModelMetadata {
  const audit = buildCatalogProjectorIdentityAudit(model, options);
  const modelContext = createCatalogSafeNativeCapabilityContext(model, model.id, audit);
  const variantCapabilities = model.variants?.map((variant) => (
    createCatalogSafeVariantCapability(variant, model, audit)
  )) ?? [];
  const inputCapabilityContext = mergeCatalogSafeNativeCapabilityContexts([
    modelContext,
    ...variantCapabilities.map((variant) => variant.context),
  ]);
  const inputCapabilities = sanitizeCatalogInputCapabilities(
    model.inputCapabilities,
    inputCapabilityContext,
  );
  const projectorCandidates = sanitizeCatalogProjectorRuntimeState(
    model.projectorCandidates,
    modelContext,
    model.id,
    model.artifacts,
    (projector) => resolveCatalogSafeProjectorContext(
      projector,
      modelContext,
      variantCapabilities,
    ),
  );
  const chatModalities = sanitizeCatalogChatModalities(model.chatModalities, modelContext);
  const variants = model.variants?.map((variant, index) => (
    sanitizeCatalogVariantRuntimeState(
      variant,
      (variantCapabilities[index] as CatalogSafeVariantCapability).context,
      model.id,
      model.artifacts,
    )
  ));
  const allProjectorCandidates = [
    ...(projectorCandidates ?? []),
    ...(variants ?? []).flatMap((variant) => variant.projectorCandidates ?? []),
  ];
  const shouldPreserveParentVisionSource = modelHasCatalogSafeVisionSource(model)
    && (modelContext.vision || variantCapabilities.some((variant) => variant.context.vision));

  return normalizePersistedModelMetadata({
    ...model,
    localPath: undefined,
    downloadedAt: undefined,
    downloadIntegrity: undefined,
    resumeData: undefined,
    downloadErrorAt: undefined,
    downloadErrorCode: undefined,
    downloadErrorMessage: undefined,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    metadataTrust: model.metadataTrust === 'verified_local' ? undefined : model.metadataTrust,
    ...(model.metadataTrust === 'verified_local' ? {
      sha256: undefined,
      capabilitySnapshot: undefined,
    } : {}),
    artifacts: sanitizeCatalogModelArtifacts(
      model,
      modelContext,
      allProjectorCandidates,
      audit,
      (projector) => resolveCatalogSafeProjectorContext(
        projector,
        modelContext,
        variantCapabilities,
      ),
    ),
    chatModalities,
    inputCapabilities,
    visionSource: shouldPreserveParentVisionSource ? model.visionSource : undefined,
    visionConfidence: shouldPreserveParentVisionSource ? model.visionConfidence : undefined,
    selectedProjectorId: undefined,
    multimodalReadiness: undefined,
    projectorCandidates,
    variants,
  });
}

export function sanitizeAnonymousCatalogModel(
  model: ModelMetadata,
  options: CatalogSanitizationOptions = {},
): ModelMetadata | null {
  if (model.isPrivate) {
    return null;
  }

  if (isPublicAnonymousModel(model)) {
    return limitAnonymousCatalogModelVariants(toAnonymousPublicCatalogModel(model, options));
  }

  return normalizePersistedModelMetadata({
    id: model.id,
    name: model.name,
    author: model.author,
    accessState: ModelAccessState.AUTH_REQUIRED,
    isGated: model.isGated === true,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  });
}

function toAnonymousPublicCatalogModel(
  model: ModelMetadata,
  options: CatalogSanitizationOptions,
): ModelMetadata {
  return sanitizeCatalogModelRuntimeState(model, options);
}

function limitAnonymousCatalogModelVariants(model: ModelMetadata): ModelMetadata {
  const variants = limitModelVariants(model.variants, {
    limit: CATALOG_SEARCH_VARIANT_LIMIT,
    includeFileNames: [model.resolvedFileName, model.activeVariantId],
    includeVariantIds: [model.activeVariantId],
  });

  if (variants === model.variants) {
    return model;
  }

  return normalizePersistedModelMetadata({
    ...model,
    variants,
  });
}

function sanitizeAnonymousPersistedModels(
  models: ModelMetadata[],
  options: CatalogSanitizationOptions = {},
): ModelMetadata[] {
  return models.flatMap((model) => {
    const sanitized = sanitizeAnonymousCatalogModel(model, options);
    return sanitized ? [sanitized] : [];
  });
}

function getTextByteLength(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }

  return unescape(encodeURIComponent(value)).length;
}

function isSort(value: unknown): value is CatalogCacheSort {
  return value === null
    || value === 'downloads'
    || value === 'likes'
    || value === 'lastModified';
}

function normalizeModels(
  models: unknown,
  persistedVersion?: number,
  payloadAlreadySanitized = false,
): ModelMetadata[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .filter((entry): entry is Partial<ModelMetadata> & { id: string } => (
      Boolean(entry)
      && typeof entry === 'object'
      && typeof (entry as { id?: unknown }).id === 'string'
    ))
    .flatMap((entry) => {
      const normalized = normalizePersistedModelMetadata(entry);
      if (typeof persistedVersion !== 'number' || payloadAlreadySanitized) {
        return payloadAlreadySanitized && !hasSafeAnonymousPersistedAccessState(normalized)
          ? []
          : [normalized];
      }

      const sanitized = sanitizeAnonymousCatalogModel(normalized, {
        persistedVersion,
        rawModel: entry,
      });
      return sanitized ? [sanitized] : [];
    });
}

function inferSnapshotAuthScope(model: ModelMetadata): CatalogCacheAuthScope {
  return model.accessState === ModelAccessState.AUTHORIZED
    || model.accessState === ModelAccessState.ACCESS_DENIED
    ? 'auth'
    : 'anon';
}

function buildSnapshotKey(modelId: string, authScope: CatalogCacheAuthScope): string {
  return `${modelId}::${authScope}`;
}

function buildCatalogSearchKey(scope: CatalogCacheScope): string {
  const gatedKey = typeof scope.gated === 'boolean' ? String(scope.gated) : '__any__';
  return [
    scope.query,
    scope.cursor ?? '__initial__',
    scope.pageSize,
    scope.sort ?? '__default__',
    scope.authScope,
    `gated:${gatedKey}`,
  ].join('::');
}

function normalizeSearchResult(
  value: unknown,
  persistedVersion?: number,
  payloadAlreadySanitized = false,
): CatalogCacheResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    models?: unknown;
    hasMore?: unknown;
    nextCursor?: unknown;
  };
  const models = normalizeModels(candidate.models, persistedVersion, payloadAlreadySanitized);
  const hasMore = candidate.hasMore === true;
  const nextCursor = typeof candidate.nextCursor === 'string' ? candidate.nextCursor : null;

  return {
    models,
    hasMore,
    nextCursor,
  };
}

function normalizeSearchScope(value: unknown): CatalogCacheScope | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CatalogCacheScope>;
  if (typeof candidate.query !== 'string') {
    return null;
  }

  return {
    query: candidate.query,
    cursor: typeof candidate.cursor === 'string' ? candidate.cursor : null,
    pageSize: typeof candidate.pageSize === 'number' && Number.isFinite(candidate.pageSize)
      ? Math.max(1, Math.round(candidate.pageSize))
      : 20,
    sort: isSort(candidate.sort) ? candidate.sort : null,
    authScope: candidate.authScope === 'auth' ? 'auth' : 'anon',
    gated: typeof candidate.gated === 'boolean' ? candidate.gated : null,
  };
}

function normalizeSearchEntry(
  value: unknown,
  persistedVersion?: number,
  payloadAlreadySanitized = false,
): SearchCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    key?: unknown;
    timestamp?: unknown;
    scope?: unknown;
    result?: unknown;
  };
  const scope = normalizeSearchScope(candidate.scope);
  const result = normalizeSearchResult(candidate.result, persistedVersion, payloadAlreadySanitized);
  const rawModels = candidate.result && typeof candidate.result === 'object'
    ? (candidate.result as { models?: unknown }).models
    : undefined;

  if (
    !scope
    || !result
    || typeof candidate.key !== 'string'
    || (
      payloadAlreadySanitized
      && (!Array.isArray(rawModels) || rawModels.length !== result.models.length)
    )
  ) {
    return null;
  }

  return {
    key: buildCatalogSearchKey(scope),
    timestamp: typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? Math.round(candidate.timestamp)
      : 0,
    scope,
    result,
  };
}

function normalizeSnapshotEntry(
  value: unknown,
  persistedVersion?: number,
  payloadAlreadySanitized = false,
): SnapshotCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    key?: unknown;
    id?: unknown;
    authScope?: unknown;
    timestamp?: unknown;
    model?: unknown;
  };

  if (typeof candidate.id !== 'string') {
    return null;
  }

  const models = normalizeModels(
    candidate.model ? [candidate.model] : [],
    persistedVersion,
    payloadAlreadySanitized,
  );
  const model = models[0];
  if (!model) {
    return null;
  }

  const authScope = candidate.authScope === 'auth' || candidate.authScope === 'anon'
    ? candidate.authScope
    : inferSnapshotAuthScope(model);

  return {
    key: typeof candidate.key === 'string'
      ? candidate.key
      : buildSnapshotKey(candidate.id, authScope),
    id: candidate.id,
    authScope,
    timestamp: typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? Math.round(candidate.timestamp)
      : 0,
    model,
  };
}

export class ModelCatalogCacheStore {
  private storage = createStorage(STORAGE_ID, { tier: 'cache' });
  private searchEntries = new Map<string, SearchCacheEntry>();
  private snapshotEntries = new Map<string, SnapshotCacheEntry>();
  private isHydrated = false;
  private isPersistenceDisabled = false;

  constructor(options: ModelCatalogCacheStoreOptions = {}) {
    if (options.hydrateOnCreate !== false) {
      this.hydrate();
    }
  }

  public hydrate(): void {
    if (this.isHydrated) {
      return;
    }

    try {
      this.loadPersistedEntries();
      // Only commit the state after both payloads were read successfully. A
      // transient storage failure must remain retryable on the next safe access.
      this.isHydrated = true;
    } catch (error) {
      this.searchEntries.clear();
      this.snapshotEntries.clear();
      throw error;
    }
  }

  public getSearch(scope: CatalogCacheScope, maxAgeMs: number): CatalogCacheResult | null {
    if (!this.isHydrated) {
      return null;
    }

    const entry = this.searchEntries.get(this.buildSearchKey(scope));
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > maxAgeMs) {
      return null;
    }

    return this.cloneSearchResult(entry.result);
  }

  public putSearch(scope: CatalogCacheScope, result: CatalogCacheResult): void {
    this.hydrateForMutation();
    const key = this.buildSearchKey(scope);
    const clonedResult = scope.authScope === 'anon'
      ? {
        ...result,
        models: sanitizeAnonymousPersistedModels(result.models),
      }
      : this.cloneSearchResult(result);
    const entry: SearchCacheEntry = {
      key,
      timestamp: Date.now(),
      scope: {
        ...scope,
        cursor: scope.cursor ?? null,
        gated: typeof scope.gated === 'boolean' ? scope.gated : null,
      },
      result: clonedResult,
    };

    this.searchEntries.set(key, entry);
    this.pruneSearchEntries();

    if (scope.authScope === 'anon') {
      this.persistSearchEntries();
    }
  }

  public getModelSnapshot(
    modelId: string,
    authScope: CatalogCacheAuthScope,
    maxAgeMs: number,
  ): ModelMetadata | null {
    if (!this.isHydrated) {
      return null;
    }

    const entry = this.snapshotEntries.get(buildSnapshotKey(modelId, authScope));
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > maxAgeMs) {
      return null;
    }

    return normalizePersistedModelMetadata(entry.model);
  }

  public putModelSnapshots(models: ModelMetadata[], authScope: CatalogCacheAuthScope): void {
    this.hydrateForMutation();
    const timestamp = Date.now();
    const modelsToStore = authScope === 'anon'
      ? sanitizeAnonymousPersistedModels(models)
      : models.map((model) => normalizePersistedModelMetadata(model));

    modelsToStore.forEach((model) => {
      const key = buildSnapshotKey(model.id, authScope);
      this.snapshotEntries.set(key, {
        key,
        id: model.id,
        authScope,
        timestamp,
        model,
      });
    });

    this.pruneSnapshotEntries();

    if (authScope === 'anon') {
      this.persistSnapshotEntries();
    }
  }

  public deleteModelSnapshots(modelIds: string[], authScope: CatalogCacheAuthScope): void {
    const uniqueModelIds = new Set(modelIds.filter((modelId) => modelId.trim().length > 0));
    if (uniqueModelIds.size === 0) {
      return;
    }

    this.hydrateForMutation();

    let didDelete = false;
    uniqueModelIds.forEach((modelId) => {
      didDelete = this.snapshotEntries.delete(buildSnapshotKey(modelId, authScope)) || didDelete;
    });

    if (didDelete && authScope === 'anon') {
      this.persistSnapshotEntries();
    }
  }

  public deleteSearchModels(modelIds: string[], authScope?: CatalogCacheAuthScope): void {
    const uniqueModelIds = new Set(modelIds.filter((modelId) => modelId.trim().length > 0));
    if (uniqueModelIds.size === 0) {
      return;
    }

    this.hydrateForMutation();

    let didPersistedAnonChange = false;
    for (const [key, entry] of this.searchEntries.entries()) {
      if (authScope && entry.scope.authScope !== authScope) {
        continue;
      }

      const nextModels = entry.result.models.filter((model) => !uniqueModelIds.has(model.id));
      if (nextModels.length === entry.result.models.length) {
        continue;
      }

      this.searchEntries.set(key, {
        ...entry,
        result: {
          ...entry.result,
          models: nextModels,
        },
      });
      didPersistedAnonChange = didPersistedAnonChange || entry.scope.authScope === 'anon';
    }

    if (didPersistedAnonChange) {
      this.persistSearchEntries();
    }
  }

  public reconcileAnonymousSearchModels(models: ModelMetadata[]): void {
    const replacements = new Map<string, ModelMetadata | null>();
    models.forEach((model) => {
      replacements.set(model.id, sanitizeAnonymousCatalogModel(model));
    });

    if (replacements.size === 0) {
      return;
    }

    this.hydrateForMutation();

    let didChange = false;
    for (const [key, entry] of this.searchEntries.entries()) {
      if (entry.scope.authScope !== 'anon') {
        continue;
      }

      let didChangeEntry = false;
      const nextModels = entry.result.models.flatMap((model) => {
        if (!replacements.has(model.id)) {
          return [model];
        }

        didChangeEntry = true;
        const replacement = replacements.get(model.id) ?? null;
        return replacement ? [replacement] : [];
      });

      if (didChangeEntry) {
        didChange = true;
        this.searchEntries.set(key, {
          ...entry,
          result: {
            ...entry.result,
            models: nextModels,
          },
        });
      }
    }

    if (didChange) {
      this.persistSearchEntries();
    }
  }

  public getPersistedSizeBytes(): number {
    if (this.isPersistenceDisabled) {
      return 0;
    }

    try {
      return PERSISTED_CACHE_KEYS.reduce((sum, key) => {
        const value = this.storage.getString(key);
        if (!value) {
          return sum;
        }

        return sum + getTextByteLength(key) + getTextByteLength(value);
      }, 0);
    } catch {
      // Metrics are advisory. A transient read failure here must not settle a
      // deferred hydration attempt or disable later cache reads and writes.
      return 0;
    }
  }

  public clearAll(): void {
    this.isHydrated = true;
    this.searchEntries.clear();
    this.snapshotEntries.clear();

    let firstError: unknown;
    let didFail = false;
    for (const key of PERSISTED_CACHE_KEYS) {
      try {
        this.removePersistedValue(key);
      } catch (error) {
        if (!didFail) {
          firstError = error;
          didFail = true;
        }
      }
    }

    if (didFail) {
      throw firstError;
    }
  }

  public clearSnapshots(): void {
    this.snapshotEntries.clear();
    this.removePersistedValue(SNAPSHOT_CACHE_KEY);
  }

  public clearSnapshotsForScope(authScope: CatalogCacheAuthScope): void {
    if (!this.isHydrated) {
      if (authScope === 'anon') {
        this.removePersistedValue(SNAPSHOT_CACHE_KEY);
      }
      return;
    }

    for (const [key, entry] of this.snapshotEntries.entries()) {
      if (entry.authScope !== authScope) {
        continue;
      }

      this.snapshotEntries.delete(key);
    }

    if (authScope === 'anon') {
      // Anonymous snapshots are the only snapshot scope persisted to disk, so
      // clearing that scope must remove the payload rather than report success
      // after a failed optional persistence operation.
      this.removePersistedValue(SNAPSHOT_CACHE_KEY);
    }
  }

  private loadPersistedEntries(): void {
    let shouldRewriteSearchPayload = false;
    const searchPayloadResult = this.parsePayload<SearchCacheEntry>(
      this.storage.getString(SEARCH_CACHE_KEY),
      normalizeSearchEntry,
    );
    shouldRewriteSearchPayload = searchPayloadResult.needsRewrite;

    if (searchPayloadResult.status === 'invalid' || searchPayloadResult.status === 'oversized') {
      this.storage.remove(SEARCH_CACHE_KEY);
    }

    searchPayloadResult.entries.forEach((entry) => {
      if (entry.scope.authScope !== 'anon') {
        shouldRewriteSearchPayload = true;
        return;
      }

      this.searchEntries.set(entry.key, entry);
    });

    let shouldRewriteSnapshotPayload = false;
    const snapshotPayloadResult = this.parsePayload<SnapshotCacheEntry>(
      this.storage.getString(SNAPSHOT_CACHE_KEY),
      normalizeSnapshotEntry,
    );
    shouldRewriteSnapshotPayload = snapshotPayloadResult.needsRewrite;

    if (snapshotPayloadResult.status === 'invalid' || snapshotPayloadResult.status === 'oversized') {
      this.storage.remove(SNAPSHOT_CACHE_KEY);
    }

    snapshotPayloadResult.entries.forEach((entry) => {
      if (entry.authScope !== 'anon') {
        shouldRewriteSnapshotPayload = true;
        return;
      }

      this.snapshotEntries.set(entry.key, entry);
    });

    const searchEntriesBeforePrune = this.searchEntries.size;
    this.pruneSearchEntries();
    if (searchEntriesBeforePrune !== this.searchEntries.size) {
      shouldRewriteSearchPayload = true;
    }

    const snapshotEntriesBeforePrune = this.snapshotEntries.size;
    this.pruneSnapshotEntries();
    if (snapshotEntriesBeforePrune !== this.snapshotEntries.size) {
      shouldRewriteSnapshotPayload = true;
    }

    if (shouldRewriteSearchPayload) {
      this.persistSearchEntries();
    }

    if (shouldRewriteSnapshotPayload) {
      this.persistSnapshotEntries();
    }
  }

  private parsePayload<T>(
    rawValue: string | undefined,
    normalizeEntry: (
      value: unknown,
      persistedVersion: number,
      payloadAlreadySanitized: boolean,
    ) => T | null,
  ): ParsedPayload<T> {
    if (!rawValue) {
      return { status: 'empty', entries: [], needsRewrite: false };
    }

    // App-written envelopes always put the version first. Reject retired or
    // unknown versions from a small prefix so a pathological payload never
    // reaches the byte encoder, JSON.parse, or the model normalizer.
    const versionMatch = /^\s*\{\s*"version"\s*:\s*(\d+)/.exec(rawValue.slice(0, 128));
    if (versionMatch && !SUPPORTED_PERSISTED_CACHE_VERSIONS.has(Number(versionMatch[1]))) {
      return { status: 'invalid', entries: [], needsRewrite: false };
    }

    if (
      rawValue.length > MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES
      || getTextByteLength(rawValue) > MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES
    ) {
      return { status: 'oversized', entries: [], needsRewrite: false };
    }

    try {
      const parsed = JSON.parse(rawValue) as PersistedPayload<unknown>;
      if (
        !parsed
        || typeof parsed !== 'object'
        || typeof parsed.version !== 'number'
        || !SUPPORTED_PERSISTED_CACHE_VERSIONS.has(parsed.version)
        || !Array.isArray(parsed.entries)
      ) {
        return { status: 'invalid', entries: [], needsRewrite: false };
      }

      const payloadAlreadySanitized = parsed.version === MODEL_CATALOG_CACHE_PERSISTED_VERSION
        && parsed.sanitized === true;
      const normalizedEntries = parsed.entries.map((entry) => (
        normalizeEntry(entry, parsed.version, payloadAlreadySanitized)
      ));
      const entries = normalizedEntries.filter((entry): entry is T => entry !== null);

      return {
        status: 'ok',
        entries,
        needsRewrite: parsed.version !== MODEL_CATALOG_CACHE_PERSISTED_VERSION
          || parsed.sanitized !== true
          || normalizedEntries.some((entry) => entry === null),
      };
    } catch {
      return { status: 'invalid', entries: [], needsRewrite: false };
    }
  }

  private persistSearchEntries(): void {
    const entries = this.getSortedSearchEntries()
      .filter((entry) => entry.scope.authScope === 'anon');
    this.persistBoundedPayload(SEARCH_CACHE_KEY, entries);
  }

  private persistSnapshotEntries(): void {
    const entries = this.getSortedSnapshotEntries()
      .filter((entry) => entry.authScope === 'anon');
    this.persistBoundedPayload(SNAPSHOT_CACHE_KEY, entries);
  }

  private persistBoundedPayload<T>(key: typeof PERSISTED_CACHE_KEYS[number], entries: T[]): void {
    if (this.isPersistenceDisabled) {
      return;
    }

    const prefix = `{"version":${MODEL_CATALOG_CACHE_PERSISTED_VERSION},"sanitized":true,"entries":[`;
    const suffix = ']}';
    const serializedEntries: string[] = [];
    let serializedBytes = getTextByteLength(prefix) + getTextByteLength(suffix);

    for (const entry of entries) {
      const serializedEntry = JSON.stringify(entry);
      if (!serializedEntry) {
        continue;
      }

      const separatorBytes = serializedEntries.length > 0 ? 1 : 0;
      const nextBytes = serializedBytes + separatorBytes + getTextByteLength(serializedEntry);
      if (nextBytes > MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES) {
        // Preserve smaller recent entries even if one unusually large result cannot be cached.
        continue;
      }

      serializedEntries.push(serializedEntry);
      serializedBytes = nextBytes;
    }

    if (serializedEntries.length === 0) {
      this.removePersistedValue(key, { failOpen: true });
      return;
    }

    try {
      this.storage.set(key, `${prefix}${serializedEntries.join(',')}${suffix}`);
    } catch {
      // The previous payload may now describe state that memory has already
      // removed (for example, a model that became private). Best-effort
      // invalidation prevents that stale value from returning after restart.
      this.removePersistedValue(key, { failOpen: true });
      this.disablePersistence();
    }
  }

  private hydrateForMutation(): void {
    if (this.isHydrated) {
      return;
    }

    try {
      this.hydrate();
    } catch {
      // The catalog cache is optional. If persistence is still unavailable when
      // fresh network data arrives, keep serving that data from memory instead
      // of turning a successful catalog request into an error.
      this.searchEntries.clear();
      this.snapshotEntries.clear();
      this.disablePersistence();
    }
  }

  private removePersistedValue(
    key: typeof PERSISTED_CACHE_KEYS[number],
    options: { failOpen?: boolean } = {},
  ): void {
    try {
      this.storage.remove(key);
    } catch (error) {
      this.disablePersistence();
      if (options.failOpen !== true) {
        throw error;
      }
    }
  }

  private disablePersistence(): void {
    this.isPersistenceDisabled = true;
    this.isHydrated = true;
  }

  private getSortedSearchEntries(): SearchCacheEntry[] {
    return Array.from(this.searchEntries.values())
      .sort((left, right) => right.timestamp - left.timestamp);
  }

  private getSortedSnapshotEntries(): SnapshotCacheEntry[] {
    return Array.from(this.snapshotEntries.values())
      .sort((left, right) => right.timestamp - left.timestamp);
  }

  private pruneSearchEntries(): void {
    const staleEntries = this.getSortedSearchEntries().slice(MAX_PERSISTED_SEARCH_ENTRIES);
    staleEntries.forEach((entry) => {
      this.searchEntries.delete(entry.key);
    });
  }

  private pruneSnapshotEntries(): void {
    const staleEntries = this.getSortedSnapshotEntries().slice(MAX_PERSISTED_SNAPSHOT_ENTRIES);
    staleEntries.forEach((entry) => {
      this.snapshotEntries.delete(entry.key);
    });
  }

  private cloneSearchResult(result: CatalogCacheResult): CatalogCacheResult {
    return {
      models: result.models.map((model) => normalizePersistedModelMetadata(model)),
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    };
  }

  private buildSearchKey(scope: CatalogCacheScope): string {
    return buildCatalogSearchKey(scope);
  }
}
