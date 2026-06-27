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
import { isValidLocalFileName } from './safeFilePath';
import { normalizeSha256Digest } from './sha256';

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
};

type StableModelArtifactMetadata = Pick<
  ModelArtifactMetadata,
  | 'id'
  | 'kind'
  | 'requiredFor'
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

function inferProjectorRequiredInputs(model: Pick<ModelMetadata, 'inputCapabilities' | 'multimodalReadiness'>): ModelArtifactRequiredInput[] {
  const requiredFor = new Set<ModelArtifactRequiredInput>(['image']);
  if (
    model.inputCapabilities?.declared.audio === 'supported'
    || model.multimodalReadiness?.support.includes('audio')
  ) {
    requiredFor.add('audio');
  }

  return Array.from(requiredFor);
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
  model: Pick<ModelMetadata, 'inputCapabilities' | 'multimodalReadiness'>,
): ModelArtifactMetadata {
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

export function deriveArtifactsFromLegacyModel(
  model: LegacyModelArtifactInput,
  options: { includeRemoteMain?: boolean; preferLegacyRuntimeState?: boolean } = {},
): ModelArtifactMetadata[] {
  const artifacts: ModelArtifactMetadata[] = [];
  if (options.includeRemoteMain === true || shouldSynthesizeMainArtifact(model)) {
    artifacts.push(deriveMainModelArtifact(model));
  }

  for (const projector of model.projectorCandidates ?? []) {
    artifacts.push(deriveProjectorArtifact(projector, model));
  }

  return mergeModelArtifacts(artifacts, model.artifacts, {
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
    const kind: ModelArtifactMetadata['kind'] | undefined = record.kind === 'main_model' || record.kind === 'multimodal_projector'
      ? record.kind
      : undefined;
    const remoteFileName = normalizeOptionalString(record.remoteFileName);
    const downloadUrl = normalizeOptionalString(record.downloadUrl);
    const installState = normalizeArtifactInstallState(record.installState);
    const requiredFor = normalizeRequiredInputs(record.requiredFor);
    if (!id || !kind || !remoteFileName || !downloadUrl || !installState || requiredFor.length === 0 || seen.has(id)) {
      return [];
    }

    seen.add(id);
    const sha256 = normalizeSha256Digest(typeof record.sha256 === 'string' ? record.sha256 : undefined);
    const localPath = normalizeLocalFileName(record.localPath);
    const downloadProgress = normalizeDownloadProgress(record.downloadProgress);
    const resumeData = normalizeDownloadResumeData(record.resumeData);
    const integrity = normalizeIntegrityMarker(record.integrity);
    const updatedAt = normalizeNonNegativeTimestamp(record.updatedAt);

    return [{
      id,
      kind,
      requiredFor,
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
    }];
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
    byId.set(artifact.id, artifact);
    orderedIds.push(artifact.id);
  }

  if (!persistedArtifacts?.length) {
    return orderedIds.map((id) => byId.get(id)).filter((artifact): artifact is ModelArtifactMetadata => artifact !== undefined);
  }

  const persistedOrderedIds: string[] = [];
  for (const artifact of persistedArtifacts) {
    const derivedArtifact = byId.get(artifact.id);
    byId.set(artifact.id, {
      ...(options.preferDerivedRuntimeState === true && derivedArtifact
        ? mergeArtifactWithDerivedRuntimeState(derivedArtifact, artifact)
        : {
          ...derivedArtifact,
          ...artifact,
        }),
    });
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
    ...(artifact.hfRevision !== undefined ? { hfRevision: artifact.hfRevision } : {}),
    remoteFileName: artifact.remoteFileName,
    downloadUrl: artifact.downloadUrl,
    sizeBytes: artifact.sizeBytes,
    ...(artifact.sha256 !== undefined ? { sha256: artifact.sha256 } : {}),
  };
}

function mergeArtifactWithDerivedRuntimeState(
  derivedArtifact: ModelArtifactMetadata,
  persistedArtifact: ModelArtifactMetadata,
): ModelArtifactMetadata {
  const persistedStable = getStableArtifactMetadata(persistedArtifact);
  return {
    ...persistedStable,
    ...derivedArtifact,
    sizeBytes: derivedArtifact.sizeBytes === null
      ? persistedStable.sizeBytes
      : derivedArtifact.sizeBytes,
  };
}

export function getMainModelArtifact(model: Pick<ModelMetadata, 'artifacts'>): ModelArtifactMetadata | undefined {
  return model.artifacts?.find((artifact) => artifact.kind === 'main_model');
}

export function getProjectorArtifacts(model: Pick<ModelMetadata, 'artifacts'>): ModelArtifactMetadata[] {
  return model.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector') ?? [];
}

export function getSelectedProjectorArtifact(
  model: Pick<ModelMetadata, 'artifacts' | 'selectedProjectorId'>,
): ModelArtifactMetadata | undefined {
  const projectors = getProjectorArtifacts(model);
  const selectedProjectorId = normalizeOptionalString(model.selectedProjectorId);
  if (selectedProjectorId) {
    return projectors.find((artifact) => artifact.id === selectedProjectorId);
  }

  return projectors.length === 1 ? projectors[0] : undefined;
}

export function getRequiredDownloadArtifacts(
  model: Pick<ModelMetadata, 'artifacts' | 'selectedProjectorId'>,
): ModelArtifactMetadata[] {
  const mainArtifact = getMainModelArtifact(model);
  const selectedProjector = getSelectedProjectorArtifact(model);
  return [mainArtifact, selectedProjector]
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

export function isMultimodalArtifactReady(model: Pick<ModelMetadata, 'artifacts' | 'selectedProjectorId'>): boolean {
  return getSelectedProjectorArtifact(model)?.installState === 'installed';
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
