export const CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY = 'chat_attachment' as const;

export type ModelChatModality = 'text' | 'vision' | 'audio';

export type ModelArtifactRole = 'primary_chat_model' | 'projector_companion';

export type VisionCapabilitySource =
  | 'catalog_metadata'
  | 'tree_probe'
  | 'gguf_metadata'
  | 'runtime_probe'
  | 'user_selected_projector';

export type VisionCapabilityConfidence = 'verified' | 'trusted' | 'inferred' | 'unknown';

export type ProjectorLifecycleStatus =
  | 'available'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'failed'
  | 'downloaded'
  | 'active';

export type ProjectorMatchStatus =
  | 'missing'
  | 'matched'
  | 'ambiguous'
  | 'user_selected'
  | 'failed';

export interface ProjectorArtifact {
  id: string;
  ownerModelId: string;
  ownerVariantId?: string;
  repoId: string;
  fileName: string;
  downloadUrl: string;
  hfRevision?: string;
  sha256?: string;
  size: number | null;
  localPath?: string;
  resumeData?: string;
  downloadProgress?: number;
  lifecycleStatus: ProjectorLifecycleStatus;
  matchStatus: ProjectorMatchStatus;
  matchReason?: string;
}

export type MultimodalReadinessStatus =
  | 'ready'
  | 'text_only'
  | 'missing_projector'
  | 'ambiguous_projector'
  | 'projector_downloading'
  | 'initializing'
  | 'failed'
  | 'unsupported';

export type MultimodalSupportModality = 'vision' | 'audio';

export interface MultimodalReadinessState {
  modelId: string;
  variantId?: string;
  status: MultimodalReadinessStatus;
  projectorId?: string;
  projectorSize?: number;
  support: MultimodalSupportModality[];
  requestedSupport?: MultimodalSupportModality[];
  failureReason?: string;
  checkedAt: number;
}

export type ChatImageAttachmentPathCategory = typeof CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY;

export type ChatImageAttachmentSource = 'photo_library';

export interface ChatImageAttachment {
  id: string;
  threadId: string;
  messageId: string;
  localUri: string;
  thumbnailUri?: string;
  pathCategory: ChatImageAttachmentPathCategory;
  mediaType?: string;
  fileName: string;
  thumbnailFileName?: string;
  size?: number;
  width?: number;
  height?: number;
  source: ChatImageAttachmentSource;
  createdAt: number;
}

export type AttachmentDraftCopyStatus = 'pending' | 'copied' | 'failed' | 'discarded';

export interface AttachmentDraft {
  id?: string;
  pickerUri: string;
  previewUri: string;
  localUri?: string;
  thumbnailUri?: string;
  pathCategory?: ChatImageAttachmentPathCategory;
  fileName?: string;
  thumbnailFileName?: string;
  mediaType?: string;
  size?: number;
  width?: number;
  height?: number;
  copyStatus: AttachmentDraftCopyStatus;
  errorReason?: string;
}

export type VisionCapabilityDiagnostic =
  | 'text_only'
  | 'vision_capable'
  | 'unsupported'
  | 'unknown';

export type ProjectorPresenceDiagnostic =
  | 'missing'
  | 'available_remote'
  | 'downloaded'
  | 'ambiguous'
  | 'failed';

export type ProjectorPathCategoryDiagnostic = 'models' | 'missing' | 'unknown';

export interface MultimodalDiagnosticsSummary {
  visionCapability: VisionCapabilityDiagnostic;
  projectorPresence: ProjectorPresenceDiagnostic;
  projectorPathCategory: ProjectorPathCategoryDiagnostic;
  projectorSize?: number;
  readinessStatus: MultimodalReadinessStatus;
  failureReason?: string;
  attachmentCount: number;
  attachmentTotalBytes?: number;
}
