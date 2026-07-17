import type {
  EngineBackendInitAttempt,
  EngineBackendMode,
  EngineBackendPolicy,
  EngineSpeculativeDecodingDiagnostics,
  EngineLifecycleEvent,
  EngineState,
  InferenceCompletionTelemetry,
  MtpFallbackReason,
} from '../types/models';
import type {
  MultimodalDiagnosticsSummary,
  MultimodalReadinessState,
  ProjectorPathCategoryDiagnostic,
  ProjectorPresenceDiagnostic,
  VisionCapabilityDiagnostic,
} from '../types/multimodal';
import { sanitizeMultimodalFailureCategory } from '../utils/multimodalFailureReason';

function toNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function toOptionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function toOptionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function buildInferenceCompletionTelemetry(source: {
  result: {
    tokens_predicted?: unknown;
    tokens_evaluated?: unknown;
    draft_tokens?: unknown;
    draft_tokens_accepted?: unknown;
    timings?: {
      predicted_per_second?: unknown;
      prompt_per_second?: unknown;
    } | null;
  };
  mtpRequested: boolean;
  mtpAttempted: boolean;
  mtpFallbackUsed: boolean;
  fallbackReason?: MtpFallbackReason | null;
  timeToFirstTokenMs?: number | null;
}): InferenceCompletionTelemetry {
  const draftTokens = toNonNegativeInteger(source.result.draft_tokens);
  const draftTokensAccepted = toNonNegativeInteger(source.result.draft_tokens_accepted);
  const acceptanceRate = draftTokens > 0
    ? Math.max(0, Math.min(1, draftTokensAccepted / draftTokens))
    : undefined;

  return {
    tokensPredicted: toNonNegativeInteger(source.result.tokens_predicted),
    tokensEvaluated: toNonNegativeInteger(source.result.tokens_evaluated),
    predictedPerSecond: toOptionalPositiveNumber(source.result.timings?.predicted_per_second),
    promptPerSecond: toOptionalPositiveNumber(source.result.timings?.prompt_per_second),
    timeToFirstTokenMs: toOptionalNonNegativeNumber(source.timeToFirstTokenMs),
    mtp: {
      requested: source.mtpRequested,
      attempted: source.mtpAttempted,
      fallbackUsed: source.mtpFallbackUsed,
      draftTokens,
      draftTokensAccepted,
      acceptanceRate,
      fallbackReason: source.fallbackReason ?? undefined,
    },
  };
}

function resolveVisionCapability(readiness: MultimodalReadinessState | null | undefined): VisionCapabilityDiagnostic {
  if (!readiness) {
    return 'unknown';
  }

  if (readiness.status === 'text_only') {
    return 'text_only';
  }

  if (readiness.requestedSupport !== undefined && !readiness.requestedSupport.includes('vision')) {
    return 'unknown';
  }

  if (readiness.status === 'unsupported') {
    return 'unsupported';
  }

  if (readiness.support.includes('vision')) {
    return 'vision_capable';
  }

  if (readiness.status === 'ready') {
    return 'unknown';
  }

  if (readiness.requestedSupport?.includes('vision') === true) {
    return 'vision_capable';
  }

  if ((readiness.requestedSupport?.length ?? 0) > 0) {
    return 'unknown';
  }

  if (
    readiness.projectorId
    || typeof readiness.projectorSize === 'number'
    || readiness.status === 'missing_projector'
    || readiness.status === 'ambiguous_projector'
    || readiness.status === 'projector_downloading'
    || readiness.status === 'initializing'
    || readiness.status === 'failed'
  ) {
    return 'vision_capable';
  }

  return 'unknown';
}

function hasProjectorEvidence(readiness: MultimodalReadinessState | null | undefined): boolean {
  return Boolean(readiness?.projectorId)
    || (typeof readiness?.projectorSize === 'number'
      && Number.isFinite(readiness.projectorSize)
      && readiness.projectorSize > 0);
}

function resolveProjectorPresence(readiness: MultimodalReadinessState | null | undefined): ProjectorPresenceDiagnostic {
  switch (readiness?.status) {
    case 'ready':
    case 'initializing':
      return readiness.projectorId || readiness.support.includes('vision') ? 'downloaded' : 'available_remote';
    case 'missing_projector':
    case 'text_only':
      return 'missing';
    case 'unsupported':
      return hasProjectorEvidence(readiness) ? 'downloaded' : 'missing';
    case 'ambiguous_projector':
      return 'ambiguous';
    case 'projector_downloading':
      return 'available_remote';
    case 'failed':
      return 'failed';
    default:
      return 'missing';
  }
}

function resolveProjectorPathCategory(readiness: MultimodalReadinessState | null | undefined): ProjectorPathCategoryDiagnostic {
  switch (readiness?.status) {
    case 'ready':
    case 'initializing':
    case 'failed':
      return readiness.projectorId || readiness.support.includes('vision') ? 'models' : 'unknown';
    case 'missing_projector':
    case 'text_only':
      return 'missing';
    case 'unsupported':
      return hasProjectorEvidence(readiness) ? 'models' : 'missing';
    case 'ambiguous_projector':
    case 'projector_downloading':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export function buildMultimodalDiagnosticsSummary(source: {
  readiness: MultimodalReadinessState | null | undefined;
  attachmentCount: number;
  attachmentTotalBytes?: number;
  failureReason?: string | null;
}): MultimodalDiagnosticsSummary | undefined {
  const attachmentCount = Number.isFinite(source.attachmentCount) && source.attachmentCount > 0
    ? Math.floor(source.attachmentCount)
    : 0;
  const hasAttachmentBytes = typeof source.attachmentTotalBytes === 'number'
    && Number.isFinite(source.attachmentTotalBytes)
    && source.attachmentTotalBytes > 0;
  const readiness = source.readiness ?? null;
  const failureReason = sanitizeMultimodalFailureCategory(source.failureReason ?? readiness?.failureReason);

  if (!readiness && attachmentCount === 0 && !failureReason) {
    return undefined;
  }

  const projectorSize = typeof readiness?.projectorSize === 'number'
    && Number.isFinite(readiness.projectorSize)
    && readiness.projectorSize > 0
    ? Math.round(readiness.projectorSize)
    : undefined;

  return {
    visionCapability: resolveVisionCapability(readiness),
    projectorPresence: resolveProjectorPresence(readiness),
    projectorPathCategory: resolveProjectorPathCategory(readiness),
    ...(projectorSize ? { projectorSize } : null),
    readinessStatus: readiness?.status ?? 'unsupported',
    ...(failureReason ? { failureReason } : null),
    attachmentCount,
    ...(hasAttachmentBytes ? { attachmentTotalBytes: Math.round(source.attachmentTotalBytes as number) } : null),
  };
}

export function buildEngineDiagnosticsSnapshot(source: {
  activeBackendMode: EngineBackendMode | 'unknown';
  activeBackendDevices: string[];
  activeBackendReasonNoGpu: string | null;
  activeBackendSystemInfo: string | null;
  activeBackendAndroidLib: string | null;
  requestedGpuLayers: number | null;
  activeGpuLayers: number | null;
  actualGpuAccelerated: boolean | null;
  requestedBackendPolicy: EngineBackendPolicy | null;
  effectiveBackendPolicy: EngineBackendPolicy | null;
  backendPolicyReasons: string[];
  backendInitAttemptsSnapshot: EngineBackendInitAttempt[];
  initGpuLayers: number | null;
  initDevices: string[] | null;
  initCacheTypeK: string | null;
  initCacheTypeV: string | null;
  initFlashAttnType: 'auto' | 'on' | 'off' | null;
  initUseMmap: boolean | null;
  initUseMlock: boolean | null;
  initNParallel: number | null;
  initNThreads: number | null;
  initCpuMask: string | null;
  initCpuStrict: boolean | null;
  initNBatch: number | null;
  initNUbatch: number | null;
  initKvUnified: boolean | null;
  lastLifecycleEvent: EngineLifecycleEvent | null;
  lastLifecycleError: string | null;
  multimodalDiagnostics: MultimodalDiagnosticsSummary | null;
  speculativeDecodingDiagnostics?: EngineSpeculativeDecodingDiagnostics | null;
}): NonNullable<EngineState['diagnostics']> {
  return {
    backendMode: source.activeBackendMode,
    backendDevices: [...source.activeBackendDevices],
    reasonNoGPU: source.activeBackendReasonNoGpu ?? undefined,
    systemInfo: source.activeBackendSystemInfo ?? undefined,
    androidLib: source.activeBackendAndroidLib ?? undefined,
    requestedGpuLayers: source.requestedGpuLayers ?? undefined,
    loadedGpuLayers: source.activeGpuLayers ?? undefined,
    actualGpuAccelerated: source.actualGpuAccelerated ?? undefined,
    requestedBackendPolicy: source.requestedBackendPolicy ?? undefined,
    effectiveBackendPolicy: source.effectiveBackendPolicy ?? undefined,
    backendPolicyReasons: source.backendPolicyReasons.length > 0 ? [...source.backendPolicyReasons] : undefined,
    backendInitAttempts: source.backendInitAttemptsSnapshot.length > 0
      ? source.backendInitAttemptsSnapshot.map((attempt) => ({
          ...attempt,
          devices: Array.isArray(attempt.devices) ? [...attempt.devices] : undefined,
        }))
      : undefined,
    initGpuLayers: source.initGpuLayers ?? undefined,
    initDevices: Array.isArray(source.initDevices) ? [...source.initDevices] : undefined,
    initCacheTypeK: source.initCacheTypeK ?? undefined,
    initCacheTypeV: source.initCacheTypeV ?? undefined,
    initFlashAttnType: source.initFlashAttnType ?? undefined,
    initUseMmap: source.initUseMmap ?? undefined,
    initUseMlock: source.initUseMlock ?? undefined,
    initNParallel: source.initNParallel ?? undefined,
    initNThreads: source.initNThreads ?? undefined,
    initCpuMask: source.initCpuMask ?? undefined,
    initCpuStrict: source.initCpuStrict ?? undefined,
    initNBatch: source.initNBatch ?? undefined,
    initNUbatch: source.initNUbatch ?? undefined,
    initKvUnified: source.initKvUnified ?? undefined,
    lastLifecycleEvent: source.lastLifecycleEvent ?? undefined,
    lastLifecycleError: source.lastLifecycleError ?? undefined,
    multimodal: source.multimodalDiagnostics ? { ...source.multimodalDiagnostics } : undefined,
    speculativeDecoding: source.speculativeDecodingDiagnostics
      ? {
          ...source.speculativeDecodingDiagnostics,
          memory: source.speculativeDecodingDiagnostics.memory
            ? { ...source.speculativeDecodingDiagnostics.memory }
            : undefined,
          lastCompletion: source.speculativeDecodingDiagnostics.lastCompletion
            ? {
                ...source.speculativeDecodingDiagnostics.lastCompletion,
                mtp: { ...source.speculativeDecodingDiagnostics.lastCompletion.mtp },
              }
            : undefined,
        }
      : undefined,
  };
}
