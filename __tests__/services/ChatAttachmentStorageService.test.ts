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

  it('rejects picked images with missing or invalid dimensions before copying into storage', async () => {
    const service = new ChatAttachmentStorageService();

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-missing-dimensions',
      fileName: 'IMG_MISSING_DIMENSIONS.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      height: 768,
      type: 'image',
    } as any)).rejects.toThrow('size limits');

    await expect(service.copyImageAssetToDraft({
      uri: 'ph://library-image-zero-height',
      fileName: 'IMG_ZERO_HEIGHT.JPG',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 0,
      type: 'image',
    })).rejects.toThrow('size limits');

    expect(FileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(FileSystem.copyAsync).not.toHaveBeenCalled();
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
    ])).resolves.toBe(1);

    expect(FileSystem.readDirectoryAsync).toHaveBeenCalledWith('test-dir/chat-attachments/');
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/delete-me.jpg', {
      idempotent: true,
    });
  });

  it('preserves only draft files created at or shortly after the reconciliation cutoff', async () => {
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
      'draft-99-before.jpg',
      'draft-100-samems.jpg',
      'draft-101-after.png',
      'draft-60101-farfuture.jpg',
      'legacy-orphan.jpg',
    ]);
    const service = new ChatAttachmentStorageService();

    await expect(service.reconcileAttachmentDirectory([], {
      preserveDraftsCreatedAtOrAfter: 100,
    })).resolves.toBe(3);

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-99-before.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/draft-60101-farfuture.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/legacy-orphan.jpg', {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/draft-100-samems.jpg', expect.anything());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/draft-101-after.png', expect.anything());
  });

  it('deletes the app-owned attachment directory for private storage reset', async () => {
    const service = new ChatAttachmentStorageService();

    await service.deleteAllAttachmentFilesForPrivateStorageReset();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/', {
      idempotent: true,
    });
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
