import {
  getRemainingChatAttachmentSlots,
  getSendableDraftDocumentAttachments,
  hasFailedDraftDocumentAttachments,
  isSupportedChatAttachmentMimeType,
  isSupportedChatDocumentDraftFormat,
  normalizeChatAttachmentKind,
  normalizeChatAttachmentProcessingState,
  normalizePersistedChatAttachment,
  resolveChatProcessableDocumentMimeType,
  resolveChatTextDocumentMimeType,
  resolveChatAttachmentKind,
  resolveChatAttachmentKindFromFileName,
  resolveChatAttachmentKindFromMimeType,
  resolveChatAttachmentRuntimeInputs,
  resolveChatAudioFormatFromMimeType,
  resolveChatAudioFormatFromPath,
  resolveRequiredNativeCapabilities,
  toGenericChatAttachmentFromLegacyImageAttachment,
  toLegacyChatImageAttachment,
  validateChatAttachmentLimit,
  validateChatDocumentAttachmentLimit,
} from '../../src/utils/chatAttachments';
import type { ChatDocumentAttachmentDraft } from '../../src/types/attachments';
import { copiedImageAttachment } from '../fixtures/chatImageAttachmentFixtures';

describe('chatAttachments generic attachment helpers', () => {
  it('normalizes known attachment kinds and processing states', () => {
    expect(normalizeChatAttachmentKind(' IMAGE ')).toBe('image');
    expect(normalizeChatAttachmentKind('document')).toBe('document');
    expect(normalizeChatAttachmentKind('camera')).toBeNull();

    expect(normalizeChatAttachmentProcessingState(' READY ')).toBe('ready');
    expect(normalizeChatAttachmentProcessingState('discarded')).toBeNull();
  });

  it('resolves supported attachment kinds from MIME types and file names', () => {
    expect(resolveChatAttachmentKindFromMimeType('image/heic')).toBe('image');
    expect(resolveChatAttachmentKindFromMimeType('audio/mpeg')).toBe('audio');
    expect(resolveChatAttachmentKindFromMimeType('application/pdf')).toBe('document');
    expect(resolveChatAttachmentKindFromMimeType('video/mp4')).toBe('video');
    expect(resolveChatAttachmentKindFromMimeType('application/octet-stream')).toBeNull();

    expect(resolveChatAttachmentKindFromFileName('photo.JPG?cache=1')).toBe('image');
    expect(resolveChatAttachmentKindFromFileName('voice.WAV')).toBe('audio');
    expect(resolveChatAttachmentKindFromFileName('notes.markdown')).toBe('document');
    expect(resolveChatAttachmentKindFromFileName('table.tsv')).toBe('document');
    expect(resolveChatAttachmentKindFromFileName('clip.mov')).toBe('video');
    expect(resolveChatAttachmentKindFromFileName('archive.zip')).toBeNull();
  });

  it('prefers MIME type but falls back to file name and local URI', () => {
    expect(resolveChatAttachmentKind({
      mediaType: 'text/plain',
      fileName: 'photo.jpg',
      localUri: 'file:///document/photo.jpg',
    })).toBe('document');

    expect(resolveChatAttachmentKind({
      fileName: 'unknown.bin',
      localUri: 'file:///document/chat-attachments/audio.mp3',
    })).toBe('audio');

    expect(isSupportedChatAttachmentMimeType('video/webm')).toBe(true);
    expect(isSupportedChatAttachmentMimeType('application/x-msdownload')).toBe(false);
  });

  it('resolves audio runtime formats from MIME types and paths', () => {
    expect(resolveChatAudioFormatFromMimeType('audio/mpeg')).toBe('mp3');
    expect(resolveChatAudioFormatFromMimeType('audio/x-wav')).toBe('wav');
    expect(resolveChatAudioFormatFromMimeType('audio/aac')).toBeNull();

    expect(resolveChatAudioFormatFromPath('file:///document/voice.mp3')).toBe('mp3');
    expect(resolveChatAudioFormatFromPath('file:///document/voice.wave')).toBe('wav');
    expect(resolveChatAudioFormatFromPath('file:///document/voice.aac')).toBeNull();
  });

  it('enforces conservative per-kind attachment limits before UI integration', () => {
    expect(getRemainingChatAttachmentSlots('image', 2)).toBe(2);
    expect(validateChatAttachmentLimit('image', 3, 1)).toEqual({
      ok: true,
      allowedRemaining: 1,
    });
    expect(validateChatAttachmentLimit('image', 3, 2)).toEqual({
      ok: false,
      reason: 'limit_exceeded',
      allowedRemaining: 1,
    });
    expect(validateChatAttachmentLimit('audio', 1, 1)).toEqual({
      ok: false,
      reason: 'limit_exceeded',
      allowedRemaining: 0,
    });
    expect(validateChatAttachmentLimit('video', 0, 2)).toEqual({
      ok: false,
      reason: 'limit_exceeded',
      allowedRemaining: 1,
    });
  });

  it('maps attachment kinds to runtime inputs and required native capabilities', () => {
    expect(resolveChatAttachmentRuntimeInputs('image')).toEqual(['image']);
    expect(resolveChatAttachmentRuntimeInputs('audio')).toEqual(['audio']);
    expect(resolveChatAttachmentRuntimeInputs('document')).toEqual(['document_text']);
    expect(resolveChatAttachmentRuntimeInputs('video')).toEqual([]);

    expect(resolveRequiredNativeCapabilities('image')).toEqual(['vision']);
    expect(resolveRequiredNativeCapabilities('audio')).toEqual(['audio']);
    expect(resolveRequiredNativeCapabilities('document')).toEqual([]);
    expect(resolveRequiredNativeCapabilities('video')).toEqual([]);
  });

  it('validates sendable copied text document drafts', () => {
    const readyDraft: ChatDocumentAttachmentDraft = {
      id: 'document-1',
      pickerUri: 'content://documents/document-1.txt',
      localUri: 'test-dir/chat-attachments/document-1.txt',
      pathCategory: 'chat_attachment',
      fileName: 'document-1.txt',
      displayName: 'Meeting notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 1024,
      source: 'document_picker',
      createdAt: 1,
      copyStatus: 'copied',
    };
    const failedDraft: ChatDocumentAttachmentDraft = {
      pickerUri: 'content://documents/broken.docx',
      fileName: 'broken.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      copyStatus: 'failed',
      errorReason: 'unsupported_type',
    };

    expect(resolveChatTextDocumentMimeType({ fileName: 'table.tsv' }))
      .toBe('text/tab-separated-values');
    expect(resolveChatProcessableDocumentMimeType({ fileName: 'paper.pdf' }))
      .toBe('application/pdf');
    expect(isSupportedChatDocumentDraftFormat(readyDraft)).toBe(true);
    expect(isSupportedChatDocumentDraftFormat(failedDraft)).toBe(false);
    expect(getSendableDraftDocumentAttachments([readyDraft, failedDraft])).toEqual([readyDraft]);
    expect(hasFailedDraftDocumentAttachments([readyDraft, failedDraft])).toBe(true);
    expect(validateChatDocumentAttachmentLimit(3, 1)).toEqual({
      ok: true,
      allowedRemaining: 1,
    });
    expect(validateChatDocumentAttachmentLimit(3, 2)).toEqual({
      ok: false,
      reason: 'limit_exceeded',
      allowedRemaining: 1,
    });
  });

  it('normalizes persisted generic attachment metadata and rejects unsafe local URIs', () => {
    expect(normalizePersistedChatAttachment({
      id: 'audio-1',
      kind: 'audio',
      state: 'ready',
      threadId: 'thread-1',
      messageId: 'message-1',
      localUri: 'test-dir/chat-attachments/audio-1.mp3',
      pathCategory: 'chat_attachment',
      fileName: 'audio-1.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 10_000,
      source: 'document_picker',
      createdAt: 1,
      audio: { durationMs: 900 },
    })).toEqual(expect.objectContaining({
      id: 'audio-1',
      kind: 'audio',
      state: 'ready',
      mimeType: 'audio/mpeg',
      sizeBytes: 10_000,
      audio: {
        format: 'mp3',
        durationMs: 900,
      },
    }));

    expect(normalizePersistedChatAttachment({
      id: 'outside',
      kind: 'image',
      state: 'ready',
      threadId: 'thread-1',
      messageId: 'message-1',
      localUri: 'file:///outside/image.jpg',
      pathCategory: 'chat_attachment',
      fileName: 'image.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      source: 'photo_library',
      createdAt: 1,
    })).toBeNull();
  });

  it('adapts legacy image attachments to generic metadata and back for migration', () => {
    const generic = toGenericChatAttachmentFromLegacyImageAttachment(copiedImageAttachment);
    expect(generic).toEqual(expect.objectContaining({
      id: copiedImageAttachment.id,
      kind: 'image',
      state: 'ready',
      mimeType: 'image/jpeg',
      sizeBytes: copiedImageAttachment.size,
      image: {
        width: copiedImageAttachment.width,
        height: copiedImageAttachment.height,
      },
    }));

    if (!generic) {
      throw new Error('Expected generic attachment');
    }

    expect(toLegacyChatImageAttachment(generic)).toEqual(expect.objectContaining({
      id: copiedImageAttachment.id,
      localUri: copiedImageAttachment.localUri,
      mediaType: 'image/jpeg',
      size: copiedImageAttachment.size,
      width: copiedImageAttachment.width,
      height: copiedImageAttachment.height,
      source: 'photo_library',
    }));
  });
});
