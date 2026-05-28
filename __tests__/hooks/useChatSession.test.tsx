import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
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
import { copiedDraftImageAttachment, copiedImageAttachment } from '../fixtures/chatImageAttachmentFixtures';
import type { MultimodalReadinessState } from '../../src/types/multimodal';

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
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 123_456 });
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

  function saveAuthorModelWithMultimodalReadiness(multimodalReadiness: MultimodalReadinessState) {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Vision test model',
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
        chatModalities: ['text', 'vision'],
        multimodalReadiness,
      },
    ]);
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

  it('persists copied image attachments on the user message and passes media paths to inference', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          support: ['vision'],
          checkedAt: 1,
        },
      });
    });

    const thread = useChatStore.getState().getActiveThread();
    const userMessage = thread?.messages[0];

    expect(userMessage).toEqual(expect.objectContaining({
      role: 'user',
      content: 'Describe this image',
      attachments: [
        expect.objectContaining({
          id: 'draft-image-1',
          threadId: thread?.id,
          messageId: userMessage?.id,
          localUri: 'test-dir/chat-attachments/draft-image-1.jpg',
        }),
      ],
    }));
    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        multimodalReadiness: expect.objectContaining({
          status: 'ready',
          support: ['vision'],
        }),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: 'Describe this image',
            mediaPaths: ['test-dir/chat-attachments/draft-image-1.jpg'],
            attachments: expect.any(Array),
          }),
        ]),
      }),
    );
    expect(llmEngineService.countPromptTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            mediaPaths: ['test-dir/chat-attachments/draft-image-1.jpg'],
          }),
        ]),
      }),
    );
  });

  it('strips retained historical images for failed-readiness text-only sends without mutating storage', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          support: ['vision'],
          checkedAt: 1,
        },
      });
    });

    const persistedAttachmentBefore = useChatStore.getState().getActiveThread()?.messages[0]?.attachments;
    (llmEngineService.chatCompletion as jest.Mock).mockClear();
    (llmEngineService.countPromptTokens as jest.Mock).mockClear();
    (FileSystem.getInfoAsync as jest.Mock).mockClear();
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: !uri.includes('draft-image-1.jpg'),
      size: 123_456,
    }));

    await act(async () => {
      await getSession()?.appendUserMessage('Continue with text only', {
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'failed',
          support: [],
          checkedAt: 2,
          failureReason: 'projector_missing',
        },
      });
    });

    const completionCall = (llmEngineService.chatCompletion as jest.Mock).mock.calls.at(-1)?.[0];
    expect(completionCall?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'Describe this image',
        }),
        expect.objectContaining({
          role: 'user',
          content: 'Continue with text only',
        }),
      ]),
    );
    expect(completionCall?.messages.flatMap((message: any) => message.mediaPaths ?? [])).toEqual([]);
    expect(completionCall?.messages.flatMap((message: any) => [
      ...(message.mediaPaths ?? []),
      ...(message.attachments ?? []),
    ])).toEqual([]);
    expect((llmEngineService.countPromptTokens as jest.Mock).mock.calls.some(([call]) => (
      call.messages.some((message: any) => message.content === 'Continue with text only')
      && call.messages.flatMap((message: any) => [
        ...(message.mediaPaths ?? []),
        ...(message.attachments ?? []),
      ]).length === 0
    ))).toBe(true);
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
    expect(useChatStore.getState().getActiveThread()?.messages[0]?.attachments).toBe(persistedAttachmentBefore);
  });

  it('throws chat_attachment_missing for missing latest draft image before appending', async () => {
    const onUserMessageAppended = jest.fn();
    const chatState = useChatStore.getState();
    const createThreadSpy = jest.spyOn(chatState, 'createThread');
    const appendMessageSpy = jest.spyOn(chatState, 'appendMessage');
    const createAssistantPlaceholderSpy = jest.spyOn(chatState, 'createAssistantPlaceholder');
    const getSession = renderHookHarness();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    let thrown: unknown;

    try {
      await act(async () => {
        try {
          await getSession()?.appendUserMessage('Describe this image', {
            attachmentDrafts: [copiedDraftImageAttachment],
            multimodalReadiness: {
              modelId: 'author/model-q4',
              status: 'ready',
              support: ['vision'],
              checkedAt: 1,
            },
            onUserMessageAppended,
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(expect.objectContaining({ code: 'chat_attachment_missing' }));
      expect(createThreadSpy).not.toHaveBeenCalled();
      expect(appendMessageSpy).not.toHaveBeenCalled();
      expect(createAssistantPlaceholderSpy).not.toHaveBeenCalled();
      expect(onUserMessageAppended).not.toHaveBeenCalled();
      expect(llmEngineService.chatCompletion).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationIndex()).toHaveLength(0);
    } finally {
      createThreadSpy.mockRestore();
      appendMessageSpy.mockRestore();
      createAssistantPlaceholderSpy.mockRestore();
    }
  });

  it('ignores historical images for a vision-ready text-only follow-up without mutating storage', async () => {
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          support: ['vision'],
          checkedAt: 1,
        },
      });
    });

    const persistedAttachmentBefore = useChatStore.getState().getActiveThread()?.messages[0]?.attachments;
    (llmEngineService.chatCompletion as jest.Mock).mockClear();
    (llmEngineService.countPromptTokens as jest.Mock).mockClear();
    (FileSystem.getInfoAsync as jest.Mock).mockClear();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 123_456 });

    await act(async () => {
      await getSession()?.appendUserMessage('Continue with text only', {
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          support: ['vision'],
          checkedAt: 2,
        },
      });
    });

    const completionCall = (llmEngineService.chatCompletion as jest.Mock).mock.calls.at(-1)?.[0];
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
    expect(completionCall?.messages.flatMap((message: any) => message.mediaPaths ?? [])).toEqual([]);
    expect(completionCall?.messages.flatMap((message: any) => [
      ...(message.mediaPaths ?? []),
      ...(message.attachments ?? []),
    ])).toEqual([]);
    expect((llmEngineService.countPromptTokens as jest.Mock).mock.calls.some(([call]) => (
      call.messages.some((message: any) => message.content === 'Continue with text only')
      && call.messages.flatMap((message: any) => [
        ...(message.mediaPaths ?? []),
        ...(message.attachments ?? []),
      ]).length === 0
    ))).toBe(true);
    expect(useChatStore.getState().getActiveThread()?.messages[0]?.attachments).toBe(persistedAttachmentBefore);
  });

  it('caps retained inference images to the latest four attachments before validating files', async () => {
    const chatState = useChatStore.getState();
    const threadId = chatState.createThread({
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
    chatState.appendMessage(threadId, {
      id: 'message-old-images',
      role: 'user',
      content: 'Older images',
      createdAt: 1,
      state: 'complete',
      kind: 'message',
      modelId: 'author/model-q4',
      attachments: Array.from({ length: 3 }, (_, index) => ({
        ...copiedImageAttachment,
        id: `old-image-${index + 1}`,
        threadId,
        messageId: 'message-old-images',
        localUri: `test-dir/chat-attachments/old-image-${index + 1}.jpg`,
        fileName: `old-image-${index + 1}.jpg`,
      })),
    });
    chatState.setActiveThread(threadId);
    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(8192);
    const latestDrafts = Array.from({ length: 4 }, (_, index) => ({
      ...copiedDraftImageAttachment,
      id: `latest-draft-${index + 1}`,
      pickerUri: `ph://latest-${index + 1}`,
      previewUri: `test-dir/chat-attachments/latest-${index + 1}.jpg`,
      localUri: `test-dir/chat-attachments/latest-${index + 1}.jpg`,
      fileName: `latest-${index + 1}.jpg`,
    }));
    (FileSystem.getInfoAsync as jest.Mock).mockClear();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 123_456 });
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Use these latest images', {
        attachmentDrafts: latestDrafts,
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          support: ['vision'],
          checkedAt: 3,
        },
      });
    });

    const completionCall = (llmEngineService.chatCompletion as jest.Mock).mock.calls.at(-1)?.[0];
    const mediaPaths = completionCall?.messages.flatMap((message: any) => message.mediaPaths ?? []);
    expect(mediaPaths).toEqual([
      'test-dir/chat-attachments/latest-1.jpg',
      'test-dir/chat-attachments/latest-2.jpg',
      'test-dir/chat-attachments/latest-3.jpg',
      'test-dir/chat-attachments/latest-4.jpg',
    ]);
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/old-image-1.jpg');
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/old-image-2.jpg');
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/old-image-3.jpg');
    expect(useChatStore.getState().getThread(threadId)?.messages[0]?.attachments).toHaveLength(3);
  });

  it('does not validate historical images for a latest text-only prompt', async () => {
    const chatState = useChatStore.getState();
    const threadId = chatState.createThread({
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

    chatState.appendMessage(threadId, {
      id: 'message-old-image-outside',
      role: 'user',
      content: 'Old image outside the retained window',
      createdAt: 1,
      state: 'complete',
      kind: 'message',
      modelId: 'author/model-q4',
      attachments: [{
        ...copiedImageAttachment,
        id: 'old-image-outside',
        threadId,
        messageId: 'message-old-image-outside',
        localUri: 'test-dir/chat-attachments/missing-outside.jpg',
      }],
    });
    chatState.appendMessage(threadId, {
      id: 'message-large-assistant',
      role: 'assistant',
      content: 'older assistant '.repeat(400),
      createdAt: 2,
      state: 'complete',
      kind: 'message',
      modelId: 'author/model-q4',
    });
    chatState.setActiveThread(threadId);
    (llmEngineService.getContextSize as jest.Mock).mockReturnValue(256);
    (FileSystem.getInfoAsync as jest.Mock).mockClear();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Fresh short text', {
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          support: ['vision'],
          checkedAt: 3,
        },
      });
    });

    expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/missing-outside.jpg');
    expect(llmEngineService.chatCompletion).toHaveBeenCalled();
    expect(useChatStore.getState().getThread(threadId)?.messages[0]?.attachments?.[0]?.localUri)
      .toBe('test-dir/chat-attachments/missing-outside.jpg');
  });

  it('notifies when an attached user message is materialized before generation failures', async () => {
    const generationError = new Error('vision generation failed after append');
    const onUserMessageAppended = jest.fn();
    (llmEngineService.chatCompletion as jest.Mock).mockRejectedValueOnce(generationError);
    const getSession = renderHookHarness();
    let thrown: unknown;

    await act(async () => {
      try {
        await getSession()?.appendUserMessage('Describe this image', {
          attachmentDrafts: [copiedDraftImageAttachment],
          multimodalReadiness: {
            modelId: 'author/model-q4',
            status: 'ready',
            support: ['vision'],
            checkedAt: 1,
          },
          onUserMessageAppended,
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(expect.objectContaining({
      code: 'action_failed',
      message: generationError.message,
    }));
    expect((thrown as { cause?: unknown } | undefined)?.cause).toBeUndefined();
    expect(onUserMessageAppended).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: 'Describe this image',
      attachments: [
        expect.objectContaining({
          id: 'draft-image-1',
          localUri: 'test-dir/chat-attachments/draft-image-1.jpg',
        }),
      ],
    }));
    expect(useChatStore.getState().getActiveThread()?.messages[0]).toEqual(expect.objectContaining({
      attachments: [
        expect.objectContaining({
          localUri: 'test-dir/chat-attachments/draft-image-1.jpg',
        }),
      ],
    }));
  });

  it('blocks image attachments before mutating chat state when vision is not ready', async () => {
    const getSession = renderHookHarness();

    await expect(act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'text_only',
          support: [],
          checkedAt: 1,
        },
      });
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
    });

    expect(useChatStore.getState().getConversationIndex()).toHaveLength(0);
    expect(llmEngineService.chatCompletion).not.toHaveBeenCalled();
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

    expect(thrown).toEqual(expect.objectContaining({
      code: 'action_failed',
      message: generationError.message,
    }));
    expect((thrown as { cause?: unknown } | undefined)?.cause).toBeUndefined();

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

  it('redacts native multimodal paths from persisted and thrown assistant generation errors', async () => {
    const rawErrorMessage = 'native multimodal failed for file:///data/user/0/com.pocket/cache/image.jpg while opening /data/user/0/com.pocket/files/projector.dat from C:\\Users\\tester\\Projector\\image.png';
    const generationError = new Error(rawErrorMessage);
    (llmEngineService.chatCompletion as jest.Mock).mockRejectedValueOnce(generationError);
    const getSession = renderHookHarness();
    let thrown: unknown;

    await act(async () => {
      try {
        await getSession()?.appendUserMessage('Describe this image', {
          attachmentDrafts: [copiedDraftImageAttachment],
          multimodalReadiness: {
            modelId: 'author/model-q4',
            status: 'ready',
            support: ['vision'],
            checkedAt: 1,
          },
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(expect.objectContaining({
      code: 'action_failed',
      message: expect.stringContaining('[path]'),
    }));
    expect((thrown as { cause?: unknown } | undefined)?.cause).toBeUndefined();
    expect((thrown as Error | undefined)?.message).not.toContain('file://');
    expect((thrown as Error | undefined)?.message).not.toContain('/data/user');
    expect((thrown as Error | undefined)?.message).not.toContain('C:\\Users');
    expect(generationError.message).toBe(rawErrorMessage);

    const thread = useChatStore.getState().getActiveThread();
    const assistantMessage = thread?.messages.at(-1);
    expect(assistantMessage).toEqual(expect.objectContaining({
      role: 'assistant',
      state: 'error',
      errorCode: 'generation_failed',
      errorMessage: expect.stringContaining('[path]'),
    }));
    expect(assistantMessage?.errorMessage).not.toContain('file://');
    expect(assistantMessage?.errorMessage).not.toContain('/data/user');
    expect(assistantMessage?.errorMessage).not.toContain('C:\\Users');
    expect(assistantMessage?.errorMessage).not.toContain('Projector');

    const record = readPersistedThreadRecord(thread?.id);
    const serializedRecord = JSON.stringify(record);
    const persistedAssistant = record.thread?.messages?.at(-1);
    expect(persistedAssistant).toEqual(expect.objectContaining({
      role: 'assistant',
      state: 'error',
      errorCode: 'generation_failed',
      errorMessage: assistantMessage?.errorMessage,
    }));
    expect(serializedRecord).not.toContain('file://');
    expect(serializedRecord).not.toContain('/data/user');
    expect(serializedRecord).not.toContain('C:\\Users');
    expect(serializedRecord).not.toContain('Projector');
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

  it('appends a new assistant when the last image-only user has no following assistant', async () => {
    const readyVision = {
      modelId: 'author/model-q4',
      status: 'ready' as const,
      support: ['vision' as const],
      checkedAt: 1,
    };
    saveAuthorModelWithMultimodalReadiness(readyVision);
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('First prompt');
    });

    const threadAfterFirstTurn = useChatStore.getState().getActiveThread();
    expect(threadAfterFirstTurn?.messages).toHaveLength(2);
    const firstAssistant = threadAfterFirstTurn?.messages[1];
    const imageOnlyUserMessageId = 'message-image-only-tail';
    const imageOnlyUserAttachment = {
      ...copiedImageAttachment,
      id: 'attachment-image-only-tail',
      threadId: threadAfterFirstTurn?.id ?? '',
      messageId: imageOnlyUserMessageId,
      localUri: copiedDraftImageAttachment.localUri,
      fileName: copiedDraftImageAttachment.fileName,
      mediaType: copiedDraftImageAttachment.mediaType,
      size: copiedDraftImageAttachment.size,
      width: copiedDraftImageAttachment.width,
      height: copiedDraftImageAttachment.height,
      createdAt: Date.now(),
    };

    await act(async () => {
      useChatStore.getState().appendMessage(threadAfterFirstTurn?.id ?? '', {
        id: imageOnlyUserMessageId,
        role: 'user',
        content: '',
        createdAt: Date.now(),
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
        attachments: [imageOnlyUserAttachment],
      });
    });

    const replaceLastAssistantSpy = jest.spyOn(useChatStore.getState(), 'replaceLastAssistantMessage');
    const getRegenerateSession = renderHookHarness();
    (llmEngineService.chatCompletion as jest.Mock).mockClear();
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Fresh image tail reply');
        return { text: 'Fresh image tail reply' };
      },
    );

    try {
      await act(async () => {
        await getRegenerateSession()?.regenerateLastResponse();
      });

      const thread = useChatStore.getState().getActiveThread();
      expect(replaceLastAssistantSpy).not.toHaveBeenCalled();
      expect(thread?.messages).toHaveLength(4);
      expect(thread?.messages[1]).toEqual(firstAssistant);
      expect(thread?.messages[2]).toEqual(expect.objectContaining({
        id: imageOnlyUserMessageId,
        role: 'user',
        content: '',
        attachments: [imageOnlyUserAttachment],
      }));
      expect(thread?.messages[3]).toEqual(expect.objectContaining({
        role: 'assistant',
        content: 'Fresh image tail reply',
        state: 'complete',
      }));
      expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
        expect.objectContaining({
          multimodalReadiness: readyVision,
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: '',
              mediaPaths: [copiedDraftImageAttachment.localUri],
              attachments: [imageOnlyUserAttachment],
            }),
          ]),
        }),
      );
    } finally {
      replaceLastAssistantSpy.mockRestore();
    }
  });

  it('blocks regenerating the last assistant when the last user image is missing before replacing it', async () => {
    const readyVision = {
      modelId: 'author/model-q4',
      status: 'ready' as const,
      support: ['vision' as const],
      checkedAt: 1,
    };
    saveAuthorModelWithMultimodalReadiness(readyVision);
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: readyVision,
      });
    });

    const threadBeforeRegenerate = useChatStore.getState().getActiveThread();
    const completionCallsBeforeRegenerate = (llmEngineService.chatCompletion as jest.Mock).mock.calls.length;
    const replaceLastAssistantSpy = jest.spyOn(useChatStore.getState(), 'replaceLastAssistantMessage');
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    const getRegenerateSession = renderHookHarness();
    let thrown: unknown;

    try {
      await act(async () => {
        try {
          await getRegenerateSession()?.regenerateLastResponse();
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(expect.objectContaining({ code: 'chat_attachment_missing' }));
      expect(replaceLastAssistantSpy).not.toHaveBeenCalled();
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(completionCallsBeforeRegenerate);
      expect(useChatStore.getState().getActiveThread()?.messages).toEqual(threadBeforeRegenerate?.messages);
    } finally {
      replaceLastAssistantSpy.mockRestore();
    }
  });

  it('blocks regenerating the last assistant when vision is not ready before replacing it', async () => {
    const readyVision = {
      modelId: 'author/model-q4',
      status: 'ready' as const,
      support: ['vision' as const],
      checkedAt: 1,
    };
    saveAuthorModelWithMultimodalReadiness({
      modelId: 'author/model-q4',
      status: 'text_only',
      support: [],
      checkedAt: 2,
    });
    const getSession = renderHookHarness();

    await act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: readyVision,
      });
    });

    const threadBeforeRegenerate = useChatStore.getState().getActiveThread();
    const completionCallsBeforeRegenerate = (llmEngineService.chatCompletion as jest.Mock).mock.calls.length;
    const replaceLastAssistantSpy = jest.spyOn(useChatStore.getState(), 'replaceLastAssistantMessage');
    (FileSystem.getInfoAsync as jest.Mock).mockClear();
    const getRegenerateSession = renderHookHarness();
    let thrown: unknown;

    try {
      await act(async () => {
        try {
          await getRegenerateSession()?.regenerateLastResponse();
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(expect.objectContaining({ code: 'multimodal_not_ready' }));
      expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
      expect(replaceLastAssistantSpy).not.toHaveBeenCalled();
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(completionCallsBeforeRegenerate);
      expect(useChatStore.getState().getActiveThread()?.messages).toEqual(threadBeforeRegenerate?.messages);
    } finally {
      replaceLastAssistantSpy.mockRestore();
    }
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

  it('regenerates an image-only user message while preserving media paths', async () => {
    const getSession = renderHookHarness();
    const readyVision = {
      modelId: 'author/model-q4',
      status: 'ready' as const,
      support: ['vision' as const],
      checkedAt: 1,
    };

    await act(async () => {
      await getSession()?.appendUserMessage('', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: readyVision,
      });
    });

    const userMessage = useChatStore.getState().getActiveThread()?.messages[0];
    const persistedAttachments = userMessage?.attachments;
    (llmEngineService.chatCompletion as jest.Mock).mockClear();
    (llmEngineService.countPromptTokens as jest.Mock).mockClear();
    (llmEngineService.chatCompletion as jest.Mock).mockImplementationOnce(
      async ({ onToken }: { onToken?: (token: string) => void }) => {
        onToken?.('Fresh image reply');
        return { text: 'Fresh image reply' };
      },
    );

    await act(async () => {
      await getSession()?.regenerateFromUserMessage(userMessage?.id ?? '', '', {
        multimodalReadiness: readyVision,
      });
    });

    const thread = useChatStore.getState().getActiveThread();
    expect(thread?.messages[0]).toEqual(expect.objectContaining({
      id: userMessage?.id,
      role: 'user',
      content: '',
      attachments: persistedAttachments,
    }));
    expect(thread?.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Fresh image reply',
      state: 'complete',
    }));
    expect(llmEngineService.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        multimodalReadiness: readyVision,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: '',
            mediaPaths: ['test-dir/chat-attachments/draft-image-1.jpg'],
            attachments: persistedAttachments,
          }),
        ]),
      }),
    );
  });

  it('blocks regenerating an attached user message with a missing image before replacing the branch', async () => {
    const getSession = renderHookHarness();
    const readyVision = {
      modelId: 'author/model-q4',
      status: 'ready' as const,
      support: ['vision' as const],
      checkedAt: 1,
    };

    await act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: readyVision,
      });
    });

    const threadBeforeRegenerate = useChatStore.getState().getActiveThread();
    const userMessageId = threadBeforeRegenerate?.messages[0]?.id ?? '';
    const completionCallsBeforeRegenerate = (llmEngineService.chatCompletion as jest.Mock).mock.calls.length;
    const replaceBranchSpy = jest.spyOn(useChatStore.getState(), 'replaceBranchFromUserMessage');
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    const getRegenerateSession = renderHookHarness();
    let thrown: unknown;

    try {
      await act(async () => {
        try {
          await getRegenerateSession()?.regenerateFromUserMessage(userMessageId, 'Describe this missing image', {
            multimodalReadiness: readyVision,
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(expect.objectContaining({ code: 'chat_attachment_missing' }));
      expect(replaceBranchSpy).not.toHaveBeenCalled();
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(completionCallsBeforeRegenerate);
      expect(useChatStore.getState().getActiveThread()?.messages).toEqual(threadBeforeRegenerate?.messages);
    } finally {
      replaceBranchSpy.mockRestore();
    }
  });

  it('blocks regenerating an attached user message when vision is not ready before replacing the branch', async () => {
    const getSession = renderHookHarness();
    const readyVision = {
      modelId: 'author/model-q4',
      status: 'ready' as const,
      support: ['vision' as const],
      checkedAt: 1,
    };

    await act(async () => {
      await getSession()?.appendUserMessage('Describe this image', {
        attachmentDrafts: [copiedDraftImageAttachment],
        multimodalReadiness: readyVision,
      });
    });

    const threadBeforeRegenerate = useChatStore.getState().getActiveThread();
    const userMessageId = threadBeforeRegenerate?.messages[0]?.id ?? '';
    const completionCallsBeforeRegenerate = (llmEngineService.chatCompletion as jest.Mock).mock.calls.length;
    const replaceBranchSpy = jest.spyOn(useChatStore.getState(), 'replaceBranchFromUserMessage');
    (FileSystem.getInfoAsync as jest.Mock).mockClear();
    const getRegenerateSession = renderHookHarness();
    let thrown: unknown;

    try {
      await act(async () => {
        try {
          await getRegenerateSession()?.regenerateFromUserMessage(userMessageId, 'Describe this image', {
            multimodalReadiness: {
              modelId: 'author/model-q4',
              status: 'text_only',
              support: [],
              checkedAt: 2,
            },
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(expect.objectContaining({ code: 'multimodal_not_ready' }));
      expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
      expect(replaceBranchSpy).not.toHaveBeenCalled();
      expect(llmEngineService.chatCompletion).toHaveBeenCalledTimes(completionCallsBeforeRegenerate);
      expect(useChatStore.getState().getActiveThread()?.messages).toEqual(threadBeforeRegenerate?.messages);
    } finally {
      replaceBranchSpy.mockRestore();
    }
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





