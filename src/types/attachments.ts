export type ChatAttachmentKind = 'image' | 'audio' | 'document' | 'video';

export type ChatAttachmentProcessingState =
  | 'staged'
  | 'processing'
  | 'ready'
  | 'failed';

export type ChatAttachmentPathCategory = 'chat_attachment';

export type ChatAttachmentSource =
  | 'photo_library'
  | 'document_picker'
  | 'derived_processor';

export type ChatAttachmentRuntimeInput =
  | 'image'
  | 'audio'
  | 'document_text'
  | 'video_frames'
  | 'video_audio';

export type ChatAttachmentNativeCapability = 'vision' | 'audio';

export type ChatDocumentAttachmentDraftCopyStatus =
  | 'pending'
  | 'copied'
  | 'failed'
  | 'discarded';

export type ChatDocumentAttachmentDraftErrorReason =
  | 'unsupported_type'
  | 'too_large'
  | 'copy_failed'
  | 'missing'
  | 'parse_failed';

export type ChatMediaAttachmentDraftKind = 'audio';

export type ChatMediaAttachmentDraftCopyStatus =
  | 'pending'
  | 'copied'
  | 'failed'
  | 'discarded';

export type ChatMediaAttachmentDraftErrorReason =
  | 'unsupported_type'
  | 'too_large'
  | 'copy_failed'
  | 'missing'
  | 'processing_failed'
  | 'unsupported_by_model';

export interface ChatAttachmentBase {
  id: string;
  kind: ChatAttachmentKind;
  state: ChatAttachmentProcessingState;
  threadId: string;
  messageId: string;
  localUri: string;
  pathCategory: ChatAttachmentPathCategory;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  source: ChatAttachmentSource;
  createdAt: number;
  errorCode?: string;
  errorMessage?: string;
  derivedFromAttachmentId?: string;
}

export interface ChatImageAttachmentMetadata {
  width?: number;
  height?: number;
  thumbnailUri?: string;
  thumbnailFileName?: string;
}

export interface ChatAudioAttachmentMetadata {
  format: 'wav' | 'mp3';
  durationMs?: number;
}

export interface ChatDocumentAttachmentMetadata {
  processorId: string;
  processorVersion: number;
  contentHash?: string;
  pageCount?: number;
  extractedCharCount?: number;
  isScanned?: boolean;
}

export interface ChatVideoAttachmentMetadata {
  durationMs?: number;
  width?: number;
  height?: number;
  derivedAttachmentIds: string[];
  samplingVersion: number;
}

export type ChatAttachment =
  | (ChatAttachmentBase & {
    kind: 'image';
    image?: ChatImageAttachmentMetadata;
  })
  | (ChatAttachmentBase & {
    kind: 'audio';
    audio: ChatAudioAttachmentMetadata;
  })
  | (ChatAttachmentBase & {
    kind: 'document';
    document: ChatDocumentAttachmentMetadata;
  })
  | (ChatAttachmentBase & {
    kind: 'video';
    video: ChatVideoAttachmentMetadata;
  });

export interface ChatDocumentAttachmentDraft {
  id?: string;
  pickerUri: string;
  localUri?: string;
  pathCategory?: ChatAttachmentPathCategory;
  fileName?: string;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: number;
  source?: Extract<ChatAttachmentSource, 'document_picker'>;
  createdAt?: number;
  copyStatus: ChatDocumentAttachmentDraftCopyStatus;
  errorReason?: ChatDocumentAttachmentDraftErrorReason;
}

export interface ChatMediaAttachmentDraft {
  id?: string;
  kind: ChatMediaAttachmentDraftKind;
  pickerUri: string;
  localUri?: string;
  previewUri?: string;
  pathCategory?: ChatAttachmentPathCategory;
  fileName?: string;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: number;
  source?: ChatAttachmentSource;
  createdAt?: number;
  copyStatus: ChatMediaAttachmentDraftCopyStatus;
  errorReason?: ChatMediaAttachmentDraftErrorReason;
  audio?: ChatAudioAttachmentMetadata;
}
