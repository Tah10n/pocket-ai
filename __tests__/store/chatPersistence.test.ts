import {
  CHAT_PERSISTENCE_INDEX_KEY,
  CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY,
  CHAT_PERSISTENCE_SCHEMA_VERSION,
  CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
  type ChatPersistencePendingIndexCommit,
  type ChatStreamingProgressRecord,
  clearPersistedChatRecords,
  createChatPersistenceWriteScheduler,
  getChatStreamingProgressStorageKey,
  getChatThreadStorageKey,
  getThreadIdFromChatStreamingProgressStorageKey,
  getThreadIdFromChatThreadStorageKey,
  parseChatStreamingProgressRecord,
  parseChatPersistenceIndex,
  parseChatPendingIndexCommit,
  parseChatThreadRecord,
  readChatStreamingProgressRecord,
  recoverChatThreadFromStreamingProgress,
  recoverStaleStreamingThread,
  sanitizeChatThreadForPersistence,
  writeChatPendingIndexCommit,
  writeChatPersistenceIndex,
  writeChatStreamingProgressRecord,
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

function buildProgress(
  threadId: string,
  overrides: Partial<ChatStreamingProgressRecord> = {},
): ChatStreamingProgressRecord {
  return {
    schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
    threadId,
    messageId: `${threadId}-assistant-progress`,
    modelId: 'author/model-q4',
    createdAt: 2,
    content: 'Latest partial response',
    thoughtContent: 'Partial reasoning',
    tokensPerSec: 12.5,
    state: 'streaming',
    persistedAt: 20,
    revision: 3,
    ...overrides,
  };
}

function buildBranchRecoveryThread(id: string): ChatThread {
  return {
    ...buildThread(id),
    activeModelId: 'author/model-q8',
    messages: [
      {
        id: `${id}-prefix-user`,
        role: 'user',
        content: 'Prefix prompt',
        createdAt: 1,
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
      },
      {
        id: `${id}-prefix-assistant`,
        role: 'assistant',
        content: 'Prefix answer',
        createdAt: 2,
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
      },
      {
        id: `${id}-target-user`,
        role: 'user',
        content: 'Original target prompt',
        createdAt: 3,
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
      },
      {
        id: `${id}-old-assistant`,
        role: 'assistant',
        content: 'Old answer',
        createdAt: 4,
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
      },
      {
        id: `${id}-trailing-switch`,
        role: 'system',
        content: '',
        createdAt: 5,
        state: 'complete',
        kind: 'model_switch',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      },
    ],
    summary: {
      content: 'Stale branch summary',
      createdAt: 5,
      sourceMessageIds: [`${id}-target-user`, `${id}-old-assistant`],
    },
    updatedAt: 5,
    status: 'idle',
  };
}

function buildBranchProgress(
  threadId: string,
  overrides: Partial<ChatStreamingProgressRecord> = {},
): ChatStreamingProgressRecord {
  return buildProgress(threadId, {
    messageId: `${threadId}-replacement-assistant`,
    modelId: 'author/model-q8',
    createdAt: 6,
    persistedAt: 120,
    regeneratesMessageId: undefined,
    branchReplacement: {
      targetUserMessageId: `${threadId}-target-user`,
      targetUserCreatedAt: 3,
      baseDurablePersistedAt: 100,
      baseCommitRevision: 7,
      replacementUserMessage: {
        id: `${threadId}-target-user`,
        role: 'user',
        kind: 'message',
        content: 'Edited target prompt',
        createdAt: 3,
        state: 'complete',
        modelId: 'author/model-q8',
      },
      insertedModelSwitchMessage: {
        id: `${threadId}-replacement-switch`,
        role: 'system',
        kind: 'model_switch',
        content: '',
        createdAt: 3,
        state: 'complete',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      },
      paramsSnapshot: {
        temperature: 0.4,
        topP: 0.8,
        topK: 32,
        minP: 0.05,
        repetitionPenalty: 1.1,
        maxTokens: 768,
        reasoningEffort: 'medium',
        seed: 42,
      },
    },
    ...overrides,
  });
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

  it('encodes progress keys and parses only bounded streaming progress envelopes', () => {
    const threadId = 'model/thread id/with spaces';
    const progress = buildProgress(threadId);
    const key = getChatStreamingProgressStorageKey(threadId);

    expect(key).toBe('chat-store:progress:model%2Fthread%20id%2Fwith%20spaces');
    expect(getThreadIdFromChatStreamingProgressStorageKey(key)).toBe(threadId);
    expect(getThreadIdFromChatStreamingProgressStorageKey('chat-store:progress:%E0%A4%A')).toBeNull();
    expect(parseChatStreamingProgressRecord(JSON.stringify(progress), threadId)).toEqual({
      ok: true,
      value: progress,
    });
    expect(parseChatStreamingProgressRecord(JSON.stringify({ ...progress, threadId: 'other' }), threadId)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
    expect(parseChatStreamingProgressRecord(JSON.stringify({ ...progress, revision: -1 }), threadId)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      persistedAt: Number.MAX_VALUE,
    }), threadId)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
    expect(parseChatStreamingProgressRecord('{broken', threadId)).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
  });

  it('parses valid branch progress without changing the progress schema version', () => {
    const progress = buildBranchProgress('thread-valid-branch-progress');

    expect(parseChatStreamingProgressRecord(JSON.stringify(progress), progress.threadId)).toEqual({
      ok: true,
      value: progress,
    });
    expect(progress.schemaVersion).toBe(CHAT_STREAM_PROGRESS_SCHEMA_VERSION);
  });

  it('rejects malformed branch progress instead of downgrading it to append recovery', () => {
    const progress = buildBranchProgress('thread-malformed-branch-progress');

    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: null,
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        baseCommitRevision: null,
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        insertedModelSwitchMessage: null,
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        paramsSnapshot: {
          ...progress.branchReplacement?.paramsSnapshot,
          topK: null,
        },
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        baseDurablePersistedAt: -1,
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        unexpectedOldTail: ['old-1', 'old-2'],
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('rejects noncanonical branch generation parameters instead of repairing corrupt progress', () => {
    const progress = buildBranchProgress('thread-invalid-branch-params');
    const validParams = progress.branchReplacement!.paramsSnapshot;
    const invalidParams: Array<[string, Record<string, unknown>]> = [
      ['temperature below range', { ...validParams, temperature: -0.01 }],
      ['temperature above range', { ...validParams, temperature: 2.01 }],
      ['topP below range', { ...validParams, topP: -0.01 }],
      ['topP above range', { ...validParams, topP: 1.01 }],
      ['fractional topK', { ...validParams, topK: 12.5 }],
      ['topK above range', { ...validParams, topK: 201 }],
      ['minP below range', { ...validParams, minP: -0.01 }],
      ['minP above range', { ...validParams, minP: 1.01 }],
      ['repetition penalty below range', { ...validParams, repetitionPenalty: -0.01 }],
      ['repetition penalty above range', { ...validParams, repetitionPenalty: 2.01 }],
      ['fractional maxTokens', { ...validParams, maxTokens: 768.5 }],
      ['maxTokens below range', { ...validParams, maxTokens: 0 }],
      ['maxTokens above range', { ...validParams, maxTokens: 8193 }],
      ['negative seed', { ...validParams, seed: -1 }],
      ['fractional seed', { ...validParams, seed: 42.5 }],
      ['seed above range', { ...validParams, seed: 2_147_483_648 }],
    ];

    invalidParams.forEach(([description, paramsSnapshot]) => {
      const result = parseChatStreamingProgressRecord(JSON.stringify({
        ...progress,
        branchReplacement: {
          ...progress.branchReplacement,
          paramsSnapshot,
        },
      }), progress.threadId);

      expect([description, result]).toEqual([
        description,
        { ok: false, reason: 'invalid_shape' },
      ]);
    });
  });

  it('rejects a branch replacement user with an invalid role', () => {
    const progress = buildBranchProgress('thread-invalid-branch-user-role');

    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        replacementUserMessage: {
          ...progress.branchReplacement?.replacementUserMessage,
          role: 'assistant',
        },
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('rejects an impossible empty branch replacement user', () => {
    const progress = buildBranchProgress('thread-invalid-empty-branch-user');

    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        replacementUserMessage: {
          ...progress.branchReplacement?.replacementUserMessage,
          content: '   ',
        },
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('rejects an invalid branch model-switch shape', () => {
    const progress = buildBranchProgress('thread-invalid-branch-switch');

    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        insertedModelSwitchMessage: {
          ...progress.branchReplacement?.insertedModelSwitchMessage,
          switchFromModelId: 'author/model-q8',
        },
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('rejects a branch model-switch id that collides with the replacement assistant id', () => {
    const progress = buildBranchProgress('thread-duplicate-branch-message-id');

    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        insertedModelSwitchMessage: {
          ...progress.branchReplacement?.insertedModelSwitchMessage,
          id: progress.messageId,
        },
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('rejects branch recovery when the target user is missing', () => {
    const thread = buildBranchRecoveryThread('thread-branch-missing-target');
    const progress = buildBranchProgress(thread.id);

    expect(recoverChatThreadFromStreamingProgress(
      {
        ...thread,
        messages: thread.messages.filter(
          (message) => message.id !== `${thread.id}-target-user`,
        ),
      },
      100,
      progress,
      130,
      7,
    )).toEqual({ outcome: 'mismatched' });
  });

  it('rejects branch recovery for a stale base persistedAt', () => {
    const thread = buildBranchRecoveryThread('thread-branch-stale-base');
    const progress = buildBranchProgress(thread.id);

    expect(recoverChatThreadFromStreamingProgress(
      thread,
      101,
      progress,
      130,
      7,
    )).toEqual({ outcome: 'stale' });
  });

  it('rejects branch recovery for a mismatched commit revision', () => {
    const thread = buildBranchRecoveryThread('thread-branch-stale-revision');
    const progress = buildBranchProgress(thread.id);

    expect(recoverChatThreadFromStreamingProgress(
      thread,
      100,
      progress,
      130,
      8,
    )).toEqual({ outcome: 'stale' });
    expect(recoverChatThreadFromStreamingProgress(
      thread,
      100,
      {
        ...progress,
        branchReplacement: {
          ...progress.branchReplacement!,
          baseCommitRevision: undefined,
        },
      },
      130,
      7,
    )).toEqual({ outcome: 'stale' });
  });

  it('rejects corrupt attachment metadata in branch progress', () => {
    const progress = buildBranchProgress('thread-branch-corrupt-attachment');

    expect(parseChatStreamingProgressRecord(JSON.stringify({
      ...progress,
      branchReplacement: {
        ...progress.branchReplacement,
        replacementUserMessage: {
          ...progress.branchReplacement?.replacementUserMessage,
          attachments: [{
            id: 'corrupt-attachment',
            kind: 'image',
            localUri: '../outside-private-storage.jpg',
          }],
        },
      },
    }), progress.threadId)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('keeps old progress records without branch metadata backward compatible', () => {
    const progress = buildProgress('thread-legacy-progress-without-branch');

    expect(parseChatStreamingProgressRecord(JSON.stringify(progress), progress.threadId)).toEqual({
      ok: true,
      value: progress,
    });
    expect(parseChatStreamingProgressRecord(
      JSON.stringify(progress),
      progress.threadId,
    ).ok).toBe(true);
  });

  it('materializes valid branch recovery through the canonical branch builder', () => {
    const thread = buildBranchRecoveryThread('thread-valid-branch-recovery');
    const progress = buildBranchProgress(thread.id);

    const recovery = recoverChatThreadFromStreamingProgress(thread, 100, progress, 130, 7);

    expect(recovery).toEqual({
      outcome: 'recovered',
      thread: expect.objectContaining({
        activeModelId: 'author/model-q8',
        paramsSnapshot: progress.branchReplacement?.paramsSnapshot,
        summary: undefined,
        status: 'stopped',
        messages: [
          thread.messages[0],
          thread.messages[1],
          progress.branchReplacement?.insertedModelSwitchMessage,
          progress.branchReplacement?.replacementUserMessage,
          expect.objectContaining({
            id: progress.messageId,
            content: progress.content,
            thoughtContent: progress.thoughtContent,
            state: 'stopped',
          }),
        ],
      }),
    });
  });

  it('rejects stale progress writes by message revision and replaces them for a newer turn', () => {
    const first = buildProgress('thread-progress', { revision: 5, persistedAt: 50 });
    expect(writeChatStreamingProgressRecord(storage, first)).toBe(true);
    expect(writeChatStreamingProgressRecord(storage, {
      ...first,
      content: 'Older callback',
      revision: 4,
      persistedAt: 60,
    })).toBe(false);
    expect(readChatStreamingProgressRecord(storage, first.threadId)).toEqual({ ok: true, value: first });

    const nextTurn = buildProgress(first.threadId, {
      messageId: 'assistant-new-turn',
      createdAt: 70,
      revision: 1,
      persistedAt: 70,
    });
    expect(writeChatStreamingProgressRecord(storage, nextTurn)).toBe(true);
    expect(readChatStreamingProgressRecord(storage, first.threadId)).toEqual({ ok: true, value: nextTurn });
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

  it('merges newer progress as a stopped assistant without duplicating durable history', () => {
    const thread: ChatThread = {
      ...buildThread('thread-progress-recovery'),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt with an attachment',
          createdAt: 1,
          state: 'complete',
          attachments: [copiedImageAttachment],
        },
      ],
      status: 'idle',
    };
    const progress = buildProgress(thread.id, {
      messageId: 'assistant-progress',
      createdAt: 2,
      persistedAt: 11,
    });

    const recovered = recoverChatThreadFromStreamingProgress(thread, 10, progress, 20);

    expect(recovered).toEqual({
      outcome: 'recovered',
      thread: expect.objectContaining({
        status: 'stopped',
        updatedAt: 20,
        messages: [
          expect.objectContaining({
            id: 'user-1',
            attachments: [copiedImageAttachment],
          }),
          expect.objectContaining({
            id: 'assistant-progress',
            content: 'Latest partial response',
            thoughtContent: 'Partial reasoning',
            tokensPerSec: 12.5,
            state: 'stopped',
          }),
        ],
      }),
    });

    if (recovered.outcome !== 'recovered') {
      throw new Error('Expected progress recovery');
    }
    const replacementProgress = buildProgress(thread.id, {
      ...progress,
      content: 'Newer partial response',
      persistedAt: 12,
      revision: 4,
    });
    const replaced = recoverChatThreadFromStreamingProgress(
      {
        ...recovered.thread,
        messages: recovered.thread.messages.map((message) => (
          message.id === progress.messageId ? { ...message, state: 'streaming' as const } : message
        )),
      },
      11,
      replacementProgress,
      21,
    );
    expect(replaced.outcome === 'recovered' ? replaced.thread.messages : []).toHaveLength(2);
  });

  it('recovers regenerated progress by replacing the original assistant answer', () => {
    const thread: ChatThread = {
      ...buildThread('thread-regenerated-progress'),
      messages: [
        {
          id: 'user-before-regeneration',
          role: 'user',
          content: 'Regenerate the answer',
          createdAt: 1,
          state: 'complete',
          attachments: [copiedImageAttachment],
        },
        {
          id: 'assistant-original',
          role: 'assistant',
          content: 'Original durable answer',
          createdAt: 2,
          state: 'complete',
          kind: 'message',
          modelId: 'author/model-q4',
        },
      ],
      status: 'idle',
    };
    const progress = buildProgress(thread.id, {
      messageId: 'assistant-regenerated',
      createdAt: 3,
      persistedAt: 11,
      regeneratesMessageId: 'assistant-original',
    });

    const recovered = recoverChatThreadFromStreamingProgress(thread, 10, progress, 20);

    expect(recovered).toEqual({
      outcome: 'recovered',
      thread: expect.objectContaining({
        status: 'stopped',
        messages: [
          expect.objectContaining({
            id: 'user-before-regeneration',
            attachments: [copiedImageAttachment],
          }),
          expect.objectContaining({
            id: 'assistant-regenerated',
            content: 'Latest partial response',
            state: 'stopped',
            regeneratesMessageId: 'assistant-original',
          }),
        ],
      }),
    });
    expect(recovered.outcome === 'recovered'
      ? recovered.thread.messages.some((message) => message.id === 'assistant-original')
      : true).toBe(false);
  });

  it('rejects stale regenerated progress targeting an unrelated or replaced message', () => {
    const targetMessage = {
      id: 'assistant-original',
      role: 'assistant' as const,
      content: 'Original durable answer',
      createdAt: 2,
      state: 'complete' as const,
      modelId: 'author/model-q4',
    };
    const baseThread: ChatThread = {
      ...buildThread('thread-regenerated-progress-rejected'),
      messages: [targetMessage],
      status: 'idle',
    };
    const progress = buildProgress(baseThread.id, {
      messageId: 'assistant-regenerated',
      createdAt: 3,
      persistedAt: 11,
      regeneratesMessageId: targetMessage.id,
    });

    expect(recoverChatThreadFromStreamingProgress(
      { ...baseThread, messages: [] },
      10,
      progress,
    )).toEqual({ outcome: 'mismatched' });
    expect(recoverChatThreadFromStreamingProgress(
      {
        ...baseThread,
        messages: [
          targetMessage,
          {
            id: 'unrelated-later-user',
            role: 'user',
            content: 'A later turn now owns the tail',
            createdAt: 4,
            state: 'complete',
          },
        ],
      },
      10,
      progress,
    )).toEqual({ outcome: 'mismatched' });
    expect(recoverChatThreadFromStreamingProgress(
      {
        ...baseThread,
        messages: [{ ...targetMessage, role: 'user' }],
      },
      10,
      progress,
    )).toEqual({ outcome: 'mismatched' });
    expect(recoverChatThreadFromStreamingProgress(
      {
        ...baseThread,
        messages: [{ ...targetMessage, createdAt: 4 }],
      },
      10,
      progress,
    )).toEqual({ outcome: 'stale' });
    expect(recoverChatThreadFromStreamingProgress(
      {
        ...baseThread,
        messages: [{
          ...targetMessage,
          id: progress.messageId,
          createdAt: progress.createdAt,
          state: 'stopped',
          regeneratesMessageId: 'different-original',
        }],
      },
      10,
      progress,
    )).toEqual({ outcome: 'mismatched' });
  });

  it('refuses stale, terminal-conflicting, model-mismatched, and empty progress', () => {
    const thread: ChatThread = {
      ...buildThread('thread-progress-rejected'),
      messages: [
        {
          id: 'assistant-terminal',
          role: 'assistant',
          content: 'Durable final answer',
          createdAt: 2,
          state: 'complete',
          modelId: 'author/model-q4',
        },
      ],
      status: 'idle',
    };

    expect(recoverChatThreadFromStreamingProgress(
      thread,
      20,
      buildProgress(thread.id, { persistedAt: 20 }),
    )).toEqual({ outcome: 'stale' });
    expect(recoverChatThreadFromStreamingProgress(
      thread,
      20,
      buildProgress(thread.id, {
        messageId: 'assistant-terminal',
        createdAt: 2,
        persistedAt: 21,
      }),
    )).toEqual({ outcome: 'mismatched' });
    expect(recoverChatThreadFromStreamingProgress(
      thread,
      20,
      buildProgress(thread.id, { modelId: 'author/other-model', persistedAt: 21 }),
    )).toEqual({ outcome: 'mismatched' });
    expect(recoverChatThreadFromStreamingProgress(
      { ...thread, messages: [] },
      20,
      buildProgress(thread.id, { content: ' ', thoughtContent: '', persistedAt: 21 }),
    )).toEqual({ outcome: 'empty' });
  });

  it('clears progress records together with v2 records and advances the clear tombstone', () => {
    const thread = buildThread('thread-progress-clear');
    const progress = buildProgress(thread.id, { persistedAt: 500 });
    writeChatThreadRecord(storage, thread, 100);
    writeChatStreamingProgressRecord(storage, progress);

    clearPersistedChatRecords(storage);

    expect(storage.getString(getChatThreadStorageKey(thread.id))).toBeUndefined();
    expect(storage.getString(getChatStreamingProgressStorageKey(thread.id))).toBeUndefined();
    expect(parseChatPersistenceIndex(storage.getString(CHAT_PERSISTENCE_INDEX_KEY))).toEqual({
      ok: true,
      value: expect.objectContaining({
        threadIds: [],
        clearedAt: expect.any(Number),
      }),
    });
    const index = parseChatPersistenceIndex(storage.getString(CHAT_PERSISTENCE_INDEX_KEY));
    expect(index.ok ? index.value.clearedAt : 0).toBeGreaterThan(500);
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
