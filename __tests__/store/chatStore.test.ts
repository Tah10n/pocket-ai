import { ChatThread } from '../../src/types/chat';
import { findMostRecentThreadId, getThreadInferenceWindow, useChatStore } from '../../src/store/chatStore';
import { storage } from '../../src/store/storage';

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

describe('chatStore', () => {
  beforeEach(() => {
    useChatStore.setState({ threads: {}, activeThreadId: null });
    storage.remove('chat-store');
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

  it('removes persisted chat-store when deleting the last thread', () => {
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

    expect(storage.getString('chat-store')).toBeTruthy();

    useChatStore.getState().deleteThread(threadId);

    expect(useChatStore.getState().getThread(threadId)).toBeNull();
    expect(storage.getString('chat-store')).toBeUndefined();
  });

  it('removes persisted chat-store when clearing all threads', () => {
    useChatStore.getState().createThread({
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

    expect(storage.getString('chat-store')).toBeTruthy();
    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    expect(storage.getString('chat-store')).toBeUndefined();
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

    const persistedSnapshot = storage.getString('chat-store');
    expect(persistedSnapshot).toContain('Persist this thread');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    storage.set('chat-store', persistedSnapshot ?? '');
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

