import type { MMKV } from 'react-native-mmkv';
import llamaPackageJson from 'llama.rn/package.json';
import { assertPrivateStorageWritable, createStorage } from './storage';

const LLAMA_RN_VERSION: string = typeof llamaPackageJson?.version === 'string' ? llamaPackageJson.version : 'unknown';

export const DEFAULT_LAST_GOOD_PROFILE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const DEFAULT_MODEL_INIT_FAILURE_BOUND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_MODEL_INIT_FAILURE_BOUND_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_MODEL_INIT_FAILURE_BOUND_ENTRIES = 64;

const MODEL_INIT_FAILURE_BOUND_KEY_PREFIX = 'init-oom-bound:';

export function getCurrentNativeModuleVersion(): string {
  return LLAMA_RN_VERSION;
}

export type LastGoodBackendMode = 'cpu' | 'gpu' | 'npu';

export type LastGoodInferenceProfile = {
  createdAtMs: number;
  modelId: string;
  contextSize: number;
  kvCacheType: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
  nativeModuleVersion?: string;
  backendMode: LastGoodBackendMode;
  nGpuLayers: number;
  devices?: string[];
};

export type ModelInitFailureBoundCompanionIdentity = {
  id: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  downloadMarker?: number | string | null;
};

export type ModelInitFailureBoundSpeculativeIdentity = {
  mode: string;
  maxDraftTokens?: number | null;
  draft?: ModelInitFailureBoundCompanionIdentity | null;
};

export type ModelInitFailureBoundIdentity = {
  modelId: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
  modelDownloadMarker?: number | null;
  modelVariantId?: string | null;
  modelResolvedFileName?: string | null;
  modelRevision?: string | null;
  deviceModel: string;
  deviceAbis: string[];
  totalMemoryBytes?: number | null;
  platform: string;
  platformVersion: string;
  osBuildId: string;
  appVersion: string;
  nativeModuleVersion: string;
  nativeRuntimeBuild: string;
  backendMode: LastGoodBackendMode;
  devices?: string[];
  contextSize: number;
  cacheTypeK: string;
  cacheTypeV: string;
  nThreads?: number | null;
  cpuMask?: string | null;
  cpuStrict?: boolean | null;
  flashAttnType: 'auto' | 'on' | 'off';
  useMmap: boolean;
  useMlock: boolean;
  nBatch?: number | null;
  nUbatch?: number | null;
  noExtraBufts: boolean;
  kvUnified?: boolean | null;
  nParallel: number;
  projector?: ModelInitFailureBoundCompanionIdentity | null;
  speculative?: ModelInitFailureBoundSpeculativeIdentity | null;
};

export type ModelInitFailureBound = {
  createdAtMs: number;
  oomUpperBoundGpuLayers: number;
};

type PersistedModelInitFailureBound = ModelInitFailureBound & {
  schemaVersion: 1;
  identityKey: string;
};

let lastGoodStorageInstance: MMKV | null = null;

export function invalidateLastGoodProfileStorageForPrivateReset(): void {
  lastGoodStorageInstance = null;
}

function getLastGoodStorage(): MMKV {
  if (lastGoodStorageInstance) {
    assertPrivateStorageWritable();
    return lastGoodStorageInstance;
  }

  const created = createStorage('pocket-ai-last-good-profiles', { tier: 'private' });
  lastGoodStorageInstance = created;
  return created;
}

function buildLastGoodKey({
  modelId,
  contextSize,
  kvCacheType,
}: {
  modelId: string;
  contextSize: number;
  kvCacheType: string;
}): string {
  const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
  const normalizedContext = Number.isFinite(contextSize) ? Math.max(0, Math.round(contextSize)) : 0;
  const normalizedKv = typeof kvCacheType === 'string' ? kvCacheType.trim().toLowerCase() : 'auto';
  return `last-good:${normalizedModelId}:${normalizedContext}:${normalizedKv}`;
}

function sanitizeDevices(devices: unknown): string[] | undefined {
  if (!Array.isArray(devices)) {
    return undefined;
  }

  const normalized = devices
    .filter((device): device is string => typeof device === 'string')
    .map((device) => device.trim())
    .filter((device) => device.length > 0 && !/\s/.test(device));

  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique.slice(0, 10) : undefined;
}

function normalizeIdentityText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeIdentityInteger(value: unknown, minimum = 0): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.round(value);
  return normalized >= minimum ? normalized : null;
}

function normalizeIdentityStringList(value: unknown, sort: boolean): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = Array.from(new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)));
  return (sort
    ? normalized.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    : normalized).slice(0, 16);
}

function normalizeIdentityMarker(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return `number:${Math.round(value)}`;
  }
  const normalized = normalizeIdentityText(value);
  return normalized.length > 0 ? `text:${normalized}` : '';
}

function normalizeFailureBoundCompanion(
  value: ModelInitFailureBoundCompanionIdentity | null | undefined,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  return {
    id: normalizeIdentityText(value.id),
    sizeBytes: normalizeIdentityInteger(value.sizeBytes, 1),
    sha256: normalizeIdentityText(value.sha256).toLowerCase(),
    downloadMarker: normalizeIdentityMarker(value.downloadMarker),
  };
}

function buildModelInitFailureBoundIdentityKey(identity: ModelInitFailureBoundIdentity): string {
  return JSON.stringify({
    model: {
      id: normalizeIdentityText(identity.modelId),
      sizeBytes: normalizeIdentityInteger(identity.modelFileSizeBytes, 1),
      sha256: normalizeIdentityText(identity.modelSha256).toLowerCase(),
      downloadMarker: normalizeIdentityInteger(identity.modelDownloadMarker),
      variantId: normalizeIdentityText(identity.modelVariantId),
      resolvedFileName: normalizeIdentityText(identity.modelResolvedFileName),
      revision: normalizeIdentityText(identity.modelRevision),
    },
    device: {
      model: normalizeIdentityText(identity.deviceModel, 'unknown'),
      abis: normalizeIdentityStringList(identity.deviceAbis, true),
      totalMemoryBytes: normalizeIdentityInteger(identity.totalMemoryBytes, 1),
      platform: normalizeIdentityText(identity.platform, 'unknown').toLowerCase(),
      platformVersion: normalizeIdentityText(identity.platformVersion, 'unknown'),
      osBuildId: normalizeIdentityText(identity.osBuildId, 'unknown'),
    },
    runtime: {
      appVersion: normalizeIdentityText(identity.appVersion, 'unknown'),
      nativeModuleVersion: normalizeIdentityText(identity.nativeModuleVersion, 'unknown'),
      nativeRuntimeBuild: normalizeIdentityText(identity.nativeRuntimeBuild, 'unknown'),
    },
    profile: {
      backendMode: identity.backendMode,
      devices: normalizeIdentityStringList(identity.devices, true),
      contextSize: normalizeIdentityInteger(identity.contextSize, 1),
      cacheTypeK: normalizeIdentityText(identity.cacheTypeK, 'f16').toLowerCase(),
      cacheTypeV: normalizeIdentityText(identity.cacheTypeV, 'f16').toLowerCase(),
      nThreads: normalizeIdentityInteger(identity.nThreads, 1),
      cpuMask: normalizeIdentityText(identity.cpuMask),
      cpuStrict: typeof identity.cpuStrict === 'boolean' ? identity.cpuStrict : null,
      flashAttnType: identity.flashAttnType,
      useMmap: identity.useMmap === true,
      useMlock: identity.useMlock === true,
      nBatch: normalizeIdentityInteger(identity.nBatch, 1),
      nUbatch: normalizeIdentityInteger(identity.nUbatch, 1),
      noExtraBufts: identity.noExtraBufts === true,
      kvUnified: typeof identity.kvUnified === 'boolean' ? identity.kvUnified : null,
      nParallel: normalizeIdentityInteger(identity.nParallel, 1),
      projector: normalizeFailureBoundCompanion(identity.projector),
      speculative: identity.speculative
        ? {
            mode: normalizeIdentityText(identity.speculative.mode, 'unknown'),
            maxDraftTokens: normalizeIdentityInteger(identity.speculative.maxDraftTokens, 1),
            draft: normalizeFailureBoundCompanion(identity.speculative.draft),
          }
        : null,
    },
  });
}

function hashFailureBoundIdentityWithSeed(identityKey: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < identityKey.length; index += 1) {
    hash ^= identityKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashFailureBoundIdentity(identityKey: string): string {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hashFailureBoundIdentityWithSeed(identityKey, seed))
    .join('');
}

function buildModelInitFailureBoundStorageKey(identityKey: string): string {
  return `${MODEL_INIT_FAILURE_BOUND_KEY_PREFIX}${identityKey.length}:${hashFailureBoundIdentity(identityKey)}`;
}

function removeFailureBoundKey(key: string): void {
  try {
    getLastGoodStorage().remove(key);
  } catch {
    // Best-effort cleanup must not hide the original read result.
  }
}

function pruneModelInitFailureBounds(nowMs: number): void {
  const storage = getLastGoodStorage();
  const retained: { key: string; createdAtMs: number }[] = [];

  for (const key of storage.getAllKeys()) {
    if (!key.startsWith(MODEL_INIT_FAILURE_BOUND_KEY_PREFIX)) {
      continue;
    }

    const raw = storage.getString(key);
    if (!raw) {
      storage.remove(key);
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedModelInitFailureBound>;
      const createdAtMs = normalizeIdentityInteger(parsed.createdAtMs);
      const upperBound = normalizeIdentityInteger(parsed.oomUpperBoundGpuLayers);
      if (
        parsed.schemaVersion !== 1
        || typeof parsed.identityKey !== 'string'
        || createdAtMs === null
        || upperBound === null
        || nowMs - createdAtMs > DEFAULT_MODEL_INIT_FAILURE_BOUND_MAX_AGE_MS
        || createdAtMs - nowMs > MAX_MODEL_INIT_FAILURE_BOUND_FUTURE_SKEW_MS
      ) {
        storage.remove(key);
        continue;
      }
      retained.push({ key, createdAtMs });
    } catch {
      storage.remove(key);
    }
  }

  retained.sort((left, right) => (
    left.createdAtMs - right.createdAtMs
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  ));
  for (const entry of retained.slice(0, Math.max(0, retained.length - MAX_MODEL_INIT_FAILURE_BOUND_ENTRIES))) {
    storage.remove(entry.key);
  }
}

export function readLastGoodInferenceProfile({
  modelId,
  contextSize,
  kvCacheType,
  modelFileSizeBytes,
  modelSha256,
  expectedNativeModuleVersion = getCurrentNativeModuleVersion(),
  maxAgeMs = DEFAULT_LAST_GOOD_PROFILE_MAX_AGE_MS,
}: {
  modelId: string;
  contextSize: number;
  kvCacheType: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
  expectedNativeModuleVersion?: string;
  maxAgeMs?: number;
}): LastGoodInferenceProfile | null {
  const key = buildLastGoodKey({ modelId, contextSize, kvCacheType });
  const raw = getLastGoodStorage().getString(key);
  if (!raw) {
    return null;
  }

  const clearAndReturnNull = () => {
    try {
      getLastGoodStorage().remove(key);
    } catch {
      // ignore
    }
    return null;
  };

  try {
    const parsed = JSON.parse(raw) as LastGoodInferenceProfile;
    if (!parsed || typeof parsed !== 'object') {
      return clearAndReturnNull();
    }
    if (typeof parsed.modelId !== 'string' || parsed.modelId.trim() !== modelId.trim()) {
      return clearAndReturnNull();
    }
    if (parsed.backendMode !== 'cpu' && parsed.backendMode !== 'gpu' && parsed.backendMode !== 'npu') {
      return clearAndReturnNull();
    }
    if (!Number.isFinite(parsed.nGpuLayers) || parsed.nGpuLayers < 0) {
      return clearAndReturnNull();
    }

    const expectedFileSize = typeof modelFileSizeBytes === 'number' && Number.isFinite(modelFileSizeBytes) && modelFileSizeBytes > 0
      ? Math.round(modelFileSizeBytes)
      : null;
    if (expectedFileSize !== null) {
      const storedFileSize = typeof parsed.modelFileSizeBytes === 'number' && Number.isFinite(parsed.modelFileSizeBytes)
        ? Math.round(parsed.modelFileSizeBytes)
        : null;
      if (storedFileSize === null || storedFileSize !== expectedFileSize) {
        return clearAndReturnNull();
      }
    }

    const expectedSha = typeof modelSha256 === 'string' ? modelSha256.trim().toLowerCase() : '';
    if (expectedSha.length > 0) {
      const storedSha = typeof parsed.modelSha256 === 'string' ? parsed.modelSha256.trim().toLowerCase() : '';
      if (storedSha.length === 0 || storedSha !== expectedSha) {
        return clearAndReturnNull();
      }
    }

    if (typeof expectedNativeModuleVersion === 'string' && expectedNativeModuleVersion.length > 0) {
      const storedVersion = typeof parsed.nativeModuleVersion === 'string' ? parsed.nativeModuleVersion : '';
      if (storedVersion !== expectedNativeModuleVersion) {
        return clearAndReturnNull();
      }
    }

    if (typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      const createdAtMs = typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs)
        ? parsed.createdAtMs
        : null;
      if (createdAtMs === null || Date.now() - createdAtMs > maxAgeMs) {
        return clearAndReturnNull();
      }
    }

    const devices = parsed.backendMode === 'npu' ? sanitizeDevices(parsed.devices) : undefined;
    return {
      createdAtMs: typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs)
        ? parsed.createdAtMs
        : Date.now(),
      modelId: parsed.modelId,
      contextSize: Number.isFinite(parsed.contextSize) ? Math.max(0, Math.round(parsed.contextSize)) : contextSize,
      kvCacheType: typeof parsed.kvCacheType === 'string' ? parsed.kvCacheType : kvCacheType,
      modelFileSizeBytes: typeof parsed.modelFileSizeBytes === 'number' && Number.isFinite(parsed.modelFileSizeBytes)
        ? Math.round(parsed.modelFileSizeBytes)
        : parsed.modelFileSizeBytes ?? null,
      modelSha256: typeof parsed.modelSha256 === 'string' ? parsed.modelSha256 : parsed.modelSha256 ?? null,
      nativeModuleVersion: typeof parsed.nativeModuleVersion === 'string' ? parsed.nativeModuleVersion : expectedNativeModuleVersion,
      backendMode: parsed.backendMode,
      nGpuLayers: Math.max(0, Math.round(parsed.nGpuLayers)),
      ...(devices ? { devices } : null),
    };
  } catch (error) {
    console.warn('[InferenceLastGoodProfileStore] Corrupted last-good payload, clearing.', error);
    getLastGoodStorage().remove(key);
    return null;
  }
}

export function writeLastGoodInferenceProfile(profile: LastGoodInferenceProfile): void {
  const key = buildLastGoodKey({
    modelId: profile.modelId,
    contextSize: profile.contextSize,
    kvCacheType: profile.kvCacheType,
  });

  const normalizedModelId = typeof profile.modelId === 'string' ? profile.modelId.trim() : '';
  const normalizedBackendMode: LastGoodBackendMode = profile.backendMode === 'gpu' || profile.backendMode === 'npu'
    ? profile.backendMode
    : 'cpu';
  const normalizedGpuLayers = Math.max(0, Math.round(profile.nGpuLayers));
  const devices = normalizedBackendMode === 'npu' ? sanitizeDevices(profile.devices) : undefined;

  const persistable: LastGoodInferenceProfile = {
    createdAtMs: typeof profile.createdAtMs === 'number' && Number.isFinite(profile.createdAtMs)
      ? profile.createdAtMs
      : Date.now(),
    modelId: normalizedModelId,
    contextSize: Number.isFinite(profile.contextSize) ? Math.max(0, Math.round(profile.contextSize)) : 0,
    kvCacheType: typeof profile.kvCacheType === 'string' ? profile.kvCacheType.trim().toLowerCase() : 'auto',
    modelFileSizeBytes: typeof profile.modelFileSizeBytes === 'number' && Number.isFinite(profile.modelFileSizeBytes)
      ? Math.round(profile.modelFileSizeBytes)
      : profile.modelFileSizeBytes ?? null,
    modelSha256: typeof profile.modelSha256 === 'string' ? profile.modelSha256.trim().toLowerCase() : profile.modelSha256 ?? null,
    nativeModuleVersion: profile.nativeModuleVersion ?? getCurrentNativeModuleVersion(),
    backendMode: normalizedBackendMode,
    nGpuLayers: normalizedBackendMode === 'cpu' ? 0 : normalizedGpuLayers,
    ...(devices ? { devices } : null),
  };

  getLastGoodStorage().set(key, JSON.stringify(persistable));
}

export function clearLastGoodInferenceProfile({
  modelId,
  contextSize,
  kvCacheType,
}: {
  modelId: string;
  contextSize: number;
  kvCacheType: string;
}): void {
  const key = buildLastGoodKey({ modelId, contextSize, kvCacheType });
  getLastGoodStorage().remove(key);
}

export function readModelInitFailureBound(
  identity: ModelInitFailureBoundIdentity,
  maxAgeMs = DEFAULT_MODEL_INIT_FAILURE_BOUND_MAX_AGE_MS,
): ModelInitFailureBound | null {
  const identityKey = buildModelInitFailureBoundIdentityKey(identity);
  const storageKey = buildModelInitFailureBoundStorageKey(identityKey);
  const raw = getLastGoodStorage().getString(storageKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedModelInitFailureBound>;
    const createdAtMs = normalizeIdentityInteger(parsed.createdAtMs);
    const oomUpperBoundGpuLayers = normalizeIdentityInteger(parsed.oomUpperBoundGpuLayers);
    if (
      parsed.schemaVersion !== 1
      || parsed.identityKey !== identityKey
      || createdAtMs === null
      || oomUpperBoundGpuLayers === null
    ) {
      if (parsed.identityKey === identityKey) {
        removeFailureBoundKey(storageKey);
      }
      return null;
    }

    const nowMs = Date.now();
    const isExpired = typeof maxAgeMs === 'number'
      && Number.isFinite(maxAgeMs)
      && maxAgeMs > 0
      && nowMs - createdAtMs > maxAgeMs;
    const isFromFuture = createdAtMs - nowMs > MAX_MODEL_INIT_FAILURE_BOUND_FUTURE_SKEW_MS;
    if (isExpired || isFromFuture) {
      removeFailureBoundKey(storageKey);
      return null;
    }

    return {
      createdAtMs,
      oomUpperBoundGpuLayers,
    };
  } catch {
    removeFailureBoundKey(storageKey);
    return null;
  }
}

export function recordModelInitFailureBound(
  identity: ModelInitFailureBoundIdentity,
  oomUpperBoundGpuLayers: number,
): ModelInitFailureBound | null {
  const normalizedUpperBound = normalizeIdentityInteger(oomUpperBoundGpuLayers);
  if (normalizedUpperBound === null) {
    return null;
  }

  const nowMs = Date.now();
  const current = readModelInitFailureBound(identity);
  const next: ModelInitFailureBound = {
    createdAtMs: nowMs,
    oomUpperBoundGpuLayers: current
      ? Math.min(current.oomUpperBoundGpuLayers, normalizedUpperBound)
      : normalizedUpperBound,
  };
  const identityKey = buildModelInitFailureBoundIdentityKey(identity);
  const storageKey = buildModelInitFailureBoundStorageKey(identityKey);
  const persisted: PersistedModelInitFailureBound = {
    schemaVersion: 1,
    identityKey,
    ...next,
  };

  getLastGoodStorage().set(storageKey, JSON.stringify(persisted));
  pruneModelInitFailureBounds(nowMs);
  return next;
}

export function reconcileModelInitFailureBoundSuccess(
  identity: ModelInitFailureBoundIdentity,
  successfulGpuLayers: number,
): boolean {
  const normalizedLayers = normalizeIdentityInteger(successfulGpuLayers);
  if (normalizedLayers === null) {
    return false;
  }

  const current = readModelInitFailureBound(identity);
  if (!current || normalizedLayers < current.oomUpperBoundGpuLayers) {
    return false;
  }

  const identityKey = buildModelInitFailureBoundIdentityKey(identity);
  getLastGoodStorage().remove(buildModelInitFailureBoundStorageKey(identityKey));
  return true;
}
