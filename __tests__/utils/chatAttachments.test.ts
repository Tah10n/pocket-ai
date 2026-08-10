import {
  CHAT_DOCUMENT_PICKER_MIME_TYPES,
  MAX_CHAT_OFFICE_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES,
  getRemainingChatAttachmentSlots,
  getSendableDraftDocumentAttachments,
  hasFailedDraftDocumentAttachments,
  isSupportedChatAttachmentMimeType,
  isSupportedChatDocumentDraftFormat,
  normalizeChatAttachmentKind,
  normalizeChatAttachmentProcessingState,
  normalizePersistedChatAttachment,
  resolveChatProcessableDocumentMimeType,
  resolveChatDocumentMaxBytes,
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
  it('includes controlled generic Android provider MIME types in the document picker', () => {
    expect(CHAT_DOCUMENT_PICKER_MIME_TYPES).toEqual(expect.arrayContaining([
      'application/octet-stream',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/epub+zip',
      'text/comma-separated-values',
    ]));
  });

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
    expect(resolveChatAttachmentKindFromMimeType('text/comma-separated-values')).toBe('document');
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

  it('validates sendable copied document drafts across direct and AnyDoc formats', () => {
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
    expect(resolveChatProcessableDocumentMimeType({
      mimeType: 'application/octet-stream',
      fileName: 'report.docx',
    })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(resolveChatProcessableDocumentMimeType({
      mimeType: 'application/zip',
      fileName: 'book.epub',
    })).toBe('application/epub+zip');
    expect(resolveChatProcessableDocumentMimeType({
      mimeType: 'text/comma-separated-values',
      fileName: 'table.csv',
    })).toBe('text/csv');
    expect(resolveChatProcessableDocumentMimeType({
      mimeType: 'application/octet-stream',
      fileName: 'arbitrary.zip',
    })).toBeNull();
    expect(resolveChatProcessableDocumentMimeType({
      mimeType: 'application/pdf',
      fileName: 'renamed.bin',
    })).toBe('application/pdf');
    expect(resolveChatProcessableDocumentMimeType({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'misleading.pdf',
    })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(resolveChatProcessableDocumentMimeType({
      mimeType: 'text/plain',
      fileName: 'binary.docx',
    })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(resolveChatTextDocumentMimeType({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'binary.txt',
    })).toBeNull();
    expect(isSupportedChatDocumentDraftFormat(readyDraft)).toBe(true);
    expect(isSupportedChatDocumentDraftFormat(failedDraft)).toBe(true);
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

  it('mirrors the native mobile source-byte profile for every document family', () => {
    expect(resolveChatDocumentMaxBytes('text/csv')).toBe(MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES);
    expect(resolveChatDocumentMaxBytes('text/comma-separated-values'))
      .toBe(MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES);
    expect(resolveChatDocumentMaxBytes('application/pdf')).toBe(MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES);
    expect(resolveChatDocumentMaxBytes('application/rtf')).toBe(MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES);
    expect(resolveChatDocumentMaxBytes('application/epub+zip')).toBe(MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES);
    expect(resolveChatDocumentMaxBytes(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )).toBe(MAX_CHAT_OFFICE_DOCUMENT_ATTACHMENT_BYTES);
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

  it('loads legacy processor-version 2 document metadata without rewriting its hash contract', () => {
    expect(normalizePersistedChatAttachment({
      id: 'legacy-document',
      kind: 'document',
      state: 'ready',
      threadId: 'thread-1',
      messageId: 'message-1',
      localUri: 'test-dir/chat-attachments/legacy-document.pdf',
      pathCategory: 'chat_attachment',
      fileName: 'legacy-document.pdf',
      displayName: 'Original legacy.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10_000,
      source: 'document_picker',
      createdAt: 1,
      document: {
        processorId: 'document-text',
        processorVersion: 2,
        contentHash: 'fnv1a32:deadbeef',
        pageCount: 2,
        extractedCharCount: 321,
        isScanned: false,
      },
    })).toEqual(expect.objectContaining({
      displayName: 'Original legacy.pdf',
      document: {
        processorId: 'document-text',
        processorVersion: 2,
        contentHash: 'fnv1a32:deadbeef',
        pageCount: 2,
        extractedCharCount: 321,
        isScanned: false,
      },
    }));
  });

  it('drops mismatched or unbounded v3 document metadata while preserving the safe attachment', () => {
    const normalized = normalizePersistedChatAttachment({
      id: 'strict-document',
      kind: 'document',
      state: 'ready',
      threadId: 'thread-1',
      messageId: 'message-1',
      localUri: 'test-dir/chat-attachments/strict-document.md',
      pathCategory: 'chat_attachment',
      fileName: 'strict-document.md',
      mimeType: 'text/markdown',
      sizeBytes: 10_000,
      source: 'document_picker',
      createdAt: 1,
      document: {
        processorId: 'document-text',
        processorVersion: 3,
        contentHash: `sha256:${'b'.repeat(64)}`,
        contentSha256: 'a'.repeat(64),
        canonicalFormat: 'future-format',
        parserId: 'unsafe\nparser',
        parserVersion: '1.0\u202e',
        exactAnyDocCommit: 'A'.repeat(40),
        sourceByteCount: (16 * 1024 * 1024) + 1,
        sourceCharCount: 100,
        selectedCharCount: 101,
        chunkCount: 2,
        selectedChunkCount: 3,
        slideCount: Number.MAX_SAFE_INTEGER + 1,
        warnings: ['context_truncated', 'unknown_warning', 'x'.repeat(1_000)],
      },
    });

    expect(normalized).toEqual(expect.objectContaining({
      kind: 'document',
      document: expect.objectContaining({
        processorId: 'document-text',
        processorVersion: 3,
        sourceCharCount: 100,
        chunkCount: 2,
        warnings: ['context_truncated'],
      }),
    }));
    const document = normalized?.kind === 'document' ? normalized.document : undefined;
    expect(document).not.toEqual(expect.objectContaining({ contentHash: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ contentSha256: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ sourceByteCount: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ selectedCharCount: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ selectedChunkCount: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ canonicalFormat: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ parserId: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ parserVersion: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ exactAnyDocCommit: expect.anything() }));
    expect(document).not.toEqual(expect.objectContaining({ slideCount: expect.anything() }));
  });

  it('preserves only an exact matching SHA-256 identity and bounded v3 processor metadata', () => {
    const sha256 = 'a'.repeat(64);
    const normalized = normalizePersistedChatAttachment({
      id: 'strict-valid-document',
      kind: 'document',
      state: 'ready',
      threadId: 'thread-1',
      messageId: 'message-1',
      localUri: 'test-dir/chat-attachments/strict-valid-document.docx',
      pathCategory: 'chat_attachment',
      fileName: 'strict-valid-document.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 10_000,
      source: 'document_picker',
      createdAt: 1,
      document: {
        processorId: 'pocket-anydoc',
        processorVersion: 3,
        contentHash: `sha256:${sha256}`,
        contentSha256: sha256,
        canonicalFormat: 'docx',
        parserId: 'anydoc',
        parserVersion: '0.1.7',
        exactAnyDocCommit: '4a45addbd607e8b59f0c263bca26aab228e10370',
        warnings: ['format_hint_mismatch', 'hidden_content_unverified'],
      },
    });

    expect(normalized).toEqual(expect.objectContaining({
      document: expect.objectContaining({
        contentHash: `sha256:${sha256}`,
        contentSha256: sha256,
        canonicalFormat: 'docx',
        parserId: 'anydoc',
        parserVersion: '0.1.7',
        exactAnyDocCommit: '4a45addbd607e8b59f0c263bca26aab228e10370',
        warnings: ['format_hint_mismatch', 'hidden_content_unverified'],
      }),
    }));
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
