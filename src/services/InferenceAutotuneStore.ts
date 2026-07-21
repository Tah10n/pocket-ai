import type { MMKV } from 'react-native-mmkv';
import llamaPackageJson from 'llama.rn/package.json';
import { assertPrivateStorageWritable, createStorage } from './storage';
import { getPrivacySafeErrorLogDetails, getSafeAppErrorCode } from './AppError';

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

export type AutotuneCandidateProfile = {
  backendMode: AutotuneBackendMode;
  nGpuLayers: number;
  deviceCount?: number;
};

export type AutotuneCandidateReport = {
  profile: AutotuneCandidateProfile;
  success: boolean;
  tokensPerSec?: number;
  ttftMs?: number;
  durationMs?: number;
  initGpuLayers?: number;
  initDeviceCount?: number;
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

const MAX_PUBLIC_DEVICE_COUNT = 10;
const SAFE_AUTOTUNE_FAILURE_CATEGORIES = new Set([
  'attempt_limit',
  'backend_unavailable',
  'cancelled',
  'invalid_configuration',
  'known_oom_upper_bound',
  'model_incompatible',
  'native_error',
  'out_of_memory',
]);
const SAFE_AUTOTUNE_ERROR_TYPES = new Set([
  'AbortError',
  'AggregateError',
  'Cancelled',
  'Error',
  'EvalError',
  'NetworkError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
  'bigint',
  'boolean',
  'function',
  'number',
  'object',
  'operation_failed',
  'string',
  'symbol',
  'undefined',
]);

function toOptionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.max(0, value)
    : undefined;
}

function toOptionalCount(value: unknown): number | undefined {
  const numberValue = toOptionalNonNegativeNumber(value);
  return numberValue === undefined
    ? undefined
    : Math.min(MAX_PUBLIC_DEVICE_COUNT, Math.round(numberValue));
}

function sanitizeAutotuneBackendMode(value: unknown): AutotuneBackendMode | null {
  return value === 'cpu' || value === 'gpu' || value === 'npu' ? value : null;
}

function sanitizeCandidateError(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  if (SAFE_AUTOTUNE_ERROR_TYPES.has(value) || getSafeAppErrorCode(value as never) === value) {
    return value;
  }
  return 'operation_failed';
}

function sanitizeFailureCategory(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return SAFE_AUTOTUNE_FAILURE_CATEGORIES.has(value) ? value : 'native_error';
}

function sanitizeBestStableProfile(value: unknown): AutotuneBestStableProfile | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const backendMode = sanitizeAutotuneBackendMode(source.backendMode);
  const nGpuLayers = toOptionalNonNegativeNumber(source.nGpuLayers);
  if (!backendMode || nGpuLayers === undefined) {
    return undefined;
  }
  const devices = Array.isArray(source.devices)
    ? source.devices
        .filter((device): device is string => typeof device === 'string')
        .map((device) => device.trim())
        .filter((device) => device.length > 0)
        .slice(0, MAX_PUBLIC_DEVICE_COUNT)
    : [];

  return {
    backendMode,
    nGpuLayers: Math.round(nGpuLayers),
    ...(devices.length > 0 ? { devices } : null),
  };
}

function sanitizeCandidateReport(value: unknown): AutotuneCandidateReport | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const source = value as Record<string, unknown>;
  const rawProfile = source.profile && typeof source.profile === 'object'
    ? source.profile as Record<string, unknown>
    : null;
  const backendMode = sanitizeAutotuneBackendMode(rawProfile?.backendMode);
  const nGpuLayers = toOptionalNonNegativeNumber(rawProfile?.nGpuLayers);
  if (!backendMode || nGpuLayers === undefined) {
    return null;
  }
  const requestedDeviceCount = toOptionalCount(rawProfile?.deviceCount)
    ?? (Array.isArray(rawProfile?.devices)
      ? Math.min(rawProfile.devices.length, MAX_PUBLIC_DEVICE_COUNT)
      : undefined);
  const legacyInitDevices = Array.isArray(source.initDevices) ? source.initDevices : null;
  const initDeviceCount = toOptionalCount(source.initDeviceCount)
    ?? (legacyInitDevices ? Math.min(legacyInitDevices.length, MAX_PUBLIC_DEVICE_COUNT) : undefined);
  const actualBackendMode = source.actualBackendMode === 'cpu'
    || source.actualBackendMode === 'gpu'
    || source.actualBackendMode === 'npu'
    || source.actualBackendMode === 'unknown'
    ? source.actualBackendMode
    : undefined;
  const error = sanitizeCandidateError(source.error);
  const reasonNoGPU = sanitizeFailureCategory(source.reasonNoGPU);

  return {
    profile: {
      backendMode,
      nGpuLayers: Math.round(nGpuLayers),
      ...(requestedDeviceCount !== undefined ? { deviceCount: requestedDeviceCount } : null),
    },
    success: source.success === true,
    ...(toOptionalNonNegativeNumber(source.tokensPerSec) !== undefined
      ? { tokensPerSec: toOptionalNonNegativeNumber(source.tokensPerSec) }
      : null),
    ...(toOptionalNonNegativeNumber(source.ttftMs) !== undefined
      ? { ttftMs: toOptionalNonNegativeNumber(source.ttftMs) }
      : null),
    ...(toOptionalNonNegativeNumber(source.durationMs) !== undefined
      ? { durationMs: toOptionalNonNegativeNumber(source.durationMs) }
      : null),
    ...(toOptionalNonNegativeNumber(source.initGpuLayers) !== undefined
      ? { initGpuLayers: Math.round(toOptionalNonNegativeNumber(source.initGpuLayers)!) }
      : null),
    ...(initDeviceCount !== undefined ? { initDeviceCount } : null),
    ...(actualBackendMode ? { actualBackendMode } : null),
    ...(typeof source.actualGpuAccelerated === 'boolean'
      ? { actualGpuAccelerated: source.actualGpuAccelerated }
      : null),
    ...(toOptionalNonNegativeNumber(source.loadedGpuLayers) !== undefined
      ? { loadedGpuLayers: Math.round(toOptionalNonNegativeNumber(source.loadedGpuLayers)!) }
      : null),
    ...(reasonNoGPU ? { reasonNoGPU } : null),
    ...(error ? { error } : null),
  };
}

function sanitizeAutotuneResult(value: AutotuneResult): AutotuneResult {
  const bestStable = sanitizeBestStableProfile(value.bestStable);
  return {
    createdAtMs: toOptionalNonNegativeNumber(value.createdAtMs) ?? 0,
    modelId: typeof value.modelId === 'string' ? value.modelId : '',
    contextSize: Math.round(toOptionalNonNegativeNumber(value.contextSize) ?? 0),
    kvCacheType: typeof value.kvCacheType === 'string' ? value.kvCacheType : 'auto',
    ...(toOptionalNonNegativeNumber(value.modelFileSizeBytes) !== undefined
      ? { modelFileSizeBytes: Math.round(toOptionalNonNegativeNumber(value.modelFileSizeBytes)!) }
      : null),
    ...(typeof value.modelSha256 === 'string' ? { modelSha256: value.modelSha256 } : null),
    ...(typeof value.nativeModuleVersion === 'string'
      ? { nativeModuleVersion: value.nativeModuleVersion }
      : null),
    ...(typeof value.backendDiscoveryKnown === 'boolean'
      ? { backendDiscoveryKnown: value.backendDiscoveryKnown }
      : null),
    ...(bestStable ? { bestStable } : null),
    candidates: value.candidates
      .map(sanitizeCandidateReport)
      .filter((candidate): candidate is AutotuneCandidateReport => candidate !== null),
  };
}

export function invalidateAutotuneStorageForPrivateReset(): void {
  autotuneStorageInstance = null;
}

function getAutotuneStorage(): MMKV {
  if (autotuneStorageInstance) {
    assertPrivateStorageWritable();
    return autotuneStorageInstance;
  }

  const created = createStorage('pocket-ai-autotune', { tier: 'private' });
  autotuneStorageInstance = created;
  return created;
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

    return sanitizeAutotuneResult(parsed);
  } catch (error) {
    console.warn(
      '[InferenceAutotuneStore] Corrupted autotune payload, clearing.',
      getPrivacySafeErrorLogDetails(error),
    );
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
  const persistable = sanitizeAutotuneResult({
    ...rest,
    nativeModuleVersion: result.nativeModuleVersion ?? getCurrentNativeModuleVersion(),
  });
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
