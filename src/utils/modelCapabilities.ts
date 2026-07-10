import type {
  ModelCapabilitySnapshot,
  ModelGgufMetadata,
  ModelMetadata,
  ModelMetadataTrust,
} from '../types/models';
import type { ModelChatModality } from '../types/multimodal';
import { getActiveModelVariantKeys, resolveActiveModelVariant } from './activeModelVariant';
import { UNKNOWN_MODEL_GPU_LAYERS_CEILING } from './modelLimits';
import { inputCapabilityEvidenceSupportsModality } from './modelInputCapabilities';
import { normalizeProjectorFileName } from './modelProjectors';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from './projectorRuntimeState';
import { getValidatedMultimodalReadinessForResolvedScope } from './multimodalReadinessCore';
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

export type ModelNativeCapabilityInput = Partial<Pick<
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

function hasImageSpecificCapabilityEvidence(
  inputCapabilities: ModelNativeCapabilityInput['inputCapabilities'],
): boolean {
  return inputCapabilities?.evidence.some((entry) => (
    inputCapabilityEvidenceSupportsModality(entry, 'image')
  )) === true;
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

function hasProjectorPathEvidence(model: ModelNativeCapabilityInput): boolean {
  return Boolean(model.projectorCandidates?.length)
    || (typeof model.selectedProjectorId === 'string' && model.selectedProjectorId.trim().length > 0);
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
  const canUseAudioReadinessEvidence = !hasExplicitChatModalities || chatSupportsAudio;
  const canUseLegacyVisionEvidence = (!hasExplicitChatModalities || chatSupportsVision)
    && !hasAudioOnlyDeclaredCapabilityEvidence(model);
  const hasExplicitNativeModalityExcludingVision = hasExplicitNativeChatModalities && !chatSupportsVision;
  const hasAudioArtifactEvidence = modelArtifactsRequireInput(model.artifacts, 'audio');
  const hasAudioReadinessEvidence = canUseAudioReadinessEvidence
    && hasPersistedAudioReadinessEvidence(model.multimodalReadiness);
  const hasAudioCatalogDeclaration = chatSupportsAudio || model.inputCapabilities?.declared.audio === 'supported';
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
      hasAudioArtifactEvidence
      || hasAudioReadinessEvidence
      || (hasAudioCatalogDeclaration && hasProjectorPathEvidence(model))
    ));

  return { vision, audio };
}

export function modelExplicitlySupportsActiveVariantModality(
  model: ModelNativeCapabilityInput,
  modality: Exclude<ModelChatModality, 'text'>,
): boolean {
  const activeVariant = resolveActiveModelVariant(model);
  if (Array.isArray(activeVariant?.chatModalities)) {
    return activeVariant.chatModalities.includes(modality);
  }

  return model.chatModalities?.includes(modality) === true;
}

export function getEffectiveActiveVariantKeys(model: ModelNativeCapabilityInput): ReadonlySet<string> {
  return getActiveModelVariantKeys(model);
}

function normalizeComparableProjectorSize(size: number | null | undefined): number | undefined {
  return typeof size === 'number' && Number.isFinite(size) && size > 0
    ? Math.round(size)
    : undefined;
}

function normalizeComparableProjectorDownloadUrl(downloadUrl: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(downloadUrl);
  if (normalized === null) {
    return undefined;
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

function projectorComparableValuesConflict<T>(
  artifactValue: T | undefined,
  candidateValue: T | undefined,
): boolean {
  return artifactValue !== undefined
    && candidateValue !== undefined
    && artifactValue !== candidateValue;
}

export function projectorArtifactMatchesCandidate(
  artifact: NonNullable<ModelMetadata['artifacts']>[number],
  candidate: NonNullable<ModelMetadata['projectorCandidates']>[number],
): boolean {
  if (
    artifact.kind !== 'multimodal_projector'
    || artifact.id !== candidate.id
    || normalizeProjectorFileName(artifact.remoteFileName) !== normalizeProjectorFileName(candidate.fileName)
    || (normalizeOptionalString(artifact.hfRevision) ?? 'main')
      !== (normalizeOptionalString(candidate.hfRevision) ?? 'main')
  ) {
    return false;
  }

  return !projectorComparableValuesConflict(
    normalizeSha256Digest(artifact.sha256),
    normalizeSha256Digest(candidate.sha256),
  ) && !projectorComparableValuesConflict(
    normalizeComparableProjectorSize(artifact.sizeBytes),
    normalizeComparableProjectorSize(candidate.size),
  ) && !projectorComparableValuesConflict(
    normalizeComparableProjectorDownloadUrl(artifact.downloadUrl),
    normalizeComparableProjectorDownloadUrl(candidate.downloadUrl),
  );
}

function getCandidateProjectorArtifactMatch(
  model: ModelNativeCapabilityInput,
  candidate: NonNullable<ModelMetadata['projectorCandidates']>[number],
): {
  artifacts: NonNullable<ModelMetadata['artifacts']>;
  hasIdentityConflict: boolean;
} {
  const candidateFileName = normalizeProjectorFileName(candidate.fileName);
  const relatedArtifacts = (model.artifacts ?? []).filter((artifact) => (
    artifact.kind === 'multimodal_projector'
    && (
      artifact.id === candidate.id
      || (
        candidateFileName !== null
        && normalizeProjectorFileName(artifact.remoteFileName) === candidateFileName
      )
    )
  ));
  const artifacts = relatedArtifacts.filter((artifact) => (
    projectorArtifactMatchesCandidate(artifact, candidate)
  ));

  return {
    artifacts,
    hasIdentityConflict: relatedArtifacts.some((artifact) => !artifacts.includes(artifact)),
  };
}

function candidateHasTrustedActiveVariantModality(
  model: ModelNativeCapabilityInput,
  candidate: NonNullable<ModelMetadata['projectorCandidates']>[number],
  modality: 'vision' | 'audio',
): boolean {
  const activeVariant = resolveActiveModelVariant(model);
  const { artifacts, hasIdentityConflict } = getCandidateProjectorArtifactMatch(model, candidate);
  if (hasIdentityConflict) {
    return false;
  }
  if (artifacts.length > 0) {
    const requiredInput = modality === 'vision' ? 'image' : 'audio';
    return artifacts.some((artifact) => artifact.requiredFor.includes(requiredInput));
  }

  if (!activeVariant || !Array.isArray(activeVariant.chatModalities)) {
    return true;
  }

  const isVariantOwned = activeVariant.projectorCandidates?.some((entry) => entry === candidate || entry.id === candidate.id)
    || candidate.ownerVariantId === activeVariant.variantId
    || candidate.ownerVariantId === activeVariant.fileName;
  return isVariantOwned === true;
}

export function filterProjectorCandidatesForEffectiveActiveVariant(
  model: ModelNativeCapabilityInput,
  candidates: NonNullable<ModelMetadata['projectorCandidates']>,
): NonNullable<ModelMetadata['projectorCandidates']> {
  const activeVariant = resolveActiveModelVariant(model);
  const activeVariantKeys = getEffectiveActiveVariantKeys(model);
  const modelId = normalizeOptionalString(model.id);
  const seenIds = new Set<string>();

  return candidates.filter((candidate) => {
    if (modelId !== null && candidate.ownerModelId !== modelId) {
      return false;
    }

    const ownerVariantId = normalizeOptionalString(candidate.ownerVariantId);
    const hasCompatibleOwner = ownerVariantId === null
      || activeVariantKeys.size === 0
      || activeVariantKeys.has(ownerVariantId);
    if (!hasCompatibleOwner) {
      return false;
    }

    const effectiveModalities = activeVariant?.chatModalities ?? model.chatModalities;
    if (Array.isArray(effectiveModalities)) {
      const hasCompatibleModality = (
        effectiveModalities.includes('vision')
        && candidateHasTrustedActiveVariantModality(model, candidate, 'vision')
      ) || (
        effectiveModalities.includes('audio')
        && candidateHasTrustedActiveVariantModality(model, candidate, 'audio')
      );
      if (!hasCompatibleModality) {
        return false;
      }
    }

    if (seenIds.has(candidate.id)) {
      return false;
    }
    seenIds.add(candidate.id);
    return true;
  });
}

export function getEffectiveActiveVariantProjectorCandidates(
  model: ModelNativeCapabilityInput,
): NonNullable<ModelMetadata['projectorCandidates']> {
  return resolveEffectiveActiveVariantProjectorCandidates(model).candidates;
}

function resolveEffectiveActiveVariantProjectorCandidates(
  model: ModelNativeCapabilityInput,
): {
  candidates: NonNullable<ModelMetadata['projectorCandidates']>;
  runtimeToEffectiveProjectorIds: ReadonlyMap<string, string>;
} {
  const activeVariant = resolveActiveModelVariant(model);
  const activeVariantCandidates = activeVariant?.projectorCandidates;
  const modelCandidates = model.projectorCandidates;
  if (!activeVariantCandidates?.length) {
    return {
      candidates: filterProjectorCandidatesForEffectiveActiveVariant(model, modelCandidates ?? []),
      runtimeToEffectiveProjectorIds: new Map(),
    };
  }

  const activeVariantKeys = getEffectiveActiveVariantKeys(model);
  const runtimeMerge = mergeProjectorCandidatesWithRuntimeStateAndIdMap(
    activeVariantCandidates,
    modelCandidates,
    { activeVariantIds: activeVariantKeys },
  );
  const blockedEffectiveProjectorIds = new Set([
    ...runtimeMerge.blockedNextProjectorIds,
    ...runtimeMerge.blockedNextReadinessProjectorIds,
  ]);
  const representedModelProjectorIds = new Set(runtimeMerge.runtimeToNextProjectorIds.keys());
  const activeVariantProjectorIds = new Set(activeVariantCandidates.map((candidate) => candidate.id));
  const compatibleModelWideCandidates = (modelCandidates ?? []).filter((candidate) => (
    !representedModelProjectorIds.has(candidate.id)
    && !activeVariantProjectorIds.has(candidate.id)
    && !runtimeMerge.blockedRuntimeProjectorIds.has(candidate.id)
    && !runtimeMerge.blockedRuntimeReadinessProjectorIds.has(candidate.id)
  ));
  const mergedCandidates = [
    ...(runtimeMerge.projectorCandidates ?? activeVariantCandidates),
    ...compatibleModelWideCandidates,
  ].filter((candidate) => !blockedEffectiveProjectorIds.has(candidate.id));

  return {
    candidates: filterProjectorCandidatesForEffectiveActiveVariant(model, mergedCandidates),
    runtimeToEffectiveProjectorIds: runtimeMerge.runtimeToNextProjectorIds,
  };
}

export function getEffectiveActiveVariantSelectedProjectorId(
  model: ModelNativeCapabilityInput,
  candidates?: NonNullable<ModelMetadata['projectorCandidates']>,
): string | undefined {
  const activeVariant = resolveActiveModelVariant(model);
  const resolution = resolveEffectiveActiveVariantProjectorCandidates(model);
  const effectiveCandidates = candidates ?? resolution.candidates;
  const selectedProjectorId = normalizeOptionalString(activeVariant?.selectedProjectorId)
    ?? normalizeOptionalString(model.selectedProjectorId);
  const effectiveSelectedProjectorId = selectedProjectorId === null
    ? null
    : resolution.runtimeToEffectiveProjectorIds.get(selectedProjectorId) ?? selectedProjectorId;
  return effectiveSelectedProjectorId !== null
    && effectiveCandidates.some((candidate) => candidate.id === effectiveSelectedProjectorId)
    ? effectiveSelectedProjectorId
    : undefined;
}

function resolveTrustedReadinessForEffectiveCapabilityInference(
  model: ModelNativeCapabilityInput,
  projectorCandidates: NonNullable<ModelMetadata['projectorCandidates']>,
): ModelNativeCapabilityInput['multimodalReadiness'] {
  const readiness = model.multimodalReadiness;
  if (!readiness) {
    return undefined;
  }

  const activeVariantKeys = getEffectiveActiveVariantKeys(model);
  const validatedReadiness = getValidatedMultimodalReadinessForResolvedScope({
    modelId: normalizeOptionalString(model.id) ?? undefined,
    readiness,
    projectorId: readiness.projectorId,
    activeVariantKeys,
    variantCount: model.variants?.length ?? 0,
    projectorCandidates,
  });
  if (validatedReadiness?.status !== 'ready') {
    return undefined;
  }

  // Capability inference may trust only support actually reported by a valid
  // ready probe. Requested-but-unavailable modalities remain diagnostic state,
  // not positive runtime/UI capability evidence.
  return {
    ...validatedReadiness,
    requestedSupport: [...validatedReadiness.support],
  };
}

/**
 * Resolves native support for runtime and presentation surfaces. Unlike
 * resolveModelNativeMultimodalSupport(), explicit active-variant modalities
 * are authoritative and cannot be widened by parent metadata.
 */
export function resolveEffectiveActiveVariantNativeSupport(
  model: ModelNativeCapabilityInput,
): ModelNativeMultimodalSupport {
  const activeVariant = resolveActiveModelVariant(model);
  const effectiveArtifactRole = activeVariant?.artifactRole ?? model.artifactRole;
  if (effectiveArtifactRole === 'projector_companion') {
    return { vision: false, audio: false };
  }

  if (Array.isArray(activeVariant?.chatModalities)) {
    const projectorCandidates = getEffectiveActiveVariantProjectorCandidates(model);
    return {
      vision: activeVariant.chatModalities.includes('vision'),
      audio: activeVariant.chatModalities.includes('audio') && projectorCandidates.some((candidate) => (
        candidateHasTrustedActiveVariantModality(model, candidate, 'audio')
      )),
    };
  }

  const projectorCandidates = getEffectiveActiveVariantProjectorCandidates(model);
  const effectiveSelectedProjectorId = getEffectiveActiveVariantSelectedProjectorId(model, projectorCandidates);
  const readiness = resolveTrustedReadinessForEffectiveCapabilityInference(model, projectorCandidates);

  const support = resolveModelNativeMultimodalSupport({
    ...model,
    artifactRole: effectiveArtifactRole,
    projectorCandidates,
    selectedProjectorId: effectiveSelectedProjectorId,
    multimodalReadiness: readiness,
  });
  return {
    vision: support.vision,
    audio: support.audio && projectorCandidates.some((candidate) => (
      candidateHasTrustedActiveVariantModality(model, candidate, 'audio')
    )),
  };
}

export function modelSupportsVision(model: ModelVisionCapabilityInput): boolean {
  return resolveEffectiveActiveVariantNativeSupport(model).vision;
}

export function modelSupportsAudio(model: ModelNativeCapabilityInput): boolean {
  return resolveEffectiveActiveVariantNativeSupport(model).audio;
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
  const candidates = getEffectiveActiveVariantProjectorCandidates(model);
  const selectedProjectorId = getEffectiveActiveVariantSelectedProjectorId(model, candidates);
  const readyCandidates = candidates.filter((candidate) => (
    candidate.lifecycleStatus === 'downloaded' || candidate.lifecycleStatus === 'active'
  ));

  return selectedProjectorId
    ? readyCandidates.some((candidate) => candidate.id === selectedProjectorId)
    : readyCandidates.length > 0;
}

export function getModelVisionCapabilityStatusLabelKey(
  model: ModelVisionCapabilityInput,
): string | null {
  if (!resolveEffectiveActiveVariantNativeSupport(model).vision) {
    return null;
  }

  if (hasReadyProjectorCandidate(model)) {
    return 'models.vision.capabilityReady';
  }

  return getEffectiveActiveVariantProjectorCandidates(model).length > 0
    ? 'models.vision.capabilityNeedsProjector'
    : 'models.vision.projectorMissing';
}

export function getModelVisionCapabilityBadgePresentation(
  model: ModelVisionCapabilityInput,
): ModelVisionCapabilityBadgePresentation | null {
  if (!resolveEffectiveActiveVariantNativeSupport(model).vision) {
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
  if (!resolveEffectiveActiveVariantNativeSupport(model).audio) {
    return null;
  }

  return {
    labelKey: 'models.audio.badge',
    tone: 'info',
    iconName: 'graphic-eq',
  };
}
