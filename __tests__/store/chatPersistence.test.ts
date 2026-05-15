import {
  CHAT_PERSISTENCE_INDEX_KEY,
  CHAT_PERSISTENCE_SCHEMA_VERSION,
  createChatPersistenceWriteScheduler,
  getChatThreadStorageKey,
  getThreadIdFromChatThreadStorageKey,
  parseChatPersistenceIndex,
  parseChatThreadRecord,
  recoverStaleStreamingThread,
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

  it('writes v2 index and per-thread records without using the legacy all-thread key', () => {
    const thread = buildThread('thread-1');

    writeChatThreadRecord(storage, thread, 11);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 12,
    });

    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toContain(thread.id);
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toContain('Partial response');
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
});
