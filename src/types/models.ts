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

export interface ModelMetadata {
  id: string;
  name: string;
  author: string;
  size: number | null;
  downloadUrl: string; // HF resolve URL
  allowUnknownSizeDownload?: boolean;
  requiresTreeProbe?: boolean;
  resolvedFileName?: string;
  localPath?: string;
  downloadedAt?: number;
  sha256?: string;
  fitsInRam: boolean | null;
  accessState: ModelAccessState;
  isGated: boolean;
  isPrivate: boolean;
  lifecycleStatus: LifecycleStatus;
  downloadProgress: number;
  resumeData?: string;
  maxContextTokens?: number;
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
