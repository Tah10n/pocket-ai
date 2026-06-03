import type {
  CompletionParams,
  LlamaContext,
  NativeBackendDeviceInfo,
  NativeCompletionResult,
} from 'llama.rn';
import DeviceInfo from 'react-native-device-info';
import { Platform } from 'react-native';
import { hardwareListenerService } from './HardwareListenerService';
import {
  EngineBackendMode,
  type EngineBackendInitAttempt,
  type EngineLifecycleEvent,
  type EngineBackendPolicy,
  EngineStatus,
  EngineState,
  type ModelMemoryFitConfidence,
  type ModelMetadata,
  type ModelThinkingCapabilitySnapshot,
} from '../types/models';
import { LlmChatCompletionOptions, LlmChatMessage } from '../types/chat';
import { registry } from './LocalStorageRegistry';
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
  modelSupportsVision,
  resolveModelCapabilitySnapshot,
  resolveModelLayerCountFromGgufMetadata,
} from '../utils/modelCapabilities';
import { resolveKvCacheTypes } from '../utils/kvCache';
import { inferenceBackendService } from './InferenceBackendService';
import { resolveInferenceProfileCandidates, type ResolvedInferenceProfile } from './resolveInferenceProfile';
import { readAutotuneResult } from './InferenceAutotuneStore';
import { readLastGoodInferenceProfile, writeLastGoodInferenceProfile } from './InferenceLastGoodProfileStore';
import {
  areThinkingCapabilitySnapshotsEqual,
  getErrorMessageText,
  getModelInfoString,
  isConversationAlternationError,
  isProbableMemoryFailure,
  readNumericMetadata,
} from './LLMEngineService.helpers';
import {
  buildEngineDiagnosticsSnapshot,
  buildMultimodalDiagnosticsSummary,
} from './LLMEngineService.diagnostics';
import {
  hasNpuRuntimeSignal as hasNpuRuntimeSignalHelper,
  resolveBackendMode as resolveBackendModeHelper,
  resolveBackendTelemetry,
} from './LLMEngineService.backend';
import {
  resolveModelFilePathOrThrow,
  resolveProjectorFilePathOrThrow,
} from './LLMEngineService.modelFile';
import {
  resolveSafeLoadPolicyOrThrow,
} from './LLMEngineService.safeLoadPolicy';
import {
  buildIntermediateGpuLayerCandidates,
  chooseSafeLoadProfileCandidate,
} from './LLMEngineService.safeLoadSearch';
import {
  ActiveCompletionRunner,
  type ContextOperationCancellationToken,
  ContextOperationRunner,
  waitForPromiseWithTimeout,
  type ContextOperationDrainResult,
} from './LLMEngineService.runners';
import { performanceMonitor } from './PerformanceMonitor';
import {
  addNativeLlamaLogListener,
  getFormattedChatFromContext,
  getLlamaBuildInfo,
  getMultimodalSupportFromContext,
  initMultimodalOnContext,
  initLlamaContext,
  loadLlamaModelInfo,
  releaseAllLlamaContexts,
  releaseMultimodalFromContext,
  runCompletionOnContext,
  tokenizeFormattedPrompt,
  toggleNativeLlamaLogs,
  LlamaRuntimeFeatureUnavailableError,
  type LlamaContextInitParams,
  type LlamaFormattedChatResult,
  type LlamaMultimodalSupport,
} from './LlamaRuntimeAdapter';
import { getReadinessStatusForProjectorLifecycle, projectorArtifactService } from './ProjectorArtifactService';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  getChatImageAttachmentMediaPaths,
  summarizeChatImageAttachments,
} from '../utils/chatImageAttachments';
import { sanitizeMultimodalFailureReason } from '../utils/multimodalFailureReason';
import type {
  MultimodalDiagnosticsSummary,
  MultimodalReadinessState,
  MultimodalReadinessStatus,
  MultimodalSupportModality,
  ProjectorArtifact,
} from '../types/multimodal';

export interface LoadModelOptions {
  forceReload?: boolean;
  allowUnsafeMemoryLoad?: boolean;
  loadParamsOverride?: Partial<ModelLoadParameters>;
  preferLastWorkingProfile?: boolean;
}

export type BackendAvailability = {
  gpuBackendAvailable: boolean | null;
  npuBackendAvailable: boolean | null;
  discoveryUnavailable: boolean;
  devices: NativeBackendDeviceInfo[];
};

type StateListener = (state: EngineState) => void;
type ChatCompletionReasoningFormat = NonNullable<NonNullable<LlmChatCompletionOptions['params']>['reasoning_format']>;
const DEFAULT_CONTEXT_SIZE = 4096;
const MAX_NATIVE_LOG_LINES = 120;
const MAX_ADDITIONAL_STOP_WORDS_CACHE_ENTRIES = 8;
const CONTEXT_OPERATION_UNLOAD_DRAIN_TIMEOUT_MS = 5000;
const CONTEXT_OPERATION_STOP_DRAIN_TIMEOUT_MS = 5000;
const CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE = 'Timed out waiting for active context operations during unload';
const ACTIVE_COMPLETION_UNLOAD_TIMEOUT_MESSAGE = 'Timed out waiting for active completion during unload';
const CONTEXT_OPERATION_STOP_MESSAGE = 'Prompt preparation was stopped before native completion started';
const CONTEXT_OPERATION_COMPLETION_DRAIN_TIMEOUT_MESSAGE = 'Timed out waiting for prompt preparation before native completion started';
const ACTIVE_COMPLETION_STOP_TIMEOUT_MESSAGE = 'Timed out waiting for active completion to stop';
const MAX_UNLOAD_RECLAIM_FRACTION_OF_TOTAL_MEMORY = 0.25;
const FALLBACK_STOP_WORDS = [
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

type StrictRoleSystemNormalization = 'plain' | 'llama';
type StopWordsResolutionSource = 'template' | 'fallback' | 'template_with_fallback';

type TemplateAdditionalStopWordsResolution = {
  stopWords: string[];
  strictRoleSystemNormalization: StrictRoleSystemNormalization;
  templateType: string | null;
};

type CompletionStopWordsResolution = {
  stopWords: string[];
  source: StopWordsResolutionSource;
  templateType: string | null;
  templateStopCount: number;
  fallbackStopCount: number;
};

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

type ModelUnloadReclaimEstimate = {
  previousModelId: string | null;
  source: 'observed_load_delta' | 'predicted_load_footprint';
  estimatedReclaimableBytes: number;
  budgetReclaimableBytes: number;
  observedFreedBytes: number;
  beforeUnloadSnapshot: SystemMemorySnapshot | null;
  afterUnloadSnapshot: SystemMemorySnapshot | null;
};

type LoadedModelArtifactIdentity = {
  localPath: string | null;
  resolvedPath: string | null;
  sizeBytes: number | null;
  modificationTime: number | null;
  fallbackDownloadMarker: number | null;
};

type ActiveMultimodalContext = {
  modelId: string;
  projectorId: string;
  projectorRepoId: string | null;
  projectorOwnerVariantId: string | null;
  projectorFileName: string | null;
  projectorDownloadUrl: string | null;
  projectorHfRevision: string | null;
  projectorSha256: string | null;
  projectorLocalPath: string | null;
  projectorResolvedPath: string | null;
  projectorSizeBytes: number | null;
  projectorModificationTime: number | null;
  projectorFallbackMarker: string | null;
};

type ResolvedModelArtifactInfo = {
  modelPath: string;
  fileInfo: {
    size?: number | null;
    modificationTime?: number | null;
  };
};

type ResolvedProjectorArtifactInfo = {
  projectorPath: string;
  localPath: string;
  fileInfo: {
    size?: number | null;
    modificationTime?: number | null;
  };
};

function normalizeMediaPaths(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) {
    return [];
  }

  return Array.from(new Set(paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)));
}

function normalizeMediaPathOccurrences(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) {
    return [];
  }

  return paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function getMessageMediaPaths(message: LlmChatMessage): string[] {
  return normalizeMediaPaths([
    ...(message.mediaPaths ?? []),
    ...getChatImageAttachmentMediaPaths(message.attachments),
  ]);
}

function getMessageMediaPathOccurrences(message: LlmChatMessage): string[] {
  const explicitMediaPaths = normalizeMediaPathOccurrences(message.mediaPaths);
  const attachmentMediaPaths = normalizeMediaPathOccurrences(
    getChatImageAttachmentMediaPaths(message.attachments),
  );
  if (explicitMediaPaths.length === 0) {
    return attachmentMediaPaths;
  }
  if (attachmentMediaPaths.length === 0) {
    return explicitMediaPaths;
  }

  const explicitCounts = new Map<string, number>();
  for (const mediaPath of explicitMediaPaths) {
    explicitCounts.set(mediaPath, (explicitCounts.get(mediaPath) ?? 0) + 1);
  }

  const attachmentCounts = new Map<string, number>();
  const occurrences = [...explicitMediaPaths];
  for (const mediaPath of attachmentMediaPaths) {
    const attachmentCount = (attachmentCounts.get(mediaPath) ?? 0) + 1;
    attachmentCounts.set(mediaPath, attachmentCount);
    if (attachmentCount > (explicitCounts.get(mediaPath) ?? 0)) {
      occurrences.push(mediaPath);
    }
  }

  return occurrences;
}

function getMessagesMediaPaths(messages: readonly LlmChatMessage[]): string[] {
  return normalizeMediaPaths(messages.flatMap((message) => getMessageMediaPaths(message)));
}

function countMessageMediaPathOccurrences(messages: readonly LlmChatMessage[]): number {
  return messages.reduce(
    (count, message) => count + getMessageMediaPathOccurrences(message).length,
    0,
  );
}

function countMergedRequestMediaPathOccurrences(
  originalMessages: readonly LlmChatMessage[],
  topLevelMediaPaths: readonly string[] | undefined,
): number {
  const latestUserMessageIndex = getLatestUserMessageIndex(originalMessages);
  if (latestUserMessageIndex < 0) {
    return countMessageMediaPathOccurrences(originalMessages);
  }

  const existingMessageMediaPaths = new Set(getMessagesMediaPaths(originalMessages));
  const appendedTopLevelMediaPathCount = normalizeMediaPathOccurrences(topLevelMediaPaths)
    .filter((mediaPath) => !existingMessageMediaPaths.has(mediaPath))
    .length;
  return countMessageMediaPathOccurrences(originalMessages) + appendedTopLevelMediaPathCount;
}

function getLatestUserMessageIndex(messages: readonly LlmChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return index;
    }
  }

  return -1;
}

function withResolvedMediaPaths(message: LlmChatMessage): LlmChatMessage {
  const mediaPaths = getMessageMediaPaths(message);
  const { mediaPaths: _mediaPaths, ...messageWithoutMediaPaths } = message;
  return {
    ...messageWithoutMediaPaths,
    ...(mediaPaths.length > 0 ? { mediaPaths } : null),
  };
}

function withoutMediaPaths(message: LlmChatMessage): LlmChatMessage {
  const {
    attachments: _attachments,
    mediaPaths: _mediaPaths,
    ...messageWithoutMedia
  } = message;
  return messageWithoutMedia;
}

function sanitizeErrorMessageForDiagnostics(error: unknown): string {
  return sanitizeMultimodalFailureReason(getErrorMessageText(error), 512)
    ?? (error instanceof Error ? error.name : typeof error);
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeMultimodalFailureReason(value, 512) ?? '[redacted]';
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnosticValue);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    return {
      errorName: value.name,
      message: sanitizeErrorMessageForDiagnostics(value),
    };
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeDiagnosticValue(entry)]),
  );
}

function buildSafeErrorLogDetails(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: sanitizeErrorMessageForDiagnostics(error),
      ...(error.details ? { details: sanitizeDiagnosticValue(error.details) } : null),
    };
  }

  return error instanceof Error
    ? { errorName: error.name, message: sanitizeErrorMessageForDiagnostics(error) }
    : { errorType: typeof error };
}

function mergeTopLevelMediaPathsIntoLatestUserMessage(
  messages: readonly LlmChatMessage[],
  mediaPaths: readonly string[] | undefined,
): LlmChatMessage[] {
  const normalizedTopLevelMediaPaths = normalizeMediaPaths(mediaPaths);
  const resolvedMessages = messages.map(withResolvedMediaPaths);
  const latestUserMessageIndex = getLatestUserMessageIndex(resolvedMessages);

  if (latestUserMessageIndex < 0) {
    return resolvedMessages;
  }

  const existingMessageMediaPaths = new Set(getMessagesMediaPaths(resolvedMessages));
  const mediaPathsToAppend = normalizedTopLevelMediaPaths.filter(
    (mediaPath) => !existingMessageMediaPaths.has(mediaPath),
  );

  return resolvedMessages.map((message, index) => {
    if (index !== latestUserMessageIndex) {
      return message;
    }

    return withResolvedMediaPaths({
      ...message,
      mediaPaths: normalizeMediaPaths([
        ...getMessageMediaPaths(message),
        ...mediaPathsToAppend,
      ]),
    });
  });
}

function assertMultimodalReadyForMediaPaths(
  mediaPaths: readonly string[],
  readiness: LlmChatCompletionOptions['multimodalReadiness'],
  mediaPathOccurrenceCount = mediaPaths.length,
  expectedModelId?: string | null,
): void {
  if (mediaPathOccurrenceCount === 0) {
    return;
  }

  if (mediaPathOccurrenceCount > MAX_CHAT_IMAGE_ATTACHMENTS) {
    throw new AppError('chat_attachment_limit_exceeded', 'Too many image attachments.', {
      details: {
        mediaPathCount: mediaPathOccurrenceCount,
        limit: MAX_CHAT_IMAGE_ATTACHMENTS,
      },
    });
  }

  if (
    readiness?.status === 'ready'
    && readiness.support.includes('vision')
    && (!expectedModelId || readiness.modelId === expectedModelId)
  ) {
    return;
  }

  throw new AppError('multimodal_not_ready', 'Vision chat is not ready for image attachments.', {
    details: {
      readinessStatus: readiness?.status ?? 'unknown',
      readinessModelId: readiness?.modelId,
      expectedModelId: expectedModelId ?? undefined,
      mediaPathCount: mediaPathOccurrenceCount,
    },
  });
}

function getSanitizedTemplateFormatterErrorMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorType: error.name || 'Error',
      hasMessage: error.message.length > 0,
    };
  }

  return {
    errorType: typeof error,
  };
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
    const normalizedMessage = withResolvedMediaPaths(message);
    if (merged.length === 0) {
      merged.push(normalizedMessage);
      continue;
    }

    const lastMessage = merged[merged.length - 1];
    if (lastMessage.role === message.role) {
      const mediaPaths = normalizeMediaPaths([
        ...getMessageMediaPaths(lastMessage),
        ...getMessageMediaPaths(normalizedMessage),
      ]);
      merged[merged.length - 1] = {
        ...lastMessage,
        role: lastMessage.role,
        content: `${lastMessage.content}\n\n${normalizedMessage.content}`,
        attachments: [
          ...(lastMessage.attachments ?? []),
          ...(normalizedMessage.attachments ?? []),
        ],
        ...(mediaPaths.length > 0 ? { mediaPaths } : null),
      };
      continue;
    }

    merged.push(normalizedMessage);
  }

  return merged;
}

function readFormattedChatType(formatted: unknown): string | null {
  if (!formatted || typeof formatted !== 'object') {
    return null;
  }

  const formattedType = (formatted as { type?: unknown }).type;
  if (typeof formattedType !== 'string') {
    return null;
  }

  const normalizedType = formattedType.trim();
  return normalizedType.length > 0 ? normalizedType : null;
}

function resolveStrictRoleSystemNormalization(formatted: unknown): StrictRoleSystemNormalization {
  if (!formatted || typeof formatted !== 'object') {
    return 'plain';
  }

  const formattedType = readFormattedChatType(formatted);
  if (formattedType === 'jinja') {
    return 'plain';
  }

  const formattedResult = formatted as { prompt?: unknown };
  const prompt = typeof formattedResult.prompt === 'string' ? formattedResult.prompt : '';
  const hasLlamaSystemBlock = /\[INST\][\s\S]*<<SYS>>[\s\S]*<<\/SYS>>/.test(prompt)
    || /^\s*<<SYS>>[\s\S]*<<\/SYS>>/.test(prompt);

  return hasLlamaSystemBlock
    ? 'llama'
    : 'plain';
}

function normalizeMessagesForStrictRoleAlternation(
  messages: LlmChatMessage[],
  options: { systemNormalization?: StrictRoleSystemNormalization } = {},
): LlmChatMessage[] {
  const systemNormalization = options.systemNormalization ?? 'plain';
  const systemParts: string[] = [];
  const nonSystemMessages: LlmChatMessage[] = [];

  for (const message of messages) {
    const content = message.content ?? '';
    const mediaPaths = getMessageMediaPaths(message);
    if (content.trim().length === 0 && mediaPaths.length === 0) {
      continue;
    }

    if (message.role === 'system') {
      if (content.trim().length > 0) {
        systemParts.push(content);
      }
      continue;
    }

    nonSystemMessages.push(withResolvedMediaPaths({ ...message, content }));
  }

  let merged = mergeConsecutiveMessages(nonSystemMessages);

  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged = merged.slice(1);
  }

  const systemContent = systemParts.join('\n\n');
  const trimmedSystemContent = systemContent.trim();
  if (trimmedSystemContent.length > 0) {
    const normalizedSystemContent = systemNormalization === 'llama'
      ? (() => {
          const sysWrappedRegex = /^\s*<<SYS>>[\s\S]*<<\/SYS>>\s*$/;
          const isAlreadyWrapped = sysWrappedRegex.test(trimmedSystemContent);
          const cleanedSystemContent = isAlreadyWrapped
            ? trimmedSystemContent
            : trimmedSystemContent
                .replace(/<<SYS>>/g, '')
                .replace(/<<\/SYS>>/g, '')
                .trim();

          if (cleanedSystemContent.length === 0) {
            return '';
          }

          return isAlreadyWrapped
            ? cleanedSystemContent
            : `<<SYS>>\n${cleanedSystemContent}\n<</SYS>>`;
        })()
      : trimmedSystemContent;

    if (normalizedSystemContent.length === 0) {
      return mergeConsecutiveMessages(merged);
    }

    if (merged.length === 0) {
      merged = [{ role: 'user', content: normalizedSystemContent }];
    } else if (merged[0].role === 'user') {
      merged[0] = { ...merged[0], role: 'user', content: `${normalizedSystemContent}\n\n${merged[0].content}` };
    } else {
      merged.unshift({ role: 'user', content: normalizedSystemContent });
    }
  }

  return mergeConsecutiveMessages(merged);
}

class LLMEngineService {
  private context: LlamaContext | null = null;
  private contextGeneration = 0;
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
  private additionalStopWordsCache: Map<string, TemplateAdditionalStopWordsResolution> = new Map();
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
  private contextOperationRunner = new ContextOperationRunner();
  private completionRunner = new ActiveCompletionRunner<NativeCompletionResult>();
  private isUnloading = false;
  private activeCalibrationSession: CalibrationSession | null = null;
  private loadedArtifactIdentity: LoadedModelArtifactIdentity | null = null;
  private activeMultimodalContext: ActiveMultimodalContext | null = null;
  private pendingMultimodalReadinessRefresh: {
    modelId: string;
    context: LlamaContext;
    useGpu: boolean;
  } | null = null;
  private pendingMultimodalReadinessRefreshPromise: Promise<void> | null = null;
  private deferredContextReleasePromise: Promise<void> | null = null;
  private lastLifecycleEvent: EngineLifecycleEvent | null = null;
  private lastLifecycleError: string | null = null;
  private recentMultimodalDiagnostics: MultimodalDiagnosticsSummary | null = null;

  private get contextOperationQueue(): Promise<void> {
    return this.contextOperationRunner.queue;
  }

  private set contextOperationQueue(value: Promise<void>) {
    this.contextOperationRunner.queue = value;
  }

  private get activeContextOperationPromises(): Set<Promise<unknown>> {
    return this.contextOperationRunner.activePromises;
  }

  private get activeContextOperationRejects(): Map<Promise<unknown>, (error: unknown) => void> {
    return this.contextOperationRunner.activeRejects;
  }

  private get contextOperationCancelGeneration(): number {
    return this.contextOperationRunner.cancelGeneration;
  }

  private set contextOperationCancelGeneration(value: number) {
    this.contextOperationRunner.cancelGeneration = value;
  }

  private get activeCompletionPromise(): Promise<NativeCompletionResult> | null {
    return this.completionRunner.activePromise;
  }

  private get activeCompletionDriverPromise(): Promise<unknown> | null {
    return this.completionRunner.getActiveDriverPromise();
  }

  private set activeCompletionPromise(value: Promise<NativeCompletionResult> | null) {
    this.completionRunner.activePromise = value;
    if (value === null) {
      this.completionRunner.activeDriverPromise = null;
    }
  }

  private get activeCompletionReject(): ((error: unknown) => void) | null {
    return this.completionRunner.activeReject;
  }

  private set activeCompletionReject(value: ((error: unknown) => void) | null) {
    this.completionRunner.activeReject = value;
  }

  private get completionInterruptGeneration(): number {
    return this.completionRunner.interruptGeneration;
  }

  private set completionInterruptGeneration(value: number) {
    this.completionRunner.interruptGeneration = value;
  }

  constructor() {
    this.hwUnsubscribe = hardwareListenerService.subscribe((status) => {
      if (status.isLowMemory && this.context) {
        this.handleLowMemoryUnload();
      }
    });
  }

  private handleLowMemoryUnload(): void {
    if (!this.context || this.isUnloading) {
      return;
    }

    if (process.env.NODE_ENV !== 'test') {
      console.warn('[LLMEngine] Low memory warning - unloading model');
    }

    void this.unload().catch((error) => {
      const appError = toAppError(error, 'action_failed');
      this.lastLifecycleEvent = 'low_memory_unload_failed';
      this.lastLifecycleError = appError.message;
      this.updateState({
        ...this.state,
        status: EngineStatus.ERROR,
        lastError: appError.message,
      });

      if (process.env.NODE_ENV !== 'test') {
        console.warn('[LLMEngine] Failed to unload model after low memory warning', buildSafeErrorLogDetails(error));
      }
    });
  }

  private setContext(context: LlamaContext | null): void {
    if (this.context !== context) {
      this.activeMultimodalContext = null;
      this.pendingMultimodalReadinessRefresh = null;
    }
    this.context = context;
    this.contextGeneration += 1;
    this.additionalStopWordsCache.clear();
  }

  private toPositiveByteCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.round(value)
      : null;
  }

  private normalizeArtifactString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private toArtifactTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : null;
  }

  private resolveArtifactFallbackDownloadMarker(model: ModelMetadata): number | null {
    return this.toArtifactTimestamp(model.downloadIntegrity?.checkedAt)
      ?? this.toArtifactTimestamp(model.downloadedAt);
  }

  private buildLoadedModelArtifactIdentity({
    localPath,
    resolvedArtifactInfo,
    fallbackDownloadMarker,
  }: {
    localPath: string;
    resolvedArtifactInfo: ResolvedModelArtifactInfo;
    fallbackDownloadMarker: number | null;
  }): LoadedModelArtifactIdentity {
    const modificationTime = this.toArtifactTimestamp(resolvedArtifactInfo.fileInfo.modificationTime);

    return {
      localPath: this.normalizeArtifactString(localPath),
      resolvedPath: this.normalizeArtifactString(resolvedArtifactInfo.modelPath),
      sizeBytes: this.toPositiveByteCount(resolvedArtifactInfo.fileInfo.size),
      modificationTime,
      fallbackDownloadMarker: modificationTime === null ? fallbackDownloadMarker : null,
    };
  }

  private areLoadedModelArtifactIdentitiesEqual(
    previous: LoadedModelArtifactIdentity | null,
    current: LoadedModelArtifactIdentity,
  ): boolean {
    return previous !== null
      && previous.localPath === current.localPath
      && previous.resolvedPath === current.resolvedPath
      && previous.sizeBytes === current.sizeBytes
      && previous.modificationTime === current.modificationTime
      && previous.fallbackDownloadMarker === current.fallbackDownloadMarker;
  }

  private buildActiveMultimodalContext({
    modelId,
    projector,
    resolvedProjector,
  }: {
    modelId: string;
    projector: ProjectorArtifact;
    resolvedProjector: ResolvedProjectorArtifactInfo;
  }): ActiveMultimodalContext {
    const modificationTime = this.toArtifactTimestamp(resolvedProjector.fileInfo.modificationTime);

    return {
      modelId,
      projectorId: projector.id,
      projectorRepoId: this.normalizeArtifactString(projector.repoId),
      projectorOwnerVariantId: this.normalizeArtifactString(projector.ownerVariantId),
      projectorFileName: this.normalizeArtifactString(projector.fileName),
      projectorDownloadUrl: this.normalizeArtifactString(projector.downloadUrl),
      projectorHfRevision: this.normalizeArtifactString(projector.hfRevision),
      projectorSha256: this.normalizeArtifactString(projector.sha256),
      projectorLocalPath: this.normalizeArtifactString(resolvedProjector.localPath),
      projectorResolvedPath: this.normalizeArtifactString(resolvedProjector.projectorPath),
      projectorSizeBytes: this.toPositiveByteCount(resolvedProjector.fileInfo.size),
      projectorModificationTime: modificationTime,
      projectorFallbackMarker: modificationTime === null
        ? this.resolveProjectorFallbackMarker(projector, resolvedProjector)
        : null,
    };
  }

  private resolveProjectorFallbackMarker(
    projector: ProjectorArtifact,
    resolvedProjector: ResolvedProjectorArtifactInfo,
  ): string {
    return JSON.stringify([
      this.normalizeArtifactString(projector.sha256),
      this.normalizeArtifactString(projector.downloadUrl),
      this.normalizeArtifactString(projector.hfRevision),
      this.normalizeArtifactString(projector.fileName),
      this.normalizeArtifactString(projector.repoId),
      this.normalizeArtifactString(projector.ownerModelId),
      this.normalizeArtifactString(projector.ownerVariantId),
      this.normalizeArtifactString(resolvedProjector.localPath),
      this.normalizeArtifactString(resolvedProjector.projectorPath),
    ]);
  }

  private isActiveMultimodalContextForResolvedProjector({
    activeMultimodalContext,
    modelId,
    projector,
    resolvedProjector,
  }: {
    activeMultimodalContext: ActiveMultimodalContext | null;
    modelId: string;
    projector: ProjectorArtifact;
    resolvedProjector: ResolvedProjectorArtifactInfo;
  }): boolean {
    if (!activeMultimodalContext) {
      return false;
    }

    const current = this.buildActiveMultimodalContext({ modelId, projector, resolvedProjector });
    return activeMultimodalContext.modelId === current.modelId
      && activeMultimodalContext.projectorId === current.projectorId
      && activeMultimodalContext.projectorLocalPath === current.projectorLocalPath
      && activeMultimodalContext.projectorResolvedPath === current.projectorResolvedPath
      && activeMultimodalContext.projectorSizeBytes === current.projectorSizeBytes
      && activeMultimodalContext.projectorModificationTime === current.projectorModificationTime
      && activeMultimodalContext.projectorFallbackMarker === current.projectorFallbackMarker;
  }

  private isMultimodalReadinessInitializationCurrent({
    modelId,
    context,
    cancellation,
  }: {
    modelId: string;
    context: LlamaContext;
    cancellation?: ContextOperationCancellationToken;
  }): boolean {
    return cancellation?.isCancelled() !== true
      && !this.isUnloading
      && this.context === context
      && this.state.activeModelId === modelId
      && (
        this.state.status === EngineStatus.READY
        || this.state.status === EngineStatus.INITIALIZING
      );
  }

  private resolveSnapshotAppUsedBytes(snapshot: SystemMemorySnapshot | null): number | null {
    if (!snapshot) {
      return null;
    }

    return this.toPositiveByteCount(snapshot.appUsedBytes)
      ?? this.toPositiveByteCount(snapshot.appPssBytes)
      ?? this.toPositiveByteCount(snapshot.appResidentBytes);
  }

  private resolveObservedLoadResidentDelta(session: CalibrationSession | null): number | null {
    if (!session?.beforeLoadSnapshot) {
      return null;
    }

    const afterLoadSnapshot = session.afterFirstTokenSnapshot ?? session.afterModelInitSnapshot;
    const beforeLoadBytes = this.resolveSnapshotAppUsedBytes(session.beforeLoadSnapshot);
    const afterLoadBytes = this.resolveSnapshotAppUsedBytes(afterLoadSnapshot);
    if (beforeLoadBytes === null || afterLoadBytes === null) {
      return null;
    }

    return this.toPositiveByteCount(afterLoadBytes - beforeLoadBytes);
  }

  private resolvePredictedLoadResidentBytes(predictedFit: MemoryFitResult | null): number | null {
    if (!predictedFit) {
      return null;
    }

    const withoutSafetyMargin = predictedFit.requiredBytes - Math.max(0, predictedFit.breakdown.safetyMarginBytes);
    return this.toPositiveByteCount(withoutSafetyMargin);
  }

  private resolveActiveContextEstimatedReclaimableBytes(): {
    bytes: number;
    source: ModelUnloadReclaimEstimate['source'];
  } | null {
    const session = this.activeCalibrationSession;
    const observedBytes = this.resolveObservedLoadResidentDelta(session);
    if (observedBytes !== null) {
      return { bytes: observedBytes, source: 'observed_load_delta' };
    }

    const predictedBytes = this.resolvePredictedLoadResidentBytes(session?.predictedFit ?? null);
    if (predictedBytes !== null) {
      return { bytes: predictedBytes, source: 'predicted_load_footprint' };
    }

    return null;
  }

  private resolveObservedFreedBytes(
    beforeUnloadSnapshot: SystemMemorySnapshot | null,
    afterUnloadSnapshot: SystemMemorySnapshot | null,
  ): number {
    if (!beforeUnloadSnapshot || !afterUnloadSnapshot) {
      return 0;
    }

    const beforeAppBytes = this.resolveSnapshotAppUsedBytes(beforeUnloadSnapshot);
    const afterAppBytes = this.resolveSnapshotAppUsedBytes(afterUnloadSnapshot);
    const appDropBytes = beforeAppBytes !== null && afterAppBytes !== null
      ? Math.max(0, beforeAppBytes - afterAppBytes)
      : 0;
    const availableGainBytes = Math.max(0, afterUnloadSnapshot.availableBytes - beforeUnloadSnapshot.availableBytes);

    return Math.round(Math.max(appDropBytes, availableGainBytes));
  }

  private buildModelUnloadReclaimEstimate({
    previousModelId,
    estimatedReclaimableBytes,
    source,
    beforeUnloadSnapshot,
    afterUnloadSnapshot,
  }: {
    previousModelId: string | null;
    estimatedReclaimableBytes: number;
    source: ModelUnloadReclaimEstimate['source'];
    beforeUnloadSnapshot: SystemMemorySnapshot | null;
    afterUnloadSnapshot: SystemMemorySnapshot | null;
  }): ModelUnloadReclaimEstimate | null {
    if (!beforeUnloadSnapshot || !afterUnloadSnapshot) {
      return null;
    }

    if (afterUnloadSnapshot?.lowMemory === true || afterUnloadSnapshot?.pressureLevel === 'critical') {
      return null;
    }

    const totalBytes = this.toPositiveByteCount(afterUnloadSnapshot?.totalBytes)
      ?? this.toPositiveByteCount(beforeUnloadSnapshot?.totalBytes)
      ?? 0;
    const maxReclaimableBytes = totalBytes > 0
      ? Math.round(totalBytes * MAX_UNLOAD_RECLAIM_FRACTION_OF_TOTAL_MEMORY)
      : estimatedReclaimableBytes;
    const observedFreedBytes = this.resolveObservedFreedBytes(beforeUnloadSnapshot, afterUnloadSnapshot);
    const remainingReclaimableBytes = Math.max(0, estimatedReclaimableBytes - observedFreedBytes);
    const budgetReclaimableBytes = Math.min(remainingReclaimableBytes, maxReclaimableBytes);

    if (!Number.isFinite(budgetReclaimableBytes) || budgetReclaimableBytes <= 0) {
      return null;
    }

    return {
      previousModelId,
      source,
      estimatedReclaimableBytes: Math.round(estimatedReclaimableBytes),
      budgetReclaimableBytes: Math.round(budgetReclaimableBytes),
      observedFreedBytes,
      beforeUnloadSnapshot,
      afterUnloadSnapshot,
    };
  }

  private withRecentUnloadReclaimableBudget(
    snapshot: SystemMemorySnapshot | null,
    recentUnloadReclaim: ModelUnloadReclaimEstimate | null,
  ): SystemMemorySnapshot | null {
    if (!snapshot || !recentUnloadReclaim || recentUnloadReclaim.budgetReclaimableBytes <= 0) {
      return snapshot;
    }

    if (snapshot.lowMemory || snapshot.pressureLevel === 'critical') {
      return snapshot;
    }

    return {
      ...snapshot,
      reclaimableBytes: recentUnloadReclaim.budgetReclaimableBytes,
    };
  }

  private summarizeRecentUnloadReclaim(
    recentUnloadReclaim: ModelUnloadReclaimEstimate | null,
  ): Record<string, unknown> | undefined {
    if (!recentUnloadReclaim) {
      return undefined;
    }

    return {
      previousModelId: recentUnloadReclaim.previousModelId,
      source: recentUnloadReclaim.source,
      estimatedReclaimableBytes: recentUnloadReclaim.estimatedReclaimableBytes,
      budgetReclaimableBytes: recentUnloadReclaim.budgetReclaimableBytes,
      observedFreedBytes: recentUnloadReclaim.observedFreedBytes,
      hasBeforeUnloadSnapshot: recentUnloadReclaim.beforeUnloadSnapshot !== null,
      hasAfterUnloadSnapshot: recentUnloadReclaim.afterUnloadSnapshot !== null,
    };
  }

  private getReadyContextOrThrow(): { context: LlamaContext; generation: number } {
    if (this.isUnloading) {
      throw new AppError('engine_unloading', 'The model engine is unloading. Please wait a moment.');
    }

    const context = this.context;
    if (!context || this.state.status !== EngineStatus.READY) {
      throw new AppError('engine_not_ready', 'Engine not ready');
    }

    return { context, generation: this.contextGeneration };
  }

  private assertContextStillCurrent(context: LlamaContext, generation: number): void {
    if (this.isUnloading) {
      throw new AppError('engine_unloading', 'The model engine is unloading. Please wait a moment.');
    }

    if (this.context !== context || this.contextGeneration !== generation || this.state.status !== EngineStatus.READY) {
      throw new AppError('engine_not_ready', 'Engine context changed during operation');
    }
  }

  private assertCompletionNotInterrupted(generation: number): void {
    this.completionRunner.assertNotInterrupted(
      generation,
      () => new AppError('engine_not_ready', 'Completion was interrupted before generation started'),
    );
  }

  private trackContextOperation<T>(
    operation: (cancellation: ContextOperationCancellationToken) => Promise<T>,
    options: { readonly chatBlocking?: boolean } = {},
  ): Promise<T> {
    return this.contextOperationRunner.track(
      operation,
      () => new AppError('engine_unloading', CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE),
      options,
    );
  }

  private waitForActiveContextOperations(options: { timeoutMs?: number } = {}): Promise<ContextOperationDrainResult> {
    return this.contextOperationRunner.waitForActive(options);
  }

  public hasActiveContextOperation(): boolean {
    return this.contextOperationRunner.hasActive();
  }

  public hasActiveChatBlockingContextOperation(): boolean {
    return this.contextOperationRunner.hasActiveChatBlocking();
  }

  public async cancelActiveContextOperations(options: { timeoutMs?: number } = {}): Promise<ContextOperationDrainResult> {
    this.contextOperationRunner.cancelActive(
      new AppError('engine_busy', CONTEXT_OPERATION_STOP_MESSAGE),
    );
    return this.waitForActiveContextOperations({
      timeoutMs: options.timeoutMs ?? CONTEXT_OPERATION_STOP_DRAIN_TIMEOUT_MS,
    });
  }

  private isContextOperationStopError(error: unknown): boolean {
    return error instanceof AppError
      && error.code === 'engine_busy'
      && error.message === CONTEXT_OPERATION_STOP_MESSAGE;
  }

  private async preemptBackgroundContextOperationsForCompletion(): Promise<void> {
    this.contextOperationRunner.cancelActive(
      new AppError('engine_busy', CONTEXT_OPERATION_STOP_MESSAGE),
      { chatBlocking: false },
    );
    const drainResult = await this.waitForActiveContextOperations({
      timeoutMs: CONTEXT_OPERATION_STOP_DRAIN_TIMEOUT_MS,
    });

    if (drainResult === 'timed_out') {
      throw new AppError('engine_busy', CONTEXT_OPERATION_COMPLETION_DRAIN_TIMEOUT_MESSAGE);
    }
  }

  private waitForUnloadPromise(
    promise: Promise<unknown>,
    timeoutMs: number,
  ): Promise<ContextOperationDrainResult> {
    return waitForPromiseWithTimeout(promise, timeoutMs);
  }

  private async waitForDeferredContextReleaseDrain(
    drainPromise: Promise<unknown>,
    timeoutMessage: string,
  ): Promise<void> {
    const drainResult = await this.waitForUnloadPromise(
      drainPromise.catch(() => undefined),
      CONTEXT_OPERATION_UNLOAD_DRAIN_TIMEOUT_MS,
    );

    if (drainResult !== 'timed_out') {
      return;
    }

    const timeoutError = new AppError('engine_unloading', timeoutMessage);
    this.contextOperationRunner.reset(timeoutError);
    this.completionRunner.reset();

    if (process.env.NODE_ENV !== 'test') {
      console.warn('[LLMEngine] Deferred context release drain timed out; forcing context release', {
        message: timeoutMessage,
      });
    }
  }

  private recordContextOperationUnloadTimeout(activeModelId: string | null): AppError {
    this.lastLifecycleEvent = 'context_operation_unload_timeout';
    this.lastLifecycleError = CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE;
    const timeoutError = new AppError('engine_unloading', CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE);
    this.contextOperationRunner.cancelActive(timeoutError);
    this.updateState({
      ...this.state,
      status: EngineStatus.ERROR,
      activeModelId: activeModelId ?? this.state.activeModelId,
      loadProgress: 0,
      lastError: CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE,
    });

    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[LLMEngine] ${CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE}`);
    }

    return timeoutError;
  }

  private recordActiveCompletionUnloadTimeout(activeModelId: string | null): AppError {
    this.lastLifecycleEvent = 'active_completion_unload_timeout';
    this.lastLifecycleError = ACTIVE_COMPLETION_UNLOAD_TIMEOUT_MESSAGE;
    const timeoutError = new AppError('engine_unloading', ACTIVE_COMPLETION_UNLOAD_TIMEOUT_MESSAGE);
    this.completionRunner.rejectActive(
      timeoutError,
    );
    this.updateState({
      ...this.state,
      status: EngineStatus.ERROR,
      activeModelId: activeModelId ?? this.state.activeModelId,
      loadProgress: 0,
      lastError: ACTIVE_COMPLETION_UNLOAD_TIMEOUT_MESSAGE,
    });

    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[LLMEngine] ${ACTIVE_COMPLETION_UNLOAD_TIMEOUT_MESSAGE}`);
    }

    return timeoutError;
  }

  private scheduleDeferredContextReleaseAfterCompletionDrain({
    drainPromise,
    context,
    generation,
  }: {
    drainPromise: Promise<unknown>;
    context: LlamaContext;
    generation: number;
  }): void {
    if (this.deferredContextReleasePromise) {
      return;
    }

    const deferredRelease = this.waitForDeferredContextReleaseDrain(
      drainPromise,
      ACTIVE_COMPLETION_UNLOAD_TIMEOUT_MESSAGE,
    )
      .then(() => this.runExclusiveOperation(async () => {
        if (this.context !== context || this.contextGeneration !== generation) {
          return;
        }

        await this.unloadInternal();
        this.lastLifecycleEvent = 'active_completion_unload_timeout';
        this.lastLifecycleError = ACTIVE_COMPLETION_UNLOAD_TIMEOUT_MESSAGE;
        this.updateState(this.state);
      }))
      .catch((error) => {
        if (process.env.NODE_ENV !== 'test') {
          console.warn(
            '[LLMEngine] Deferred context release after active completion unload timeout failed',
            buildSafeErrorLogDetails(error),
          );
        }
      })
      .finally(() => {
        if (this.deferredContextReleasePromise === deferredRelease) {
          this.deferredContextReleasePromise = null;
        }
      });

    this.deferredContextReleasePromise = deferredRelease;
  }

  private cancelActiveContextOperationsForDeferredUnload(error: unknown): Promise<void> {
    this.contextOperationRunner.cancelActive(error);
    return this.waitForActiveContextOperations().then(() => undefined);
  }

  private scheduleDeferredContextReleaseAfterDrain({
    context,
    generation,
  }: {
    context: LlamaContext;
    generation: number;
  }): void {
    if (this.deferredContextReleasePromise) {
      return;
    }

    const deferredRelease = this.waitForDeferredContextReleaseDrain(
      this.waitForActiveContextOperations(),
      CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE,
    )
      .then(() => this.runExclusiveOperation(async () => {
        if (this.context !== context || this.contextGeneration !== generation) {
          return;
        }

        await this.unloadInternal();
        this.lastLifecycleEvent = 'context_operation_unload_timeout';
        this.lastLifecycleError = CONTEXT_OPERATION_UNLOAD_TIMEOUT_MESSAGE;
        this.updateState(this.state);
      }))
      .catch((error) => {
        if (process.env.NODE_ENV !== 'test') {
          console.warn(
            '[LLMEngine] Deferred context release after unload timeout failed',
            buildSafeErrorLogDetails(error),
          );
        }
      })
      .finally(() => {
        if (this.deferredContextReleasePromise === deferredRelease) {
          this.deferredContextReleasePromise = null;
        }
      });

    this.deferredContextReleasePromise = deferredRelease;
  }

  private buildAdditionalStopWordsCacheKey({
    generation,
    messages,
    enableThinking,
    reasoningFormat,
  }: {
    generation: number;
    messages: LlmChatMessage[];
    enableThinking: boolean;
    reasoningFormat: ChatCompletionReasoningFormat;
  }): string {
    return [
      this.state.activeModelId ?? 'unknown-model',
      generation,
      enableThinking ? 'thinking:on' : 'thinking:off',
      `reasoning:${reasoningFormat}`,
      'generation-prompt:on',
      `messages:${this.buildChatMessagesCacheSignature(messages)}`,
    ].join('|');
  }

  private buildChatMessagesCacheSignature(messages: LlmChatMessage[]): string {
    let hash = 2166136261;
    for (const message of messages) {
      hash = this.updateCacheHash(hash, message.role);
      hash = this.updateCacheHash(hash, '\u0000');
      hash = this.updateCacheHash(hash, String(message.content.length));
      hash = this.updateCacheHash(hash, '\u0001');
      hash = this.updateCacheHash(hash, message.content);
      hash = this.updateCacheHash(hash, '\u0002');
      const mediaPaths = getMessageMediaPaths(message);
      hash = this.updateCacheHash(hash, String(mediaPaths.length));
      hash = this.updateCacheHash(hash, '\u0003');
      for (const mediaPath of mediaPaths) {
        hash = this.updateCacheHash(hash, mediaPath);
        hash = this.updateCacheHash(hash, '\u0004');
      }
    }

    return `${messages.length}:${hash.toString(36)}`;
  }

  private updateCacheHash(hash: number, value: string): number {
    let nextHash = hash >>> 0;
    for (let i = 0; i < value.length; i += 1) {
      nextHash ^= value.charCodeAt(i);
      nextHash = Math.imul(nextHash, 16777619) >>> 0;
    }
    return nextHash;
  }

  private normalizeAdditionalStopWords(stops: unknown[]): string[] {
    return Array.from(
      new Set(
        stops
          .filter((stop): stop is string => typeof stop === 'string')
          .map((stop) => stop.trim())
          .filter((stop) => stop.length > 0),
      ),
    );
  }

  private copyTemplateStopWordsResolution(
    resolution: TemplateAdditionalStopWordsResolution,
  ): TemplateAdditionalStopWordsResolution {
    return {
      stopWords: [...resolution.stopWords],
      strictRoleSystemNormalization: resolution.strictRoleSystemNormalization,
      templateType: resolution.templateType,
    };
  }

  private shouldIncludeFallbackStopWords(templateType: string | null, templateStopCount: number): boolean {
    if (templateStopCount === 0) {
      return true;
    }

    if (templateType === null) {
      return true;
    }

    const normalizedType = templateType.toLowerCase();
    return normalizedType === 'llama' || normalizedType === 'llama-chat';
  }

  private resolveCompletionStopWords(
    templateStopResolution: TemplateAdditionalStopWordsResolution,
  ): CompletionStopWordsResolution {
    const templateStops = templateStopResolution.stopWords;
    const shouldIncludeFallbackStops = this.shouldIncludeFallbackStopWords(
      templateStopResolution.templateType,
      templateStops.length,
    );
    const stopWords = Array.from(
      new Set(
        [
          ...(shouldIncludeFallbackStops ? FALLBACK_STOP_WORDS : []),
          ...templateStops,
        ]
          .map((stop) => stop.trim())
          .filter((stop) => stop.length > 0),
      ),
    );

    let source: StopWordsResolutionSource = 'template';
    if (shouldIncludeFallbackStops) {
      source = templateStops.length > 0 ? 'template_with_fallback' : 'fallback';
    }

    return {
      stopWords,
      source,
      templateType: templateStopResolution.templateType,
      templateStopCount: templateStops.length,
      fallbackStopCount: shouldIncludeFallbackStops ? FALLBACK_STOP_WORDS.length : 0,
    };
  }

  private recordResolvedCompletionStopWords(resolution: CompletionStopWordsResolution): void {
    performanceMonitor.mark('llm.stopWords.resolved', {
      modelId: this.state.activeModelId ?? 'unknown-model',
      source: resolution.source,
      templateType: resolution.templateType ?? 'unknown',
      templateStopCount: resolution.templateStopCount,
      fallbackStopCount: resolution.fallbackStopCount,
      stopCount: resolution.stopWords.length,
      resolvedStops: resolution.stopWords,
    });
  }

  private async resolveTemplateAdditionalStopWords({
    context,
    generation,
    messages,
    enableThinking,
    reasoningFormat,
  }: {
    context: LlamaContext;
    generation: number;
    messages: LlmChatMessage[];
    enableThinking: boolean;
    reasoningFormat: ChatCompletionReasoningFormat;
  }): Promise<TemplateAdditionalStopWordsResolution> {
    const cacheKey = this.buildAdditionalStopWordsCacheKey({
      generation,
      messages,
      enableThinking,
      reasoningFormat,
    });
    const cached = this.additionalStopWordsCache.get(cacheKey);
    if (cached) {
      this.assertContextStillCurrent(context, generation);
      return this.copyTemplateStopWordsResolution(cached);
    }

    try {
      this.assertContextStillCurrent(context, generation);
      const formatted = await getFormattedChatFromContext({
        context,
        messages,
        options: {
          enable_thinking: enableThinking,
          reasoning_format: reasoningFormat,
          add_generation_prompt: true,
        },
      });
      this.assertContextStillCurrent(context, generation);

      const normalizedStops = this.normalizeAdditionalStopWords(formatted.additional_stops);
      const resolution: TemplateAdditionalStopWordsResolution = {
        stopWords: normalizedStops,
        strictRoleSystemNormalization: resolveStrictRoleSystemNormalization(formatted),
        templateType: readFormattedChatType(formatted),
      };
      this.additionalStopWordsCache.set(cacheKey, resolution);
      if (this.additionalStopWordsCache.size > MAX_ADDITIONAL_STOP_WORDS_CACHE_ENTRIES) {
        const oldestCacheKey = this.additionalStopWordsCache.keys().next().value;
        if (oldestCacheKey) {
          this.additionalStopWordsCache.delete(oldestCacheKey);
        }
      }
      return this.copyTemplateStopWordsResolution(resolution);
    } catch (error) {
      this.assertContextStillCurrent(context, generation);
      if (process.env.NODE_ENV !== 'test') {
        console.warn(
          '[LLMEngine] Failed to resolve template stop tokens',
          getSanitizedTemplateFormatterErrorMetadata(error),
        );
      }
      return {
        stopWords: [],
        strictRoleSystemNormalization: 'plain',
        templateType: null,
      };
    }
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
    multimodalSizeBytes,
    hasMmproj = false,
    preferGpuLayers = false,
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
    multimodalSizeBytes?: number;
    hasMmproj?: boolean;
    preferGpuLayers?: boolean;
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
      const cacheKey = `${normalizedContext}:${normalizedGpuLayers}:${cacheTypeK}:${cacheTypeV}:${useMmap ? 'mmap' : 'nommap'}:${hasMmproj ? 'mmproj' : 'text'}:${multimodalSizeBytes ?? 0}`;
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
            hasMmproj,
            nBatch: lowMemoryBatchParams?.nBatch,
            nUbatch: lowMemoryBatchParams?.nUbatch,
          })
        : null;
      const calibrationRecord = calibrationKey ? registry.getCalibrationRecord(calibrationKey) : undefined;

      const fit = estimateAccurateMemoryFit({
        input: {
          modelSizeBytes: resolvedModelSizeBytes,
          verifiedFileSizeBytes: verifiedFileSizeBytes ?? undefined,
          ...(multimodalSizeBytes ? { multimodalSizeBytes } : null),
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

    let bestGpuLayers = 0;
    let bestContextTokens = MIN_CONTEXT_WINDOW_TOKENS;

    if (preferGpuLayers && normalizedGpuCeiling > 0) {
      for (let gpuLayers = normalizedGpuCeiling; gpuLayers >= 1; gpuLayers -= 1) {
        const minFit = estimateFit(MIN_CONTEXT_WINDOW_TOKENS, gpuLayers);
        if (!fitsBudget(minFit)) {
          continue;
        }

        bestGpuLayers = gpuLayers;
        bestContextTokens = solveMaxContextForGpuLayers(gpuLayers);
        break;
      }
    }

    if (bestGpuLayers === 0) {
      const contextOptimizedCandidate = chooseSafeLoadProfileCandidate(
        buildIntermediateGpuLayerCandidates(normalizedGpuCeiling).map((gpuLayers) => ({
          contextTokens: solveMaxContextForGpuLayers(gpuLayers),
          gpuLayers,
        })),
      );
      bestContextTokens = contextOptimizedCandidate.contextTokens;

      if (normalizedGpuCeiling > 0) {
        for (let gpuLayers = normalizedGpuCeiling; gpuLayers >= 0; gpuLayers -= 1) {
          if (fitsBudget(estimateFit(bestContextTokens, gpuLayers))) {
            bestGpuLayers = gpuLayers;
            break;
          }
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
      const fallbackDownloadMarker = this.resolveArtifactFallbackDownloadMarker(model);
      let resolvedArtifactInfo: ResolvedModelArtifactInfo | null = null;
      let isCurrentLoadedArtifact = false;
      if (this.state.activeModelId === modelId && !forceReload) {
        resolvedArtifactInfo = await resolveModelFilePathOrThrow({ modelId, localPath: model.localPath });
        const currentArtifactIdentity = this.buildLoadedModelArtifactIdentity({
          localPath: model.localPath,
          resolvedArtifactInfo,
          fallbackDownloadMarker,
        });
        isCurrentLoadedArtifact = this.areLoadedModelArtifactIdentitiesEqual(
          this.loadedArtifactIdentity,
          currentArtifactIdentity,
        );
      }
      const hasStaleLoadedContext = Boolean(
        this.context && (this.state.status !== EngineStatus.READY || !this.state.activeModelId),
      );
      const shouldUnloadActiveModel = hasStaleLoadedContext || Boolean(
        this.state.activeModelId && (this.state.activeModelId !== modelId || forceReload || !isCurrentLoadedArtifact),
      );

      if (
        this.state.status === EngineStatus.READY &&
        this.state.activeModelId === modelId &&
        !forceReload &&
        isCurrentLoadedArtifact
      ) {
        if (this.context) {
          const refreshRequest = {
            modelId,
            context: this.context,
            useGpu: this.actualGpuAccelerated === true,
          };
          if (this.activeCompletionPromise) {
            this.queueMultimodalReadinessRefreshAfterCompletion(refreshRequest);
          } else {
            try {
              await this.trackContextOperation(async (cancellation) => {
                if (
                  cancellation.isCancelled()
                  || this.context !== refreshRequest.context
                  || this.state.activeModelId !== refreshRequest.modelId
                  || this.state.status !== EngineStatus.READY
                ) {
                  return;
                }

                await this.initializeMultimodalReadinessForLoadedContext(refreshRequest, cancellation);
              }, { chatBlocking: false });
            } catch (error) {
              if (!this.isContextOperationStopError(error) || !this.activeCompletionPromise) {
                throw error;
              }

              this.queueMultimodalReadinessRefreshAfterCompletion(refreshRequest);
            }
          }
        }
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

      let recentUnloadReclaim: ModelUnloadReclaimEstimate | null = null;
      if (shouldUnloadActiveModel) {
        recentUnloadReclaim = await this.unloadInternal();
      }

      this.initPromise = this.initializeModel(
        modelId,
        model.localPath,
        model.maxContextTokens,
        model.size ?? null,
        allowUnsafeMemoryLoad,
        options?.loadParamsOverride,
        options?.preferLastWorkingProfile === true,
        recentUnloadReclaim,
        fallbackDownloadMarker,
        resolvedArtifactInfo,
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
    mediaPaths,
    multimodalReadiness,
    onToken,
    params,
  }: LlmChatCompletionOptions): Promise<NativeCompletionResult> {
    if (this.isUnloading) {
      throw new AppError('engine_unloading', 'The model engine is unloading. Please wait a moment.');
    }

    if (this.completionRunner.hasActive()) {
      throw new AppError('engine_busy', 'A response is already being generated.');
    }

    const requestMessages = mergeTopLevelMediaPathsIntoLatestUserMessage(messages, mediaPaths);
    const requestMediaPaths = getMessagesMediaPaths(requestMessages);
    const requestMediaPathOccurrenceCount = countMergedRequestMediaPathOccurrences(messages, mediaPaths);
    const shouldRecordMultimodalDiagnostics = requestMediaPaths.length > 0
      || (multimodalReadiness !== undefined && multimodalReadiness.status !== 'ready');
    if (shouldRecordMultimodalDiagnostics) {
      this.recordRecentMultimodalDiagnostics({
        messages: requestMessages,
        mediaPaths: requestMediaPaths,
        mediaPathOccurrenceCount: requestMediaPathOccurrenceCount,
        readiness: multimodalReadiness,
      });
    }
    try {
      assertMultimodalReadyForMediaPaths(
        requestMediaPaths,
        multimodalReadiness,
        requestMediaPathOccurrenceCount,
        this.state.activeModelId,
      );
    } catch (error) {
      this.recordRecentMultimodalDiagnostics({
        messages: requestMessages,
        mediaPaths: requestMediaPaths,
        mediaPathOccurrenceCount: requestMediaPathOccurrenceCount,
        readiness: multimodalReadiness,
        failureReason: multimodalReadiness?.failureReason ?? getErrorMessageText(error),
      });
      throw error;
    }

    let resolveCompletion!: (result: NativeCompletionResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completionTask = new Promise<NativeCompletionResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const interruptGeneration = this.completionRunner.start(completionTask, rejectCompletion);

    const completionDriver = (async () => {
      try {
        if (this.state.status === EngineStatus.INITIALIZING && this.initPromise) {
          await this.initPromise;
        }

        await this.preemptBackgroundContextOperationsForCompletion();

        const { context, generation: contextGeneration } = this.getReadyContextOrThrow();
        try {
          this.assertActiveMultimodalRuntimeReadyForMediaPaths(
            requestMediaPaths,
            multimodalReadiness,
            requestMediaPathOccurrenceCount,
          );
        } catch (error) {
          this.recordRecentMultimodalDiagnostics({
            messages: requestMessages,
            mediaPaths: requestMediaPaths,
            mediaPathOccurrenceCount: requestMediaPathOccurrenceCount,
            readiness: multimodalReadiness,
            failureReason: multimodalReadiness?.failureReason ?? getErrorMessageText(error),
          });
          throw error;
        }

        let hasStreamedTokens = false;
        const markTokensStreamed = () => {
          if (!hasStreamedTokens) {
            void this.captureAfterFirstTokenSnapshotIfNeeded();
          }
          hasStreamedTokens = true;
        };

        let strictRoleSystemNormalization: StrictRoleSystemNormalization = 'plain';
        const runCompletion = async (completionMessages: LlmChatMessage[], onTokensStreamed: () => void) => {
          this.assertCompletionNotInterrupted(interruptGeneration);
          const enableThinking = params?.enable_thinking ?? false;
          const reasoningFormat: ChatCompletionReasoningFormat = params?.reasoning_format ?? 'none';
          const templateStopResolution = await this.resolveTemplateAdditionalStopWords({
            context,
            generation: contextGeneration,
            messages: completionMessages,
            enableThinking,
            reasoningFormat,
          });
          strictRoleSystemNormalization = templateStopResolution.strictRoleSystemNormalization;
          this.assertCompletionNotInterrupted(interruptGeneration);

          const resolvedStops = this.resolveCompletionStopWords(templateStopResolution);
          this.recordResolvedCompletionStopWords(resolvedStops);

          const completionParams: CompletionParams = {
            messages: completionMessages,
            n_predict: params?.n_predict ?? 512,
            temperature: params?.temperature ?? 0.7,
            top_p: params?.top_p ?? 0.9,
            top_k: params?.top_k ?? 40,
            min_p: params?.min_p ?? 0.05,
            penalty_repeat: params?.penalty_repeat ?? 1,
            enable_thinking: enableThinking,
            reasoning_format: reasoningFormat,
            stop: resolvedStops.stopWords,
          };

          if (requestMediaPaths.length > 0) {
            completionParams.media_paths = requestMediaPaths;
          }

          if (typeof params?.seed === 'number' && Number.isFinite(params.seed)) {
            completionParams.seed = Math.round(params.seed);
          }

          // Explicitly clear the thinking budget whenever it is not set for this request so llama.rn never
          // reuses a previously-supplied value across completions. (`llama.rn` treats -1 as unset.)
          if (!enableThinking) {
            completionParams.thinking_budget_tokens = -1;
          } else if (typeof params?.thinking_budget_tokens === 'number' && Number.isFinite(params.thinking_budget_tokens)) {
            completionParams.thinking_budget_tokens = Math.max(0, Math.round(params.thinking_budget_tokens));
          } else {
            completionParams.thinking_budget_tokens = -1;
          }

          this.assertContextStillCurrent(context, contextGeneration);
          this.assertCompletionNotInterrupted(interruptGeneration);

          return await runCompletionOnContext({
            context,
            params: completionParams,
            onToken: (data) => {
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
          });
        };

        try {
          hasStreamedTokens = false;
          resolveCompletion(await runCompletion(requestMessages, markTokensStreamed));
        } catch (error) {
          if (isConversationAlternationError(error)) {
            if (hasStreamedTokens && onToken) {
              console.warn(
                '[LLMEngine] Conversation alternation error after streaming started; skipping retry to avoid duplicate output',
              );
              throw error;
            }

            console.warn('[LLMEngine] Retrying completion after normalizing chat roles for strict templates');
            const normalizedMessages = normalizeMessagesForStrictRoleAlternation(requestMessages, {
              systemNormalization: strictRoleSystemNormalization,
            });
            hasStreamedTokens = false;
            resolveCompletion(await runCompletion(normalizedMessages, markTokensStreamed));
            return;
          }

          throw error;
        }
      } catch (error) {
        if (requestMediaPaths.length > 0) {
          this.recordRecentMultimodalDiagnostics({
            messages: requestMessages,
            mediaPaths: requestMediaPaths,
            mediaPathOccurrenceCount: requestMediaPathOccurrenceCount,
            readiness: multimodalReadiness,
            failureReason: getErrorMessageText(error),
          });
        }
        rejectCompletion(error);
      } finally {
        this.completionRunner.clearIfActive(completionTask);
        if (this.pendingMultimodalReadinessRefresh) {
          this.schedulePendingMultimodalReadinessRefresh();
        }
      }
    })();
    this.completionRunner.attachDriver(completionTask, completionDriver);

    return completionTask;
  }

  private async probeThinkingCapability(context: LlamaContext): Promise<ModelThinkingCapabilitySnapshot | null> {
    const sampleMessages: LlmChatMessage[] = [{ role: 'user', content: 'ping' }];
    const shouldAbort = () => this.isUnloading || this.context !== context || this.activeCompletionPromise !== null;

    const safeFormat = async ({
      enableThinking,
      reasoningFormat,
    }: {
      enableThinking: boolean;
      reasoningFormat: 'none' | 'auto';
    }): Promise<LlamaFormattedChatResult | null> => {
      if (shouldAbort()) {
        return null;
      }

      try {
        const formatted = await getFormattedChatFromContext({
          context,
          messages: sampleMessages,
          options: {
            jinja: true,
            enable_thinking: enableThinking,
            reasoning_format: reasoningFormat,
            add_generation_prompt: true,
          },
        });

        if (shouldAbort()) {
          return null;
        }

        return formatted;
      } catch (error) {
        if (!shouldAbort() && process.env.NODE_ENV !== 'test') {
          console.warn('[LLMEngine] Failed to probe chat template thinking capability', buildSafeErrorLogDetails(error));
        }
        return null;
      }
    };

    const formattedOn = await safeFormat({ enableThinking: true, reasoningFormat: 'auto' });
    const formattedOff = await safeFormat({ enableThinking: false, reasoningFormat: 'none' });

    if (!formattedOn && !formattedOff) {
      return null;
    }

    const isJinjaResult = (value: LlamaFormattedChatResult | null): value is LlamaFormattedChatResult => {
      return value !== null && (
        value.type === 'jinja'
        || typeof value.thinking_start_tag === 'string'
        || typeof value.thinking_end_tag === 'string'
        || typeof value.thinking_forced_open === 'boolean'
      );
    };

    const detectThinkingTagsFromPrompt = (prompt: string) => {
      const candidates = [
        { start: '<think>', end: '</think>' },
        { start: '[THINK]', end: '[/THINK]' },
        { start: '<|start_thinking|>', end: '<|end_thinking|>' },
        { start: '<|channel>thought', end: '<channel|>' },
        { start: '<|channel|>thought', end: '<|end|>' },
      ] as const;

      for (const candidate of candidates) {
        if (prompt.includes(candidate.start)) {
          return candidate;
        }
      }

      return null;
    };

    const readPrompt = (value: LlamaFormattedChatResult | null): string | null => {
      return value ? value.prompt : null;
    };

    const promptOn = readPrompt(formattedOn);
    const promptOff = readPrompt(formattedOff);

    if (promptOn && promptOff) {
      const jinjaOn = isJinjaResult(formattedOn) ? formattedOn : null;
      const jinjaOff = isJinjaResult(formattedOff) ? formattedOff : null;

      if (jinjaOn && jinjaOff) {
        let thinkingStartTag = typeof jinjaOn?.thinking_start_tag === 'string' && jinjaOn.thinking_start_tag.trim().length > 0
          ? jinjaOn.thinking_start_tag
          : undefined;
        let thinkingEndTag = typeof jinjaOn?.thinking_end_tag === 'string' && jinjaOn.thinking_end_tag.trim().length > 0
          ? jinjaOn.thinking_end_tag
          : undefined;

        if (!thinkingStartTag && !thinkingEndTag) {
          const tagsFromPrompt = detectThinkingTagsFromPrompt(promptOn) ?? detectThinkingTagsFromPrompt(promptOff);
          if (tagsFromPrompt) {
            thinkingStartTag = tagsFromPrompt.start;
            thinkingEndTag = tagsFromPrompt.end;
          }
        }

        const supportsThinking = Boolean(thinkingStartTag) || Boolean(thinkingEndTag);
        if (!supportsThinking) {
          return null;
        }

        const canDisableThinking = typeof jinjaOff?.thinking_forced_open === 'boolean'
          ? !jinjaOff.thinking_forced_open
          : detectThinkingTagsFromPrompt(promptOff) === null;

        return {
          detectedAt: Date.now(),
          supportsThinking,
          canDisableThinking,
          ...(thinkingStartTag ? { thinkingStartTag } : {}),
          ...(thinkingEndTag ? { thinkingEndTag } : {}),
        };
      }

      const thinkingTagOn = detectThinkingTagsFromPrompt(promptOn);
      const thinkingTagOff = detectThinkingTagsFromPrompt(promptOff);

      if (thinkingTagOn || thinkingTagOff) {
        const resolvedThinkingTag = thinkingTagOn ?? thinkingTagOff!;

        return {
          detectedAt: Date.now(),
          supportsThinking: true,
          // For non-jinja formatting, infer whether thinking can be disabled by comparing the prompts.
          canDisableThinking: thinkingTagOff === null,
          thinkingStartTag: resolvedThinkingTag.start,
          thinkingEndTag: resolvedThinkingTag.end,
        };
      }
    }

    return null;
  }

  private launchThinkingCapabilityProbe(modelId: string): void {
    const contextAtProbeStart = this.context;
    const generationAtProbeStart = this.contextGeneration;

    if (!contextAtProbeStart) {
      return;
    }

    const isProbeStillCurrent = () => (
      this.context === contextAtProbeStart
      && this.contextGeneration === generationAtProbeStart
      && !this.isUnloading
      && this.state.status === EngineStatus.READY
      && this.state.activeModelId === modelId
    );

    void (async () => {
      try {
        const thinkingCapability = await this.probeThinkingCapability(contextAtProbeStart);
        if (thinkingCapability && isProbeStillCurrent()) {
          const model = registry.getModel(modelId);
          if (model && isProbeStillCurrent() && !areThinkingCapabilitySnapshotsEqual(model.thinkingCapability, thinkingCapability)) {
            registry.updateModel({
              ...model,
              thinkingCapability,
            });
          }
        }
      } catch (error) {
        if (isProbeStillCurrent()) {
          console.warn('[LLMEngine] Failed to persist chat template thinking capability', buildSafeErrorLogDetails(error));
        }
      }
    })();
  }

  public async countPromptTokens({
    messages,
    params,
    multimodalReadiness,
    expectedModelId,
    chatBlocking = true,
    allowMediaFallback = false,
  }: {
    messages: LlmChatMessage[];
    params?: {
      enable_thinking?: boolean;
      reasoning_format?: 'none' | 'auto' | 'deepseek';
      add_generation_prompt?: boolean;
    };
    multimodalReadiness?: MultimodalReadinessState;
    expectedModelId?: string | null;
    chatBlocking?: boolean;
    allowMediaFallback?: boolean;
  }): Promise<number> {
    if (this.isUnloading) {
      throw new AppError('engine_unloading', 'The model engine is unloading. Please wait a moment.');
    }

    if (this.activeCompletionPromise) {
      throw new AppError('engine_busy', 'A response is already being generated.');
    }

    const mediaAwareMessages = messages.map(withResolvedMediaPaths);
    const mediaPaths = getMessagesMediaPaths(mediaAwareMessages);
    const mediaPathOccurrenceCount = countMessageMediaPathOccurrences(mediaAwareMessages);
    const shouldUseMediaPaths = (() => {
      if (mediaPathOccurrenceCount === 0) {
        return false;
      }

      try {
        assertMultimodalReadyForMediaPaths(
          mediaPaths,
          multimodalReadiness,
          mediaPathOccurrenceCount,
          expectedModelId,
        );
        return true;
      } catch (error) {
        if (!allowMediaFallback || toAppError(error).code === 'chat_attachment_limit_exceeded') {
          throw error;
        }

        return false;
      }
    })();
    const requestMessages = shouldUseMediaPaths
      ? mediaAwareMessages
      : mediaAwareMessages.map(withoutMediaPaths);

    return this.trackContextOperation(async (cancellation) => {
      if (this.state.status === EngineStatus.INITIALIZING && this.initPromise) {
        await this.initPromise;
      }
      cancellation.throwIfCancelled();

      if (this.activeCompletionPromise) {
        throw new AppError('engine_busy', 'A response is already being generated.');
      }

      const { context, generation: contextGeneration } = this.getReadyContextOrThrow();

      let strictRoleSystemNormalization: StrictRoleSystemNormalization = 'plain';
      const countTokens = async (promptMessages: LlmChatMessage[]) => {
        this.assertContextStillCurrent(context, contextGeneration);
        let formatted: LlamaFormattedChatResult;
        try {
          formatted = await getFormattedChatFromContext({
            context,
            messages: promptMessages,
            options: {
              enable_thinking: params?.enable_thinking ?? false,
              reasoning_format: params?.reasoning_format ?? 'none',
              add_generation_prompt: params?.add_generation_prompt,
            },
          });
        } catch (error) {
          this.assertContextStillCurrent(context, contextGeneration);
          throw error;
        }

        cancellation.throwIfCancelled();
        strictRoleSystemNormalization = resolveStrictRoleSystemNormalization(formatted);
        this.assertContextStillCurrent(context, contextGeneration);
        let tokenized: Awaited<ReturnType<LlamaContext['tokenize']>>;
        try {
          tokenized = await tokenizeFormattedPrompt({
            context,
            prompt: formatted.prompt,
            mediaPaths: shouldUseMediaPaths
              ? formatted.media_paths && formatted.media_paths.length > 0
                ? formatted.media_paths
                : getMessagesMediaPaths(promptMessages)
              : undefined,
          });
        } catch (error) {
          this.assertContextStillCurrent(context, contextGeneration);
          throw error;
        }

        this.assertContextStillCurrent(context, contextGeneration);
        return tokenized.tokens.length;
      };

      try {
        return await countTokens(requestMessages);
      } catch (error) {
        if (isConversationAlternationError(error)) {
          console.warn('[LLMEngine] Retrying prompt token count after normalizing chat roles for strict templates');
          const normalizedMessages = normalizeMessagesForStrictRoleAlternation(requestMessages, {
            systemNormalization: strictRoleSystemNormalization,
          });
          return await countTokens(normalizedMessages);
        }

        throw error;
      }
    }, { chatBlocking });
  }

  public async stopCompletion(): Promise<void> {
    this.completionRunner.interruptIfActive();

    if (this.context) {
      await this.context.stopCompletion();
    }
  }

  public async interruptActiveCompletion(): Promise<void> {
    const activeCompletion = this.activeCompletionDriverPromise;
    if (!activeCompletion) {
      return;
    }

    try {
      await this.stopCompletion();
    } catch (error) {
      console.warn('[LLMEngine] Failed to interrupt active completion', buildSafeErrorLogDetails(error));
    }

    try {
      const stopResult = await this.waitForUnloadPromise(activeCompletion, CONTEXT_OPERATION_STOP_DRAIN_TIMEOUT_MS);
      if (stopResult === 'timed_out') {
        this.completionRunner.rejectActive(
          new AppError('engine_busy', ACTIVE_COMPLETION_STOP_TIMEOUT_MESSAGE),
        );
      }
    } catch {
      // Completion failures are handled by the chat flow that initiated them.
    }
  }

  public hasActiveCompletion(): boolean {
    return this.completionRunner.hasActive();
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
      console.warn('[LLMEngine] Failed to resolve total device memory for GPU layer recommendation', buildSafeErrorLogDetails(error));
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
    return buildEngineDiagnosticsSnapshot({
      activeBackendMode: this.activeBackendMode,
      activeBackendDevices: this.activeBackendDevices,
      activeBackendReasonNoGpu: this.activeBackendReasonNoGpu,
      activeBackendSystemInfo: this.activeBackendSystemInfo,
      activeBackendAndroidLib: this.activeBackendAndroidLib,
      requestedGpuLayers: this.requestedGpuLayers,
      activeGpuLayers: this.activeGpuLayers,
      actualGpuAccelerated: this.actualGpuAccelerated,
      requestedBackendPolicy: this.requestedBackendPolicy,
      effectiveBackendPolicy: this.effectiveBackendPolicy,
      backendPolicyReasons: this.backendPolicyReasons,
      backendInitAttemptsSnapshot: this.backendInitAttemptsSnapshot,
      initGpuLayers: this.initGpuLayers,
      initDevices: this.initDevices,
      initCacheTypeK: this.initCacheTypeK,
      initCacheTypeV: this.initCacheTypeV,
      initFlashAttnType: this.initFlashAttnType,
      initUseMmap: this.initUseMmap,
      initUseMlock: this.initUseMlock,
      initNParallel: this.initNParallel,
      initNThreads: this.initNThreads,
      initCpuMask: this.initCpuMask,
      initCpuStrict: this.initCpuStrict,
      initNBatch: this.initNBatch,
      initNUbatch: this.initNUbatch,
      initKvUnified: this.initKvUnified,
      lastLifecycleEvent: this.lastLifecycleEvent,
      lastLifecycleError: this.lastLifecycleError,
      multimodalDiagnostics: this.recentMultimodalDiagnostics,
    });
  }

  private recordRecentMultimodalDiagnostics({
    messages,
    mediaPaths,
    mediaPathOccurrenceCount,
    readiness,
    failureReason,
  }: {
    messages: readonly LlmChatMessage[];
    mediaPaths: readonly string[];
    mediaPathOccurrenceCount?: number;
    readiness: MultimodalReadinessState | undefined;
    failureReason?: string | null;
  }): void {
    const attachmentSummary = summarizeChatImageAttachments(
      messages.flatMap((message) => message.attachments ?? []),
    );
    const multimodalDiagnostics = buildMultimodalDiagnosticsSummary({
      readiness,
      attachmentCount: Math.max(attachmentSummary.count, mediaPathOccurrenceCount ?? mediaPaths.length),
      attachmentTotalBytes: attachmentSummary.totalBytes,
      failureReason,
    });

    if (!multimodalDiagnostics) {
      return;
    }

    this.recentMultimodalDiagnostics = multimodalDiagnostics;
    this.updateState(this.state);
  }

  private getMultimodalVariantId(model: ModelMetadata): string | undefined {
    return model.activeVariantId ?? model.resolvedFileName;
  }

  private isVisionCapableModel(model: ModelMetadata): boolean {
    return modelSupportsVision(model);
  }

  private async resolveLoadTimeProjectorMemoryInfo(
    model: ModelMetadata | null | undefined,
  ): Promise<{ projectorId: string; sizeBytes: number } | null> {
    if (!model || !this.isVisionCapableModel(model)) {
      return null;
    }

    const resolution = projectorArtifactService.resolveProjectorForModel(model);
    const projector = resolution.selectedProjector;
    if (!projector || (projector.lifecycleStatus !== 'downloaded' && projector.lifecycleStatus !== 'active')) {
      return null;
    }

    try {
      const resolvedProjector = await resolveProjectorFilePathOrThrow({ modelId: model.id, projector });
      const sizeBytes = this.toPositiveByteCount(resolvedProjector.fileInfo.size)
        ?? this.toPositiveByteCount(projector.size);

      return sizeBytes ? { projectorId: projector.id, sizeBytes } : null;
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[LLMEngine] Failed to resolve projector size for load-time memory fit', {
          modelId: model.id,
          projectorId: projector.id,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
      return null;
    }
  }

  private buildMultimodalReadinessState(
    model: ModelMetadata,
    status: MultimodalReadinessStatus,
    options: {
      projector?: Pick<ProjectorArtifact, 'id' | 'size'> | null;
      projectorSize?: number | null;
      support?: readonly MultimodalSupportModality[];
      failureReason?: string | null;
    } = {},
  ): MultimodalReadinessState {
    const projectorSize = this.toPositiveByteCount(options.projectorSize)
      ?? this.toPositiveByteCount(options.projector?.size);
    const support = Array.from(new Set(options.support ?? []));
    const failureReason = sanitizeMultimodalFailureReason(options.failureReason);

    return {
      modelId: model.id,
      ...(this.getMultimodalVariantId(model) ? { variantId: this.getMultimodalVariantId(model) } : null),
      status,
      ...(options.projector?.id ? { projectorId: options.projector.id } : null),
      ...(projectorSize ? { projectorSize } : null),
      support,
      ...(failureReason ? { failureReason } : null),
      checkedAt: Date.now(),
    };
  }

  private persistMultimodalReadiness(modelId: string, readiness: MultimodalReadinessState): void {
    const currentModel = registry.getModel(modelId);
    if (!currentModel) {
      return;
    }

    registry.updateModel({
      ...currentModel,
      multimodalReadiness: readiness,
    });

    this.recordRecentMultimodalDiagnostics({
      messages: [],
      mediaPaths: [],
      readiness,
      failureReason: readiness.failureReason,
    });
  }

  private resolveMultimodalSupportList(support: LlamaMultimodalSupport): MultimodalSupportModality[] {
    return [
      ...(support.vision ? ['vision' as const] : []),
      ...(support.audio ? ['audio' as const] : []),
    ];
  }

  private getMultimodalRuntimeFailureStatus(error: unknown): MultimodalReadinessStatus {
    return error instanceof LlamaRuntimeFeatureUnavailableError ? 'unsupported' : 'failed';
  }

  private queueMultimodalReadinessRefreshAfterCompletion(refresh: {
    modelId: string;
    context: LlamaContext;
    useGpu: boolean;
  }): void {
    this.pendingMultimodalReadinessRefresh = refresh;
    const activeCompletion = this.activeCompletionPromise;
    if (activeCompletion) {
      void activeCompletion.catch(() => undefined).then(() => {
        this.schedulePendingMultimodalReadinessRefresh();
      });
      return;
    }

    this.schedulePendingMultimodalReadinessRefresh();
  }

  private schedulePendingMultimodalReadinessRefresh(): void {
    if (this.pendingMultimodalReadinessRefreshPromise) {
      return;
    }

    const refreshPromise = this.runPendingMultimodalReadinessRefresh();
    this.pendingMultimodalReadinessRefreshPromise = refreshPromise;
    void refreshPromise.finally(() => {
      if (this.pendingMultimodalReadinessRefreshPromise === refreshPromise) {
        this.pendingMultimodalReadinessRefreshPromise = null;
      }

      if (this.pendingMultimodalReadinessRefresh && !this.activeCompletionPromise && !this.isUnloading) {
        this.schedulePendingMultimodalReadinessRefresh();
      }
    });
  }

  private async runPendingMultimodalReadinessRefresh(): Promise<void> {
    const pendingRefresh = this.pendingMultimodalReadinessRefresh;
    if (!pendingRefresh || this.activeCompletionPromise || this.isUnloading) {
      return;
    }

    this.pendingMultimodalReadinessRefresh = null;

    try {
      await this.trackContextOperation(async (cancellation) => {
        if (this.activeCompletionPromise) {
          this.pendingMultimodalReadinessRefresh ??= pendingRefresh;
          return;
        }

        if (
          cancellation.isCancelled()
          || this.context !== pendingRefresh.context
          || this.state.activeModelId !== pendingRefresh.modelId
          || this.state.status !== EngineStatus.READY
        ) {
          return;
        }

        await this.initializeMultimodalReadinessForLoadedContext(pendingRefresh, cancellation);
      }, { chatBlocking: false });
    } catch (error) {
      if (this.isContextOperationStopError(error) && this.activeCompletionPromise) {
        this.queueMultimodalReadinessRefreshAfterCompletion(pendingRefresh);
        return;
      }

      if (process.env.NODE_ENV !== 'test') {
        console.warn('[LLMEngine] Deferred multimodal readiness refresh failed', {
          modelId: pendingRefresh.modelId,
          error: sanitizeMultimodalFailureReason(getErrorMessageText(error))
            ?? (error instanceof Error ? error.name : typeof error),
        });
      }
    }
  }

  private async initializeMultimodalReadinessForLoadedContext({
    modelId,
    context,
    useGpu,
  }: {
    modelId: string;
    context: LlamaContext;
    useGpu: boolean;
  }, cancellation?: ContextOperationCancellationToken): Promise<void> {
    const model = registry.getModel(modelId);
    if (!model) {
      return;
    }

    const isCurrent = () => this.isMultimodalReadinessInitializationCurrent({
      modelId,
      context,
      cancellation,
    });
    if (!isCurrent()) {
      return;
    }

    if (!this.isVisionCapableModel(model)) {
      if (!isCurrent()) {
        return;
      }
      if (model.multimodalReadiness) {
        this.persistMultimodalReadiness(
          model.id,
          this.buildMultimodalReadinessState(model, 'text_only'),
        );
      }
      await this.releaseActiveMultimodalContext({ modelId: model.id, context });
      return;
    }

    const resolution = projectorArtifactService.resolveProjectorForModel(model);
    const projector = resolution.selectedProjector;
    if (!projector) {
      if (!isCurrent()) {
        return;
      }
      const status: MultimodalReadinessStatus = resolution.status === 'ambiguous'
        ? 'ambiguous_projector'
        : resolution.status === 'failed'
          ? 'failed'
          : 'missing_projector';
      this.persistMultimodalReadiness(
        model.id,
        this.buildMultimodalReadinessState(model, status, {
          failureReason: resolution.reason,
        }),
      );
      await this.releaseActiveMultimodalContext({ modelId: model.id, context });
      return;
    }

    const lifecycleReadiness = getReadinessStatusForProjectorLifecycle(projector);
    if (lifecycleReadiness) {
      if (!isCurrent()) {
        return;
      }
      this.persistMultimodalReadiness(
        model.id,
        this.buildMultimodalReadinessState(model, lifecycleReadiness, {
          projector,
          failureReason: lifecycleReadiness === 'failed' ? projector.matchReason ?? 'projector_download_failed' : undefined,
        }),
      );
      await this.releaseActiveMultimodalContext({ modelId: model.id, context });
      return;
    }

    let resolvedProjector: ResolvedProjectorArtifactInfo;
    try {
      resolvedProjector = await resolveProjectorFilePathOrThrow({ modelId: model.id, projector });
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      this.persistMultimodalReadiness(
        model.id,
        this.buildMultimodalReadinessState(model, 'failed', {
          projector,
          failureReason: getErrorMessageText(error),
        }),
      );
      await this.releaseActiveMultimodalContext({ modelId: model.id, context });
      return;
    }

    if (!isCurrent()) {
      return;
    }

    const hasActiveMatchingProjectorArtifact = this.isActiveMultimodalContextForResolvedProjector({
      activeMultimodalContext: this.activeMultimodalContext,
      modelId: model.id,
      projector,
      resolvedProjector,
    });

    if (hasActiveMatchingProjectorArtifact) {
      if (model.multimodalReadiness?.status === 'ready') {
        return;
      }

      try {
        const support = this.resolveMultimodalSupportList(await getMultimodalSupportFromContext(context));
        if (!isCurrent()) {
          return;
        }
        const readiness = support.includes('vision')
          ? this.buildMultimodalReadinessState(model, 'ready', {
            projector,
            support,
          })
          : this.buildMultimodalReadinessState(model, 'unsupported', {
            projector,
            support,
            failureReason: 'Runtime did not report vision support for the active projector.',
          });

        this.persistMultimodalReadiness(model.id, readiness);
        if (readiness.status !== 'ready') {
          await this.releaseActiveMultimodalContext({ modelId: model.id, context });
        }
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        this.persistMultimodalReadiness(
          model.id,
          this.buildMultimodalReadinessState(model, this.getMultimodalRuntimeFailureStatus(error), {
            projector,
            failureReason: getErrorMessageText(error),
          }),
        );
        await this.releaseActiveMultimodalContext({ modelId: model.id, context });
      }
      return;
    }

    if (
      this.activeMultimodalContext
      && this.activeMultimodalContext.modelId === model.id
      && !hasActiveMatchingProjectorArtifact
    ) {
      const didReleasePreviousProjector = await this.releaseActiveMultimodalContext({ modelId: model.id, context });
      if (!isCurrent()) {
        return;
      }
      if (!didReleasePreviousProjector) {
        this.persistMultimodalReadiness(
          model.id,
          this.buildMultimodalReadinessState(model, 'failed', {
            projector,
            failureReason: 'Failed to release the previously initialized multimodal projector.',
          }),
        );
        return;
      }
    }

    let initializedMultimodalContext: ActiveMultimodalContext | undefined;
    const releaseActiveInitializedMultimodalContext = () => this.releaseActiveMultimodalContext({
      modelId: model.id,
      context,
      ...(initializedMultimodalContext ? { activeMultimodalContext: initializedMultimodalContext } : {}),
    });

    try {
      const didInitialize = await initMultimodalOnContext({
        context,
        path: resolvedProjector.projectorPath,
        useGpu,
      });

      if (!didInitialize) {
        if (!isCurrent()) {
          return;
        }

        this.persistMultimodalReadiness(
          model.id,
          this.buildMultimodalReadinessState(model, 'failed', {
            projector,
            projectorSize: resolvedProjector.fileInfo.size,
            failureReason: 'llama.rn did not initialize the multimodal projector.',
          }),
        );
        await this.releaseActiveMultimodalContext({ modelId: model.id, context });
        return;
      }

      initializedMultimodalContext = this.buildActiveMultimodalContext({
        modelId: model.id,
        projector,
        resolvedProjector,
      });
      this.activeMultimodalContext = initializedMultimodalContext;

      if (!isCurrent()) {
        await releaseActiveInitializedMultimodalContext();
        return;
      }

      const support = this.resolveMultimodalSupportList(await getMultimodalSupportFromContext(context));
      if (!isCurrent()) {
        await releaseActiveInitializedMultimodalContext();
        return;
      }
      const readiness = support.includes('vision')
        ? this.buildMultimodalReadinessState(model, 'ready', {
          projector,
          projectorSize: resolvedProjector.fileInfo.size,
          support,
        })
        : this.buildMultimodalReadinessState(model, 'unsupported', {
          projector,
          projectorSize: resolvedProjector.fileInfo.size,
          support,
          failureReason: 'Runtime did not report vision support after projector initialization.',
        });

      this.persistMultimodalReadiness(model.id, readiness);
      if (readiness.status !== 'ready') {
        await this.releaseActiveMultimodalContext({ modelId: model.id, context });
      }
    } catch (error) {
      if (!isCurrent()) {
        await releaseActiveInitializedMultimodalContext();
        return;
      }
      this.persistMultimodalReadiness(
        model.id,
        this.buildMultimodalReadinessState(model, this.getMultimodalRuntimeFailureStatus(error), {
          projector,
          projectorSize: resolvedProjector.fileInfo.size,
          failureReason: getErrorMessageText(error),
        }),
      );
      await this.releaseActiveMultimodalContext({ modelId: model.id, context });
    }
  }

  private assertActiveMultimodalRuntimeReadyForMediaPaths(
    mediaPaths: readonly string[],
    readiness: MultimodalReadinessState | undefined,
    mediaPathOccurrenceCount = mediaPaths.length,
  ): void {
    if (mediaPaths.length === 0) {
      return;
    }

    const activeMultimodal = this.activeMultimodalContext;
    if (!activeMultimodal || activeMultimodal.modelId !== this.state.activeModelId) {
      throw new AppError('multimodal_not_ready', 'Multimodal runtime is not initialized for the active model.', {
        details: {
          activeModelId: this.state.activeModelId,
          readinessStatus: readiness?.status,
          mediaPathCount: mediaPathOccurrenceCount,
        },
      });
    }

    if (readiness?.modelId && readiness.modelId !== activeMultimodal.modelId) {
      throw new AppError('multimodal_not_ready', 'Multimodal readiness belongs to a different model.', {
        details: {
          activeModelId: this.state.activeModelId,
          readinessModelId: readiness.modelId,
          mediaPathCount: mediaPathOccurrenceCount,
        },
      });
    }

    if (readiness?.projectorId && readiness.projectorId !== activeMultimodal.projectorId) {
      throw new AppError('multimodal_not_ready', 'Multimodal runtime is initialized with a different projector.', {
        details: {
          activeModelId: this.state.activeModelId,
          readinessProjectorId: readiness.projectorId,
          runtimeProjectorId: activeMultimodal.projectorId,
          mediaPathCount: mediaPathOccurrenceCount,
        },
      });
    }
  }

  private async releaseActiveMultimodalContext(expected?: {
    modelId?: string;
    context?: LlamaContext;
    activeMultimodalContext?: ActiveMultimodalContext;
  }): Promise<boolean> {
    const activeMultimodal = this.activeMultimodalContext;
    if (!activeMultimodal) {
      return true;
    }

    if (expected?.activeMultimodalContext && activeMultimodal !== expected.activeMultimodalContext) {
      return true;
    }

    if (expected?.modelId && activeMultimodal.modelId !== expected.modelId) {
      return true;
    }

    const context = this.context;
    if (expected?.context && context !== expected.context) {
      if (expected.activeMultimodalContext && activeMultimodal === expected.activeMultimodalContext) {
        this.activeMultimodalContext = null;
      }
      return true;
    }

    if (!context) {
      this.activeMultimodalContext = null;
      return true;
    }

    this.activeMultimodalContext = null;
    try {
      await releaseMultimodalFromContext(context);
      return true;
    } catch (error) {
      if (this.context === context && this.state.activeModelId === activeMultimodal.modelId) {
        this.activeMultimodalContext = activeMultimodal;
      }
      if (process.env.NODE_ENV !== 'test') {
        const sanitizedErrorMessage = sanitizeMultimodalFailureReason(getErrorMessageText(error));
        console.warn('[LLMEngine] Failed to release multimodal context', {
          modelId: activeMultimodal.modelId,
          projectorId: activeMultimodal.projectorId,
          error: sanitizedErrorMessage ?? (error instanceof Error ? error.name : typeof error),
        });
      }
      return false;
    }
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
    this.recentMultimodalDiagnostics = null;
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
    this.lastLifecycleEvent = null;
    this.lastLifecycleError = null;
  }

  private resolveReportedLoadedGpuLayers(resolvedGpuLayers: number | null): number {
    const normalizedResolvedGpuLayers = typeof resolvedGpuLayers === 'number' && Number.isFinite(resolvedGpuLayers)
      ? Math.max(0, Math.round(resolvedGpuLayers))
      : 0;

    return this.actualGpuAccelerated === true ? normalizedResolvedGpuLayers : 0;
  }

  private hasNpuRuntimeSignal(context: LlamaContext): boolean {
    return hasNpuRuntimeSignalHelper(context);
  }

  private resolveBackendMode(context: LlamaContext): EngineBackendMode {
    return resolveBackendModeHelper(context);
  }

  private captureBackendTelemetry(
    context: LlamaContext,
    initProfile?: ResolvedInferenceProfile | null,
    initGpuLayers?: number | null,
  ): void {
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

    const resolvedInitGpuLayers = typeof initGpuLayers === 'number' && Number.isFinite(initGpuLayers)
      ? Math.max(0, Math.round(initGpuLayers))
      : null;
    const resolvedProfileLayers = typeof initProfile?.nGpuLayers === 'number' && Number.isFinite(initProfile.nGpuLayers)
      ? Math.max(0, Math.round(initProfile.nGpuLayers))
      : 0;
    const resolvedProfileBackendMode: EngineBackendMode | null = initProfile?.backendMode === 'cpu'
      ? 'cpu'
      : initProfile?.backendMode === 'gpu'
        ? 'gpu'
        : initProfile?.backendMode === 'npu'
          ? 'npu'
          : null;
    const telemetry = resolveBackendTelemetry({
      context,
      initProfileBackendMode: resolvedProfileBackendMode,
      resolvedInitGpuLayers,
      resolvedProfileLayers,
    });

    this.activeBackendMode = telemetry.activeBackendMode;
    this.actualGpuAccelerated = telemetry.actualGpuAccelerated;
  }

  /**
   * Helper to calculate if model fits in RAM.
   */
  public async fitsInRam(modelSize: number): Promise<MemoryFitResult> {
    let totalMemoryBytes: number | null = null;
    try {
      totalMemoryBytes = await DeviceInfo.getTotalMemory();
    } catch (error) {
      console.warn('[LLMEngine] Failed to resolve total device memory for fit estimate', buildSafeErrorLogDetails(error));
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
    preferLastWorkingProfile = false,
    recentUnloadReclaim: ModelUnloadReclaimEstimate | null = null,
    fallbackDownloadMarker: number | null = null,
    resolvedArtifactInfo: ResolvedModelArtifactInfo | null = null,
  ): Promise<void> {
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    const nativeLogs: { level: string; text: string }[] = [];
    let nativeLogListener: { remove: () => void } | null = null;
    let didEnableNativeLogs = false;
    let initDiagnostics: Record<string, unknown> | null = null;
    let gpuInitError: unknown | null = null;
    let cpuInitError: unknown | null = null;
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
      this.loadedArtifactIdentity = null;
      this.safeModeLoadLimits = null;
      this.resetRuntimeTelemetry();
      this.updateState({
        status: EngineStatus.INITIALIZING,
        activeModelId: modelId,
        loadProgress: 0,
        lastError: undefined,
      });

      const resolvedArtifact = resolvedArtifactInfo ?? (await resolveModelFilePathOrThrow({ modelId, localPath }));
      const { modelPath, fileInfo } = resolvedArtifact;
      const loadedArtifactIdentity = this.buildLoadedModelArtifactIdentity({
        localPath,
        resolvedArtifactInfo: resolvedArtifact,
        fallbackDownloadMarker,
      });

      const persistedLoadParams = getModelLoadParametersForModel(modelId);
      const loadParams = loadParamsOverride
        ? { ...persistedLoadParams, ...loadParamsOverride }
        : persistedLoadParams;
      const rawSystemMemorySnapshot = recentUnloadReclaim?.afterUnloadSnapshot
        ?? await getFreshMemorySnapshot(recentUnloadReclaim ? 0 : 1500).catch(() => null);
      const systemMemorySnapshot = this.withRecentUnloadReclaimableBudget(
        rawSystemMemorySnapshot,
        recentUnloadReclaim,
      );
      const observedRawBudgetBytes = this.resolveObservedRawBudgetBytes(rawSystemMemorySnapshot);
      let totalMemoryBytes: number | null = null;
      try {
        totalMemoryBytes = await DeviceInfo.getTotalMemory();
      } catch (error) {
        console.warn('[LLMEngine] Failed to resolve total device memory', buildSafeErrorLogDetails(error));
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
      let shouldAutoUseSafeLoadProfile = false;
      let shouldUseSafeLoadProfile = false;
      let finalContextSize = DEFAULT_CONTEXT_SIZE;
      let gpuLayers = 0;
      let shouldUseLowMemoryContextParams = false;
      let validateSafeLoadBudgetOrThrow: ((input: {
        predictedFitForLoad: MemoryFitResult | null;
        requestedMemoryFit: MemoryFitResult | null;
      }) => { unsafeMemoryBypassedHardBlock: boolean }) | null = null;

      let modelInfo: Record<string, unknown> | null = null;
      try {
        modelInfo = await loadLlamaModelInfo(modelPath);
      } catch (error) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[LLMEngine] Failed to read GGUF metadata', buildSafeErrorLogDetails(error));
        }
      }

      const ggufArchitecture = getModelInfoString(modelInfo, 'general.architecture')?.toLowerCase() ?? null;
      const ggufType = getModelInfoString(modelInfo, 'general.type')?.toLowerCase() ?? null;
      if (ggufType === 'mmproj' || ggufArchitecture === 'clip') {
        // mmproj/CLIP projector GGUFs need a separate multimodal lifecycle. Never load them as
        // the primary language model context.
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
        llamaRnBuild: getLlamaBuildInfo(),
        fileSizeBytes: typeof fileInfo.size === 'number' ? fileInfo.size : null,
        totalMemoryBytes: resolvedTotalMemoryBytes,
        hasSystemMemorySnapshot: systemMemorySnapshot !== null,
        lowMemorySignal: systemMemorySnapshot?.lowMemory ?? hardwareListenerService.getCurrentStatus().isLowMemory,
        requestedModelSizeBytes: resolvedModelSizeBytes,
        recentUnloadReclaim: this.summarizeRecentUnloadReclaim(recentUnloadReclaim),
        ggufInfo: {
          architecture: ggufArchitecture,
          type: ggufType,
        },
        loadParams,
      };

      const cachedModel = registry.getModel(modelId);
      const loadTimeProjectorMemory = await this.resolveLoadTimeProjectorMemoryInfo(cachedModel);
      const loadTimeProjectorSizeBytes = loadTimeProjectorMemory?.sizeBytes;
      const hasLoadTimeMmproj = typeof loadTimeProjectorSizeBytes === 'number'
        && Number.isFinite(loadTimeProjectorSizeBytes)
        && loadTimeProjectorSizeBytes > 0;
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
      const baseLoadProfileModelSizeBytes = verifiedFileSizeBytes ?? resolvedModelSizeBytes;
      const loadProfileModelSizeBytes = typeof baseLoadProfileModelSizeBytes === 'number'
        && Number.isFinite(baseLoadProfileModelSizeBytes)
        && baseLoadProfileModelSizeBytes > 0
        ? baseLoadProfileModelSizeBytes + (loadTimeProjectorSizeBytes ?? 0)
        : baseLoadProfileModelSizeBytes;
      const { recommendedGpuLayers, gpuLayersCeiling } = this.resolveRecommendedLoadProfile({
        totalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
          ? resolvedTotalMemoryBytes
          : null,
        systemMemorySnapshot,
        modelSizeBytes: loadProfileModelSizeBytes,
        ggufMetadata,
        modelLayerCount: stableCapability?.modelLayerCount,
        gpuLayersCeilingOverride: stableCapability?.gpuLayersCeiling,
      });

      const lastGoodProfile = preferLastWorkingProfile
        ? readLastGoodInferenceProfile({
            modelId,
            contextSize: loadParams.contextSize,
            kvCacheType: loadParams.kvCacheType,
            modelFileSizeBytes: verifiedFileSizeBytes,
            modelSha256: cachedModel?.sha256,
          })
        : null;

      // Do not override user settings with last-good. Last-good is used only to reorder
      // already-safe init candidates later (crash recovery / warmup).
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

      const explicitGpuLayers = typeof loadParams.gpuLayers === 'number'
        && Number.isFinite(loadParams.gpuLayers)
        && loadParams.gpuLayers >= 0
        ? Math.round(loadParams.gpuLayers)
        : null;
      const requestedGpuLayersCandidate = requestedBackendPolicy === 'cpu'
        ? 0
        : explicitGpuLayers !== null
          ? explicitGpuLayers
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
          ...(loadTimeProjectorSizeBytes ? { multimodalSizeBytes: loadTimeProjectorSizeBytes } : null),
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

      // Default to the requested load profile. The safe-load policy (if it runs)
      // may override these values.
      finalContextSize = resolvedContextSize;
      gpuLayers = requestedGpuLayers;
      const requestedCalibrationKey = verifiedFileSizeBytes !== null
        ? this.buildCalibrationKeyString({
          ggufMetadata,
          verifiedFileSizeBytes,
          contextTokens: resolvedContextSize,
          gpuLayers: requestedGpuLayers,
          cacheTypeK,
          cacheTypeV,
          useMmap: requestedUseMmap,
          hasMmproj: hasLoadTimeMmproj,
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
        ...(loadTimeProjectorSizeBytes ? { multimodalSizeBytes: loadTimeProjectorSizeBytes } : null),
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

        const lowMemorySignal = systemMemorySnapshot?.lowMemory ?? hardwareListenerService.getCurrentStatus().isLowMemory;
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

        const safeLoadDecision = resolveSafeLoadPolicyOrThrow({
          modelId,
          allowUnsafeMemoryLoad,
          memoryFit,
          resolvedModelSizeBytes,
          resolvedTotalMemoryBytes: typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0
            ? resolvedTotalMemoryBytes
            : null,
          systemMemorySnapshot,
          lowMemorySignal,
          resolvedContextSize,
          requestedGpuLayers,
          configuredContextCeilingTokens,
          modelContextCeilingTokens,
          computeSafeProfile: () => this.resolveMaxSafeLoadProfile({
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
            ...(loadTimeProjectorSizeBytes ? { multimodalSizeBytes: loadTimeProjectorSizeBytes } : null),
            hasMmproj: hasLoadTimeMmproj,
            preferGpuLayers: requestedBackendPolicy === 'gpu' || requestedBackendPolicy === 'npu',
          }),
          onHardBlock: (confidence) => this.persistHardBlockedMemoryFit(modelId, confidence),
        });

        safeLoadProfile = safeLoadDecision.safeLoadProfile;
        safeMemoryFit = safeLoadDecision.safeMemoryFit;
        shouldAutoUseSafeLoadProfile = safeLoadDecision.shouldAutoUseSafeLoadProfile;
        shouldUseSafeLoadProfile = safeLoadDecision.shouldUseSafeLoadProfile;
        finalContextSize = safeLoadDecision.finalContextSize;
        gpuLayers = safeLoadDecision.gpuLayers;
        shouldUseLowMemoryContextParams = safeLoadDecision.shouldUseLowMemoryContextParams;
        validateSafeLoadBudgetOrThrow = safeLoadDecision.validateBudgetOrThrow;

        if (shouldAutoUseSafeLoadProfile && initDiagnostics) {
          initDiagnostics = {
            ...initDiagnostics,
            safeLoadProfile,
            safeMemoryFit: safeMemoryFit ?? undefined,
            autoSafeLoadProfile: true,
          };
        }
      }

      this.requestedGpuLayers = requestedGpuLayers;
      // shouldUseLowMemoryContextParams is decided by the safe-load policy.
      // Keep llama.cpp parallel slots disabled until the app implements the official parallel decoding flow.
      const resolvedParallelSlots = 1;
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
          hasMmproj: hasLoadTimeMmproj,
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
      const safeLoadValidation = validateSafeLoadBudgetOrThrow
        ? validateSafeLoadBudgetOrThrow({
            predictedFitForLoad: predictedFitForLoad ?? memoryFit,
            requestedMemoryFit: memoryFit,
          })
        : { unsafeMemoryBypassedHardBlock: false };

      if (safeLoadValidation.unsafeMemoryBypassedHardBlock && initDiagnostics) {
        initDiagnostics = {
          ...initDiagnostics,
          unsafeMemoryBypassedHardBlock: true,
        };
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
           nativeLogListener = addNativeLlamaLogListener((level, text) => {
            nativeLogs.push({ level, text });
            if (nativeLogs.length > MAX_NATIVE_LOG_LINES) {
              nativeLogs.splice(0, nativeLogs.length - MAX_NATIVE_LOG_LINES);
            }
          });
          await toggleNativeLlamaLogs(true);
          didEnableNativeLogs = true;
        } catch (error) {
          console.warn('[LLMEngine] Failed to enable native llama logs', buildSafeErrorLogDetails(error));
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
      const publishBackendInitAttempts = () => {
        this.backendInitAttemptsSnapshot = backendInitAttempts;
        if (initDiagnostics) {
          initDiagnostics = {
            ...initDiagnostics,
            backendInitAttempts,
          };
        }
      };

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
              hasMmproj: hasLoadTimeMmproj,
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

        const buildOptions = (layers: number): LlamaContextInitParams => {
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
            // llama.rn supports `no_gpu_devices` (iOS-only, deprecated). Prefer controlling
            // acceleration via `n_gpu_layers` and explicit `devices` when needed.
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

        const initOnce = async (layers: number) => initLlamaContext(
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
          backendInitAttempts.push({
            candidate,
            nGpuLayers: normalizedLayers,
            devices,
            outcome: 'error',
            error: sanitizeErrorMessageForDiagnostics(error),
          });

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
            console.warn(logLabel, buildSafeErrorLogDetails(error));
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
                  hasMmproj: hasLoadTimeMmproj,
                  nBatch: effectiveBatchParams?.nBatch,
                  nUbatch: effectiveBatchParams?.nUbatch,
                })
              : null;

            try {
              const context = await initOnce(candidateLayers);
              applyCalibrationForGpuLayers(candidateLayers);
              return { context, resolvedGpuLayers: candidateLayers };
            } catch (retryError) {
              backendInitAttempts.push({
                candidate,
                nGpuLayers: candidateLayers,
                devices,
                outcome: 'error',
                error: sanitizeErrorMessageForDiagnostics(retryError),
              });
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

      const autotuneResult = normalizedBackendPolicy === 'auto'
        ? readAutotuneResult({
            modelId,
            contextSize: loadParams.contextSize,
            kvCacheType: loadParams.kvCacheType,
            modelFileSizeBytes: verifiedFileSizeBytes,
            modelSha256: cachedModel?.sha256,
          })
        : null;
      const autotuneBestStableProfile = (() => {
        const best = autotuneResult?.bestStable;
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
      })();
      const autotuneBenchmarkedAccelerators = Array.isArray(autotuneResult?.candidates)
        && autotuneResult.candidates.some((candidate) => {
          const mode = candidate?.profile?.backendMode;
          return mode === 'gpu' || mode === 'npu';
        });

      let {
        effectiveBackendPolicy,
        candidates: resolvedInferenceCandidates,
        reasons: backendPolicyReasons,
      } = resolveInferenceProfileCandidates({
        capabilities: backendCapabilities,
        loadParams: {
          backendPolicy: requestedBackendPolicy,
          selectedBackendDevices,
        },
        gpuLayers,
        baseProfile: baseInferenceProfile,
        preferConservativeGpuProbe: normalizedBackendPolicy === 'auto'
          && explicitGpuLayers === null
          && !autotuneBestStableProfile,
      });

      let inferenceCandidatesForInit = resolvedInferenceCandidates;
      let resolvedBackendPolicyReasons = backendPolicyReasons;

      const capabilitiesKnown = Boolean(backendCapabilities && backendCapabilities.discoveryUnavailable !== true);

      if (normalizedBackendPolicy === 'auto' && autotuneBestStableProfile) {
        const preferredBackendMode = autotuneBestStableProfile.backendMode;
        const preferredGpuLayers = Math.max(0, Math.round(autotuneBestStableProfile.nGpuLayers));
        const clampedGpuLayers = preferredBackendMode === 'cpu' ? 0 : Math.min(gpuLayers, preferredGpuLayers);
        const acceleratorsCurrentlyAvailable = backendCapabilities?.gpu.available === true
          || backendCapabilities?.npu.available === true;
        const savedCpuProfileLooksFallbackOnly = preferredBackendMode === 'cpu'
          && acceleratorsCurrentlyAvailable
          && (
            autotuneResult?.backendDiscoveryKnown === false
            || (autotuneResult?.backendDiscoveryKnown === undefined && !autotuneBenchmarkedAccelerators)
          );

        const canApplyPreferred = preferredBackendMode === 'cpu'
          ? !savedCpuProfileLooksFallbackOnly
          : (
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

      if (preferLastWorkingProfile && lastGoodProfile) {
        const storedBackendMode = lastGoodProfile.backendMode;
        const storedGpuLayers = Math.max(0, Math.round(lastGoodProfile.nGpuLayers));
        const targetBackendMode: ResolvedInferenceProfile['backendMode'] = storedBackendMode !== 'cpu' && storedGpuLayers > 0
          ? storedBackendMode
          : 'cpu';

        const baseWarmupCandidate = inferenceCandidatesForInit.find((candidate) => candidate.backendMode === targetBackendMode) ?? null;
        if (baseWarmupCandidate) {
          const warmupCandidate: ResolvedInferenceProfile = (() => {
            if (targetBackendMode === 'cpu') {
              return {
                ...baseWarmupCandidate,
                backendMode: 'cpu',
                nGpuLayers: 0,
                flashAttnType: 'off',
              };
            }

            const clampedGpuLayers = Math.max(
              0,
              Math.min(baseWarmupCandidate.nGpuLayers, storedGpuLayers),
            );
            if (clampedGpuLayers <= 0) {
              return {
                ...baseWarmupCandidate,
                backendMode: 'cpu',
                nGpuLayers: 0,
                flashAttnType: 'off',
              };
            }

            return {
              ...baseWarmupCandidate,
              backendMode: targetBackendMode,
              nGpuLayers: clampedGpuLayers,
              ...(targetBackendMode === 'npu' && Array.isArray(lastGoodProfile.devices) && lastGoodProfile.devices.length > 0
                ? { devices: lastGoodProfile.devices }
                : null),
            };
          })();

          const previousFirstKey = inferenceCandidatesForInit[0]
            ? `${inferenceCandidatesForInit[0].backendMode}:${Array.isArray(inferenceCandidatesForInit[0].devices) ? inferenceCandidatesForInit[0].devices.join('|') : '*'}`
            : '';

          const seenCandidateKeys = new Set<string>();
          // Keep the warmup candidate in addition to the requested candidate.
          // Include `nGpuLayers` in the key so we don't accidentally drop a higher-layer request.
          inferenceCandidatesForInit = [warmupCandidate, ...inferenceCandidatesForInit].filter((profile) => {
            const devicesKey = Array.isArray(profile.devices) ? profile.devices.join('|') : '*';
            const candidateKey = `${profile.backendMode}:${devicesKey}:${Math.max(0, Math.round(profile.nGpuLayers))}`;
            if (seenCandidateKeys.has(candidateKey)) {
              return false;
            }
            seenCandidateKeys.add(candidateKey);
            return true;
          });

          const nextFirstKey = inferenceCandidatesForInit[0]
            ? `${inferenceCandidatesForInit[0].backendMode}:${Array.isArray(inferenceCandidatesForInit[0].devices) ? inferenceCandidatesForInit[0].devices.join('|') : '*'}`
            : '';

          if (nextFirstKey.length > 0 && nextFirstKey !== previousFirstKey) {
            resolvedBackendPolicyReasons = [
              ...resolvedBackendPolicyReasons,
              'inference.backendPolicyReason.warmupPreferringLastGood',
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
      let resolvedInitActualGpu: boolean | null = null;
      let lastBackendInitError: unknown | null = null;
      for (let i = 0; i < inferenceCandidatesForInit.length; i += 1) {
        const profile = inferenceCandidatesForInit[i];
        const { backendMode: candidate, nGpuLayers, devices } = profile;
        const hasAcceleratorCandidateAfter = inferenceCandidatesForInit.slice(i + 1).some((next) => next.backendMode !== 'cpu');

        const attemptsBeforeProfile = backendInitAttempts.length;
        try {
          const { context, resolvedGpuLayers: candidateGpuLayers } = await initLlamaWithRetry(profile);
          const reasonNoGPU = typeof context.reasonNoGPU === 'string' ? context.reasonNoGPU.trim() : '';
          const runtimeAccelerationEnabled = candidate === 'npu'
            ? (Boolean(context.gpu) || (this.hasNpuRuntimeSignal(context) && reasonNoGPU.length === 0))
            : Boolean(context.gpu);
          const actualGpu = candidateGpuLayers > 0 && runtimeAccelerationEnabled;

          backendInitAttempts.push({
            candidate,
            nGpuLayers: Math.max(0, Math.round(candidateGpuLayers)),
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
            await releaseAllLlamaContexts().catch(() => undefined);
            lastBackendInitError = new Error(
              reasonNoGPU || `${candidate.toUpperCase()} acceleration was not enabled.`,
            );
            continue;
          }

          resolvedInitProfile = profile;
          resolvedInitGpuLayers = candidateGpuLayers;
          resolvedInitActualGpu = actualGpu;
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

          this.setContext(context);
          gpuInitError = null;
          break;
        } catch (error) {
          lastBackendInitError = error;
          if (backendInitAttempts.length === attemptsBeforeProfile) {
            backendInitAttempts.push({
              candidate,
              nGpuLayers: Math.max(0, Math.round(nGpuLayers)),
              devices,
              outcome: 'error',
              error: sanitizeErrorMessageForDiagnostics(error),
            });
          }

          if (candidate === 'cpu') {
            cpuInitError = error;
          } else {
            gpuInitError = error;
          }

          await releaseAllLlamaContexts().catch(() => undefined);
        }
      }

      publishBackendInitAttempts();

      if (!this.context) {
        throw lastBackendInitError ?? new Error('Failed to initialize inference backend');
      }

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
        this.captureBackendTelemetry(this.context, resolvedInitProfile, resolvedInitGpuLayers);
      } else {
        this.resetBackendTelemetry();
      }

      const reportedLoadedGpuLayers = this.resolveReportedLoadedGpuLayers(resolvedGpuLayers);
      this.activeContextSize = finalContextSize;
      this.activeGpuLayers = reportedLoadedGpuLayers;
      this.safeModeLoadLimits = shouldUseSafeLoadProfile
        ? { maxContextTokens: finalContextSize, requestedGpuLayers, loadedGpuLayers: reportedLoadedGpuLayers }
        : null;

      if (this.context) {
        await this.initializeMultimodalReadinessForLoadedContext({
          modelId,
          context: this.context,
          useGpu: resolvedInitActualGpu === true,
        });
      }

      if (resolvedInitProfile) {
        const isAcceleratorRequested = normalizedBackendPolicy === 'auto'
          || normalizedBackendPolicy === 'gpu'
          || normalizedBackendPolicy === 'npu';
        const didActuallyAccelerate = resolvedInitProfile.backendMode !== 'cpu' && resolvedInitActualGpu === true;
        const shouldPersistCpuFallback = resolvedInitProfile.backendMode === 'cpu'
          && (!isAcceleratorRequested || !lastGoodProfile || lastGoodProfile.backendMode === 'cpu');

        // Persist only profiles that are known-good.
        // - Accelerator modes: only when runtime reports acceleration actually enabled.
        // - CPU mode: persist when CPU was the intended policy, or when no accelerator last-good exists.
        if (didActuallyAccelerate || shouldPersistCpuFallback) {
          writeLastGoodInferenceProfile({
            createdAtMs: Date.now(),
            modelId,
            contextSize: loadParams.contextSize,
            kvCacheType: loadParams.kvCacheType,
            modelFileSizeBytes: verifiedFileSizeBytes,
            modelSha256: cachedModel?.sha256,
            backendMode: resolvedInitProfile.backendMode === 'gpu' || resolvedInitProfile.backendMode === 'npu'
              ? resolvedInitProfile.backendMode
              : 'cpu',
            nGpuLayers: resolvedInitProfile.backendMode === 'cpu'
              ? 0
              : (resolvedInitGpuLayers ?? resolvedInitProfile.nGpuLayers),
            ...(resolvedInitProfile.backendMode === 'npu' ? { devices: resolvedInitProfile.devices } : null),
          });
        }
      }
      this.loadedArtifactIdentity = loadedArtifactIdentity;
      this.updateState({ ...this.state, status: EngineStatus.READY, loadProgress: 1 });
      updateSettings({ activeModelId: modelId });

      const shouldProbeThinkingCapability = (() => {
        const model = registry.getModel(modelId);
        return model ? model.thinkingCapability === undefined : true;
      })();

      const shouldLaunchThinkingProbe = process.env.NODE_ENV !== 'test';

      if (shouldProbeThinkingCapability && shouldLaunchThinkingProbe) {
        this.launchThinkingCapabilityProbe(modelId);
      }
    } catch (error) {
      const baseError = toAppError(error, 'model_load_failed');
      const extraDetails: Record<string, unknown> = {
        ...(baseError.details ?? {}),
        ...(initDiagnostics ?? {}),
      };

      if (gpuInitError) {
        extraDetails.gpuInitError = sanitizeErrorMessageForDiagnostics(gpuInitError);
      }

      if (cpuInitError) {
        extraDetails.cpuInitError = sanitizeErrorMessageForDiagnostics(cpuInitError);
      }

      if (isDev && nativeLogs.length > 0) {
        extraDetails.nativeLogs = nativeLogs.map((line) => (
          sanitizeMultimodalFailureReason(`${line.level}: ${line.text}`, 512) ?? `${line.level}: [redacted]`
        ));
      }

      const errorCause = baseError.cause ?? (error instanceof AppError ? error.cause : error);
      const appError = Object.keys(extraDetails).length > 0
        ? new AppError(baseError.code, baseError.message, {
            cause: errorCause,
            details: extraDetails,
          })
        : baseError;

      if (
        appError.code === 'model_memory_warning'
        || appError.code === 'model_load_blocked'
        || appError.code === 'model_memory_insufficient'
      ) {
        const logLabel = appError.code === 'model_load_blocked'
          ? '[LLMEngine] Model load blocked during initialize'
          : appError.code === 'model_memory_insufficient'
            ? '[LLMEngine] Insufficient memory during initialize'
            : '[LLMEngine] Memory warning during initialize';
        console.warn(logLabel, {
          ...buildSafeErrorLogDetails(appError),
          ...(Object.keys(extraDetails).length > 0 ? { details: sanitizeDiagnosticValue(extraDetails) } : null),
        });
        this.setContext(null);
        this.loadedArtifactIdentity = null;
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

      console.error('[LLMEngine] Failed to initialize', {
        ...buildSafeErrorLogDetails(appError),
        ...(Object.keys(extraDetails).length > 0 ? { details: sanitizeDiagnosticValue(extraDetails) } : null),
      });
      this.lastModelLoadError = appError;
      this.lastModelLoadErrorScope = 'LLMEngineService.load';
      this.setContext(null);
      this.loadedArtifactIdentity = null;
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

      if (didEnableNativeLogs) {
        await toggleNativeLlamaLogs(false).catch(() => undefined);
      }

      this.initPromise = null;
    }
  }

  private async unloadInternal(): Promise<ModelUnloadReclaimEstimate | null> {
    const previousModelId = this.state.activeModelId ?? null;
    const activeContextReclaimEstimate = this.context
      ? this.resolveActiveContextEstimatedReclaimableBytes()
      : null;
    let beforeUnloadSnapshot: SystemMemorySnapshot | null = null;
    let unloadReclaimEstimate: ModelUnloadReclaimEstimate | null = null;
    let deferredContextReleaseError: AppError | null = null;
    this.isUnloading = true;
    this.resetRuntimeTelemetry();
    this.updateState({
      status: EngineStatus.IDLE,
      activeModelId: undefined,
      loadProgress: 0,
      lastError: undefined,
    });

    try {
      const activeCompletion = this.activeCompletionDriverPromise;
      if (activeCompletion) {
        let stopCompletionError: unknown;
        const stopCompletionPromise = this.stopCompletion().catch((error) => {
          stopCompletionError = error;
        });
        const completionAndStopDrainPromise = Promise.all([
          stopCompletionPromise,
          activeCompletion.catch(() => undefined),
        ]).then(() => undefined);
        const stopCompletionResult = await this.waitForUnloadPromise(
          stopCompletionPromise,
          CONTEXT_OPERATION_UNLOAD_DRAIN_TIMEOUT_MS,
        );
        if (stopCompletionResult === 'timed_out') {
          deferredContextReleaseError = this.recordActiveCompletionUnloadTimeout(previousModelId);
        } else if (stopCompletionError) {
          console.warn('[LLMEngine] Failed to stop completion before unload', buildSafeErrorLogDetails(stopCompletionError));
        }

        if (!deferredContextReleaseError) {
          const activeCompletionResult = await this.waitForUnloadPromise(
            activeCompletion.catch(() => undefined),
            CONTEXT_OPERATION_UNLOAD_DRAIN_TIMEOUT_MS,
          );
          if (activeCompletionResult === 'timed_out') {
            deferredContextReleaseError = this.recordActiveCompletionUnloadTimeout(previousModelId);
          }
        }

        if (deferredContextReleaseError && this.context) {
          const contextOperationDrainPromise = this.cancelActiveContextOperationsForDeferredUnload(
            deferredContextReleaseError,
          );
          this.scheduleDeferredContextReleaseAfterCompletionDrain({
            drainPromise: Promise.all([
              completionAndStopDrainPromise,
              contextOperationDrainPromise,
            ]).then(() => undefined),
            context: this.context,
            generation: this.contextGeneration,
          });
        }
      }

      if (!deferredContextReleaseError) {
        const contextDrainResult = await this.waitForActiveContextOperations({
          timeoutMs: CONTEXT_OPERATION_UNLOAD_DRAIN_TIMEOUT_MS,
        });
        if (contextDrainResult === 'timed_out') {
          const contextAtTimeout = this.context;
          const contextGenerationAtTimeout = this.contextGeneration;
          deferredContextReleaseError = this.recordContextOperationUnloadTimeout(previousModelId);
          if (contextAtTimeout) {
            this.scheduleDeferredContextReleaseAfterDrain({
              context: contextAtTimeout,
              generation: contextGenerationAtTimeout,
            });
          }
        } else if (this.context) {
          if (activeContextReclaimEstimate) {
            beforeUnloadSnapshot = await getFreshMemorySnapshot(0).catch(() => null);
          }
          await this.releaseActiveMultimodalContext();
          await releaseAllLlamaContexts();
        }
      }
    } finally {
      if (!deferredContextReleaseError) {
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

        if (calibrationSession || activeContextReclaimEstimate) {
          const afterUnloadSnapshot = await getFreshMemorySnapshot(0).catch(() => null);
          if (calibrationSession) {
            calibrationSession.afterUnloadSnapshot = afterUnloadSnapshot;
          }
          if (activeContextReclaimEstimate) {
            unloadReclaimEstimate = this.buildModelUnloadReclaimEstimate({
              previousModelId,
              estimatedReclaimableBytes: activeContextReclaimEstimate.bytes,
              source: activeContextReclaimEstimate.source,
              beforeUnloadSnapshot,
              afterUnloadSnapshot,
            });
          }
        }

        this.setContext(null);
        this.loadedArtifactIdentity = null;
        this.activeContextSize = DEFAULT_CONTEXT_SIZE;
        this.activeGpuLayers = null;
        this.safeModeLoadLimits = null;
        this.resetRuntimeTelemetry();
        updateSettings({ activeModelId: null });
        hardwareListenerService.resetLowMemoryFlag();
      }

      this.initPromise = null;
      if (!deferredContextReleaseError || !this.activeCompletionDriverPromise) {
        this.completionRunner.reset();
      }
      this.isUnloading = false;
    }

    if (deferredContextReleaseError) {
      throw deferredContextReleaseError;
    }

    return unloadReclaimEstimate;
  }
}

export const llmEngineService = new LLMEngineService();
