import type {
  ModelArtifactRole,
  ModelChatModality,
  MultimodalDiagnosticsSummary,
  MultimodalReadinessState,
  ProjectorArtifact,
  VisionCapabilityConfidence,
  VisionCapabilitySource,
} from './multimodal';
import type { ModelInputCapabilitySnapshot } from './modelInputCapabilities';

export enum LifecycleStatus {
  AVAILABLE = 'available',
  DOWNLOADING = 'downloading',
  FAILED = 'failed',
  PAUSED = 'paused',
  QUEUED = 'queued',
  VERIFYING = 'verifying',
  DOWNLOADED = 'downloaded',
  ACTIVE = 'active',
}

export enum ModelAccessState {
  PUBLIC = 'public',
  AUTH_REQUIRED = 'auth_required',
  AUTHORIZED = 'authorized',
  ACCESS_DENIED = 'access_denied',
}

export type ModelMetadataTrust = 'verified_local' | 'trusted_remote' | 'inferred' | 'unknown';
export type ModelSizeResolutionState = 'resolving' | 'resolved' | 'unavailable';

export type ModelMemoryFitDecision =
  | 'fits_high_confidence'
  | 'fits_low_confidence'
  | 'borderline'
  | 'likely_oom'
  | 'unknown';

export type ModelMemoryFitConfidence = 'high' | 'medium' | 'low';

export type ModelSpeculativeDecodingMode = 'embedded' | 'draft_model';

export interface ModelSpeculativeDecodingConfig {
  type: 'mtp';
  mode: ModelSpeculativeDecodingMode;
  enabled: boolean;
  maxDraftTokens: number;
  draftArtifactId?: string;
}

export type MtpFallbackReason =
  | 'configured_draft_artifact_missing'
  | 'draft_artifact_unavailable'
  | 'memory_budget'
  | 'initialization_failed'
  | 'completion_failed';

export interface MtpCompletionTelemetry {
  requested: boolean;
  attempted: boolean;
  fallbackUsed: boolean;
  draftTokens: number;
  draftTokensAccepted: number;
  acceptanceRate?: number;
  fallbackReason?: MtpFallbackReason;
}

export interface InferenceCompletionTelemetry {
  tokensPredicted: number;
  tokensEvaluated: number;
  predictedPerSecond?: number;
  promptPerSecond?: number;
  timeToFirstTokenMs?: number;
  mtp: MtpCompletionTelemetry;
}

export interface EngineSpeculativeDecodingMemoryDiagnostics {
  beforeLoadAppBytes?: number;
  afterModelInitAppBytes?: number;
  afterFirstTokenAppBytes?: number;
  modelInitAppDeltaBytes?: number;
  firstTokenAppDeltaBytes?: number;
  beforeLoadPssBytes?: number;
  afterModelInitPssBytes?: number;
  afterFirstTokenPssBytes?: number;
  modelInitPssDeltaBytes?: number;
  firstTokenPssDeltaBytes?: number;
}

export interface EngineSpeculativeDecodingDiagnostics {
  configured: boolean;
  enabled: boolean;
  active: boolean;
  mode?: ModelSpeculativeDecodingMode;
  maxDraftTokens?: number;
  draftArtifactId?: string;
  draftModelBytes?: number;
  fallbackReason?: MtpFallbackReason;
  memory?: EngineSpeculativeDecodingMemoryDiagnostics;
  lastCompletion?: InferenceCompletionTelemetry;
}

export interface ModelGgufMetadata {
  [key: string]: string | number | undefined;
  totalBytes?: number;
  contextLengthTokens?: number;
  architecture?: string;
  sizeLabel?: string;
  nLayers?: number;
  nHeadKv?: number;
  nEmbdHeadK?: number;
  nEmbdHeadV?: number;
  slidingWindowTokens?: number;
}

export interface ModelCapabilitySnapshot {
  heuristicVersion: number;
  modelLayerCount: number | null;
  gpuLayersCeiling: number;
  metadataTrust: ModelMetadataTrust;
  sizeBytes?: number;
  verifiedFileSizeBytes?: number;
  verifiedMaxContextTokens?: number;
  ggufCapabilityDigest?: string;
  sha256?: string;
  lastModifiedAt?: number;
}

export interface ModelVariant {
  variantId: string;
  fileName: string;
  quantizationLabel: string;
  size: number | null;
  sha256?: string;
  ramFit?: ModelMemoryFitDecision;
  ramFitConfidence?: ModelMemoryFitConfidence;
  isLocal?: boolean;
  chatModalities?: ModelChatModality[];
  artifactRole?: ModelArtifactRole;
  visionSource?: VisionCapabilitySource;
  visionConfidence?: VisionCapabilityConfidence;
  projectorCandidates?: ProjectorArtifact[];
  selectedProjectorId?: string;
  speculativeDecoding?: ModelSpeculativeDecodingConfig;
}

export interface ModelThinkingCapabilitySnapshot {
  detectedAt: number;
  supportsThinking: boolean;
  canDisableThinking: boolean;
  thinkingStartTag?: string;
  thinkingEndTag?: string;
}

export interface ModelFileIntegrityMarker {
  kind: 'sha256' | 'size';
  sizeBytes: number;
  checkedAt: number;
  sha256?: string;
}

export type ModelArtifactKind =
  | 'main_model'
  | 'multimodal_projector'
  | 'speculative_draft';

export type ModelArtifactRequiredInput = 'text' | 'image' | 'audio';

export type ModelArtifactInstallState =
  | 'remote'
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'installed'
  | 'failed'
  | 'missing';

export interface ModelArtifactMetadata {
  id: string;
  kind: ModelArtifactKind;
  requiredFor: ModelArtifactRequiredInput[];
  hfRevision?: string;
  remoteFileName: string;
  downloadUrl: string;
  sizeBytes: number | null;
  sha256?: string;
  localPath?: string;
  installState: ModelArtifactInstallState;
  downloadProgress?: number;
  resumeData?: string;
  integrity?: ModelFileIntegrityMarker;
  errorCode?: string;
  errorMessage?: string;
  updatedAt?: number;
}

export interface ModelMetadata {
  id: string;
  name: string;
  author: string;
  size: number | null;
  /** Runtime-only catalog state; intentionally omitted from persistent normalization. */
  sizeResolutionState?: ModelSizeResolutionState;
  downloadUrl: string; // HF resolve URL
  allowUnknownSizeDownload?: boolean;
  requiresTreeProbe?: boolean;
  hfRevision?: string;
  resolvedFileName?: string;
  localPath?: string;
  downloadedAt?: number;
  lastModifiedAt?: number;
  sha256?: string;
  downloadIntegrity?: ModelFileIntegrityMarker;
  fitsInRam: boolean | null;
  memoryFitDecision?: ModelMemoryFitDecision;
  memoryFitConfidence?: ModelMemoryFitConfidence;
  metadataTrust?: ModelMetadataTrust;
  gguf?: ModelGgufMetadata;
  accessState: ModelAccessState;
  isGated: boolean;
  isPrivate: boolean;
  lifecycleStatus: LifecycleStatus;
  downloadProgress: number;
  resumeData?: string;
  downloadErrorCode?: string;
  downloadErrorMessage?: string;
  downloadErrorAt?: number;
  maxContextTokens?: number;
  hasVerifiedContextWindow?: boolean;
  capabilitySnapshot?: ModelCapabilitySnapshot;
  parameterSizeLabel?: string;
  modelType?: string;
  architectures?: string[];
  baseModels?: string[];
  license?: string;
  languages?: string[];
  datasets?: string[];
  quantizedBy?: string;
  modelCreator?: string;
  downloads?: number | null;
  likes?: number | null;
  tags?: string[];
  description?: string;
  variants?: ModelVariant[];
  activeVariantId?: string;
  thinkingCapability?: ModelThinkingCapabilitySnapshot;
  artifacts?: ModelArtifactMetadata[];
  chatModalities?: ModelChatModality[];
  inputCapabilities?: ModelInputCapabilitySnapshot;
  artifactRole?: ModelArtifactRole;
  visionSource?: VisionCapabilitySource;
  visionConfidence?: VisionCapabilityConfidence;
  projectorCandidates?: ProjectorArtifact[];
  selectedProjectorId?: string;
  multimodalReadiness?: MultimodalReadinessState;
  speculativeDecoding?: ModelSpeculativeDecodingConfig;
}

export enum EngineStatus {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ERROR = 'error',
}

export type EngineBackendMode = 'cpu' | 'gpu' | 'npu' | 'unknown';

export type EngineBackendPolicy = 'auto' | 'cpu' | 'gpu' | 'npu';

export type EngineLifecycleEvent =
  | 'low_memory_unload_failed'
  | 'context_operation_unload_timeout'
  | 'active_completion_unload_timeout';

export type EngineModelInitProfileSource =
  | 'requested'
  | 'conservative_probe'
  | 'autotune'
  | 'last_good'
  | 'oom_retry'
  | 'cpu_fallback'
  | 'speculative_fallback'
  | 'backend_discovery';

export type EngineModelInitFailureCategory =
  | 'out_of_memory'
  | 'backend_unavailable'
  | 'invalid_configuration'
  | 'model_incompatible'
  | 'cancelled'
  | 'native_error'
  | 'known_oom_upper_bound'
  | 'attempt_limit';

export type EngineBackendInitAttempt = {
  candidate: 'npu' | 'gpu' | 'cpu';
  nGpuLayers: number;
  deviceCount?: number;
  contextSize: number;
  nBatch?: number;
  nUbatch?: number;
  cacheTypeK: string;
  cacheTypeV: string;
  speculativeEnabled: boolean;
  profileSource: EngineModelInitProfileSource;
  probableOom: boolean;
  durationMs: number;
  outcome: 'success' | 'error' | 'skipped';
  failureCategory?: EngineModelInitFailureCategory;
  actualGpu?: boolean;
  reasonNoGPU?: string;
};

export interface EngineDiagnostics {
  backendMode: EngineBackendMode;
  backendDevices: string[];
  backendDeviceCount?: number;
  reasonNoGPU?: string;
  systemInfo?: string;
  androidLib?: string;
  requestedGpuLayers?: number;
  loadedGpuLayers?: number;
  actualGpuAccelerated?: boolean;
  requestedBackendPolicy?: EngineBackendPolicy;
  effectiveBackendPolicy?: EngineBackendPolicy;
  backendPolicyReasons?: string[];
  backendInitAttempts?: EngineBackendInitAttempt[];
  initGpuLayers?: number;
  initDevices?: string[];
  initDeviceCount?: number;
  initCacheTypeK?: string;
  initCacheTypeV?: string;
  initFlashAttnType?: 'auto' | 'on' | 'off';
  initUseMmap?: boolean;
  initUseMlock?: boolean;
  initNParallel?: number;
  initNThreads?: number;
  initCpuMask?: string;
  initCpuStrict?: boolean;
  initNBatch?: number;
  initNUbatch?: number;
  initKvUnified?: boolean;
  lastLifecycleEvent?: EngineLifecycleEvent;
  lastLifecycleError?: string;
  multimodal?: MultimodalDiagnosticsSummary;
  speculativeDecoding?: EngineSpeculativeDecodingDiagnostics;
}

export interface EngineState {
  status: EngineStatus;
  activeModelId?: string;
  loadProgress: number;
  lastError?: string;
  diagnostics?: EngineDiagnostics;
}
