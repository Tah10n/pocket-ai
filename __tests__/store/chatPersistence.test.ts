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
import type { ChatThread } from '../../src/types/chat';

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
