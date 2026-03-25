import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from '../store/storage';
import {
  ChatMessage,
  ChatMessageRole,
  ChatMessageState,
  ChatSummary,
  ChatThread,
  ChatThreadStatus,
  ConversationIndexItem,
  GenerationParamsSnapshot,
  LlmChatMessage,
  PresetSnapshot,
  createChatId,
  deriveThreadTitle,
  normalizeConversationTitle,
  sanitizeHydratedThread,
  toConversationIndexItem,
} from '../types/chat';

const FALLBACK_TOP_K = 40;
const FALLBACK_MIN_P = 0.05;
const FALLBACK_REPETITION_PENALTY = 1;

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
  appendMessage: (threadId: string, message: ChatMessage) => void;
  createAssistantPlaceholder: (threadId: string) => string;
  stopAssistantMessage: (threadId: string, messageId: string) => void;
  finalizeAssistantMessage: (threadId: string, messageId: string, content: string) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => boolean;
  deleteMessageBranch: (threadId: string, messageId: string) => boolean;
  patchAssistantMessage: (
    threadId: string,
    messageId: string,
    updates: Partial<Pick<ChatMessage, 'content' | 'tokensPerSec' | 'state' | 'errorCode'>>,
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
              : Object.values(nextThreads).sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        });

        return importedCount;
      },

      pruneExpiredThreads: (retentionDays, now = Date.now()) => {
        const expiredThreadIds = getExpiredThreadIds(get().threads, retentionDays, now, get().activeThreadId);
        if (expiredThreadIds.length === 0) {
          return 0;
        }

        set((state) => {
          const nextThreads = { ...state.threads };
          expiredThreadIds.forEach((threadId) => {
            delete nextThreads[threadId];
          });

          const nextActiveThreadId =
            state.activeThreadId && nextThreads[state.activeThreadId]
              ? state.activeThreadId
              : Object.values(nextThreads).sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        });

        return expiredThreadIds.length;
      },

      clearAllThreads: () => {
        const threadCount = Object.keys(get().threads).length;
        if (threadCount === 0) {
          return 0;
        }

        set({
          threads: {},
          activeThreadId: null,
        });

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
              [threadId]: {
                ...existingThread,
                paramsSnapshot: {
                  temperature: paramsSnapshot.temperature,
                  topP: paramsSnapshot.topP,
                  topK: paramsSnapshot.topK ?? FALLBACK_TOP_K,
                  minP: paramsSnapshot.minP ?? FALLBACK_MIN_P,
                  repetitionPenalty: paramsSnapshot.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
                  maxTokens: paramsSnapshot.maxTokens,
                },
              },
            },
          };
        }),

      appendMessage: (threadId, message) =>
        set((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const nextThread = updateThreadMetadata({
            ...existingThread,
            messages: [...existingThread.messages, message],
            status: message.role === 'assistant' && message.state === 'streaming'
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

      finalizeAssistantMessage: (threadId, messageId, content) => {
        get().patchAssistantMessage(threadId, messageId, {
          content,
          state: 'complete',
          errorCode: undefined,
        });
      },

      deleteThread: (threadId) =>
        set((state) => {
          if (!state.threads[threadId]) {
            return state;
          }

          const nextThreads = { ...state.threads };
          delete nextThreads[threadId];

          const nextActiveThreadId =
            state.activeThreadId !== threadId
              ? state.activeThreadId
              : Object.values(nextThreads).sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        }),

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

          const nextMessages = existingThread.messages.map((message) =>
            message.id === messageId ? { ...message, ...updates } : message,
          );

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

          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...updateThreadMetadata({
                  ...existingThread,
                  messages: nextMessages,
                  status: nextStatus,
                  lastGeneratedAt:
                    updates.state && updates.state !== 'streaming'
                      ? Date.now()
                      : existingThread.lastGeneratedAt,
                }),
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

          const nextMessages = existingThread.messages.map((message): ChatMessage =>
            message.id === target.id
              ? {
                  id: nextMessageId,
                  role: 'assistant' as ChatMessageRole,
                  content: '',
                  createdAt: Date.now(),
                  state: 'streaming' as ChatMessageState,
                  regeneratesMessageId: target.id,
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
              regeneratesMessageId: undefined,
            },
            {
              id: nextAssistantMessageId,
              role: 'assistant',
              content: '',
              createdAt: Date.now(),
              state: 'streaming',
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
        Object.values(get().threads)
          .map(toConversationIndexItem)
          .sort((left, right) => right.updatedAt - left.updatedAt),
    }),
    {
      name: 'chat-store',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        threads: state.threads,
        activeThreadId: state.activeThreadId,
      }),
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
          const latestThread = Object.values(sanitizedThreads).sort(
            (left, right) => right.updatedAt - left.updatedAt,
          )[0];
          state.activeThreadId = latestThread?.id ?? null;
        }
      },
    },
  ),
);

export interface ThreadInferenceWindow {
  messages: LlmChatMessage[];
  truncatedMessageIds: string[];
}

export interface ThreadInferenceWindowOptions {
  maxContextMessages: number;
  maxContextTokens?: number;
  responseReserveTokens?: number;
  promptSafetyMarginTokens?: number;
}

const CHARS_PER_ESTIMATED_TOKEN = 4;
const MESSAGE_TOKEN_OVERHEAD = 6;
export const DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS = 64;

export function estimateLlmMessageTokens(message: LlmChatMessage) {
  return Math.max(1, Math.ceil(message.content.trim().length / CHARS_PER_ESTIMATED_TOKEN)) + MESSAGE_TOKEN_OVERHEAD;
}

export function estimateLlmMessagesTokens(messages: LlmChatMessage[]) {
  return messages.reduce((total, message) => total + estimateLlmMessageTokens(message), 0);
}

function getMinimumRequiredHistoryTokens(historyMessages: LlmChatMessage[]) {
  if (historyMessages.length === 0) {
    return 0;
  }

  const lastMessage = historyMessages[historyMessages.length - 1];
  let total = estimateLlmMessageTokens(lastMessage);

  if (lastMessage.role === 'assistant') {
    const previousMessage = historyMessages[historyMessages.length - 2];
    if (previousMessage?.role === 'user') {
      total += estimateLlmMessageTokens(previousMessage);
    }
  }

  return total;
}

function resolveInferenceWindowOptions(
  optionsOrMaxContextMessages: number | ThreadInferenceWindowOptions,
): ThreadInferenceWindowOptions {
  if (typeof optionsOrMaxContextMessages === 'number') {
    return {
      maxContextMessages: optionsOrMaxContextMessages,
    };
  }

  return optionsOrMaxContextMessages;
}

export function getThreadInferenceWindow(
  thread: ChatThread,
  optionsOrMaxContextMessages: number | ThreadInferenceWindowOptions,
  latestUserMessage?: ChatMessage,
): ThreadInferenceWindow {
  const options = resolveInferenceWindowOptions(optionsOrMaxContextMessages);
  const systemMessages: LlmChatMessage[] = [];

  if (thread.presetSnapshot.systemPrompt.trim().length > 0) {
    systemMessages.push({
      role: 'system',
      content: thread.presetSnapshot.systemPrompt,
    });
  }

  if (thread.summary) {
    systemMessages.push({
      role: 'system',
      content: `Conversation summary:\n${thread.summary.content}`,
    });
  }

  const eligibleMessages = thread.messages.filter(
    (message) => message.state !== 'error' && message.content.trim().length > 0,
  );
  const historyMessages = eligibleMessages.map<LlmChatMessage>((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (
    latestUserMessage &&
    !historyMessages.some((message) => message.content === latestUserMessage.content && message.role === 'user')
  ) {
    historyMessages.push({
      role: 'user',
      content: latestUserMessage.content,
    });
  }

  const reservedSlots = Math.min(systemMessages.length, options.maxContextMessages);
  const maxHistoryMessages = Math.max(options.maxContextMessages - reservedSlots, 0);
  let effectiveHistoryStartIndex =
    historyMessages.length <= maxHistoryMessages
      ? 0
      : historyMessages.length - maxHistoryMessages;
  let normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
  let promptTokenBudget: number | null = null;

  if (typeof options.maxContextTokens === 'number' && options.maxContextTokens > 0) {
    const targetReservedResponseTokens = Math.max(
      0,
      Math.round(options.responseReserveTokens ?? thread.paramsSnapshot.maxTokens),
    );
    const systemTokenCount = estimateLlmMessagesTokens(systemMessages);
    const promptSafetyMargin = Math.max(
      0,
      Math.round(options.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
    );
    const totalPromptBudget = Math.max(
      0,
      Math.round(options.maxContextTokens) - promptSafetyMargin - systemTokenCount,
    );
    const minimumRequiredHistoryTokens = getMinimumRequiredHistoryTokens(normalizedHistoryMessages);
    const canFitMinimumRequiredHistory =
      minimumRequiredHistoryTokens === 0 || minimumRequiredHistoryTokens <= totalPromptBudget;
    const effectiveReservedResponseTokens = canFitMinimumRequiredHistory
      ? Math.min(
          targetReservedResponseTokens,
          Math.max(totalPromptBudget - minimumRequiredHistoryTokens, 0),
        )
      : 0;

    promptTokenBudget = Math.max(
      0,
      totalPromptBudget - effectiveReservedResponseTokens,
    );

    let consumedPromptTokens = 0;
    let nextHistoryCount = 0;

    for (let index = normalizedHistoryMessages.length - 1; index >= 0; index -= 1) {
      const messageTokens = estimateLlmMessageTokens(normalizedHistoryMessages[index]);
      const canFitMore = consumedPromptTokens + messageTokens <= promptTokenBudget;

      if (!canFitMore) {
        break;
      }

      consumedPromptTokens += messageTokens;
      nextHistoryCount += 1;
    }

    if (
      nextHistoryCount === 0 &&
      normalizedHistoryMessages.length > 0 &&
      !canFitMinimumRequiredHistory
    ) {
      nextHistoryCount = 1;
    }

    effectiveHistoryStartIndex = historyMessages.length - nextHistoryCount;
    normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
  }

  const shouldBackfillLeadingUserMessage =
    promptTokenBudget != null &&
    effectiveHistoryStartIndex > 0 &&
    normalizedHistoryMessages.length > 0 &&
    normalizedHistoryMessages[0]?.role === 'assistant' &&
    historyMessages[effectiveHistoryStartIndex - 1]?.role === 'user';

  if (shouldBackfillLeadingUserMessage && promptTokenBudget != null) {
    const resolvedPromptTokenBudget = promptTokenBudget;
    const leadingUserMessage = historyMessages[effectiveHistoryStartIndex - 1];
    const leadingUserTokens = estimateLlmMessageTokens(leadingUserMessage);
    const canBackfillLeadingUserMessage =
      estimateLlmMessagesTokens(normalizedHistoryMessages) + leadingUserTokens
        <= resolvedPromptTokenBudget;

    if (canBackfillLeadingUserMessage) {
      effectiveHistoryStartIndex -= 1;
      normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
    } else if (
      normalizedHistoryMessages.length === 1 &&
      leadingUserTokens <= resolvedPromptTokenBudget
    ) {
      effectiveHistoryStartIndex -= 1;
      normalizedHistoryMessages = [leadingUserMessage];
    }
  }

  while (
    effectiveHistoryStartIndex > 0 &&
    normalizedHistoryMessages.length > 0 &&
    normalizedHistoryMessages[0]?.role === 'assistant'
  ) {
    effectiveHistoryStartIndex += 1;
    normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
  }

  const truncatedMessageIds = eligibleMessages
    .slice(0, effectiveHistoryStartIndex)
    .map((message) => message.id);

  return {
    messages: [...systemMessages, ...normalizedHistoryMessages],
    truncatedMessageIds,
  };
}

export function buildThreadMessagesForInference(
  thread: ChatThread,
  latestUserMessage?: ChatMessage,
  optionsOrMaxContextMessages: number | ThreadInferenceWindowOptions = Number.MAX_SAFE_INTEGER,
) {
  return getThreadInferenceWindow(thread, optionsOrMaxContextMessages, latestUserMessage).messages;
}
