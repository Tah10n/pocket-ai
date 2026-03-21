import { ChatThread } from '../../src/types/chat';
import { useChatStore } from '../../src/store/chatStore';

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
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
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
      },
    });

    useChatStore.getState().deleteThread(secondThreadId);

    expect(useChatStore.getState().getThread(secondThreadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(firstThreadId);
  });

  it('captures preset and params snapshots immutably at thread creation', () => {
    const paramsSnapshot = {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
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
        paramsSnapshot: {
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 1024,
        },
        presetSnapshot: {
          id: 'preset-1',
          name: 'Helpful Assistant',
          systemPrompt: 'Be concise.',
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
});
