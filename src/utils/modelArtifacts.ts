import {
  LifecycleStatus,
  type ModelArtifactInstallState,
  type ModelArtifactMetadata,
  type ModelArtifactRequiredInput,
  type ModelFileIntegrityMarker,
  type ModelMetadata,
} from '../types/models';
import type { ProjectorArtifact } from '../types/multimodal';
import { normalizeDownloadResumeData } from './downloadResumeData';
import {
  hasConsistentRemoteProjectorIdentity,
  hasHuggingFaceHostname,
  remoteProjectorIdentityKey,
  resolveHuggingFaceRevision,
  resolveHuggingFaceResolveIdentity,
  resolveRemoteFilePathFromDownloadUrl,
} from './huggingFaceUrls';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
  normalizeProjectorArtifactPath,
} from './modelProjectors';
import {
  canonicalizeProjectorCandidateAliases,
  remapProjectorAliasId,
} from './projectorIdentity';
import { isValidLocalFileName } from './safeFilePath';
import { normalizeSha256Digest } from './sha256';
import { getSelectedMtpDraftArtifact } from './modelSpeculativeDecoding';

type LegacyModelArtifactInput = Pick<
  ModelMetadata,
  | 'artifacts'
  | 'downloadErrorCode'
  | 'downloadErrorMessage'
  | 'downloadErrorAt'
  | 'downloadIntegrity'
  | 'downloadProgress'
  | 'downloadUrl'
  | 'hfRevision'
  | 'id'
  | 'chatModalities'
  | 'inputCapabilities'
  | 'lifecycleStatus'
  | 'localPath'
  | 'multimodalReadiness'
  | 'projectorCandidates'
  | 'resolvedFileName'
  | 'resumeData'
  | 'selectedProjectorId'
  | 'sha256'
  | 'size'
>;

type MergeModelArtifactsOptions = {
  preferDerivedRuntimeState?: boolean;
  preservePersistedRuntimeState?: boolean;
  preservePersistedCompanionSelection?: boolean;
};

type StableModelArtifactMetadata = Pick<
  ModelArtifactMetadata,
  | 'id'
  | 'kind'
  | 'requiredFor'
  | 'selected'
  | 'boundToModelIdentity'
  | 'hfRevision'
  | 'remoteFileName'
  | 'downloadUrl'
  | 'sizeBytes'
  | 'sha256'
>;

const MODEL_ARTIFACT_REQUIRED_INPUTS = new Set<ModelArtifactRequiredInput>(['text', 'image', 'audio']);

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeLocalFileName(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized !== undefined && isValidLocalFileName(normalized) ? normalized : undefined;
}

function normalizePositiveSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function normalizeNonNegativeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function normalizeArtifactInstallState(value: unknown): ModelArtifactInstallState | undefined {
  return value === 'remote'
    || value === 'queued'
    || value === 'downloading'
    || value === 'verifying'
    || value === 'paused'
    || value === 'installed'
    || value === 'failed'
    || value === 'missing'
    ? value
    : undefined;
}

function normalizeDownloadProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.min(value, 1));
}

function normalizeRequiredInputs(value: unknown): ModelArtifactRequiredInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is ModelArtifactRequiredInput => (
    MODEL_ARTIFACT_REQUIRED_INPUTS.has(entry as ModelArtifactRequiredInput)
  )))];
}

function normalizeIntegrityMarker(value: unknown): ModelFileIntegrityMarker | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind === 'sha256' || record.kind === 'size' ? record.kind : undefined;
  const sizeBytes = normalizePositiveSize(record.sizeBytes);
  const checkedAt = normalizeNonNegativeTimestamp(record.checkedAt);
  const sha256 = normalizeSha256Digest(typeof record.sha256 === 'string' ? record.sha256 : undefined);
  if (!kind || sizeBytes === null || checkedAt === undefined) {
    return undefined;
  }

  if (kind === 'sha256' && !sha256) {
    return undefined;
  }

  return {
    kind,
    sizeBytes,
    checkedAt,
    ...(sha256 ? { sha256 } : {}),
  };
}

function normalizeArtifactIdPart(value: string | undefined, fallback: string): string {
  const normalized = normalizeOptionalString(value) ?? fallback;
  return normalized.toLowerCase().replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

export function buildMainModelArtifactId(model: Pick<ModelMetadata, 'id' | 'hfRevision' | 'resolvedFileName'>): string {
  return [
    'main',
    normalizeArtifactIdPart(model.id, 'model'),
    normalizeArtifactIdPart(model.hfRevision, 'main'),
    normalizeArtifactIdPart(model.resolvedFileName, 'model.gguf'),
  ].join('-');
}

function installStateFromModelLifecycle(
  lifecycleStatus: LifecycleStatus,
  localPath: string | undefined,
): ModelArtifactInstallState {
  if (lifecycleStatus === LifecycleStatus.DOWNLOADED || lifecycleStatus === LifecycleStatus.ACTIVE) {
    return localPath ? 'installed' : 'missing';
  }

  if (lifecycleStatus === LifecycleStatus.QUEUED) {
    return 'queued';
  }

  if (lifecycleStatus === LifecycleStatus.DOWNLOADING || lifecycleStatus === LifecycleStatus.PAUSED) {
    return 'downloading';
  }

  if (lifecycleStatus === LifecycleStatus.VERIFYING) {
    return 'verifying';
  }

  if (lifecycleStatus === LifecycleStatus.FAILED) {
    return 'failed';
  }

  return 'remote';
}

function installStateFromProjectorLifecycle(projector: Pick<ProjectorArtifact, 'lifecycleStatus' | 'localPath'>): ModelArtifactInstallState {
  if (projector.lifecycleStatus === 'downloaded' || projector.lifecycleStatus === 'active') {
    return normalizeLocalFileName(projector.localPath) ? 'installed' : 'missing';
  }

  if (projector.lifecycleStatus === 'queued') {
    return 'queued';
  }

  if (projector.lifecycleStatus === 'downloading' || projector.lifecycleStatus === 'paused') {
    return 'downloading';
  }

  if (projector.lifecycleStatus === 'failed') {
    return 'failed';
  }

  return 'remote';
}

function inferProjectorRequiredInputs(model: Pick<ModelMetadata, 'chatModalities' | 'inputCapabilities' | 'multimodalReadiness'>): ModelArtifactRequiredInput[] {
  const requiredFor = new Set<ModelArtifactRequiredInput>();
  const hasExplicitChatModalities = Array.isArray(model.chatModalities);
  const requestedSupportCanAddVision = !hasExplicitChatModalities
    || model.chatModalities?.includes('vision') === true;
  const requestedSupportCanAddAudio = !hasExplicitChatModalities
    || model.chatModalities?.includes('audio') === true;
  if (
    model.chatModalities?.includes('vision') === true
    || model.inputCapabilities?.declared.image === 'supported'
    || model.multimodalReadiness?.support.includes('vision') === true
    || (
      requestedSupportCanAddVision
      && model.multimodalReadiness?.requestedSupport?.includes('vision') === true
    )
  ) {
    requiredFor.add('image');
  }

  if (
    model.chatModalities?.includes('audio') === true
    || model.inputCapabilities?.declared.audio === 'supported'
    || model.multimodalReadiness?.support.includes('audio')
    || (
      requestedSupportCanAddAudio
      && model.multimodalReadiness?.requestedSupport?.includes('audio') === true
    )
  ) {
    requiredFor.add('audio');
  }

  return requiredFor.size > 0 ? Array.from(requiredFor) : ['image'];
}

function deriveMainModelArtifact(model: LegacyModelArtifactInput): ModelArtifactMetadata {
  const localPath = normalizeLocalFileName(model.localPath);
  const remoteFileName = normalizeOptionalString(model.resolvedFileName)
    ?? normalizeOptionalString(model.localPath)
    ?? 'model.gguf';
  const installState = installStateFromModelLifecycle(model.lifecycleStatus, localPath);

  return {
    id: buildMainModelArtifactId(model),
    kind: 'main_model',
    requiredFor: ['text'],
    ...(model.hfRevision ? { hfRevision: model.hfRevision } : {}),
    remoteFileName,
    downloadUrl: model.downloadUrl,
    sizeBytes: normalizePositiveSize(model.size),
    ...(normalizeSha256Digest(model.sha256) ? { sha256: normalizeSha256Digest(model.sha256) } : {}),
    ...(localPath ? { localPath } : {}),
    installState,
    ...(normalizeDownloadProgress(model.downloadProgress) !== undefined
      ? { downloadProgress: normalizeDownloadProgress(model.downloadProgress) }
      : {}),
    ...(normalizeDownloadResumeData(model.resumeData) ? { resumeData: normalizeDownloadResumeData(model.resumeData) } : {}),
    ...(model.downloadIntegrity ? { integrity: model.downloadIntegrity } : {}),
    ...(normalizeOptionalString(model.downloadErrorCode) ? { errorCode: normalizeOptionalString(model.downloadErrorCode) } : {}),
    ...(normalizeOptionalString(model.downloadErrorMessage) ? { errorMessage: normalizeOptionalString(model.downloadErrorMessage) } : {}),
    ...(normalizeNonNegativeTimestamp(model.downloadErrorAt) !== undefined ? { updatedAt: normalizeNonNegativeTimestamp(model.downloadErrorAt) } : {}),
  };
}

function deriveProjectorArtifact(
  projector: ProjectorArtifact,
  model: Pick<ModelMetadata, 'chatModalities' | 'inputCapabilities' | 'multimodalReadiness'>,
): ModelArtifactMetadata | null {
  if (!hasConsistentRemoteProjectorIdentity({
    repoId: projector.repoId,
    revision: projector.hfRevision,
    filePath: projector.fileName,
    downloadUrl: projector.downloadUrl,
  })) {
    return null;
  }

  const localPath = normalizeLocalFileName(projector.localPath);

  return {
    id: projector.id,
    kind: 'multimodal_projector',
    requiredFor: inferProjectorRequiredInputs(model),
    ...(projector.hfRevision ? { hfRevision: projector.hfRevision } : {}),
    remoteFileName: projector.fileName,
    downloadUrl: projector.downloadUrl,
    sizeBytes: normalizePositiveSize(projector.size),
    ...(normalizeSha256Digest(projector.sha256) ? { sha256: normalizeSha256Digest(projector.sha256) } : {}),
    ...(localPath ? { localPath } : {}),
    installState: installStateFromProjectorLifecycle(projector),
    ...(normalizeDownloadProgress(projector.downloadProgress) !== undefined
      ? { downloadProgress: normalizeDownloadProgress(projector.downloadProgress) }
      : {}),
    ...(normalizeDownloadResumeData(projector.resumeData) ? { resumeData: normalizeDownloadResumeData(projector.resumeData) } : {}),
    ...(normalizeOptionalString(projector.matchReason) && projector.matchStatus === 'failed'
      ? { errorMessage: normalizeOptionalString(projector.matchReason) }
      : {}),
  };
}

function shouldSynthesizeMainArtifact(model: LegacyModelArtifactInput): boolean {
  return Boolean(
    normalizeLocalFileName(model.localPath)
    || model.lifecycleStatus === LifecycleStatus.DOWNLOADED
    || model.lifecycleStatus === LifecycleStatus.ACTIVE
    || model.lifecycleStatus === LifecycleStatus.QUEUED
    || model.lifecycleStatus === LifecycleStatus.DOWNLOADING
    || model.lifecycleStatus === LifecycleStatus.PAUSED
    || model.lifecycleStatus === LifecycleStatus.VERIFYING
    || model.lifecycleStatus === LifecycleStatus.FAILED
  );
}

function projectorArtifactIsBoundToCandidate(
  artifact: ModelArtifactMetadata,
  candidate: ProjectorArtifact,
): boolean {
  if (artifact.kind !== 'multimodal_projector') {
    return false;
  }

  const identity = {
    repoId: candidate.repoId,
    hfRevision: candidate.hfRevision,
    ownerVariantId: candidate.ownerVariantId,
    fileName: candidate.fileName,
  };
  if (
    artifact.id === candidate.id
    || artifact.id === buildProjectorArtifactId(identity)
    || artifact.id === buildLegacyProjectorArtifactId(identity)
  ) {
    return true;
  }

  const artifactPath = normalizeProjectorArtifactPath(artifact.remoteFileName);
  const candidatePath = normalizeProjectorArtifactPath(candidate.fileName);
  const artifactDownloadIdentity = normalizeArtifactDownloadUrl(artifact);
  const candidateDownloadIdentity = normalizeArtifactDownloadUrl({
    id: candidate.id,
    kind: 'multimodal_projector',
    requiredFor: ['image'],
    hfRevision: candidate.hfRevision,
    remoteFileName: candidate.fileName,
    downloadUrl: candidate.downloadUrl,
    sizeBytes: candidate.size,
    installState: 'remote',
  });
  return artifactPath !== null
    && artifactPath === candidatePath
    && normalizeArtifactRevision(artifact.hfRevision) === normalizeArtifactRevision(candidate.hfRevision)
    && artifactDownloadIdentity !== null
    && artifactDownloadIdentity === candidateDownloadIdentity;
}

export function getUnboundProjectorArtifactsForBookkeeping(
  artifacts: readonly ModelArtifactMetadata[] | undefined,
  candidates: readonly ProjectorArtifact[],
): ModelArtifactMetadata[] {
  return (artifacts ?? []).filter((artifact) => (
    artifact.kind === 'multimodal_projector'
    && !candidates.some((candidate) => projectorArtifactIsBoundToCandidate(artifact, candidate))
  ));
}

export function deriveArtifactsFromLegacyModel(
  model: LegacyModelArtifactInput,
  options: { includeRemoteMain?: boolean; preferLegacyRuntimeState?: boolean } = {},
): ModelArtifactMetadata[] {
  const artifacts: ModelArtifactMetadata[] = [];
  if (options.includeRemoteMain === true || shouldSynthesizeMainArtifact(model)) {
    artifacts.push(deriveMainModelArtifact(model));
  }

  const canonicalProjectors = canonicalizeProjectorCandidateAliases(
    model.projectorCandidates ?? [],
    model.artifacts,
  );
  for (const projector of canonicalProjectors.candidates) {
    const artifact = deriveProjectorArtifact(projector, model);
    if (artifact) {
      artifacts.push(artifact);
    }
  }

  const canonicalPersistedArtifacts = model.artifacts === undefined
    ? undefined
    : [
        ...model.artifacts.filter((artifact) => artifact.kind !== 'multimodal_projector'),
        ...canonicalProjectors.artifacts,
        // Artifact-only records remain necessary for safe local-file cleanup.
        // Never retain an artifact that claimed a candidate scope and was
        // rejected by exact canonicalization.
        ...getUnboundProjectorArtifactsForBookkeeping(
          model.artifacts,
          model.projectorCandidates ?? [],
        ),
      ];
  return mergeModelArtifacts(artifacts, canonicalPersistedArtifacts, {
    preferDerivedRuntimeState: options.preferLegacyRuntimeState === true,
  });
}

export function normalizePersistedModelArtifacts(value: unknown): ModelArtifactMetadata[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const artifacts = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const id = normalizeOptionalString(record.id);
    const kind: ModelArtifactMetadata['kind'] | undefined = record.kind === 'main_model'
      || record.kind === 'multimodal_projector'
      || record.kind === 'speculative_draft'
      || record.kind === 'tts_codec'
      || record.kind === 'lora_adapter'
      ? record.kind
      : undefined;
    const remoteFileName = normalizeOptionalString(record.remoteFileName);
    const downloadUrl = normalizeOptionalString(record.downloadUrl);
    const installState = normalizeArtifactInstallState(record.installState);
    const requiredFor = normalizeRequiredInputs(record.requiredFor);
    if (
      !id
      || !kind
      || !remoteFileName
      || !downloadUrl
      || !installState
      || (requiredFor.length === 0 && kind !== 'tts_codec' && kind !== 'lora_adapter' && kind !== 'speculative_draft')
      || (kind !== 'multimodal_projector' && seen.has(id))
    ) {
      return [];
    }

    const sha256 = normalizeSha256Digest(typeof record.sha256 === 'string' ? record.sha256 : undefined);
    const localPath = normalizeLocalFileName(record.localPath);
    const downloadProgress = normalizeDownloadProgress(record.downloadProgress);
    const resumeData = normalizeDownloadResumeData(record.resumeData);
    const integrity = normalizeIntegrityMarker(record.integrity);
    const updatedAt = normalizeNonNegativeTimestamp(record.updatedAt);

    const artifact: ModelArtifactMetadata = {
      id,
      kind,
      requiredFor: kind === 'tts_codec' || kind === 'lora_adapter' ? [] : requiredFor,
      ...(typeof record.selected === 'boolean' ? { selected: record.selected } : {}),
      ...(normalizeOptionalString(record.boundToModelIdentity) ? { boundToModelIdentity: normalizeOptionalString(record.boundToModelIdentity) } : {}),
      ...(normalizeOptionalString(record.hfRevision) ? { hfRevision: normalizeOptionalString(record.hfRevision) } : {}),
      remoteFileName,
      downloadUrl,
      sizeBytes: normalizePositiveSize(record.sizeBytes),
      ...(sha256 ? { sha256 } : {}),
      ...(localPath ? { localPath } : {}),
      installState,
      ...(downloadProgress !== undefined ? { downloadProgress } : {}),
      ...(resumeData ? { resumeData } : {}),
      ...(integrity ? { integrity } : {}),
      ...(normalizeOptionalString(record.errorCode) ? { errorCode: normalizeOptionalString(record.errorCode) } : {}),
      ...(normalizeOptionalString(record.errorMessage) ? { errorMessage: normalizeOptionalString(record.errorMessage) } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
    if (!projectorArtifactHasConsistentRemoteIdentity(artifact)) {
      return [];
    }

    if (kind !== 'multimodal_projector') {
      seen.add(id);
    }
    return [artifact];
  });

  return artifacts.length > 0 ? artifacts : undefined;
}

export function mergeModelArtifacts(
  derivedArtifacts: readonly ModelArtifactMetadata[],
  persistedArtifacts?: readonly ModelArtifactMetadata[],
  options: MergeModelArtifactsOptions = {},
): ModelArtifactMetadata[] {
  const byId = new Map<string, ModelArtifactMetadata>();
  const orderedIds: string[] = [];

  for (const artifact of derivedArtifacts) {
    if (!projectorArtifactHasConsistentRemoteIdentity(artifact)) {
      continue;
    }
    byId.set(artifact.id, artifact);
    orderedIds.push(artifact.id);
  }

  if (!persistedArtifacts?.length) {
    return orderedIds.map((id) => byId.get(id)).filter((artifact): artifact is ModelArtifactMetadata => artifact !== undefined);
  }

  const persistedOrderedIds: string[] = [];
  for (const artifact of persistedArtifacts) {
    if (!projectorArtifactHasConsistentRemoteIdentity(artifact)) {
      continue;
    }
    const derivedArtifact = byId.get(artifact.id);
    const mergedArtifact = options.preservePersistedRuntimeState === true && derivedArtifact
      ? mergeArtifactWithPersistedRuntimeState(derivedArtifact, artifact, options.preservePersistedCompanionSelection)
      : options.preferDerivedRuntimeState === true && derivedArtifact
        ? mergeArtifactWithDerivedRuntimeState(derivedArtifact, artifact)
        : {
            ...derivedArtifact,
            ...artifact,
          };
    byId.set(artifact.id, mergedArtifact);
    persistedOrderedIds.push(artifact.id);
  }

  const derivedOnlyIds = orderedIds.filter((id) => !persistedOrderedIds.includes(id));
  return [...persistedOrderedIds, ...derivedOnlyIds]
    .map((id) => byId.get(id))
    .filter((artifact): artifact is ModelArtifactMetadata => artifact !== undefined);
}

function getStableArtifactMetadata(artifact: ModelArtifactMetadata): StableModelArtifactMetadata {
  return {
    id: artifact.id,
    kind: artifact.kind,
    requiredFor: artifact.requiredFor,
    selected: artifact.selected,
    boundToModelIdentity: artifact.boundToModelIdentity,
    ...(artifact.hfRevision !== undefined ? { hfRevision: artifact.hfRevision } : {}),
    remoteFileName: artifact.remoteFileName,
    downloadUrl: artifact.downloadUrl,
    sizeBytes: artifact.sizeBytes,
    ...(artifact.sha256 !== undefined ? { sha256: artifact.sha256 } : {}),
  };
}

function normalizeArtifactFileIdentity(artifact: ModelArtifactMetadata): string | null {
  if (artifact.kind === 'multimodal_projector') {
    return normalizeProjectorArtifactPath(artifact.remoteFileName);
  }

  const normalizedPath = artifact.remoteFileName.trim().replace(/\\/gu, '/');
  return normalizedPath;
}

function normalizeArtifactRevision(value: string | undefined): string {
  return normalizeOptionalString(value) ?? 'main';
}

function normalizeArtifactDownloadUrl(artifact: ModelArtifactMetadata): string | null {
  const normalized = artifact.downloadUrl.trim();
  if (artifact.kind === 'multimodal_projector' && hasHuggingFaceHostname(normalized)) {
    const identity = resolveHuggingFaceResolveIdentity(normalized);
    const filePath = normalizeProjectorArtifactPath(artifact.remoteFileName);
    return identity
      && filePath === identity.filePath
      && resolveHuggingFaceRevision(artifact.hfRevision) === identity.revision
      ? remoteProjectorIdentityKey(identity)
      : null;
  }

  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function projectorArtifactHasConsistentRemoteIdentity(artifact: ModelArtifactMetadata): boolean {
  if (artifact.kind !== 'multimodal_projector') {
    return true;
  }

  const artifactPath = normalizeProjectorArtifactPath(artifact.remoteFileName);
  return artifactPath !== null
    && resolveRemoteFilePathFromDownloadUrl(artifact.downloadUrl) === artifactPath
    && (!hasHuggingFaceHostname(artifact.downloadUrl) || normalizeArtifactDownloadUrl(artifact) !== null);
}

function artifactValuesConflict<T>(left: T | undefined, right: T | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

function artifactsShareStableIdentity(
  derivedArtifact: ModelArtifactMetadata,
  persistedArtifact: ModelArtifactMetadata,
): boolean {
  const derivedFileIdentity = normalizeArtifactFileIdentity(derivedArtifact);
  const persistedFileIdentity = normalizeArtifactFileIdentity(persistedArtifact);
  const derivedDownloadUrl = normalizeArtifactDownloadUrl(derivedArtifact);
  const persistedDownloadUrl = normalizeArtifactDownloadUrl(persistedArtifact);
  if (
    derivedArtifact.id !== persistedArtifact.id
    || derivedArtifact.kind !== persistedArtifact.kind
    || derivedFileIdentity === null
    || persistedFileIdentity === null
    || derivedFileIdentity !== persistedFileIdentity
    || derivedDownloadUrl === null
    || persistedDownloadUrl === null
    || normalizeArtifactRevision(derivedArtifact.hfRevision)
      !== normalizeArtifactRevision(persistedArtifact.hfRevision)
  ) {
    return false;
  }

  return !artifactValuesConflict(
    normalizeSha256Digest(derivedArtifact.sha256),
    normalizeSha256Digest(persistedArtifact.sha256),
  ) && !artifactValuesConflict(
    normalizePositiveSize(derivedArtifact.sizeBytes) ?? undefined,
    normalizePositiveSize(persistedArtifact.sizeBytes) ?? undefined,
  ) && !artifactValuesConflict(
    derivedDownloadUrl,
    persistedDownloadUrl,
  );
}

function mergeArtifactWithDerivedRuntimeState(
  derivedArtifact: ModelArtifactMetadata,
  persistedArtifact: ModelArtifactMetadata,
): ModelArtifactMetadata {
  const persistedStable = getStableArtifactMetadata(persistedArtifact);
  const sharesStableIdentity = artifactsShareStableIdentity(derivedArtifact, persistedArtifact);
  const requiredFor = sharesStableIdentity
    ? persistedStable.requiredFor
    : derivedArtifact.requiredFor;
  const merged = {
    ...persistedStable,
    ...derivedArtifact,
    // Explicit persisted requirements can be narrower than model-wide legacy
    // modality fields (for example separate image and audio projectors). Keep
    // that projector-specific boundary only across the same stable artifact.
    requiredFor,
    sizeBytes: derivedArtifact.sizeBytes === null
      ? persistedStable.sizeBytes
      : derivedArtifact.sizeBytes,
  };

  if (
    sharesStableIdentity
    && derivedArtifact.kind !== 'main_model'
    && persistedArtifact.installState === 'installed'
    && persistedArtifact.localPath
  ) {
    return {
      ...merged,
      localPath: persistedArtifact.localPath,
      installState: 'installed',
      downloadProgress: persistedArtifact.downloadProgress ?? 1,
      resumeData: persistedArtifact.resumeData,
      integrity: persistedArtifact.integrity,
      errorCode: persistedArtifact.errorCode,
      errorMessage: persistedArtifact.errorMessage,
      updatedAt: persistedArtifact.updatedAt,
    };
  }

  return merged;
}

function mergeArtifactWithPersistedRuntimeState(
  derivedArtifact: ModelArtifactMetadata,
  persistedArtifact: ModelArtifactMetadata,
  preserveCompanionSelection = false,
): ModelArtifactMetadata {
  const sharesStableIdentity = artifactsShareStableIdentity(derivedArtifact, persistedArtifact);
  const merged = {
    ...getStableArtifactMetadata(persistedArtifact),
    ...derivedArtifact,
    sizeBytes: derivedArtifact.sizeBytes === null
      ? persistedArtifact.sizeBytes
      : derivedArtifact.sizeBytes,
  };
  if (!sharesStableIdentity || derivedArtifact.kind === 'main_model') {
    return merged;
  }

  return {
    ...merged,
    // Only a runtime projection opts in: explicit registry edits outrank a
    // stale route snapshot, and only after the source identity matched above.
    ...(preserveCompanionSelection && isManagedCompanionArtifact(derivedArtifact) ? {
      selected: persistedArtifact.selected,
      boundToModelIdentity: persistedArtifact.boundToModelIdentity,
    } : {}),
    localPath: persistedArtifact.localPath,
    installState: persistedArtifact.installState,
    downloadProgress: persistedArtifact.downloadProgress,
    resumeData: persistedArtifact.resumeData,
    integrity: persistedArtifact.integrity,
    errorCode: persistedArtifact.errorCode,
    errorMessage: persistedArtifact.errorMessage,
    updatedAt: persistedArtifact.updatedAt,
  };
}

export function getMainModelArtifact(model: Pick<ModelMetadata, 'artifacts'>): ModelArtifactMetadata | undefined {
  return model.artifacts?.find((artifact) => artifact.kind === 'main_model');
}

export function getProjectorArtifacts(model: Pick<ModelMetadata, 'artifacts'>): ModelArtifactMetadata[] {
  return model.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector') ?? [];
}

export function getSpeculativeDraftArtifacts(model: Pick<ModelMetadata, 'artifacts'>): ModelArtifactMetadata[] {
  return model.artifacts?.filter((artifact) => artifact.kind === 'speculative_draft') ?? [];
}

type ProjectorArtifactModelInput = Pick<ModelMetadata, 'artifacts' | 'selectedProjectorId'>
  & Partial<Pick<
    ModelMetadata,
    'activeVariantId' | 'projectorCandidates' | 'resolvedFileName' | 'speculativeDecoding' | 'variants'
  >>;

export function getSelectedProjectorArtifact(
  model: ProjectorArtifactModelInput,
): ModelArtifactMetadata | undefined {
  const projectors = getProjectorArtifacts(model);
  const selectedProjectorId = normalizeOptionalString(model.selectedProjectorId);
  if (selectedProjectorId) {
    const canonical = canonicalizeProjectorCandidateAliases(
      model.projectorCandidates ?? [],
      projectors,
    );
    const canonicalSelectedProjectorId = remapProjectorAliasId(selectedProjectorId, canonical)
      ?? selectedProjectorId;
    return canonical.artifacts.find((artifact) => artifact.id === canonicalSelectedProjectorId)
      ?? projectors.find((artifact) => artifact.id === canonicalSelectedProjectorId);
  }

  return projectors.length === 1 ? projectors[0] : undefined;
}

export function getRequiredDownloadArtifacts(
  model: ProjectorArtifactModelInput,
  mtpEnabledOverride?: boolean,
): ModelArtifactMetadata[] {
  const mainArtifact = getMainModelArtifact(model);
  const selectedProjector = getSelectedProjectorArtifact(model);
  const selectedSpeculativeDraft = getSelectedMtpDraftArtifact(model, mtpEnabledOverride);
  return [mainArtifact, selectedProjector, selectedSpeculativeDraft]
    .filter((artifact): artifact is ModelArtifactMetadata => (
      artifact !== undefined && artifact.installState !== 'installed'
    ));
}

export function getInstalledArtifactLocalPaths(model: Pick<ModelMetadata, 'artifacts'>): string[] {
  return Array.from(new Set((model.artifacts ?? []).flatMap((artifact) => (
    artifact.installState === 'installed' && artifact.localPath ? [artifact.localPath] : []
  ))));
}

export function getTotalInstalledModelBytes(model: Pick<ModelMetadata, 'artifacts'>): number {
  const seen = new Set<string>();
  return (model.artifacts ?? []).reduce((sum, artifact, index) => {
    if (artifact.installState !== 'installed') {
      return sum;
    }

    const identity = artifact.localPath ? `path:${artifact.localPath}` : `id:${artifact.id || index}`;
    if (seen.has(identity)) {
      return sum;
    }

    seen.add(identity);
    return sum + (normalizePositiveSize(artifact.sizeBytes) ?? 0);
  }, 0);
}

export function isMainArtifactReady(model: Pick<ModelMetadata, 'artifacts'>): boolean {
  return getMainModelArtifact(model)?.installState === 'installed';
}

export function isMultimodalArtifactReady(model: ProjectorArtifactModelInput): boolean {
  return getSelectedProjectorArtifact(model)?.installState === 'installed';
}

export function isSpeculativeDraftArtifactReady(
  model: Parameters<typeof getSelectedMtpDraftArtifact>[0],
  mtpEnabledOverride?: boolean,
): boolean {
  return getSelectedMtpDraftArtifact(model, mtpEnabledOverride)?.installState === 'installed';
}

export function syncLegacyMainArtifactFields(model: ModelMetadata): ModelMetadata {
  const mainArtifact = getMainModelArtifact(model);
  if (!mainArtifact) {
    return model;
  }

  return {
    ...model,
    downloadUrl: mainArtifact.downloadUrl,
    hfRevision: mainArtifact.hfRevision ?? model.hfRevision,
    resolvedFileName: mainArtifact.remoteFileName,
    size: mainArtifact.sizeBytes,
    sha256: mainArtifact.sha256,
    localPath: mainArtifact.localPath,
    downloadIntegrity: mainArtifact.integrity,
    resumeData: mainArtifact.resumeData,
    downloadProgress: mainArtifact.downloadProgress ?? model.downloadProgress,
  };
}

/** Generic companion ownership excludes projectors, which retain their existing pipeline. */
export function isManagedCompanionArtifact(artifact: Pick<ModelArtifactMetadata, 'kind'>): boolean {
  return artifact.kind === 'speculative_draft' || artifact.kind === 'tts_codec' || artifact.kind === 'lora_adapter';
}
export function getManagedCompanionArtifacts(model: Pick<ModelMetadata, 'artifacts'>): ModelArtifactMetadata[] {
  return model.artifacts?.filter(isManagedCompanionArtifact) ?? [];
}
export function getCompanionBindingIdentity(model: Pick<ModelMetadata, 'id' | 'downloadUrl' | 'hfRevision' | 'resolvedFileName' | 'sha256'>): string {
  return JSON.stringify([model.id, model.downloadUrl, model.hfRevision ?? 'main', model.resolvedFileName ?? '', model.sha256 ?? '']);
}
export function getSelectedManagedCompanions(model: ModelMetadata): ModelArtifactMetadata[] {
  const identity = getCompanionBindingIdentity(model);
  return getManagedCompanionArtifacts(model).filter(artifact => artifact.selected === true && artifact.boundToModelIdentity === identity);
}
export function bindManagedCompanion(model: ModelMetadata, input: {
  kind: 'tts_codec' | 'lora_adapter' | 'speculative_draft';
  downloadUrl: string; sizeBytes?: number | null; sha256?: string;
}): ModelMetadata {
  const url = new URL(input.downloadUrl.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Companion must use an HTTPS GGUF URL without credentials or fragment');
  }
  const identity = resolveHuggingFaceResolveIdentity(url.toString());
  const remoteFileName = identity?.filePath ?? decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!remoteFileName.toLowerCase().endsWith('.gguf') || remoteFileName.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('Select a GGUF companion file');
  }
  const sha256 = normalizeSha256Digest(input.sha256);
  if (input.sha256 && !sha256) throw new Error('Invalid SHA-256 digest');
  const id = input.kind + ':' + url.toString() + ':' + (sha256 ?? '');
  const existing = model.artifacts?.find(artifact => artifact.id === id);
  const sizeBytes = normalizePositiveSize(input.sizeBytes) ?? existing?.sizeBytes ?? null;
  const sizeChanged = existing !== undefined && existing.sizeBytes !== null && sizeBytes !== existing.sizeBytes;
  const artifact: ModelArtifactMetadata = {
    ...existing, id, kind: input.kind, requiredFor: [], selected: true,
    boundToModelIdentity: getCompanionBindingIdentity(model),
    remoteFileName, downloadUrl: url.toString(), hfRevision: identity?.revision,
    sizeBytes, sha256, installState: sizeChanged ? 'remote' : existing?.installState ?? 'remote',
    ...(sizeChanged ? { integrity: undefined, resumeData: undefined, downloadProgress: 0, errorCode: undefined, errorMessage: undefined } : {}),
  };
  const draftConfig = { type: 'mtp' as const, mode: 'draft_model' as const, enabled: false, maxDraftTokens: 3, draftArtifactId: id };
  return { ...model, ...(input.kind === 'speculative_draft' ? { speculativeDecoding: draftConfig, variants: model.variants?.map(variant => variant.variantId === model.activeVariantId || variant.fileName === model.resolvedFileName ? { ...variant, speculativeDecoding: draftConfig } : variant) } : {}), artifacts: [...(model.artifacts ?? []).filter(item => item.id !== id).map(item => (
    (input.kind === 'tts_codec' && item.kind === 'tts_codec') || (item.kind === input.kind && item.downloadUrl === url.toString()) ? { ...item, selected: false } : item
  )), artifact] };
}

/** Unknown sizes remain unknown; neither disk admission nor UI may treat them as zero. */
export function getManagedCompanionDiskPlan(model: ModelMetadata): {
  installedBytes: number;
  selectedDownloadBytes: number | null;
  unknownSizeCount: number;
} {
  const selected = getSelectedManagedCompanions(model);
  const installedSources = new Set(getManagedCompanionArtifacts(model).filter(artifact => artifact.installState === 'installed' && artifact.localPath).map(getCompanionSourceIdentity));
  const seen = new Set<string>();
  let knownBytes = 0;
  let unknownSizeCount = 0;
  for (const artifact of selected) {
    const key = getCompanionSourceIdentity(artifact);
    if (seen.has(key)) continue;
    seen.add(key);
    if (artifact.installState === 'installed' || installedSources.has(key)) continue;
    const size = normalizePositiveSize(artifact.sizeBytes);
    if (size === null) unknownSizeCount += 1;
    else knownBytes += size;
  }
  return { installedBytes: getTotalInstalledModelBytes(model), selectedDownloadBytes: unknownSizeCount ? null : knownBytes, unknownSizeCount };
}

export function getCompanionSourceIdentity(artifact: ModelArtifactMetadata): string {
  return JSON.stringify([artifact.downloadUrl, artifact.hfRevision ?? 'main', artifact.remoteFileName, artifact.sha256 ?? '', artifact.sizeBytes]);
}
