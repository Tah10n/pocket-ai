import type {
  ModelCapabilitySnapshot,
  ModelGgufMetadata,
  ModelMetadata,
  ModelMetadataTrust,
} from '../types/models';
import { UNKNOWN_MODEL_GPU_LAYERS_CEILING } from './modelLimits';

export const MODEL_CAPABILITY_HEURISTIC_VERSION = 1;

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
  const sha256 = normalizeOptionalString(input.sha256);
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
    ...(sha256 !== null ? { sha256 } : {}),
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
  const sha256 = normalizeOptionalString(candidate.sha256);
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
    ...(sha256 !== null ? { sha256 } : {}),
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
