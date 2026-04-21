import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { getAppStorage, mmkvStorage } from '../store/storage';
import {
  ChatMessage,
  ChatMessageRole,
  ChatMessageState,
  ChatSummary,
  ChatThread,
  ChatThreadStatus,
  ConversationIndexItem,
  GenerationParamsSnapshot,
  PresetSnapshot,
  createChatId,
  deriveThreadTitle,
  normalizeConversationTitle,
  sanitizeHydratedThread,
  buildConversationIndex,
  getThreadActiveModelId,
} from '../types/chat';
import { normalizeReasoningEffort } from '../types/reasoning';
import { createInstrumentedStateStorage } from './persistStateStorage';

const FALLBACK_TOP_K = 40;
const FALLBACK_MIN_P = 0.05;
const FALLBACK_REPETITION_PENALTY = 1;
const CHAT_STORE_STORAGE_KEY = 'chat-store';

const chatStoreStateStorage = createInstrumentedStateStorage(mmkvStorage, { scope: 'chatStore', dedupe: true });

interface CreateThreadInput {
  modelId: string;
  presetId: string | null;
  presetSnapshot: PresetSnapshot;
  paramsSnapshot: GenerationParamsSnapshot;
  title?: string;
}

interface ChatStoreState {
  threads: Record<string, ChatThread>;
  activeThreadId: string | null;
  createThread: (input: CreateThreadInput) => string;
  mergeImportedThreads: (threads: ChatThread[]) => number;
  pruneExpiredThreads: (retentionDays: number | null, now?: number) => number;
  clearAllThreads: () => number;
  setActiveThread: (threadId: string | null) => void;
  updateThreadPresetSnapshot: (threadId: string, presetId: string | null, presetSnapshot: PresetSnapshot) => void;
  updateThreadParamsSnapshot: (threadId: string, paramsSnapshot: GenerationParamsSnapshot) => void;
  switchThreadModel: (threadId: string, nextModelId: string, at?: number) => string | null;
  appendMessage: (threadId: string, message: ChatMessage) => void;
  createAssistantPlaceholder: (threadId: string) => string;
  stopAssistantMessage: (threadId: string, messageId: string) => void;
  finalizeAssistantMessage: (threadId: string, messageId: string, content: string, thoughtContent?: string) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => boolean;
  deleteMessageBranch: (threadId: string, messageId: string) => boolean;
  patchAssistantMessage: (
    threadId: string,
    messageId: string,
    updates: Partial<Pick<ChatMessage, 'content' | 'thoughtContent' | 'tokensPerSec' | 'state' | 'errorCode' | 'errorMessage'>>,
  ) => void;
  replaceLastAssistantMessage: (threadId: string) => string | null;
  replaceBranchFromUserMessage: (
    threadId: string,
    messageId: string,
    nextUserContent: string,
  ) => string | null;
  finalizeThreadStatus: (threadId: string, status: ChatThreadStatus) => void;
  setThreadSummary: (threadId: string, summary: ChatSummary | undefined) => void;
  getThread: (threadId: string | null) => ChatThread | null;
  getActiveThread: () => ChatThread | null;
  getConversationIndex: () => ConversationIndexItem[];
}

function updateThreadMetadata(thread: ChatThread): ChatThread {
  const derivedTitle = deriveThreadTitle(thread.messages);
  const title =
    thread.titleSource === 'manual'
      ? normalizeConversationTitle(thread.title) || derivedTitle
      : derivedTitle;

  return {
    ...thread,
    title,
    updatedAt: Date.now(),
  };
}

function clearPersistedChatStoreIfEmpty(threads: Record<string, ChatThread>) {
  if (Object.keys(threads).length === 0) {
    getAppStorage().remove(CHAT_STORE_STORAGE_KEY);
  }
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function getExpiredThreadIds(
  threads: Record<string, ChatThread>,
  retentionDays: number | null,
  now = Date.now(),
  activeThreadId: string | null = null,
) {
  if (retentionDays == null) {
    return [];
  }

  const cutoffTimestamp = now - retentionDays * MILLISECONDS_PER_DAY;

  return Object.values(threads)
    .filter((thread) => thread.id !== activeThreadId && thread.updatedAt < cutoffTimestamp)
    .map((thread) => thread.id);
}

export function findMostRecentThreadId(threads: Record<string, ChatThread>): string | null {
  let bestId: string | null = null;
  let bestUpdatedAt = -Infinity;

  for (const thread of Object.values(threads)) {
    if (!bestId || thread.updatedAt > bestUpdatedAt) {
      bestId = thread.id;
      bestUpdatedAt = thread.updatedAt;
    }
  }

  return bestId;
}

export const useChatStore = create<ChatStoreState>()(
  persist(
    (set, get) => ({
      threads: {},
      activeThreadId: null,

      createThread: ({ modelId, presetId, presetSnapshot, paramsSnapshot, title }) => {
        const id = createChatId('thread');
        const now = Date.now();
        const thread: ChatThread = {
          id,
          title: title ?? 'New Conversation',
          titleSource: title ? 'manual' : 'derived',
          modelId,
          activeModelId: modelId,
          presetId,
          presetSnapshot: {
            id: presetSnapshot.id,
            name: presetSnapshot.name,
            systemPrompt: presetSnapshot.systemPrompt,
          },
          paramsSnapshot: {
            temperature: paramsSnapshot.temperature,
            topP: paramsSnapshot.topP,
            topK: paramsSnapshot.topK ?? FALLBACK_TOP_K,
            minP: paramsSnapshot.minP ?? FALLBACK_MIN_P,
            repetitionPenalty: paramsSnapshot.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
            maxTokens: paramsSnapshot.maxTokens,
            reasoningEffort: normalizeReasoningEffort(
              paramsSnapshot.reasoningEffort,
              (paramsSnapshot as { reasoningEnabled?: unknown }).reasoningEnabled,
            ),
            seed: paramsSnapshot.seed ?? null,
          },
          messages: [],
          createdAt: now,
          updatedAt: now,
          status: 'idle',
        };

        set((state) => ({
          threads: {
            ...state.threads,
            [id]: thread,
          },
          activeThreadId: id,
        }));

        return id;
      },

      mergeImportedThreads: (threads) => {
        if (threads.length === 0) {
          return 0;
        }

        let importedCount = 0;

        set((state) => {
          const nextThreads = { ...state.threads };

          threads.forEach((thread) => {
            if (nextThreads[thread.id]) {
              return;
            }

            nextThreads[thread.id] = sanitizeHydratedThread(thread);
            importedCount += 1;
          });

          if (importedCount === 0) {
            return state;
          }

          const nextActiveThreadId =
            state.activeThreadId && nextThreads[state.activeThreadId]
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        });

        return importedCount;
      },

      pruneExpiredThreads: (retentionDays, now = Date.now()) => {
        const state = get();
        const expiredThreadIds = getExpiredThreadIds(state.threads, retentionDays, now, state.activeThreadId);
        if (expiredThreadIds.length === 0) {
          return 0;
        }

        let nextThreadsSnapshot: Record<string, ChatThread> | null = null;

        set((state) => {
          const nextThreads = { ...state.threads };
          expiredThreadIds.forEach((threadId) => {
            delete nextThreads[threadId];
          });
          nextThreadsSnapshot = nextThreads;

          const nextActiveThreadId =
            state.activeThreadId && nextThreads[state.activeThreadId]
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        });

        if (nextThreadsSnapshot) {
          clearPersistedChatStoreIfEmpty(nextThreadsSnapshot);
        }

        return expiredThreadIds.length;
      },

      clearAllThreads: () => {
        const threadCount = Object.keys(get().threads).length;
        if (threadCount === 0) {
          getAppStorage().remove(CHAT_STORE_STORAGE_KEY);
          return 0;
        }

        set({
          threads: {},
          activeThreadId: null,
        });
        getAppStorage().remove(CHAT_STORE_STORAGE_KEY);

        return threadCount;
      },

      setActiveThread: (threadId) => set({ activeThreadId: threadId }),

      updateThreadPresetSnapshot: (threadId, presetId, presetSnapshot) =>
        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                presetId,
                presetSnapshot: {
                  id: presetSnapshot.id,
                  name: presetSnapshot.name,
                  systemPrompt: presetSnapshot.systemPrompt,
                },
              }),
            },
          };
        }),

      updateThreadParamsSnapshot: (threadId, paramsSnapshot) =>
        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                paramsSnapshot: {
                  temperature: paramsSnapshot.temperature,
                  topP: paramsSnapshot.topP,
                  topK: paramsSnapshot.topK ?? FALLBACK_TOP_K,
                  minP: paramsSnapshot.minP ?? FALLBACK_MIN_P,
                  repetitionPenalty: paramsSnapshot.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
                  maxTokens: paramsSnapshot.maxTokens,
                  reasoningEffort: normalizeReasoningEffort(
                    paramsSnapshot.reasoningEffort,
                    (paramsSnapshot as { reasoningEnabled?: unknown }).reasoningEnabled,
                  ),
                  seed: paramsSnapshot.seed ?? null,
                },
              }),
            },
          };
        }),

      switchThreadModel: (threadId, nextModelId, at) => {
        let createdMessageId: string | null = null;

        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const prevModelId = getThreadActiveModelId(existingThread);
          if (nextModelId === prevModelId) {
            return state;
          }

          const requestedCreatedAt = at ?? Date.now();
          const lastMessageCreatedAt = existingThread.messages[existingThread.messages.length - 1]?.createdAt;
          const createdAt = typeof lastMessageCreatedAt === 'number'
            ? Math.max(requestedCreatedAt, lastMessageCreatedAt)
            : requestedCreatedAt;
          const updatedAt = Math.max(Date.now(), existingThread.updatedAt, createdAt);
          const messageId = createChatId('message');
          createdMessageId = messageId;

          const switchMessage: ChatMessage = {
            id: messageId,
            role: 'system',
            kind: 'model_switch',
            content: '',
            modelId: nextModelId,
            switchFromModelId: prevModelId,
            switchToModelId: nextModelId,
            createdAt,
            state: 'complete',
          };

          const nextThread: ChatThread = {
            ...existingThread,
            activeModelId: nextModelId,
            messages: [...existingThread.messages, switchMessage],
            updatedAt,
          };

          return {
            threads: {
              ...state.threads,
              [threadId]: nextThread,
            },
          };
        });

        return createdMessageId;
      },

      appendMessage: (threadId, message) =>
        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const kind = message.kind ?? 'message';
          const fallbackModelId = kind === 'model_switch'
            ? message.switchToModelId ?? getThreadActiveModelId(existingThread)
            : getThreadActiveModelId(existingThread);
          const normalizedMessage: ChatMessage = {
            ...message,
            kind,
            modelId: message.modelId ?? fallbackModelId,
          };

          const nextThread = updateThreadMetadata({
            ...existingThread,
            messages: [...existingThread.messages, normalizedMessage],
            status: normalizedMessage.role === 'assistant' && normalizedMessage.state === 'streaming'
              ? 'generating'
              : existingThread.status,
          });

          return {
            threads: {
              ...state.threads,
              [threadId]: nextThread,
            },
          };
        }),

      createAssistantPlaceholder: (threadId) => {
        const messageId = createChatId('message');
        get().appendMessage(threadId, {
          id: messageId,
          role: 'assistant',
          content: '',
          thoughtContent: undefined,
          createdAt: Date.now(),
          state: 'streaming',
        });
        return messageId;
      },

      stopAssistantMessage: (threadId, messageId) => {
        get().patchAssistantMessage(threadId, messageId, {
          state: 'stopped',
        });
      },

      finalizeAssistantMessage: (threadId, messageId, content, thoughtContent) => {
        get().patchAssistantMessage(threadId, messageId, {
          content,
          thoughtContent,
          state: 'complete',
          errorCode: undefined,
          errorMessage: undefined,
        });
      },

      deleteThread: (threadId) => {
        let nextThreadsSnapshot: Record<string, ChatThread> | null = null;

        set((state) => {
          if (!state.threads[threadId]) {
            return state;
          }

          const nextThreads = { ...state.threads };
          delete nextThreads[threadId];
          nextThreadsSnapshot = nextThreads;

          const nextActiveThreadId =
            state.activeThreadId !== threadId
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        });

        if (nextThreadsSnapshot) {
          clearPersistedChatStoreIfEmpty(nextThreadsSnapshot);
        }
      },

      renameThread: (threadId, title) => {
        const normalizedTitle = normalizeConversationTitle(title);
        const existingThread = get().threads[threadId];
        if (!existingThread) {
          return false;
        }

        set((state) => {
          const thread = state.threads[threadId];
          if (!thread) {
            return state;
          }

          const nextThread = updateThreadMetadata({
            ...thread,
            title: normalizedTitle || deriveThreadTitle(thread.messages),
            titleSource: normalizedTitle ? 'manual' : 'derived',
          });

          return {
            threads: {
              ...state.threads,
              [threadId]: nextThread,
            },
          };
        });

        return true;
      },

      deleteMessageBranch: (threadId, messageId) => {
        const thread = get().threads[threadId];
        if (!thread) {
          return false;
        }

        const targetIndex = thread.messages.findIndex((message) => message.id === messageId);
        if (targetIndex < 0) {
          return false;
        }

        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const nextMessages = existingThread.messages.slice(0, targetIndex);

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                messages: nextMessages,
                summary: undefined,
                status: 'idle',
              }),
            },
          };
        });

        return true;
      },

      patchAssistantMessage: (threadId, messageId, updates) =>
        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const messages = existingThread.messages;
          if (messages.length === 0) {
            return state;
          }

          const lastIndex = messages.length - 1;
          const targetIndex =
            messages[lastIndex]?.id === messageId
              ? lastIndex
              : messages.findIndex((message) => message.id === messageId);

          if (targetIndex < 0) {
            return state;
          }

          const nextMessages = messages.slice();
          nextMessages[targetIndex] = { ...messages[targetIndex], ...updates };

          const nextStatus =
            updates.state === 'streaming'
              ? 'generating'
              : updates.state === 'stopped'
                ? 'stopped'
                : updates.state === 'error'
                  ? 'error'
                  : existingThread.status === 'generating'
                    ? 'idle'
                    : existingThread.status;

          const shouldUpdateMetadata = Boolean(updates.state && updates.state !== 'streaming');
          const nextThreadBase: ChatThread = {
            ...existingThread,
            messages: nextMessages,
            status: nextStatus,
            lastGeneratedAt:
              updates.state && updates.state !== 'streaming'
                ? Date.now()
                : existingThread.lastGeneratedAt,
          };
          const nextThread = shouldUpdateMetadata
            ? updateThreadMetadata(nextThreadBase)
            : nextThreadBase;

          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...nextThread,
              },
            },
          };
        }),

      replaceLastAssistantMessage: (threadId) => {
        const thread = get().threads[threadId];
        if (!thread) {
          return null;
        }

        const target = [...thread.messages].reverse().find((message) => message.role === 'assistant');
        if (!target) {
          return null;
        }

        const nextMessageId = createChatId('message');

        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const modelId = getThreadActiveModelId(existingThread);

          const nextMessages = existingThread.messages.map((message): ChatMessage =>
            message.id === target.id
              ? {
                  id: nextMessageId,
                  role: 'assistant' as ChatMessageRole,
                  content: '',
                  thoughtContent: undefined,
                  createdAt: Date.now(),
                  state: 'streaming' as ChatMessageState,
                  regeneratesMessageId: target.id,
                  kind: 'message',
                  modelId,
                }
              : message,
          );

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                messages: nextMessages,
                status: 'generating',
              }),
            },
          };
        });

        return nextMessageId;
      },

      replaceBranchFromUserMessage: (threadId, messageId, nextUserContent) => {
        const thread = get().threads[threadId];
        if (!thread) {
          return null;
        }

        const targetMessage = thread.messages.find((message) => message.id === messageId);
        if (!targetMessage || targetMessage.role !== 'user') {
          return null;
        }

        const targetIndex = thread.messages.findIndex((message) => message.id === messageId);
        if (targetIndex < 0) {
          return null;
        }

        const nextAssistantMessageId = createChatId('message');

        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const modelId = getThreadActiveModelId(existingThread);

          const existingTargetMessage = existingThread.messages[targetIndex];
          if (!existingTargetMessage || existingTargetMessage.role !== 'user') {
            return state;
          }

          const nextMessages: ChatMessage[] = [
            ...existingThread.messages.slice(0, targetIndex),
            {
              ...existingTargetMessage,
              content: nextUserContent,
              state: 'complete',
              tokensPerSec: undefined,
              errorCode: undefined,
              errorMessage: undefined,
              regeneratesMessageId: undefined,
              kind: 'message',
              modelId: existingTargetMessage.modelId ?? modelId,
            },
            {
              id: nextAssistantMessageId,
              role: 'assistant',
              content: '',
              thoughtContent: undefined,
              createdAt: Date.now(),
              state: 'streaming',
              kind: 'message',
              modelId,
            },
          ];

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                messages: nextMessages,
                summary: undefined,
                status: 'generating',
              }),
            },
          };
        });

        return nextAssistantMessageId;
      },

      finalizeThreadStatus: (threadId, status) =>
        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...existingThread,
                status,
                updatedAt: Date.now(),
                lastGeneratedAt: Date.now(),
              },
            },
          };
        }),

      setThreadSummary: (threadId, summary) =>
        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...updateThreadMetadata({
                  ...existingThread,
                  summary,
                }),
              },
            },
          };
        }),

      getThread: (threadId) => (threadId ? get().threads[threadId] ?? null : null),
      getActiveThread: () => {
        const { activeThreadId, threads } = get();
        return activeThreadId ? threads[activeThreadId] ?? null : null;
      },
      getConversationIndex: () =>
        buildConversationIndex(get().threads),
    }),
    {
      name: 'chat-store',
      version: 1,
      skipHydration: true,
      storage: createJSONStorage(() => chatStoreStateStorage),
      partialize: (state) => ({
        threads: (() => {
          const threads = state.threads;
          const hasAnyGeneratingThread = Object.values(threads).some((thread) =>
            thread.status === 'generating',
          );

          if (!hasAnyGeneratingThread) {
            return threads;
          }

          return Object.fromEntries(
            Object.entries(threads).map(([threadId, thread]) => {
              if (thread.status !== 'generating') {
                return [threadId, thread];
              }

              const stoppedStatus = 'stopped';
              return [
                threadId,
                {
                  ...thread,
                  status: stoppedStatus,
                  messages: thread.messages.filter((message) => message.state !== 'streaming'),
                },
              ];
            }),
          );
        })(),
        activeThreadId: state.activeThreadId,
      }),
      migrate: (persistedState, version) => {
        const state = (persistedState ?? {}) as Partial<Pick<ChatStoreState, 'threads' | 'activeThreadId'>>;
        const threads = (state.threads ?? {}) as Record<string, ChatThread>;

        const sanitizedThreads = Object.fromEntries(
          Object.entries(threads).map(([threadId, thread]) => [threadId, sanitizeHydratedThread(thread)]),
        );

        const resolvedActiveThreadId = state.activeThreadId && sanitizedThreads[state.activeThreadId]
          ? state.activeThreadId
          : findMostRecentThreadId(sanitizedThreads);

        void version;

        return {
          threads: sanitizedThreads,
          activeThreadId: resolvedActiveThreadId,
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }

        const sanitizedThreads = Object.fromEntries(
          Object.entries(state.threads).map(([threadId, thread]) => [
            threadId,
            sanitizeHydratedThread(thread),
          ]),
        );

        state.threads = sanitizedThreads;

        if (state.activeThreadId && !sanitizedThreads[state.activeThreadId]) {
          state.activeThreadId = findMostRecentThreadId(sanitizedThreads);
        }
      },
    },
  ),
);
export type { ThreadInferenceWindow, ThreadInferenceWindowOptions } from '../utils/inferenceWindow';
export {
  DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS,
  buildThreadMessagesForInference,
  estimateLlmMessageTokens,
  estimateLlmMessagesTokens,
  getThreadInferenceWindow,
} from '../utils/inferenceWindow';
