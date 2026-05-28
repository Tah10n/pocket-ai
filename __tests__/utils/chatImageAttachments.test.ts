import {
  canAttachChatImages,
  getChatImageAttachmentMediaPaths,
  getRemainingChatImageAttachmentSlots,
  getSendableDraftImageAttachments,
  hasFailedDraftImageAttachments,
  isSupportedChatImageDraftFormat,
  isSupportedChatImageMimeType,
  MAX_CHAT_IMAGE_ATTACHMENTS,
  MAX_CHAT_IMAGE_ATTACHMENT_BYTES,
  MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS,
  MAX_CHAT_IMAGE_ATTACHMENT_TOTAL_PIXELS,
  summarizeChatImageAttachments,
  validateChatImageAttachmentBounds,
  validateChatImageAttachmentLimit,
} from '../../src/utils/chatImageAttachments';
import {
  copiedImageAttachments,
  draftImageAttachment,
  failedDraftImageAttachment,
} from '../fixtures/chatImageAttachmentFixtures';
import type { AttachmentDraft } from '../../src/types/multimodal';

describe('chatImageAttachments', () => {
  it('enforces the four image attachment limit', () => {
    expect(MAX_CHAT_IMAGE_ATTACHMENTS).toBe(4);
    expect(getRemainingChatImageAttachmentSlots(1)).toBe(3);
    expect(canAttachChatImages(3, 1)).toBe(true);
    expect(canAttachChatImages(3, 2)).toBe(false);
    expect(validateChatImageAttachmentLimit(4, 1)).toEqual({
      ok: false,
      reason: 'limit_exceeded',
      allowedRemaining: 0,
    });
  });

  it('filters sendable drafts to runtime-supported image formats', () => {
    const unknownMimeJpegDraft: AttachmentDraft = {
      ...draftImageAttachment,
      fileName: 'image-without-mime.jpg',
      localUri: 'test-dir/chat-attachments/image-without-mime.jpg',
      mediaType: undefined,
      pickerUri: 'ph://library-image-unknown',
      copyStatus: 'copied',
    };
    const unknownMimeHeicDraft: AttachmentDraft = {
      ...draftImageAttachment,
      fileName: 'image-without-mime.heic',
      mediaType: undefined,
      pickerUri: 'ph://library-image-heic',
    };
    const unknownMimeQueryDraft: AttachmentDraft = {
      ...draftImageAttachment,
      fileName: undefined,
      mediaType: undefined,
      localUri: 'test-dir/chat-attachments/image-with-query.png',
      previewUri: 'file:///tmp/image-with-query.PNG?cache=1',
      pickerUri: 'file:///tmp/image-with-query.PNG?cache=1',
      copyStatus: 'copied',
    };
    const unsupportedDraft: AttachmentDraft = {
      ...draftImageAttachment,
      fileName: 'unsupported.heic',
      mediaType: 'image/heic',
      pickerUri: 'file:///tmp/unsupported.heic',
    };
    const oversizedDraft: AttachmentDraft = {
      ...draftImageAttachment,
      fileName: 'oversized.jpg',
      localUri: 'test-dir/chat-attachments/oversized.jpg',
      size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES + 1,
      copyStatus: 'copied',
    };
    const unknownDimensionsDraft: AttachmentDraft = {
      pickerUri: draftImageAttachment.pickerUri,
      previewUri: draftImageAttachment.previewUri,
      pathCategory: 'chat_attachment',
      mediaType: draftImageAttachment.mediaType,
      size: draftImageAttachment.size,
      fileName: 'unknown-dimensions.jpg',
      localUri: 'test-dir/chat-attachments/unknown-dimensions.jpg',
      copyStatus: 'copied',
    };

    expect(isSupportedChatImageMimeType('image/jpeg')).toBe(true);
    expect(isSupportedChatImageMimeType(undefined)).toBe(false);
    expect(isSupportedChatImageMimeType('image/heic')).toBe(false);
    expect(isSupportedChatImageDraftFormat(unknownMimeJpegDraft)).toBe(true);
    expect(isSupportedChatImageDraftFormat(unknownMimeHeicDraft)).toBe(false);
    expect(isSupportedChatImageDraftFormat(unknownMimeQueryDraft)).toBe(true);
    expect(hasFailedDraftImageAttachments([draftImageAttachment, failedDraftImageAttachment])).toBe(true);
    const copiedSupportedDraft: AttachmentDraft = {
      ...draftImageAttachment,
      fileName: 'draft-image.jpg',
      localUri: 'test-dir/chat-attachments/draft-image.jpg',
      copyStatus: 'copied',
    };

    expect(getSendableDraftImageAttachments([
      copiedSupportedDraft,
      failedDraftImageAttachment,
      unknownMimeJpegDraft,
      unknownMimeHeicDraft,
      unknownMimeQueryDraft,
      unsupportedDraft,
      oversizedDraft,
      unknownDimensionsDraft,
    ])).toEqual([
      copiedSupportedDraft,
      unknownMimeJpegDraft,
      unknownMimeQueryDraft,
      unknownDimensionsDraft,
    ]);
  });

  it('normalizes persisted attachment URIs for runtime media paths and diagnostics summaries', () => {
    expect(getChatImageAttachmentMediaPaths(copiedImageAttachments)).toEqual([
      'test-dir/chat-attachments/thread-vision-1/attachment-image-1.jpg',
      'test-dir/chat-attachments/thread-vision-1/attachment-image-2.png',
    ]);

    expect(getChatImageAttachmentMediaPaths([
      { localUri: 'test-dir/chat-attachments/../models/model.gguf' },
      { localUri: 'file:///document/chat-attachments/attachment-image-1.jpg' },
    ])).toEqual([]);

    expect(summarizeChatImageAttachments(copiedImageAttachments)).toEqual({
      count: 2,
      totalBytes: 358_023,
    });
  });

  it('enforces app-level image attachment byte and pixel bounds while accepting unknown dimensions', () => {
    expect(validateChatImageAttachmentBounds({
      size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES,
      width: MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS,
      height: MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS,
    })).toEqual({ ok: true });

    expect(validateChatImageAttachmentBounds({ size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES + 1 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(validateChatImageAttachmentBounds({ width: MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS + 1 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(validateChatImageAttachmentBounds({
      width: MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS,
      height: Math.floor(MAX_CHAT_IMAGE_ATTACHMENT_TOTAL_PIXELS / MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS) + 1,
    })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(validateChatImageAttachmentBounds({ width: 1280 })).toEqual({ ok: true });
    expect(validateChatImageAttachmentBounds({ height: 768 })).toEqual({ ok: true });
    expect(validateChatImageAttachmentBounds({ width: 0, height: 768 })).toEqual({ ok: true });
    expect(validateChatImageAttachmentBounds({ size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES })).toEqual({ ok: true });
    expect(validateChatImageAttachmentBounds({ size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES }, {
      requireDimensions: false,
    })).toEqual({ ok: true });
  });
});
