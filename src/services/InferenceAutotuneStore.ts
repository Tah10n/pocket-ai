import type { MMKV } from 'react-native-mmkv';
import llamaPackageJson from 'llama.rn/package.json';
import { createStorage } from './storage';

const LLAMA_RN_VERSION: string = typeof llamaPackageJson?.version === 'string' ? llamaPackageJson.version : 'unknown';

export const DEFAULT_AUTOTUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getCurrentNativeModuleVersion(): string {
  return LLAMA_RN_VERSION;
}

export type AutotuneBackendMode = 'cpu' | 'gpu' | 'npu';

export type AutotuneBestStableProfile = {
  backendMode: AutotuneBackendMode;
  nGpuLayers: number;
  devices?: string[];
};

export type AutotuneCandidateReport = {
  profile: AutotuneBestStableProfile;
  success: boolean;
  tokensPerSec?: number;
  ttftMs?: number;
  durationMs?: number;
  initGpuLayers?: number;
  initDevices?: string[];
  actualBackendMode?: 'cpu' | 'gpu' | 'npu' | 'unknown';
  actualGpuAccelerated?: boolean;
  loadedGpuLayers?: number;
  reasonNoGPU?: string;
  error?: string;
};

export type AutotuneResult = {
  createdAtMs: number;
  modelId: string;
  contextSize: number;
  kvCacheType: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
  nativeModuleVersion?: string;
  backendDiscoveryKnown?: boolean;
  bestStable?: AutotuneBestStableProfile;
  candidates: AutotuneCandidateReport[];
  restorationError?: string;
  cancelled?: boolean;
};

let autotuneStorageInstance: MMKV | null = null;

function getAutotuneStorage(): MMKV {
  if (!autotuneStorageInstance) {
    autotuneStorageInstance = createStorage('pocket-ai-autotune', { tier: 'private' });
  }

  return autotuneStorageInstance;
}

function buildAutotuneKey({
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
  return `autotune:${normalizedModelId}:${normalizedContext}:${normalizedKv}`;
}

export function readAutotuneResult({
  modelId,
  contextSize,
  kvCacheType,
  modelFileSizeBytes,
  modelSha256,
  expectedNativeModuleVersion = getCurrentNativeModuleVersion(),
  maxAgeMs = DEFAULT_AUTOTUNE_MAX_AGE_MS,
}: {
  modelId: string;
  contextSize: number;
  kvCacheType: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
  expectedNativeModuleVersion?: string;
  maxAgeMs?: number;
}): AutotuneResult | null {
  const key = buildAutotuneKey({ modelId, contextSize, kvCacheType });
  const raw = getAutotuneStorage().getString(key);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as AutotuneResult;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (typeof parsed.modelId !== 'string' || parsed.modelId.trim() !== modelId.trim()) {
      return null;
    }
    if (!Array.isArray(parsed.candidates)) {
      return null;
    }

    const expectedFileSize = typeof modelFileSizeBytes === 'number' && Number.isFinite(modelFileSizeBytes) && modelFileSizeBytes > 0
      ? Math.round(modelFileSizeBytes)
      : null;
    if (expectedFileSize !== null) {
      const storedFileSize = typeof parsed.modelFileSizeBytes === 'number' && Number.isFinite(parsed.modelFileSizeBytes)
        ? Math.round(parsed.modelFileSizeBytes)
        : null;
      if (storedFileSize === null || storedFileSize !== expectedFileSize) {
        return null;
      }
    }

    const expectedSha = typeof modelSha256 === 'string' ? modelSha256.trim().toLowerCase() : '';
    if (expectedSha.length > 0) {
      const storedSha = typeof parsed.modelSha256 === 'string' ? parsed.modelSha256.trim().toLowerCase() : '';
      if (storedSha.length === 0 || storedSha !== expectedSha) {
        return null;
      }
    }

    if (typeof expectedNativeModuleVersion === 'string' && expectedNativeModuleVersion.length > 0) {
      const storedVersion = typeof parsed.nativeModuleVersion === 'string' ? parsed.nativeModuleVersion : '';
      if (storedVersion !== expectedNativeModuleVersion) {
        return null;
      }
    }

    if (typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      const createdAtMs = typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs)
        ? parsed.createdAtMs
        : null;
      if (createdAtMs === null || Date.now() - createdAtMs > maxAgeMs) {
        return null;
      }
    }

    return parsed;
  } catch (error) {
    console.warn('[InferenceAutotuneStore] Corrupted autotune payload, clearing.', error);
    getAutotuneStorage().remove(key);
    return null;
  }
}

export function writeAutotuneResult(result: AutotuneResult): void {
  if (result.cancelled === true) {
    // Cancelled runs should never be persisted.
    return;
  }
  const key = buildAutotuneKey({
    modelId: result.modelId,
    contextSize: result.contextSize,
    kvCacheType: result.kvCacheType,
  });
  // restorationError/cancelled are transient runtime signals, never persisted.
  const { restorationError: _restorationError, cancelled: _cancelled, ...rest } = result;
  const persistable: AutotuneResult = {
    ...rest,
    nativeModuleVersion: result.nativeModuleVersion ?? getCurrentNativeModuleVersion(),
  };
  getAutotuneStorage().set(key, JSON.stringify(persistable));
}

export function readBestStableAutotuneProfile({
  modelId,
  contextSize,
  kvCacheType,
  modelFileSizeBytes,
  modelSha256,
  expectedNativeModuleVersion,
  maxAgeMs,
}: {
  modelId: string;
  contextSize: number;
  kvCacheType: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
  expectedNativeModuleVersion?: string;
  maxAgeMs?: number;
}): AutotuneBestStableProfile | null {
  const result = readAutotuneResult({
    modelId,
    contextSize,
    kvCacheType,
    modelFileSizeBytes,
    modelSha256,
    ...(expectedNativeModuleVersion !== undefined ? { expectedNativeModuleVersion } : {}),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
  });
  const best = result?.bestStable;
  if (!best) {
    return null;
  }
  if (best.backendMode !== 'cpu' && best.backendMode !== 'gpu' && best.backendMode !== 'npu') {
    return null;
  }
  if (!Number.isFinite(best.nGpuLayers) || best.nGpuLayers < 0) {
    return null;
  }
  const devices = Array.isArray(best.devices)
    ? best.devices
        .filter((device): device is string => typeof device === 'string')
        .map((device) => device.trim())
        .filter((device) => device.length > 0)
    : undefined;

  return {
    backendMode: best.backendMode,
    nGpuLayers: Math.max(0, Math.round(best.nGpuLayers)),
    ...(devices && devices.length > 0 ? { devices } : null),
  };
}
