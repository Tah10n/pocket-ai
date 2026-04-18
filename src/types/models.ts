export enum LifecycleStatus {
  AVAILABLE = 'available',
  DOWNLOADING = 'downloading',
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

export type ModelMemoryFitDecision =
  | 'fits_high_confidence'
  | 'fits_low_confidence'
  | 'borderline'
  | 'likely_oom'
  | 'unknown';

export type ModelMemoryFitConfidence = 'high' | 'medium' | 'low';

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
  quantizationLabel: string;
  size: number | null;
  ramFit?: ModelMemoryFitDecision;
  isLocal?: boolean;
}

export interface ModelThinkingCapabilitySnapshot {
  detectedAt: number;
  supportsThinking: boolean;
  canDisableThinking: boolean;
  thinkingStartTag?: string;
  thinkingEndTag?: string;
}

export interface ModelMetadata {
  id: string;
  name: string;
  author: string;
  size: number | null;
  downloadUrl: string; // HF resolve URL
  allowUnknownSizeDownload?: boolean;
  requiresTreeProbe?: boolean;
  hfRevision?: string;
  resolvedFileName?: string;
  localPath?: string;
  downloadedAt?: number;
  lastModifiedAt?: number;
  sha256?: string;
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
}

export enum EngineStatus {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ERROR = 'error',
}

export type EngineBackendMode = 'cpu' | 'gpu' | 'npu' | 'unknown';

export type EngineBackendPolicy = 'auto' | 'cpu' | 'gpu' | 'npu';

export type EngineBackendInitAttempt = {
  candidate: 'npu' | 'gpu' | 'cpu';
  nGpuLayers: number;
  devices?: string[];
  outcome: 'success' | 'error' | 'skipped';
  actualGpu?: boolean;
  reasonNoGPU?: string;
  error?: string;
};

export interface EngineDiagnostics {
  backendMode: EngineBackendMode;
  backendDevices: string[];
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
}

export interface EngineState {
  status: EngineStatus;
  activeModelId?: string;
  loadProgress: number;
  lastError?: string;
  diagnostics?: EngineDiagnostics;
}
