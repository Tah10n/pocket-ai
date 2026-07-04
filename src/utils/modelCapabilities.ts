import type {
  ModelCapabilitySnapshot,
  ModelGgufMetadata,
  ModelMetadata,
  ModelMetadataTrust,
} from '../types/models';
import type { ModelChatModality } from '../types/multimodal';
import { UNKNOWN_MODEL_GPU_LAYERS_CEILING } from './modelLimits';
import { normalizeSha256Digest } from './sha256';

export const MODEL_CAPABILITY_HEURISTIC_VERSION = 1;

export type ModelNativeCapabilityBadgeTone = 'info' | 'warning';

export interface ModelNativeCapabilityBadgePresentation {
  labelKey: string;
  tone: ModelNativeCapabilityBadgeTone;
  iconName: 'visibility' | 'graphic-eq';
}

export type ModelVisionCapabilityBadgeTone = ModelNativeCapabilityBadgeTone;
export type ModelVisionCapabilityBadgePresentation = ModelNativeCapabilityBadgePresentation;
export type ModelAudioCapabilityBadgePresentation = ModelNativeCapabilityBadgePresentation;

export type ModelNativeMultimodalSupport = {
  vision: boolean;
  audio: boolean;
};

type ModelNativeCapabilityInput = Partial<Pick<
  ModelMetadata,
  | 'artifactRole'
  | 'activeVariantId'
  | 'artifacts'
  | 'chatModalities'
  | 'id'
  | 'inputCapabilities'
  | 'projectorCandidates'
  | 'resolvedFileName'
  | 'selectedProjectorId'
  | 'multimodalReadiness'
  | 'variants'
>>;

type ModelVisionCapabilityInput = ModelNativeCapabilityInput;

type ModelCapabilityInput = Pick<
  ModelMetadata,
  | 'capabilitySnapshot'
  | 'gguf'
  | 'hasVerifiedContextWindow'
  | 'lastModifiedAt'
  | 'maxContextTokens'
  | 'metadataTrust'
  | 'sha256'
  | 'size'
>;

function normalizeArchitecturePrefix(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function toPositiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
}

function toNonNegativeIntegerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value);
}

function normalizeMetadataTrust(value: unknown): ModelMetadataTrust {
  return value === 'verified_local'
    || value === 'trusted_remote'
    || value === 'inferred'
    || value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function extractCapabilityDigestEntries(
  ggufMetadata?: ModelGgufMetadata | Record<string, unknown>,
): Record<string, string | number> {
  if (!ggufMetadata) {
    return {};
  }

  const directArchitecture = normalizeArchitecturePrefix(ggufMetadata.architecture);
  const generalArchitecture = normalizeArchitecturePrefix(ggufMetadata['general.architecture']);
  const architecture = directArchitecture ?? generalArchitecture;
  const prefixes = architecture
    ? Array.from(new Set([architecture, architecture.replace(/\d+$/u, '')].filter((value) => value.length > 0)))
    : [];
  const relevantKeys = [
    'general.architecture',
    'architecture',
    'general.type',
    'context_length',
    'sliding_window',
    'nLayers',
    'n_layers',
    'n_layer',
    'block_count',
    ...prefixes.map((prefix) => `${prefix}.block_count`),
  ];

  return relevantKeys.reduce<Record<string, string | number>>((acc, key) => {
    const raw = ggufMetadata[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      acc[key] = raw;
    } else {
      const normalized = normalizeOptionalString(raw);
      if (normalized !== null) {
        acc[key] = normalized;
      }
    }
    return acc;
  }, {});
}

export function resolveModelLayerCountFromGgufMetadata(
  ggufMetadata?: ModelGgufMetadata | Record<string, unknown>,
): number | null {
  if (!ggufMetadata) {
    return null;
  }

  const directArchitecture = normalizeArchitecturePrefix(ggufMetadata.architecture);
  const generalArchitecture = normalizeArchitecturePrefix(ggufMetadata['general.architecture']);
  const architecture = directArchitecture ?? generalArchitecture;
  const prefixes = architecture
    ? Array.from(new Set([architecture, architecture.replace(/\d+$/u, '')].filter((value) => value.length > 0)))
    : [];
  const candidates = [
    'nLayers',
    'n_layers',
    'n_layer',
    'block_count',
    ...prefixes.map((prefix) => `${prefix}.block_count`),
  ];

  for (const key of candidates) {
    const raw = ggufMetadata[key];
    const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) {
      continue;
    }

    const rounded = Math.round(numeric);
    if (rounded > 0) {
      return rounded;
    }
  }

  return null;
}

function resolveSizeBytes(input: ModelCapabilityInput): number | null {
  return toPositiveIntegerOrNull(input.size);
}

function resolveVerifiedFileSizeBytes(input: ModelCapabilityInput): number | null {
  if (input.metadataTrust !== 'verified_local') {
    return null;
  }

  return toPositiveIntegerOrNull(input.gguf?.totalBytes) ?? resolveSizeBytes(input);
}

function resolveVerifiedMaxContextTokens(input: ModelCapabilityInput): number | null {
  if (input.hasVerifiedContextWindow !== true) {
    return null;
  }

  return toPositiveIntegerOrNull(input.maxContextTokens);
}

function buildGgufCapabilityDigest(
  ggufMetadata?: ModelGgufMetadata | Record<string, unknown>,
): string | null {
  const entries = Object.entries(extractCapabilityDigestEntries(ggufMetadata))
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  if (entries.length === 0) {
    return null;
  }

  return JSON.stringify(entries);
}

export function buildModelCapabilitySnapshot(
  input: Omit<ModelCapabilityInput, 'capabilitySnapshot'>,
): ModelCapabilitySnapshot {
  const modelLayerCount = resolveModelLayerCountFromGgufMetadata(input.gguf);
  const gpuLayersCeiling = modelLayerCount ?? UNKNOWN_MODEL_GPU_LAYERS_CEILING;
  const metadataTrust = normalizeMetadataTrust(input.metadataTrust);
  const sizeBytes = resolveSizeBytes(input);
  const verifiedFileSizeBytes = resolveVerifiedFileSizeBytes(input);
  const verifiedMaxContextTokens = resolveVerifiedMaxContextTokens(input);
  const ggufCapabilityDigest = buildGgufCapabilityDigest(input.gguf);
  const sha256 = normalizeSha256Digest(input.sha256);
  const lastModifiedAt = toPositiveIntegerOrNull(input.lastModifiedAt);

  return {
    heuristicVersion: MODEL_CAPABILITY_HEURISTIC_VERSION,
    modelLayerCount,
    gpuLayersCeiling,
    metadataTrust,
    ...(sizeBytes !== null ? { sizeBytes } : {}),
    ...(verifiedFileSizeBytes !== null ? { verifiedFileSizeBytes } : {}),
    ...(verifiedMaxContextTokens !== null ? { verifiedMaxContextTokens } : {}),
    ...(ggufCapabilityDigest !== null ? { ggufCapabilityDigest } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(lastModifiedAt !== null ? { lastModifiedAt } : {}),
  };
}

function normalizeCapabilitySnapshot(
  snapshot: unknown,
): ModelCapabilitySnapshot | null {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const candidate = snapshot as Partial<ModelCapabilitySnapshot>;
  const heuristicVersion = toPositiveIntegerOrNull(candidate.heuristicVersion);
  const gpuLayersCeiling = toNonNegativeIntegerOrNull(candidate.gpuLayersCeiling);
  const modelLayerCount = candidate.modelLayerCount === null
    ? null
    : toPositiveIntegerOrNull(candidate.modelLayerCount);
  const sizeBytes = toPositiveIntegerOrNull(candidate.sizeBytes);
  const verifiedFileSizeBytes = toPositiveIntegerOrNull(candidate.verifiedFileSizeBytes);
  const verifiedMaxContextTokens = toPositiveIntegerOrNull(candidate.verifiedMaxContextTokens);
  const ggufCapabilityDigest = normalizeOptionalString(candidate.ggufCapabilityDigest);
  const sha256 = normalizeSha256Digest(candidate.sha256);
  const lastModifiedAt = toPositiveIntegerOrNull(candidate.lastModifiedAt);

  if (heuristicVersion === null || gpuLayersCeiling === null) {
    return null;
  }

  return {
    heuristicVersion,
    modelLayerCount,
    gpuLayersCeiling,
    metadataTrust: normalizeMetadataTrust(candidate.metadataTrust),
    ...(sizeBytes !== null ? { sizeBytes } : {}),
    ...(verifiedFileSizeBytes !== null ? { verifiedFileSizeBytes } : {}),
    ...(verifiedMaxContextTokens !== null ? { verifiedMaxContextTokens } : {}),
    ...(ggufCapabilityDigest !== null ? { ggufCapabilityDigest } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(lastModifiedAt !== null ? { lastModifiedAt } : {}),
  };
}

function areOptionalValuesEqual<T extends string | number | null | undefined>(
  left: T,
  right: T,
): boolean {
  return left === right;
}

export function isModelCapabilitySnapshotCurrent(
  input: Omit<ModelCapabilityInput, 'capabilitySnapshot'>,
  snapshot: ModelCapabilitySnapshot,
): boolean {
  const derivedSnapshot = buildModelCapabilitySnapshot(input);

  return (
    snapshot.heuristicVersion === derivedSnapshot.heuristicVersion
    && snapshot.modelLayerCount === derivedSnapshot.modelLayerCount
    && snapshot.gpuLayersCeiling === derivedSnapshot.gpuLayersCeiling
    && snapshot.metadataTrust === derivedSnapshot.metadataTrust
    && areOptionalValuesEqual(snapshot.sizeBytes, derivedSnapshot.sizeBytes)
    && areOptionalValuesEqual(snapshot.verifiedFileSizeBytes, derivedSnapshot.verifiedFileSizeBytes)
    && areOptionalValuesEqual(snapshot.verifiedMaxContextTokens, derivedSnapshot.verifiedMaxContextTokens)
    && areOptionalValuesEqual(snapshot.ggufCapabilityDigest, derivedSnapshot.ggufCapabilityDigest)
    && areOptionalValuesEqual(snapshot.sha256, derivedSnapshot.sha256)
    && areOptionalValuesEqual(snapshot.lastModifiedAt, derivedSnapshot.lastModifiedAt)
  );
}

export function normalizePersistedModelCapabilitySnapshot(
  input: Omit<ModelCapabilityInput, 'capabilitySnapshot'>,
  snapshot: unknown,
): ModelCapabilitySnapshot | undefined {
  const normalizedSnapshot = normalizeCapabilitySnapshot(snapshot);
  if (!normalizedSnapshot) {
    return undefined;
  }

  return isModelCapabilitySnapshotCurrent(input, normalizedSnapshot)
    ? normalizedSnapshot
    : undefined;
}

export function resolveModelCapabilitySnapshot(
  input: ModelCapabilityInput,
): { snapshot: ModelCapabilitySnapshot; isCurrentPersisted: boolean } {
  const normalizedInput = {
    gguf: input.gguf,
    hasVerifiedContextWindow: input.hasVerifiedContextWindow,
    lastModifiedAt: input.lastModifiedAt,
    maxContextTokens: input.maxContextTokens,
    metadataTrust: input.metadataTrust,
    sha256: input.sha256,
    size: input.size,
  };
  const persistedSnapshot = normalizePersistedModelCapabilitySnapshot(
    normalizedInput,
    input.capabilitySnapshot,
  );

  if (persistedSnapshot) {
    return {
      snapshot: persistedSnapshot,
      isCurrentPersisted: true,
    };
  }

  return {
    snapshot: buildModelCapabilitySnapshot(normalizedInput),
    isCurrentPersisted: false,
  };
}

function hasPersistedVisionReadinessEvidence(
  readiness: ModelVisionCapabilityInput['multimodalReadiness'],
  options: { allowLegacyEvidence: boolean },
): boolean {
  if (!readiness) {
    return false;
  }

  if (readiness.support.includes('vision') || readiness.requestedSupport?.includes('vision') === true) {
    return true;
  }

  if (!options.allowLegacyEvidence || readiness.requestedSupport !== undefined) {
    return false;
  }

  return typeof readiness.projectorId === 'string' || readiness.status !== 'text_only';
}

const IMAGE_CAPABILITY_PIPELINE_TAGS = new Set([
  'image-text-to-text',
  'visual-question-answering',
  'document-question-answering',
]);
const IMAGE_CAPABILITY_SIGNAL_PATTERN = /\b(?:vision|visual|multimodal|vlm|llava|bakllava|moondream|pixtral|qwen2(?:\.5)?-?vl|qwen2vl|qwen25vl)/u;

function hasImageSpecificCapabilityEvidence(
  inputCapabilities: ModelNativeCapabilityInput['inputCapabilities'],
): boolean {
  return inputCapabilities?.evidence.some((entry) => {
    const value = entry.value.trim().toLowerCase();
    if (!value || entry.source === 'projector') {
      return false;
    }

    if (entry.source === 'pipeline_tag') {
      return IMAGE_CAPABILITY_PIPELINE_TAGS.has(value);
    }

    return IMAGE_CAPABILITY_SIGNAL_PATTERN.test(value);
  }) === true;
}

function hasDeclaredImageInputSupport(
  model: ModelNativeCapabilityInput,
  options: { allowProjectorOnlyEvidence: boolean },
): boolean {
  if (model.inputCapabilities?.declared.image !== 'supported') {
    return false;
  }

  return options.allowProjectorOnlyEvidence || hasImageSpecificCapabilityEvidence(model.inputCapabilities);
}

function hasAudioOnlyDeclaredCapabilityEvidence(model: ModelNativeCapabilityInput): boolean {
  return model.inputCapabilities?.declared.audio === 'supported'
    && model.inputCapabilities.declared.image !== 'supported'
    && !hasImageSpecificCapabilityEvidence(model.inputCapabilities);
}

function modelArtifactsRequireInput(
  artifacts: ModelNativeCapabilityInput['artifacts'],
  input: 'image' | 'audio',
): boolean {
  return artifacts?.some((artifact) => (
    artifact.kind === 'multimodal_projector' && artifact.requiredFor.includes(input)
  )) === true;
}

function hasPersistedAudioReadinessEvidence(
  readiness: ModelNativeCapabilityInput['multimodalReadiness'],
): boolean {
  return readiness?.support.includes('audio') === true
    || readiness?.requestedSupport?.includes('audio') === true;
}

export function resolveModelNativeMultimodalSupport(model: ModelNativeCapabilityInput): ModelNativeMultimodalSupport {
  if (model.artifactRole === 'projector_companion') {
    return { vision: false, audio: false };
  }

  const chatSupportsVision = model.chatModalities?.includes('vision') === true;
  const chatSupportsAudio = model.chatModalities?.includes('audio') === true;
  const hasExplicitChatModalities = Array.isArray(model.chatModalities);
  const hasExplicitNativeChatModalities = chatSupportsVision || chatSupportsAudio;
  const canUseNativeCapabilityEvidence = !hasExplicitChatModalities || hasExplicitNativeChatModalities;
  const canUseLegacyVisionEvidence = (!hasExplicitChatModalities || chatSupportsVision)
    && !hasAudioOnlyDeclaredCapabilityEvidence(model);
  const hasExplicitNativeModalityExcludingVision = hasExplicitNativeChatModalities && !chatSupportsVision;
  const vision = chatSupportsVision
    || (canUseNativeCapabilityEvidence && hasDeclaredImageInputSupport(model, {
      allowProjectorOnlyEvidence: !hasExplicitNativeModalityExcludingVision,
    }))
    || (canUseLegacyVisionEvidence && (
      Boolean(model.projectorCandidates?.length)
      || (typeof model.selectedProjectorId === 'string' && model.selectedProjectorId.trim().length > 0)
      || modelArtifactsRequireInput(model.artifacts, 'image')
      || hasPersistedVisionReadinessEvidence(model.multimodalReadiness, {
        allowLegacyEvidence: canUseLegacyVisionEvidence,
      })
    ));
  const audio = chatSupportsAudio
    || (canUseNativeCapabilityEvidence && (
      model.inputCapabilities?.declared.audio === 'supported'
      || modelArtifactsRequireInput(model.artifacts, 'audio')
      || hasPersistedAudioReadinessEvidence(model.multimodalReadiness)
    ));

  return { vision, audio };
}

export function modelSupportsVision(model: ModelVisionCapabilityInput): boolean {
  return resolveModelNativeMultimodalSupport(model).vision;
}

export function modelSupportsAudio(model: ModelNativeCapabilityInput): boolean {
  return resolveModelNativeMultimodalSupport(model).audio;
}

export function resolveModelChatModalities(model: ModelNativeCapabilityInput): ModelChatModality[] {
  const support = resolveModelNativeMultimodalSupport(model);
  return [
    'text',
    ...(support.vision ? ['vision' as const] : []),
    ...(support.audio ? ['audio' as const] : []),
  ];
}

function hasReadyProjectorCandidate(
  model: ModelVisionCapabilityInput,
): boolean {
  const candidates = getCompatibleProjectorCandidates(model);
  const selectedProjectorId = normalizeOptionalString(model.selectedProjectorId);
  const readyCandidates = candidates.filter((candidate) => (
    candidate.lifecycleStatus === 'downloaded' || candidate.lifecycleStatus === 'active'
  ));

  return selectedProjectorId
    ? readyCandidates.some((candidate) => candidate.id === selectedProjectorId)
    : readyCandidates.length > 0;
}

function getActiveVariantKeys(model: ModelVisionCapabilityInput): Set<string> {
  const activeVariantId = normalizeOptionalString(model.activeVariantId);
  const resolvedFileName = normalizeOptionalString(model.resolvedFileName);
  const activeVariant = model.variants?.find((variant) => (
    (activeVariantId !== null && (variant.variantId === activeVariantId || variant.fileName === activeVariantId))
    || (resolvedFileName !== null && (variant.variantId === resolvedFileName || variant.fileName === resolvedFileName))
  ));

  return new Set([
    activeVariantId,
    resolvedFileName,
    normalizeOptionalString(activeVariant?.variantId),
    normalizeOptionalString(activeVariant?.fileName),
  ].filter((value): value is string => value !== null));
}

function getCompatibleProjectorCandidates(model: ModelVisionCapabilityInput): NonNullable<ModelMetadata['projectorCandidates']> {
  const modelId = normalizeOptionalString(model.id);
  const activeVariantKeys = getActiveVariantKeys(model);

  return (model.projectorCandidates ?? []).filter((candidate) => {
    if (modelId !== null && candidate.ownerModelId !== modelId) {
      return false;
    }

    const ownerVariantId = normalizeOptionalString(candidate.ownerVariantId);
    return ownerVariantId === null || activeVariantKeys.size === 0 || activeVariantKeys.has(ownerVariantId);
  });
}

export function getModelVisionCapabilityStatusLabelKey(
  model: ModelVisionCapabilityInput,
): string | null {
  if (!modelSupportsVision(model)) {
    return null;
  }

  if (hasReadyProjectorCandidate(model)) {
    return 'models.vision.capabilityReady';
  }

  return getCompatibleProjectorCandidates(model).length > 0
    ? 'models.vision.capabilityNeedsProjector'
    : 'models.vision.projectorMissing';
}

export function getModelVisionCapabilityBadgePresentation(
  model: ModelVisionCapabilityInput,
): ModelVisionCapabilityBadgePresentation | null {
  if (!modelSupportsVision(model)) {
    return null;
  }

  return {
    labelKey: 'models.vision.badge',
    tone: hasReadyProjectorCandidate(model) ? 'info' : 'warning',
    iconName: 'visibility',
  };
}

export function getModelAudioCapabilityBadgePresentation(
  model: ModelNativeCapabilityInput,
): ModelAudioCapabilityBadgePresentation | null {
  if (!modelSupportsAudio(model)) {
    return null;
  }

  return {
    labelKey: 'models.audio.badge',
    tone: 'info',
    iconName: 'graphic-eq',
  };
}
