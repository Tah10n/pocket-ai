import {
  LifecycleStatus,
  ModelAccessState,
  type ModelMetadata,
} from '../types/models';

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

export function normalizePersistedModelMetadata(
  model: PersistedModelMetadata,
): ModelMetadata {
  const size = normalizeSize(model.size);
  const downloadUrl = normalizeNonEmptyString(model.downloadUrl) ?? `https://huggingface.co/${model.id}/resolve/main/model.gguf`;
  const normalizedName = normalizeNonEmptyString(model.name) ?? model.id.split('/').pop() ?? model.id;
  const normalizedAuthor = normalizeNonEmptyString(model.author) ?? model.id.split('/')[0] ?? 'unknown';
  const lifecycleStatus = normalizeLifecycleStatus(model.lifecycleStatus);
  const rawProgress = typeof model.downloadProgress === 'number' && Number.isFinite(model.downloadProgress)
    ? model.downloadProgress
    : 0;
  const downloadProgress = Math.max(0, Math.min(rawProgress, 1));

  return {
    id: model.id,
    name: normalizedName,
    author: normalizedAuthor,
    size,
    downloadUrl,
    resolvedFileName: normalizeNonEmptyString(model.resolvedFileName),
    localPath: normalizeNonEmptyString(model.localPath),
    downloadedAt: typeof model.downloadedAt === 'number' && Number.isFinite(model.downloadedAt)
      ? Math.round(model.downloadedAt)
      : undefined,
    sha256: normalizeNonEmptyString(model.sha256),
    fitsInRam: size === null
      ? null
      : typeof model.fitsInRam === 'boolean'
        ? model.fitsInRam
        : null,
    accessState: normalizeAccessState(model.accessState),
    isGated: model.isGated === true,
    isPrivate: model.isPrivate === true,
    lifecycleStatus,
    downloadProgress,
    resumeData: normalizeNonEmptyString(model.resumeData),
    maxContextTokens: typeof model.maxContextTokens === 'number' && Number.isFinite(model.maxContextTokens)
      ? Math.round(model.maxContextTokens)
      : undefined,
    modelType: normalizeNonEmptyString(model.modelType),
    architectures: Array.isArray(model.architectures)
      ? model.architectures.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : undefined,
  };
}
