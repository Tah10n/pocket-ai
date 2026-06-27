export type NativeInputModality = 'image' | 'audio' | 'video';

export type AppDerivedInputModality = 'document' | 'video_frames' | 'video_audio';

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export type CapabilityConfidence = 'high' | 'medium' | 'low';

export interface CapabilityEvidence {
  source:
    | 'pipeline_tag'
    | 'tag'
    | 'architecture'
    | 'config'
    | 'repository_tree'
    | 'projector'
    | 'runtime';
  value: string;
  confidence: CapabilityConfidence;
}

export interface ModelInputCapabilitySnapshot {
  detectedAt: number;
  declared: Record<NativeInputModality, CapabilityState>;
  evidence: CapabilityEvidence[];
}

export interface RuntimeInputCapabilitySnapshot {
  checkedAt: number;
  multimodalInitialized: boolean;
  vision: boolean;
  audio: boolean;
  video: false;
  initializationErrorCode?: string;
}

export interface EffectiveInputCapabilities {
  text: boolean;
  image: boolean;
  audio: boolean;
  document: boolean;
  videoFrames: boolean;
  videoAudio: boolean;
  directVideo: false;
  reasons: Partial<Record<
    'image' | 'audio' | 'document' | 'videoFrames' | 'videoAudio',
    string
  >>;
}
