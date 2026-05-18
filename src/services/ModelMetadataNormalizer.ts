import {
  LifecycleStatus,
  ModelAccessState,
  type ModelCapabilitySnapshot,
  type ModelFileIntegrityMarker,
  type ModelGgufMetadata,
  type ModelMetadata,
  type ModelMemoryFitConfidence,
  type ModelMemoryFitDecision,
  type ModelMetadataTrust,
  type ModelThinkingCapabilitySnapshot,
} from '../types/models';
import { normalizePersistedModelCapabilitySnapshot } from '../utils/modelCapabilities';
import { getShortModelLabel } from '../utils/modelLabel';
import { buildHuggingFaceResolveUrl } from '../utils/huggingFaceUrls';
import { isValidLocalFileName } from '../utils/safeFilePath';
import { normalizeSha256Digest } from '../utils/sha256';

type PersistedModelMetadata = Partial<ModelMetadata> & {
  id: string;
  name?: string;
  author?: string;
  downloadUrl?: string;
};

function normalizeSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
}

function normalizeNullableCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value);
}

function normalizeLifecycleStatus(value: unknown): LifecycleStatus {
  return Object.values(LifecycleStatus).includes(value as LifecycleStatus)
    ? value as LifecycleStatus
    : LifecycleStatus.AVAILABLE;
}

function normalizeAccessState(value: unknown): ModelAccessState {
  return Object.values(ModelAccessState).includes(value as ModelAccessState)
    ? value as ModelAccessState
    : ModelAccessState.PUBLIC;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLocalFileName(value: unknown): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  return normalized !== undefined && isValidLocalFileName(normalized) ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMetadataTrust(value: unknown): ModelMetadataTrust | undefined {
  return value === 'verified_local'
    || value === 'trusted_remote'
    || value === 'inferred'
    || value === 'unknown'
    ? value
    : undefined;
}

function normalizeMemoryFitDecision(value: unknown): ModelMemoryFitDecision | undefined {
  return value === 'fits_high_confidence'
    || value === 'fits_low_confidence'
    || value === 'borderline'
    || value === 'likely_oom'
    || value === 'unknown'
    ? value
    : undefined;
}

function normalizeMemoryFitConfidence(value: unknown): ModelMemoryFitConfidence | undefined {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function fitsInRamForMemoryFitDecision(decision: ModelMemoryFitDecision): boolean | null {
  if (decision === 'fits_high_confidence' || decision === 'fits_low_confidence') {
    return true;
  }

  if (decision === 'borderline' || decision === 'likely_oom') {
    return false;
  }

  return null;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const normalized = normalizeSize(value);
  return normalized === null ? undefined : normalized;
}

function normalizeScalarMetadataValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return normalizeNonEmptyString(value);
}

function normalizeGgufMetadata(value: unknown): ModelGgufMetadata | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const preservedPrefixedMetadata = Object.fromEntries(
    Object.entries(record).flatMap(([key, rawValue]) => {
      if (!key.includes('.')) {
        return [];
      }

      const normalizedValue = normalizeScalarMetadataValue(rawValue);
      return normalizedValue === undefined ? [] : [[key, normalizedValue]];
    }),
  ) as Record<string, string | number>;
  const architecture = normalizeNonEmptyString(record.architecture ?? record['general.architecture']);
  const sizeLabel = normalizeNonEmptyString(record.sizeLabel ?? record.size_label);
  const totalBytes = normalizePositiveInteger(record.totalBytes ?? record.total);
  const contextLengthTokens = normalizePositiveInteger(record.contextLengthTokens ?? record.context_length);
  const slidingWindowTokens = normalizePositiveInteger(
    record.slidingWindowTokens
    ?? record.sliding_window,
  );
  const nLayers = normalizePositiveInteger(record.nLayers ?? record.n_layers);
  const nHeadKv = normalizePositiveInteger(record.nHeadKv ?? record.n_head_kv);
  const nEmbdHeadK = normalizePositiveInteger(record.nEmbdHeadK ?? record.n_embd_head_k);
  const nEmbdHeadV = normalizePositiveInteger(record.nEmbdHeadV ?? record.n_embd_head_v);

  const normalized: ModelGgufMetadata = {
    ...preservedPrefixedMetadata,
    ...(architecture !== undefined ? { architecture } : {}),
    ...(sizeLabel !== undefined ? { sizeLabel } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(contextLengthTokens !== undefined ? { contextLengthTokens } : {}),
    ...(slidingWindowTokens !== undefined ? { slidingWindowTokens } : {}),
    ...(nLayers !== undefined ? { nLayers } : {}),
    ...(nHeadKv !== undefined ? { nHeadKv } : {}),
    ...(nEmbdHeadK !== undefined ? { nEmbdHeadK } : {}),
    ...(nEmbdHeadV !== undefined ? { nEmbdHeadV } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeThinkingCapabilitySnapshot(value: unknown): ModelThinkingCapabilitySnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const detectedAt = typeof record.detectedAt === 'number' && Number.isFinite(record.detectedAt)
    ? Math.max(0, Math.round(record.detectedAt))
    : null;
  const supportsThinking = typeof record.supportsThinking === 'boolean' ? record.supportsThinking : null;
  const canDisableThinking = typeof record.canDisableThinking === 'boolean' ? record.canDisableThinking : null;
  const thinkingStartTag = normalizeNonEmptyString(record.thinkingStartTag);
  const thinkingEndTag = normalizeNonEmptyString(record.thinkingEndTag);

  if (detectedAt === null || supportsThinking === null || canDisableThinking === null) {
    if (process.env.NODE_ENV !== 'test' && Object.keys(record).length > 0) {
      const missing: string[] = [];
      if (detectedAt === null) missing.push('detectedAt');
      if (supportsThinking === null) missing.push('supportsThinking');
      if (canDisableThinking === null) missing.push('canDisableThinking');

      console.warn(
        `[ModelMetadataNormalizer] Dropping invalid thinkingCapability snapshot (missing: ${missing.join(', ')})`,
        { keys: Object.keys(record) },
      );
    }
    return undefined;
  }

  return {
    detectedAt,
    supportsThinking,
    canDisableThinking,
    ...(thinkingStartTag ? { thinkingStartTag } : {}),
    ...(thinkingEndTag ? { thinkingEndTag } : {}),
  };
}

function normalizeFileIntegrityMarker(value: unknown): ModelFileIntegrityMarker | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind === 'sha256' || record.kind === 'size' ? record.kind : null;
  const sizeBytes = normalizePositiveInteger(record.sizeBytes);
  const checkedAt = typeof record.checkedAt === 'number' && Number.isFinite(record.checkedAt)
    ? Math.max(0, Math.round(record.checkedAt))
    : undefined;
  const sha256 = normalizeSha256Digest(typeof record.sha256 === 'string' ? record.sha256 : undefined);

  if (!kind || sizeBytes === undefined || checkedAt === undefined) {
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

export function normalizePersistedModelMetadata(
  model: PersistedModelMetadata,
): ModelMetadata {
  const size = normalizeSize(model.size);
  const normalizedRevision = normalizeNonEmptyString(model.hfRevision);
  const downloadUrl = normalizeNonEmptyString(model.downloadUrl)
    ?? buildHuggingFaceResolveUrl(model.id, 'model.gguf', normalizedRevision);
  const normalizedName = normalizeNonEmptyString(model.name) ?? (getShortModelLabel(model.id) || model.id);
  const normalizedAuthor = normalizeNonEmptyString(model.author) ?? model.id.split('/')[0] ?? 'unknown';
  const localPath = normalizeLocalFileName(model.localPath);
  const persistedLifecycleStatus = normalizeLifecycleStatus(model.lifecycleStatus);
  const shouldDropDownloadedState = localPath === undefined && (
    persistedLifecycleStatus === LifecycleStatus.DOWNLOADED
    || persistedLifecycleStatus === LifecycleStatus.ACTIVE
  );
  const lifecycleStatus = shouldDropDownloadedState
    ? LifecycleStatus.AVAILABLE
    : persistedLifecycleStatus;
  const rawMetadataTrust = normalizeMetadataTrust(model.metadataTrust);
  const normalizedSha256 = normalizeSha256Digest(model.sha256);
  const normalizedMemoryFitDecision = size === null ? undefined : normalizeMemoryFitDecision(model.memoryFitDecision);
  const normalizedMemoryFitConfidence = size === null ? undefined : normalizeMemoryFitConfidence(model.memoryFitConfidence);
  const normalizedGguf = normalizeGgufMetadata(model.gguf);
  const thinkingCapability = normalizeThinkingCapabilitySnapshot(
    (model as PersistedModelMetadata & { thinkingCapability?: unknown }).thinkingCapability,
  );
  const normalizedDownloadIntegrity = normalizeFileIntegrityMarker(
    (model as PersistedModelMetadata & { downloadIntegrity?: unknown }).downloadIntegrity,
  );
  const hasCurrentSha256Integrity = normalizedDownloadIntegrity?.kind === 'sha256'
    && normalizedSha256 !== undefined
    && normalizedDownloadIntegrity.sha256 === normalizedSha256;
  const hasMismatchedSha256Integrity = normalizedDownloadIntegrity?.kind === 'sha256'
    && normalizedSha256 !== undefined
    && normalizedDownloadIntegrity.sha256 !== normalizedSha256;
  const shouldClearVerifiedLocalTrust = rawMetadataTrust === 'verified_local'
    && !hasCurrentSha256Integrity;
  const metadataTrust = (shouldDropDownloadedState && rawMetadataTrust === 'verified_local') || shouldClearVerifiedLocalTrust
    ? undefined
    : rawMetadataTrust;
  const memoryFitDecision = shouldClearVerifiedLocalTrust ? undefined : normalizedMemoryFitDecision;
  const memoryFitConfidence = shouldClearVerifiedLocalTrust ? undefined : normalizedMemoryFitConfidence;
  const gguf = shouldClearVerifiedLocalTrust ? undefined : normalizedGguf;
  const normalizedMaxContextTokens = typeof model.maxContextTokens === 'number' && Number.isFinite(model.maxContextTokens)
    ? Math.round(model.maxContextTokens)
    : undefined;
  const maxContextTokens = shouldClearVerifiedLocalTrust ? undefined : normalizedMaxContextTokens;
  const hasVerifiedContextWindow = !shouldClearVerifiedLocalTrust && model.hasVerifiedContextWindow === true;
  const downloadIntegrity = shouldDropDownloadedState || hasMismatchedSha256Integrity
    ? undefined
    : normalizedDownloadIntegrity;
  const rawProgress = typeof model.downloadProgress === 'number' && Number.isFinite(model.downloadProgress)
    ? model.downloadProgress
    : 0;
  const downloadProgress = shouldDropDownloadedState ? 0 : Math.max(0, Math.min(rawProgress, 1));
  const downloadedAt = !shouldDropDownloadedState
    && typeof model.downloadedAt === 'number'
    && Number.isFinite(model.downloadedAt)
    ? Math.round(model.downloadedAt)
    : undefined;
  const resumeData = shouldDropDownloadedState
    ? undefined
    : normalizeNonEmptyString(model.resumeData);
  const downloadErrorCode = shouldDropDownloadedState
    ? undefined
    : normalizeNonEmptyString(model.downloadErrorCode);
  const downloadErrorMessage = shouldDropDownloadedState
    ? undefined
    : normalizeNonEmptyString(model.downloadErrorMessage);
  const downloadErrorAt = !shouldDropDownloadedState
    && typeof model.downloadErrorAt === 'number'
    && Number.isFinite(model.downloadErrorAt)
    ? Math.max(0, Math.round(model.downloadErrorAt))
    : undefined;
  const capabilitySnapshot = normalizePersistedModelCapabilitySnapshot({
    gguf,
    hasVerifiedContextWindow,
    lastModifiedAt: typeof model.lastModifiedAt === 'number' && Number.isFinite(model.lastModifiedAt)
      ? Math.round(model.lastModifiedAt)
      : undefined,
    maxContextTokens: typeof model.maxContextTokens === 'number' && Number.isFinite(model.maxContextTokens)
      ? Math.round(model.maxContextTokens)
      : undefined,
    metadataTrust,
    sha256: normalizedSha256,
    size,
  }, (model as PersistedModelMetadata & { capabilitySnapshot?: ModelCapabilitySnapshot }).capabilitySnapshot);

  return {
    id: model.id,
    name: normalizedName,
    author: normalizedAuthor,
    size,
    downloadUrl,
    allowUnknownSizeDownload: model.allowUnknownSizeDownload === true,
    requiresTreeProbe: model.requiresTreeProbe === true,
    hfRevision: normalizedRevision,
    resolvedFileName: normalizeNonEmptyString(model.resolvedFileName),
    localPath,
    downloadedAt,
    lastModifiedAt: typeof model.lastModifiedAt === 'number' && Number.isFinite(model.lastModifiedAt)
      ? Math.round(model.lastModifiedAt)
      : undefined,
    sha256: normalizedSha256,
    ...(downloadIntegrity !== undefined ? { downloadIntegrity } : {}),
    fitsInRam: size === null || shouldClearVerifiedLocalTrust
      ? null
      : memoryFitDecision !== undefined
        ? fitsInRamForMemoryFitDecision(memoryFitDecision)
        : typeof model.fitsInRam === 'boolean'
          ? model.fitsInRam
          : null,
    ...(memoryFitDecision !== undefined ? { memoryFitDecision } : {}),
    ...(memoryFitConfidence !== undefined ? { memoryFitConfidence } : {}),
    ...(metadataTrust !== undefined ? { metadataTrust } : {}),
    ...(gguf !== undefined ? { gguf } : {}),
    ...(thinkingCapability !== undefined ? { thinkingCapability } : {}),
    accessState: normalizeAccessState(model.accessState),
    isGated: model.isGated === true,
    isPrivate: model.isPrivate === true,
    lifecycleStatus,
    downloadProgress,
    resumeData,
    downloadErrorCode,
    downloadErrorMessage,
    downloadErrorAt,
    maxContextTokens,
    hasVerifiedContextWindow,
    capabilitySnapshot,
    parameterSizeLabel: normalizeNonEmptyString(model.parameterSizeLabel),
    modelType: normalizeNonEmptyString(model.modelType),
    architectures: normalizeStringArray(model.architectures),
    baseModels: normalizeStringArray(model.baseModels),
    license: normalizeNonEmptyString(model.license),
    languages: normalizeStringArray(model.languages),
    datasets: normalizeStringArray(model.datasets),
    quantizedBy: normalizeNonEmptyString(model.quantizedBy),
    modelCreator: normalizeNonEmptyString(model.modelCreator),
    downloads: normalizeNullableCount(model.downloads),
    likes: normalizeNullableCount(model.likes),
    tags: normalizeStringArray(model.tags),
    description: normalizeNonEmptyString(model.description),
  };
}
