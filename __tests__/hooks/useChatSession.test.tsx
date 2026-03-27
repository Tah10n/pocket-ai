import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { useChatSession } from '../../src/hooks/useChatSession';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { getGenerationParametersForModel, getSettings } from '../../src/services/SettingsStore';
import { EngineStatus } from '../../src/types/models';
import { useChatStore } from '../../src/store/chatStore';
import { AppState } from 'react-native';
import {
  buildInferenceMessagesForThread,
  getThreadTruncationState,
  MAX_CONTEXT_MESSAGES,
  resetSharedGenerationStateForTests,
  resolvePresetSnapshot,
  SUMMARY_PLACEHOLDER_CONTENT,
} from '../../src/hooks/useChatSession';
import { presetManager } from '../../src/services/PresetManager';

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    getState: jest.fn(),
    getContextSize: jest.fn(),
    chatCompletion: jest.fn(),
    stopCompletion: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: jest.fn(),
  getGenerationParametersForModel: jest.fn(),
}));

jest.mock('../../src/services/PresetManager', () => ({
  presetManager: {
    getPreset: jest.fn().mockReturnValue({
      id: 'preset-1',
      name: 'Helpful Assistant',
      systemPrompt: 'Be concise.',
    }),
  },
}));

describe('useChatSession', () => {
  let appStateListeners: Array<(state: 'active' | 'background' | 'inactive') => void>;

  function renderHookHarness() {
    let session: ReturnType<typeof useChatSession> | null = null;

    const Harness = () => {
      const value = useChatSession();
      useEffect(() => {
        session = value;
      }, [value]);
      return null;
    };

    render(<Harness />);
    return () => session;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useChatStore.setState({ threads: {}, activeThreadId: null });
    resetSharedGenerationStateForTests();
    appStateListeners = [];
    (presetManager.getPreset as jest.Mock).mockReset();
    (presetManager.getPreset as jest.Mock).mockReturnValue({
      id: 'preset-1',
      name: 'Helpful Assistant',
      systemPrompt: 'Be concise.',
    });
    (getSettings as jest.Mock).mockReturnValue({
      activeModelId: 'author/model-q4',
      activePresetId: 'preset-1',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
    });
    (getGenerationParametersForModel as jest.Mock).mockImplementation((modelId: string | null | undefined) => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: modelId ? 1024 : 2048,
      reasoningEnabled: false,
    }));
    (llmEngineService.getState as jest.Mock).mockReturnValue({
      status: EngineStatus.READY,
    });
    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(2048);
    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Hello back');
        return { text: 'Hello back' };
      },
    );
    (llmEngineService.stopCompletion as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type: any, listener: any) => {
      if (type === 'change') {
        appStateListeners.push(listener);
      }

      return {
        remove: jest.fn(),
      } as any;
    });
  });

  function emitAppState(state: 'active' | 'background' | 'inactive') {
    appStateListeners.forEach((listener) => {
      listener(state);
    });
  }

  it('creates and persists a thread-backed conversation', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Hello there');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getConversationIndex()).toHaveLength(1);
    });

    const thread = useChatStore.getState().getActiveThread();
    expect(thread?.modelId).toBe('author/model-q4');
    expect(thread?.presetId).toBe('preset-1');
    expect(thread?.presetSnapshot).toEqual({
      id: 'preset-1',
      name: 'Helpful Assistant',
      systemPrompt: 'Be concise.',
    });
    expect(thread?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(thread?.messages.at(-1)?.content).toBe('Hello back');
  });

  it('stores reasoning separately from the final assistant content when the engine exposes it', async () => {
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: any) => void }) => {
        onToken?.({
          token: 'reason-1',
          reasoningContent: 'Thinking through the answer',
        });
        onToken?.({
          token: 'answer-1',
          content: 'Visible answer',
          reasoningContent: 'Thinking through the answer',
        });

        return {
          text: '<think>Thinking through the answer</think>Visible answer',
          content: 'Visible answer',
          reasoning_content: 'Thinking through the answer',
        };
      },
    );

    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Explain this');
    });

    const assistantMessage = useChatStore.getState().getActiveThread()?.messages.at(-1);

    expect(assistantMessage).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Visible answer',
        thoughtContent: 'Thinking through the answer',
        state: 'complete',
      }),
    );
  });

  it('does not force reasoning flags when the model profile leaves reasoning disabled', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Hello there');
    });

    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          enable_thinking: false,
          reasoning_format: 'none',
        }),
      }),
    );
  });

  it('enables reasoning flags when the model profile opts in', async () => {
    (getGenerationParametersForModel as jest.Mock).mockImplementation((modelId: string | null | undefined) => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: modelId ? 1024 : 2048,
      reasoningEnabled: true,
    }));
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Explain this with reasoning');
    });

    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          enable_thinking: true,
          reasoning_format: 'auto',
        }),
      }),
    );
  });

  it('stops generation and preserves the partial assistant response', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Stopped' });
        }),
    );

    const getSession = renderHookHarness();

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Long answer please');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
    });

    await act(async () => {
      onToken?.('Partial answer');
    });

    await act(async () => {
      await getSession()?.stopGeneration();
      resolveCompletion?.();
      await sendPromise;
    });

    const thread = useChatStore.getState().getActiveThread();
    expect(llmEngineService.stopCompletion).toHaveBeenCalled();
    expect(thread?.status).toBe('stopped');
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Partial answer',
        state: 'stopped',
      }),
    );
  });

  it('regenerates the last assistant response in-place', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Hello there');
    });

    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Fresh reply');
        return { text: 'Fresh reply' };
      },
    );

    await act(async () => {
      await getSession()?.regenerateLastResponse();
    });

    const thread = useChatStore.getState().getActiveThread();
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Fresh reply',
        state: 'complete',
        regeneratesMessageId: expect.any(String),
      }),
    );
  });

  it('regenerates from a selected user message after editing it', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Original prompt');
    });

    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Edited branch reply');
        return { text: 'Edited branch reply' };
      },
    );

    await act(async () => {
      await getSession()?.regenerateFromUserMessage(
        useChatStore.getState().getActiveThread()?.messages[0].id ?? '',
        'Edited prompt',
      );
    });

    const thread = useChatStore.getState().getActiveThread();
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[0]).toEqual(
      expect.objectContaining({
        role: 'user',
        content: 'Edited prompt',
      }),
    );
    expect(thread?.messages[1]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Edited branch reply',
        state: 'complete',
      }),
    );
    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Edited prompt' },
        ],
      }),
    );
  });

  it('keeps backgrounded generation alive until completion resolves', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Finished in background' });
        }),
    );

    const getSession = renderHookHarness();

    await act(async () => {
      void getSession()?.appendUserMessage('Continue while backgrounded');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
    });

    await act(async () => {
      emitAppState('background');
      onToken?.('Finished in background');
      resolveCompletion?.();
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('idle');
    });

    expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Finished in background',
        state: 'complete',
      }),
    );
  });

  it('marks orphaned generating state as stopped when returning to foreground', async () => {
    renderHookHarness();

    await act(async () => {
      useChatStore.setState({
        threads: {
          'thread-1': {
            id: 'thread-1',
            title: 'Recovered thread',
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
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'Partial reply',
                createdAt: 1,
                state: 'stopped',
              },
            ],
            createdAt: 1,
            updatedAt: 1,
            status: 'generating',
          },
        },
        activeThreadId: 'thread-1',
      });
    });

    await act(async () => {
      emitAppState('background');
      emitAppState('active');
    });

    expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
  });

  it('does not stop a live generation when another hook instance returns to foreground', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Completed normally' });
        }),
    );

    const getPrimarySession = renderHookHarness();
    renderHookHarness();

    await act(async () => {
      void getPrimarySession()?.appendUserMessage('Keep streaming');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
    });

    await act(async () => {
      emitAppState('background');
      emitAppState('active');
    });

    expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');

    await act(async () => {
      onToken?.('Completed normally');
      resolveCompletion?.();
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('idle');
    });
  });

  it('builds inference context from frozen preset snapshot, history, and params', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('First prompt');
    });

    (getSettings as jest.Mock).mockReturnValue({
      activeModelId: 'author/model-q4',
      activePresetId: 'preset-2',
      temperature: 1.4,
      topP: 0.4,
      maxTokens: 256,
    });
    (presetManager.getPreset as jest.Mock).mockReturnValueOnce({
      id: 'preset-2',
      name: 'Changed Preset',
      systemPrompt: 'Use a different tone.',
    });

    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Frozen reply');
        return { text: 'Frozen reply' };
      },
    );

    await act(async () => {
      await getSession()?.regenerateLastResponse();
    });

    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'First prompt' },
        ]),
        params: expect.objectContaining({
          temperature: 0.7,
          top_p: 0.9,
          n_predict: 1024,
        }),
      }),
    );
  });

  it('caps n_predict to the remaining estimated context budget', async () => {
    const getSession = renderHookHarness();
    const longPrompt = 'A'.repeat(120);

    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(150);
    (getGenerationParametersForModel as jest.Mock).mockImplementation(() => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 70,
    }));

    await act(async () => {
      await getSession()?.appendUserMessage(longPrompt);
    });

    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          n_predict: 41,
        }),
      }),
    );
  });

  it('starts a new thread when another model is currently loaded', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('First prompt');
    });

    const originalThread = useChatStore.getState().getActiveThread();

    (getSettings as jest.Mock).mockReturnValue({
      activeModelId: 'author/model-q8',
      activePresetId: 'preset-1',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
    });

    await act(async () => {
      await getSession()?.appendUserMessage('Use a different model now');
    });

    const state = useChatStore.getState();
    const activeThread = state.getActiveThread();

    expect(activeThread?.id).not.toBe(originalThread?.id);
    expect(activeThread?.modelId).toBe('author/model-q8');
    expect(activeThread?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(originalThread?.modelId).toBe('author/model-q4');
    expect(state.getConversationIndex()).toHaveLength(2);
  });

  it('blocks regenerating a thread when another model is currently loaded', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('First prompt');
    });

    (getSettings as jest.Mock).mockReturnValue({
      activeModelId: 'author/model-q8',
      activePresetId: 'preset-1',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
    });

    await expect(getSession()?.regenerateLastResponse()).rejects.toThrow(
      'This conversation is pinned to author/model-q4. Load that model before regenerating this response.',
    );
  });

  it('switches to another saved thread when opening a conversation explicitly', async () => {
    const threadOneId = useChatStore.getState().createThread({
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
    const threadTwoId = useChatStore.getState().createThread({
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

    useChatStore.getState().appendMessage(threadOneId, {
      id: 'user-1',
      role: 'user',
      content: 'First thread',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadTwoId, {
      id: 'user-2',
      role: 'user',
      content: 'Second thread',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().setActiveThread(threadOneId);

    const getSession = renderHookHarness();

    await act(async () => {
      getSession()?.openThread(threadTwoId);
    });

    expect(useChatStore.getState().activeThreadId).toBe(threadTwoId);
  });

  it('blocks deleting a live generating thread from another hook instance', async () => {
    let resolveCompletion: (() => void) | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCompletion = () => resolve({ text: 'Stopped elsewhere' });
        }),
    );

    const getPrimarySession = renderHookHarness();
    const getSecondarySession = renderHookHarness();

    await act(async () => {
      void getPrimarySession()?.appendUserMessage('Please stream');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
    });

    const threadId = useChatStore.getState().activeThreadId;
    expect(() => getSecondarySession()?.deleteThread(threadId ?? '')).toThrow(
      'Stop the current response before deleting this conversation.',
    );
    expect(threadId ? useChatStore.getState().getThread(threadId) : null).not.toBeNull();

    await act(async () => {
      await getSecondarySession()?.stopGeneration();
      resolveCompletion?.();
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
    });
  });

  it('exposes prompt builder helpers for preset resolution and context assembly', () => {
    (presetManager.getPreset as jest.Mock).mockReset();
    (presetManager.getPreset as jest.Mock).mockReturnValue({
      id: 'preset-1',
      name: 'Helpful Assistant',
      systemPrompt: 'Be concise.',
    });

    const snapshot = resolvePresetSnapshot('preset-1');

    expect(snapshot).toEqual({
      id: 'preset-1',
      name: 'Helpful Assistant',
      systemPrompt: 'Be concise.',
    });

    const messages = buildInferenceMessagesForThread({
      id: 'thread-1',
      title: 'Example',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: snapshot,
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
      },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Hello',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Hi',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    });

    expect(messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('truncates older history deterministically and exposes summarize affordance state', () => {
    const snapshot = resolvePresetSnapshot('preset-1');
    const thread = {
      id: 'thread-1',
      title: 'Long thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: snapshot,
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
      },
      messages: Array.from({ length: MAX_CONTEXT_MESSAGES + 4 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `Message ${index + 1}`,
        createdAt: index + 1,
        state: 'complete' as const,
      })),
      createdAt: 1,
      updatedAt: 2,
      status: 'idle' as const,
    };

    const messages = buildInferenceMessagesForThread(thread);
    const truncationState = getThreadTruncationState(thread);

    expect(messages).toHaveLength(MAX_CONTEXT_MESSAGES - 1);
    expect(messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Message 7' });
    expect(truncationState).toEqual({
      truncatedMessageIds: ['message-1', 'message-2', 'message-3', 'message-4', 'message-5', 'message-6'],
      shouldOfferSummary: true,
    });
  });

  it('shrinks the inference window further when the token budget is tight', () => {
    const snapshot = resolvePresetSnapshot('preset-1');
    const longMessage = 'A'.repeat(240);
    const thread = {
      id: 'thread-budget',
      title: 'Token budget thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: snapshot,
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 96,
      },
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `${longMessage}-${index + 1}`,
        createdAt: index + 1,
        state: 'complete' as const,
      })),
      createdAt: 1,
      updatedAt: 2,
      status: 'idle' as const,
    };

    const messages = buildInferenceMessagesForThread(thread, {
      maxContextTokens: 200,
      responseReserveTokens: 96,
    });

    expect(messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'user', content: `${longMessage}-7` });
  });

  it('creates a persisted summary placeholder when truncation is active', async () => {
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

    for (let index = 0; index < MAX_CONTEXT_MESSAGES + 4; index += 1) {
      useChatStore.getState().appendMessage(threadId, {
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index + 1}`,
        createdAt: index + 1,
        state: 'complete',
      });
    }

    useChatStore.getState().setActiveThread(threadId);
    const getSession = renderHookHarness();

    let created = false;
    await act(async () => {
      created = getSession()?.createSummaryPlaceholder() ?? false;
    });

    expect(created).toBe(true);
    const activeThread = useChatStore.getState().getActiveThread();
    expect(activeThread?.summary).toEqual(
      expect.objectContaining({
        content: SUMMARY_PLACEHOLDER_CONTENT,
        sourceMessageIds: ['message-1', 'message-2', 'message-3', 'message-4', 'message-5', 'message-6'],
        isPlaceholder: true,
      }),
    );
    expect(buildInferenceMessagesForThread(activeThread!)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining(SUMMARY_PLACEHOLDER_CONTENT),
        }),
      ]),
    );
  });
});





