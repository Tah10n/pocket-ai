import type {
  LlamaContext,
  NativeBackendDeviceInfo,
  NativeCompletionResult,
  TokenData,
} from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { Platform } from 'react-native';
import { hardwareListenerService } from './HardwareListenerService';
import {
  EngineBackendMode,
  type EngineBackendInitAttempt,
  type EngineBackendPolicy,
  EngineStatus,
  EngineState,
  type ModelMemoryFitConfidence,
  type ModelMetadata,
} from '../types/models';
import { LlmChatCompletionOptions, LlmChatMessage } from '../types/chat';
import { registry } from './LocalStorageRegistry';
import { getModelsDir } from './FileSystemSetup';
import { safeJoinModelPath } from '../utils/safeFilePath';
import {
  getModelLoadParametersForModel,
  type ModelLoadParameters,
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
  updateSettings,
} from './SettingsStore';
import { AppError, toAppError } from './AppError';
import { getFreshMemorySnapshot, type SystemMemorySnapshot } from './SystemMetricsService';
import {
  clampContextWindowTokens,
  CONTEXT_WINDOW_STEP_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  resolveContextWindowCeiling,
} from '../utils/contextWindow';
import {
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
} from '../memory/budget';
import { estimateAccurateMemoryFit } from '../memory/estimator';
import type { MemoryFitResult, MemoryMetadataTrust } from '../memory/types';
import {
  applyFailedCalibrationObservation,
  applySuccessfulCalibrationObservation,
  createCalibrationKey,
  createEmptyCalibrationRecord,
  serializeCalibrationKey,
} from '../memory/calibration';
import { DECIMAL_GIGABYTE } from '../utils/modelSize';
import { isHighConfidenceLikelyOomMemoryFit } from '../utils/modelMemoryFitState';
import {
  resolveModelCapabilitySnapshot,
  resolveModelLayerCountFromGgufMetadata,
} from '../utils/modelCapabilities';
import { resolveKvCacheTypes } from '../utils/kvCache';
import { requireLlamaModule } from './llamaRnModule';
import { inferenceBackendService } from './InferenceBackendService';
import { resolveInferenceProfileCandidates, type ResolvedInferenceProfile } from './resolveInferenceProfile';
import { readBestStableAutotuneProfile } from './InferenceAutotuneStore';

export interface LoadModelOptions {
  forceReload?: boolean;
  allowUnsafeMemoryLoad?: boolean;
  loadParamsOverride?: Partial<ModelLoadParameters>;
}

export type BackendAvailability = {
  gpuBackendAvailable: boolean | null;
  npuBackendAvailable: boolean | null;
  discoveryUnavailable: boolean;
  devices: NativeBackendDeviceInfo[];
};

type StateListener = (state: EngineState) => void;
const DEFAULT_CONTEXT_SIZE = 4096;
const MAX_NATIVE_LOG_LINES = 120;

type CalibrationSession = {
  modelId: string;
  calibrationKey: string;
  predictedFit: MemoryFitResult | null;
  observedRawBudgetBytes: number | null;
  beforeLoadSnapshot: SystemMemorySnapshot | null;
  afterModelInitSnapshot: SystemMemorySnapshot | null;
  afterFirstTokenSnapshot: SystemMemorySnapshot | null;
  afterUnloadSnapshot: SystemMemorySnapshot | null;
  didRecordSuccess: boolean;
};

function getErrorMessageText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return '';
}

function isConversationAlternationError(error: unknown): boolean {
  const message = getErrorMessageText(error);
  return /Conversation roles must alternate user\/assistant/i.test(message);
}

function isProbableMemoryFailure(error: unknown): boolean {
  const message = getErrorMessageText(error).toLowerCase();
  if (message.length === 0) {
    return false;
  }

  return (
    message.includes('out of memory')
    || message.includes('oom')
    || message.includes('not enough memory')
    || message.includes('insufficient memory')
    || message.includes('bad alloc')
    || message.includes('cannot allocate memory')
    || message.includes('malloc')
    || message.includes('std::bad_alloc')
    || message.includes('failed to allocate')
  );
}

function shouldHardBlockSafeLoad({
  memoryFit,
  availableBudgetBytes,
  lowMemorySignal,
}: {
  memoryFit: MemoryFitResult | null | undefined;
  availableBudgetBytes: number | null;
  lowMemorySignal: boolean;
}): boolean {
  if (!memoryFit) {
    return false;
  }

  if (!Number.isFinite(memoryFit.requiredBytes) || memoryFit.requiredBytes <= 0) {
    return false;
  }

  if (!Number.isFinite(memoryFit.budget.totalMemoryBytes) || memoryFit.budget.totalMemoryBytes <= 0) {
    return false;
  }

  if (memoryFit.decision !== 'likely_oom') {
    return false;
  }

  if (memoryFit.confidence === 'high') {
    return true;
  }

  if (lowMemorySignal) {
    return true;
  }

  if (!Number.isFinite(availableBudgetBytes) || availableBudgetBytes === null || availableBudgetBytes <= 0) {
    return false;
  }

  return memoryFit.requiredBytes >= availableBudgetBytes;
}

function canAutoUseSafeLoadProfile({
  memoryFit,
  availableBudgetBytes,
  lowMemorySignal,
}: {
  memoryFit: MemoryFitResult | null | undefined;
  availableBudgetBytes: number | null;
  lowMemorySignal: boolean;
}): boolean {
  if (!memoryFit) {
    return false;
  }

  if (lowMemorySignal) {
    return false;
  }

  if (!Number.isFinite(memoryFit.requiredBytes) || memoryFit.requiredBytes <= 0) {
    return false;
  }

  if (!Number.isFinite(availableBudgetBytes) || availableBudgetBytes === null || availableBudgetBytes <= 0) {
    return false;
  }

  return memoryFit.requiredBytes <= availableBudgetBytes;
}

function getModelInfoString(modelInfo: unknown, key: string): string | null {
  if (!modelInfo || typeof modelInfo !== 'object') {
    return null;
  }

  const value = (modelInfo as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : null;
}

function toFinitePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function readNumericMetadata(metadata: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!metadata) {
    return null;
  }

  for (const key of keys) {
    const value = toFinitePositiveNumber(metadata[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function normalizeArchitecturePrefix(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function resolveGgufArchitecturePrefixes(ggufMetadata?: Record<string, unknown>): string[] {
  if (!ggufMetadata) {
    return [];
  }

  const direct = normalizeArchitecturePrefix(ggufMetadata.architecture);
  const general = normalizeArchitecturePrefix(ggufMetadata['general.architecture']);
  const candidate = direct ?? general;
  if (!candidate) {
    return [];
  }

  const prefixes = new Set<string>();
  prefixes.add(candidate);
  const stripped = candidate.replace(/\d+$/u, '');
  if (stripped.length > 0) {
    prefixes.add(stripped);
  }

  return Array.from(prefixes);
}

function withPrefixes(prefixes: string[], suffixes: string[]): string[] {
  if (prefixes.length === 0 || suffixes.length === 0) {
    return [];
  }

  const keys: string[] = [];
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      keys.push(`${prefix}.${suffix}`);
    }
  }
  return keys;
}

function resolveDerivedHeadDim({
  ggufMetadata,
  prefixes,
}: {
  ggufMetadata: Record<string, unknown> | undefined;
  prefixes: string[];
}): number | null {
  const embeddingLength = readNumericMetadata(
    ggufMetadata,
    ['nEmbd', 'n_embd', 'embedding_length', ...withPrefixes(prefixes, ['embedding_length'])],
  );
  const headCount = readNumericMetadata(
    ggufMetadata,
    ['nHead', 'n_head', 'attention.head_count', ...withPrefixes(prefixes, ['attention.head_count'])],
  );

  if (!embeddingLength || !headCount || embeddingLength <= 0 || headCount <= 0) {
    return null;
  }

  const raw = embeddingLength / headCount;
  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }

  const rounded = Math.round(raw);
  if (rounded <= 0) {
    return null;
  }

  // Require near-integer to avoid wildly incorrect derivations.
  if (Math.abs(rounded - raw) > 1e-3) {
    return null;
  }

  return rounded;
}

function resolveKvCacheHeadDims(ggufMetadata?: Record<string, unknown>): { headDimK: number | null; headDimV: number | null } {
  const prefixes = resolveGgufArchitecturePrefixes(ggufMetadata);

  const headDimK = readNumericMetadata(
    ggufMetadata,
    [
      'nEmbdHeadK',
      'n_embd_head_k',
      'attention.key_length',
      ...withPrefixes(prefixes, ['attention.key_length']),
    ],
  ) ?? resolveDerivedHeadDim({ ggufMetadata, prefixes });

  const headDimV = readNumericMetadata(
    ggufMetadata,
    [
      'nEmbdHeadV',
      'n_embd_head_v',
      'attention.value_length',
      ...withPrefixes(prefixes, ['attention.value_length']),
    ],
  ) ?? headDimK;

  return {
    headDimK: headDimK && headDimK > 0 ? Math.round(headDimK) : null,
    headDimV: headDimV && headDimV > 0 ? Math.round(headDimV) : null,
  };
}

function mergeConsecutiveMessages(messages: LlmChatMessage[]): LlmChatMessage[] {
  const merged: LlmChatMessage[] = [];

  for (const message of messages) {
    if (merged.length === 0) {
      merged.push({ ...message });
      continue;
    }

    const lastMessage = merged[merged.length - 1];
    if (lastMessage.role === message.role) {
      merged[merged.length - 1] = {
        role: lastMessage.role,
        content: `${lastMessage.content}\n\n${message.content}`,
      };
      continue;
    }

    merged.push({ ...message });
  }

  return merged;
}

function normalizeMessagesForStrictRoleAlternation(messages: LlmChatMessage[]): LlmChatMessage[] {
  const systemParts: string[] = [];
  const nonSystemMessages: LlmChatMessage[] = [];

  for (const message of messages) {
    const content = message.content ?? '';
    if (content.trim().length === 0) {
      continue;
    }

    if (message.role === 'system') {
      systemParts.push(content);
      continue;
    }

    nonSystemMessages.push({ role: message.role, content });
  }

  let merged = mergeConsecutiveMessages(nonSystemMessages);

  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged = merged.slice(1);
  }

  const systemContent = systemParts.join('\n\n');
  const trimmedSystemContent = systemContent.trim();
  if (trimmedSystemContent.length > 0) {
    const sysWrappedRegex = /^\s*<<SYS>>[\s\S]*<<\/SYS>>\s*$/;
    const isAlreadyWrapped = sysWrappedRegex.test(trimmedSystemContent);

    const cleanedSystemContent = isAlreadyWrapped
      ? trimmedSystemContent
      : trimmedSystemContent
          .replace(/<<SYS>>/g, '')
          .replace(/<<\/SYS>>/g, '')
          .trim();

    if (cleanedSystemContent.length === 0) {
      return mergeConsecutiveMessages(merged);
    }

    const normalizedSystemContent = isAlreadyWrapped
      ? cleanedSystemContent
      : `<<SYS>>\n${cleanedSystemContent}\n<</SYS>>`;

    if (merged.length === 0) {
      merged = [{ role: 'user', content: normalizedSystemContent }];
    } else if (merged[0].role === 'user') {
      merged[0] = { role: 'user', content: `${normalizedSystemContent}\n\n${merged[0].content}` };
    } else {
      merged.unshift({ role: 'user', content: normalizedSystemContent });
    }
  }

  return mergeConsecutiveMessages(merged);
}

class LLMEngineService {
  private context: LlamaContext | null = null;
  private activeContextSize = DEFAULT_CONTEXT_SIZE;
  private activeGpuLayers: number | null = null;
  private safeModeLoadLimits: {
    maxContextTokens: number;
    requestedGpuLayers: number;
    loadedGpuLayers: number;
  } | null = null;
  private activeBackendMode: EngineBackendMode = 'unknown';
  private activeBackendDevices: string[] = [];
  private activeBackendReasonNoGpu: string | null = null;
  private activeBackendSystemInfo: string | null = null;
  private activeBackendAndroidLib: string | null = null;
  private requestedGpuLayers: number | null = null;
  private actualGpuAccelerated: boolean | null = null;
  private requestedBackendPolicy: EngineBackendPolicy | null = null;
  private effectiveBackendPolicy: EngineBackendPolicy | null = null;
  private backendPolicyReasons: string[] = [];
  private backendInitAttemptsSnapshot: EngineBackendInitAttempt[] = [];
  private initGpuLayers: number | null = null;
  private initDevices: string[] | null = null;
  private initCacheTypeK: string | null = null;
  private initCacheTypeV: string | null = null;
  private initFlashAttnType: 'auto' | 'on' | 'off' | null = null;
  private initUseMmap: boolean | null = null;
  private initUseMlock: boolean | null = null;
  private initNParallel: number | null = null;
  private initNThreads: number | null = null;
  private initCpuMask: string | null = null;
  private initCpuStrict: boolean | null = null;
  private initNBatch: number | null = null;
  private initNUbatch: number | null = null;
  private initKvUnified: boolean | null = null;
  private state: EngineState = {
    status: EngineStatus.IDLE,
    loadProgress: 0,
    diagnostics: {
      backendMode: 'unknown',
      backendDevices: [],
    },
  };
  private lastModelLoadError: AppError | null = null;
  private lastModelLoadErrorScope: string | null = null;
  private listeners: Set<StateListener> = new Set();
  private hwUnsubscribe?: () => void;
  private initPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private activeCompletionPromise: Promise<NativeCompletionResult> | null = null;
  private isUnloading = false;
  private activeCalibrationSession: CalibrationSession | null = null;

  constructor() {
    this.hwUnsubscribe = hardwareListenerService.subscribe((status) => {
      if (status.isLowMemory && this.context) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[LLMEngine] Low memory warning — unloading model');
        }
        this.unload();
      }
    });
  }

  public async getBackendAvailability(): Promise<BackendAvailability> {
    try {
      // Delegate discovery + caching to InferenceBackendService.
      return await inferenceBackendService.getBackendAvailability();
    } catch {
      return {
        gpuBackendAvailable: null,
        npuBackendAvailable: null,
        discoveryUnavailable: true,
        devices: [],
      };
    }
  }

  /**
   * Determine the number of GPU layers based on device RAM only.
   *
   * This is used as a fallback when we don't have enough metadata to do a
   * model-aware recommendation.
   */
  private suggestGpuLayersFromTotalMemory(totalMemoryBytes: number): number {
    const totalGB = totalMemoryBytes / DECIMAL_GIGABYTE;

    if (totalGB >= 12) return 35;
    if (totalGB >= 8) return 20;
    if (totalGB >= 6) return 10;
    return 0;
  }

  private suggestGpuLayersForModel({
    totalMemoryBytes,
    systemMemorySnapshot,
    modelSizeBytes,
    ggufMetadata,
  }: {
    totalMemoryBytes: number | null;
    systemMemorySnapshot: SystemMemorySnapshot | null;
    modelSizeBytes: number | null;
    ggufMetadata?: Record<string, unknown>;
  }): number {
    const fallback = typeof totalMemoryBytes === 'number' && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
      ? this.suggestGpuLayersFromTotalMemory(totalMemoryBytes)
      : 0;
    const nLayers = resolveModelLayerCountFromGgufMetadata(ggufMetadata);
    const normalizedFallback = nLayers ? Math.min(fallback, nLayers) : fallback;

    if (!nLayers) {
      return normalizedFallback;
    }

    const normalizedModelSizeBytes = typeof modelSizeBytes === 'number' && Number.isFinite(modelSizeBytes) && modelSizeBytes > 0
      ? modelSizeBytes
      : null;
    if (normalizedModelSizeBytes === null) {
      return normalizedFallback;
    }

    const observedRawBudgetBytes = this.resolveObservedRawBudgetBytes(systemMemorySnapshot)
      ?? (typeof totalMemoryBytes === 'number' && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
        ? Math.floor(totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO)
        : null);

    if (observedRawBudgetBytes === null || observedRawBudgetBytes <= 0) {
      return normalizedFallback;
    }

    const bytesPerLayer = normalizedModelSizeBytes / nLayers;
    if (!Number.isFinite(bytesPerLayer) || bytesPerLayer <= 0) {
      return normalizedFallback;
    }

    // GPU offload typically requires additional resident buffers (and on some backends
    // effectively duplicates a portion of the weights). Keep headroom for KV cache
    // + runtime buffers by budgeting only a fraction of the observed allocatable memory.
    const offloadBudgetBytes = Math.floor(observedRawBudgetBytes * 0.5);
    if (!Number.isFinite(offloadBudgetBytes) || offloadBudgetBytes <= 0) {
      return normalizedFallback;
    }

    const maxLayersByBudget = Math.floor(offloadBudgetBytes / bytesPerLayer);
    const suggested = Math.max(0, Math.min(Math.round(maxLayersByBudget), nLayers));

    return suggested;
  }

  private resolveRecommendedLoadProfile({
    totalMemoryBytes,
    systemMemorySnapshot,
    modelSizeBytes,
    ggufMetadata,
    modelLayerCount,
    gpuLayersCeilingOverride,
  }: {
    totalMemoryBytes: number | null;
    systemMemorySnapshot: SystemMemorySnapshot | null;
    modelSizeBytes: number | null;
    ggufMetadata?: Record<string, unknown>;
    modelLayerCount?: number | null;
    gpuLayersCeilingOverride?: number | null;
  }): { recommendedGpuLayers: number; gpuLayersCeiling: number; modelLayerCount: number | null } {
    const resolvedModelLayerCount = typeof modelLayerCount === 'number'
      && Number.isFinite(modelLayerCount)
      && modelLayerCount > 0
      ? Math.round(modelLayerCount)
      : resolveModelLayerCountFromGgufMetadata(ggufMetadata);
    const suggestedGpuLayers = this.suggestGpuLayersForModel({
      totalMemoryBytes,
      systemMemorySnapshot,
      modelSizeBytes,
      ggufMetadata,
    });

    const availableBudgetBytes = systemMemorySnapshot ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot) : null;
    const lowMemoryRecommended = availableBudgetBytes !== null && availableBudgetBytes < 1.5 * 1024 * 1024 * 1024
      ? Math.min(suggestedGpuLayers, 10)
      : suggestedGpuLayers;

    const gpuLayersCeiling = typeof gpuLayersCeilingOverride === 'number'
      && Number.isFinite(gpuLayersCeilingOverride)
      && gpuLayersCeilingOverride >= 0
      ? Math.max(0, Math.round(gpuLayersCeilingOverride))
      : resolvedModelLayerCount ?? UNKNOWN_MODEL_GPU_LAYERS_CEILING;
    return {
      recommendedGpuLayers: Math.max(0, Math.min(Math.round(lowMemoryRecommended), gpuLayersCeiling)),
      gpuLayersCeiling,
      modelLayerCount: resolvedModelLayerCount,
    };
  }

  private resolveCalibrationDeviceModel(): string {
    try {
      const deviceId = DeviceInfo.getDeviceId();
      const normalized = typeof deviceId === 'string' ? deviceId.trim() : '';
      return normalized.length > 0 ? normalized : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private resolveCalibrationOsMajor(): string {
    try {
      const version = DeviceInfo.getSystemVersion();
      const normalized = typeof version === 'string' ? version.trim() : '';
      const major = normalized.split('.')[0]?.trim() ?? '';
      const majorKey = major.length > 0 ? major : normalized.length > 0 ? normalized : 'unknown';
      const os = Platform.OS === 'android'
        ? 'android'
        : Platform.OS === 'ios'
          ? 'ios'
          : Platform.OS;
      return `${os}:${majorKey}`;
    } catch {
      const os = Platform.OS === 'android'
        ? 'android'
        : Platform.OS === 'ios'
          ? 'ios'
          : Platform.OS;
      return `${os}:unknown`;
    }
  }

  private resolveObservedRawBudgetBytes(snapshot: SystemMemorySnapshot | null): number | null {
    if (!snapshot) {
      return null;
    }

    const totalBytes = typeof snapshot.totalBytes === 'number' && Number.isFinite(snapshot.totalBytes) && snapshot.totalBytes > 0
      ? snapshot.totalBytes
      : 0;
    if (totalBytes <= 0) {
      return null;
    }

    const softTotalBudgetBytes = Math.floor(totalBytes * FITS_IN_RAM_HEADROOM_RATIO);
    const availableBudgetBytes = resolveConservativeAvailableMemoryBudget(snapshot);
    const rawBudgetBytes = Math.min(
      softTotalBudgetBytes,
      availableBudgetBytes === null ? softTotalBudgetBytes : availableBudgetBytes,
    );
    return rawBudgetBytes > 0 ? rawBudgetBytes : null;
  }

  private buildCalibrationKeyString({
    ggufMetadata,
    verifiedFileSizeBytes,
    contextTokens,
    gpuLayers,
    cacheTypeK,
    cacheTypeV,
    useMmap,
    hasMmproj,
    nBatch,
    nUbatch,
  }: {
    ggufMetadata?: Record<string, unknown>;
    verifiedFileSizeBytes: number;
    contextTokens: number;
    gpuLayers: number;
    cacheTypeK: string;
    cacheTypeV: string;
    useMmap: boolean;
    hasMmproj: boolean;
    nBatch?: number;
    nUbatch?: number;
  }): string | null {
    const key = createCalibrationKey({
      deviceModel: this.resolveCalibrationDeviceModel(),
      osMajor: this.resolveCalibrationOsMajor(),
      ggufMetadata,
      verifiedFileSizeBytes,
      contextTokens,
      gpuLayers,
      cacheTypeK,
      cacheTypeV,
      useMmap,
      hasMmproj,
      nBatch,
      nUbatch,
    });
    return key ? serializeCalibrationKey(key) : null;
  }

  private resolveLowMemoryBatchParams(
    contextTokens: number,
    enabled: boolean,
  ): { nBatch: number; nUbatch: number } | null {
    if (!enabled) {
      return null;
    }

    const nBatch = Math.max(32, Math.min(256, contextTokens));
    const nUbatch = Math.max(32, Math.min(128, nBatch));
    return { nBatch, nUbatch };
  }

  private persistHardBlockedMemoryFit(
    modelId: string,
    confidence: ModelMemoryFitConfidence = 'high',
  ): void {
    const model = registry.getModel(modelId);
    if (!model) {
      return;
    }

    if (
      model.fitsInRam === false
      && model.memoryFitDecision === 'likely_oom'
      && model.memoryFitConfidence === confidence
    ) {
      return;
    }

    registry.updateModel({
      ...model,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: confidence,
    });
  }

  private resolveMaxSafeLoadProfile({
    ggufMetadata,
    resolvedModelSizeBytes,
    verifiedFileSizeBytes,
    metadataTrust,
    totalMemoryBytes,
    systemMemorySnapshot,
    contextCeilingTokens,
    gpuLayersCeiling,
    cacheTypeK,
    cacheTypeV,
    useMmap,
  }: {
    ggufMetadata?: Record<string, unknown>;
    resolvedModelSizeBytes: number;
    verifiedFileSizeBytes: number | null;
    metadataTrust: MemoryMetadataTrust;
    totalMemoryBytes: number | null;
    systemMemorySnapshot: SystemMemorySnapshot | null;
    contextCeilingTokens: number;
    gpuLayersCeiling: number;
    cacheTypeK: string;
    cacheTypeV: string;
    useMmap: boolean;
  }): { safeLoadProfile: { contextTokens: number; gpuLayers: number }; safeMemoryFit: MemoryFitResult } {
    const normalizedContextCeiling = clampContextWindowTokens(
      contextCeilingTokens,
      contextCeilingTokens,
    );
    const normalizedGpuCeiling = Math.max(0, Math.round(gpuLayersCeiling));

    const fitCache = new Map<string, MemoryFitResult>();
    const estimateFit = (contextTokens: number, gpuLayers: number): MemoryFitResult => {
      const normalizedContext = clampContextWindowTokens(contextTokens, normalizedContextCeiling);
      const normalizedGpuLayers = Math.max(0, Math.min(normalizedGpuCeiling, Math.round(gpuLayers)));
      const cacheKey = `${normalizedContext}:${normalizedGpuLayers}:${cacheTypeK}:${cacheTypeV}:${useMmap ? 'mmap' : 'nommap'}`;
      const cached = fitCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const lowMemoryBatchParams = this.resolveLowMemoryBatchParams(
        normalizedContext,
        true,
      );
      const calibrationKey = verifiedFileSizeBytes !== null
        ? this.buildCalibrationKeyString({
            ggufMetadata,
            verifiedFileSizeBytes,
            contextTokens: normalizedContext,
            gpuLayers: normalizedGpuLayers,
            cacheTypeK,
            cacheTypeV,
            useMmap,
            hasMmproj: false,
            nBatch: lowMemoryBatchParams?.nBatch,
            nUbatch: lowMemoryBatchParams?.nUbatch,
          })
        : null;
      const calibrationRecord = calibrationKey ? registry.getCalibrationRecord(calibrationKey) : undefined;

      const fit = estimateAccurateMemoryFit({
        input: {
          modelSizeBytes: resolvedModelSizeBytes,
          verifiedFileSizeBytes: verifiedFileSizeBytes ?? undefined,
          metadataTrust,
          ggufMetadata,
          runtimeParams: {
            contextTokens: normalizedContext,
            gpuLayers: normalizedGpuLayers,
            cacheTypeK,
            cacheTypeV,
            useMmap,
          },
          snapshot: systemMemorySnapshot ?? undefined,
          calibrationRecord,
        },
        totalMemoryBytes,
      });

      fitCache.set(cacheKey, fit);
      return fit;
    };

    const fitsBudget = (fit: MemoryFitResult): boolean => {
      if (!Number.isFinite(fit.requiredBytes) || fit.requiredBytes <= 0) {
        return false;
      }
      if (!Number.isFinite(fit.effectiveBudgetBytes) || fit.effectiveBudgetBytes <= 0) {
        return false;
      }
      return fit.requiredBytes <= fit.effectiveBudgetBytes;
    };

    const solveMaxContextForGpuLayers = (gpuLayers: number): number => {
      const minFit = estimateFit(MIN_CONTEXT_WINDOW_TOKENS, gpuLayers);
      if (!fitsBudget(minFit)) {
        return MIN_CONTEXT_WINDOW_TOKENS;
      }

      const maxIndex = Math.floor(
        (normalizedContextCeiling - MIN_CONTEXT_WINDOW_TOKENS) / CONTEXT_WINDOW_STEP_TOKENS,
      );
      let low = 0;
      let high = Math.max(0, maxIndex);
      let bestTokens = MIN_CONTEXT_WINDOW_TOKENS;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidateTokens = MIN_CONTEXT_WINDOW_TOKENS + mid * CONTEXT_WINDOW_STEP_TOKENS;
        const candidateFit = estimateFit(candidateTokens, gpuLayers);

        if (fitsBudget(candidateFit)) {
          bestTokens = candidateTokens;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      return clampContextWindowTokens(bestTokens, normalizedContextCeiling);
    };

    const gpuCandidates = normalizedGpuCeiling > 0 ? [0, normalizedGpuCeiling] : [0];
    let bestContextTokens = MIN_CONTEXT_WINDOW_TOKENS;
    let contextOptimizedGpuLayers = 0;
    for (const gpuLayers of gpuCandidates) {
      const candidateContext = solveMaxContextForGpuLayers(gpuLayers);
      if (
        candidateContext > bestContextTokens
        || (candidateContext === bestContextTokens && gpuLayers > contextOptimizedGpuLayers)
      ) {
        bestContextTokens = candidateContext;
        contextOptimizedGpuLayers = gpuLayers;
      }
    }

    let bestGpuLayers = 0;
    if (normalizedGpuCeiling > 0) {
      for (let gpuLayers = normalizedGpuCeiling; gpuLayers >= 0; gpuLayers -= 1) {
        if (fitsBudget(estimateFit(bestContextTokens, gpuLayers))) {
          bestGpuLayers = gpuLayers;
          break;
        }
      }
    }

    const safeLoadProfile = {
      contextTokens: bestContextTokens,
      gpuLayers: bestGpuLayers,
    };
    const safeMemoryFit = estimateFit(safeLoadProfile.contextTokens, safeLoadProfile.gpuLayers);

    return { safeLoadProfile, safeMemoryFit };
  }

  private persistCalibrationFailure({
    calibrationKey,
    observedRawBudgetBytes,
  }: {
    calibrationKey: string;
    observedRawBudgetBytes: number | null;
  }): void {
    const existing = registry.getCalibrationRecord(calibrationKey) ?? createEmptyCalibrationRecord(calibrationKey);
    const updated = applyFailedCalibrationObservation({
      record: existing,
      observedRawBudgetBytes,
    });
    registry.saveCalibrationRecord(updated);
  }

  private persistCalibrationSuccess({
    calibrationKey,
    predictedFit,
    beforeLoadSnapshot,
    observedSnapshot,
    observedRawBudgetBytes,
  }: {
    calibrationKey: string;
    predictedFit: MemoryFitResult | null;
    beforeLoadSnapshot: SystemMemorySnapshot | null;
    observedSnapshot: SystemMemorySnapshot | null;
    observedRawBudgetBytes: number | null;
  }): void {
    if (!predictedFit) {
      return;
    }

    const deltaCandidate = beforeLoadSnapshot && observedSnapshot
      ? observedSnapshot.appUsedBytes - beforeLoadSnapshot.appUsedBytes
      : null;
    const observedResidentDeltaBytes = typeof deltaCandidate === 'number' && Number.isFinite(deltaCandidate) && deltaCandidate > 0
      ? Math.round(deltaCandidate)
      : null;
    const existing = registry.getCalibrationRecord(calibrationKey) ?? createEmptyCalibrationRecord(calibrationKey);
    const updated = applySuccessfulCalibrationObservation({
      record: existing,
      predictedBreakdown: predictedFit.breakdown,
      observedResidentDeltaBytes,
      observedRawBudgetBytes,
    });
    registry.saveCalibrationRecord(updated);
  }

  private async captureAfterFirstTokenSnapshotIfNeeded(): Promise<void> {
    const activeSession = this.activeCalibrationSession;
    if (!activeSession || activeSession.didRecordSuccess || activeSession.afterFirstTokenSnapshot !== null) {
      return;
    }

    const calibrationKey = activeSession.calibrationKey;
    const modelId = activeSession.modelId;

    const snapshot = await getFreshMemorySnapshot(0).catch(() => null);

    const currentSession = this.activeCalibrationSession;
    if (!currentSession || currentSession.calibrationKey !== calibrationKey || currentSession.modelId !== modelId) {
      return;
    }

    currentSession.afterFirstTokenSnapshot = snapshot;
    currentSession.didRecordSuccess = true;

    this.persistCalibrationSuccess({
      calibrationKey: currentSession.calibrationKey,
      predictedFit: currentSession.predictedFit,
      beforeLoadSnapshot: currentSession.beforeLoadSnapshot,
      observedSnapshot: snapshot,
      observedRawBudgetBytes: currentSession.observedRawBudgetBytes,
    });
  }

  /**
   * Initialize the llama.rn engine and load a GGUF model from disk.
   */
  public async load(modelId: string, options?: LoadModelOptions): Promise<void> {
    await this.runExclusiveOperation(async () => {
      const model = registry.getModel(modelId);
      if (!model || !model.localPath) {
        throw new AppError('model_not_found', `Model ${modelId} not found or not downloaded`, {
          details: { modelId },
        });
      }

      const forceReload = options?.forceReload === true;
      const allowUnsafeMemoryLoad = options?.allowUnsafeMemoryLoad === true;

      if (
        this.state.status === EngineStatus.READY &&
        this.state.activeModelId === modelId &&
        !forceReload
      ) {
        return;
      }

      if (isHighConfidenceLikelyOomMemoryFit(model) && !allowUnsafeMemoryLoad) {
        throw new AppError(
          'model_load_blocked',
          'Loading is disabled for this model because it is marked as "Won\'t fit RAM".',
          {
            details: {
              modelId,
              memoryFitDecision: model.memoryFitDecision,
              memoryFitConfidence: model.memoryFitConfidence,
              fitsInRam: model.fitsInRam,
              allowUnsafeMemoryLoad,
              forceReload,
            },
          },
        );
      }

      if (this.state.activeModelId && (this.state.activeModelId !== modelId || forceReload)) {
        await this.unloadInternal();
      }

      this.initPromise = this.initializeModel(
        modelId,
        model.localPath,
        model.maxContextTokens,
        model.size ?? null,
        allowUnsafeMemoryLoad,
        options?.loadParamsOverride,
      );
      await this.initPromise;
    });
  }

  public async unload(): Promise<void> {
    await this.runExclusiveOperation(async () => {
      await this.unloadInternal();
    });
  }

  public async chatCompletion({
    messages,
    onToken,
    params,
  }: LlmChatCompletionOptions): Promise<NativeCompletionResult> {
    if (this.state.status === EngineStatus.INITIALIZING && this.initPromise) {
      await this.initPromise;
    }

    if (this.isUnloading) {
      throw new AppError('engine_unloading', 'The model engine is unloading. Please wait a moment.');
    }

    if (this.activeCompletionPromise) {
      throw new AppError('engine_busy', 'A response is already being generated.');
    }

    if (!this.context || this.state.status !== EngineStatus.READY) {
      throw new AppError('engine_not_ready', 'Engine not ready');
    }

    let hasStreamedTokens = false;
    const markTokensStreamed = () => {
      if (!hasStreamedTokens) {
        void this.captureAfterFirstTokenSnapshotIfNeeded();
      }
      hasStreamedTokens = true;
    };

    const runCompletion = async (completionMessages: LlmChatMessage[], onTokensStreamed: () => void) => {
      const baseStopWords = [
        '</s>',
        '<|end|>',
        '<|eot_id|>',
        '<|end_of_text|>',
        '<|im_end|>',
        '<|EOT|>',
        '<|END_OF_TURN_TOKEN|>',
        '<|end_of_turn|>',
        '<|endoftext|>',
      ];

      const resolvedStops = Array.from(
        new Set(baseStopWords.map((stop) => stop.trim()).filter((stop) => stop.length > 0)),
      );

      const completionPromise = this.context!.completion(
        {
          messages: completionMessages,
          n_predict: params?.n_predict ?? 512,
          temperature: params?.temperature ?? 0.7,
          top_p: params?.top_p ?? 0.9,
          top_k: params?.top_k ?? 40,
          min_p: params?.min_p ?? 0.05,
          penalty_repeat: params?.penalty_repeat ?? 1,
          seed: params?.seed ?? undefined,
          enable_thinking: params?.enable_thinking ?? false,
          reasoning_format: params?.reasoning_format ?? 'none',
          stop: resolvedStops,
        },
        (data: TokenData) => {
          if (data.token || data.content !== undefined || data.reasoning_content !== undefined) {
            onTokensStreamed();
            onToken?.({
              token: data.token ?? '',
              content: data.content,
              reasoningContent: data.reasoning_content,
              accumulatedText: data.accumulated_text,
            });
          }
        },
      );

      this.activeCompletionPromise = completionPromise;

      try {
        return await completionPromise;
      } finally {
        if (this.activeCompletionPromise === completionPromise) {
          this.activeCompletionPromise = null;
        }
      }
    };

    try {
      hasStreamedTokens = false;
      return await runCompletion(messages, markTokensStreamed);
    } catch (error) {
      if (isConversationAlternationError(error)) {
        if (hasStreamedTokens && onToken) {
          console.warn(
            '[LLMEngine] Conversation alternation error after streaming started; skipping retry to avoid duplicate output',
          );
          throw error;
        }

        console.warn('[LLMEngine] Retrying completion after normalizing chat roles for strict templates');
        const normalizedMessages = normalizeMessagesForStrictRoleAlternation(messages);
        hasStreamedTokens = false;
        return await runCompletion(normalizedMessages, markTokensStreamed);
      }

      throw error;
    }
  }

  public async countPromptTokens({
    messages,
    params,
  }: {
    messages: LlmChatMessage[];
    params?: {
      enable_thinking?: boolean;
      reasoning_format?: 'none' | 'auto' | 'deepseek';
      add_generation_prompt?: boolean;
    };
  }): Promise<number> {
    if (this.state.status === EngineStatus.INITIALIZING && this.initPromise) {
      await this.initPromise;
    }

    if (this.isUnloading) {
      throw new AppError('engine_unloading', 'The model engine is unloading. Please wait a moment.');
    }

    if (this.activeCompletionPromise) {
      throw new AppError('engine_busy', 'A response is already being generated.');
    }

    if (!this.context || this.state.status !== EngineStatus.READY) {
      throw new AppError('engine_not_ready', 'Engine not ready');
    }

    const countTokens = async (promptMessages: LlmChatMessage[]) => {
      const formatted = await this.context!.getFormattedChat(promptMessages as any, null, {
        enable_thinking: params?.enable_thinking ?? false,
        reasoning_format: params?.reasoning_format ?? 'none',
        add_generation_prompt: params?.add_generation_prompt,
      });

      const tokenized = await this.context!.tokenize(
        formatted.prompt,
        formatted.media_paths ? { media_paths: formatted.media_paths } : undefined,
      );

      return tokenized.tokens.length;
    };

    try {
      return await countTokens(messages);
    } catch (error) {
      if (isConversationAlternationError(error)) {
        console.warn('[LLMEngine] Retrying prompt token count after normalizing chat roles for strict templates');
        const normalizedMessages = normalizeMessagesForStrictRoleAlternation(messages);
        return await countTokens(normalizedMessages);
      }

      throw error;
    }
  }

  public async stopCompletion(): Promise<void> {
    if (this.context) {
      await this.context.stopCompletion();
    }
  }

  public async interruptActiveCompletion(): Promise<void> {
    const activeCompletion = this.activeCompletionPromise;
    if (!activeCompletion) {
      return;
    }

    try {
      await this.stopCompletion();
    } catch (error) {
      console.warn('[LLMEngine] Failed to interrupt active completion', error);
    }

    try {
      await activeCompletion;
    } catch {
      // Completion failures are handled by the chat flow that initiated them.
    }
  }

  public hasActiveCompletion(): boolean {
    return this.activeCompletionPromise != null;
  }

  public getState(): EngineState {
    return this.state;
  }

  public getContextSize(): number {
    return this.activeContextSize;
  }

  public getLoadedGpuLayers(): number | null {
    return this.activeGpuLayers;
  }

  public getSafeModeLoadLimits(): {
    maxContextTokens: number;
    requestedGpuLayers: number;
    loadedGpuLayers: number;
  } | null {
    return this.safeModeLoadLimits ? { ...this.safeModeLoadLimits } : null;
  }

  public ensurePersistedCapabilitySnapshot(model: ModelMetadata | undefined): {
    modelLayerCount: number | null;
    gpuLayersCeiling: number;
  } | null {
    if (!model) {
      return null;
    }

    const resolvedCapability = resolveModelCapabilitySnapshot(model);
    if (!resolvedCapability.isCurrentPersisted && registry.getModel(model.id)) {
      registry.updateModel({
        ...model,
        capabilitySnapshot: resolvedCapability.snapshot,
      });
    }

    return {
      modelLayerCount: resolvedCapability.snapshot.modelLayerCount,
      gpuLayersCeiling: resolvedCapability.snapshot.gpuLayersCeiling,
    };
  }

  public async getRecommendedLoadProfile(modelId: string | null): Promise<{
    recommendedGpuLayers: number;
    gpuLayersCeiling: number;
    modelLayerCount: number | null;
  }> {
    let totalMemoryBytes: number | null = null;

    try {
      totalMemoryBytes = await DeviceInfo.getTotalMemory();
    } catch (error) {
      console.warn('[LLMEngine] Failed to resolve total device memory for GPU layer recommendation', error);
    }

    const snapshot = await getFreshMemorySnapshot(350).catch(() => null);
    const model = modelId ? registry.getModel(modelId) : undefined;
    const stableCapability = this.ensurePersistedCapabilitySnapshot(model);
    const rawModelSizeBytes = typeof model?.size === 'number' && Number.isFinite(model.size) && model.size > 0
      ? model.size
      : null;
    const verifiedFileSizeBytes = model?.metadataTrust === 'verified_local'
      ? typeof model?.gguf?.totalBytes === 'number' && Number.isFinite(model.gguf.totalBytes) && model.gguf.totalBytes > 0
        ? model.gguf.totalBytes
        : rawModelSizeBytes
      : null;
    const modelSizeBytes = verifiedFileSizeBytes ?? rawModelSizeBytes;

    return this.resolveRecommendedLoadProfile({
      totalMemoryBytes,
      systemMemorySnapshot: snapshot,
      modelSizeBytes,
      ggufMetadata: model?.gguf as unknown as Record<string, unknown> | undefined,
      modelLayerCount: stableCapability?.modelLayerCount,
      gpuLayersCeilingOverride: stableCapability?.gpuLayersCeiling,
    });
  }

  public async getRecommendedGpuLayers(): Promise<number> {
    const { recommendedGpuLayers } = await this.getRecommendedLoadProfile(null);
    return recommendedGpuLayers;
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getLastModelLoadError(): { scope: string; error: AppError } | null {
    if (!this.lastModelLoadError || !this.lastModelLoadErrorScope) {
      return null;
    }

    return { scope: this.lastModelLoadErrorScope, error: this.lastModelLoadError };
  }

  public clearLastModelLoadError(): void {
    this.lastModelLoadError = null;
    this.lastModelLoadErrorScope = null;
  }

  private buildDiagnosticsSnapshot(): NonNullable<EngineState['diagnostics']> {
    return {
      backendMode: this.activeBackendMode,
      backendDevices: [...this.activeBackendDevices],
      reasonNoGPU: this.activeBackendReasonNoGpu ?? undefined,
      systemInfo: this.activeBackendSystemInfo ?? undefined,
      androidLib: this.activeBackendAndroidLib ?? undefined,
      requestedGpuLayers: this.requestedGpuLayers ?? undefined,
      loadedGpuLayers: this.activeGpuLayers ?? undefined,
      actualGpuAccelerated: this.actualGpuAccelerated ?? undefined,
      requestedBackendPolicy: this.requestedBackendPolicy ?? undefined,
      effectiveBackendPolicy: this.effectiveBackendPolicy ?? undefined,
      backendPolicyReasons: this.backendPolicyReasons.length > 0 ? [...this.backendPolicyReasons] : undefined,
      backendInitAttempts: this.backendInitAttemptsSnapshot.length > 0
        ? this.backendInitAttemptsSnapshot.map((attempt) => ({
            ...attempt,
            devices: Array.isArray(attempt.devices) ? [...attempt.devices] : undefined,
          }))
        : undefined,
      initGpuLayers: this.initGpuLayers ?? undefined,
      initDevices: Array.isArray(this.initDevices) ? [...this.initDevices] : undefined,
      initCacheTypeK: this.initCacheTypeK ?? undefined,
      initCacheTypeV: this.initCacheTypeV ?? undefined,
      initFlashAttnType: this.initFlashAttnType ?? undefined,
      initUseMmap: this.initUseMmap ?? undefined,
      initUseMlock: this.initUseMlock ?? undefined,
      initNParallel: this.initNParallel ?? undefined,
      initNThreads: this.initNThreads ?? undefined,
      initCpuMask: this.initCpuMask ?? undefined,
      initCpuStrict: this.initCpuStrict ?? undefined,
      initNBatch: this.initNBatch ?? undefined,
      initNUbatch: this.initNUbatch ?? undefined,
      initKvUnified: this.initKvUnified ?? undefined,
    };
  }

  private updateState(newState: EngineState) {
    this.state = {
      ...newState,
      diagnostics: this.buildDiagnosticsSnapshot(),
    };
    this.listeners.forEach((l) => l(this.state));
  }

  private resetBackendTelemetry(): void {
    this.activeBackendMode = 'unknown';
    this.activeBackendDevices = [];
    this.activeBackendReasonNoGpu = null;
    this.activeBackendSystemInfo = null;
    this.activeBackendAndroidLib = null;
    this.actualGpuAccelerated = null;
  }

  private resetRuntimeTelemetry(): void {
    this.resetBackendTelemetry();
    this.requestedGpuLayers = null;
    this.requestedBackendPolicy = null;
    this.effectiveBackendPolicy = null;
    this.backendPolicyReasons = [];
    this.backendInitAttemptsSnapshot = [];
    this.initGpuLayers = null;
    this.initDevices = null;
    this.initCacheTypeK = null;
    this.initCacheTypeV = null;
    this.initFlashAttnType = null;
    this.initUseMmap = null;
    this.initUseMlock = null;
    this.initNParallel = null;
    this.initNThreads = null;
    this.initCpuMask = null;
    this.initCpuStrict = null;
    this.initNBatch = null;
    this.initNUbatch = null;
    this.initKvUnified = null;
  }

  private resolveReportedLoadedGpuLayers(resolvedGpuLayers: number | null): number {
    const normalizedResolvedGpuLayers = typeof resolvedGpuLayers === 'number' && Number.isFinite(resolvedGpuLayers)
      ? Math.max(0, Math.round(resolvedGpuLayers))
      : 0;

    return this.actualGpuAccelerated === true ? normalizedResolvedGpuLayers : 0;
  }

  private resolveBackendMode(context: LlamaContext): EngineBackendMode {
    if (!context.gpu) {
      return 'cpu';
    }

    const devices = Array.isArray(context.devices) ? context.devices : [];
    const deviceText = devices.join(' ').toLowerCase();
    const androidLib = typeof context.androidLib === 'string' ? context.androidLib.toLowerCase() : '';
    const systemInfo = typeof context.systemInfo === 'string' ? context.systemInfo.toLowerCase() : '';

    if (
      devices.some((device) => device.startsWith('HTP'))
      || deviceText.includes('hexagon')
      || deviceText.includes('htp')
      || androidLib.includes('hexagon')
      || androidLib.includes('qnn')
      || systemInfo.includes('hexagon')
      || systemInfo.includes('qnn')
    ) {
      return 'npu';
    }

    return 'gpu';
  }

  private captureBackendTelemetry(context: LlamaContext): void {
    const devices = Array.isArray(context.devices)
      ? context.devices
          .filter((device): device is string => typeof device === 'string')
          .map((device) => device.trim())
          .filter((device) => device.length > 0)
      : [];
    const reasonNoGPU = typeof context.reasonNoGPU === 'string' ? context.reasonNoGPU.trim() : '';
    const systemInfo = typeof context.systemInfo === 'string' ? context.systemInfo.trim() : '';
    const androidLib = typeof context.androidLib === 'string' ? context.androidLib.trim() : '';

    this.activeBackendDevices = devices;
    this.activeBackendReasonNoGpu = reasonNoGPU.length > 0 ? reasonNoGPU : null;
    this.activeBackendSystemInfo = systemInfo.length > 0 ? systemInfo : null;
    this.activeBackendAndroidLib = androidLib.length > 0 ? androidLib : null;
    this.actualGpuAccelerated = Boolean(context.gpu);
    this.activeBackendMode = this.resolveBackendMode(context);
  }

  /**
   * Helper to calculate if model fits in RAM.
   */
  public async fitsInRam(modelSize: number): Promise<MemoryFitResult> {
    let totalMemoryBytes: number | null = null;
    try {
      totalMemoryBytes = await DeviceInfo.getTotalMemory();
    } catch (error) {
      console.warn('[LLMEngine] Failed to resolve total device memory for fit estimate', error);
    }

    // This is a cheap UI-facing estimate: it must never depend on live "available memory" snapshots.
    return estimateAccurateMemoryFit({
      input: {
        modelSizeBytes: modelSize,
        metadataTrust: 'unknown',
        runtimeParams: {},
      },
      totalMemoryBytes,
    });
  }

  private async runExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previousOperation = this.operationQueue;
    let releaseQueue: () => void = () => undefined;

    this.operationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousOperation.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseQueue();
    }
  }

  private async initializeModel(
    modelId: string,
    localPath: string,
    modelMaxContextTokens?: number,
    modelSizeBytes?: number | null,
    allowUnsafeMemoryLoad = false,
    loadParamsOverride?: Partial<ModelLoadParameters>,
  ): Promise<void> {
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    const nativeLogs: { level: string; text: string }[] = [];
    let nativeLogListener: { remove: () => void } | null = null;
    let didEnableNativeLogs = false;
    let initDiagnostics: Record<string, unknown> | null = null;
    let gpuInitError: unknown | null = null;
    let cpuInitError: unknown | null = null;
    let llamaModule: ReturnType<typeof requireLlamaModule> | null = null;
    const shouldBridgeNativeLogs = (
      isDev
      && process.env.NODE_ENV !== 'test'
      && process.env.EXPO_PUBLIC_LLAMA_NATIVE_LOGS === '1'
    );

    try {
      this.lastModelLoadError = null;
      this.lastModelLoadErrorScope = null;
      this.isUnloading = false;
      this.activeCalibrationSession = null;
      this.safeModeLoadLimits = null;
      this.resetRuntimeTelemetry();
      this.updateState({
        status: EngineStatus.INITIALIZING,
        activeModelId: modelId,
        loadProgress: 0,
        lastError: undefined,
      });

      const modelsDir = getModelsDir();
      if (!modelsDir) {
        throw new AppError('action_failed', 'Local file system is unavailable on this platform.', {
          details: { modelId },
        });
      }

      const modelPath = safeJoinModelPath(modelsDir, localPath);
      if (!modelPath) {
        throw new AppError('action_failed', `Invalid model file path for ${modelId}`, {
          details: { modelId },
        });
      }
      const fileInfo = await FileSystem.getInfoAsync(modelPath);
      if (!fileInfo.exists) {
        throw new AppError('download_file_missing', `Model file not found at ${modelPath}`, {
          details: { modelId, modelPath },
        });
      }

      const llama = requireLlamaModule();
      llamaModule = llama;

      const persistedLoadParams = getModelLoadParametersForModel(modelId);
      const loadParams = loadParamsOverride
        ? { ...persistedLoadParams, ...loadParamsOverride }
        : persistedLoadParams;
      const systemMemorySnapshot = await getFreshMemorySnapshot(1500).catch(() => null);
      const observedRawBudgetBytes = this.resolveObservedRawBudgetBytes(systemMemorySnapshot);
      let totalMemoryBytes: number | null = null;
      try {
        totalMemoryBytes = await DeviceInfo.getTotalMemory();
      } catch (error) {
        console.warn('[LLMEngine] Failed to resolve total device memory', error);
      }

      const resolvedTotalMemoryBytes = systemMemorySnapshot?.totalBytes ?? totalMemoryBytes;
      const resolvedModelSizeBytes = typeof fileInfo.size === 'number' ? fileInfo.size : modelSizeBytes ?? null;
      const kvCacheAvailableBudgetBytes = systemMemorySnapshot ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot) : null;
      let { cacheTypeK, cacheTypeV } = resolveKvCacheTypes({
        kvCacheType: loadParams.kvCacheType,
        requestedContextTokens: loadParams.contextSize,
        totalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
          ? resolvedTotalMemoryBytes
          : null,
        availableBudgetBytes: kvCacheAvailableBudgetBytes,
      });

      const resolveEffectiveFlashAttnType = (value: 'auto' | 'on' | 'off', layers: number): 'auto' | 'on' | 'off' => {
        const base = layers > 0 ? value : 'off';
        return cacheTypeV !== 'f16' && base === 'off'
          ? 'auto'
          : base;
      };
      let memoryFit: MemoryFitResult | null = null;
      let safeLoadProfile: { contextTokens: number; gpuLayers: number } | null = null;
      let safeMemoryFit: MemoryFitResult | null = null;
      let exceedsEffectiveBudget = false;
      let availableBudgetBytes: number | null = null;
      let shouldAutoUseSafeLoadProfile = false;

      let modelInfo: Record<string, unknown> | null = null;
      try {
        modelInfo = await llama.loadLlamaModelInfo(modelPath) as Record<string, unknown>;
      } catch (error) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[LLMEngine] Failed to read GGUF metadata', error);
        }
      }

      const ggufArchitecture = getModelInfoString(modelInfo, 'general.architecture')?.toLowerCase() ?? null;
      const ggufType = getModelInfoString(modelInfo, 'general.type')?.toLowerCase() ?? null;
      if (ggufType === 'mmproj' || ggufArchitecture === 'clip') {
        throw new AppError(
          'model_incompatible',
          'CLIP projector models (mmproj) cannot be used as the main model. Download the base language model GGUF instead.',
          {
            details: {
              modelId,
              ggufType,
              ggufArchitecture,
            },
          },
        );
      }

      initDiagnostics = {
        modelId,
        llamaRnBuild: llama.BuildInfo,
        fileSizeBytes: typeof fileInfo.size === 'number' ? fileInfo.size : null,
        totalMemoryBytes: resolvedTotalMemoryBytes,
        hasSystemMemorySnapshot: systemMemorySnapshot !== null,
        lowMemorySignal: systemMemorySnapshot?.lowMemory ?? hardwareListenerService.getCurrentStatus().isLowMemory,
        requestedModelSizeBytes: resolvedModelSizeBytes,
        ggufInfo: {
          architecture: ggufArchitecture,
          type: ggufType,
        },
        loadParams,
      };

      const cachedModel = registry.getModel(modelId);
      const ggufMetadata = modelInfo !== null || cachedModel?.gguf
        ? {
          ...(cachedModel?.gguf ?? {}),
          ...(modelInfo ?? {}),
        }
        : undefined;

      // KV cache quantization is experimental in llama.cpp and can crash llama.rn when the native
      // context fails to initialize (llama.rn currently checks for a loaded model but may
      // dereference a null context pointer). Guard against known init-time incompatibilities.
      //
      // In particular, quantized KV cache types require the per-head key/value dimensions to be
      // divisible by the quantization block size.
      if (cacheTypeK !== 'f16' || cacheTypeV !== 'f16') {
        const { headDimK, headDimV } = resolveKvCacheHeadDims(ggufMetadata as unknown as Record<string, unknown> | undefined);
        const quantBlockSize = 32;
        const missingK = cacheTypeK !== 'f16' && headDimK === null;
        const missingV = cacheTypeV !== 'f16' && headDimV === null;
        const incompatibleK = cacheTypeK !== 'f16' && headDimK !== null && headDimK % quantBlockSize !== 0;
        const incompatibleV = cacheTypeV !== 'f16' && headDimV !== null && headDimV % quantBlockSize !== 0;
        const shouldFallback = missingK || missingV || incompatibleK || incompatibleV;

        if (shouldFallback) {
          const previous = { cacheTypeK, cacheTypeV };
          cacheTypeK = 'f16';
          cacheTypeV = 'f16';

          if (initDiagnostics) {
            initDiagnostics = {
              ...initDiagnostics,
              kvCacheCompatibilityFallback: {
                previous,
                resolved: { cacheTypeK, cacheTypeV },
                headDimK,
                headDimV,
                quantBlockSize,
                missingK,
                missingV,
                incompatibleK,
                incompatibleV,
              },
            };
          }

           if (process.env.NODE_ENV !== 'test') {
             console.warn('[LLMEngine] KV cache quantization is incompatible with this model; falling back to f16', {
               modelId,
               previous,
               resolved: { cacheTypeK, cacheTypeV },
               headDimK,
               headDimV,
               quantBlockSize,
               missingK,
               missingV,
               incompatibleK,
               incompatibleV,
             });
           }
         }
       }
      const verifiedFileSizeBytes = typeof fileInfo.size === 'number' && Number.isFinite(fileInfo.size) && fileInfo.size > 0
        ? Math.round(fileInfo.size)
        : null;
      const stableCapability = cachedModel
        ? this.ensurePersistedCapabilitySnapshot({
          ...cachedModel,
          gguf: ggufMetadata as ModelMetadata['gguf'],
          metadataTrust: modelInfo !== null ? 'verified_local' : cachedModel.metadataTrust,
          size: verifiedFileSizeBytes ?? cachedModel.size,
        })
        : null;
      const { recommendedGpuLayers, gpuLayersCeiling } = this.resolveRecommendedLoadProfile({
        totalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
          ? resolvedTotalMemoryBytes
          : null,
        systemMemorySnapshot,
        modelSizeBytes: verifiedFileSizeBytes ?? resolvedModelSizeBytes,
        ggufMetadata,
        modelLayerCount: stableCapability?.modelLayerCount,
        gpuLayersCeilingOverride: stableCapability?.gpuLayersCeiling,
      });
      const selectedBackendDevices = Array.isArray(loadParams.selectedBackendDevices) && loadParams.selectedBackendDevices.length > 0
        ? loadParams.selectedBackendDevices
        : null;
      const requestedUseMmap = typeof loadParams.useMmap === 'boolean' ? loadParams.useMmap : true;
      const requestedUseMlock = typeof loadParams.useMlock === 'boolean' ? loadParams.useMlock : false;
      const requestedFlashAttention = loadParams.flashAttention === 'on' || loadParams.flashAttention === 'off'
        ? loadParams.flashAttention
        : 'auto';
      const requestedCpuThreads = typeof loadParams.cpuThreads === 'number' && Number.isFinite(loadParams.cpuThreads) && loadParams.cpuThreads > 0
        ? Math.max(1, Math.round(loadParams.cpuThreads))
        : undefined;
      const requestedCpuMask = typeof loadParams.cpuMask === 'string' && loadParams.cpuMask.trim().length > 0
        ? loadParams.cpuMask.trim()
        : undefined;
      const requestedCpuStrict = typeof loadParams.cpuStrict === 'boolean' ? loadParams.cpuStrict : undefined;
      const requestedParallelSlots = typeof loadParams.parallelSlots === 'number' && Number.isFinite(loadParams.parallelSlots) && loadParams.parallelSlots > 0
        ? Math.max(1, Math.round(loadParams.parallelSlots))
        : undefined;
      const requestedKvUnified = typeof loadParams.kvUnified === 'boolean' ? loadParams.kvUnified : undefined;
      const configuredBatchParams = typeof loadParams.nBatch === 'number'
        && Number.isFinite(loadParams.nBatch)
        && loadParams.nBatch > 0
        && typeof loadParams.nUbatch === 'number'
        && Number.isFinite(loadParams.nUbatch)
        && loadParams.nUbatch > 0
        ? {
            nBatch: Math.max(1, Math.round(loadParams.nBatch)),
            nUbatch: Math.max(1, Math.round(loadParams.nUbatch)),
          }
        : null;

      const requestedBackendPolicy = loadParams.backendPolicy;

      const requestedGpuLayersCandidate = requestedBackendPolicy === 'cpu'
        ? 0
        : (
          typeof loadParams.gpuLayers === 'number'
          && Number.isFinite(loadParams.gpuLayers)
          && loadParams.gpuLayers >= 0
        )
          ? Math.round(loadParams.gpuLayers)
          : recommendedGpuLayers;
      const requestedGpuLayers = Math.max(
        0,
        Math.min(gpuLayersCeiling, Math.round(requestedGpuLayersCandidate)),
      );
      const metadataTrustForEstimator = modelInfo !== null
        ? 'verified_local' as const
        : cachedModel?.metadataTrust ?? 'unknown';
      const resolvedContextSize = resolveContextWindowCeiling({
        modelMaxContextTokens,
        totalMemoryBytes: resolvedTotalMemoryBytes,
        appMaxContextTokens: loadParams.contextSize,
        input: {
          modelSizeBytes: resolvedModelSizeBytes,
          verifiedFileSizeBytes: verifiedFileSizeBytes ?? undefined,
          metadataTrust: metadataTrustForEstimator,
          ggufMetadata,
          runtimeParams: {
            gpuLayers: requestedGpuLayers,
            cacheTypeK,
            cacheTypeV,
            useMmap: requestedUseMmap,
          },
          snapshot: systemMemorySnapshot ?? undefined,
        },
      });
      const requestedCalibrationKey = verifiedFileSizeBytes !== null
        ? this.buildCalibrationKeyString({
          ggufMetadata,
          verifiedFileSizeBytes,
          contextTokens: resolvedContextSize,
          gpuLayers: requestedGpuLayers,
          cacheTypeK,
          cacheTypeV,
          useMmap: requestedUseMmap,
          hasMmproj: false,
          nBatch: configuredBatchParams?.nBatch,
          nUbatch: configuredBatchParams?.nUbatch,
        })
        : null;
      const requestedCalibrationRecord = requestedCalibrationKey
        ? registry.getCalibrationRecord(requestedCalibrationKey)
        : undefined;
      const requestedEstimatorInput = {
        modelSizeBytes: resolvedModelSizeBytes,
        verifiedFileSizeBytes: verifiedFileSizeBytes ?? undefined,
        metadataTrust: metadataTrustForEstimator,
        ggufMetadata,
        runtimeParams: {
          contextTokens: resolvedContextSize,
          gpuLayers: requestedGpuLayers,
          cacheTypeK,
          cacheTypeV,
          useMmap: requestedUseMmap,
          ...(configuredBatchParams
            ? {
                nBatch: configuredBatchParams.nBatch,
                nUbatch: configuredBatchParams.nUbatch,
              }
            : null),
        },
        snapshot: systemMemorySnapshot ?? undefined,
        calibrationRecord: requestedCalibrationRecord,
      };

      if (typeof resolvedModelSizeBytes === 'number' && Number.isFinite(resolvedModelSizeBytes) && resolvedModelSizeBytes > 0) {
        memoryFit = estimateAccurateMemoryFit({
          input: requestedEstimatorInput,
          totalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
            ? resolvedTotalMemoryBytes
            : null,
        });

        if (initDiagnostics) {
          initDiagnostics = {
            ...initDiagnostics,
            memoryFit,
          };
        }

        const overBudgetRatio = memoryFit.effectiveBudgetBytes > 0
          ? memoryFit.requiredBytes / memoryFit.effectiveBudgetBytes
          : Number.POSITIVE_INFINITY;
        const hasTrustedBudget = memoryFit.budget.totalMemoryBytes > 0;
        const lowMemorySignal = systemMemorySnapshot?.lowMemory ?? hardwareListenerService.getCurrentStatus().isLowMemory;
        exceedsEffectiveBudget = (
          memoryFit.requiredBytes > 0
          && memoryFit.effectiveBudgetBytes > 0
          && memoryFit.requiredBytes >= memoryFit.effectiveBudgetBytes
        );
        const shouldHardBlock = (
          hasTrustedBudget
          && memoryFit.decision === 'likely_oom'
          && memoryFit.confidence === 'high'
        );
        availableBudgetBytes = systemMemorySnapshot
          ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot)
          : null;

        if (shouldHardBlock && !allowUnsafeMemoryLoad) {
          this.persistHardBlockedMemoryFit(modelId, 'high');
          throw new AppError('model_memory_insufficient', 'Not enough memory to load this model.', {
            details: {
              modelId,
              modelSizeBytes: resolvedModelSizeBytes,
              estimatedRuntimeBytes: memoryFit.requiredBytes,
              totalMemoryBytes: resolvedTotalMemoryBytes,
              availableMemoryBytes: systemMemorySnapshot?.availableBytes,
              freeMemoryBytes: systemMemorySnapshot?.freeBytes,
              thresholdBytes: systemMemorySnapshot?.thresholdBytes,
              totalBudgetBytes: memoryFit.budget.totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO,
              availableBudgetBytes,
              effectiveAvailableBudgetBytes: memoryFit.effectiveBudgetBytes,
              lowMemory: lowMemorySignal,
              allowUnsafeMemoryLoad,
              overBudgetRatio,
              decision: memoryFit.decision,
              confidence: memoryFit.confidence,
              memoryFit,
            },
          });
        }

        if (exceedsEffectiveBudget) {
          ({ safeLoadProfile, safeMemoryFit } = this.resolveMaxSafeLoadProfile({
            ggufMetadata,
            resolvedModelSizeBytes,
            verifiedFileSizeBytes,
            metadataTrust: metadataTrustForEstimator,
            totalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
              ? resolvedTotalMemoryBytes
              : null,
            systemMemorySnapshot,
            contextCeilingTokens: resolvedContextSize,
            gpuLayersCeiling: requestedGpuLayers,
            cacheTypeK,
            cacheTypeV,
            useMmap: requestedUseMmap,
          }));

          const configuredContextCeilingTokens = (
            typeof loadParams.contextSize === 'number'
            && Number.isFinite(loadParams.contextSize)
            && loadParams.contextSize > 0
          )
            ? Math.round(loadParams.contextSize)
            : DEFAULT_CONTEXT_SIZE;
          const modelContextCeilingTokens = (
            typeof modelMaxContextTokens === 'number'
            && Number.isFinite(modelMaxContextTokens)
            && modelMaxContextTokens > 0
          )
            ? Math.round(modelMaxContextTokens)
            : null;
          const effectiveContextCeilingTokens = modelContextCeilingTokens === null
            ? configuredContextCeilingTokens
            : Math.min(configuredContextCeilingTokens, modelContextCeilingTokens);

          if (
            safeLoadProfile.contextTokens === MIN_CONTEXT_WINDOW_TOKENS
            && effectiveContextCeilingTokens > MIN_CONTEXT_WINDOW_TOKENS
          ) {
            this.persistHardBlockedMemoryFit(modelId, 'high');
            throw new AppError(
              'model_load_blocked',
              'Loading is disabled for this model because it only fits at the minimum context window.',
              {
                details: {
                  modelId,
                  requestedLoadProfile: {
                    contextTokens: resolvedContextSize,
                    gpuLayers: requestedGpuLayers,
                  },
                  safeLoadProfile,
                  safeMemoryFit,
                  memoryFit,
                },
              },
            );
          }
        }

        if (!allowUnsafeMemoryLoad && exceedsEffectiveBudget) {
          shouldAutoUseSafeLoadProfile = canAutoUseSafeLoadProfile({
            memoryFit: safeMemoryFit ?? undefined,
            availableBudgetBytes,
            lowMemorySignal,
          });

          if (shouldAutoUseSafeLoadProfile) {
            if (initDiagnostics) {
              initDiagnostics = {
                ...initDiagnostics,
                safeLoadProfile,
                safeMemoryFit: safeMemoryFit ?? undefined,
                autoSafeLoadProfile: true,
              };
            }
          } else {
            throw new AppError('model_memory_warning', 'Model may not fit in memory.', {
              details: {
                modelId,
                decision: memoryFit.decision,
                confidence: memoryFit.confidence,
                overBudgetRatio,
                memoryFit,
                safeLoadProfile,
                safeMemoryFit: safeMemoryFit ?? undefined,
                requestedLoadProfile: {
                  contextTokens: resolvedContextSize,
                  gpuLayers: requestedGpuLayers,
                },
              },
            });
          }
        }
      }

      const shouldUseSafeLoadProfile = Boolean(
        (allowUnsafeMemoryLoad || shouldAutoUseSafeLoadProfile)
        && memoryFit
        && exceedsEffectiveBudget,
      );
      const resolvedSafeLoadProfile = safeLoadProfile ?? { contextTokens: MIN_CONTEXT_WINDOW_TOKENS, gpuLayers: 0 };
      const finalContextSize = shouldUseSafeLoadProfile ? resolvedSafeLoadProfile.contextTokens : resolvedContextSize;
      const gpuLayers = shouldUseSafeLoadProfile ? resolvedSafeLoadProfile.gpuLayers : requestedGpuLayers;
      this.requestedGpuLayers = requestedGpuLayers;
      const shouldUseLowMemoryContextParams = Boolean(
        memoryFit
        && (
          shouldUseSafeLoadProfile
          || memoryFit.decision === 'fits_low_confidence'
          || memoryFit.decision === 'borderline'
          || memoryFit.decision === 'likely_oom'
        ),
      );
      const resolvedParallelSlots = requestedParallelSlots ?? 1;
      const lowMemoryBatchParams = this.resolveLowMemoryBatchParams(
        finalContextSize,
        shouldUseLowMemoryContextParams,
      );
      const lowMemoryBatchSize = lowMemoryBatchParams?.nBatch ?? null;
      const lowMemoryMicroBatchSize = lowMemoryBatchParams?.nUbatch ?? null;
      const effectiveBatchParams = shouldUseLowMemoryContextParams && lowMemoryBatchSize !== null && lowMemoryMicroBatchSize !== null
        ? {
            nBatch: lowMemoryBatchSize,
            nUbatch: lowMemoryMicroBatchSize,
          }
        : configuredBatchParams;

      if (process.env.NODE_ENV !== 'test' && memoryFit) {
        const shouldWarnNearLimit = (
          shouldUseSafeLoadProfile
          || memoryFit.decision === 'fits_low_confidence'
          || memoryFit.decision === 'borderline'
          || memoryFit.decision === 'likely_oom'
        );

        if (shouldWarnNearLimit) {
          const overBudgetRatio = memoryFit.effectiveBudgetBytes > 0
            ? memoryFit.requiredBytes / memoryFit.effectiveBudgetBytes
            : null;

          console.warn('[LLMEngine] Loading model near RAM limit', {
            modelId,
            decision: memoryFit.decision,
            confidence: memoryFit.confidence,
            overBudgetRatio,
            allowUnsafeMemoryLoad,
            requestedLoadProfile: {
              contextTokens: resolvedContextSize,
              gpuLayers: requestedGpuLayers,
            },
            effectiveLoadProfile: {
              contextTokens: finalContextSize,
              gpuLayers,
            },
            effectiveContextParams: {
              n_parallel: resolvedParallelSlots,
              ...(effectiveBatchParams
                ? {
                    ...(shouldUseLowMemoryContextParams ? { no_extra_bufts: true } : null),
                    n_batch: effectiveBatchParams.nBatch,
                    n_ubatch: effectiveBatchParams.nUbatch,
                  }
                : null),
              flash_attn_type: (
                resolveEffectiveFlashAttnType(requestedFlashAttention, gpuLayers)
              ),
              use_mmap: requestedUseMmap,
              use_mlock: requestedUseMlock,
              ...(typeof requestedCpuThreads === 'number' ? { n_threads: requestedCpuThreads } : null),
              ...(requestedCpuMask ? { cpu_mask: requestedCpuMask } : null),
              ...(typeof requestedCpuStrict === 'boolean' ? { cpu_strict: requestedCpuStrict } : null),
              ...(typeof requestedKvUnified === 'boolean' ? { kv_unified: requestedKvUnified } : null),
            },
            memoryFit,
            safeLoadProfile: safeLoadProfile ?? undefined,
            safeMemoryFit: safeMemoryFit ?? undefined,
          });
        }
      }
      let calibrationKeyForLoad = verifiedFileSizeBytes !== null
        ? this.buildCalibrationKeyString({
          ggufMetadata,
          verifiedFileSizeBytes,
          contextTokens: finalContextSize,
          gpuLayers,
          cacheTypeK,
          cacheTypeV,
          useMmap: requestedUseMmap,
          hasMmproj: false,
          nBatch: effectiveBatchParams?.nBatch,
          nUbatch: effectiveBatchParams?.nUbatch,
        })
        : null;
      let calibrationRecordForLoad = calibrationKeyForLoad
        ? registry.getCalibrationRecord(calibrationKeyForLoad)
        : undefined;
      let predictedFitForLoad = (
        typeof resolvedModelSizeBytes === 'number'
        && Number.isFinite(resolvedModelSizeBytes)
        && resolvedModelSizeBytes > 0
        && calibrationKeyForLoad
        && (
          shouldUseSafeLoadProfile
          || calibrationKeyForLoad !== requestedCalibrationKey
        )
      )
        ? estimateAccurateMemoryFit({
          input: {
            ...requestedEstimatorInput,
            runtimeParams: {
              ...requestedEstimatorInput.runtimeParams,
              contextTokens: finalContextSize,
              gpuLayers,
              useMmap: requestedUseMmap,
              ...(effectiveBatchParams
                ? {
                    nBatch: effectiveBatchParams.nBatch,
                    nUbatch: effectiveBatchParams.nUbatch,
                  }
                : null),
            },
            calibrationRecord: calibrationRecordForLoad,
          },
          totalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
            ? resolvedTotalMemoryBytes
            : null,
        })
        : memoryFit;
      let resolvedGpuLayers = gpuLayers;
      const lowMemorySignal = systemMemorySnapshot?.lowMemory ?? hardwareListenerService.getCurrentStatus().isLowMemory;
      const safeLoadStillExceedsBudget = (
        shouldUseSafeLoadProfile
        && shouldHardBlockSafeLoad({
          memoryFit: predictedFitForLoad,
          availableBudgetBytes,
          lowMemorySignal,
        })
      );

      if (safeLoadStillExceedsBudget && predictedFitForLoad && allowUnsafeMemoryLoad) {
        initDiagnostics = initDiagnostics ? {
          ...initDiagnostics,
          unsafeMemoryBypassedHardBlock: true,
        } : initDiagnostics;
      }

       if (safeLoadStillExceedsBudget && predictedFitForLoad && !allowUnsafeMemoryLoad) {
         throw new AppError('model_memory_insufficient', 'Not enough memory to load this model.', {
           details: {
            modelId,
            modelSizeBytes: resolvedModelSizeBytes,
            estimatedRuntimeBytes: predictedFitForLoad.requiredBytes,
            totalMemoryBytes: resolvedTotalMemoryBytes,
            availableMemoryBytes: systemMemorySnapshot?.availableBytes,
            freeMemoryBytes: systemMemorySnapshot?.freeBytes,
            thresholdBytes: systemMemorySnapshot?.thresholdBytes,
            totalBudgetBytes: predictedFitForLoad.budget.totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO,
            availableBudgetBytes,
            effectiveAvailableBudgetBytes: predictedFitForLoad.effectiveBudgetBytes,
            lowMemory: lowMemorySignal,
            allowUnsafeMemoryLoad,
            decision: predictedFitForLoad.decision,
            confidence: predictedFitForLoad.confidence,
            memoryFit: predictedFitForLoad,
            requestedMemoryFit: memoryFit,
            requestedLoadProfile: {
              contextTokens: resolvedContextSize,
              gpuLayers: requestedGpuLayers,
            },
            attemptedLoadProfile: {
              contextTokens: finalContextSize,
              gpuLayers,
            },
          },
         });
       }

       if (initDiagnostics) {
         initDiagnostics = {
           ...initDiagnostics,
           resolvedContextSize: finalContextSize,
           requestedGpuLayers,
           resolvedGpuLayers: gpuLayers,
           didUseSafeLoadProfile: shouldUseSafeLoadProfile,
         };
       }

       if (shouldBridgeNativeLogs) {
         try {
           nativeLogListener = llama.addNativeLogListener((level, text) => {
            nativeLogs.push({ level, text });
            if (nativeLogs.length > MAX_NATIVE_LOG_LINES) {
              nativeLogs.splice(0, nativeLogs.length - MAX_NATIVE_LOG_LINES);
            }
          });
          await llama.toggleNativeLog(true);
          didEnableNativeLogs = true;
        } catch (error) {
          console.warn('[LLMEngine] Failed to enable native llama logs', error);
        }
      }

      const normalizedBackendPolicy = requestedBackendPolicy && requestedBackendPolicy !== 'auto'
        ? requestedBackendPolicy
        : 'auto';
      const shouldDiscoverBackendCapabilities = gpuLayers > 0 && (
        normalizedBackendPolicy === 'auto'
        || normalizedBackendPolicy === 'npu'
        || normalizedBackendPolicy === 'gpu'
      );
      const backendCapabilities = shouldDiscoverBackendCapabilities
        ? await inferenceBackendService.getCapabilitiesSummary().catch(() => null)
        : null;

      const backendInitAttempts: EngineBackendInitAttempt[] = [];

      const applyCalibrationForGpuLayers = (nextGpuLayers: number) => {
        const normalized = Math.max(0, Math.round(nextGpuLayers));
        resolvedGpuLayers = normalized;
        calibrationKeyForLoad = verifiedFileSizeBytes !== null
          ? this.buildCalibrationKeyString({
              ggufMetadata,
              verifiedFileSizeBytes,
              contextTokens: finalContextSize,
              gpuLayers: normalized,
              cacheTypeK,
              cacheTypeV,
              useMmap: requestedUseMmap,
              hasMmproj: false,
              nBatch: effectiveBatchParams?.nBatch,
              nUbatch: effectiveBatchParams?.nUbatch,
            })
          : null;
        calibrationRecordForLoad = calibrationKeyForLoad
          ? registry.getCalibrationRecord(calibrationKeyForLoad)
          : undefined;

        if (
          typeof resolvedModelSizeBytes === 'number'
          && Number.isFinite(resolvedModelSizeBytes)
          && resolvedModelSizeBytes > 0
          && calibrationKeyForLoad
        ) {
          predictedFitForLoad = estimateAccurateMemoryFit({
            input: {
              ...requestedEstimatorInput,
              runtimeParams: {
                ...requestedEstimatorInput.runtimeParams,
                contextTokens: finalContextSize,
                gpuLayers: normalized,
                useMmap: requestedUseMmap,
                ...(effectiveBatchParams
                  ? {
                      nBatch: effectiveBatchParams.nBatch,
                      nUbatch: effectiveBatchParams.nUbatch,
                    }
                  : null),
              },
              calibrationRecord: calibrationRecordForLoad,
            },
            totalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
              ? resolvedTotalMemoryBytes
              : null,
          });
        } else {
          predictedFitForLoad = memoryFit;
        }
      };

      const initLlamaWithRetry = async (profile: ResolvedInferenceProfile): Promise<{
        context: LlamaContext;
        resolvedGpuLayers: number;
      }> => {
        const {
          backendMode: candidate,
          devices,
          nGpuLayers,
          nThreads,
          cpuMask,
          cpuStrict,
          flashAttnType,
          useMmap,
          useMlock,
          nBatch,
          nUbatch,
          kvUnified,
          nParallel,
        } = profile;

        const buildOptions = (layers: number) => {
          // llama.cpp requires Flash Attention when using quantized V cache.
          // Some candidate profiles force flashAttnType='off' (e.g., CPU fallback). When
          // combined with cache_type_v=q8_0/q4_0, llama.cpp returns a null context and
          // llama.rn can crash before surfacing the error.
          const resolvedFlashAttnType = resolveEffectiveFlashAttnType(flashAttnType, layers);

          return {
            model: modelPath,
            n_ctx: finalContextSize,
            n_gpu_layers: layers,
            n_parallel: nParallel,
            ...(typeof nThreads === 'number' && Number.isFinite(nThreads) && nThreads > 0
              ? { n_threads: Math.max(1, Math.round(nThreads)) }
              : null),
            ...(typeof cpuMask === 'string' && cpuMask.trim().length > 0
              ? { cpu_mask: cpuMask.trim() }
              : null),
            ...(typeof cpuStrict === 'boolean' ? { cpu_strict: cpuStrict } : null),
            use_mmap: useMmap,
            use_mlock: useMlock,
            cache_type_k: cacheTypeK,
            cache_type_v: cacheTypeV,
            flash_attn_type: resolvedFlashAttnType,
            ...(typeof kvUnified === 'boolean' ? { kv_unified: kvUnified } : null),
            ...(devices ? { devices } : null),
            ...(typeof nBatch === 'number'
            && Number.isFinite(nBatch)
            && typeof nUbatch === 'number'
            && Number.isFinite(nUbatch)
              ? {
                  ...(shouldUseLowMemoryContextParams ? { no_extra_bufts: true } : null),
                  n_batch: Math.round(nBatch),
                  n_ubatch: Math.round(nUbatch),
                }
              : null),
          };
        };

        const initOnce = async (layers: number) => llama.initLlama(
          buildOptions(layers),
          (progress) => {
            this.updateState({ ...this.state, loadProgress: progress });
          },
        );

        const normalizedLayers = Math.max(0, Math.round(nGpuLayers));
        if (normalizedLayers <= 0) {
          const context = await initOnce(0);
          applyCalibrationForGpuLayers(0);
          return { context, resolvedGpuLayers: 0 };
        }

        try {
          const context = await initOnce(normalizedLayers);
          applyCalibrationForGpuLayers(normalizedLayers);
          return { context, resolvedGpuLayers: normalizedLayers };
        } catch (error) {
          const isOomLikely = isProbableMemoryFailure(error);
          if (calibrationKeyForLoad && isOomLikely) {
            this.persistCalibrationFailure({
              calibrationKey: calibrationKeyForLoad,
              observedRawBudgetBytes,
            });
          }

          const retryCandidates = isOomLikely
            ? Array.from(
                new Set([
                  Math.floor(normalizedLayers * 0.75),
                  Math.floor(normalizedLayers / 2),
                  Math.floor(normalizedLayers / 4),
                  1,
                ]),
              )
                .filter((candidateLayers) => candidateLayers > 0 && candidateLayers < normalizedLayers)
                .sort((a, b) => b - a)
            : [];

          if (process.env.NODE_ENV !== 'test') {
            const logLabel = retryCandidates.length > 0
              ? `[LLMEngine] ${candidate.toUpperCase()} init failed, retrying with fewer layers`
              : `[LLMEngine] ${candidate.toUpperCase()} init failed`;
            console.warn(logLabel, error);
          }

          let lastError: unknown = error;
          for (const candidateLayers of retryCandidates) {
            const candidateCalibrationKey = verifiedFileSizeBytes !== null
              ? this.buildCalibrationKeyString({
                  ggufMetadata,
                  verifiedFileSizeBytes,
                  contextTokens: finalContextSize,
                  gpuLayers: candidateLayers,
                  cacheTypeK,
                  cacheTypeV,
                  useMmap: requestedUseMmap,
                  hasMmproj: false,
                  nBatch: effectiveBatchParams?.nBatch,
                  nUbatch: effectiveBatchParams?.nUbatch,
                })
              : null;

            try {
              const context = await initOnce(candidateLayers);
              applyCalibrationForGpuLayers(candidateLayers);
              return { context, resolvedGpuLayers: candidateLayers };
            } catch (retryError) {
              lastError = retryError;
              if (candidateCalibrationKey && isProbableMemoryFailure(retryError)) {
                this.persistCalibrationFailure({
                  calibrationKey: candidateCalibrationKey,
                  observedRawBudgetBytes,
                });
              }
            }
          }

          throw lastError;
        }
      };

      const baseInferenceProfile: Omit<ResolvedInferenceProfile, 'backendMode' | 'devices' | 'nGpuLayers'> = {
        flashAttnType: requestedFlashAttention,
        useMmap: requestedUseMmap,
        useMlock: requestedUseMlock,
        nParallel: resolvedParallelSlots,
        ...(typeof requestedCpuThreads === 'number' ? { nThreads: requestedCpuThreads } : null),
        ...(requestedCpuMask ? { cpuMask: requestedCpuMask } : null),
        ...(typeof requestedCpuStrict === 'boolean' ? { cpuStrict: requestedCpuStrict } : null),
        ...(typeof requestedKvUnified === 'boolean' ? { kvUnified: requestedKvUnified } : null),
        ...(effectiveBatchParams
          ? {
              nBatch: effectiveBatchParams.nBatch,
              nUbatch: effectiveBatchParams.nUbatch,
            }
          : null),
      };

      const autotuneBestStableProfile = normalizedBackendPolicy === 'auto'
        ? readBestStableAutotuneProfile({
            modelId,
            contextSize: loadParams.contextSize,
            kvCacheType: loadParams.kvCacheType,
            modelFileSizeBytes: verifiedFileSizeBytes,
            modelSha256: cachedModel?.sha256,
          })
        : null;

      const {
        effectiveBackendPolicy,
        candidates: resolvedInferenceCandidates,
        reasons: backendPolicyReasons,
      } = resolveInferenceProfileCandidates({
        capabilities: backendCapabilities,
        loadParams: {
          backendPolicy: requestedBackendPolicy,
          selectedBackendDevices: loadParams.selectedBackendDevices,
        },
        gpuLayers,
        baseProfile: baseInferenceProfile,
      });

      let inferenceCandidatesForInit = resolvedInferenceCandidates;
      let resolvedBackendPolicyReasons = backendPolicyReasons;

      const capabilitiesKnown = Boolean(backendCapabilities && backendCapabilities.discoveryUnavailable !== true);

      if (normalizedBackendPolicy === 'auto' && autotuneBestStableProfile) {
        const preferredBackendMode = autotuneBestStableProfile.backendMode;
        const preferredGpuLayers = Math.max(0, Math.round(autotuneBestStableProfile.nGpuLayers));
        const clampedGpuLayers = preferredBackendMode === 'cpu' ? 0 : Math.min(gpuLayers, preferredGpuLayers);

        const canApplyPreferred = preferredBackendMode === 'cpu'
          || (
            clampedGpuLayers > 0
            && (
              (preferredBackendMode === 'gpu' && backendCapabilities?.gpu.available === true)
              || (preferredBackendMode === 'npu' && backendCapabilities?.npu.available === true)
            )
          );

        if (canApplyPreferred) {
          const fallbackNpuDevices = preferredBackendMode === 'npu'
            ? (() => {
                const discovered = Array.isArray(backendCapabilities?.npu.deviceNames)
                  ? backendCapabilities.npu.deviceNames
                      .filter((device): device is string => typeof device === 'string')
                      .map((device) => device.trim())
                      .filter((device) => device.length > 0 && !/\s/.test(device))
                  : [];
                const unique = Array.from(new Set(discovered));
                return unique.length > 0 ? unique : ['HTP*'];
              })()
            : null;

          const savedNpuDevices = preferredBackendMode === 'npu' && Array.isArray(autotuneBestStableProfile.devices)
            ? autotuneBestStableProfile.devices
                .filter((device): device is string => typeof device === 'string')
                .map((device) => device.trim())
                .filter((device) => device.length > 0 && !/\s/.test(device))
            : [];
          const uniqueSavedNpuDevices = Array.from(new Set(savedNpuDevices));
          const didUseSavedNpuDevices = preferredBackendMode === 'npu' && uniqueSavedNpuDevices.length > 0;
          const preferredNpuDevices = preferredBackendMode === 'npu'
            ? (didUseSavedNpuDevices ? uniqueSavedNpuDevices : (fallbackNpuDevices ?? ['HTP*']))
            : null;

          // Only honor stored device selectors for NPU. GPU device strings can be human-readable
          // labels (with whitespace) and may not be safe to feed back into init.
          const preferredCandidate: ResolvedInferenceProfile = {
            ...baseInferenceProfile,
            backendMode: preferredBackendMode,
            nGpuLayers: clampedGpuLayers,
            ...(preferredBackendMode === 'npu'
              ? { devices: preferredNpuDevices ?? ['HTP*'] }
              : null),
          };

          const seenCandidateKeys = new Set<string>();
          inferenceCandidatesForInit = [
            preferredCandidate,
            ...(didUseSavedNpuDevices && fallbackNpuDevices
              ? [
                  {
                    ...baseInferenceProfile,
                    backendMode: 'npu',
                    nGpuLayers: clampedGpuLayers,
                    devices: fallbackNpuDevices,
                  } satisfies ResolvedInferenceProfile,
                ]
              : []),
            ...resolvedInferenceCandidates,
          ].filter((profile) => {
            const candidateKey = `${profile.backendMode}:${Array.isArray(profile.devices) ? profile.devices.join('|') : '*'}`;
            if (seenCandidateKeys.has(candidateKey)) {
              return false;
            }
            seenCandidateKeys.add(candidateKey);
            return true;
          });

          if (inferenceCandidatesForInit[0]?.backendMode !== resolvedInferenceCandidates[0]?.backendMode) {
            resolvedBackendPolicyReasons = [
              ...backendPolicyReasons,
              preferredBackendMode === 'cpu'
                ? 'inference.backendPolicyReason.autotunePreferringCpu'
                : preferredBackendMode === 'npu'
                  ? 'inference.backendPolicyReason.autotunePreferringNpu'
                  : 'inference.backendPolicyReason.autotunePreferringGpu',
            ];
          }
        }
      }

      this.requestedBackendPolicy = normalizedBackendPolicy;
      this.effectiveBackendPolicy = effectiveBackendPolicy as EngineBackendPolicy;
      this.backendPolicyReasons = resolvedBackendPolicyReasons;
      this.initCacheTypeK = cacheTypeK;
      this.initCacheTypeV = cacheTypeV;
      const candidateModes = new Set(inferenceCandidatesForInit.map((candidate) => candidate.backendMode));

      // Record a skipped init attempt when the requested policy could not be attempted due to a
      // known device discovery result.
      if (capabilitiesKnown && gpuLayers > 0) {
        if (requestedBackendPolicy === 'npu' && !candidateModes.has('npu')) {
          backendInitAttempts.push({
            candidate: 'npu',
            nGpuLayers: gpuLayers,
            devices: selectedBackendDevices ?? ['HTP*'],
            outcome: 'skipped',
          });
        }

        if (requestedBackendPolicy === 'gpu' && !candidateModes.has('gpu')) {
          backendInitAttempts.push({
            candidate: 'gpu',
            nGpuLayers: gpuLayers,
            outcome: 'skipped',
          });
        }
      }

      if (initDiagnostics) {
        initDiagnostics = {
          ...initDiagnostics,
          effectiveBackendPolicy,
          backendPolicyReasons: resolvedBackendPolicyReasons,
        };
      }

      let resolvedInitProfile: ResolvedInferenceProfile | null = null;
      let resolvedInitGpuLayers: number | null = null;
      let resolvedRuntimeDevices: string[] | null = null;
      let lastBackendInitError: unknown | null = null;
      for (let i = 0; i < inferenceCandidatesForInit.length; i += 1) {
        const profile = inferenceCandidatesForInit[i];
        const { backendMode: candidate, nGpuLayers, devices } = profile;
        const hasAcceleratorCandidateAfter = inferenceCandidatesForInit.slice(i + 1).some((next) => next.backendMode !== 'cpu');

        try {
          const { context, resolvedGpuLayers: candidateGpuLayers } = await initLlamaWithRetry(profile);
          const actualGpu = Boolean(context.gpu);
          const reasonNoGPU = typeof context.reasonNoGPU === 'string' ? context.reasonNoGPU.trim() : '';

          backendInitAttempts.push({
            candidate,
            nGpuLayers: Math.max(0, Math.round(nGpuLayers)),
            devices,
            outcome: 'success',
            actualGpu,
            ...(reasonNoGPU ? { reasonNoGPU } : null),
          });

          // If an accelerator candidate initializes but the runtime reports CPU mode,
          // treat this as a degraded init and continue to the next candidate.
          // This ensures we eventually land on a true CPU profile (n_gpu_layers=0) with a
          // crash-safe flash attention setting (e.g., V-cache quantization requires flash_attn != off).
          // and also allows switching to the next accelerator candidate when AUTO prefers one.
          if (candidate !== 'cpu' && !actualGpu) {
            if (process.env.NODE_ENV !== 'test') {
              const fallbackLabel = hasAcceleratorCandidateAfter
                ? 'retrying next accelerator candidate'
                : 'falling back to CPU profile';
              console.warn(`[LLMEngine] ${candidate.toUpperCase()} init returned CPU runtime, ${fallbackLabel}`);
            }
            await llama.releaseAllLlama().catch(() => undefined);
            lastBackendInitError = new Error(
              reasonNoGPU || `${candidate.toUpperCase()} acceleration was not enabled.`,
            );
            continue;
          }

          resolvedInitProfile = profile;
          resolvedInitGpuLayers = candidateGpuLayers;
          resolvedRuntimeDevices = Array.isArray(context.devices)
            ? context.devices
                .filter((device): device is string => typeof device === 'string')
                .map((device) => device.trim())
                .filter((device) => device.length > 0)
            : null;

          if (!actualGpu) {
            applyCalibrationForGpuLayers(0);
          } else if (candidateGpuLayers !== resolvedGpuLayers) {
            applyCalibrationForGpuLayers(candidateGpuLayers);
          }

          this.context = context;
          gpuInitError = null;
          break;
        } catch (error) {
          lastBackendInitError = error;
          backendInitAttempts.push({
            candidate,
            nGpuLayers: Math.max(0, Math.round(nGpuLayers)),
            devices,
            outcome: 'error',
            error: getErrorMessageText(error),
          });

          if (candidate === 'cpu') {
            cpuInitError = error;
          } else {
            gpuInitError = error;
          }

          await llama.releaseAllLlama().catch(() => undefined);
        }
      }

      if (!this.context) {
        throw lastBackendInitError ?? new Error('Failed to initialize inference backend');
      }

      this.backendInitAttemptsSnapshot = backendInitAttempts;

      // If the user explicitly requested an accelerator but we ended up initializing a CPU profile,
      // reflect that in the effective backend policy so diagnostics/UI make the fallback obvious.
      if (
        resolvedInitProfile?.backendMode === 'cpu'
        && (normalizedBackendPolicy === 'gpu' || normalizedBackendPolicy === 'npu')
      ) {
        this.effectiveBackendPolicy = 'cpu';
      }

      if (resolvedInitProfile) {
        this.initGpuLayers = resolvedInitGpuLayers;
        this.initDevices = Array.isArray(resolvedRuntimeDevices) && resolvedRuntimeDevices.length > 0
          ? [...resolvedRuntimeDevices]
          : Array.isArray(resolvedInitProfile.devices)
            ? [...resolvedInitProfile.devices]
            : null;
        this.initFlashAttnType = resolveEffectiveFlashAttnType(
          resolvedInitProfile.flashAttnType,
          resolvedInitGpuLayers ?? resolvedInitProfile.nGpuLayers,
        );
        this.initUseMmap = resolvedInitProfile.useMmap;
        this.initUseMlock = resolvedInitProfile.useMlock;
        this.initNParallel = resolvedInitProfile.nParallel;
        this.initNThreads = typeof resolvedInitProfile.nThreads === 'number' && Number.isFinite(resolvedInitProfile.nThreads)
          ? Math.round(resolvedInitProfile.nThreads)
          : null;
        this.initCpuMask = typeof resolvedInitProfile.cpuMask === 'string' && resolvedInitProfile.cpuMask.trim().length > 0
          ? resolvedInitProfile.cpuMask.trim()
          : null;
        this.initCpuStrict = typeof resolvedInitProfile.cpuStrict === 'boolean' ? resolvedInitProfile.cpuStrict : null;
        this.initNBatch = typeof resolvedInitProfile.nBatch === 'number' && Number.isFinite(resolvedInitProfile.nBatch)
          ? Math.round(resolvedInitProfile.nBatch)
          : null;
        this.initNUbatch = typeof resolvedInitProfile.nUbatch === 'number' && Number.isFinite(resolvedInitProfile.nUbatch)
          ? Math.round(resolvedInitProfile.nUbatch)
          : null;
        this.initKvUnified = typeof resolvedInitProfile.kvUnified === 'boolean' ? resolvedInitProfile.kvUnified : null;
      }

      if (initDiagnostics) {
        initDiagnostics = {
          ...initDiagnostics,
          backendInitAttempts,
        };
      }

      if (initDiagnostics) {
        initDiagnostics = {
          ...initDiagnostics,
          resolvedGpuLayers,
        };
      }

      const afterModelInitSnapshot = await getFreshMemorySnapshot(0).catch(() => null);

      if (calibrationKeyForLoad && predictedFitForLoad) {
        this.activeCalibrationSession = {
          modelId,
          calibrationKey: calibrationKeyForLoad,
          predictedFit: predictedFitForLoad,
          observedRawBudgetBytes,
          beforeLoadSnapshot: systemMemorySnapshot,
          afterModelInitSnapshot,
          afterFirstTokenSnapshot: null,
          afterUnloadSnapshot: null,
          didRecordSuccess: false,
        };
      } else {
        this.activeCalibrationSession = null;
      }

      if (this.context) {
        this.captureBackendTelemetry(this.context);
      } else {
        this.resetBackendTelemetry();
      }

      const reportedLoadedGpuLayers = this.resolveReportedLoadedGpuLayers(resolvedGpuLayers);
      this.activeContextSize = finalContextSize;
      this.activeGpuLayers = reportedLoadedGpuLayers;
      this.safeModeLoadLimits = shouldUseSafeLoadProfile
        ? { maxContextTokens: finalContextSize, requestedGpuLayers, loadedGpuLayers: reportedLoadedGpuLayers }
        : null;
      this.updateState({ ...this.state, status: EngineStatus.READY, loadProgress: 1 });
      updateSettings({ activeModelId: modelId });
    } catch (error) {
      const baseError = toAppError(error, 'model_load_failed');
      const extraDetails: Record<string, unknown> = {
        ...(baseError.details ?? {}),
        ...(initDiagnostics ?? {}),
      };

      if (gpuInitError) {
        extraDetails.gpuInitError = getErrorMessageText(gpuInitError);
      }

      if (cpuInitError) {
        extraDetails.cpuInitError = getErrorMessageText(cpuInitError);
      }

      if (isDev && nativeLogs.length > 0) {
        extraDetails.nativeLogs = nativeLogs.map((line) => `${line.level}: ${line.text}`);
      }

      const errorCause = baseError.cause ?? (error instanceof AppError ? error.cause : error);
      const appError = Object.keys(extraDetails).length > 0
        ? new AppError(baseError.code, baseError.message, {
            cause: errorCause,
            details: extraDetails,
          })
        : baseError;

      if (appError.code === 'model_memory_warning' || appError.code === 'model_load_blocked') {
        const logLabel = appError.code === 'model_load_blocked'
          ? '[LLMEngine] Model load blocked during initialize'
          : '[LLMEngine] Memory warning during initialize';
        console.warn(logLabel, appError, Object.keys(extraDetails).length > 0 ? extraDetails : undefined);
        this.context = null;
        this.activeContextSize = DEFAULT_CONTEXT_SIZE;
        this.activeGpuLayers = null;
        this.safeModeLoadLimits = null;
        this.resetRuntimeTelemetry();
        this.updateState({
          status: EngineStatus.IDLE,
          activeModelId: undefined,
          loadProgress: 0,
          lastError: undefined,
        });
        throw appError;
      }

      console.error('[LLMEngine] Failed to initialize', appError, Object.keys(extraDetails).length > 0 ? extraDetails : undefined);
      this.lastModelLoadError = appError;
      this.lastModelLoadErrorScope = 'LLMEngineService.load';
      this.context = null;
      this.activeContextSize = DEFAULT_CONTEXT_SIZE;
      this.activeGpuLayers = null;
      this.safeModeLoadLimits = null;
      this.resetRuntimeTelemetry();
      updateSettings({ activeModelId: null });
      this.updateState({
        status: EngineStatus.ERROR,
        activeModelId: undefined,
        loadProgress: 0,
        lastError: appError.message,
      });
      throw appError;
    } finally {
      if (nativeLogListener) {
        nativeLogListener.remove();
      }

      if (didEnableNativeLogs && llamaModule) {
        await llamaModule.toggleNativeLog(false).catch(() => undefined);
      }

      this.initPromise = null;
    }
  }

  private async unloadInternal(): Promise<void> {
    this.isUnloading = true;
    this.resetRuntimeTelemetry();
    this.updateState({
      status: EngineStatus.IDLE,
      activeModelId: undefined,
      loadProgress: 0,
      lastError: undefined,
    });

    try {
      if (this.activeCompletionPromise) {
        try {
          await this.stopCompletion();
        } catch (error) {
          console.warn('[LLMEngine] Failed to stop completion before unload', error);
        }

        try {
          await this.activeCompletionPromise;
        } catch {
          // Completion failures are handled by the chat flow.
        }
      }

      if (this.context) {
        await requireLlamaModule().releaseAllLlama();
      }
    } finally {
      const calibrationSession = this.activeCalibrationSession;
      this.activeCalibrationSession = null;

      if (calibrationSession && !calibrationSession.didRecordSuccess) {
        this.persistCalibrationSuccess({
          calibrationKey: calibrationSession.calibrationKey,
          predictedFit: calibrationSession.predictedFit,
          beforeLoadSnapshot: calibrationSession.beforeLoadSnapshot,
          observedSnapshot: calibrationSession.afterModelInitSnapshot,
          observedRawBudgetBytes: calibrationSession.observedRawBudgetBytes,
        });
        calibrationSession.didRecordSuccess = true;
      }

      if (calibrationSession) {
        calibrationSession.afterUnloadSnapshot = await getFreshMemorySnapshot(0).catch(() => null);
      }

      this.context = null;
      this.activeContextSize = DEFAULT_CONTEXT_SIZE;
      this.activeGpuLayers = null;
      this.safeModeLoadLimits = null;
      this.resetRuntimeTelemetry();
      this.initPromise = null;
      this.activeCompletionPromise = null;
      this.isUnloading = false;
      updateSettings({ activeModelId: null });
      hardwareListenerService.resetLowMemoryFlag();
    }
  }
}

export const llmEngineService = new LLMEngineService();
