export enum LifecycleStatus {
  AVAILABLE = 'available',
  DOWNLOADING = 'downloading',
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
}

export enum EngineStatus {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ERROR = 'error',
}

export interface EngineState {
  status: EngineStatus;
  activeModelId?: string;
  loadProgress: number;
  lastError?: string;
}
