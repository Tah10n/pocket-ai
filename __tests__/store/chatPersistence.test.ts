import {
  CHAT_PERSISTENCE_INDEX_KEY,
  CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY,
  CHAT_PERSISTENCE_SCHEMA_VERSION,
  type ChatPersistencePendingIndexCommit,
  createChatPersistenceWriteScheduler,
  getChatThreadStorageKey,
  getThreadIdFromChatThreadStorageKey,
  parseChatPersistenceIndex,
  parseChatPendingIndexCommit,
  parseChatThreadRecord,
  recoverStaleStreamingThread,
  sanitizeChatThreadForPersistence,
  writeChatPendingIndexCommit,
  writeChatPersistenceIndex,
  writeChatThreadRecord,
} from '../../src/store/chatPersistence';
import { storage } from '../../src/store/storage';
import type { ChatAttachment } from '../../src/types/attachments';
import type { ChatThread } from '../../src/types/chat';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  MAX_CHAT_IMAGE_ATTACHMENT_BYTES,
  MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS,
} from '../../src/utils/chatImageAttachments';
import {
  copiedImageAttachment,
  secondCopiedImageAttachment,
} from '../fixtures/chatImageAttachmentFixtures';

const LEGACY_MAX_CHAT_VIDEO_DERIVED_FRAME_ATTACHMENTS = 8;

function buildThread(id: string): ChatThread {
  return {
    id,
    title: `Conversation ${id}`,
    modelId: 'author/model-q4',
    presetId: null,
    presetSnapshot: {
      id: null,
      name: 'Default',
      systemPrompt: 'You are helpful.',
    },
    paramsSnapshot: {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
      seed: null,
    },
    messages: [
      {
        id: `${id}-assistant-1`,
        role: 'assistant',
        content: 'Partial response',
        createdAt: 1,
        state: 'streaming',
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    status: 'generating',
  };
}

describe('chatPersistence', () => {
  beforeEach(() => {
    storage.getAllKeys().forEach((key) => storage.remove(key));
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('encodes thread ids into reversible v2 storage keys', () => {
    const threadId = 'model/thread id/with spaces';
    const key = getChatThreadStorageKey(threadId);

    expect(key).toBe('chat-store:v2:thread:model%2Fthread%20id%2Fwith%20spaces');
    expect(getThreadIdFromChatThreadStorageKey(key)).toBe(threadId);
    expect(getThreadIdFromChatThreadStorageKey('other:key')).toBeNull();
    expect(getThreadIdFromChatThreadStorageKey('chat-store:v2:thread:%E0%A4%A')).toBeNull();
  });

  it('parses only valid v2 index and thread record envelopes', () => {
    const thread = buildThread('thread-1');
    const validIndex = {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 10,
    };
    const validRecord = {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread,
      persistedAt: 11,
    };

    expect(parseChatPersistenceIndex(JSON.stringify(validIndex))).toEqual({
      ok: true,
      value: validIndex,
    });
    expect(parseChatThreadRecord(JSON.stringify(validRecord), thread.id)).toEqual({
      ok: true,
      value: validRecord,
    });
    expect(parseChatPersistenceIndex('{broken')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseChatThreadRecord(JSON.stringify(validRecord), 'other-thread')).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
  });

  it('parses pending index commits and rejects malformed revisions', () => {
    const validCommit: ChatPersistencePendingIndexCommit = {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 3,
      activeThreadId: 'thread-1',
      threadIds: ['thread-1'],
      updatedAt: 12,
      reason: 'thread_mutation',
      changedThreadIds: ['thread-1'],
      requiresChangedThreadCommitRevision: true,
    };

    expect(parseChatPendingIndexCommit(JSON.stringify(validCommit))).toEqual({
      ok: true,
      value: validCommit,
    });
    expect(parseChatPendingIndexCommit(JSON.stringify({
      ...validCommit,
      revision: 1.5,
    }))).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseChatPendingIndexCommit(JSON.stringify({
      ...validCommit,
      reason: 'unknown',
    }))).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseChatPendingIndexCommit(JSON.stringify({
      ...validCommit,
      requiresChangedThreadCommitRevision: 'yes',
    }))).toEqual({ ok: false, reason: 'invalid_shape' });

    writeChatPendingIndexCommit(storage, validCommit);
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toContain('"revision":3');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toContain('"requiresChangedThreadCommitRevision":true');
  });

  it('writes v2 index and per-thread records without using the legacy all-thread key', () => {
    const thread = buildThread('thread-1');

    writeChatThreadRecord(storage, thread, 11, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 12,
      revision: 1,
    });

    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toContain(thread.id);
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toContain('Partial response');
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toContain('"commitRevision":1');
  });

  it('persists normalized user image attachment metadata in v2 thread records', () => {
    const thread: ChatThread = {
      ...buildThread('thread-attachments'),
      messages: [
        {
          id: 'user-with-image',
          role: 'user',
          content: 'What is in this image?',
          createdAt: 1,
          state: 'complete',
          attachments: [
            {
              ...copiedImageAttachment,
              threadId: 'stale-thread-id',
              messageId: 'stale-message-id',
              mediaType: 'IMAGE/JPEG',
              thumbnailUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-1-thumb.jpg',
              thumbnailFileName: 'attachment-image-1-thumb.jpg',
            },
            {
              ...secondCopiedImageAttachment,
              id: 'mime-less-png',
              threadId: 'stale-thread-id',
              messageId: 'stale-message-id',
              mediaType: undefined,
              thumbnailUri: 'test-dir/chat-attachments/thread-vision-1/mime-less-png-thumb.gif',
              thumbnailFileName: 'mime-less-png-thumb.gif',
            },
          ],
        },
        {
          id: 'assistant-with-invalid-image',
          role: 'assistant',
          content: 'A response',
          createdAt: 2,
          state: 'complete',
          attachments: [copiedImageAttachment],
        },
      ],
      status: 'idle',
    };

    writeChatThreadRecord(storage, thread, 11);

    const record = parseChatThreadRecord(storage.getString(getChatThreadStorageKey(thread.id)), thread.id);

    expect(record.ok).toBe(true);
    if (!record.ok) {
      throw new Error('Expected persisted thread record to parse');
    }
    expect(record.value.thread.messages[0]).toEqual(
      expect.objectContaining({
        id: 'user-with-image',
        attachments: [
          expect.objectContaining({
            id: copiedImageAttachment.id,
            threadId: thread.id,
            messageId: 'user-with-image',
            localUri: copiedImageAttachment.localUri,
            thumbnailUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-1-thumb.jpg',
            thumbnailFileName: 'attachment-image-1-thumb.jpg',
            mediaType: 'image/jpeg',
            pathCategory: 'chat_attachment',
            source: 'photo_library',
          }),
          expect.not.objectContaining({
            mediaType: expect.any(String),
          }),
        ],
      }),
    );
    expect(record.value.thread.messages[0].attachments?.[1]).toEqual(expect.objectContaining({
      id: 'mime-less-png',
      threadId: thread.id,
      messageId: 'user-with-image',
      localUri: secondCopiedImageAttachment.localUri,
      fileName: secondCopiedImageAttachment.fileName,
      pathCategory: 'chat_attachment',
      source: 'photo_library',
    }));
    expect(record.value.thread.messages[0].attachments?.[1]).not.toHaveProperty('mediaType');
    expect(record.value.thread.messages[0].attachments?.[1]).not.toHaveProperty('thumbnailUri');
    expect(record.value.thread.messages[0].attachments?.[1]).not.toHaveProperty('thumbnailFileName');
    expect(record.value.thread.messages[1]).not.toHaveProperty('attachments');
  });

  it('drops malformed persisted attachment metadata during schema migration sanitization', () => {
    const thread: ChatThread = {
      ...buildThread('thread-attachment-migration'),
      messages: [
        {
          id: 'user-legacy-attachments',
          role: 'user',
          content: 'Legacy image prompt',
          createdAt: 1,
          state: 'complete',
          attachments: [
            copiedImageAttachment,
            {
              ...copiedImageAttachment,
              id: 'temp-picker-uri',
              localUri: 'ph://temporary-library-uri',
              fileName: 'temporary.jpg',
            },
            {
              ...copiedImageAttachment,
              id: 'unsupported-media',
              mediaType: 'video/mp4',
              fileName: 'clip.mp4',
            },
            {
              ...copiedImageAttachment,
              id: 'unsupported-mime-less-heic',
              mediaType: undefined,
              localUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-3.heic',
              fileName: 'attachment-image-3.heic',
            },
            {
              ...copiedImageAttachment,
              id: 'outside-app-owned-storage',
              localUri: 'file:///document/chat-attachments/thread-vision-1/attachment-image-4.jpg',
              fileName: 'attachment-image-4.jpg',
            },
            {
              ...copiedImageAttachment,
              id: 'path-traversal-uri',
              localUri: 'test-dir/chat-attachments/../models/model.gguf',
              fileName: 'model.gguf',
            },
            {
              ...copiedImageAttachment,
              id: 'oversized-bytes',
              size: MAX_CHAT_IMAGE_ATTACHMENT_BYTES + 1,
            },
            {
              ...copiedImageAttachment,
              id: 'oversized-dimensions',
              width: MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS + 1,
              height: 512,
            },
          ],
        },
      ],
      status: 'idle',
    };

    expect(sanitizeChatThreadForPersistence(thread).messages[0]).toEqual(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            id: copiedImageAttachment.id,
            threadId: thread.id,
            messageId: 'user-legacy-attachments',
          }),
        ],
      }),
    );
  });

  it('normalizes generic images while preserving processable non-image attachments', () => {
    const thread: ChatThread = {
      ...buildThread('thread-generic-attachment-migration'),
      messages: [
        {
          id: 'user-generic-attachments',
          role: 'user',
          content: 'Generic image prompt',
          createdAt: 1,
          state: 'complete',
          attachments: [
            {
              id: 'generic-image-1',
              kind: 'image',
              state: 'ready',
              threadId: 'spoofed-thread',
              messageId: 'spoofed-message',
              localUri: 'test-dir/chat-attachments/thread-generic-attachment-migration/generic-image-1.png',
              pathCategory: 'chat_attachment',
              fileName: 'generic-image-1.png',
              mimeType: 'image/png',
              sizeBytes: 123_456,
              source: 'photo_library',
              createdAt: 10,
              image: {
                width: 640,
                height: 480,
              },
            },
            {
              id: 'generic-document-1',
              kind: 'document',
              state: 'ready',
              threadId: 'thread-generic-attachment-migration',
              messageId: 'user-generic-attachments',
              localUri: 'test-dir/chat-attachments/thread-generic-attachment-migration/generic-document-1.pdf',
              pathCategory: 'chat_attachment',
              fileName: 'generic-document-1.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 456_789,
              source: 'document_picker',
              createdAt: 10,
              document: {
                processorId: 'pdf-text-v1',
                processorVersion: 1,
              },
            },
          ] as never,
        },
      ],
      status: 'idle',
    };

    const sanitizedMessage = sanitizeChatThreadForPersistence(thread).messages[0];
    expect(sanitizedMessage.attachments).toEqual([
      expect.objectContaining({
        id: 'generic-image-1',
        threadId: thread.id,
        messageId: 'user-generic-attachments',
        localUri: 'test-dir/chat-attachments/thread-generic-attachment-migration/generic-image-1.png',
        mediaType: 'image/png',
        fileName: 'generic-image-1.png',
        size: 123_456,
        width: 640,
        height: 480,
        source: 'photo_library',
      }),
      expect.objectContaining({
        id: 'generic-document-1',
        kind: 'document',
        state: 'ready',
        threadId: thread.id,
        messageId: 'user-generic-attachments',
        localUri: 'test-dir/chat-attachments/thread-generic-attachment-migration/generic-document-1.pdf',
        fileName: 'generic-document-1.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 456_789,
        source: 'document_picker',
        document: expect.objectContaining({
          processorId: 'pdf-text-v1',
          processorVersion: 1,
        }),
      }),
    ]);
    expect(sanitizedMessage.attachments?.[0]).not.toHaveProperty('kind');
    expect(sanitizedMessage.attachments?.[0]).not.toHaveProperty('state');
    expect(sanitizedMessage.attachments?.[0]).not.toHaveProperty('sizeBytes');
  });

  it('persists video-derived frame images without consuming the normal image attachment limit', () => {
    const threadId = 'thread-video-frames';
    const messageId = 'user-video-frames';
    const videoId = 'video-attachment-1';
    const derivedFrameIds = Array.from({ length: LEGACY_MAX_CHAT_VIDEO_DERIVED_FRAME_ATTACHMENTS }, (_, index) => (
      `video-attachment-1-frame-${index + 1}`
    ));
    const videoAttachment: ChatAttachment = {
      id: videoId,
      kind: 'video',
      state: 'ready',
      threadId: 'stale-thread',
      messageId: 'stale-message',
      localUri: `test-dir/chat-attachments/${threadId}/video-attachment-1.mp4`,
      pathCategory: 'chat_attachment',
      fileName: 'video-attachment-1.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1_234_567,
      source: 'photo_library',
      createdAt: 10,
      video: {
        durationMs: 42_000,
        width: 1280,
        height: 720,
        derivedAttachmentIds: derivedFrameIds,
        samplingVersion: 1,
      },
    };
    const derivedFrameAttachments: ChatAttachment[] = derivedFrameIds.map((frameId, index) => ({
      id: frameId,
      kind: 'image',
      state: 'ready',
      threadId: 'stale-thread',
      messageId: 'stale-message',
      localUri: `test-dir/chat-attachments/${threadId}/${frameId}.jpg`,
      pathCategory: 'chat_attachment',
      fileName: `${frameId}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 12_000 + index,
      source: 'derived_processor',
      createdAt: 10,
      derivedFromAttachmentId: videoId,
      image: {
        width: 1024,
        height: 576,
      },
    }));
    const orphanDerivedFrameAttachment: ChatAttachment = {
      ...derivedFrameAttachments[0],
      id: 'orphan-derived-frame',
      localUri: `test-dir/chat-attachments/${threadId}/orphan-derived-frame.jpg`,
      fileName: 'orphan-derived-frame.jpg',
      derivedFromAttachmentId: 'missing-video',
    };
    const standaloneImages = Array.from({ length: MAX_CHAT_IMAGE_ATTACHMENTS + 1 }, (_, index) => ({
      ...copiedImageAttachment,
      id: `standalone-image-${index + 1}`,
      localUri: `test-dir/chat-attachments/${threadId}/standalone-image-${index + 1}.jpg`,
      fileName: `standalone-image-${index + 1}.jpg`,
    }));
    const thread: ChatThread = {
      ...buildThread(threadId),
      messages: [
        {
          id: messageId,
          role: 'user',
          content: 'Describe the video and these images.',
          createdAt: 1,
          state: 'complete',
          attachments: [
            videoAttachment,
            ...derivedFrameAttachments,
            orphanDerivedFrameAttachment,
            ...standaloneImages,
          ],
        },
      ],
      status: 'idle',
    };

    const sanitizedMessage = sanitizeChatThreadForPersistence(thread).messages[0];
    const attachments = sanitizedMessage.attachments ?? [];
    const retainedVideo = attachments.find((attachment): attachment is Extract<ChatAttachment, { kind: 'video' }> => (
      'kind' in attachment && attachment.kind === 'video'
    ));
    const retainedFrames = attachments.filter((attachment): attachment is Extract<ChatAttachment, { kind: 'image' }> => (
      'kind' in attachment
      && attachment.kind === 'image'
      && attachment.derivedFromAttachmentId === videoId
    ));
    const retainedStandaloneImages = attachments.filter((attachment) => !('kind' in attachment));

    expect(retainedVideo?.video.derivedAttachmentIds).toEqual(derivedFrameIds);
    expect(retainedFrames.map((attachment) => attachment.id)).toEqual(derivedFrameIds);
    expect(retainedFrames).toHaveLength(LEGACY_MAX_CHAT_VIDEO_DERIVED_FRAME_ATTACHMENTS);
    expect(retainedStandaloneImages.map((attachment) => attachment.id)).toEqual(
      standaloneImages.slice(0, MAX_CHAT_IMAGE_ATTACHMENTS).map((attachment) => attachment.id),
    );
    expect(retainedStandaloneImages).toHaveLength(MAX_CHAT_IMAGE_ATTACHMENTS);
    expect(JSON.stringify(attachments)).not.toContain('standalone-image-5');
    expect(JSON.stringify(attachments)).not.toContain('orphan-derived-frame');
  });

  it('omits empty assistant progress placeholders from durable thread records', () => {
    const thread: ChatThread = {
      ...buildThread('thread-empty-placeholder'),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt before first token',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'assistant-empty',
          role: 'assistant',
          content: '',
          thoughtContent: '   ',
          createdAt: 2,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };

    writeChatThreadRecord(storage, thread, 11);

    expect(parseChatThreadRecord(storage.getString(getChatThreadStorageKey(thread.id)), thread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        thread: expect.objectContaining({
          status: 'idle',
          messages: [
            expect.objectContaining({
              id: 'user-1',
              role: 'user',
            }),
          ],
        }),
      }),
    });
  });

  it('recovers cold-hydrated stale streaming messages as stopped without dropping partial content', () => {
    const thread = buildThread('thread-1');

    expect(recoverStaleStreamingThread(thread, 20)).toEqual(
      expect.objectContaining({
        status: 'stopped',
        updatedAt: 20,
        messages: [
          expect.objectContaining({
            id: 'thread-1-assistant-1',
            content: 'Partial response',
            state: 'stopped',
          }),
        ],
      }),
    );
  });

  it('drops empty streaming and stopped assistant placeholders during cold recovery', () => {
    const thread: ChatThread = {
      ...buildThread('thread-empty-recovery'),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt before crash',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'assistant-empty-streaming',
          role: 'assistant',
          content: '',
          createdAt: 2,
          state: 'streaming',
        },
        {
          id: 'assistant-empty-stopped',
          role: 'assistant',
          content: '   ',
          thoughtContent: '',
          createdAt: 3,
          state: 'stopped',
        },
      ],
      status: 'generating',
    };

    expect(recoverStaleStreamingThread(thread, 20)).toEqual(
      expect.objectContaining({
        status: 'idle',
        updatedAt: 20,
        messages: [
          expect.objectContaining({
            id: 'user-1',
            role: 'user',
          }),
        ],
      }),
    );
  });

  it('keeps errored empty assistant messages durable', () => {
    const thread: ChatThread = {
      ...buildThread('thread-error'),
      messages: [
        {
          id: 'assistant-error',
          role: 'assistant',
          content: '',
          createdAt: 1,
          state: 'error',
          errorCode: 'generation_failed',
          errorMessage: 'Native failure',
        },
      ],
      status: 'error',
    };

    expect(sanitizeChatThreadForPersistence(thread).messages).toEqual([
      expect.objectContaining({
        id: 'assistant-error',
        state: 'error',
        errorCode: 'generation_failed',
      }),
    ]);
  });

  it('debounces streaming writes and lets terminal flush win over a pending timer', () => {
    jest.useFakeTimers();
    const flushThread = jest.fn();
    const scheduler = createChatPersistenceWriteScheduler({
      flushThread,
      debounceMs: 1000,
    });

    scheduler.scheduleStreamingThreadWrite('thread-1');
    scheduler.scheduleStreamingThreadWrite('thread-1');
    jest.advanceTimersByTime(999);
    expect(flushThread).not.toHaveBeenCalled();

    scheduler.flushThreadWrite('thread-1', 'terminal_state');
    expect(flushThread).toHaveBeenCalledTimes(1);
    expect(flushThread).toHaveBeenCalledWith('thread-1', 'terminal_state');

    jest.advanceTimersByTime(1);
    expect(flushThread).toHaveBeenCalledTimes(1);
  });

  it('keeps the scheduled retry when an explicit pending flush fails', () => {
    jest.useFakeTimers();
    const storageError = new Error('private storage unavailable');
    const flushThread = jest.fn((_threadId: string, reason: string) => {
      if (reason === 'background') {
        throw storageError;
      }
    });
    const scheduler = createChatPersistenceWriteScheduler({
      flushThread,
      debounceMs: 1000,
    });

    scheduler.scheduleStreamingThreadWrite('thread-1');

    expect(() => scheduler.flushThreadWrite('thread-1', 'background')).toThrow(storageError);
    expect(flushThread).toHaveBeenCalledWith('thread-1', 'background');

    jest.advanceTimersByTime(1000);

    expect(flushThread).toHaveBeenCalledWith('thread-1', 'streaming_patch');
    expect(flushThread).toHaveBeenCalledTimes(2);
  });

  it('continues flushing pending threads after one explicit flush fails', () => {
    jest.useFakeTimers();
    const storageError = new Error('private storage unavailable');
    const flushThread = jest.fn((threadId: string, reason: string) => {
      if (threadId === 'thread-1' && reason === 'background') {
        throw storageError;
      }
    });
    const scheduler = createChatPersistenceWriteScheduler({
      flushThread,
      debounceMs: 1000,
    });

    scheduler.scheduleStreamingThreadWrite('thread-1');
    scheduler.scheduleStreamingThreadWrite('thread-2');

    expect(() => scheduler.flushAllPendingWrites('background')).toThrow(storageError);
    expect(flushThread).toHaveBeenCalledWith('thread-1', 'background');
    expect(flushThread).toHaveBeenCalledWith('thread-2', 'background');
    expect(flushThread).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(1000);

    expect(flushThread).toHaveBeenCalledWith('thread-1', 'streaming_patch');
    expect(flushThread).toHaveBeenCalledTimes(3);
  });

  it('contains scheduled streaming flush failures instead of throwing from timer callbacks', () => {
    jest.useFakeTimers();
    const storageError = new Error('private storage unavailable');
    const flushThread = jest.fn((_threadId: string, reason: string) => {
      if (reason === 'streaming_patch') {
        throw storageError;
      }
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scheduler = createChatPersistenceWriteScheduler({
      flushThread,
      debounceMs: 1000,
    });

    scheduler.scheduleStreamingThreadWrite('thread-1');

    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(flushThread).toHaveBeenCalledWith('thread-1', 'streaming_patch');
    expect(warnSpy).toHaveBeenCalledWith(
      '[ChatPersistence] Failed to flush scheduled streaming thread write',
      { threadId: 'thread-1', reason: 'streaming_patch' },
      storageError,
    );

    scheduler.flushAllPendingWrites('background');
    expect(flushThread).toHaveBeenCalledWith('thread-1', 'background');
    expect(flushThread).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
