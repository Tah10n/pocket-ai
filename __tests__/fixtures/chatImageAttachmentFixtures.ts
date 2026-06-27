export const chatAttachmentThreadId = 'thread-vision-1';
export const chatAttachmentMessageId = 'message-user-1';

export const copiedImageAttachment = {
  id: 'attachment-image-1',
  threadId: chatAttachmentThreadId,
  messageId: chatAttachmentMessageId,
  localUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-1.jpg',
  pathCategory: 'chat_attachment',
  mediaType: 'image/jpeg',
  fileName: 'attachment-image-1.jpg',
  size: 123_456,
  width: 1024,
  height: 768,
  source: 'photo_library',
  createdAt: 1_780_000_000_000,
} as const;

export const secondCopiedImageAttachment = {
  ...copiedImageAttachment,
  id: 'attachment-image-2',
  localUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-2.png',
  mediaType: 'image/png',
  fileName: 'attachment-image-2.png',
  size: 234_567,
  width: 800,
  height: 600,
} as const;

export const copiedImageAttachments = [
  copiedImageAttachment,
  secondCopiedImageAttachment,
] as const;

export const draftImageAttachment = {
  pickerUri: 'ph://library-image-1',
  previewUri: 'file:///cache/image-picker-preview-1.jpg',
  mediaType: 'image/jpeg',
  size: 123_456,
  width: 1024,
  height: 768,
  copyStatus: 'pending',
  errorReason: undefined,
} as const;

export const copiedDraftImageAttachment = {
  ...draftImageAttachment,
  id: 'draft-image-1',
  previewUri: 'test-dir/chat-attachments/draft-image-1.jpg',
  localUri: 'test-dir/chat-attachments/draft-image-1.jpg',
  pathCategory: 'chat_attachment',
  fileName: 'draft-image-1.jpg',
  copyStatus: 'copied',
} as const;

export const failedDraftImageAttachment = {
  ...draftImageAttachment,
  pickerUri: 'ph://library-image-failed',
  previewUri: 'file:///cache/image-picker-preview-failed.jpg',
  copyStatus: 'failed',
  errorReason: 'copy_failed',
} as const;
