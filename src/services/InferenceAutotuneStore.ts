import type { MMKV } from 'react-native-mmkv';
import { createStorage } from './storage';

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
  bestStable?: AutotuneBestStableProfile;
  candidates: AutotuneCandidateReport[];
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
}: {
  modelId: string;
  contextSize: number;
  kvCacheType: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
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

    return parsed;
  } catch (error) {
    console.warn('[InferenceAutotuneStore] Corrupted autotune payload, clearing.', error);
    getAutotuneStorage().remove(key);
    return null;
  }
}

export function writeAutotuneResult(result: AutotuneResult): void {
  const key = buildAutotuneKey({
    modelId: result.modelId,
    contextSize: result.contextSize,
    kvCacheType: result.kvCacheType,
  });
  getAutotuneStorage().set(key, JSON.stringify(result));
}

export function readBestStableAutotuneProfile({
  modelId,
  contextSize,
  kvCacheType,
  modelFileSizeBytes,
  modelSha256,
}: {
  modelId: string;
  contextSize: number;
  kvCacheType: string;
  modelFileSizeBytes?: number | null;
  modelSha256?: string | null;
}): AutotuneBestStableProfile | null {
  const result = readAutotuneResult({ modelId, contextSize, kvCacheType, modelFileSizeBytes, modelSha256 });
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
