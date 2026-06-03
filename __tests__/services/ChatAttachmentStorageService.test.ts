import * as FileSystem from 'expo-file-system/legacy';
import {
  ChatAttachmentStorageService,
  buildFailedAttachmentDraft,
  collectChatAttachmentLocalUrisFromUnknownThreadRecord,
  collectReferencedChatAttachmentLocalUrisFromThreads,
  getChatAttachmentsDir,
  materializeAttachmentDraftsForMessage,
} from '../../src/services/ChatAttachmentStorageService';
import {
  chatAttachmentMessageId,
  chatAttachmentThreadId,
  copiedDraftImageAttachment,
  failedDraftImageAttachment,
} from '../fixtures/chatImageAttachmentFixtures';
import {
  MAX_CHAT_IMAGE_ATTACHMENT_BYTES,
  MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS,
} from '../../src/utils/chatImageAttachments';

describe('ChatAttachmentStorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1234 });
    (FileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.copyAsync as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
  });

  it('copies a picked gallery image into app-owned chat attachment storage', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, size: 1234 });
    const service = new ChatAttachmentStorageService({
      now: () => 123,
      random: () => 0.456,
    });

    const draft = await service.copyImageAssetToDraft({
      uri: 'ph://library-image-1',
      fileName: 'IMG_0001.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 768,
      type: 'image',
    });

    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith('test-dir/chat-attachments/', {
      intermediates: true,
    });
    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'ph://library-image-1',
      to: 'test-dir/chat-attachments/draft-123-gez4w9.jpg',
    });
    expect(draft).toEqual({
      id: 'draft-123-gez4w9',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-123-gez4w9.jpg',
      localUri: 'test-dir/chat-attachments/draft-123-gez4w9.jpg',
      pathCategory: 'chat_attachment',
      mediaType: 'image/jpeg',
      fileName: 'draft-123-gez4w9.jpg',
      size: 1234,
      width: 1024,
      height: 768,
      copyStatus: 'copied',
    });
  });

  it('rejects unsupported picked image formats before copying into storage', async () => {
    const service = new ChatAttachmentStorageService();

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-2',
      fileName: 'IMG_0002.HEIC',
      fileSize: 2048,
      mimeType: 'image/heic',
      width: 1024,
      height: 768,
      type: 'image',
    })).rejects.toThrow('unsupported');

    expect(FileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  });

  it('rejects oversized picked image metadata before copying into storage', async () => {
    const service = new ChatAttachmentStorageService();

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-large',
      fileName: 'IMG_LARGE.JPG',
      fileSize: MAX_CHAT_IMAGE_ATTACHMENT_BYTES + 1,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 768,
      type: 'image',
    })).rejects.toThrow('size limits');

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-wide',
      fileName: 'IMG_WIDE.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      width: MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS + 1,
      height: 768,
      type: 'image',
    })).rejects.toThrow('size limits');

    expect(FileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  });

  it('accepts picked images with missing or invalid dimensions when copied size is known', async () => {
    const service = new ChatAttachmentStorageService({
      now: () => 123,
      random: () => 0.456,
    });

    const missingWidthDraft = await service.copyImageAssetToDraft({
      uri: 'ph://library-image-missing-dimensions',
      fileName: 'IMG_MISSING_DIMENSIONS.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      height: 768,
      type: 'image',
    } as any);

    const zeroHeightDraft = await service.copyImageAssetToDraft({
      uri: 'ph://library-image-zero-height',
      fileName: 'IMG_ZERO_HEIGHT.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 0,
      type: 'image',
    });

    expect(missingWidthDraft).toEqual(expect.objectContaining({
      copyStatus: 'copied',
      size: 1234,
      height: 768,
    }));
    expect(missingWidthDraft.width).toBeUndefined();
    expect(zeroHeightDraft).toEqual(expect.objectContaining({
      copyStatus: 'copied',
      size: 1234,
      width: 1024,
    }));
    expect(zeroHeightDraft.height).toBeUndefined();
    expect(FileSystem.copyAsync).toHaveBeenCalledTimes(2);
  });

  it('deletes copied files that exceed the byte limit after copy', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: true })
      .mockResolvedValueOnce({ exists: true, size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES + 1 });
    const service = new ChatAttachmentStorageService({
      now: () => 123,
      random: () => 0.456,
    });

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-post-copy-large',
      fileName: 'IMG_0003.JPG',
      fileSize: undefined,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 768,
      type: 'image',
    })).rejects.toThrow('size limits');

    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'ph://library-image-post-copy-large',
      to: 'test-dir/chat-attachments/draft-123-gez4w9.jpg',
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-123-gez4w9.jpg', {
      idempotent: true,
    });
  });

  it('rejects and deletes copied files when the copied and picker sizes are unknown', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: true })
      .mockResolvedValueOnce({ exists: true });
    const service = new ChatAttachmentStorageService({
      now: () => 123,
      random: () => 0.456,
    });

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-unknown-size',
      fileName: 'IMG_UNKNOWN.JPG',
      fileSize: undefined,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 768,
      type: 'image',
    })).rejects.toThrow('file size is unknown');

    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'ph://library-image-unknown-size',
      to: 'test-dir/chat-attachments/draft-123-gez4w9.jpg',
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-123-gez4w9.jpg', {
      idempotent: true,
    });
  });

  it('rejects and deletes copied files when copied size is unknown even if picker size exists', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: true })
      .mockResolvedValueOnce({ exists: true });
    const service = new ChatAttachmentStorageService({
      now: () => 123,
      random: () => 0.456,
    });

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-unverified-copied-size',
      fileName: 'IMG_UNVERIFIED.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 768,
      type: 'image',
    })).rejects.toThrow('file size is unknown');

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-123-gez4w9.jpg', {
      idempotent: true,
    });
  });

  it('deletes a partial destination file when copying an image fails', async () => {
    const copyError = new Error('copy failed');
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true });
    (FileSystem.copyAsync as jest.Mock).mockRejectedValueOnce(copyError);
    const service = new ChatAttachmentStorageService({
      now: () => 123,
      random: () => 0.456,
    });

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-copy-fail',
      fileName: 'IMG_FAIL.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 768,
      type: 'image',
    })).rejects.toBe(copyError);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-123-gez4w9.jpg', {
      idempotent: true,
    });
    expect(FileSystem.getInfoAsync).toHaveBeenCalledTimes(1);
  });

  it('accepts MIME-less picked images only when the path has a supported extension', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, size: 1234 });
    const service = new ChatAttachmentStorageService({
      now: () => 123,
      random: () => 0.456,
    });

    const draft = await service.copyImageAssetToDraft({
      uri: 'file:///tmp/image.PNG',
      fileName: undefined,
      fileSize: 2048,
      mimeType: undefined,
      width: 1024,
      height: 768,
      type: 'image',
    });

    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'file:///tmp/image.PNG',
      to: 'test-dir/chat-attachments/draft-123-gez4w9.png',
    });
    expect(draft.fileName).toBe('draft-123-gez4w9.png');
    expect(draft.mediaType).toBeUndefined();
  });

  it('builds a failed draft without leaking image bytes or private paths', () => {
    expect(buildFailedAttachmentDraft({
      uri: 'content://provider/image',
      mimeType: 'image/png',
      width: 640,
      height: 480,
    }, 'copy_failed')).toEqual({
      pickerUri: 'content://provider/image',
      previewUri: 'content://provider/image',
      mediaType: 'image/png',
      width: 640,
      height: 480,
      copyStatus: 'failed',
      errorReason: 'copy_failed',
    });
  });

  it('materializes copied attachment drafts into persisted chat message attachments', () => {
    expect(materializeAttachmentDraftsForMessage({
      threadId: chatAttachmentThreadId,
      messageId: chatAttachmentMessageId,
      drafts: [copiedDraftImageAttachment],
      now: () => 1_780_000_000_000,
    })).toEqual([
      {
        id: 'draft-image-1',
        threadId: chatAttachmentThreadId,
        messageId: chatAttachmentMessageId,
        localUri: 'test-dir/chat-attachments/draft-image-1.jpg',
        pathCategory: 'chat_attachment',
        mediaType: 'image/jpeg',
        fileName: 'draft-image-1.jpg',
        size: 123_456,
        width: 1024,
        height: 768,
        source: 'photo_library',
        createdAt: 1_780_000_000_000,
      },
    ]);
  });

  it('rejects drafts that are not copied into app-owned attachment storage metadata', () => {
    expect(() => materializeAttachmentDraftsForMessage({
      threadId: chatAttachmentThreadId,
      messageId: chatAttachmentMessageId,
      drafts: [failedDraftImageAttachment],
    })).toThrow('not ready to send');
  });

  it('rejects copied drafts with unsupported runtime image formats', () => {
    expect(() => materializeAttachmentDraftsForMessage({
      threadId: chatAttachmentThreadId,
      messageId: chatAttachmentMessageId,
      drafts: [{
        ...copiedDraftImageAttachment,
        mediaType: 'image/heic',
        fileName: 'draft-image-1.heic',
        localUri: 'test-dir/chat-attachments/draft-image-1.heic',
      }],
    })).toThrow('not ready to send');
  });

  it('rejects copied drafts that exceed app-level image bounds', () => {
    expect(() => materializeAttachmentDraftsForMessage({
      threadId: chatAttachmentThreadId,
      messageId: chatAttachmentMessageId,
      drafts: [{
        ...copiedDraftImageAttachment,
        size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES + 1,
      }],
    })).toThrow('not ready to send');
  });

  it('rejects copied drafts without a positive verified copied file size', () => {
    const invalidSizes = [undefined, 0, Number.NaN] as const;

    invalidSizes.forEach((size) => {
      expect(() => materializeAttachmentDraftsForMessage({
        threadId: chatAttachmentThreadId,
        messageId: chatAttachmentMessageId,
        drafts: [{
          ...copiedDraftImageAttachment,
          size,
        }],
      })).toThrow('not ready to send');
    });
  });

  it('materializes copied drafts with positive size and missing dimensions', () => {
    expect(materializeAttachmentDraftsForMessage({
      threadId: chatAttachmentThreadId,
      messageId: chatAttachmentMessageId,
      drafts: [{
        ...copiedDraftImageAttachment,
        width: undefined,
        height: undefined,
      }],
      now: () => 1_780_000_000_000,
    })).toEqual([
      expect.objectContaining({
        id: 'draft-image-1',
        size: 123_456,
        createdAt: 1_780_000_000_000,
      }),
    ]);
  });

  it('discards only copied drafts inside the app-owned attachment directory', async () => {
    const service = new ChatAttachmentStorageService();

    await service.discardDraft({
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-safe.jpg',
      localUri: 'test-dir/chat-attachments/draft-safe.jpg',
      copyStatus: 'copied',
    });
    await service.discardDraft({
      pickerUri: 'ph://library-image-2',
      previewUri: 'file:///outside/image.jpg',
      localUri: 'file:///outside/image.jpg',
      copyStatus: 'copied',
    });

    expect(getChatAttachmentsDir()).toBe('test-dir/chat-attachments/');
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-safe.jpg', {
      idempotent: true,
    });
  });

  it('scans referenced attachment files from typed and corrupt thread records', () => {
    const thread = {
      id: 'thread-1',
      title: 'Thread',
      modelId: 'model',
      presetId: null,
      presetSnapshot: { id: null, name: 'Default', systemPrompt: '' },
      paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 1024, seed: null },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt',
          createdAt: 1,
          state: 'complete',
          attachments: [
            {
              id: 'attachment-1',
              localUri: 'test-dir/chat-attachments/attachment-1.jpg',
            },
            {
              id: 'outside',
              localUri: 'file:///outside/attachment.jpg',
            },
          ],
        },
      ],
      createdAt: 1,
      updatedAt: 1,
      status: 'idle',
    } as any;

    expect(Array.from(collectReferencedChatAttachmentLocalUrisFromThreads([thread]))).toEqual([
      'test-dir/chat-attachments/attachment-1.jpg',
    ]);
    expect(Array.from(collectChatAttachmentLocalUrisFromUnknownThreadRecord({ thread }))).toEqual([
      'test-dir/chat-attachments/attachment-1.jpg',
    ]);
  });

  it('deletes only unreferenced files inside app-owned attachment storage', async () => {
    const service = new ChatAttachmentStorageService();

    await expect(service.deleteUnreferencedAttachmentFiles({
      candidateLocalUris: [
        'test-dir/chat-attachments/delete-me.jpg',
        'test-dir/chat-attachments/keep-me.jpg',
        'file:///outside/delete-me.jpg',
      ],
      referencedLocalUris: ['test-dir/chat-attachments/keep-me.jpg'],
    })).resolves.toBe(1);

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-me.jpg', {
      idempotent: true,
    });
  });

  it('bounds unreferenced attachment cleanup deletes', async () => {
    const service = new ChatAttachmentStorageService();

    await expect(service.deleteUnreferencedAttachmentFiles({
      candidateLocalUris: [
        'test-dir/chat-attachments/delete-1.jpg',
        'test-dir/chat-attachments/delete-2.jpg',
        'test-dir/chat-attachments/delete-3.jpg',
      ],
      maxDeletes: 2,
    })).resolves.toBe(2);

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-1.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-2.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/delete-3.jpg', expect.anything());
  });

  it('serializes unreferenced attachment deletes to avoid native IO bursts', async () => {
    const service = new ChatAttachmentStorageService();
    let releaseFirstDelete!: () => void;
    (FileSystem.deleteAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstDelete = resolve;
    }));

    const cleanupPromise = service.deleteUnreferencedAttachmentFiles({
      candidateLocalUris: [
        'test-dir/chat-attachments/delete-1.jpg',
        'test-dir/chat-attachments/delete-2.jpg',
      ],
    });

    await Promise.resolve();
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);

    releaseFirstDelete();
    await cleanupPromise;

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
    expect(FileSystem.deleteAsync).toHaveBeenNthCalledWith(2, 'test-dir/chat-attachments/delete-2.jpg', {
      idempotent: true,
    });
  });

  it('reconciles the attachment directory by preserving referenced files and deleting safe unreferenced files', async () => {
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'keep-me.jpg',
      'delete-me.jpg',
      '../outside.jpg',
      '%2e%2e%2foutside.jpg',
    ]);
    const service = new ChatAttachmentStorageService();

    await expect(service.reconcileAttachmentDirectory([
      'test-dir/chat-attachments/keep-me.jpg',
    ])).resolves.toEqual(expect.objectContaining({
      deletedCount: 1,
      attemptedDeleteCount: 1,
      candidateCount: 1,
      hasMoreCandidates: false,
    }));

    expect(FileSystem.readDirectoryAsync).toHaveBeenCalledWith('test-dir/chat-attachments/');
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-me.jpg', {
      idempotent: true,
    });
  });

  it('caps directory reconciliation deletes per pass and reports remaining bounded candidates', async () => {
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'delete-1.jpg',
      'delete-2.jpg',
      'delete-3.jpg',
    ]);
    const service = new ChatAttachmentStorageService();

    await expect(service.reconcileAttachmentDirectory([], {
      maxCandidates: 2,
      maxDeletes: 1,
    })).resolves.toEqual(expect.objectContaining({
      deletedCount: 1,
      attemptedDeleteCount: 1,
      candidateCount: 3,
      hasMoreCandidates: true,
    }));

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-1.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/delete-2.jpg', expect.anything());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/delete-3.jpg', expect.anything());
  });

  it('stops collecting reconciliation candidates after the bounded lookahead', async () => {
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => `delete-${index}.jpg`),
    );
    const service = new ChatAttachmentStorageService();

    await expect(service.reconcileAttachmentDirectory([], {
      maxCandidates: 2,
      maxDeletes: 2,
    })).resolves.toEqual(expect.objectContaining({
      deletedCount: 2,
      attemptedDeleteCount: 2,
      candidateCount: 3,
      hasMoreCandidates: true,
    }));

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-0.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-1.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/delete-2.jpg', expect.anything());
  });

  it('continues directory reconciliation after a delete failure within the delete cap', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'delete-1.jpg',
      'delete-2.jpg',
      'delete-3.jpg',
    ]);
    (FileSystem.deleteAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValue(undefined);
    const service = new ChatAttachmentStorageService();

    try {
      await expect(service.reconcileAttachmentDirectory([], {
        maxDeletes: 2,
      })).resolves.toEqual(expect.objectContaining({
        deletedCount: 1,
        attemptedDeleteCount: 2,
        candidateCount: 3,
        hasMoreCandidates: true,
      }));

      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-2.jpg', {
        idempotent: true,
      });
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/delete-3.jpg', expect.anything());
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('applies directory reconciliation candidate bounds after excluding referenced files', async () => {
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'keep-1.jpg',
      'keep-2.jpg',
      'delete-1.jpg',
      'delete-2.jpg',
    ]);
    const service = new ChatAttachmentStorageService();

    await expect(service.reconcileAttachmentDirectory([
      'test-dir/chat-attachments/keep-1.jpg',
      'test-dir/chat-attachments/keep-2.jpg',
    ], {
      maxCandidates: 1,
      maxDeletes: 1,
    })).resolves.toEqual(expect.objectContaining({
      deletedCount: 1,
      attemptedDeleteCount: 1,
      candidateCount: 2,
      hasMoreCandidates: true,
    }));

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-1.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/keep-1.jpg', expect.anything());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/keep-2.jpg', expect.anything());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/delete-2.jpg', expect.anything());
  });

  it('preserves draft files created at or after the reconciliation cutoff', async () => {
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'draft-99-before.jpg',
      'draft-100-samems.jpg',
      'draft-101-after.png',
      'draft-400101-beyondgrace.jpg',
      'legacy-orphan.jpg',
    ]);
    const service = new ChatAttachmentStorageService({ now: () => 100 });

    await expect(service.reconcileAttachmentDirectory([], {
      preserveDraftsCreatedAtOrAfter: 100,
    })).resolves.toEqual(expect.objectContaining({
      deletedCount: 3,
      attemptedDeleteCount: 3,
      candidateCount: 3,
      hasMoreCandidates: false,
    }));

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-99-before.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/legacy-orphan.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-400101-beyondgrace.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/draft-100-samems.jpg', expect.anything());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/draft-101-after.png', expect.anything());
  });

  it('deletes every direct child inside app-owned attachment storage for private storage reset while preserving the directory', async () => {
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'delete-me.jpg',
      'delete me too.png',
      'résumé 100%.jpg',
    ]);
    const service = new ChatAttachmentStorageService();

    await service.deleteAllAttachmentFilesForPrivateStorageReset();

    expect(FileSystem.readDirectoryAsync).toHaveBeenCalledWith('test-dir/chat-attachments/');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/', expect.anything());
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-me.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete%20me%20too.png', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/r%C3%A9sum%C3%A9%20100%25.jpg', {
      idempotent: true,
    });
  });

  it('deletes private storage reset attachment candidates sequentially', async () => {
    let resolveFirstDelete!: () => void;
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'first.jpg',
      'second.png',
      'third.jpg',
    ]);
    (FileSystem.deleteAsync as jest.Mock)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstDelete = resolve;
      }))
      .mockResolvedValue(undefined);
    const service = new ChatAttachmentStorageService();

    const cleanupPromise = service.deleteAllAttachmentFilesForPrivateStorageReset();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/first.jpg', {
      idempotent: true,
    });

    resolveFirstDelete();
    await cleanupPromise;

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
    expect(FileSystem.deleteAsync).toHaveBeenNthCalledWith(2, 'test-dir/chat-attachments/second.png', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenNthCalledWith(3, 'test-dir/chat-attachments/third.jpg', {
      idempotent: true,
    });
  });

  it('fails private storage reset after deleting safe files rather than skipping unsafe child names', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'delete-me.jpg',
      '../outside.jpg',
    ]);
    const service = new ChatAttachmentStorageService();

    await expect(service.deleteAllAttachmentFilesForPrivateStorageReset()).rejects.toThrow('child_name_rejected');

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-me.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/..%2Foutside.jpg', expect.anything());
    expect(warnSpy).toHaveBeenCalledWith(
      '[ChatAttachmentStorage] Refusing unsafe chat attachment child during private reset',
      expect.objectContaining({
        pathCategory: 'chat_attachment',
        context: 'private_storage_reset_child_name_rejected',
        rejectedCount: 1,
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('../outside.jpg');
    warnSpy.mockRestore();
  });

  it('surfaces private storage reset attachment enumeration failures', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.readDirectoryAsync as jest.Mock).mockRejectedValueOnce(new Error('secret file:///private/chat-attachments'));
    const service = new ChatAttachmentStorageService();

    await expect(service.deleteAllAttachmentFilesForPrivateStorageReset()).rejects.toThrow('enumeration_failed');

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ChatAttachmentStorage] Failed to delete chat attachment storage after private reset',
      expect.objectContaining({
        pathCategory: 'chat_attachment',
        context: 'private_storage_reset_enumeration',
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('file:///private/chat-attachments');
    warnSpy.mockRestore();
  });

  it('surfaces private storage reset attachment inspection failures before enumeration', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.getInfoAsync as jest.Mock).mockRejectedValueOnce(new Error('secret file:///private/chat-attachments'));
    const service = new ChatAttachmentStorageService();

    await expect(service.deleteAllAttachmentFilesForPrivateStorageReset()).rejects.toThrow('inspection_failed');

    expect(FileSystem.readDirectoryAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ChatAttachmentStorage] Failed to inspect chat attachment storage before private reset',
      expect.objectContaining({
        pathCategory: 'chat_attachment',
        context: 'private_storage_reset_inspection',
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('file:///private/chat-attachments');
    warnSpy.mockRestore();
  });

  it('surfaces private storage reset attachment child delete failures after preserving the directory', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'delete-me.jpg',
      'delete-me-too.png',
    ]);
    (FileSystem.deleteAsync as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('secret file:///private/chat-attachments/delete-me-too.png'));
    const service = new ChatAttachmentStorageService();

    await expect(service.deleteAllAttachmentFilesForPrivateStorageReset()).rejects.toThrow('child_delete_failed');

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/', expect.anything());
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[ChatAttachmentStorage] Failed to delete chat attachment during private reset',
      expect.objectContaining({
        pathCategory: 'chat_attachment',
        context: 'private_storage_reset_child_delete',
        failedCount: 1,
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('file:///private/chat-attachments/delete-me-too.png');
    warnSpy.mockRestore();
  });

  it('treats a missing attachment directory as a silent private storage reset no-op', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: false });
    const service = new ChatAttachmentStorageService();

    await service.deleteAllAttachmentFilesForPrivateStorageReset();

    expect(FileSystem.readDirectoryAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('sanitizes attachment cleanup logs without raw errors or paths', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (FileSystem.deleteAsync as jest.Mock).mockRejectedValueOnce(new Error('secret file:///outside/private.jpg'));
    const service = new ChatAttachmentStorageService();

    await expect(service.deleteUnreferencedAttachmentFiles({
      candidateLocalUris: ['test-dir/chat-attachments/delete-me.jpg'],
    })).resolves.toBe(0);

    expect(warnSpy).toHaveBeenCalledWith(
      '[ChatAttachmentStorage] Failed to delete unreferenced chat attachment',
      expect.objectContaining({
        pathCategory: 'chat_attachment',
        context: 'unreferenced_cleanup',
        errorName: 'Error',
      }),
    );
    expect(warnSpy.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('file:///outside/private.jpg');
    warnSpy.mockRestore();
  });

  it('rejects traversal-shaped chat attachment URIs during cleanup', async () => {
    const service = new ChatAttachmentStorageService();

    await service.discardDraft({
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/../models/model.gguf',
      localUri: 'test-dir/chat-attachments/../models/model.gguf',
      copyStatus: 'copied',
    });
    await expect(service.deleteUnreferencedAttachmentFiles({
      candidateLocalUris: [
        'test-dir/chat-attachments/%2e%2e%2fmodels%2fmodel.gguf',
        'test-dir/chat-attachments/thread-1/../../models/model.gguf',
      ],
    })).resolves.toBe(0);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });
});
