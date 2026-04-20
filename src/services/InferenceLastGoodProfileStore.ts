import type { MMKV } from 'react-native-mmkv';
import llamaPackageJson from 'llama.rn/package.json';
import { createStorage } from './storage';

const LLAMA_RN_VERSION: string = typeof llamaPackageJson?.version === 'string' ? llamaPackageJson.version : 'unknown';

export const DEFAULT_LAST_GOOD_PROFILE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

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

let lastGoodStorageInstance: MMKV | null = null;

function getLastGoodStorage(): MMKV {
  if (!lastGoodStorageInstance) {
    lastGoodStorageInstance = createStorage('pocket-ai-last-good-profiles', { tier: 'private' });
  }

  return lastGoodStorageInstance;
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
