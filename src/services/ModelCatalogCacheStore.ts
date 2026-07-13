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
  getInputCapabilityEvidenceModalities,
  mergeCapabilityEvidence,
} from '../utils/modelInputCapabilities';
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
export const MODEL_CATALOG_CACHE_PERSISTED_VERSION = 6;
export const MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES = 1_500_000;
const SUPPORTED_PERSISTED_CACHE_VERSIONS = new Set([3, 4, 5, MODEL_CATALOG_CACHE_PERSISTED_VERSION]);
const MAX_PERSISTED_SEARCH_ENTRIES = 6;
const MAX_PERSISTED_SNAPSHOT_ENTRIES = 40;
const PERSISTED_CACHE_KEYS = [SEARCH_CACHE_KEY, SNAPSHOT_CACHE_KEY] as const;
const CATALOG_SAFE_VISION_SOURCES = new Set<VisionCapabilitySource>(['catalog_metadata', 'tree_probe']);
const CATALOG_SAFE_ARTIFACT_REQUIRED_INPUTS = new Set<ModelArtifactRequiredInput>(['text', 'image', 'audio']);

type CatalogVisionRuntimeSource = Pick<ModelMetadata | ModelVariant, 'visionSource'> & Partial<Pick<
  ModelMetadata | ModelVariant,
  'chatModalities' | 'projectorCandidates' | 'visionConfidence'
>> & Partial<Pick<ModelMetadata, 'artifacts' | 'inputCapabilities'>>;

export type CatalogSafeNativeCapabilityContext = {
  vision: boolean;
  audio: boolean;
  projectorEvidenceFileNames: ReadonlySet<string>;
};

type JsonComparableValue = null | boolean | number | string | JsonComparableValue[] | {
  [key: string]: JsonComparableValue;
};

function isPublicAnonymousModel(model: ModelMetadata): boolean {
  return model.accessState === ModelAccessState.PUBLIC
    && model.isGated !== true
    && model.isPrivate !== true;
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

function hasCatalogProjectorIdentity(
  projector: ProjectorArtifact,
  context: CatalogSafeNativeCapabilityContext,
): boolean {
  const fileName = getCatalogRemoteProjectorFileName(projector.fileName, projector.downloadUrl);
  return Boolean(
    fileName
    && (
      context.projectorEvidenceFileNames.has(fileName)
      || sanitizeCatalogProjectorMatchReason(projector) !== undefined
    ),
  );
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

function normalizeCatalogProjectorFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedPath = value.trim().replace(/\\/gu, '/').split(/[?#]/u)[0];
  const encodedFileName = normalizedPath.split('/').filter(Boolean).pop();
  if (!encodedFileName) {
    return undefined;
  }

  try {
    const decodedFileName = decodeURIComponent(encodedFileName).trim().toLowerCase();
    return decodedFileName.length > 0 ? decodedFileName : undefined;
  } catch {
    const fallbackFileName = encodedFileName.trim().toLowerCase();
    return fallbackFileName.length > 0 ? fallbackFileName : undefined;
  }
}

function getCatalogRemoteProjectorFileName(
  fileName: unknown,
  downloadUrl: unknown,
): string | undefined {
  if (typeof downloadUrl !== 'string') {
    return undefined;
  }

  const normalizedFileName = normalizeCatalogProjectorFileName(fileName);
  const normalizedUrlFileName = normalizeCatalogProjectorFileName(
    getRemoteFileNameFromDownloadUrl(downloadUrl),
  );
  return normalizedFileName && normalizedFileName === normalizedUrlFileName
    ? normalizedFileName
    : undefined;
}

function getCatalogRemoteProjectorCanonicalFileName(
  fileName: unknown,
  downloadUrl: unknown,
): string | undefined {
  if (typeof downloadUrl !== 'string') {
    return undefined;
  }

  const remoteFileName = getRemoteFileNameFromDownloadUrl(downloadUrl);
  return getCatalogRemoteProjectorFileName(fileName, downloadUrl)
    ? remoteFileName
    : undefined;
}

function getCatalogProjectorEvidenceFileNames(
  inputCapabilities: ModelInputCapabilitySnapshot | undefined,
): Set<string> {
  return new Set(inputCapabilities?.evidence.flatMap((entry) => {
    if (entry.source !== 'projector') {
      return [];
    }

    const fileName = normalizeCatalogProjectorFileName(entry.value);
    return fileName ? [fileName] : [];
  }) ?? []);
}

function getCatalogProjectorRepresentationFileNames(model: CatalogVisionRuntimeSource): Set<string> {
  const candidateFileNames = model.projectorCandidates?.flatMap((projector) => {
    const fileName = getCatalogRemoteProjectorFileName(projector.fileName, projector.downloadUrl);
    return fileName ? [fileName] : [];
  }) ?? [];
  const artifactFileNames = model.artifacts?.flatMap((artifact) => {
    if (artifact.kind !== 'multimodal_projector') {
      return [];
    }

    const fileName = getCatalogRemoteProjectorFileName(artifact.remoteFileName, artifact.downloadUrl);
    return fileName ? [fileName] : [];
  }) ?? [];

  return new Set([...candidateFileNames, ...artifactFileNames]);
}

function catalogProjectorRepresentationSupportsInput(
  model: CatalogVisionRuntimeSource,
  fileName: string,
  input: 'image' | 'audio',
): boolean {
  const matchingArtifacts = model.artifacts?.filter((artifact) => (
    artifact.kind === 'multimodal_projector'
    && getCatalogRemoteProjectorFileName(artifact.remoteFileName, artifact.downloadUrl) === fileName
  )) ?? [];
  if (matchingArtifacts.length > 0) {
    return matchingArtifacts.some((artifact) => artifact.requiredFor.includes(input));
  }

  return model.projectorCandidates?.some((projector) => (
    getCatalogRemoteProjectorFileName(projector.fileName, projector.downloadUrl) === fileName
  )) === true;
}

function createCatalogSafeNativeCapabilityContext(
  model: CatalogVisionRuntimeSource,
): CatalogSafeNativeCapabilityContext {
  const projectorEvidenceFileNames = getCatalogProjectorEvidenceFileNames(model.inputCapabilities);
  const projectorRepresentationFileNames = getCatalogProjectorRepresentationFileNames(model);
  const matchingProjectorEvidenceFileNames = new Set(
    [...projectorEvidenceFileNames].filter((fileName) => projectorRepresentationFileNames.has(fileName)),
  );
  const hasExplicitChatModalities = Array.isArray(model.chatModalities);
  const permitsVision = !hasExplicitChatModalities || model.chatModalities?.includes('vision') === true;
  const permitsAudio = !hasExplicitChatModalities || model.chatModalities?.includes('audio') === true;
  const vision = permitsVision && modelHasCatalogSafeVisionSource(model);
  const hasCatalogSafeAudioSignal = permitsAudio
    && modelHasCatalogAudioCapabilitySignal(model)
    && modelHasCatalogSafeAudioCapabilityEvidence(model);
  const visionProjectorEvidenceFileNames = vision
    ? [...matchingProjectorEvidenceFileNames].filter((fileName) => (
      catalogProjectorRepresentationSupportsInput(model, fileName, 'image')
    ))
    : [];
  const audioProjectorEvidenceFileNames = hasCatalogSafeAudioSignal
    ? [...matchingProjectorEvidenceFileNames].filter((fileName) => (
      catalogProjectorRepresentationSupportsInput(model, fileName, 'audio')
    ))
    : [];
  const audio = audioProjectorEvidenceFileNames.length > 0;

  return {
    vision,
    audio,
    projectorEvidenceFileNames: new Set([
      ...visionProjectorEvidenceFileNames,
      ...audioProjectorEvidenceFileNames,
    ]),
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
  };
}

function getRemoteFileNameFromDownloadUrl(downloadUrl: string): string | undefined {
  try {
    const url = new URL(downloadUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }

    const encodedName = url.pathname.split('/').filter(Boolean).pop();
    if (!encodedName) {
      return undefined;
    }

    const decodedName = decodeURIComponent(encodedName).trim();
    return decodedName.length > 0 ? decodedName : undefined;
  } catch {
    return undefined;
  }
}

function normalizeArtifactRequiredFor(requiredFor: ModelArtifactMetadata['requiredFor']): ModelArtifactRequiredInput[] {
  return [...new Set(requiredFor.filter((entry): entry is ModelArtifactRequiredInput => (
    CATALOG_SAFE_ARTIFACT_REQUIRED_INPUTS.has(entry)
  )))];
}

function sanitizeCatalogArtifactRemoteFileName(
  artifact: ModelArtifactMetadata,
  model: Pick<ModelMetadata, 'resolvedFileName'>,
): string | undefined {
  if (artifact.kind === 'main_model') {
    const remoteFileName = getRemoteFileNameFromDownloadUrl(artifact.downloadUrl);
    return remoteFileName ? model.resolvedFileName ?? remoteFileName : undefined;
  }

  return getCatalogRemoteProjectorCanonicalFileName(
    artifact.remoteFileName,
    artifact.downloadUrl,
  );
}

function projectorCandidateMatchesArtifact(
  projector: ProjectorArtifact,
  artifact: ModelArtifactMetadata,
): boolean {
  if (artifact.kind !== 'multimodal_projector') {
    return false;
  }

  const projectorFileName = getCatalogRemoteProjectorFileName(
    projector.fileName,
    projector.downloadUrl,
  );
  const artifactFileName = getCatalogRemoteProjectorFileName(
    artifact.remoteFileName,
    artifact.downloadUrl,
  );
  return Boolean(
    projectorFileName
    && projectorFileName === artifactFileName
    && (artifact.id === projector.id || artifact.downloadUrl === projector.downloadUrl),
  );
}

function sanitizeCatalogArtifactRequiredFor(
  artifact: ModelArtifactMetadata,
  context: CatalogSafeNativeCapabilityContext,
): ModelArtifactRequiredInput[] {
  const projectorFileName = artifact.kind === 'multimodal_projector'
    ? getCatalogRemoteProjectorFileName(artifact.remoteFileName, artifact.downloadUrl)
    : undefined;

  return normalizeArtifactRequiredFor(artifact.requiredFor).filter((requiredInput) => {
    if (requiredInput === 'text') {
      return artifact.kind === 'main_model';
    }

    if (requiredInput === 'image') {
      return context.vision;
    }

    return context.audio && (
      artifact.kind === 'main_model'
      || Boolean(projectorFileName && context.projectorEvidenceFileNames.has(projectorFileName))
    );
  });
}

function sanitizeCatalogModelArtifacts(
  model: Pick<
    ModelMetadata,
    'artifacts'
      | 'chatModalities'
      | 'inputCapabilities'
      | 'metadataTrust'
      | 'projectorCandidates'
      | 'resolvedFileName'
      | 'visionSource'
  >,
  context: CatalogSafeNativeCapabilityContext,
  resolveContext: (
    artifact: ModelArtifactMetadata,
  ) => CatalogSafeNativeCapabilityContext = () => context,
): ModelMetadata['artifacts'] {
  if (!model.artifacts?.length) {
    return undefined;
  }

  const artifacts = model.artifacts.flatMap((artifact): ModelArtifactMetadata[] => {
    const remoteFileName = sanitizeCatalogArtifactRemoteFileName(artifact, model);
    const requiredFor = sanitizeCatalogArtifactRequiredFor(artifact, resolveContext(artifact));
    if (!remoteFileName || requiredFor.length === 0) {
      return [];
    }

    return [{
      id: artifact.id,
      kind: artifact.kind,
      requiredFor,
      ...(artifact.hfRevision ? { hfRevision: artifact.hfRevision } : {}),
      remoteFileName,
      downloadUrl: artifact.downloadUrl,
      sizeBytes: artifact.sizeBytes,
      ...(artifact.kind !== 'main_model' || model.metadataTrust !== 'verified_local'
        ? { ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}) }
        : {}),
      installState: 'remote',
    }];
  });

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
    const fileName = normalizeCatalogProjectorFileName(entry.value);
    return Boolean(fileName && context.projectorEvidenceFileNames.has(fileName))
      ? [{ ...entry, value: fileName as string }]
      : [];
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
  artifacts?: ModelMetadata['artifacts'],
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
    const canonicalFileName = getCatalogRemoteProjectorCanonicalFileName(
      projector.fileName,
      projector.downloadUrl,
    );
    const normalizedFileName = normalizeCatalogProjectorFileName(canonicalFileName);
    if (!canonicalFileName || !normalizedFileName) {
      return [];
    }

    const projectorContext = resolveContext(projector);
    const matchingArtifact = artifacts?.find((artifact) => (
      projectorCandidateMatchesArtifact(projector, artifact)
    ));
    const hasMatchingProjectorEvidence = projectorContext.projectorEvidenceFileNames.has(normalizedFileName);
    const hasIndependentCatalogIdentity = hasCatalogProjectorIdentity(projector, projectorContext);
    const hasSafeVisionIdentity = projectorContext.vision
      && hasIndependentCatalogIdentity
      && (matchingArtifact?.requiredFor.includes('image') ?? true);
    const hasSafeAudioIdentity = projectorContext.audio
      && hasMatchingProjectorEvidence
      && (matchingArtifact?.requiredFor.includes('audio') ?? true);
    const isAllowed = hasSafeVisionIdentity || hasSafeAudioIdentity;
    if (!isAllowed) {
      return [];
    }

    return [{
      ...projector,
      fileName: canonicalFileName,
      localPath: undefined,
      resumeData: undefined,
      downloadProgress: undefined,
      lifecycleStatus: 'available' as const,
      matchStatus: sanitizeCatalogProjectorMatchStatus(projector),
      matchReason: sanitizeCatalogProjectorMatchReason(projector),
    }];
  });

  return sanitized.length > 0 ? sanitized : undefined;
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
  const leftFileName = getCatalogRemoteProjectorFileName(left.fileName, left.downloadUrl);
  const rightFileName = getCatalogRemoteProjectorFileName(right.fileName, right.downloadUrl);
  return Boolean(
    leftFileName
    && leftFileName === rightFileName
    && (left.id === right.id || left.downloadUrl === right.downloadUrl),
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
): CatalogSafeVariantCapability {
  const projectorCandidates = getVariantCompatibleProjectorCandidates(variant, model);
  const artifacts = model.artifacts?.filter((artifact) => (
    artifact.kind !== 'multimodal_projector'
    || projectorCandidates.some((projector) => projectorCandidateMatchesArtifact(projector, artifact))
  ));

  return {
    context: createCatalogSafeNativeCapabilityContext({
      ...variant,
      visionSource: variant.visionSource ?? model.visionSource,
      artifacts,
      chatModalities: variant.chatModalities ?? model.chatModalities,
      inputCapabilities: model.inputCapabilities,
      projectorCandidates,
    }),
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

function resolveCatalogSafeArtifactContext(
  artifact: ModelArtifactMetadata,
  model: ModelMetadata,
  modelContext: CatalogSafeNativeCapabilityContext,
  variants: readonly CatalogSafeVariantCapability[],
): CatalogSafeNativeCapabilityContext {
  if (artifact.kind !== 'multimodal_projector') {
    return modelContext;
  }

  const allMatchingModelCandidates = model.projectorCandidates?.filter((projector) => (
    projectorCandidateMatchesArtifact(projector, artifact)
  )) ?? [];
  const allMatchingVariantCandidates = variants.flatMap((variant) => (
    variant.projectorCandidates.filter((projector) => (
      projectorCandidateMatchesArtifact(projector, artifact)
    ))
  ));
  const matchingModelCandidates = allMatchingModelCandidates.filter((projector) => (
    hasCatalogProjectorIdentity(
      projector,
      resolveCatalogSafeProjectorContext(projector, modelContext, variants),
    )
  ));
  const contexts: CatalogSafeNativeCapabilityContext[] = [];
  if (
    matchingModelCandidates.some((projector) => !projector.ownerVariantId?.trim())
    || (
      allMatchingModelCandidates.length === 0
      && allMatchingVariantCandidates.length === 0
      && artifact.installState === 'remote'
    )
  ) {
    contexts.push(modelContext);
  }

  for (const variant of variants) {
    if (variant.projectorCandidates.some((projector) => (
      projectorCandidateMatchesArtifact(projector, artifact)
      && hasCatalogProjectorIdentity(projector, variant.context)
    ))) {
      contexts.push(variant.context);
    }
  }

  return mergeCatalogSafeNativeCapabilityContexts(contexts);
}

function sanitizeCatalogVariantRuntimeState(
  variant: ModelVariant,
  context: CatalogSafeNativeCapabilityContext,
  artifacts?: ModelMetadata['artifacts'],
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
      artifacts,
    ),
  };
}

export function sanitizeCatalogModelRuntimeState(model: ModelMetadata): ModelMetadata {
  const modelContext = createCatalogSafeNativeCapabilityContext(model);
  const variantCapabilities = model.variants?.map((variant) => (
    createCatalogSafeVariantCapability(variant, model)
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
      model.artifacts,
    )
  ));
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
      (artifact) => resolveCatalogSafeArtifactContext(
        artifact,
        model,
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

export function sanitizeAnonymousCatalogModel(model: ModelMetadata): ModelMetadata | null {
  if (model.isPrivate) {
    return null;
  }

  if (isPublicAnonymousModel(model)) {
    return limitAnonymousCatalogModelVariants(toAnonymousPublicCatalogModel(model));
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

function toAnonymousPublicCatalogModel(model: ModelMetadata): ModelMetadata {
  return sanitizeCatalogModelRuntimeState(model);
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

function sanitizeAnonymousPersistedModels(models: ModelMetadata[]): ModelMetadata[] {
  return models.flatMap((model) => {
    const sanitized = sanitizeAnonymousCatalogModel(model);
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

function normalizeModels(models: unknown): ModelMetadata[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .filter((entry): entry is Partial<ModelMetadata> & { id: string } => (
      Boolean(entry)
      && typeof entry === 'object'
      && typeof (entry as { id?: unknown }).id === 'string'
    ))
    .map((entry) => normalizePersistedModelMetadata(entry));
}

function toJsonComparableValue(value: unknown): JsonComparableValue | undefined {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toJsonComparableValue(entry) ?? null);
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const comparable: { [key: string]: JsonComparableValue } = {};
  for (const key of Object.keys(value).sort()) {
    const entry = toJsonComparableValue((value as Record<string, unknown>)[key]);
    if (entry !== undefined) {
      comparable[key] = entry;
    }
  }

  return comparable;
}

function rawPersistedModelNeedsAnonymousRewrite(value: unknown): boolean {
  const normalizedModel = normalizeModels([value])[0];
  if (!normalizedModel) {
    return true;
  }

  const sanitizedModel = sanitizeAnonymousCatalogModel(normalizedModel);
  return sanitizedModel === null
    || JSON.stringify(toJsonComparableValue(value))
      !== JSON.stringify(toJsonComparableValue(sanitizedModel));
}

function rawSearchEntryNeedsAnonymousRewrite(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return true;
  }

  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== 'object') {
    return true;
  }

  const models = (result as { models?: unknown }).models;
  return !Array.isArray(models) || models.some((model) => rawPersistedModelNeedsAnonymousRewrite(model));
}

function rawSnapshotEntryNeedsAnonymousRewrite(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return true;
  }

  return rawPersistedModelNeedsAnonymousRewrite((value as { model?: unknown }).model);
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

function normalizeSearchResult(value: unknown): CatalogCacheResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    models?: unknown;
    hasMore?: unknown;
    nextCursor?: unknown;
  };
  const models = normalizeModels(candidate.models);
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
  };
}

function normalizeSearchEntry(value: unknown): SearchCacheEntry | null {
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
  const result = normalizeSearchResult(candidate.result);

  if (!scope || !result || typeof candidate.key !== 'string') {
    return null;
  }

  return {
    key: candidate.key,
    timestamp: typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? Math.round(candidate.timestamp)
      : 0,
    scope,
    result,
  };
}

function normalizeSnapshotEntry(value: unknown): SnapshotCacheEntry | null {
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

  const models = normalizeModels(candidate.model ? [candidate.model] : []);
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
    const clonedResult = this.cloneSearchResult(result);
    const entry: SearchCacheEntry = {
      key,
      timestamp: Date.now(),
      scope: {
        ...scope,
        cursor: scope.cursor ?? null,
      },
      result: scope.authScope === 'anon'
        ? {
          ...clonedResult,
          models: sanitizeAnonymousPersistedModels(clonedResult.models),
        }
        : clonedResult,
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
      rawSearchEntryNeedsAnonymousRewrite,
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

      const sanitizedModels = sanitizeAnonymousPersistedModels(entry.result.models);
      if (sanitizedModels.length !== entry.result.models.length) {
        shouldRewriteSearchPayload = true;
      }

      entry.result.models = sanitizedModels;
      this.searchEntries.set(entry.key, entry);
    });

    let shouldRewriteSnapshotPayload = false;
    const snapshotPayloadResult = this.parsePayload<SnapshotCacheEntry>(
      this.storage.getString(SNAPSHOT_CACHE_KEY),
      normalizeSnapshotEntry,
      rawSnapshotEntryNeedsAnonymousRewrite,
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

      const sanitizedModel = sanitizeAnonymousCatalogModel(entry.model);
      if (sanitizedModel) {
        entry.model = sanitizedModel;
        this.snapshotEntries.set(entry.key, entry);
      } else {
        shouldRewriteSnapshotPayload = true;
      }
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
    normalizeEntry: (value: unknown) => T | null,
    rawEntryNeedsRewrite: (value: unknown) => boolean = () => false,
  ): ParsedPayload<T> {
    if (!rawValue) {
      return { status: 'empty', entries: [], needsRewrite: false };
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

      const normalizedEntries = parsed.entries.map((entry) => normalizeEntry(entry));
      const entries = normalizedEntries.filter((entry): entry is T => entry !== null);

      return {
        status: 'ok',
        entries,
        needsRewrite: parsed.version !== MODEL_CATALOG_CACHE_PERSISTED_VERSION
          || normalizedEntries.some((entry) => entry === null)
          || parsed.entries.some((entry) => rawEntryNeedsRewrite(entry)),
      };
    } catch {
      return { status: 'invalid', entries: [], needsRewrite: false };
    }
  }

  private persistSearchEntries(): void {
    const entries = this.getSortedSearchEntries()
      .filter((entry) => entry.scope.authScope === 'anon')
      .map((entry) => ({
        ...entry,
        result: {
          ...entry.result,
          models: sanitizeAnonymousPersistedModels(entry.result.models),
        },
      }));
    this.persistBoundedPayload(SEARCH_CACHE_KEY, entries);
  }

  private persistSnapshotEntries(): void {
    const entries = this.getSortedSnapshotEntries()
      .filter((entry) => entry.authScope === 'anon')
      .flatMap((entry) => {
        const sanitizedModel = sanitizeAnonymousCatalogModel(entry.model);
        return sanitizedModel
          ? [{
            ...entry,
            model: sanitizedModel,
          }]
          : [];
      });
    this.persistBoundedPayload(SNAPSHOT_CACHE_KEY, entries);
  }

  private persistBoundedPayload<T>(key: typeof PERSISTED_CACHE_KEYS[number], entries: T[]): void {
    if (this.isPersistenceDisabled) {
      return;
    }

    const prefix = `{"version":${MODEL_CATALOG_CACHE_PERSISTED_VERSION},"entries":[`;
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
    return [
      scope.query,
      scope.cursor ?? '__initial__',
      scope.pageSize,
      scope.sort ?? '__default__',
      scope.authScope,
    ].join('::');
  }
}
