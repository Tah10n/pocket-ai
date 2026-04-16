import {
  LifecycleStatus,
  ModelAccessState,
  type ModelCapabilitySnapshot,
  type ModelGgufMetadata,
  type ModelMetadata,
  type ModelMemoryFitConfidence,
  type ModelMemoryFitDecision,
  type ModelMetadataTrust,
} from '../types/models';
import { normalizePersistedModelCapabilitySnapshot } from '../utils/modelCapabilities';
import { buildHuggingFaceResolveUrl } from '../utils/huggingFaceUrls';

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

export function normalizePersistedModelMetadata(
  model: PersistedModelMetadata,
): ModelMetadata {
  const size = normalizeSize(model.size);
  const normalizedRevision = normalizeNonEmptyString(model.hfRevision);
  const downloadUrl = normalizeNonEmptyString(model.downloadUrl)
    ?? buildHuggingFaceResolveUrl(model.id, 'model.gguf', normalizedRevision);
  const normalizedName = normalizeNonEmptyString(model.name) ?? model.id.split('/').pop() ?? model.id;
  const normalizedAuthor = normalizeNonEmptyString(model.author) ?? model.id.split('/')[0] ?? 'unknown';
  const lifecycleStatus = normalizeLifecycleStatus(model.lifecycleStatus);
  const metadataTrust = normalizeMetadataTrust(model.metadataTrust);
  const memoryFitDecision = size === null ? undefined : normalizeMemoryFitDecision(model.memoryFitDecision);
  const memoryFitConfidence = size === null ? undefined : normalizeMemoryFitConfidence(model.memoryFitConfidence);
  const gguf = normalizeGgufMetadata(model.gguf);
  const rawProgress = typeof model.downloadProgress === 'number' && Number.isFinite(model.downloadProgress)
    ? model.downloadProgress
    : 0;
  const downloadProgress = Math.max(0, Math.min(rawProgress, 1));
  const capabilitySnapshot = normalizePersistedModelCapabilitySnapshot({
    gguf,
    hasVerifiedContextWindow: model.hasVerifiedContextWindow === true,
    lastModifiedAt: typeof model.lastModifiedAt === 'number' && Number.isFinite(model.lastModifiedAt)
      ? Math.round(model.lastModifiedAt)
      : undefined,
    maxContextTokens: typeof model.maxContextTokens === 'number' && Number.isFinite(model.maxContextTokens)
      ? Math.round(model.maxContextTokens)
      : undefined,
    metadataTrust,
    sha256: normalizeNonEmptyString(model.sha256),
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
    localPath: normalizeNonEmptyString(model.localPath),
    downloadedAt: typeof model.downloadedAt === 'number' && Number.isFinite(model.downloadedAt)
      ? Math.round(model.downloadedAt)
      : undefined,
    lastModifiedAt: typeof model.lastModifiedAt === 'number' && Number.isFinite(model.lastModifiedAt)
      ? Math.round(model.lastModifiedAt)
      : undefined,
    sha256: normalizeNonEmptyString(model.sha256),
    fitsInRam: size === null
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
    accessState: normalizeAccessState(model.accessState),
    isGated: model.isGated === true,
    isPrivate: model.isPrivate === true,
    lifecycleStatus,
    downloadProgress,
    resumeData: normalizeNonEmptyString(model.resumeData),
    maxContextTokens: typeof model.maxContextTokens === 'number' && Number.isFinite(model.maxContextTokens)
      ? Math.round(model.maxContextTokens)
      : undefined,
    hasVerifiedContextWindow: model.hasVerifiedContextWindow === true,
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
