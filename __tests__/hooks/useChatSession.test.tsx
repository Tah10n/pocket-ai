import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { useChatSession } from '../../src/hooks/useChatSession';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { getGenerationParametersForModel, getSettings } from '../../src/services/SettingsStore';
import { EngineStatus, LifecycleStatus, ModelAccessState } from '../../src/types/models';
import { estimateLlmMessagesTokens, flushPendingChatPersistenceWrites, useChatStore } from '../../src/store/chatStore';
import { AppState } from 'react-native';
import { getAppStorage, storage } from '../../src/store/storage';
import { getChatThreadStorageKey } from '../../src/store/chatPersistence';
import {
  buildInferenceMessagesForThread,
  getThreadTruncationState,
  LONG_STREAM_PATCH_INTERVAL_MS,
  resetSharedGenerationStateForTests,
  resolveAssistantStreamPatchInterval,
  resolvePresetSnapshot,
  shouldFlushAssistantStreamPatchOnBoundary,
  stopActiveChatGenerationForPrivateStorageBlocked,
} from '../../src/hooks/useChatSession';
import { presetManager } from '../../src/services/PresetManager';
import { backgroundTaskService } from '../../src/services/BackgroundTaskService';
import { notificationService } from '../../src/services/NotificationService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { PrivateStorageUnavailableError, getPrivateStorageHealthSnapshot, isPrivateStorageWritable } from '../../src/services/storage';

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    ensurePersistedCapabilitySnapshot: jest.fn().mockReturnValue(null),
    getState: jest.fn(),
    getContextSize: jest.fn(),
    chatCompletion: jest.fn(),
    countPromptTokens: jest.fn(),
    stopCompletion: jest.fn(),
    interruptActiveCompletion: jest.fn(),
    hasActiveCompletion: jest.fn(),
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

jest.mock('../../src/services/storage', () => {
  const actual = jest.requireActual('../../src/services/storage');
  const stores = new Map<string, Map<string, string>>();
  const getStore = (id?: string) => {
    const key = id ?? '__default__';
    const existing = stores.get(key);
    if (existing) {
      return existing;
    }

    const created = new Map<string, string>();
    stores.set(key, created);
    return created;
  };

  return {
    ...actual,
    createStorage: jest.fn((id?: string) => {
      const store = getStore(id);
      return {
        set: jest.fn((key: string, value: string | number | boolean) => {
          store.set(key, String(value));
        }),
        getString: jest.fn((key: string) => store.get(key)),
        getNumber: jest.fn((key: string) => {
          const raw = store.get(key);
          if (raw === undefined) {
            return undefined;
          }

          const parsed = Number(raw);
          return Number.isFinite(parsed) ? parsed : undefined;
        }),
        getBoolean: jest.fn((key: string) => {
          const raw = store.get(key);
          if (raw === 'true') {
            return true;
          }
          if (raw === 'false') {
            return false;
          }
          return undefined;
        }),
        remove: jest.fn((key: string) => {
          store.delete(key);
        }),
        clearAll: jest.fn(() => {
          store.clear();
        }),
        contains: jest.fn((key: string) => store.has(key)),
        getAllKeys: jest.fn(() => Array.from(store.keys())),
      };
    }),
    getPrivateStorageHealthSnapshot: jest.fn(() => ({
      status: 'ready',
      retryable: false,
      requiresExplicitReset: false,
      lastUpdatedAt: 0,
    })),
    isPrivateStorageWritable: jest.fn(() => true),
  };
});

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

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
    });
    await backgroundTaskService.stopBackgroundTask();
    flushPendingChatPersistenceWrites('background');
    useChatStore.setState({ threads: {}, activeThreadId: null });
    storage.getAllKeys().forEach((key) => storage.remove(key));
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
      maxTokens: modelId ? 1024 : 512,
      reasoningEffort: 'auto',
    }));
    (isPrivateStorageWritable as jest.Mock).mockReturnValue(true);
    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue({
      status: 'ready',
      retryable: false,
      requiresExplicitReset: false,
      lastUpdatedAt: 0,
    });
    registry.saveModels([]);
    (llmEngineService.getState as jest.Mock).mockReturnValue({
      status: EngineStatus.READY,
      activeModelId: 'author/model-q4',
    });
    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(2048);
    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Hello back');
        return { text: 'Hello back' };
      },
    );
    (llmEngineService.countPromptTokens as jest.Mock).mockImplementation(
      async ({ messages }: { messages: any[] }) => estimateLlmMessagesTokens(messages as any),
    );
    (llmEngineService.stopCompletion as jest.Mock).mockResolvedValue(undefined);
    (llmEngineService.interruptActiveCompletion as jest.Mock).mockImplementation(
      async () => (llmEngineService.stopCompletion as jest.Mock)(),
    );
    (llmEngineService.hasActiveCompletion as jest.Mock).mockReturnValue(false);
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

  function readPersistedThreadRecord(threadId: string | null | undefined) {
    expect(threadId).toBeTruthy();
    const rawRecord = storage.getString(getChatThreadStorageKey(threadId ?? ''));
    expect(rawRecord).toBeTruthy();

    return JSON.parse(rawRecord ?? '{}') as {
      thread?: {
        status?: string;
        messages?: Array<Record<string, unknown>>;
      };
    };
  }

  it('resolves adaptive stream patch cadence for short and long rendered buffers', () => {
    expect(resolveAssistantStreamPatchInterval({
      tokensCount: 1,
      visibleCharCount: 12,
      thoughtCharCount: 0,
    })).toBeLessThan(resolveAssistantStreamPatchInterval({
      tokensCount: 20,
      visibleCharCount: 320,
      thoughtCharCount: 0,
    }));
    expect(resolveAssistantStreamPatchInterval({
      tokensCount: 80,
      visibleCharCount: 300,
      thoughtCharCount: 950,
    })).toBe(LONG_STREAM_PATCH_INTERVAL_MS);
    expect(shouldFlushAssistantStreamPatchOnBoundary('Rendered markdown sentence.')).toBe(true);
    expect(shouldFlushAssistantStreamPatchOnBoundary('Rendered markdown fragment')).toBe(false);
  });

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

  it('persists errored generation terminal state into bounded storage', async () => {
    const generationError = new Error('native generation failed');
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Partial before failure');
        throw generationError;
      },
    );

    const getSession = renderHookHarness();
    let thrown: unknown;

    await act(async () => {
      try {
        await getSession()?.appendUserMessage('Please fail durably');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBe(generationError);

    const thread = useChatStore.getState().getActiveThread();
    expect(thread).toEqual(expect.objectContaining({ status: 'error' }));
    expect(thread?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Partial before failure',
      state: 'error',
      errorCode: 'generation_failed',
      errorMessage: 'native generation failed',
    }));

    const record = readPersistedThreadRecord(thread?.id);
    const persistedAssistant = record.thread?.messages?.at(-1);
    expect(record.thread?.status).toBe('error');
    expect(persistedAssistant).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Partial before failure',
      state: 'error',
      errorCode: 'generation_failed',
      errorMessage: 'native generation failed',
    }));
    expect(record.thread?.messages?.some((message) => message.state === 'streaming')).toBe(false);
    expect(storage.getString('chat-store') ?? '').not.toContain('Partial before failure');
  });

  it('blocks sending before persisted chat mutations when private storage is unavailable', async () => {
    const blockedHealth = {
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: false,
      messageKey: 'storage.private.encryptedOpenFailed',
      lastUpdatedAt: 123,
    };
    (isPrivateStorageWritable as jest.Mock).mockReturnValue(false);
    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(blockedHealth);

    const chatState = useChatStore.getState();
    const createThreadSpy = jest.spyOn(chatState, 'createThread');
    const appendMessageSpy = jest.spyOn(chatState, 'appendMessage');
    const createAssistantPlaceholderSpy = jest.spyOn(chatState, 'createAssistantPlaceholder');
    const setActiveThreadSpy = jest.spyOn(chatState, 'setActiveThread');
    const getSession = renderHookHarness();
    let thrown: unknown;

    try {
      await act(async () => {
        try {
          await getSession()?.appendUserMessage('Hello there');
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(
        expect.objectContaining({
          name: 'AppError',
          code: 'storage_private_unavailable',
          details: {
            privateStorageHealth: blockedHealth,
          },
        }),
      );
      expect(getSettings).not.toHaveBeenCalled();
      expect(createThreadSpy).not.toHaveBeenCalled();
      expect(appendMessageSpy).not.toHaveBeenCalled();
      expect(createAssistantPlaceholderSpy).not.toHaveBeenCalled();
      expect(setActiveThreadSpy).not.toHaveBeenCalled();
      expect(llmEngineService.chatCompletion).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationIndex()).toHaveLength(0);
    } finally {
      createThreadSpy.mockRestore();
      appendMessageSpy.mockRestore();
      createAssistantPlaceholderSpy.mockRestore();
      setActiveThreadSpy.mockRestore();
    }
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

  it('keeps raw think tags out of the visible answer when accumulatedText still includes reasoning', async () => {
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: any) => void }) => {
        onToken?.({
          token: 'reason-1',
          reasoningContent: 'Thinking through the answer',
          accumulatedText: '<think>Thinking through the answer',
        });
        onToken?.({
          token: 'answer-1',
          reasoningContent: 'Thinking through the answer',
          accumulatedText: '<think>Thinking through the answer</think>Visible answer',
        });

        return {
          text: '<think>Thinking through the answer</think>Visible answer',
          content: '',
          reasoning_content: 'Thinking through the answer',
        };
      },
    );
    (getGenerationParametersForModel as jest.Mock).mockImplementation((modelId: string | null | undefined) => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: modelId ? 1024 : 512,
      reasoningEffort: 'medium',
    }));
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'ReD-Qwen3-4B-Thinking-Search-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        downloadUrl: 'https://example.com/author/model-q4.gguf',
        localPath: 'author-model-q4.gguf',
        fitsInRam: true,
        accessState: ModelAccessState.PUBLIC,
        isGated: false,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        modelType: 'qwen3',
        tags: ['gguf', 'thinking'],
      },
    ]);

    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Explain this');
    });

    expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Visible answer',
        thoughtContent: 'Thinking through the answer',
      }),
    );
  });

  it('keeps raw [THINK] blocks out of the visible answer when accumulatedText still includes reasoning', async () => {
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: any) => void }) => {
        onToken?.({
          token: 'reason-1',
          reasoningContent: 'Thinking through the answer',
          accumulatedText: '[THINK]Thinking through the answer',
        });
        onToken?.({
          token: 'answer-1',
          reasoningContent: 'Thinking through the answer',
          accumulatedText: '[THINK]Thinking through the answer[/THINK]Visible answer',
        });

        return {
          text: '[THINK]Thinking through the answer[/THINK]Visible answer',
          content: '',
          reasoning_content: 'Thinking through the answer',
        };
      },
    );
    (getGenerationParametersForModel as jest.Mock).mockImplementation((modelId: string | null | undefined) => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: modelId ? 1024 : 512,
      reasoningEffort: 'medium',
    }));
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Ministral-3-14B-Reasoning-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        downloadUrl: 'https://example.com/author/model-q4.gguf',
        localPath: 'author-model-q4.gguf',
        fitsInRam: true,
        accessState: ModelAccessState.PUBLIC,
        isGated: false,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        modelType: 'mistral',
        tags: ['gguf', 'reasoning'],
      },
    ]);

    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Explain this');
    });

    expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Visible answer',
        thoughtContent: 'Thinking through the answer',
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
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Qwen3-4B-Instruct-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        downloadUrl: 'https://example.com/author/model-q4.gguf',
        localPath: 'author-model-q4.gguf',
        fitsInRam: true,
        accessState: ModelAccessState.PUBLIC,
        isGated: false,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        modelType: 'qwen3',
        tags: ['gguf', 'chat'],
      },
    ]);
    (getGenerationParametersForModel as jest.Mock).mockImplementation((modelId: string | null | undefined) => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: modelId ? 1024 : 512,
      reasoningEffort: 'medium',
    }));
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Explain this with reasoning');
    });

    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          enable_thinking: true,
          thinking_budget_tokens: 384,
          reasoning_format: 'auto',
        }),
      }),
    );
  });

  it('disables thinking when the context window cannot fit additional thinking budget tokens', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Qwen3-4B-Instruct-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        downloadUrl: 'https://example.com/author/model-q4.gguf',
        localPath: 'author-model-q4.gguf',
        fitsInRam: true,
        accessState: ModelAccessState.PUBLIC,
        isGated: false,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        modelType: 'qwen3',
        tags: ['gguf', 'chat'],
      },
    ]);
    (getGenerationParametersForModel as jest.Mock).mockImplementation((modelId: string | null | undefined) => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: modelId ? 1024 : 512,
      reasoningEffort: 'medium',
    }));
    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(128);

    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Explain this with reasoning');
    });

    const call = (llmEngineService.chatCompletion as jest.Mock).mock.calls.at(-1)?.[0];
    expect(call?.params.enable_thinking).toBe(false);
    expect(call?.params.reasoning_format).toBe('none');
    expect(call?.params.thinking_budget_tokens).toBeUndefined();
  });

  it('accumulates streamed reasoning deltas when reasoning_content is not returned', async () => {
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: any) => void }) => {
        onToken?.({
          token: 'reason-1',
          reasoningContent: 'Think ',
        });
        onToken?.({
          token: 'reason-2',
          reasoningContent: 'through',
        });
        onToken?.({
          token: 'answer-1',
          content: 'Visible answer',
        });

        return {
          text: '<think>Think through</think>Visible answer',
          content: 'Visible answer',
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
        thoughtContent: 'Think through',
        state: 'complete',
      }),
    );
  });

  it('does not enable reasoning flags for models without reasoning support', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'gemma-2-2b-it-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        downloadUrl: 'https://example.com/author/model-q4.gguf',
        localPath: 'author-model-q4.gguf',
        fitsInRam: true,
        accessState: ModelAccessState.PUBLIC,
        isGated: false,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        modelType: 'gemma2',
        tags: ['gguf', 'chat'],
      },
    ]);
    (getGenerationParametersForModel as jest.Mock).mockImplementation((modelId: string | null | undefined) => ({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: modelId ? 1024 : 512,
      reasoningEffort: 'medium',
    }));
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Explain this with reasoning');
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
      onToken?.(' late token');
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

    const persistedRecord = readPersistedThreadRecord(thread?.id);
    const persistedAssistant = persistedRecord.thread?.messages?.at(-1);
    expect(persistedRecord.thread?.status).toBe('stopped');
    expect(persistedAssistant).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Partial answer',
      state: 'stopped',
    }));
    expect(persistedAssistant?.content).not.toContain('late token');
  });

  it('stops active generation when private storage becomes blocked', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Stopped by storage block' });
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
      await stopActiveChatGenerationForPrivateStorageBlocked();
      resolveCompletion?.();
      await sendPromise;
    });

    expect(llmEngineService.interruptActiveCompletion).toHaveBeenCalledTimes(1);
    expect(backgroundTaskService.isTaskActive('inference')).toBe(false);
    expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
    expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(expect.objectContaining({
      content: 'Partial answer',
      state: 'stopped',
    }));
  });

  it('interrupts active generation when a pending flush cannot persist after storage blocks', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;
    const originalPatchAssistantMessage = useChatStore.getState().patchAssistantMessage;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const privateStorageError = new PrivateStorageUnavailableError('encrypted_open_failed', {
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      lastUpdatedAt: 1,
    });

    let patchCallCount = 0;
    useChatStore.setState({
      patchAssistantMessage: jest.fn((...args: Parameters<typeof originalPatchAssistantMessage>) => {
        patchCallCount += 1;
        if (patchCallCount === 1) {
          originalPatchAssistantMessage(...args);
          return;
        }

        throw privateStorageError;
      }),
    } as Partial<ReturnType<typeof useChatStore.getState>>);

    try {
      (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
        ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
          new Promise((resolve) => {
            onToken = tokenHandler;
            resolveCompletion = () => resolve({ text: 'Stopped by storage block' });
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
        onToken?.(' still pending');
        await expect(stopActiveChatGenerationForPrivateStorageBlocked()).resolves.toBeUndefined();
      });

      expect(llmEngineService.interruptActiveCompletion).toHaveBeenCalledTimes(1);
      expect(backgroundTaskService.isTaskActive('inference')).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('pending assistant patch'),
        privateStorageError,
      );

      await act(async () => {
        resolveCompletion?.();
        await expect(sendPromise).rejects.toBe(privateStorageError);
      });
    } finally {
      await act(async () => {
        useChatStore.setState({ patchAssistantMessage: originalPatchAssistantMessage } as Partial<ReturnType<typeof useChatStore.getState>>);
      });
      warnSpy.mockRestore();
    }
  });

  it('flushes throttled assistant content before marking a pending stop as stopped', async () => {
    let onToken: ((token: any) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;
    let resolveStopCompletion: (() => void) | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: any) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Native completion resolved later' });
        }),
    );
    (llmEngineService.stopCompletion as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveStopCompletion = () => resolve(undefined);
      }),
    );

    const getSession = renderHookHarness();
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Stream, then stop');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
    });

    jest.useFakeTimers();
    try {
      await act(async () => {
        onToken?.({
          token: 'answer-1',
          content: 'Buffered answer',
          reasoningContent: 'Buffered thought',
        });
      });

      let thread = useChatStore.getState().getActiveThread();
      expect(thread?.messages.at(-1)).toEqual(expect.objectContaining({
        content: 'Buffered answer',
        thoughtContent: 'Buffered thought',
        state: 'streaming',
      }));

      let stopPromise: Promise<void> | undefined;
      await act(async () => {
        stopPromise = getSession()?.stopGeneration();
        await Promise.resolve();
      });

      thread = useChatStore.getState().getActiveThread();
      expect(llmEngineService.stopCompletion).toHaveBeenCalled();
      expect(thread?.status).toBe('stopped');
      expect(thread?.messages.at(-1)).toEqual(expect.objectContaining({
        role: 'assistant',
        content: 'Buffered answer',
        thoughtContent: 'Buffered thought',
        state: 'stopped',
      }));

      await act(async () => {
        onToken?.({
          token: 'late-answer',
          content: 'Late answer',
          reasoningContent: 'Late thought',
        });
        await Promise.resolve();
      });

      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(expect.objectContaining({
        content: 'Buffered answer',
        thoughtContent: 'Buffered thought',
        state: 'stopped',
      }));

      await act(async () => {
        resolveStopCompletion?.();
        resolveCompletion?.();
        await stopPromise;
        await sendPromise;
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('slows long streaming UI patches while keeping first token and sentence boundaries immediate', async () => {
    let onToken: ((token: any) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;
    let sendPromise: Promise<void> | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: any) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Final long answer.' });
        }),
    );

    const getSession = renderHookHarness();
    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Stream a long markdown answer');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
    });

    jest.useFakeTimers();
    try {
      await act(async () => {
        onToken?.({
          token: 'intro',
          content: 'Intro',
          accumulatedText: 'Intro',
          reasoningContent: 'Plan',
        });
        await Promise.resolve();
      });

      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(expect.objectContaining({
        content: 'Intro',
        thoughtContent: 'Plan',
        state: 'streaming',
      }));

      const longMarkdown = `Intro ${'**markdown** '.repeat(120)}`;
      const longReasoning = 'Plan '.repeat(260);
      await act(async () => {
        onToken?.({
          token: 'long',
          content: longMarkdown,
          accumulatedText: longMarkdown,
          reasoningContent: longReasoning,
        });
        await Promise.resolve();
      });

      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(expect.objectContaining({
        content: 'Intro',
        thoughtContent: 'Plan',
      }));

      act(() => {
        jest.advanceTimersByTime(LONG_STREAM_PATCH_INTERVAL_MS - 1);
      });
      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)).toEqual(expect.objectContaining({
        content: 'Intro',
      }));

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)?.content).toContain('**markdown**');

      await act(async () => {
        onToken?.({
          token: '.',
          content: `${longMarkdown}.`,
          accumulatedText: `${longMarkdown}.`,
          reasoningContent: longReasoning,
        });
        await Promise.resolve();
      });

      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)?.content.endsWith('.')).toBe(true);

      await act(async () => {
        onToken?.({
          token: 'reasoning-tail',
          accumulatedText: `${longMarkdown}.`,
          reasoningContent: `${longReasoning} more reasoning`,
        });
        await Promise.resolve();
      });

      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)?.thoughtContent).toBe(longReasoning);

      act(() => {
        jest.advanceTimersByTime(LONG_STREAM_PATCH_INTERVAL_MS);
      });
      expect(useChatStore.getState().getActiveThread()?.messages.at(-1)?.thoughtContent).toContain('more reasoning');

      await act(async () => {
        resolveCompletion?.();
        await sendPromise;
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks a new send while a stopped native completion is still settling', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;
    let resolveInterrupt: (() => void) | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Stopped' });
        }),
    );
    (llmEngineService.interruptActiveCompletion as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveInterrupt = () => resolve(undefined);
      }),
    );

    const getSession = renderHookHarness();
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Long answer please');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      onToken?.('Partial answer');
    });

    let stopPromise: Promise<void> | undefined;
    await act(async () => {
      stopPromise = getSession()?.stopGeneration();
      await Promise.resolve();
    });

    expect(llmEngineService.interruptActiveCompletion).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');

    let sendError: unknown;
    await act(async () => {
      try {
        await getSession()?.appendUserMessage('Too soon');
      } catch (error) {
        sendError = error;
      }
    });

    expect(sendError).toEqual(expect.objectContaining({
      message: expect.stringContaining('finish stopping'),
    }));
    expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().getActiveThread()?.messages.map((message) => message.content)).toEqual([
      'Long answer please',
      'Partial answer',
    ]);

    await act(async () => {
      resolveInterrupt?.();
      await stopPromise;
      resolveCompletion?.();
      await sendPromise;
    });
  });

  it('does not start engine completion when stop is requested during prompt preparation', async () => {
    let resolvePromptCount: (() => void) | undefined;
    (llmEngineService.countPromptTokens as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePromptCount = () => resolve(16);
      }),
    );

    const getSession = renderHookHarness();
    let sendPromise: Promise<void> | undefined;

    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Stop before native generation');
    });

    await waitFor(() => {
      expect(llmEngineService.countPromptTokens).toHaveBeenCalled();
    });

    await act(async () => {
      await getSession()?.stopGeneration();
    });

    let thread = useChatStore.getState().getActiveThread();
    expect(llmEngineService.stopCompletion).toHaveBeenCalled();
    expect(llmEngineService.chatCompletion).not.toHaveBeenCalled();
    expect(thread?.status).toBe('stopped');
    expect(thread?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'assistant',
      state: 'stopped',
    }));

    await act(async () => {
      resolvePromptCount?.();
      await sendPromise;
    });

    thread = useChatStore.getState().getActiveThread();
    expect(llmEngineService.chatCompletion).not.toHaveBeenCalled();
    expect(thread?.status).toBe('stopped');
    expect(thread?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'assistant',
      state: 'stopped',
    }));
  });

  it('cleans up background inference when pre-native stopCompletion rejects', async () => {
    let resolvePromptCount: (() => void) | undefined;
    const stopError = new Error('pre-native stop failed');

    (llmEngineService.countPromptTokens as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePromptCount = () => resolve(16);
      }),
    );
    (llmEngineService.stopCompletion as jest.Mock).mockRejectedValueOnce(stopError);

    const getSession = renderHookHarness();
    let sendPromise: Promise<void> | undefined;

    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Stop before native cleanup');
    });

    await waitFor(() => {
      expect(llmEngineService.countPromptTokens).toHaveBeenCalled();
      expect(backgroundTaskService.isTaskActive('inference')).toBe(true);
    });

    let caughtError: unknown;
    await act(async () => {
      try {
        await getSession()?.stopGeneration();
      } catch (error) {
        caughtError = error;
      }
    });

    expect(caughtError).toBe(stopError);
    expect(backgroundTaskService.isTaskActive('inference')).toBe(false);
    expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
    expect(llmEngineService.chatCompletion).not.toHaveBeenCalled();

    await act(async () => {
      resolvePromptCount?.();
      await sendPromise;
    });
  });

  it('does not let an old stopped prompt-prep run start after a new send', async () => {
    let resolveFirstPromptCount: (() => void) | undefined;
    let resolveSecondCompletion: (() => void) | undefined;
    (llmEngineService.countPromptTokens as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveFirstPromptCount = () => resolve(16);
      }),
    );
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => new Promise((resolve) => {
        resolveSecondCompletion = () => {
          onToken?.('Hello back');
          resolve({ text: 'Hello back' });
        };
      }),
    );

    const getSession = renderHookHarness();
    let firstSendPromise: Promise<void> | undefined;
    await act(async () => {
      firstSendPromise = getSession()?.appendUserMessage('First request');
    });

    await waitFor(() => {
      expect(llmEngineService.countPromptTokens).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await getSession()?.stopGeneration();
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
    });

    let secondSendPromise: Promise<void> | undefined;
    await act(async () => {
      secondSendPromise = getSession()?.appendUserMessage('Second request');
    });

    await waitFor(() => {
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(1);
    });

    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);

    await act(async () => {
      resolveFirstPromptCount?.();
      await firstSendPromise;
    });

    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);

    await act(async () => {
      resolveSecondCompletion?.();
      await secondSendPromise;
    });

    const thread = useChatStore.getState().getActiveThread();
    expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(1);
    expect(thread?.status).toBe('idle');
    expect(thread?.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(thread?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Hello back',
      state: 'complete',
    }));
  });

  it('does not let a slow stale stop clear a newer generation background task', async () => {
    let resolveFirstPromptCount: (() => void) | undefined;
    let resolveStopCompletion: (() => void) | undefined;
    let resolveSecondCompletion: (() => void) | undefined;

    (llmEngineService.countPromptTokens as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveFirstPromptCount = () => resolve(16);
      }),
    );
    (llmEngineService.stopCompletion as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveStopCompletion = () => resolve(undefined);
      }),
    );
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => new Promise((resolve) => {
        resolveSecondCompletion = () => {
          onToken?.('Hello back');
          resolve({ text: 'Hello back' });
        };
      }),
    );

    const getSession = renderHookHarness();
    let firstSendPromise: Promise<void> | undefined;
    await act(async () => {
      firstSendPromise = getSession()?.appendUserMessage('First request');
    });

    await waitFor(() => {
      expect(llmEngineService.countPromptTokens).toHaveBeenCalledTimes(1);
    });

    let stopPromise: Promise<void> | undefined;
    await act(async () => {
      stopPromise = getSession()?.stopGeneration();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
    });

    let secondSendPromise: Promise<void> | undefined;
    await act(async () => {
      secondSendPromise = getSession()?.appendUserMessage('Second request');
    });

    await waitFor(() => {
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolveStopCompletion?.();
      await stopPromise;
    });

    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);

    await act(async () => {
      resolveFirstPromptCount?.();
      await firstSendPromise;
    });

    expect(backgroundTaskService.isTaskActive('inference')).toBe(true);

    await act(async () => {
      resolveSecondCompletion?.();
      await secondSendPromise;
    });

    expect(backgroundTaskService.isTaskActive('inference')).toBe(false);
    expect(useChatStore.getState().getActiveThread()?.status).toBe('idle');
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

  it('blocks edited regeneration before replacing a persisted branch when private storage is unavailable', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Original prompt');
    });

    const threadBeforeBlock = useChatStore.getState().getActiveThread();
    const userMessageId = threadBeforeBlock?.messages[0].id ?? '';
    const blockedHealth = {
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: false,
      messageKey: 'storage.private.encryptedOpenFailed',
      lastUpdatedAt: 456,
    };
    (isPrivateStorageWritable as jest.Mock).mockReturnValue(false);
    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(blockedHealth);

    const chatCompletionCallsBeforeBlock = (llmEngineService.chatCompletion as jest.Mock).mock.calls.length;
    const replaceBranchSpy = jest.spyOn(useChatStore.getState(), 'replaceBranchFromUserMessage');
    const getBlockedSession = renderHookHarness();
    let thrown: unknown;

    try {
      await act(async () => {
        try {
          await getBlockedSession()?.regenerateFromUserMessage(userMessageId, 'Edited prompt');
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(
        expect.objectContaining({
          name: 'AppError',
          code: 'storage_private_unavailable',
          details: {
            privateStorageHealth: blockedHealth,
          },
        }),
      );
      expect(replaceBranchSpy).not.toHaveBeenCalled();
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(chatCompletionCallsBeforeBlock);
      expect(useChatStore.getState().getActiveThread()?.messages).toEqual(threadBeforeBlock?.messages);
    } finally {
      replaceBranchSpy.mockRestore();
    }
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

  it('flushes pending streaming content into bounded storage before backgrounding', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;
    let sendPromise: Promise<void> | undefined;

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Finished after background flush' });
        }),
    );

    const getSession = renderHookHarness();

    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Persist partial before background');
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
    });

    await act(async () => {
      onToken?.('Partial before background');
      emitAppState('background');
    });

    const threadId = useChatStore.getState().activeThreadId;
    expect(threadId).toBeTruthy();
    expect(storage.getString(getChatThreadStorageKey(threadId ?? ''))).toContain('Partial before background');

    await act(async () => {
      resolveCompletion?.();
      await sendPromise;
    });
  });

  it('does not throw when background persistence flush hits blocked private storage', async () => {
    renderHookHarness();

    await act(async () => {
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
      const assistantMessageId = useChatStore.getState().createAssistantPlaceholder(threadId);
      useChatStore.getState().patchAssistantMessage(threadId, assistantMessageId, {
        content: 'Partial before blocked background flush',
        state: 'streaming',
      });
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const privateStorageError = new PrivateStorageUnavailableError('encrypted_open_failed', {
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      lastUpdatedAt: 1,
    });
    const appStorage = getAppStorage();
    const originalSet = appStorage.set;
    appStorage.set = jest.fn(() => {
      throw privateStorageError;
    }) as unknown as typeof appStorage.set;

    try {
      await act(async () => {
        expect(() => emitAppState('background')).not.toThrow();
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('background chat persistence'),
        privateStorageError,
      );
    } finally {
      appStorage.set = originalSet;
      warnSpy.mockRestore();
    }
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
            seed: null,
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

  it('keeps a generating thread alive on foreground recovery while background inference tracking is still active', async () => {
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
              seed: null,
            },
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'Still streaming',
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
      await backgroundTaskService.startBackgroundInference('Recovered model');
    });

    await act(async () => {
      emitAppState('background');
      emitAppState('active');
    });

    expect(useChatStore.getState().getActiveThread()?.status).toBe('generating');
  });

  it('marks an orphaned generating thread as stopped when only a background download task is active', async () => {
    renderHookHarness();

    await act(async () => {
      useChatStore.setState({
        threads: {
          'thread-1': {
            id: 'thread-1',
            title: 'Interrupted thread',
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
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'Interrupted output',
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
      await backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' });
      await (backgroundTaskService as any).handleAppStateChange('background');
    });

    await act(async () => {
      emitAppState('background');
      emitAppState('active');
    });

    expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
  });

  it('sends only one interrupted notification when iOS expiration stops generation', async () => {
    let onToken: ((token: string) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;
    let sendPromise: Promise<void> | undefined;
    const interruptedSpy = jest.spyOn(notificationService, 'sendInterruptedNotification').mockResolvedValue(undefined);

    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'background',
    });

    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      ({ onToken: tokenHandler }: { onToken?: (token: string) => void }) =>
        new Promise((resolve) => {
          onToken = tokenHandler;
          resolveCompletion = () => resolve({ text: 'Stopped after expiration' });
        }),
    );

    const getSession = renderHookHarness();

    await act(async () => {
      sendPromise = getSession()?.appendUserMessage('Expire this response');
    });

    await waitFor(() => {
      expect(BackgroundTaskServiceOnExpirationHandler()).toEqual(expect.any(Function));
      expect(onToken).toEqual(expect.any(Function));
    });

    await act(async () => {
      onToken?.('Partial before expiration');
      BackgroundTaskServiceOnExpirationHandler()?.();
      resolveCompletion?.();
      await sendPromise;
    });

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
    });

    const thread = useChatStore.getState().getActiveThread();
    const persistedRecord = readPersistedThreadRecord(thread?.id);
    const persistedAssistant = persistedRecord.thread?.messages?.at(-1);
    expect(persistedRecord.thread?.status).toBe('stopped');
    expect(persistedAssistant).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Partial before expiration',
      state: 'stopped',
    }));
    expect(persistedRecord.thread?.messages?.some((message) => message.state === 'streaming')).toBe(false);
    expect(interruptedSpy).toHaveBeenCalledTimes(1);
  });

  it('logs rejected expiration stop without changing stopped notification flow', async () => {
    let resolveCompletion: (() => void) | undefined;
    const stopError = new Error('expiration stop failed');
    const interruptedSpy = jest.spyOn(notificationService, 'sendInterruptedNotification').mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'background',
    });

    (llmEngineService.stopCompletion as jest.Mock).mockRejectedValueOnce(stopError);
    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCompletion = () => resolve({ text: 'Stopped after rejected expiration stop' });
        }),
    );

    try {
      const getSession = renderHookHarness();
      let sendPromise: Promise<void> | undefined;

      await act(async () => {
        sendPromise = getSession()?.appendUserMessage('Expire and reject stop');
      });

      await waitFor(() => {
        expect(BackgroundTaskServiceOnExpirationHandler()).toEqual(expect.any(Function));
      });

      await act(async () => {
        BackgroundTaskServiceOnExpirationHandler()?.();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(useChatStore.getState().getActiveThread()?.status).toBe('stopped');
      });

      expect(llmEngineService.stopCompletion).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[ChatSession] Failed to stop expired completion', stopError);
      expect(interruptedSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveCompletion?.();
        await sendPromise;
      });
    } finally {
      warnSpy.mockRestore();
    }
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

  it('auto-switches the active thread model when the global active model changes', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('First prompt');
    });

    const originalThread = useChatStore.getState().getActiveThread();

    expect(originalThread?.modelId).toBe('author/model-q4');
    expect(originalThread?.activeModelId).toBe('author/model-q4');

    (getSettings as jest.Mock).mockReturnValue({
      activeModelId: 'author/model-q8',
      activePresetId: 'preset-1',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
    });
    (llmEngineService.getState as jest.Mock).mockReturnValue({
      status: EngineStatus.READY,
      activeModelId: 'author/model-q8',
    });

    await act(async () => {
      await getSession()?.appendUserMessage('Use a different model now');
    });

    const state = useChatStore.getState();
    const activeThread = state.getActiveThread();

    expect(activeThread?.id).toBe(originalThread?.id);
    expect(activeThread?.modelId).toBe('author/model-q4');
    expect(activeThread?.activeModelId).toBe('author/model-q8');

    const roles = activeThread?.messages.map((message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'system', 'user', 'assistant']);

    const switchMessage = activeThread?.messages.find((message) => message.kind === 'model_switch');
    expect(switchMessage).toEqual(
      expect.objectContaining({
        role: 'system',
        kind: 'model_switch',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      }),
    );

    const lastUserMessage = [...(activeThread?.messages ?? [])].reverse().find((message) => message.role === 'user');
    const lastAssistantMessage = activeThread?.messages.at(-1);
    expect(lastUserMessage).toEqual(
      expect.objectContaining({
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    );
    expect(lastAssistantMessage).toEqual(
      expect.objectContaining({
        role: 'assistant',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    );

    expect(originalThread?.modelId).toBe('author/model-q4');
    expect(state.getConversationIndex()).toHaveLength(1);
  });

  it('does not block regenerating when the global active model differs from the thread model', async () => {
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

    let didRegenerate = false;
    await act(async () => {
      didRegenerate = await getSession()?.regenerateLastResponse() ?? false;
    });

    expect(didRegenerate).toBe(true);
    expect(useChatStore.getState().getActiveThread()?.messages.some((message) => message.kind === 'model_switch')).toBe(false);
  });

  it('rebuilds the last turn instead of leaving a trailing model switch after regenerate', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('First prompt');
    });

    const originalThread = useChatStore.getState().getActiveThread();
    expect(originalThread).toBeTruthy();
    const originalAssistantId = originalThread?.messages.at(-1)?.id;

    await act(async () => {
      useChatStore.getState().switchThreadModel(originalThread!.id, 'author/model-q8', 2);
    });

    (llmEngineService.getState as jest.Mock).mockReturnValue({
      status: EngineStatus.READY,
      activeModelId: 'author/model-q8',
    });
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Fresh q8 reply');
        return { text: 'Fresh q8 reply' };
      },
    );

    await act(async () => {
      await getSession()?.regenerateLastResponse();
    });

    const thread = useChatStore.getState().getActiveThread();

    expect(thread?.activeModelId).toBe('author/model-q8');
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages.some((message) => message.kind === 'model_switch')).toBe(false);
    expect(thread?.messages[0]).toEqual(
      expect.objectContaining({
        role: 'user',
        content: 'First prompt',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    );
    expect(thread?.messages[1]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Fresh q8 reply',
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    );
    expect(thread?.messages[1]?.id).not.toBe(originalAssistantId);
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
        seed: null,
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
        seed: null,
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
        seed: null,
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

  it('truncates history only when the token budget is tight', () => {
    const snapshot = resolvePresetSnapshot('preset-1');
    const messageCount = 28;
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
        seed: null,
      },
      messages: Array.from({ length: messageCount }, (_, index) => ({
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

    const roomyMessages = buildInferenceMessagesForThread(thread, { maxContextTokens: 2048 });
    const roomyTruncationState = getThreadTruncationState(thread, { maxContextTokens: 2048 });

    expect(roomyMessages).toHaveLength(messageCount + 1);
    expect(roomyTruncationState).toEqual({
      truncatedMessageIds: [],
      shouldOfferSummary: false,
    });
    expect(roomyMessages[0]).toEqual({ role: 'system', content: 'Be concise.' });

    const tightTruncationState = getThreadTruncationState(thread, {
      maxContextTokens: 150,
      responseReserveTokens: 0,
      promptSafetyMarginTokens: 0,
    });

    expect(tightTruncationState.truncatedMessageIds.length).toBeGreaterThan(0);
    expect(tightTruncationState.shouldOfferSummary).toBe(true);
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
        seed: null,
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

  it('does not persist a summary placeholder when truncation is active', async () => {
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

    const messageCount = 28;
    for (let index = 0; index < messageCount; index += 1) {
      useChatStore.getState().appendMessage(threadId, {
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index + 1}`,
        createdAt: index + 1,
        state: 'complete',
      });
    }

    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(150);
    useChatStore.getState().setActiveThread(threadId);
    const getSession = renderHookHarness();

    await waitFor(() => {
      expect(getSession()?.shouldOfferSummary).toBe(true);
    });

    let created = true;
    await act(async () => {
      created = getSession()?.createSummaryPlaceholder() ?? false;
    });

    expect(created).toBe(false);
    const activeThread = useChatStore.getState().getActiveThread();
    expect(activeThread?.summary).toBeUndefined();
    expect(buildInferenceMessagesForThread(activeThread!)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Summary generation is not available yet.'),
        }),
      ]),
    );
  });

  it('aligns the summary affordance with the accurate prompt window when tokenizer counts exceed heuristics', async () => {
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

    for (let index = 0; index < 6; index += 1) {
      useChatStore.getState().appendMessage(threadId, {
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `m${index + 1}`,
        createdAt: index + 1,
        state: 'complete',
      });
    }

    const activeThread = useChatStore.getState().getThread(threadId)!;
    expect(getThreadTruncationState(activeThread, { maxContextTokens: 450 })).toEqual({
      truncatedMessageIds: [],
      shouldOfferSummary: false,
    });

    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(450);
    (llmEngineService.countPromptTokens as jest.Mock).mockImplementation(
      async ({ messages }: { messages: Array<{ role: string }> }) => messages.reduce(
        (total, message) => total + (message.role === 'system' ? 20 : 50),
        0,
      ),
    );

    useChatStore.getState().setActiveThread(threadId);
    const getSession = renderHookHarness();

    await waitFor(() => {
      expect(getSession()?.shouldOfferSummary).toBe(true);
      expect(getSession()?.truncatedMessageCount).toBe(4);
    });

    let created = true;
    await act(async () => {
      created = getSession()?.createSummaryPlaceholder() ?? false;
    });

    expect(created).toBe(false);
    expect(useChatStore.getState().getActiveThread()?.summary).toBeUndefined();
  });
});

function BackgroundTaskServiceOnExpirationHandler() {
  return ((require('react-native-background-actions') as { default: { on: jest.Mock } }).default.on as jest.Mock)
    .mock.calls
    .find((call) => call[0] === 'expiration')?.[1] as (() => void) | undefined;
}





