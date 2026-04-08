import { estimateFastMemoryFit } from '../memory/estimator';
import { LifecycleStatus, ModelAccessState, type ModelMemoryFitConfidence, type ModelMemoryFitDecision, type ModelMetadata } from '../types/models';
import type { CreateTreeProbeCandidateOptions, HuggingFaceModelCardData, HuggingFaceModelConfig, HuggingFaceModelSummary } from '../types/huggingFace';
import { buildHuggingFaceResolveUrl } from '../utils/huggingFaceUrls';
import { getFileName, getFileSha, getFileSize, isCatalogSummarySupported, selectPreferredGgufEntry, shouldRevalidateCatalogSummarySelection } from './ModelCatalogFileSelector';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';

type MemoryFitContext = { totalMemoryBytes: number | null } | null;

export function parseHuggingFaceLastModifiedAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    return Math.round(ms);
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.round(parsed);
}

export function resolveMemoryFitSummary(
  model: Pick<ModelMetadata, 'size' | 'metadataTrust' | 'gguf'>,
  memoryFitContext: MemoryFitContext,
): {
  fitsInRam: boolean | null;
  decision: ModelMemoryFitDecision;
  confidence: ModelMemoryFitConfidence;
} | null {
  const size = model.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  if (!memoryFitContext) {
    return null;
  }

  const fit = estimateFastMemoryFit({
    modelSizeBytes: size,
    totalMemoryBytes: memoryFitContext.totalMemoryBytes,
    metadataTrust: model.metadataTrust,
    ggufMetadata: model.gguf as Record<string, unknown> | undefined,
  });

  return {
    fitsInRam: fit.decision === 'unknown'
      ? null
      : fit.decision === 'fits_high_confidence' || fit.decision === 'fits_low_confidence',
    decision: fit.decision,
    confidence: fit.confidence,
  };
}

export function normalizeContextTokenValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 256) {
    return Math.round(value);
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase().replace(/[_\s,]/g, '');
    const shorthandMatch = normalizedValue.match(/^(\d+(?:\.\d+)?)([km])?(?:tokens?)?$/);
    const multiplier = shorthandMatch?.[2] === 'm'
      ? 1024 * 1024
      : shorthandMatch?.[2] === 'k'
        ? 1024
        : 1;
    const normalized = shorthandMatch
      ? Number(shorthandMatch[1]) * multiplier
      : Number(normalizedValue);
    if (Number.isFinite(normalized) && normalized >= 256) {
      return Math.round(normalized);
    }
  }

  return undefined;
}

export function resolveLargestContextTokenValue(values: unknown[]): number | undefined {
  let resolved: number | undefined;

  for (const value of values) {
    const normalized = normalizeContextTokenValue(value);
    if (normalized === undefined) {
      continue;
    }

    resolved = resolved === undefined ? normalized : Math.max(resolved, normalized);
  }

  return resolved;
}

export function resolveCardDataMaxContextTokens(cardData?: Partial<HuggingFaceModelCardData>): number | undefined {
  if (!cardData) {
    return undefined;
  }

  return resolveLargestContextTokenValue([
    cardData.context_length,
    cardData.max_position_embeddings,
    cardData.n_positions,
    cardData.max_sequence_length,
    cardData.seq_length,
    cardData.sliding_window,
    cardData.model_max_length,
    cardData.n_ctx,
    cardData.n_ctx_train,
    cardData.num_ctx,
  ]);
}

export function resolveMaxContextTokens(config?: HuggingFaceModelConfig): number | undefined {
  return resolveLargestContextTokenValue([
    config?.max_position_embeddings,
    config?.n_positions,
    config?.max_sequence_length,
    config?.seq_length,
    config?.sliding_window,
    config?.context_length,
    config?.model_max_length,
    config?.n_ctx,
    config?.n_ctx_train,
    config?.num_ctx,
    config?.original_max_position_embeddings,
    config?.rope_scaling?.original_max_position_embeddings,
    config?.rope_scaling?.max_position_embeddings,
    config?.text_config?.max_position_embeddings,
    config?.text_config?.n_positions,
    config?.text_config?.max_sequence_length,
    config?.text_config?.seq_length,
    config?.text_config?.sliding_window,
    config?.text_config?.context_length,
    config?.text_config?.model_max_length,
    config?.text_config?.n_ctx,
    config?.text_config?.n_ctx_train,
    config?.text_config?.num_ctx,
    config?.text_config?.original_max_position_embeddings,
    config?.text_config?.rope_scaling?.original_max_position_embeddings,
    config?.text_config?.rope_scaling?.max_position_embeddings,
  ]);
}

export function resolveSummaryMaxContextTokens(
  summary?: Pick<HuggingFaceModelSummary, 'config' | 'cardData' | 'gguf'>,
): number | undefined {
  if (!summary) {
    return undefined;
  }

  return resolveLargestContextTokenValue([
    resolveMaxContextTokens(summary.config),
    resolveCardDataMaxContextTokens(summary.cardData),
    summary.gguf?.context_length,
  ]);
}

export function resolveMergedMaxContextTokens(...values: (number | undefined)[]): number | undefined {
  return resolveLargestContextTokenValue(values);
}

export function resolveDetailAccessState(requiresAuth: boolean, authToken: string | null): ModelAccessState {
  if (!requiresAuth) {
    return ModelAccessState.PUBLIC;
  }

  if (!authToken) {
    return ModelAccessState.AUTH_REQUIRED;
  }

  // Treat gated/private repos as authorized when a token is configured. We
  // avoid attaching Authorization to public catalog endpoints; later probe/tree
  // checks can still downgrade this to access denied.
  return ModelAccessState.AUTHORIZED;
}

export function hasGgufCatalogSignal(repoId: string, tags?: string[]): boolean {
  if (repoId.toLowerCase().includes('gguf')) {
    return true;
  }

  return Array.isArray(tags) && tags.some((tag) => typeof tag === 'string' && tag.toLowerCase().includes('gguf'));
}

export function resolveStringMetadata(primaryValue: string | undefined, fallbackValue: string | undefined): string | undefined {
  return typeof primaryValue === 'string' && primaryValue.trim().length > 0
    ? primaryValue.trim()
    : typeof fallbackValue === 'string' && fallbackValue.trim().length > 0
      ? fallbackValue.trim()
      : undefined;
}

export function resolveStringArrayMetadata(
  primaryValue: string[] | undefined,
  fallbackValue: string | string[] | undefined,
): string[] | undefined {
  const normalizedPrimary = normalizeStringArrayMetadata(primaryValue);
  if (normalizedPrimary) {
    return normalizedPrimary;
  }

  return normalizeStringArrayMetadata(fallbackValue);
}

function normalizeStringArrayMetadata(value: string | string[] | undefined): string[] | undefined {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];

  if (rawValues.length === 0) {
    return undefined;
  }

  const normalized = rawValues
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

export function createFallbackModel(modelId: string): ModelMetadata {
  return normalizePersistedModelMetadata({
    id: modelId,
    name: modelId.split('/').pop() || modelId,
    author: modelId.split('/')[0] || 'unknown',
    size: null,
    downloadUrl: buildHuggingFaceResolveUrl(modelId, 'model.gguf', undefined),
    fitsInRam: null,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  });
}

function createTreeProbeCandidate(
  item: HuggingFaceModelSummary,
  repoId: string,
  memoryFitContext: MemoryFitContext,
  authToken: string | null,
  options?: CreateTreeProbeCandidateOptions,
): ModelMetadata | null {
  const requiresAuth = Boolean(item.gated) || item.private === true;
  if (!hasGgufCatalogSignal(repoId, item.tags)) {
    return null;
  }

  if (!requiresAuth && options?.allowPublic !== true) {
    return null;
  }

  const size = typeof item.gguf?.total === 'number' && Number.isFinite(item.gguf.total) && item.gguf.total > 0
    ? Math.round(item.gguf.total)
    : null;
  const metadataTrust = typeof size === 'number' && Number.isFinite(size) && size > 0
    ? 'inferred' as const
    : undefined;
  const maxContextTokens = resolveSummaryMaxContextTokens(item);
  const slidingWindowTokens = resolveLargestContextTokenValue([
    item.cardData?.sliding_window,
    item.config?.sliding_window,
    item.config?.text_config?.sliding_window,
  ]);
  const gguf = {
    ...(typeof size === 'number' && Number.isFinite(size) && size > 0 ? { totalBytes: Math.round(size) } : {}),
    ...(typeof item.gguf?.context_length === 'number' && Number.isFinite(item.gguf.context_length) && item.gguf.context_length > 0
      ? { contextLengthTokens: Math.round(item.gguf.context_length) }
      : {}),
    ...(typeof item.gguf?.architecture === 'string' && item.gguf.architecture.trim().length > 0
      ? { architecture: item.gguf.architecture.trim() }
      : {}),
    ...(typeof item.gguf?.size_label === 'string' && item.gguf.size_label.trim().length > 0
      ? { sizeLabel: item.gguf.size_label.trim() }
      : {}),
    ...(typeof slidingWindowTokens === 'number' && Number.isFinite(slidingWindowTokens) && slidingWindowTokens > 0
      ? { slidingWindowTokens }
      : {}),
  };
  const resolvedMemoryFit = resolveMemoryFitSummary({ size, metadataTrust }, memoryFitContext);
  const fitsInRam = resolvedMemoryFit?.fitsInRam ?? null;
  const lastModifiedAt = parseHuggingFaceLastModifiedAt(item.lastModified);

  return normalizePersistedModelMetadata({
    id: repoId,
    name: repoId.split('/').pop() || repoId,
    author: item.author || repoId.split('/')[0],
    size,
    downloadUrl: buildHuggingFaceResolveUrl(repoId, 'model.gguf', item.sha ?? undefined),
    lastModifiedAt,
    fitsInRam,
    memoryFitDecision: resolvedMemoryFit?.decision,
    memoryFitConfidence: resolvedMemoryFit?.confidence,
    metadataTrust,
    gguf: Object.keys(gguf).length > 0 ? gguf : undefined,
    accessState: resolveDetailAccessState(requiresAuth, authToken),
    isGated: Boolean(item.gated),
    isPrivate: item.private === true,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    requiresTreeProbe: true,
    hfRevision: item.sha ?? undefined,
    maxContextTokens,
    downloads: item.downloads ?? null,
    likes: item.likes ?? null,
  });
}

export function transformHFResponse(
  data: HuggingFaceModelSummary[],
  memoryFitContext: MemoryFitContext,
  authToken: string | null,
): ModelMetadata[] {
  const results: ModelMetadata[] = [];

  for (const item of data) {
    const repoId = item.id || item.modelId;
    if (!repoId) continue;
    if (!isCatalogSummarySupported(item)) {
      continue;
    }

    const hasSiblingMetadata = Array.isArray(item.siblings) && item.siblings.length > 0;
    const probeCandidate = createTreeProbeCandidate(item, repoId, memoryFitContext, authToken, {
      allowPublic: !hasSiblingMetadata,
    });
    if (!hasSiblingMetadata) {
      if (probeCandidate) {
        results.push(probeCandidate);
      }
      continue;
    }

    const siblings = item.siblings ?? [];
    const ggufSibling = selectPreferredGgufEntry(siblings);
    if (!ggufSibling) {
      if (probeCandidate) {
        results.push(probeCandidate);
      }
      continue;
    }

    const selectedEntrySize = getFileSize(ggufSibling);
    const size = selectedEntrySize ?? item.gguf?.total ?? null;
    const metadataTrust = typeof selectedEntrySize === 'number' && Number.isFinite(selectedEntrySize) && selectedEntrySize > 0
      ? 'trusted_remote' as const
      : typeof item.gguf?.total === 'number' && Number.isFinite(item.gguf.total) && item.gguf.total > 0
        ? 'inferred' as const
        : undefined;
    const maxContextTokens = resolveSummaryMaxContextTokens(item);
    const slidingWindowTokens = resolveLargestContextTokenValue([
      item.cardData?.sliding_window,
      item.config?.sliding_window,
      item.config?.text_config?.sliding_window,
    ]);
    const gguf = {
      ...(typeof size === 'number' && Number.isFinite(size) && size > 0 ? { totalBytes: Math.round(size) } : {}),
      ...(typeof item.gguf?.context_length === 'number' && Number.isFinite(item.gguf.context_length) && item.gguf.context_length > 0
        ? { contextLengthTokens: Math.round(item.gguf.context_length) }
        : {}),
      ...(typeof item.gguf?.architecture === 'string' && item.gguf.architecture.trim().length > 0
        ? { architecture: item.gguf.architecture.trim() }
        : {}),
      ...(typeof item.gguf?.size_label === 'string' && item.gguf.size_label.trim().length > 0
        ? { sizeLabel: item.gguf.size_label.trim() }
        : {}),
      ...(typeof slidingWindowTokens === 'number' && Number.isFinite(slidingWindowTokens) && slidingWindowTokens > 0
        ? { slidingWindowTokens }
        : {}),
    };
    const resolvedMemoryFit = resolveMemoryFitSummary({ size, metadataTrust }, memoryFitContext);
    const fitsInRam = resolvedMemoryFit?.fitsInRam ?? null;
    const fileName = getFileName(ggufSibling) || 'model.gguf';
    const hfRevision = item.sha ?? undefined;
    const lastModifiedAt = parseHuggingFaceLastModifiedAt(item.lastModified);
    const requiresAuth = Boolean(item.gated) || item.private === true;
    const requiresTreeProbe = shouldRevalidateCatalogSummarySelection(ggufSibling);
    const accessState = resolveDetailAccessState(requiresAuth, authToken);

    results.push(normalizePersistedModelMetadata({
      id: repoId,
      name: repoId.split('/').pop() || repoId,
      author: item.author || repoId.split('/')[0],
      size,
      downloadUrl: buildHuggingFaceResolveUrl(repoId, fileName, hfRevision),
      hfRevision,
      resolvedFileName: fileName,
      lastModifiedAt,
      fitsInRam,
      memoryFitDecision: resolvedMemoryFit?.decision,
      memoryFitConfidence: resolvedMemoryFit?.confidence,
      metadataTrust,
      gguf: Object.keys(gguf).length > 0 ? gguf : undefined,
      accessState,
      isGated: Boolean(item.gated),
      isPrivate: item.private === true,
      requiresTreeProbe,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      sha256: getFileSha(ggufSibling),
      maxContextTokens,
      downloads: item.downloads ?? null,
      likes: item.likes ?? null,
    }));
  }

  return results;
}

export function buildModelMetadataFromPayload(
  payload: HuggingFaceModelSummary,
  memoryFitContext: MemoryFitContext,
  authToken: string | null,
  fallbackModel: ModelMetadata,
  payloadMaxContextTokens?: number,
): ModelMetadata {
  const repoId = payload.id || payload.modelId || fallbackModel.id;
  const hfRevision = payload.sha ?? fallbackModel.hfRevision;
  const selectedEntry = selectPreferredGgufEntry(payload.siblings ?? []);
  const selectedEntrySize = getFileSize(selectedEntry);
  const resolvedFileName = selectedEntry
    ? getFileName(selectedEntry)
    : fallbackModel.resolvedFileName;
  const size = selectedEntrySize ?? payload.gguf?.total ?? fallbackModel.size;
  const metadataTrustFromPayload = typeof selectedEntrySize === 'number' && Number.isFinite(selectedEntrySize) && selectedEntrySize > 0
    ? 'trusted_remote' as const
    : typeof payload.gguf?.total === 'number' && Number.isFinite(payload.gguf.total) && payload.gguf.total > 0
      ? 'inferred' as const
      : fallbackModel.metadataTrust;
  const slidingWindowTokens = resolveLargestContextTokenValue([
    payload.cardData?.sliding_window,
    payload.config?.sliding_window,
    payload.config?.text_config?.sliding_window,
  ]);
  const ggufFromPayload = {
    ...(typeof size === 'number' && Number.isFinite(size) && size > 0 ? { totalBytes: Math.round(size) } : {}),
    ...(typeof payload.gguf?.context_length === 'number' && Number.isFinite(payload.gguf.context_length) && payload.gguf.context_length > 0
      ? { contextLengthTokens: Math.round(payload.gguf.context_length) }
      : {}),
    ...(typeof payload.gguf?.architecture === 'string' && payload.gguf.architecture.trim().length > 0
      ? { architecture: payload.gguf.architecture.trim() }
      : {}),
    ...(typeof payload.gguf?.size_label === 'string' && payload.gguf.size_label.trim().length > 0
      ? { sizeLabel: payload.gguf.size_label.trim() }
      : {}),
    ...(typeof slidingWindowTokens === 'number' && Number.isFinite(slidingWindowTokens) && slidingWindowTokens > 0
      ? { slidingWindowTokens }
      : {}),
  };
  const gguf = Object.keys(ggufFromPayload).length > 0
    ? {
      ...(fallbackModel.gguf ?? {}),
      ...ggufFromPayload,
    }
    : fallbackModel.gguf;
  const resolvedMemoryFit = resolveMemoryFitSummary({ size, metadataTrust: metadataTrustFromPayload }, memoryFitContext);
  const fitsInRam = resolvedMemoryFit?.fitsInRam ?? fallbackModel.fitsInRam;
  const memoryFitDecision = resolvedMemoryFit?.decision ?? fallbackModel.memoryFitDecision;
  const memoryFitConfidence = resolvedMemoryFit?.confidence ?? fallbackModel.memoryFitConfidence;
  const lastModifiedAt = parseHuggingFaceLastModifiedAt(payload.lastModified) ?? fallbackModel.lastModifiedAt;
  const requiresAuth = Boolean(payload.gated) || payload.private === true;
  const requiresTreeProbe = selectedEntry
    ? selectedEntrySize === null
    : fallbackModel.requiresTreeProbe === true;

  return normalizePersistedModelMetadata({
    ...fallbackModel,
    id: repoId,
    name: repoId.split('/').pop() || repoId,
    author: payload.author || repoId.split('/')[0],
    size,
    downloadUrl: resolvedFileName
      ? buildHuggingFaceResolveUrl(repoId, resolvedFileName, hfRevision)
      : fallbackModel.downloadUrl,
    hfRevision,
    resolvedFileName,
    lastModifiedAt,
    fitsInRam,
    memoryFitDecision,
    memoryFitConfidence,
    metadataTrust: metadataTrustFromPayload,
    gguf,
    accessState: resolveDetailAccessState(requiresAuth, authToken),
    isGated: Boolean(payload.gated),
    isPrivate: payload.private === true,
    requiresTreeProbe,
    parameterSizeLabel: resolveStringMetadata(fallbackModel.parameterSizeLabel, payload.gguf?.size_label),
    sha256: selectedEntry ? getFileSha(selectedEntry) ?? fallbackModel.sha256 : fallbackModel.sha256,
    maxContextTokens: payloadMaxContextTokens ?? fallbackModel.maxContextTokens,
    modelType: payload.config?.model_type ?? payload.cardData?.model_type ?? fallbackModel.modelType,
    architectures: payload.config?.architectures ?? fallbackModel.architectures,
    baseModels: resolveStringArrayMetadata(fallbackModel.baseModels, payload.cardData?.base_model),
    license: resolveStringMetadata(fallbackModel.license, payload.cardData?.license),
    languages: resolveStringArrayMetadata(fallbackModel.languages, payload.cardData?.language),
    datasets: resolveStringArrayMetadata(fallbackModel.datasets, payload.cardData?.datasets),
    quantizedBy: resolveStringMetadata(fallbackModel.quantizedBy, payload.cardData?.quantized_by),
    modelCreator: resolveStringMetadata(fallbackModel.modelCreator, payload.cardData?.model_creator),
    downloads: payload.downloads ?? fallbackModel.downloads ?? null,
    likes: payload.likes ?? fallbackModel.likes ?? null,
    tags: payload.tags ?? fallbackModel.tags,
  });
}

