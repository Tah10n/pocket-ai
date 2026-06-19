import * as FileSystem from 'expo-file-system/legacy';
import { ChatThread } from '../../src/types/chat';
import {
  findMostRecentThreadId,
  flushPendingChatPersistenceWrites,
  getThreadInferenceWindow,
  resetChatStoreForPrivateStorageReset,
  useChatStore,
} from '../../src/store/chatStore';
import {
  CHAT_PERSISTENCE_INDEX_KEY,
  CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY,
  CHAT_PERSISTENCE_SCHEMA_VERSION,
  getChatThreadStorageKey,
  writeChatPendingIndexCommit,
  writeChatPersistenceIndex,
  writeChatThreadRecord,
} from '../../src/store/chatPersistence';
import { getAppStorage, storage } from '../../src/store/storage';
import { chatAttachmentStorageService } from '../../src/services/ChatAttachmentStorageService';
import { copiedImageAttachment } from '../fixtures/chatImageAttachmentFixtures';

function buildThread(id: string, updatedAt: number): ChatThread {
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
        id: `${id}-user-1`,
        role: 'user',
        content: `Prompt for ${id}`,
        createdAt: updatedAt,
        state: 'complete',
      },
    ],
    createdAt: updatedAt,
    updatedAt,
    status: 'idle',
  };
}

function readPersistedChatIndex() {
  return JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}') as Record<string, unknown>;
}

function expectPersistedChatClearTombstone() {
  const rawIndex = storage.getString(CHAT_PERSISTENCE_INDEX_KEY);
  expect(rawIndex).toBeTruthy();

  const index = readPersistedChatIndex();
  expect(index).toEqual(expect.objectContaining({
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    activeThreadId: null,
    threadIds: [],
    clearedAt: expect.any(Number),
  }));
  expect(index.updatedAt).toBe(index.clearedAt);
}

function buildStoredAttachment(threadId: string, messageId: string, fileName: string) {
  return {
    ...copiedImageAttachment,
    id: fileName.replace(/\.[^.]+$/u, ''),
    threadId,
    messageId,
    localUri: `test-dir/chat-attachments/${fileName}`,
    fileName,
  };
}

async function flushAttachmentCleanup(cycles = 2) {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await Promise.resolve();
  }
}

function captureScheduledTimeouts() {
  const callbacks: Array<() => void> = [];
  const delays: Array<number | undefined> = [];
  const setTimeoutSpy = jest
    .spyOn(global, 'setTimeout')
    .mockImplementation((callback, delay) => {
      callbacks.push(callback as () => void);
      delays.push(typeof delay === 'number' ? delay : undefined);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    });

  return { callbacks, delays, setTimeoutSpy };
}

describe('chatStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    flushPendingChatPersistenceWrites('background');
    useChatStore.setState({ threads: {}, activeThreadId: null });
    storage.getAllKeys().forEach((key) => storage.remove(key));
  });

  it('findMostRecentThreadId returns the newest thread id without sorting', () => {
    const threads = {
      a: buildThread('a', 10),
      b: buildThread('b', 20),
      c: buildThread('c', 5),
    };

    expect(findMostRecentThreadId(threads)).toBe('b');
  });

  it('creates a thread and conversation index entry', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there from the user',
      createdAt: Date.now(),
      state: 'complete',
    });

    const thread = useChatStore.getState().getThread(threadId);
    const index = useChatStore.getState().getConversationIndex();

    expect(thread?.title).toContain('Hello there');
    expect(index).toHaveLength(1);
    expect(index[0]).toEqual(
      expect.objectContaining({
        id: threadId,
        modelId: 'author/model-q4',
        presetId: 'preset-1',
        messageCount: 1,
      }),
    );
  });

  it('rolls back in-memory chat state when a persistence write fails', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const threadBeforeAppend = useChatStore.getState().getThread(threadId);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writeError = new Error('simulated thread write failure');
    let threadWriteAttempts = 0;
    appStorage.set = jest.fn(function setWithFailure(this: unknown, key: string, value: unknown) {
      if (key === getChatThreadStorageKey(threadId) && threadWriteAttempts === 0) {
        threadWriteAttempts += 1;
        throw writeError;
      }

      return originalSet.call(this, key, value);
    });

    try {
      expect(() => {
        useChatStore.getState().appendMessage(threadId, {
          id: 'user-after-failure',
          role: 'user',
          content: 'This write should roll back',
          createdAt: Date.now(),
          state: 'complete',
        });
      }).toThrow(writeError);

      expect(useChatStore.getState().getThread(threadId)).toEqual(threadBeforeAppend);
      expect(useChatStore.getState().getConversationIndex()[0]).toEqual(expect.objectContaining({
        id: threadId,
        messageCount: threadBeforeAppend?.messages.length ?? 0,
      }));
    } finally {
      appStorage.set = originalSet;
    }
  });

  it('rolls back partial durable chat records when a persistence index write fails', async () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const threadBeforeAppend = useChatStore.getState().getThread(threadId);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writeError = new Error('simulated index write failure');
    let indexWriteAttempts = 0;
    appStorage.set = jest.fn(function setWithFailure(this: unknown, key: string, value: unknown) {
      if (key === CHAT_PERSISTENCE_INDEX_KEY && indexWriteAttempts === 0) {
        indexWriteAttempts += 1;
        throw writeError;
      }

      return originalSet.call(this, key, value);
    });

    try {
      expect(() => {
        useChatStore.getState().appendMessage(threadId, {
          id: 'user-after-durable-failure',
          role: 'user',
          content: 'This partial write should not survive rehydrate',
          createdAt: Date.now(),
          state: 'complete',
        });
      }).toThrow(writeError);
    } finally {
      appStorage.set = originalSet;
    }

    expect(useChatStore.getState().getThread(threadId)).toEqual(threadBeforeAppend);
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).not.toContain('partial write should not survive');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(threadId)).toEqual(threadBeforeAppend);
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual(threadBeforeAppend?.messages);
  });

  it('defaults kind and modelId when appending messages without metadata', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there from the user',
      createdAt: 1,
      state: 'complete',
    });

    expect(useChatStore.getState().getThread(threadId)?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: 'user-1',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    );
  });

  it('uses activeModelId for the conversation index model id when available', () => {
    const thread = {
      ...buildThread('thread-active-model', 10),
      modelId: 'author/model-q4',
      activeModelId: 'author/model-q8',
    };

    useChatStore.setState({
      threads: {
        [thread.id]: thread,
      },
      activeThreadId: thread.id,
    });

    expect(useChatStore.getState().getConversationIndex()[0]?.modelId).toBe('author/model-q8');
  });

  it('switchThreadModel updates activeModelId and appends a model_switch system message', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: 1,
      state: 'complete',
    });

    const switchMessageId = useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 123);
    const thread = useChatStore.getState().getThread(threadId);

    expect(switchMessageId).toBeTruthy();
    expect(thread?.activeModelId).toBe('author/model-q8');
    expect(thread?.messages.filter((message) => message.kind === 'model_switch')).toHaveLength(1);
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: switchMessageId,
        role: 'system',
        kind: 'model_switch',
        content: '',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
        createdAt: 123,
        state: 'complete',
      }),
    );
  });

  it('switchThreadModel is a no-op when switching to the current active model', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: 1,
      state: 'complete',
    });

    const before = useChatStore.getState().getThread(threadId);
    const result = useChatStore.getState().switchThreadModel(threadId, 'author/model-q4', 123);
    const after = useChatStore.getState().getThread(threadId);

    expect(result).toBeNull();
    expect(after).toBe(before);
    expect(after?.activeModelId).toBe('author/model-q4');
    expect(after?.messages).toHaveLength(1);
  });

  it('excludes model_switch messages from conversation previews and message counts', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 2);

    const indexItem = useChatStore.getState().getConversationIndex()[0];
    expect(indexItem).toEqual(
      expect.objectContaining({
        id: threadId,
        modelId: 'author/model-q8',
        messageCount: 1,
        lastMessagePreview: 'Hello there',
      }),
    );
  });

  it('creates and patches an assistant placeholder', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    useChatStore.getState().patchAssistantMessage(threadId, assistantId, {
      content: 'Streaming reply',
      state: 'complete',
    });

    const thread = useChatStore.getState().getThread(threadId);
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        role: 'assistant',
        content: 'Streaming reply',
        state: 'complete',
      }),
    );
  });

  it('keeps an empty assistant placeholder in memory but out of durable records before the first token', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Prompt before first token',
      createdAt: 1,
      state: 'complete',
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    flushPendingChatPersistenceWrites('background');

    expect(useChatStore.getState().getThread(threadId)?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        state: 'streaming',
      }),
    );

    const rawRecord = storage.getString(getChatThreadStorageKey(threadId));
    const record = JSON.parse(rawRecord ?? '{}') as { thread: ChatThread };
    expect(record.thread.status).toBe('idle');
    expect(record.thread.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'Prompt before first token',
      }),
    ]);
  });

  it('ignores assistant patches when the target message does not exist', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: Date.now(),
      state: 'complete',
    });

    const before = useChatStore.getState().getThread(threadId);

    useChatStore.getState().patchAssistantMessage(threadId, 'missing-message-id', {
      content: 'Should not apply',
      state: 'complete',
    });

    const after = useChatStore.getState().getThread(threadId);

    expect(after).toBe(before);
    expect(after?.messages).toBe(before?.messages);
    expect(after?.status).toBe(before?.status);
  });

  it('ignores stale assistant patches once the target is no longer the latest message', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Original prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Original answer',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'New prompt',
      createdAt: 3,
      state: 'complete',
    });
    const replacementId = useChatStore.getState().createAssistantPlaceholder(threadId);
    const before = useChatStore.getState().getThread(threadId);

    useChatStore.getState().patchAssistantMessage(threadId, 'assistant-1', {
      content: 'Late stale token',
      state: 'complete',
    });

    const after = useChatStore.getState().getThread(threadId);
    expect(after).toBe(before);
    expect(after?.messages.find((message) => message.id === 'assistant-1')).toEqual(
      expect.objectContaining({
        content: 'Original answer',
        state: 'complete',
      }),
    );
    expect(after?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: replacementId,
        state: 'streaming',
      }),
    );
  });

  it('ignores late streaming patches after the assistant message is stopped', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    useChatStore.getState().stopAssistantMessage(threadId, assistantId);
    const before = useChatStore.getState().getThread(threadId);

    useChatStore.getState().patchAssistantMessage(threadId, assistantId, {
      content: 'Late token after stop',
      state: 'streaming',
    });

    const after = useChatStore.getState().getThread(threadId);
    expect(after).toBe(before);
    expect(after?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        content: '',
        state: 'stopped',
      }),
    );
  });

  it('stops an assistant message and marks the thread as stopped', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    useChatStore.getState().patchAssistantMessage(threadId, assistantId, {
      content: 'Partial reply',
      state: 'streaming',
    });

    useChatStore.getState().stopAssistantMessage(threadId, assistantId);

    const thread = useChatStore.getState().getThread(threadId);
    expect(thread?.status).toBe('stopped');
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        content: 'Partial reply',
        state: 'stopped',
      }),
    );
  });

  it('replaces the last assistant message for regeneration', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: Date.now(),
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Original reply',
      createdAt: Date.now(),
      state: 'complete',
    });

    const replacementId = useChatStore.getState().replaceLastAssistantMessage(threadId);
    const thread = useChatStore.getState().getThread(threadId);
    const replacement = thread?.messages.at(-1);

    expect(replacementId).toBeTruthy();
    expect(thread?.status).toBe('generating');
    expect(replacement).toEqual(
      expect.objectContaining({
        id: replacementId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        regeneratesMessageId: 'assistant-1',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    );
  });

  it('replaces a message branch from a selected user turn', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 3,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 4,
      state: 'complete',
    });

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      'Edited first prompt',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'Edited first prompt',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    ]);
  });

  it('trims edited user branch content and rejects empty branch edits inside the store', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      '  Edited first prompt  ',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages[0]).toEqual(
      expect.objectContaining({
        id: 'user-1',
        content: 'Edited first prompt',
      }),
    );

    const beforeEmptyEdit = useChatStore.getState().getThread(threadId);
    expect(useChatStore.getState().replaceBranchFromUserMessage(threadId, 'user-1', '   ')).toBeNull();
    expect(useChatStore.getState().getThread(threadId)).toBe(beforeEmptyEdit);
  });

  it('preserves image-only user attachments when regenerating a branch with empty text', () => {
    const threadId = useChatStore.getState().createThread({
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
    });
    const attachment = buildStoredAttachment(threadId, 'user-1', 'image-only.jpg');

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: '',
      attachments: [attachment],
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      '   ',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: '',
        attachments: [attachment],
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
      }),
    ]);
  });

  it('replaces an older user branch with the active switched model metadata', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 3,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 4,
      state: 'complete',
    });

    useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 5);

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      'Edited first prompt',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'Edited first prompt',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    ]);
  });

  it('inserts a replacement model switch when regenerating an older branch after multiple switches', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });

    const firstSwitchId = useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 3);

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 4,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 5,
      state: 'complete',
    });

    useChatStore.getState().switchThreadModel(threadId, 'author/model-q6', 6);

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-2',
      'Edited second prompt',
    );

    const thread = useChatStore.getState().getThread(threadId);
    const modelSwitchMessages = thread?.messages.filter((message) => message.kind === 'model_switch') ?? [];

    expect(firstSwitchId).toBeTruthy();
    expect(replacementAssistantId).toBeTruthy();
    expect(thread?.activeModelId).toBe('author/model-q6');
    expect(modelSwitchMessages).toHaveLength(2);
    expect(modelSwitchMessages).toEqual([
      expect.objectContaining({
        id: firstSwitchId,
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        switchFromModelId: 'author/model-q8',
        switchToModelId: 'author/model-q6',
      }),
    ]);
    expect(thread?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'First prompt',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: 'assistant-1',
        role: 'assistant',
        content: 'First reply',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: firstSwitchId,
        kind: 'model_switch',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        kind: 'model_switch',
        switchFromModelId: 'author/model-q8',
        switchToModelId: 'author/model-q6',
      }),
      expect.objectContaining({
        id: 'user-2',
        role: 'user',
        content: 'Edited second prompt',
        kind: 'message',
        modelId: 'author/model-q6',
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        kind: 'message',
        modelId: 'author/model-q6',
      }),
    ]);
  });

  it('deletes a message branch and resets the thread to earlier messages', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 3,
      state: 'complete',
    });

    expect(useChatStore.getState().deleteMessageBranch(threadId, 'assistant-1')).toBe(true);
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'First prompt',
      }),
    ]);
  });

  it('cleans attachments removed by branch deletion without deleting surviving references', async () => {
    const retainedAttachment = buildStoredAttachment('thread-branch-cleanup', 'user-1', 'shared.jpg');
    const removedAttachment = buildStoredAttachment('thread-branch-cleanup', 'user-2', 'removed-branch.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-branch-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Keep this image',
          createdAt: 10,
          state: 'complete',
          attachments: [retainedAttachment],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'First reply',
          createdAt: 11,
          state: 'complete',
        },
        {
          id: 'user-2',
          role: 'user',
          content: 'Remove this branch image',
          createdAt: 12,
          state: 'complete',
          attachments: [removedAttachment],
        },
      ],
    };

    useChatStore.setState({
      threads: { [thread.id]: thread },
      activeThreadId: thread.id,
    });

    expect(useChatStore.getState().deleteMessageBranch(thread.id, 'user-2')).toBe(true);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(removedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(retainedAttachment.localUri, expect.anything());
  });

  it('cleans attachments removed by retry or edit branch replacement', async () => {
    const retainedAttachment = buildStoredAttachment('thread-edit-cleanup', 'user-1', 'edited-kept.jpg');
    const removedAttachment = buildStoredAttachment('thread-edit-cleanup', 'user-2', 'edited-removed.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-edit-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Original image prompt',
          createdAt: 10,
          state: 'complete',
          attachments: [retainedAttachment],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'First reply',
          createdAt: 11,
          state: 'complete',
        },
        {
          id: 'user-2',
          role: 'user',
          content: 'Later image prompt',
          createdAt: 12,
          state: 'complete',
          attachments: [removedAttachment],
        },
      ],
    };

    useChatStore.setState({
      threads: { [thread.id]: thread },
      activeThreadId: thread.id,
    });

    expect(useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      'user-1',
      'Edited original image prompt',
    )).toBeTruthy();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([retainedAttachment]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(removedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(retainedAttachment.localUri, expect.anything());
  });

  it('recomputes activeModelId from the surviving history when deleting an older branch after multiple switches', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 3);
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 4,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 5,
      state: 'complete',
    });
    useChatStore.getState().switchThreadModel(threadId, 'author/model-q6', 6);

    expect(useChatStore.getState().deleteMessageBranch(threadId, 'assistant-2')).toBe(true);

    const thread = useChatStore.getState().getThread(threadId);

    expect(thread?.activeModelId).toBe('author/model-q8');
    expect(thread?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: 'assistant-1',
        role: 'assistant',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        kind: 'model_switch',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        id: 'user-2',
        role: 'user',
        modelId: 'author/model-q8',
      }),
    ]);
  });

  it('deletes a thread and moves the active selection to the newest remaining thread', () => {
    const firstThreadId = useChatStore.getState().createThread({
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
    });
    const secondThreadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().deleteThread(secondThreadId);

    expect(useChatStore.getState().getThread(secondThreadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(firstThreadId);
  });

  it('cleans attachment files when deleting full threads', async () => {
    const removedAttachment = buildStoredAttachment('thread-delete-cleanup', 'user-1', 'thread-delete.jpg');
    const retainedAttachment = buildStoredAttachment('thread-retained-cleanup', 'user-1', 'thread-retained.jpg');
    const removedThread: ChatThread = {
      ...buildThread('thread-delete-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Remove thread attachment',
          createdAt: 10,
          state: 'complete',
          attachments: [removedAttachment],
        },
      ],
    };
    const retainedThread: ChatThread = {
      ...buildThread('thread-retained-cleanup', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Keep thread attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [retainedAttachment],
        },
      ],
    };

    useChatStore.setState({
      threads: {
        [removedThread.id]: removedThread,
        [retainedThread.id]: retainedThread,
      },
      activeThreadId: removedThread.id,
    });

    useChatStore.getState().deleteThread(removedThread.id);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(removedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(retainedAttachment.localUri, expect.anything());
  });

  it('persists an explicit blank active thread selection across rehydrate', async () => {
    const firstThreadId = useChatStore.getState().createThread({
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
    });
    const secondThreadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().setActiveThread(null);

    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: null,
      threadIds: [firstThreadId, secondThreadId],
    }));

    useChatStore.setState({ threads: {}, activeThreadId: secondThreadId });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(firstThreadId)).toEqual(
      expect.objectContaining({ id: firstThreadId }),
    );
    expect(useChatStore.getState().getThread(secondThreadId)).toEqual(
      expect.objectContaining({ id: secondThreadId }),
    );
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(readPersistedChatIndex().activeThreadId).toBeNull();
  });

  it('recovers a pending thread commit when the record was written before the index update', async () => {
    const thread = buildThread('thread-pending-record-first', 20);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 10,
      revision: 1,
    });
    writeChatThreadRecord(storage, thread, 21, { commitRevision: 2 });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [thread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)).toEqual(
      expect.objectContaining({ id: thread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(thread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: thread.id,
      threadIds: [thread.id],
      revision: 2,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('cleans attachment files dropped while recovering a pending thread commit', async () => {
    const keptAttachment = buildStoredAttachment('thread-pending-sanitized-attachment', 'user-1', 'pending-kept.jpg');
    const droppedAttachment = {
      ...buildStoredAttachment('thread-pending-sanitized-attachment', 'user-1', 'pending-dropped.txt'),
      mediaType: 'text/plain',
    };
    const thread: ChatThread = {
      ...buildThread('thread-pending-sanitized-attachment', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Pending sanitized attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [keptAttachment, droppedAttachment],
        },
      ],
    };

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 10,
      revision: 1,
    });
    storage.set(getChatThreadStorageKey(thread.id), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread,
      persistedAt: 21,
      commitRevision: 2,
    }));
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [thread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([keptAttachment]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(droppedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(keptAttachment.localUri, expect.anything());
  });

  it('recovers legacy pending commits whose changed records predate commit revision markers', async () => {
    const thread = buildThread('thread-pending-legacy-record', 20);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 10,
      revision: 1,
    });
    writeChatThreadRecord(storage, thread, 23);
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [thread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)).toEqual(
      expect.objectContaining({ id: thread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(thread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: thread.id,
      threadIds: [thread.id],
      revision: 2,
    }));
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toContain('"commitRevision":2');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a legacy changed record predates the pending commit', async () => {
    const staleThread = {
      ...buildThread('thread-legacy-stale-record', 10),
      title: 'Old title',
    };

    writeChatThreadRecord(storage, staleThread, 11);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [staleThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toEqual(
      expect.objectContaining({ title: 'Old title' }),
    );
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).not.toContain('"commitRevision"');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a strict pending record lacks a commit revision marker', async () => {
    const staleThread = buildThread('thread-strict-record-without-revision', 10);

    writeChatThreadRecord(storage, staleThread, 11);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [staleThread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toEqual(
      expect.objectContaining({ id: staleThread.id }),
    );
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).not.toContain('"commitRevision"');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a changed pending thread record is missing', async () => {
    const existingThread = buildThread('thread-existing', 10);
    const missingThreadId = 'thread-missing-record';

    writeChatThreadRecord(storage, existingThread, 11, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: existingThread.id,
      threadIds: [existingThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: missingThreadId,
      threadIds: [existingThread.id, missingThreadId],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [missingThreadId],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(existingThread.id)).toEqual(
      expect.objectContaining({ id: existingThread.id }),
    );
    expect(useChatStore.getState().getThread(missingThreadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(existingThread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: existingThread.id,
      threadIds: [existingThread.id],
      revision: 1,
    }));
    expect(readPersistedChatIndex()).not.toHaveProperty('corruptThreadIds');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('does not apply pending removals when a mixed commit has no durable changed record', async () => {
    const retainedThread = buildThread('thread-mixed-retained', 10);
    const removedThread = buildThread('thread-mixed-removed', 20);
    const missingThreadId = 'thread-mixed-missing-record';

    writeChatThreadRecord(storage, retainedThread, 11, { commitRevision: 1 });
    writeChatThreadRecord(storage, removedThread, 21, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: removedThread.id,
      threadIds: [retainedThread.id, removedThread.id],
      updatedAt: 22,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: retainedThread.id,
      threadIds: [retainedThread.id, missingThreadId],
      updatedAt: 23,
      reason: 'thread_mutation',
      changedThreadIds: [missingThreadId],
      removedThreadIds: [removedThread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(retainedThread.id)).toEqual(
      expect.objectContaining({ id: retainedThread.id }),
    );
    expect(useChatStore.getState().getThread(removedThread.id)).toEqual(
      expect.objectContaining({ id: removedThread.id }),
    );
    expect(useChatStore.getState().getThread(missingThreadId)).toBeNull();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: removedThread.id,
      threadIds: [retainedThread.id, removedThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(removedThread.id))).toContain(removedThread.title);
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a changed pending thread record has an older commit revision', async () => {
    const staleThread = {
      ...buildThread('thread-stale-record', 10),
      title: 'Old title',
    };

    writeChatThreadRecord(storage, staleThread, 11, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [staleThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toEqual(
      expect.objectContaining({ title: 'Old title' }),
    );
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).toContain('"commitRevision":1');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('removes unindexed changed records when their commit revision does not match the pending revision', async () => {
    const uncommittedThread = buildThread('thread-uncommitted-record', 10);

    writeChatThreadRecord(storage, uncommittedThread, 11, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: uncommittedThread.id,
      threadIds: [uncommittedThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [uncommittedThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(uncommittedThread.id)).toBeNull();
    expect(storage.getString(getChatThreadStorageKey(uncommittedThread.id))).toBeUndefined();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: null,
      threadIds: [],
      revision: 1,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('removes unapplied changed records when discarding a pending commit without a trusted index', async () => {
    const unappliedThread = buildThread('thread-pending-indexless-record', 10);

    writeChatThreadRecord(storage, unappliedThread, 11, { commitRevision: 1 });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: unappliedThread.id,
      threadIds: [unappliedThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [unappliedThread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(unappliedThread.id)).toBeNull();
    expect(storage.getString(getChatThreadStorageKey(unappliedThread.id))).toBeUndefined();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toBeUndefined();
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('applies pending commits when changed records match the pending revision and unchanged records are older', async () => {
    const unchangedThread = buildThread('thread-unchanged-record', 10);
    const changedThread = {
      ...buildThread('thread-changed-record', 20),
      title: 'Changed title',
    };

    writeChatThreadRecord(storage, unchangedThread, 11, { commitRevision: 1 });
    writeChatThreadRecord(storage, changedThread, 21, { commitRevision: 2 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: unchangedThread.id,
      threadIds: [unchangedThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: changedThread.id,
      threadIds: [unchangedThread.id, changedThread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [changedThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(unchangedThread.id)).toEqual(
      expect.objectContaining({ id: unchangedThread.id }),
    );
    expect(useChatStore.getState().getThread(changedThread.id)).toEqual(
      expect.objectContaining({ title: 'Changed title' }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(changedThread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: changedThread.id,
      threadIds: [unchangedThread.id, changedThread.id],
      revision: 2,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('applies pending removed thread ids before discovery can resurrect stale records', async () => {
    const staleThread = buildThread('thread-pending-stale', 5);
    const retainedThread = buildThread('thread-pending-retained', 20);

    writeChatThreadRecord(storage, staleThread, 6, { commitRevision: 1 });
    writeChatThreadRecord(storage, retainedThread, 21, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: retainedThread.id,
      threadIds: [staleThread.id, retainedThread.id],
      updatedAt: 22,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: retainedThread.id,
      threadIds: [retainedThread.id],
      updatedAt: 23,
      reason: 'retention_cleanup',
      removedThreadIds: [staleThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(retainedThread.id)).toEqual(
      expect.objectContaining({ id: retainedThread.id }),
    );
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).toBeUndefined();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: retainedThread.id,
      threadIds: [retainedThread.id],
      revision: 2,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('ignores stale pending removals from an older revision', async () => {
    const currentThread = buildThread('thread-newer-revision', 30);

    writeChatThreadRecord(storage, currentThread, 31, { commitRevision: 3 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: currentThread.id,
      threadIds: [currentThread.id],
      updatedAt: 32,
      revision: 3,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 22,
      reason: 'retention_cleanup',
      removedThreadIds: [currentThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(currentThread.id)).toEqual(
      expect.objectContaining({ id: currentThread.id }),
    );
    expect(storage.getString(getChatThreadStorageKey(currentThread.id))).toContain(currentThread.title);
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('removes persisted v2 records when deleting the last thread', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeTruthy();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toBeTruthy();

    useChatStore.getState().deleteThread(threadId);

    expect(useChatStore.getState().getThread(threadId)).toBeNull();
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
    expectPersistedChatClearTombstone();
  });

  it('removes persisted v2 records when clearing all threads', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeTruthy();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toBeTruthy();
    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
    expectPersistedChatClearTombstone();
  });

  it('cleans attachment files when clearing all chat history', async () => {
    const attachment = buildStoredAttachment('thread-clear-cleanup', 'user-1', 'clear-history.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-clear-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Clear history image',
          createdAt: 10,
          state: 'complete',
          attachments: [attachment],
        },
      ],
    };

    useChatStore.setState({
      threads: { [thread.id]: thread },
      activeThreadId: thread.id,
    });

    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(attachment.localUri, {
      idempotent: true,
    });
  });

  it('leaves a clear tombstone when resetting chat state for private storage recovery', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeTruthy();

    resetChatStoreForPrivateStorageReset();

    expect(useChatStore.getState().getThread(threadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
    expectPersistedChatClearTombstone();
  });

  it('captures preset and params snapshots immutably at thread creation', () => {
    const paramsSnapshot = {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
      seed: null,
    };
    const presetSnapshot = {
      id: 'preset-1',
      name: 'Helpful Assistant',
      systemPrompt: 'Be concise.',
    };

    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot,
      paramsSnapshot,
    });

    paramsSnapshot.temperature = 1.8;
    presetSnapshot.name = 'Changed later';
    presetSnapshot.systemPrompt = 'Different prompt';

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        paramsSnapshot: expect.objectContaining({
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          repetitionPenalty: 1,
          maxTokens: 1024,
        }),
        presetSnapshot: {
          id: 'preset-1',
          name: 'Helpful Assistant',
          systemPrompt: 'Be concise.',
        },
      }),
    );
  });

  it('updates the preset snapshot for an existing thread', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().updateThreadPresetSnapshot(threadId, 'preset-2', {
      id: 'preset-2',
      name: 'Research Analyst',
      systemPrompt: 'Organize findings clearly.',
    });

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        presetId: 'preset-2',
        presetSnapshot: {
          id: 'preset-2',
          name: 'Research Analyst',
          systemPrompt: 'Organize findings clearly.',
        },
      }),
    );
  });

  it('updates thread activity when params snapshot changes', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const before = useChatStore.getState().getThread(threadId);
    expect(before).toBeTruthy();

    const originalDateNow = Date.now;
    Date.now = jest.fn(() => (before?.updatedAt ?? 0) + 5_000);

    try {
      useChatStore.getState().updateThreadParamsSnapshot(threadId, {
        temperature: 1.1,
        topP: 0.4,
        topK: 60,
        minP: 0.1,
        repetitionPenalty: 1.2,
        maxTokens: 512,
        reasoningEffort: 'high',
        seed: null,
      });
    } finally {
      Date.now = originalDateNow;
    }

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        updatedAt: (before?.updatedAt ?? 0) + 5_000,
        paramsSnapshot: {
          temperature: 1.1,
          topP: 0.4,
          topK: 60,
          minP: 0.1,
          repetitionPenalty: 1.2,
          maxTokens: 512,
          reasoningEffort: 'high',
          seed: null,
        },
      }),
    );
  });

  it('derives a stable truncated title from the first user message', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'This is a long opening question that should become a shortened conversation title for history',
      createdAt: Date.now(),
      state: 'complete',
    });

    expect(useChatStore.getState().getThread(threadId)?.title).toBe(
      'This is a long opening question that should b...',
    );
  });

  it('keeps a manually renamed title after more messages are added', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Original opening prompt',
      createdAt: Date.now(),
      state: 'complete',
    });

    expect(useChatStore.getState().renameThread(threadId, 'Project Planning')).toBe(true);

    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Let us outline the work.',
      createdAt: Date.now(),
      state: 'complete',
    });

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        title: 'Project Planning',
        titleSource: 'manual',
      }),
    );
  });

  it('does not schedule attachment cleanup for metadata-only thread mutations', async () => {
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFiles')
      .mockResolvedValue(0);
    const threadId = useChatStore.getState().createThread({
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
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-with-attachment',
      role: 'user',
      content: 'Image prompt',
      createdAt: Date.now(),
      state: 'complete',
      attachments: [buildStoredAttachment(threadId, 'user-with-attachment', 'metadata-kept.jpg')],
    });
    await flushAttachmentCleanup();
    cleanupSpy.mockClear();

    expect(useChatStore.getState().renameThread(threadId, 'Renamed')).toBe(true);
    await flushAttachmentCleanup();

    expect(cleanupSpy).not.toHaveBeenCalled();
    cleanupSpy.mockRestore();
  });

  it('serializes overlapping unreferenced attachment cleanup requests', async () => {
    const firstCleanup = {
      resolve: null as ((deletedCount: number) => void) | null,
    };
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFiles')
      .mockImplementationOnce(() => new Promise<number>((resolve) => {
        firstCleanup.resolve = resolve;
      }))
      .mockResolvedValue(0);
    const firstAttachment = buildStoredAttachment('thread-cleanup-one', 'user-1', 'cleanup-one.jpg');
    const secondAttachment = buildStoredAttachment('thread-cleanup-two', 'user-1', 'cleanup-two.jpg');
    const firstThread: ChatThread = {
      ...buildThread('thread-cleanup-one', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'First image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [firstAttachment],
      }],
    };
    const secondThread: ChatThread = {
      ...buildThread('thread-cleanup-two', 20),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Second image prompt',
        createdAt: 20,
        state: 'complete',
        attachments: [secondAttachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: {
          [firstThread.id]: firstThread,
          [secondThread.id]: secondThread,
        },
        activeThreadId: firstThread.id,
      });

      useChatStore.getState().deleteThread(firstThread.id);
      await flushAttachmentCleanup();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        candidateLocalUris: [firstAttachment.localUri],
        maxDeletes: 16,
      }));

      useChatStore.getState().deleteThread(secondThread.id);
      await flushAttachmentCleanup();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      expect(firstCleanup.resolve).toEqual(expect.any(Function));
      firstCleanup.resolve?.(0);
      firstCleanup.resolve = null;
      await flushAttachmentCleanup(6);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      expect(cleanupSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        candidateLocalUris: [secondAttachment.localUri],
        maxDeletes: 16,
      }));
    } finally {
      if (firstCleanup.resolve) {
        firstCleanup.resolve(0);
      }
      cleanupSpy.mockRestore();
    }
  });

  it('does not let stale queued references protect later orphaned attachments', async () => {
    const firstCleanup = {
      resolve: null as ((deletedCount: number) => void) | null,
    };
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFiles')
      .mockImplementationOnce(() => new Promise<number>((resolve) => {
        firstCleanup.resolve = resolve;
      }))
      .mockResolvedValue(0);
    const inFlightAttachment = buildStoredAttachment('thread-cleanup-in-flight', 'user-1', 'cleanup-in-flight.jpg');
    const queuedAttachment = buildStoredAttachment('thread-cleanup-queued', 'user-1', 'cleanup-queued.jpg');
    const laterOrphanedAttachment = buildStoredAttachment('thread-cleanup-later', 'user-1', 'cleanup-later.jpg');
    const inFlightThread: ChatThread = {
      ...buildThread('thread-cleanup-in-flight', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'In-flight cleanup image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [inFlightAttachment],
      }],
    };
    const queuedThread: ChatThread = {
      ...buildThread('thread-cleanup-queued', 20),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Queued cleanup image prompt',
        createdAt: 20,
        state: 'complete',
        attachments: [queuedAttachment],
      }],
    };
    const laterOrphanedThread: ChatThread = {
      ...buildThread('thread-cleanup-later', 30),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Later orphaned image prompt',
        createdAt: 30,
        state: 'complete',
        attachments: [laterOrphanedAttachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: {
          [inFlightThread.id]: inFlightThread,
          [queuedThread.id]: queuedThread,
          [laterOrphanedThread.id]: laterOrphanedThread,
        },
        activeThreadId: inFlightThread.id,
      });

      useChatStore.getState().deleteThread(inFlightThread.id);
      await flushAttachmentCleanup();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      useChatStore.getState().deleteThread(queuedThread.id);
      useChatStore.getState().deleteThread(laterOrphanedThread.id);
      await flushAttachmentCleanup();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      expect(firstCleanup.resolve).toEqual(expect.any(Function));
      firstCleanup.resolve?.(0);
      firstCleanup.resolve = null;
      await flushAttachmentCleanup(6);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      const secondCleanupRequest = cleanupSpy.mock.calls[1][0];
      expect(secondCleanupRequest).toEqual(expect.objectContaining({
        candidateLocalUris: [queuedAttachment.localUri, laterOrphanedAttachment.localUri],
        maxDeletes: 16,
      }));
      expect(secondCleanupRequest.referencedLocalUris).toBeDefined();
      expect(Array.from(secondCleanupRequest.referencedLocalUris!)).not.toContain(laterOrphanedAttachment.localUri);
    } finally {
      if (firstCleanup.resolve) {
        firstCleanup.resolve(0);
      }
      cleanupSpy.mockRestore();
    }
  });

  it('bounds large unreferenced attachment cleanup batches', async () => {
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFiles')
      .mockResolvedValue(0);
    const attachments = Array.from({ length: 18 }, (_, index) => (
      buildStoredAttachment('thread-cleanup-large', `user-${index}`, `cleanup-large-${index}.jpg`)
    ));
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-large', 10),
      messages: attachments.map((attachment, index) => ({
        id: `user-${index}`,
        role: 'user' as const,
        content: `Large cleanup image prompt ${index}`,
        createdAt: 10 + index,
        state: 'complete' as const,
        attachments: [attachment],
      })),
    };

    useChatStore.setState({
      threads: {
        [removedThread.id]: removedThread,
      },
      activeThreadId: removedThread.id,
    });

    useChatStore.getState().deleteThread(removedThread.id);
    await flushAttachmentCleanup(8);

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    expect(cleanupSpy.mock.calls[0][0]).toEqual(expect.objectContaining({
      candidateLocalUris: attachments.slice(0, 16).map((attachment) => attachment.localUri),
      maxDeletes: 16,
    }));
    expect(cleanupSpy.mock.calls[1][0]).toEqual(expect.objectContaining({
      candidateLocalUris: attachments.slice(16).map((attachment) => attachment.localUri),
      maxDeletes: 16,
    }));
    cleanupSpy.mockRestore();
  });

  it('retries rejected unreferenced attachment cleanup without dropping failed or remaining candidates', async () => {
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFiles')
      .mockRejectedValueOnce(new Error('cleanup unavailable'))
      .mockResolvedValue(0);
    const attachments = Array.from({ length: 18 }, (_, index) => (
      buildStoredAttachment('thread-cleanup-retry', `user-${index}`, `cleanup-retry-${index}.jpg`)
    ));
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-retry', 10),
      messages: attachments.map((attachment, index) => ({
        id: `user-${index}`,
        role: 'user' as const,
        content: `Retry cleanup image prompt ${index}`,
        createdAt: 10 + index,
        state: 'complete' as const,
        attachments: [attachment],
      })),
    };

    try {
      useChatStore.setState({
        threads: {
          [removedThread.id]: removedThread,
        },
        activeThreadId: removedThread.id,
      });

      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy.mock.calls[0][0]).toEqual(expect.objectContaining({
        candidateLocalUris: attachments.slice(0, 16).map((attachment) => attachment.localUri),
        maxDeletes: 16,
      }));
      expect(callbacks).toHaveLength(1);
      expect(delays[0]).toBe(1000);

      callbacks[0]?.();
      await flushAttachmentCleanup(10);

      expect(cleanupSpy).toHaveBeenCalledTimes(3);
      expect(cleanupSpy.mock.calls[1][0]).toEqual(expect.objectContaining({
        candidateLocalUris: attachments.slice(0, 16).map((attachment) => attachment.localUri),
        maxDeletes: 16,
      }));
      expect(cleanupSpy.mock.calls[2][0]).toEqual(expect.objectContaining({
        candidateLocalUris: attachments.slice(16).map((attachment) => attachment.localUri),
        maxDeletes: 16,
      }));
      expect(warnSpy).toHaveBeenCalledWith('[chatStore] Failed to clean up chat attachments', { errorName: 'Error' });
    } finally {
      cleanupSpy.mockRestore();
      warnSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('honors cleanup retry backoff while merging new requests into the pending retry', async () => {
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFiles')
      .mockRejectedValueOnce(new Error('cleanup unavailable'))
      .mockResolvedValue(0);
    const firstAttachment = buildStoredAttachment('thread-cleanup-retry-first', 'user-1', 'cleanup-retry-first.jpg');
    const secondAttachment = buildStoredAttachment('thread-cleanup-retry-second', 'user-1', 'cleanup-retry-second.jpg');
    const firstThread: ChatThread = {
      ...buildThread('thread-cleanup-retry-first', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'First retry image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [firstAttachment],
      }],
    };
    const secondThread: ChatThread = {
      ...buildThread('thread-cleanup-retry-second', 20),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Second retry image prompt',
        createdAt: 20,
        state: 'complete',
        attachments: [secondAttachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: {
          [firstThread.id]: firstThread,
          [secondThread.id]: secondThread,
        },
        activeThreadId: firstThread.id,
      });

      useChatStore.getState().deleteThread(firstThread.id);
      await flushAttachmentCleanup(8);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(callbacks).toHaveLength(1);
      expect(delays[0]).toBe(1000);

      useChatStore.getState().deleteThread(secondThread.id);
      await flushAttachmentCleanup(8);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      callbacks[0]?.();
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      expect(cleanupSpy.mock.calls[1][0]).toEqual(expect.objectContaining({
        candidateLocalUris: [firstAttachment.localUri, secondAttachment.localUri],
        maxDeletes: 16,
      }));
      expect(warnSpy).toHaveBeenCalledWith('[chatStore] Failed to clean up chat attachments', { errorName: 'Error' });
    } finally {
      cleanupSpy.mockRestore();
      warnSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('preserves live attachments dropped by persistence sanitization during store writes', async () => {
    const threadId = useChatStore.getState().createThread({
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
    });
    const attachments = [
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-1.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-2.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-3.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-4.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-dropped-5.jpg'),
    ];

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-over-limit',
      role: 'user',
      content: 'Image prompt over the persistence limit',
      createdAt: Date.now(),
      state: 'complete',
      attachments,
    });
    await flushAttachmentCleanup();

    const persistedRecord = JSON.parse(storage.getString(getChatThreadStorageKey(threadId)) ?? '{}') as {
      thread?: ChatThread;
    };

    expect(useChatStore.getState().getThread(threadId)?.messages[0]?.attachments).toEqual(attachments);
    expect(persistedRecord.thread?.messages[0]?.attachments).toEqual(attachments.slice(0, 4));
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(attachments[4].localUri, expect.anything());
    attachments.slice(0, 4).forEach((attachment) => {
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(attachment.localUri, expect.anything());
    });
  });

  it('prunes inactive threads that fall outside the retention window', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleThread = buildThread('thread-stale', now - 95 * 24 * 60 * 60 * 1000);
    const activeOldThread = buildThread('thread-active', now - 120 * 24 * 60 * 60 * 1000);
    const recentThread = buildThread('thread-recent', now - 10 * 24 * 60 * 60 * 1000);

    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [activeOldThread.id]: activeOldThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: activeOldThread.id,
    });

    const deletedCount = useChatStore.getState().pruneExpiredThreads(90, now);

    expect(deletedCount).toBe(1);
    expect(useChatStore.getState().getThread(staleThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(activeOldThread.id)).toEqual(activeOldThread);
    expect(useChatStore.getState().getThread(recentThread.id)).toEqual(recentThread);
  });

  it('removes expired v2 records during retention cleanup without touching retained threads', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleThread = buildThread('thread-stale-v2', now - 95 * 24 * 60 * 60 * 1000);
    const recentThread = buildThread('thread-recent-v2', now - 10 * 24 * 60 * 60 * 1000);

    writeChatThreadRecord(storage, staleThread, now);
    writeChatThreadRecord(storage, recentThread, now);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: recentThread.id,
      threadIds: [staleThread.id, recentThread.id],
      updatedAt: now,
    });
    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: recentThread.id,
    });

    expect(useChatStore.getState().pruneExpiredThreads(90, now)).toBe(1);

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(recentThread.id))).toContain(recentThread.title);
    expect(index.threadIds).toEqual([recentThread.id]);
    expect(index.revision).toEqual(expect.any(Number));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('cleans attachment files removed by retention pruning', async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleAttachment = buildStoredAttachment('thread-stale-attachment', 'user-1', 'retention-stale.jpg');
    const recentAttachment = buildStoredAttachment('thread-recent-attachment', 'user-1', 'retention-recent.jpg');
    const staleThread: ChatThread = {
      ...buildThread('thread-stale-attachment', now - 95 * 24 * 60 * 60 * 1000),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Expired image prompt',
          createdAt: now - 95 * 24 * 60 * 60 * 1000,
          state: 'complete',
          attachments: [staleAttachment],
        },
      ],
    };
    const recentThread: ChatThread = {
      ...buildThread('thread-recent-attachment', now - 10 * 24 * 60 * 60 * 1000),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Recent image prompt',
          createdAt: now - 10 * 24 * 60 * 60 * 1000,
          state: 'complete',
          attachments: [recentAttachment],
        },
      ],
    };

    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: recentThread.id,
    });

    expect(useChatStore.getState().pruneExpiredThreads(90, now)).toBe(1);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(staleAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(recentAttachment.localUri, expect.anything());
  });

  it('moves activeThreadId to the most recent remaining thread when pruning runs with a missing activeThreadId', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleThread = buildThread('thread-stale', now - 95 * 24 * 60 * 60 * 1000);
    const recentThread = buildThread('thread-recent', now - 10 * 24 * 60 * 60 * 1000);

    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: 'missing-thread',
    });

    const deletedCount = useChatStore.getState().pruneExpiredThreads(90, now);

    expect(deletedCount).toBe(1);
    expect(useChatStore.getState().activeThreadId).toBe(recentThread.id);
  });

  it('selects the most recent imported thread when merging into an empty store', () => {
    const importedA = buildThread('import-a', 10);
    const importedB = buildThread('import-b', 20);

    const importedCount = useChatStore.getState().mergeImportedThreads([importedA, importedB]);

    expect(importedCount).toBe(2);
    expect(useChatStore.getState().activeThreadId).toBe(importedB.id);
  });

  it('rehydrates to the most recent thread when persisted activeThreadId is missing', async () => {
    const older = buildThread('thread-older', 10);
    const newer = buildThread('thread-newer', 20);

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [older.id]: older,
            [newer.id]: newer,
          },
          activeThreadId: 'missing-thread',
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().activeThreadId).toBe(newer.id);
  });

  it('migrates legacy hydrated threads by adding activeModelId and per-message model metadata', async () => {
    const legacyThread: ChatThread = {
      ...buildThread('thread-legacy', 10),
      messages: [
        {
          id: 'legacy-user-1',
          role: 'user',
          content: 'Legacy prompt',
          createdAt: 10,
          state: 'complete',
        },
        {
          id: 'legacy-assistant-1',
          role: 'assistant',
          content: 'Legacy reply',
          createdAt: 11,
          state: 'complete',
        },
      ],
    };

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [legacyThread.id]: legacyThread,
          },
          activeThreadId: legacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const hydrated = useChatStore.getState().getThread(legacyThread.id);

    expect(hydrated?.activeModelId).toBe(legacyThread.modelId);
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({
        id: 'legacy-user-1',
        kind: 'message',
        modelId: legacyThread.modelId,
      }),
      expect.objectContaining({
        id: 'legacy-assistant-1',
        kind: 'message',
        modelId: legacyThread.modelId,
      }),
    ]);
    expect(storage.getString(getChatThreadStorageKey(legacyThread.id))).toContain('Legacy prompt');
    expect(storage.getString('chat-store')).not.toContain('Legacy prompt');
  });

  it('migrates valid legacy threads while isolating invalid legacy records', async () => {
    const validThread = buildThread('thread-valid-legacy', 20);

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [validThread.id]: validThread,
            'thread-invalid-legacy': {
              id: 'thread-invalid-legacy',
              messages: [],
            },
          },
          activeThreadId: 'thread-invalid-legacy',
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().getThread('thread-invalid-legacy')).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(validThread.id);
    expect(storage.getString(getChatThreadStorageKey(validThread.id))).toContain(validThread.title);
    expect(index.threadIds).toEqual([validThread.id]);
    expect(index.corruptThreadIds).toEqual(['thread-invalid-legacy']);
  });

  it('does not let an empty v2 index shadow a valid legacy snapshot during migration', async () => {
    const validThread = buildThread('thread-shadowed-legacy', 30);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 1,
    });
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [validThread.id]: validThread,
          },
          activeThreadId: validThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(storage.getString(getChatThreadStorageKey(validThread.id))).toContain(validThread.title);
  });

  it('treats a cleared v2 tombstone as authoritative over orphan records and stale legacy payloads', async () => {
    const orphanThread = buildThread('thread-cleared-orphan', 35);
    const clearedAt = 40;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });
    writeChatThreadRecord(storage, orphanThread, 39);
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [orphanThread.id]: orphanThread,
          },
          activeThreadId: orphanThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(orphanThread.id)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(index.threadIds).toEqual([]);
    expect(index.clearedAt).toBe(clearedAt);
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(orphanThread.id))).toBeUndefined();
  });

  it('recovers v2 records written after a clear tombstone without resurrecting stale payloads', async () => {
    const staleBeforeClearThread = buildThread('thread-before-clear', 35);
    const equalToClearThread = buildThread('thread-equal-clear', 40);
    const recoveredAfterClearThread = buildThread('thread-after-clear', 45);
    const staleLegacyThread = buildThread('thread-stale-legacy-after-clear', 30);
    const clearedAt = 40;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });
    writeChatThreadRecord(storage, staleBeforeClearThread, clearedAt - 1);
    writeChatThreadRecord(storage, equalToClearThread, clearedAt);
    writeChatThreadRecord(storage, recoveredAfterClearThread, clearedAt + 1);
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [staleLegacyThread.id]: staleLegacyThread,
          },
          activeThreadId: staleLegacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(staleBeforeClearThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(equalToClearThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(staleLegacyThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(recoveredAfterClearThread.id)).toEqual(
      expect.objectContaining({ id: recoveredAfterClearThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(recoveredAfterClearThread.id);
    expect(index.threadIds).toEqual([recoveredAfterClearThread.id]);
    expect(index.activeThreadId).toBe(recoveredAfterClearThread.id);
    expect(index.clearedAt).toBeUndefined();
    expect(storage.getString('chat-store') ?? '').not.toContain(staleLegacyThread.title);
    expect(storage.getString(getChatThreadStorageKey(staleBeforeClearThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(equalToClearThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(recoveredAfterClearThread.id))).toContain(recoveredAfterClearThread.title);
  });

  it('persists post-clear mutations after the tombstone timestamp when they share the same millisecond', async () => {
    const clearedAt = 40;
    const originalDateNow = Date.now;
    let threadId = '';

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });

    Date.now = jest.fn(() => clearedAt);
    try {
      threadId = useChatStore.getState().createThread({
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
      });
    } finally {
      Date.now = originalDateNow;
    }

    const record = JSON.parse(storage.getString(getChatThreadStorageKey(threadId)) ?? '{}') as { persistedAt?: unknown };
    expect(record.persistedAt).toBe(clearedAt + 1);

    // Simulate a crash after the thread record write but before the index rewrite
    // replaced the clear tombstone.
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({ id: threadId }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(threadId);
    expect(index.threadIds).toEqual([threadId]);
    expect(index.clearedAt).toBeUndefined();
  });

  it('does not resurrect same-millisecond records when a later clear crashes before record removal', async () => {
    const firstClearedAt = 40;
    const originalDateNow = Date.now;
    let threadId = '';
    let rawRecord: string | undefined;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: firstClearedAt,
      clearedAt: firstClearedAt,
    });

    Date.now = jest.fn(() => firstClearedAt);
    try {
      threadId = useChatStore.getState().createThread({
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
      });
      rawRecord = storage.getString(getChatThreadStorageKey(threadId));

      expect(useChatStore.getState().clearAllThreads()).toBe(1);
    } finally {
      Date.now = originalDateNow;
    }

    const secondClearIndex = readPersistedChatIndex();
    expect(secondClearIndex.clearedAt).toBe(firstClearedAt + 2);
    expect(rawRecord).toBeTruthy();

    // Simulate a crash after the second clear tombstone was written but before
    // the old thread record was removed.
    storage.set(getChatThreadStorageKey(threadId), rawRecord ?? '');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(threadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(index.threadIds).toEqual([]);
    expect(index.clearedAt).toBe(firstClearedAt + 2);
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
  });

  it('keeps newer corrupt v2 records isolated after a clear tombstone', async () => {
    const staleLegacyThread = buildThread('thread-legacy-behind-corrupt-clear', 30);
    const corruptThreadId = 'thread-corrupt-after-clear';
    const corruptAttachment = buildStoredAttachment(corruptThreadId, 'user-1', 'corrupt-after-clear.jpg');
    const clearedAt = 40;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });
    storage.set(getChatThreadStorageKey(corruptThreadId), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread: {
        id: corruptThreadId,
        messages: [
          {
            id: 'user-1',
            attachments: [corruptAttachment],
          },
        ],
      },
      persistedAt: clearedAt + 1,
    }));
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [staleLegacyThread.id]: staleLegacyThread,
          },
          activeThreadId: staleLegacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(staleLegacyThread.id)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(index.threadIds).toEqual([]);
    expect(index.activeThreadId).toBeNull();
    expect(index.clearedAt).toBeUndefined();
    expect(index.corruptThreadIds).toEqual([corruptThreadId]);
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(corruptThreadId))).toContain(corruptThreadId);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(corruptAttachment.localUri, {
      idempotent: true,
    });
  });

  it('recovers v2 thread records when the v2 index is missing', async () => {
    const recoveredThread = buildThread('thread-indexless-v2', 36);

    writeChatThreadRecord(storage, recoveredThread, 36);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(recoveredThread.id)).toEqual(
      expect.objectContaining({ id: recoveredThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(recoveredThread.id);
    expect(index.threadIds).toEqual([recoveredThread.id]);
    expect(index.clearedAt).toBeUndefined();
  });

  it('recovers v2 thread records when a non-tombstone v2 index is stale', async () => {
    const recoveredThread = buildThread('thread-stale-index-v2', 37);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 1,
    });
    writeChatThreadRecord(storage, recoveredThread, 37);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(recoveredThread.id)).toEqual(
      expect.objectContaining({ id: recoveredThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(recoveredThread.id);
    expect(index.threadIds).toEqual([recoveredThread.id]);
    expect(index.clearedAt).toBeUndefined();
  });

  it('merges legacy-only threads into existing v2 records during partial migration recovery', async () => {
    const v2Thread = {
      ...buildThread('thread-v2-partial', 40),
      title: 'V2 title should win',
    };
    const legacyDuplicate = {
      ...v2Thread,
      title: 'Legacy duplicate should not overwrite v2',
      updatedAt: 10,
    };
    const legacyOnlyThread = buildThread('thread-legacy-only-after-partial', 50);

    writeChatThreadRecord(storage, v2Thread, 40);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: v2Thread.id,
      threadIds: [v2Thread.id],
      updatedAt: 40,
    });
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [legacyDuplicate.id]: legacyDuplicate,
            [legacyOnlyThread.id]: legacyOnlyThread,
          },
          activeThreadId: legacyOnlyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');

    expect(useChatStore.getState().getThread(v2Thread.id)).toEqual(
      expect.objectContaining({
        id: v2Thread.id,
        title: 'V2 title should win',
      }),
    );
    expect(useChatStore.getState().getThread(legacyOnlyThread.id)).toEqual(
      expect.objectContaining({ id: legacyOnlyThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(legacyOnlyThread.id);
    expect(storage.getString(getChatThreadStorageKey(legacyOnlyThread.id))).toContain(legacyOnlyThread.title);
    expect(index.threadIds).toEqual([v2Thread.id, legacyOnlyThread.id]);
    expect(storage.getString('chat-store')).not.toContain(legacyOnlyThread.title);
  });

  it('keeps the v2 active thread when a partial migration has a stale legacy active id', async () => {
    const v2Thread = buildThread('thread-v2-active-after-partial', 40);
    const newerLegacyOnlyThread = buildThread('thread-newer-legacy-only-after-partial', 60);

    writeChatThreadRecord(storage, v2Thread, 40);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: v2Thread.id,
      threadIds: [v2Thread.id],
      updatedAt: 40,
    });
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [newerLegacyOnlyThread.id]: newerLegacyOnlyThread,
          },
          activeThreadId: 'missing-legacy-thread',
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(newerLegacyOnlyThread.id)).toEqual(
      expect.objectContaining({ id: newerLegacyOnlyThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(v2Thread.id);
  });

  it('hydrates valid v2 records when the legacy chat-store value is malformed', async () => {
    const validThread = buildThread('thread-v2-with-broken-legacy-anchor', 60);

    writeChatThreadRecord(storage, validThread, 60);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: validThread.id,
      threadIds: [validThread.id],
      updatedAt: 60,
    });
    storage.set('chat-store', '{broken legacy json');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(validThread.id);
    expect(storage.getString('chat-store')).toBe('{broken legacy json');
  });

  it('hydrates valid v2 records when another v2 record is corrupt', async () => {
    const validThread = buildThread('thread-valid-v2', 20);

    writeChatThreadRecord(storage, validThread, 20);
    storage.set(
      getChatThreadStorageKey('thread-corrupt-v2'),
      JSON.stringify({
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        thread: {
          id: 'thread-corrupt-v2',
        },
        persistedAt: 21,
      }),
    );
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: 'thread-corrupt-v2',
      threadIds: [validThread.id, 'thread-corrupt-v2'],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().getThread('thread-corrupt-v2')).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(validThread.id);
    expect(storage.getString(getChatThreadStorageKey('thread-corrupt-v2'))).toContain('thread-corrupt-v2');
    expect(index.threadIds).toEqual([validThread.id]);
    expect(index.corruptThreadIds).toEqual(['thread-corrupt-v2']);
  });

  it('cleans unreferenced attachment files from corrupt persisted thread recovery', async () => {
    const sharedAttachment = buildStoredAttachment('thread-valid-shared', 'user-1', 'shared-corrupt.jpg');
    const corruptOnlyAttachment = buildStoredAttachment('thread-corrupt-with-image', 'user-1', 'corrupt-only.jpg');
    const validThread: ChatThread = {
      ...buildThread('thread-valid-shared', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Still references shared image',
          createdAt: 20,
          state: 'complete',
          attachments: [sharedAttachment],
        },
      ],
    };

    writeChatThreadRecord(storage, validThread, 20);
    storage.set(
      getChatThreadStorageKey('thread-corrupt-with-image'),
      JSON.stringify({
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        thread: {
          id: 'thread-corrupt-with-image',
          messages: [
            {
              id: 'user-1',
              attachments: [sharedAttachment, corruptOnlyAttachment],
            },
          ],
        },
        persistedAt: 21,
      }),
    );
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: 'thread-corrupt-with-image',
      threadIds: [validThread.id, 'thread-corrupt-with-image'],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().getThread('thread-corrupt-with-image')).toBeNull();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(corruptOnlyAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(sharedAttachment.localUri, expect.anything());
  });

  it('cleans attachment files dropped by hydration sanitization', async () => {
    const validAttachment = buildStoredAttachment('thread-sanitized-attachments', 'user-1', 'kept.jpg');
    const droppedAttachment = {
      ...buildStoredAttachment('thread-sanitized-attachments', 'user-1', 'dropped.txt'),
      mediaType: 'text/plain',
    };
    const thread: ChatThread = {
      ...buildThread('thread-sanitized-attachments', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Hydrate attachments',
          createdAt: 20,
          state: 'complete',
          attachments: [validAttachment, droppedAttachment],
        },
      ],
    };

    storage.set(getChatThreadStorageKey(thread.id), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread,
      persistedAt: 20,
    }));
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 21,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([validAttachment]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(droppedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(validAttachment.localUri, expect.anything());
  });

  it('reconciles the attachment directory on hydration with no referenced attachments', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValue({
        deletedCount: 1,
        attemptedDeleteCount: 1,
        candidateCount: 1,
        hasMoreCandidates: false,
      });

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(Array.from(reconcileSpy.mock.calls[0]?.[0] as Iterable<string>)).toEqual([]);
      expect(reconcileSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        preserveDraftsCreatedAtOrAfter: expect.any(Number),
        maxCandidates: 16,
        maxDeletes: 16,
      }));
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  it('passes referenced attachment uris to hydration directory reconciliation', async () => {
    const referencedAttachment = buildStoredAttachment('thread-reconcile-referenced', 'user-1', 'preserve.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-reconcile-referenced', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Preserve this hydrated attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [referencedAttachment],
        },
      ],
    };
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });

    try {
      writeChatThreadRecord(storage, thread, 20);
      writeChatPersistenceIndex(storage, {
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        activeThreadId: thread.id,
        threadIds: [thread.id],
        updatedAt: 21,
      });

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(new Set(reconcileSpy.mock.calls[0]?.[0] as Iterable<string>)).toEqual(
        new Set([referencedAttachment.localUri]),
      );
      expect(reconcileSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        preserveDraftsCreatedAtOrAfter: expect.any(Number),
        maxCandidates: 16,
        maxDeletes: 16,
      }));
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  it('schedules a later hydration directory reconciliation pass when candidates remain', async () => {
    const referencedAttachment = buildStoredAttachment('thread-reconcile-reschedule', 'user-1', 'keep.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-reconcile-reschedule', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Preserve referenced attachment during rescheduled cleanup',
          createdAt: 20,
          state: 'complete',
          attachments: [referencedAttachment],
        },
      ],
    };
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 16,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      })
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      writeChatThreadRecord(storage, thread, 20);
      writeChatPersistenceIndex(storage, {
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        activeThreadId: thread.id,
        threadIds: [thread.id],
        updatedAt: 21,
      });

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      reconcileSpy.mock.calls.forEach(([referencedLocalUris, options]) => {
        expect(new Set(referencedLocalUris as Iterable<string>)).toEqual(
          new Set([referencedAttachment.localUri]),
        );
        expect(options).toEqual(expect.objectContaining({
          preserveDraftsCreatedAtOrAfter: expect.any(Number),
          maxCandidates: 16,
          maxDeletes: 16,
        }));
      });
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);
    } finally {
      const pendingRetry = callbacks.shift();
      if (pendingRetry) {
        pendingRetry();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('keeps the original draft cutoff across hydration directory reconciliation retries', async () => {
    let now = 100;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    (FileSystem.readDirectoryAsync as jest.Mock)
      .mockResolvedValueOnce(Array.from({ length: 17 }, (_, index) => `orphan-${index}.jpg`))
      .mockResolvedValueOnce(['draft-150-between.jpg']);
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((callback) => {
        now = 200;
        (callback as () => void)();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup(80);

      expect(FileSystem.readDirectoryAsync).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(16);
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
        'test-dir/chat-attachments/draft-150-between.jpg',
        expect.anything(),
      );
    } finally {
      setTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });

  it('retries zero-progress hydration directory reconciliation only within a bounded budget', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      });
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      expect(delays[1]).toBe(2_000);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(3);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      expect(callbacks).toHaveLength(0);
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('retries transient final-batch hydration directory delete failures', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 0,
        attemptedDeleteCount: 2,
        candidateCount: 2,
        hasMoreCandidates: false,
      })
      .mockResolvedValue({
        deletedCount: 2,
        attemptedDeleteCount: 2,
        candidateCount: 2,
        hasMoreCandidates: false,
      });
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('deduplicates hydration directory reconciliation retry timers across repeated rehydrate', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 0,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      })
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });
    const { callbacks, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(callbacks).toHaveLength(1);

      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(callbacks).toHaveLength(1);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('uses current store threads when hydration directory reconciliation retries', async () => {
    const firstAttachment = buildStoredAttachment('thread-reconcile-first', 'user-1', 'first.jpg');
    const secondAttachment = buildStoredAttachment('thread-reconcile-second', 'user-1', 'second.jpg');
    const firstThread: ChatThread = {
      ...buildThread('thread-reconcile-first', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'First referenced attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [firstAttachment],
        },
      ],
    };
    const secondThread: ChatThread = {
      ...buildThread('thread-reconcile-second', 30),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Second referenced attachment',
          createdAt: 30,
          state: 'complete',
          attachments: [secondAttachment],
        },
      ],
    };
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 16,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      })
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });
    const { callbacks, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      writeChatThreadRecord(storage, firstThread, 20);
      writeChatPersistenceIndex(storage, {
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        activeThreadId: firstThread.id,
        threadIds: [firstThread.id],
        updatedAt: 21,
      });

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(new Set(reconcileSpy.mock.calls[0]?.[0] as Iterable<string>)).toEqual(
        new Set([firstAttachment.localUri]),
      );
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      useChatStore.setState({
        threads: { [secondThread.id]: secondThread },
        activeThreadId: secondThread.id,
      });

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
      expect(new Set(reconcileSpy.mock.calls[1]?.[0] as Iterable<string>)).toEqual(
        new Set([secondAttachment.localUri]),
      );
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('does not perform unbounded hydration attachment directory deletion in one scheduled pass', async () => {
    const fileNames = Array.from({ length: 40 }, (_, index) => `orphan-${index}.jpg`);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce(fileNames);
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup(80);

      expect(FileSystem.readDirectoryAsync).toHaveBeenCalledTimes(1);
      expect(FileSystem.readDirectoryAsync).toHaveBeenCalledWith('test-dir/chat-attachments/');
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(16);
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/orphan-15.jpg', {
        idempotent: true,
      });
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/orphan-16.jpg', expect.anything());
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);
    } finally {
      const pendingRetry = callbacks.shift();
      if (pendingRetry) {
        pendingRetry();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
    }
  });

  it('recovers hydrated streaming assistant messages as stopped while preserving partial content', async () => {
    const streamingThread: ChatThread = {
      ...buildThread('thread-streaming-v2', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt before crash',
          createdAt: 20,
          state: 'complete',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Partial answer before crash',
          createdAt: 21,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };

    writeChatThreadRecord(storage, streamingThread, 22);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: streamingThread.id,
      threadIds: [streamingThread.id],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(streamingThread.id)).toEqual(
      expect.objectContaining({
        status: 'stopped',
        messages: [
          expect.objectContaining({
            id: 'user-1',
            state: 'complete',
          }),
          expect.objectContaining({
            id: 'assistant-1',
            content: 'Partial answer before crash',
            state: 'stopped',
          }),
        ],
      }),
    );
  });

  it('reconstructs missing message modelId values using model_switch events during rehydration', async () => {
    const thread: ChatThread = {
      ...buildThread('thread-model-switch-migration', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Before switch',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'switch-1',
          role: 'system',
          kind: 'model_switch',
          content: '',
          createdAt: 2,
          state: 'complete',
          switchFromModelId: 'author/model-q4',
          switchToModelId: 'author/model-q8',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'After switch',
          createdAt: 3,
          state: 'complete',
        },
      ],
    };

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [thread.id]: thread,
          },
          activeThreadId: thread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const hydrated = useChatStore.getState().getThread(thread.id);

    expect(hydrated?.activeModelId).toBe('author/model-q8');
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: 'switch-1',
        kind: 'model_switch',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        id: 'assistant-1',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    ]);
  });

  it('persists and rehydrates a saved thread', async () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Persist this thread',
      createdAt: 1,
      state: 'complete',
    });

    const persistedRecord = storage.getString(getChatThreadStorageKey(threadId));
    const persistedAnchor = storage.getString('chat-store');
    expect(persistedRecord).toContain('Persist this thread');
    expect(persistedAnchor).not.toContain('Persist this thread');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().activeThreadId).toBe(threadId);
    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        id: threadId,
        messages: [
          expect.objectContaining({
            id: 'user-1',
            content: 'Persist this thread',
          }),
        ],
      }),
    );
  });

  it('drops polluted empty streaming placeholders during v2 hydration instead of recovering phantom stopped messages', async () => {
    const pollutedThread: ChatThread = {
      ...buildThread('thread-empty-placeholder-v2', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt before a cold restart',
          createdAt: 20,
          state: 'complete',
        },
        {
          id: 'assistant-empty-1',
          role: 'assistant',
          content: '',
          createdAt: 21,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };

    storage.set(getChatThreadStorageKey(pollutedThread.id), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread: pollutedThread,
      persistedAt: 22,
    }));
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: pollutedThread.id,
      threadIds: [pollutedThread.id],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(pollutedThread.id)).toEqual(
      expect.objectContaining({
        status: 'idle',
        messages: [
          expect.objectContaining({
            id: 'user-1',
            role: 'user',
            content: 'Prompt before a cold restart',
          }),
        ],
      }),
    );

    const recoveredRecord = JSON.parse(
      storage.getString(getChatThreadStorageKey(pollutedThread.id)) ?? '{}',
    ) as { thread: ChatThread };
    expect(recoveredRecord.thread.status).toBe('idle');
    expect(recoveredRecord.thread.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
      }),
    ]);
  });

  it('debounces streaming patches to the active thread without rewriting unrelated records', () => {
    jest.useFakeTimers();
    const activeThread = {
      ...buildThread('thread-active', 20),
      messages: [
        {
          id: 'active-user-1',
          role: 'user' as const,
          content: 'Active prompt',
          createdAt: 20,
          state: 'complete' as const,
        },
        {
          id: 'active-assistant-1',
          role: 'assistant' as const,
          content: '',
          createdAt: 21,
          state: 'streaming' as const,
        },
      ],
      status: 'generating' as const,
    };
    const archivedThread = {
      ...buildThread('thread-archive', 10),
      messages: [
        {
          id: 'archive-user-1',
          role: 'user' as const,
          content: 'Archived prompt that should not be rewritten by active streaming',
          createdAt: 10,
          state: 'complete' as const,
        },
      ],
    };
    const secondArchivedThread = {
      ...buildThread('thread-archive-two', 11),
      messages: [
        {
          id: 'archive-two-user-1',
          role: 'user' as const,
          content: 'Second archived prompt that should also stay untouched',
          createdAt: 11,
          state: 'complete' as const,
        },
      ],
    };

    writeChatThreadRecord(storage, archivedThread, 10);
    writeChatThreadRecord(storage, secondArchivedThread, 11);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: activeThread.id,
      threadIds: [activeThread.id, archivedThread.id, secondArchivedThread.id],
      updatedAt: 10,
    });
    const archivedRecordBefore = storage.getString(getChatThreadStorageKey(archivedThread.id));
    const secondArchivedRecordBefore = storage.getString(getChatThreadStorageKey(secondArchivedThread.id));

    useChatStore.setState({
      threads: {
        [activeThread.id]: activeThread,
        [archivedThread.id]: archivedThread,
        [secondArchivedThread.id]: secondArchivedThread,
      },
      activeThreadId: activeThread.id,
    });

    useChatStore.getState().patchAssistantMessage(activeThread.id, 'active-assistant-1', {
      content: 'Streaming token',
      state: 'streaming',
    });

    expect(storage.getString('chat-store')).not.toContain('Archived prompt that should not be rewritten by active streaming');
    expect(storage.getString('chat-store')).not.toContain('Second archived prompt that should also stay untouched');
    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(archivedThread.id))).toBe(archivedRecordBefore);
    expect(storage.getString(getChatThreadStorageKey(secondArchivedThread.id))).toBe(secondArchivedRecordBefore);

    jest.advanceTimersByTime(749);
    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toBeUndefined();

    flushPendingChatPersistenceWrites('background');
    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toContain('Streaming token');
    expect(storage.getString(getChatThreadStorageKey(archivedThread.id))).toBe(archivedRecordBefore);
    expect(storage.getString(getChatThreadStorageKey(secondArchivedThread.id))).toBe(secondArchivedRecordBefore);

    useChatStore.getState().finalizeAssistantMessage(
      activeThread.id,
      'active-assistant-1',
      'Final answer',
    );

    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toContain('Final answer');
    expect(storage.getString(getChatThreadStorageKey(archivedThread.id))).toBe(archivedRecordBefore);
    expect(storage.getString(getChatThreadStorageKey(secondArchivedThread.id))).toBe(secondArchivedRecordBefore);
    jest.useRealTimers();
  });

  it('does not run attachment cleanup for streaming content patches when references are unchanged', async () => {
    const attachment = buildStoredAttachment('thread-streaming-attachment', 'user-1', 'streaming-kept.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-streaming-attachment', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Describe this image',
          createdAt: 20,
          state: 'complete',
          attachments: [attachment],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          createdAt: 21,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFiles')
      .mockResolvedValue(0);

    try {
      useChatStore.setState({
        threads: { [thread.id]: thread },
        activeThreadId: thread.id,
      });

      useChatStore.getState().patchAssistantMessage(thread.id, 'assistant-1', {
        content: 'Streaming token',
        state: 'streaming',
      });
      await flushAttachmentCleanup();

      expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([attachment]);
      expect(cleanupSpy).not.toHaveBeenCalled();
    } finally {
      cleanupSpy.mockRestore();
    }
  });

  it('persists activeModelId, model switches, and per-message model metadata across rehydration', async () => {
    const legacyThread: ChatThread = buildThread('thread-persist-switches', 10);

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [legacyThread.id]: legacyThread,
          },
          activeThreadId: legacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const migratedBeforeSwitch = useChatStore.getState().getThread(legacyThread.id);
    expect(migratedBeforeSwitch?.activeModelId).toBe('author/model-q4');
    expect(migratedBeforeSwitch?.messages.at(0)).toEqual(
      expect.objectContaining({
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    );

    useChatStore.getState().switchThreadModel(legacyThread.id, 'author/model-q8', 20);
    useChatStore.getState().switchThreadModel(legacyThread.id, 'author/model-q6', 30);
    useChatStore.getState().appendMessage(legacyThread.id, {
      id: 'user-after-switches',
      role: 'user',
      content: 'After switches',
      createdAt: 31,
      state: 'complete',
    });

    const afterSwitches = useChatStore.getState().getThread(legacyThread.id);
    expect(afterSwitches?.activeModelId).toBe('author/model-q6');
    expect(afterSwitches?.messages.filter((message) => message.kind === 'model_switch')).toHaveLength(2);
    expect(afterSwitches?.messages.find((message) => message.id === 'user-after-switches')).toEqual(
      expect.objectContaining({
        kind: 'message',
        modelId: 'author/model-q6',
      }),
    );
    expect(useChatStore.getState().getConversationIndex()[0]).toEqual(
      expect.objectContaining({
        id: legacyThread.id,
        modelId: 'author/model-q6',
        messageCount: 2,
        lastMessagePreview: 'After switches',
      }),
    );

    const persistedRecord = storage.getString(getChatThreadStorageKey(legacyThread.id));
    const persistedAnchor = storage.getString('chat-store');
    expect(persistedRecord).toContain('model_switch');
    expect(persistedRecord).toContain('author/model-q6');
    expect(persistedAnchor).not.toContain('model_switch');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const rehydrated = useChatStore.getState().getThread(legacyThread.id);
    expect(rehydrated?.activeModelId).toBe('author/model-q6');
    expect(rehydrated?.messages.filter((message) => message.kind === 'model_switch')).toHaveLength(2);
    expect(rehydrated?.messages.find((message) => message.id === 'user-after-switches')).toEqual(
      expect.objectContaining({
        kind: 'message',
        modelId: 'author/model-q6',
      }),
    );
    expect(useChatStore.getState().getConversationIndex()[0]).toEqual(
      expect.objectContaining({
        id: legacyThread.id,
        modelId: 'author/model-q6',
        messageCount: 2,
        lastMessagePreview: 'After switches',
      }),
    );
  });

  it('uses the visible assistant answer for conversation previews when thoughts are present', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Explain this',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: '<think>Hidden reasoning</think>\n\nVisible answer',
      createdAt: 2,
      state: 'complete',
    });

    expect(useChatStore.getState().getConversationIndex()[0]?.lastMessagePreview).toBe('Visible answer');
  });

  it('skips pure thought-only assistant messages when building conversation previews', () => {
    const threadId = useChatStore.getState().createThread({
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
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Explain this',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: '<think>Hidden reasoning only</think>',
      createdAt: 2,
      state: 'complete',
    });

    expect(useChatStore.getState().getConversationIndex()[0]?.lastMessagePreview).toBe('Explain this');
  });

  it('strips leading assistant thoughts from the inference window', () => {
    const thread: ChatThread = {
      id: 'thread-thoughts',
      title: 'Thought thread',
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
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 1024,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Explain this',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: '<think>Hidden reasoning</think>\n\nVisible answer',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };

    expect(getThreadInferenceWindow(thread, 24).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Explain this' },
      { role: 'assistant', content: 'Visible answer' },
    ]);
  });

  it('omits pure thought-only assistant turns from the inference window', () => {
    const thread: ChatThread = {
      id: 'thread-thoughts-only',
      title: 'Thought-only thread',
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
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 1024,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Explain this',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: '<think>Hidden reasoning only</think>',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };

    expect(getThreadInferenceWindow(thread, 24).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Explain this' },
    ]);
  });

  it('excludes model_switch system events from the inference window even when they have content', () => {
    const thread: ChatThread = {
      id: 'thread-model-switch-window',
      title: 'Switch thread',
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
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 1024,
        seed: null,
      },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Before',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'switch-1',
          role: 'system',
          kind: 'model_switch',
          content: 'Model switched: q4 -> q8',
          modelId: 'author/model-q8',
          switchFromModelId: 'author/model-q4',
          switchToModelId: 'author/model-q8',
          createdAt: 2,
          state: 'complete',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'After',
          createdAt: 3,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 3,
      status: 'idle',
    };

    expect(getThreadInferenceWindow(thread, 24).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Before' },
      { role: 'assistant', content: 'After' },
    ]);
  });

  it('keeps only the newest coherent turn when the response reserve squeezes prompt history', () => {
    const longMessage = 'A'.repeat(120);
    const thread: ChatThread = {
      id: 'thread-budget',
      title: 'Budget thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 70,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: `${longMessage}-1`,
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: `${longMessage}-2`,
          createdAt: 2,
          state: 'complete',
        },
        {
          id: 'message-3',
          role: 'user',
          content: `${longMessage}-3`,
          createdAt: 3,
          state: 'complete',
        },
        {
          id: 'message-4',
          role: 'assistant',
          content: `${longMessage}-4`,
          createdAt: 4,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 4,
      status: 'idle',
    };

    const { messages, truncatedMessageIds } = getThreadInferenceWindow(thread, {
      maxContextMessages: 24,
      maxContextTokens: 150,
      responseReserveTokens: 70,
      promptSafetyMarginTokens: 24,
    });

    expect(messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: `${longMessage}-3` },
      { role: 'assistant', content: `${longMessage}-4` },
    ]);
    expect(truncatedMessageIds).toEqual(['message-1', 'message-2']);
  });

  it('does not drop the last assistant message when the leading user message cannot fit the prompt budget', () => {
    const longUserMessage = 'A'.repeat(220);
    const thread: ChatThread = {
      id: 'thread-assistant-only-budget',
      title: 'Assistant-only budget thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 70,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: longUserMessage,
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: 'ok',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };

    const { messages, truncatedMessageIds } = getThreadInferenceWindow(thread, {
      maxContextMessages: 24,
      maxContextTokens: 19,
      responseReserveTokens: 0,
      promptSafetyMarginTokens: 0,
    });

    expect(messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(truncatedMessageIds).toEqual(['message-1']);
  });

  it('does not let a large response reserve evict short history from a roomy context window', () => {
    const thread: ChatThread = {
      id: 'thread-balanced-reserve',
      title: 'Balanced reserve thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 2048,
        seed: null,
      },
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `m${index + 1}`,
        createdAt: index + 1,
        state: 'complete' as const,
      })),
      createdAt: 1,
      updatedAt: 12,
      status: 'idle',
    };

    const { messages, truncatedMessageIds } = getThreadInferenceWindow(thread, {
      maxContextMessages: 24,
      maxContextTokens: 2048,
      responseReserveTokens: 2048,
    });

    expect(messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 'm4' },
      { role: 'user', content: 'm5' },
      { role: 'assistant', content: 'm6' },
      { role: 'user', content: 'm7' },
      { role: 'assistant', content: 'm8' },
      { role: 'user', content: 'm9' },
      { role: 'assistant', content: 'm10' },
      { role: 'user', content: 'm11' },
      { role: 'assistant', content: 'm12' },
    ]);
    expect(truncatedMessageIds).toEqual([]);
  });
});

