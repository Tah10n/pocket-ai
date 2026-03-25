export enum LifecycleStatus {
  AVAILABLE = 'available',
  DOWNLOADING = 'downloading',
  QUEUED = 'queued',
  VERIFYING = 'verifying',
  DOWNLOADED = 'downloaded',
  ACTIVE = 'active',
}

export interface ModelMetadata {
  id: string;
  name: string;
  author: string;
  size: number;
  downloadUrl: string; // HF resolve URL
  localPath?: string;
  downloadedAt?: number;
  sha256?: string;
  fitsInRam: boolean;
  lifecycleStatus: LifecycleStatus;
  downloadProgress: number;
  resumeData?: string;
  maxContextTokens?: number;
  modelType?: string;
  architectures?: string[];
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
