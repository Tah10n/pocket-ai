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
  type ModelVariant,
  type ModelThinkingCapabilitySnapshot,
} from '../types/models';
import type {
  ModelArtifactRole,
  ModelChatModality,
  MultimodalReadinessState,
  MultimodalReadinessStatus,
  MultimodalSupportModality,
  ProjectorArtifact,
  ProjectorLifecycleStatus,
  ProjectorMatchStatus,
  VisionCapabilityConfidence,
  VisionCapabilitySource,
} from '../types/multimodal';
import type { ModelInputCapabilitySnapshot } from '../types/modelInputCapabilities';
import {
  deriveArtifactsFromLegacyModel,
  getUnboundProjectorArtifactsForBookkeeping,
  normalizePersistedModelArtifacts,
} from '../utils/modelArtifacts';
import {
  normalizePersistedModelCapabilitySnapshot,
  projectorArtifactMatchesCandidate,
} from '../utils/modelCapabilities';
import {
  inferDeclaredInputCapabilities,
  inputCapabilityEvidenceSupportsModality,
  isKnownAudioInputProfileSignal,
  isKnownAudioOnlyInputProfileSignal,
  isKnownVisionAudioInputProfileSignal,
  mergeInputCapabilitySnapshots,
  normalizePersistedInputCapabilitySnapshot,
} from '../utils/modelInputCapabilities';
import { dedupeModelVariantsByIdentity } from '../utils/modelVariantIdentity';
import { getShortModelLabel } from '../utils/modelLabel';
import { buildHuggingFaceResolveUrl } from '../utils/huggingFaceUrls';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
  resolveModelArtifactRole,
} from '../utils/modelProjectors';
import { isValidLocalFileName } from '../utils/safeFilePath';
import { normalizeSha256Digest } from '../utils/sha256';
import { normalizeDownloadResumeData } from '../utils/downloadResumeData';
import { sanitizeMultimodalFailureReason } from '../utils/multimodalFailureReason';
import { normalizeMultimodalReadinessState as normalizeReadinessSupport } from '../utils/multimodalReadiness';
import { resolveActiveModelVariant } from '../utils/activeModelVariant';
import { normalizeModelSpeculativeDecodingConfig } from '../utils/modelSpeculativeDecoding';
import {
  canonicalizeProjectorCandidateAliases,
  getProjectorExactScopeKey,
  remapProjectorAliasId,
} from '../utils/projectorIdentity';
import {
  isProjectorFileName,
  isSupportedGgufFileName,
} from './ModelCatalogFileSelector';

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

function normalizeProgress(value: unknown, fallback = 0): number {
  const progress = typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;

  return Math.max(0, Math.min(progress, 1));
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

function normalizeModelArtifactRole(value: unknown): ModelArtifactRole | undefined {
  return value === 'primary_chat_model' || value === 'projector_companion'
    ? value
    : undefined;
}

function normalizeChatModalities(value: unknown): ModelChatModality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const modalities = value.filter((entry): entry is ModelChatModality => (
    entry === 'text' || entry === 'vision' || entry === 'audio'
  ));
  const deduped = [...new Set(modalities)];

  return deduped.length > 0 ? deduped : undefined;
}

function reconcileChatModalitiesWithTrustedProfile(
  chatModalities: ModelChatModality[] | undefined,
  profileSupport: { image: boolean; audio: boolean; audioOnly: boolean },
): ModelChatModality[] {
  const modalities = new Set<ModelChatModality>(chatModalities ?? ['text']);
  modalities.add('text');
  if (profileSupport.audioOnly) {
    modalities.delete('vision');
  }
  if (profileSupport.image) {
    modalities.add('vision');
  }
  if (profileSupport.audio) {
    modalities.add('audio');
  }

  return [
    'text',
    ...(modalities.has('vision') ? ['vision' as const] : []),
    ...(modalities.has('audio') ? ['audio' as const] : []),
  ];
}

function hasExplicitTextOnlyChatModalities(chatModalities: ModelChatModality[] | undefined): boolean {
  return Array.isArray(chatModalities)
    && chatModalities.includes('text')
    && !chatModalities.includes('vision')
    && !chatModalities.includes('audio');
}

function hasTrustedPersistedImageEvidence(
  inputCapabilities: ModelInputCapabilitySnapshot | undefined,
): boolean {
  return inputCapabilities?.evidence.some((entry) => (
    inputCapabilityEvidenceSupportsModality(entry, 'image')
    && (
      entry.source === 'runtime'
      || entry.source === 'architecture'
      || entry.source === 'config'
      || entry.confidence === 'high'
    )
  )) === true;
}

function normalizeMultimodalReadinessStatus(value: unknown): MultimodalReadinessStatus | undefined {
  return value === 'ready'
    || value === 'text_only'
    || value === 'missing_projector'
    || value === 'ambiguous_projector'
    || value === 'projector_downloading'
    || value === 'initializing'
    || value === 'failed'
    || value === 'unsupported'
    ? value
    : undefined;
}

function normalizeMultimodalSupport(value: unknown): MultimodalSupportModality[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is MultimodalSupportModality => (
    entry === 'vision' || entry === 'audio'
  )))];
}

function normalizeMultimodalReadinessState(value: unknown): MultimodalReadinessState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const modelId = normalizeNonEmptyString(record.modelId);
  const status = normalizeMultimodalReadinessStatus(record.status);
  if (!modelId || !status) {
    return undefined;
  }

  const checkedAt = typeof record.checkedAt === 'number' && Number.isFinite(record.checkedAt)
    ? Math.max(0, Math.round(record.checkedAt))
    : 0;
  const projectorSize = typeof record.projectorSize === 'number' && Number.isFinite(record.projectorSize) && record.projectorSize > 0
    ? Math.round(record.projectorSize)
    : undefined;
  const requestedSupport = Array.isArray(record.requestedSupport)
    ? normalizeMultimodalSupport(record.requestedSupport)
    : undefined;
  const failureReason = sanitizeMultimodalFailureReason(normalizeNonEmptyString(record.failureReason));

  return normalizeReadinessSupport({
    modelId,
    ...(normalizeNonEmptyString(record.variantId) ? { variantId: normalizeNonEmptyString(record.variantId) } : {}),
    status,
    ...(normalizeNonEmptyString(record.projectorId) ? { projectorId: normalizeNonEmptyString(record.projectorId) } : {}),
    ...(projectorSize !== undefined ? { projectorSize } : {}),
    support: normalizeMultimodalSupport(record.support),
    ...(requestedSupport !== undefined ? { requestedSupport } : {}),
    ...(failureReason ? { failureReason } : {}),
    checkedAt,
  });
}

function normalizeVisionCapabilitySource(value: unknown): VisionCapabilitySource | undefined {
  return value === 'catalog_metadata'
    || value === 'tree_probe'
    || value === 'gguf_metadata'
    || value === 'runtime_probe'
    || value === 'user_selected_projector'
    ? value
    : undefined;
}

function normalizeVisionCapabilityConfidence(value: unknown): VisionCapabilityConfidence | undefined {
  return value === 'verified'
    || value === 'trusted'
    || value === 'inferred'
    || value === 'unknown'
    ? value
    : undefined;
}

function normalizeProjectorLifecycleStatus(value: unknown): ProjectorLifecycleStatus {
  return value === 'queued'
    || value === 'downloading'
    || value === 'paused'
    || value === 'failed'
    || value === 'downloaded'
    || value === 'active'
    ? value
    : 'available';
}

function normalizeProjectorMatchStatus(value: unknown): ProjectorMatchStatus {
  return value === 'matched'
    || value === 'ambiguous'
    || value === 'user_selected'
    || value === 'failed'
    ? value
    : 'missing';
}

function normalizeProjectorArtifact(value: unknown): ProjectorArtifact | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = normalizeNonEmptyString(record.id);
  const ownerModelId = normalizeNonEmptyString(record.ownerModelId);
  const repoId = normalizeNonEmptyString(record.repoId);
  const fileName = normalizeNonEmptyString(record.fileName);
  const downloadUrl = normalizeNonEmptyString(record.downloadUrl);
  if (!id || !ownerModelId || !repoId || !fileName || !downloadUrl) {
    return null;
  }

  const ownerVariantId = normalizeNonEmptyString(record.ownerVariantId);
  const hfRevision = normalizeNonEmptyString(record.hfRevision);
  const sha256 = normalizeSha256Digest(typeof record.sha256 === 'string' ? record.sha256 : undefined);
  const size = normalizeSize(record.size);
  const localPath = normalizeLocalFileName(record.localPath);
  const resumeData = normalizeDownloadResumeData(record.resumeData);
  const downloadProgress = record.downloadProgress === undefined
    ? undefined
    : normalizeProgress(record.downloadProgress);
  const lifecycleStatus = normalizeProjectorLifecycleStatus(record.lifecycleStatus);
  const matchStatus = normalizeProjectorMatchStatus(record.matchStatus);
  const matchReason = normalizeNonEmptyString(record.matchReason);

  return {
    id,
    ownerModelId,
    ...(ownerVariantId !== undefined ? { ownerVariantId } : {}),
    repoId,
    fileName,
    downloadUrl,
    ...(hfRevision !== undefined ? { hfRevision } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
    size,
    ...(localPath !== undefined ? { localPath } : {}),
    ...(resumeData !== undefined ? { resumeData } : {}),
    ...(downloadProgress !== undefined ? { downloadProgress } : {}),
    lifecycleStatus,
    matchStatus,
    ...(matchReason !== undefined ? { matchReason } : {}),
  };
}

function normalizeProjectorArtifacts(value: unknown): ProjectorArtifact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  if (value.length === 0) {
    return [];
  }

  const artifacts = value.flatMap((entry) => {
    const artifact = normalizeProjectorArtifact(entry);
    if (!artifact) {
      return [];
    }

    return [artifact];
  });

  return artifacts.length > 0 ? artifacts : undefined;
}

function selectCanonicalProjectorsForSource(
  sourceCandidates: ProjectorArtifact[] | undefined,
  canonicalCandidates: readonly ProjectorArtifact[],
): ProjectorArtifact[] | undefined {
  if (!sourceCandidates) {
    return undefined;
  }
  if (sourceCandidates.length === 0) {
    return [];
  }

  const sourceScopeKeys = new Set(sourceCandidates.flatMap((candidate) => {
    const scopeKey = getProjectorExactScopeKey(candidate);
    return scopeKey ? [scopeKey] : [];
  }));
  const candidates = canonicalCandidates.filter((candidate) => {
    const scopeKey = getProjectorExactScopeKey(candidate);
    return scopeKey !== null && sourceScopeKeys.has(scopeKey);
  });
  // A non-empty explicit source remains authoritative even when exact
  // canonicalization rejects every candidate. Returning an empty array keeps
  // downstream merges from reviving stale projector state.
  return candidates;
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

function normalizeModelVariant(value: unknown): ModelVariant | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const fileName = normalizeNonEmptyString(record.fileName ?? record.resolvedFileName ?? record.variantId);
  if (!fileName) {
    return null;
  }
  if (!isSupportedGgufFileName(fileName)) {
    return null;
  }

  const variantId = normalizeNonEmptyString(record.variantId) ?? fileName;
  const quantizationLabel = normalizeNonEmptyString(record.quantizationLabel) ?? 'GGUF';
  const size = normalizeSize(record.size);
  const sha256 = normalizeSha256Digest(typeof record.sha256 === 'string' ? record.sha256 : undefined);
  const ramFit = normalizeMemoryFitDecision(record.ramFit);
  const ramFitConfidence = normalizeMemoryFitConfidence(record.ramFitConfidence);
  const chatModalities = normalizeChatModalities(record.chatModalities);
  const artifactRole = normalizeModelArtifactRole(record.artifactRole);
  const permitsVisionMetadata = chatModalities === undefined || chatModalities.includes('vision');
  const visionSource = permitsVisionMetadata
    ? normalizeVisionCapabilitySource(record.visionSource)
    : undefined;
  const visionConfidence = permitsVisionMetadata
    ? normalizeVisionCapabilityConfidence(record.visionConfidence)
    : undefined;
  const projectorCandidates = normalizeProjectorArtifacts(record.projectorCandidates);
  const selectedProjectorId = normalizeNonEmptyString(record.selectedProjectorId);
  const speculativeDecoding = normalizeModelSpeculativeDecodingConfig(record.speculativeDecoding);

  return {
    variantId,
    fileName,
    quantizationLabel,
    size,
    ...(sha256 ? { sha256 } : {}),
    ...(ramFit ? { ramFit } : {}),
    ...(ramFitConfidence ? { ramFitConfidence } : {}),
    ...(record.isLocal === true ? { isLocal: true } : {}),
    ...(chatModalities ? { chatModalities } : {}),
    ...(artifactRole === 'primary_chat_model' ? { artifactRole } : {}),
    ...(visionSource ? { visionSource } : {}),
    ...(visionConfidence ? { visionConfidence } : {}),
    ...(projectorCandidates ? { projectorCandidates } : {}),
    ...(selectedProjectorId ? { selectedProjectorId } : {}),
    ...(speculativeDecoding ? { speculativeDecoding } : {}),
  };
}

function isSupportedOpaqueActiveVariantId(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }

  if (normalized.toLowerCase().endsWith('.gguf')) {
    return isSupportedGgufFileName(normalized);
  }

  return !isProjectorFileName(normalized);
}

function resolveActiveVariantId(
  activeVariantId: string | undefined,
  resolvedFileName: string | undefined,
  variants: ModelVariant[] | undefined,
): string | undefined {
  if (activeVariantId && isSupportedOpaqueActiveVariantId(activeVariantId)) {
    if (!variants || variants.length === 0) {
      return activeVariantId;
    }

    const activeVariant = resolveActiveModelVariant({ activeVariantId, variants });
    if (activeVariant) {
      return activeVariant.variantId;
    }
  }

  if (resolvedFileName) {
    const resolvedVariant = resolveActiveModelVariant({ resolvedFileName, variants });
    if (resolvedVariant) {
      return resolvedVariant.variantId;
    }
  }

  return undefined;
}

function normalizeModelVariants(
  value: unknown,
  options: {
    activeVariantId?: string;
    resolvedFileName?: string;
  } = {},
): ModelVariant[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const variants = value
    .map((entry) => normalizeModelVariant(entry))
    .filter((entry): entry is ModelVariant => entry !== null);
  const dedupedVariants = dedupeModelVariantsByIdentity(variants, options);

  return dedupedVariants.length > 0 ? dedupedVariants : undefined;
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
  const normalizedModelType = normalizeNonEmptyString(model.modelType);
  const normalizedArchitectures = normalizeStringArray(model.architectures);
  const normalizedTags = normalizeStringArray(model.tags);
  const normalizedModelSpeculativeDecoding = normalizeModelSpeculativeDecodingConfig(
    (model as PersistedModelMetadata & { speculativeDecoding?: unknown }).speculativeDecoding,
  );
  const thinkingCapability = normalizeThinkingCapabilitySnapshot(
    (model as PersistedModelMetadata & { thinkingCapability?: unknown }).thinkingCapability,
  );
  const normalizedActiveVariantId = normalizeNonEmptyString(model.activeVariantId);
  const normalizedResolvedFileName = normalizeNonEmptyString(model.resolvedFileName);
  const normalizedVariantsBeforeProjectorCanonicalization = normalizeModelVariants(
    (model as PersistedModelMetadata & { variants?: unknown }).variants,
    {
      activeVariantId: normalizedActiveVariantId,
      resolvedFileName: normalizedResolvedFileName,
    },
  );
  const persistedChatModalities = normalizeChatModalities(model.chatModalities);
  const persistedInputCapabilities = normalizePersistedInputCapabilitySnapshot(
    (model as PersistedModelMetadata & { inputCapabilities?: unknown }).inputCapabilities,
  );
  const artifactRole = normalizeModelArtifactRole(model.artifactRole)
    ?? (normalizedResolvedFileName ? resolveModelArtifactRole(normalizedResolvedFileName) : undefined);
  const visionSource = normalizeVisionCapabilitySource(model.visionSource);
  const visionConfidence = normalizeVisionCapabilityConfidence(model.visionConfidence);
  const normalizedModelProjectorCandidates = normalizeProjectorArtifacts(model.projectorCandidates);
  const normalizedPersistedArtifacts = normalizePersistedModelArtifacts(
    (model as PersistedModelMetadata & { artifacts?: unknown }).artifacts,
  );
  const normalizedAllProjectorCandidates = [
    ...(normalizedModelProjectorCandidates ?? []),
    ...(normalizedVariantsBeforeProjectorCanonicalization ?? []).flatMap((variant) => (
      variant.projectorCandidates ?? []
    )),
  ];
  const canonicalProjectors = canonicalizeProjectorCandidateAliases(
    normalizedAllProjectorCandidates,
    normalizedPersistedArtifacts,
  );
  const projectorCandidates = selectCanonicalProjectorsForSource(
    normalizedModelProjectorCandidates,
    canonicalProjectors.candidates,
  );
  const normalizedVariants = normalizedVariantsBeforeProjectorCanonicalization?.map((variant) => {
    const variantProjectorCandidates = selectCanonicalProjectorsForSource(
      variant.projectorCandidates,
      canonicalProjectors.candidates,
    );
    const remappedSelectedProjectorId = remapProjectorAliasId(
      variant.selectedProjectorId,
      canonicalProjectors,
    );
    const selectedProjectorId = remappedSelectedProjectorId
      && canonicalProjectors.candidates.some((candidate) => (
        candidate.id === remappedSelectedProjectorId
        && (
          candidate.ownerVariantId === undefined
          || candidate.ownerVariantId === variant.variantId
          || candidate.ownerVariantId === variant.fileName
        )
      ))
      ? remappedSelectedProjectorId
      : undefined;
    const normalizedVariant = { ...variant };
    delete normalizedVariant.projectorCandidates;
    delete normalizedVariant.selectedProjectorId;
    return {
      ...normalizedVariant,
      ...(variantProjectorCandidates !== undefined
        ? { projectorCandidates: variantProjectorCandidates }
        : {}),
      ...(selectedProjectorId ? { selectedProjectorId } : {}),
    };
  });
  const remappedSelectedProjectorId = remapProjectorAliasId(
    normalizeNonEmptyString(model.selectedProjectorId),
    canonicalProjectors,
  );
  const selectedProjectorId = remappedSelectedProjectorId
    && canonicalProjectors.candidates.some((candidate) => candidate.id === remappedSelectedProjectorId)
    ? remappedSelectedProjectorId
    : undefined;
  const persistedArtifacts = normalizedPersistedArtifacts === undefined
    ? undefined
    : [
        ...normalizedPersistedArtifacts.filter((artifact) => artifact.kind !== 'multimodal_projector'),
        ...canonicalProjectors.artifacts,
        ...getUnboundProjectorArtifactsForBookkeeping(
          normalizedPersistedArtifacts,
          normalizedAllProjectorCandidates,
        ),
      ];
  const normalizedMultimodalReadiness = normalizeMultimodalReadinessState(
    (model as PersistedModelMetadata & { multimodalReadiness?: unknown }).multimodalReadiness,
  );
  const remappedReadinessProjectorId = remapProjectorAliasId(
    normalizedMultimodalReadiness?.projectorId,
    canonicalProjectors,
  );
  const hasAnyProjectorEvidence = normalizedAllProjectorCandidates.length > 0
    || normalizedPersistedArtifacts?.some((artifact) => artifact.kind === 'multimodal_projector') === true;
  const multimodalReadiness = normalizedMultimodalReadiness?.projectorId === undefined
    ? (!hasAnyProjectorEvidence ? normalizedMultimodalReadiness : undefined)
    : normalizedMultimodalReadiness
      && remappedReadinessProjectorId
      && canonicalProjectors.candidates.some((candidate) => candidate.id === remappedReadinessProjectorId)
      ? {
          ...normalizedMultimodalReadiness,
          projectorId: remappedReadinessProjectorId,
        }
      : undefined;
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
  const knownAudioProfileSignals = [
    model.id,
    normalizedModelType,
    ...(normalizedArchitectures ?? []),
    ...(normalizedTags ?? []),
    gguf?.architecture,
  ];
  const shouldInferKnownAudioProfile = knownAudioProfileSignals.some(isKnownAudioInputProfileSignal);
  const inferredProfileInputCapabilities = shouldInferKnownAudioProfile
    ? inferDeclaredInputCapabilities({
        id: model.id,
        modelId: model.id,
        ...(normalizedTags ? { tags: normalizedTags } : {}),
        config: {
          ...(normalizedModelType ? { model_type: normalizedModelType } : {}),
          ...(normalizedArchitectures ? { architectures: normalizedArchitectures } : {}),
        },
        ...(gguf?.architecture ? { gguf: { architecture: gguf.architecture } } : {}),
      }, [
        normalizedResolvedFileName,
        localPath,
        ...(normalizedVariants?.map((variant) => variant.fileName) ?? []),
        ...(projectorCandidates?.map((candidate) => candidate.fileName) ?? []),
        ...(normalizedVariants?.flatMap((variant) => (
          variant.projectorCandidates?.map((candidate) => candidate.fileName) ?? []
        )) ?? []),
      ].flatMap((path) => path ? [{ path }] : []), {
        detectedAt: persistedInputCapabilities?.detectedAt ?? 0,
      })
    : undefined;
  const hasTrustedProfileEvidenceFor = (modality: 'image' | 'audio') => (
    inferredProfileInputCapabilities?.evidence.some((entry) => (
      (entry.source === 'architecture' || entry.source === 'config' || entry.source === 'repository_tree')
      && entry.confidence === 'high'
      && inputCapabilityEvidenceSupportsModality(entry, modality)
    )) === true
  );
  const hasTrustedAudioProfile = hasTrustedProfileEvidenceFor('audio');
  const hasTrustedInferredImageProfile = hasTrustedProfileEvidenceFor('image');
  const hasTrustedPersistedImageProfile = hasTrustedPersistedImageEvidence(persistedInputCapabilities);
  const hasRuntimeVisionSupport = multimodalReadiness?.support.includes('vision') === true;
  const hasKnownVisionAudioProfile = knownAudioProfileSignals.some(isKnownVisionAudioInputProfileSignal);
  const hasVerifiedPersistedVision = persistedChatModalities?.includes('vision') === true
    && visionConfidence === 'verified';
  const hasVerifiedVariantVision = normalizedVariants?.some((variant) => (
    variant.chatModalities?.includes('vision') === true
    && variant.visionConfidence === 'verified'
  )) === true;
  const trustedProfileIsAudioOnly = hasTrustedAudioProfile
    && knownAudioProfileSignals.some(isKnownAudioOnlyInputProfileSignal)
    && !hasKnownVisionAudioProfile
    && !hasTrustedInferredImageProfile
    && !hasTrustedPersistedImageProfile
    && !hasRuntimeVisionSupport
    && !hasVerifiedPersistedVision
    && !hasVerifiedVariantVision;
  const trustedProfileSupport = {
    image: !trustedProfileIsAudioOnly && (
      hasTrustedInferredImageProfile
      || hasTrustedPersistedImageProfile
      || hasRuntimeVisionSupport
      || hasVerifiedPersistedVision
      || hasVerifiedVariantVision
      || persistedInputCapabilities?.declared.image === 'supported'
    ),
    audio: hasTrustedAudioProfile,
    audioOnly: trustedProfileIsAudioOnly,
  };
  const persistedInputCapabilitiesForProfile = trustedProfileIsAudioOnly && persistedInputCapabilities
    ? {
        ...persistedInputCapabilities,
        declared: {
          ...persistedInputCapabilities.declared,
          image: 'unknown' as const,
        },
        evidence: persistedInputCapabilities.evidence.filter((entry) => (
          !inputCapabilityEvidenceSupportsModality(entry, 'image') || entry.source === 'runtime'
        )),
      }
    : persistedInputCapabilities;
  const inputCapabilities = hasTrustedAudioProfile
    ? mergeInputCapabilitySnapshots(persistedInputCapabilitiesForProfile, inferredProfileInputCapabilities)
    : persistedInputCapabilitiesForProfile;
  const shouldReconcileParentChatModalities = hasTrustedAudioProfile
    && Boolean(projectorCandidates?.length);
  const chatModalities = shouldReconcileParentChatModalities
    ? reconcileChatModalitiesWithTrustedProfile(persistedChatModalities, trustedProfileSupport)
    : persistedChatModalities;
  const variants = hasTrustedAudioProfile
    ? normalizedVariants?.map((variant) => {
        const variantHasProjector = Boolean(variant.projectorCandidates?.length)
          || projectorCandidates?.some((candidate) => (
            candidate.ownerVariantId === undefined
            || candidate.ownerVariantId === variant.variantId
            || candidate.ownerVariantId === variant.fileName
          )) === true;
        if (
          !variantHasProjector
          || variant.artifactRole === 'projector_companion'
          || hasExplicitTextOnlyChatModalities(variant.chatModalities)
        ) {
          return variant;
        }

        return {
          ...variant,
          chatModalities: reconcileChatModalitiesWithTrustedProfile(
            variant.chatModalities,
            trustedProfileSupport,
          ),
          ...(trustedProfileIsAudioOnly
            ? { visionSource: undefined, visionConfidence: undefined }
            : {}),
        };
      })
    : normalizedVariants;
  const activeVariantId = resolveActiveVariantId(normalizedActiveVariantId, normalizedResolvedFileName, variants);
  const downloadIntegrity = shouldDropDownloadedState || hasMismatchedSha256Integrity
    ? undefined
    : normalizedDownloadIntegrity;
  const downloadProgress = shouldDropDownloadedState ? 0 : normalizeProgress(model.downloadProgress);
  const downloadedAt = !shouldDropDownloadedState
    && typeof model.downloadedAt === 'number'
    && Number.isFinite(model.downloadedAt)
    ? Math.round(model.downloadedAt)
    : undefined;
  const resumeData = shouldDropDownloadedState
    ? undefined
    : normalizeDownloadResumeData(model.resumeData);
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
  const hasReconciledAudioModality = chatModalities?.includes('audio') === true
    || variants?.some((variant) => variant.chatModalities?.includes('audio') === true) === true;
  const matchingPersistedProjectorCount = persistedArtifacts?.filter((artifact) => (
    artifact.kind === 'multimodal_projector'
    && projectorCandidates?.some((candidate) => projectorArtifactMatchesCandidate(artifact, candidate)) === true
  )).length ?? 0;
  const stableProjectorCandidateIds = new Set((projectorCandidates ?? []).map((candidate) => (
    buildProjectorArtifactId({
      repoId: candidate.repoId,
      hfRevision: candidate.hfRevision,
      ownerVariantId: candidate.ownerVariantId,
      fileName: candidate.fileName,
    })
  )));
  // Multiple projectors can intentionally split image and audio requirements.
  // Current and legacy IDs can coexist for one physical projector, so count
  // canonical candidate identities instead of persisted artifact records.
  const hasSingleStableLegacyProjector = stableProjectorCandidateIds.size === 1
    && matchingPersistedProjectorCount > 0;
  const canRepairAudioOnlyLegacyProjector = hasSingleStableLegacyProjector
    && trustedProfileIsAudioOnly;
  const canRepairUnifiedLegacyProjector = hasSingleStableLegacyProjector
    && trustedProfileSupport.image
    && trustedProfileSupport.audio;
  const hasExplicitAudioOnlyModelModalities = Array.isArray(chatModalities)
    && chatModalities.includes('audio')
    && !chatModalities.includes('vision');
  const hasVariantVisionDeclaration = variants?.some((variant) => (
    variant.chatModalities?.includes('vision') === true
  )) === true;
  const hasReadyAudioOnlyRuntime = multimodalReadiness?.status === 'ready'
    && multimodalReadiness.support.includes('audio')
    && !multimodalReadiness.support.includes('vision');
  const hasStaleMixedRequestedSupport = multimodalReadiness?.requestedSupport?.includes('vision') === true
    && multimodalReadiness.requestedSupport.includes('audio');
  const canRepairPersistedAudioOnlyProjectorRequirement = hasSingleStableLegacyProjector
    && hasExplicitAudioOnlyModelModalities
    && hasReadyAudioOnlyRuntime
    && hasStaleMixedRequestedSupport
    && !trustedProfileSupport.image
    && !hasVariantVisionDeclaration;
  const shouldReconcilePersistedProjectorRequirements = (
    hasTrustedAudioProfile && hasReconciledAudioModality
  ) || canRepairPersistedAudioOnlyProjectorRequirement;
  const readinessProjectorCandidate = projectorCandidates?.find((candidate) => (
    candidate.id === multimodalReadiness?.projectorId
    || buildLegacyProjectorArtifactId({
      repoId: candidate.repoId,
      hfRevision: candidate.hfRevision,
      ownerVariantId: candidate.ownerVariantId,
      fileName: candidate.fileName,
    }) === multimodalReadiness?.projectorId
  ));
  const reconciledPersistedArtifacts = shouldReconcilePersistedProjectorRequirements
    ? persistedArtifacts?.map((artifact) => {
        const matchingProjector = artifact.kind === 'multimodal_projector'
          ? projectorCandidates?.find((candidate) => projectorArtifactMatchesCandidate(artifact, candidate))
          : undefined;
        if (!matchingProjector) {
          return artifact;
        }

        if (
          canRepairPersistedAudioOnlyProjectorRequirement
          && readinessProjectorCandidate !== undefined
          && projectorArtifactMatchesCandidate(artifact, readinessProjectorCandidate)
          && artifact.requiredFor.includes('image')
          && artifact.requiredFor.includes('audio')
        ) {
          // Older normalization could derive an image requirement from a stale
          // requestedSupport entry and then persist that derived artifact. Do
          // not let the cached artifact become circular evidence that widens an
          // explicitly audio-only model on every subsequent cold start.
          return { ...artifact, requiredFor: ['audio' as const] };
        }

        if (canRepairAudioOnlyLegacyProjector && (
          artifact.requiredFor.includes('image') || artifact.requiredFor.includes('audio')
        )) {
          return { ...artifact, requiredFor: ['audio' as const] };
        }

        const hasLegacyImageOnlyRequirement = artifact.requiredFor.length === 1
          && artifact.requiredFor[0] === 'image';
        return canRepairUnifiedLegacyProjector && hasLegacyImageOnlyRequirement
          ? { ...artifact, requiredFor: ['image' as const, 'audio' as const] }
          : artifact;
      })
    : persistedArtifacts;
  const isSpeculativeConfigBackedByArtifact = (
    config: NonNullable<ModelMetadata['speculativeDecoding']>,
  ): boolean => config.mode === 'embedded' || reconciledPersistedArtifacts?.some((artifact) => (
    artifact.kind === 'speculative_draft' && artifact.id === config.draftArtifactId
  )) === true;
  const variantsWithValidSpeculativeDecoding = variants?.map((variant) => {
    if (!variant.speculativeDecoding || isSpeculativeConfigBackedByArtifact(variant.speculativeDecoding)) {
      return variant;
    }

    const { speculativeDecoding: _invalidSpeculativeDecoding, ...variantWithoutSpeculativeDecoding } = variant;
    return variantWithoutSpeculativeDecoding;
  });
  const activeVariantWithValidSpeculativeDecoding = resolveActiveModelVariant({
    activeVariantId,
    resolvedFileName: normalizedResolvedFileName,
    variants: variantsWithValidSpeculativeDecoding,
  });
  const speculativeDecodingCandidate = activeVariantWithValidSpeculativeDecoding
    ? activeVariantWithValidSpeculativeDecoding.speculativeDecoding
    : normalizedModelSpeculativeDecoding;
  const speculativeDecoding = speculativeDecodingCandidate
    && isSpeculativeConfigBackedByArtifact(speculativeDecodingCandidate)
    ? speculativeDecodingCandidate
    : undefined;
  const artifacts = deriveArtifactsFromLegacyModel({
    artifacts: reconciledPersistedArtifacts,
    downloadErrorAt,
    downloadErrorCode,
    downloadErrorMessage,
    downloadIntegrity,
    downloadProgress,
    downloadUrl,
    hfRevision: normalizedRevision,
    id: model.id,
    chatModalities,
    inputCapabilities,
    lifecycleStatus,
    localPath,
    multimodalReadiness,
    projectorCandidates,
    resolvedFileName: normalizeNonEmptyString(model.resolvedFileName),
    resumeData,
    selectedProjectorId,
    sha256: normalizedSha256,
    size,
  }, {
    preferLegacyRuntimeState: true,
  });
  const shouldPersistArtifacts = artifacts.length > 0
    && (persistedArtifacts !== undefined || localPath !== undefined || projectorCandidates !== undefined);

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
    modelType: normalizedModelType,
    architectures: normalizedArchitectures,
    baseModels: normalizeStringArray(model.baseModels),
    license: normalizeNonEmptyString(model.license),
    languages: normalizeStringArray(model.languages),
    datasets: normalizeStringArray(model.datasets),
    quantizedBy: normalizeNonEmptyString(model.quantizedBy),
    modelCreator: normalizeNonEmptyString(model.modelCreator),
    downloads: normalizeNullableCount(model.downloads),
    likes: normalizeNullableCount(model.likes),
    tags: normalizedTags,
    description: normalizeNonEmptyString(model.description),
    variants: variantsWithValidSpeculativeDecoding,
    activeVariantId,
    ...(chatModalities !== undefined ? { chatModalities } : {}),
    ...(shouldPersistArtifacts ? { artifacts } : {}),
    ...(inputCapabilities !== undefined ? { inputCapabilities } : {}),
    ...(artifactRole !== undefined ? { artifactRole } : {}),
    ...(!trustedProfileIsAudioOnly && visionSource !== undefined ? { visionSource } : {}),
    ...(!trustedProfileIsAudioOnly && visionConfidence !== undefined ? { visionConfidence } : {}),
    ...(projectorCandidates !== undefined ? { projectorCandidates } : {}),
    ...(selectedProjectorId !== undefined ? { selectedProjectorId } : {}),
    ...(multimodalReadiness !== undefined ? { multimodalReadiness } : {}),
    ...(speculativeDecoding !== undefined ? { speculativeDecoding } : {}),
  };
}
