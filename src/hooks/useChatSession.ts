import { AppState, AppStateStatus } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { llmEngineService } from '../services/LLMEngineService';
import { performanceMonitor } from '../services/PerformanceMonitor';
import { GenerationParameters, getGenerationParametersForModel, getSettings } from '../services/SettingsStore';
import { presetManager } from '../services/PresetManager';
import { EngineStatus } from '../types/models';
import {
  ChatMessage,
  ChatThread,
  DEFAULT_PRESET_SNAPSHOT,
  DEFAULT_SYSTEM_PROMPT,
  LlmChatMessage,
  PresetSnapshot,
  createChatId,
} from '../types/chat';
import {
  DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS,
  estimateLlmMessagesTokens,
  getThreadInferenceWindow,
  type ThreadInferenceWindowOptions,
  useChatStore,
} from '../store/chatStore';
import { getVisibleMessageContent } from '../utils/chatPresentation';
import { syncThreadParameters } from '../utils/chatThreadParameters';

export const SUMMARY_PLACEHOLDER_CONTENT =
  'Summary generation is not available yet. Older messages stay visible in the thread, but only the most recent context is sent to the model right now.';
export const SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES = 1;
const DEFAULT_CONTEXT_SIZE = 4096;
const DEFAULT_RESPONSE_RESERVE_TOKENS = 256;
const STREAM_PATCH_INTERVAL_MS = 100;

interface ActiveGenerationState {
  threadId: string;
  messageId: string;
  stopRequested: boolean;
}

const sharedGenerationState: { current: ActiveGenerationState | null } = {
  current: null,
};

function isMatchingGeneration(threadId: string, messageId: string) {
  return (
    sharedGenerationState.current?.threadId === threadId &&
    sharedGenerationState.current?.messageId === messageId
  );
}

export function resetSharedGenerationStateForTests() {
  sharedGenerationState.current = null;
}

export function resolvePresetSnapshot(presetId: string | null): PresetSnapshot {
  if (!presetId) {
    return { ...DEFAULT_PRESET_SNAPSHOT };
  }

  const preset = presetManager.getPreset(presetId);
  if (!preset) {
    return {
      id: presetId,
      name: 'Missing Preset',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };
  }

  return {
    id: preset.id,
    name: preset.name,
    systemPrompt: preset.systemPrompt,
  };
}

interface InferenceBudgetOptions {
  maxContextMessages?: number;
  maxContextTokens?: number;
  responseReserveTokens?: number;
  promptSafetyMarginTokens?: number;
}

function resolveInferenceOptions(
  thread: ChatThread,
  options?: InferenceBudgetOptions,
): ThreadInferenceWindowOptions {
  return {
    maxContextMessages: options?.maxContextMessages ?? Number.MAX_SAFE_INTEGER,
    maxContextTokens: options?.maxContextTokens,
    responseReserveTokens: options?.responseReserveTokens
      ?? Math.min(thread.paramsSnapshot.maxTokens, DEFAULT_RESPONSE_RESERVE_TOKENS),
    promptSafetyMarginTokens: options?.promptSafetyMarginTokens,
  };
}

export function buildInferenceMessagesForThread(thread: ChatThread, options?: InferenceBudgetOptions) {
  return getThreadInferenceWindow(thread, resolveInferenceOptions(thread, options)).messages;
}

function getEligibleThreadMessages(thread: ChatThread): ChatMessage[] {
  return thread.messages.filter(
    (message) =>
      message.state !== 'error'
      && getVisibleMessageContent(message.role, message.content).trim().length > 0,
  );
}

function createTruncationState(truncatedMessageIds: string[]) {
  return {
    truncatedMessageIds,
    shouldOfferSummary:
      truncatedMessageIds.length >= SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES,
  };
}

async function buildInferenceWindowWithAccurateTokenCounts(
  thread: ChatThread,
  options: ThreadInferenceWindowOptions,
): Promise<{
  messages: LlmChatMessage[];
  promptTokens: number;
  promptSafetyMarginTokens: number;
  truncatedMessageIds: string[];
}> {
  const maxContextTokens =
    typeof options.maxContextTokens === 'number' && options.maxContextTokens > 0
      ? Math.round(options.maxContextTokens)
      : null;
  const promptSafetyMarginTokens = Math.max(
    0,
    Math.round(options.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
  );
  const responseReserveTokens = Math.max(
    0,
    Math.round(options.responseReserveTokens ?? thread.paramsSnapshot.maxTokens),
  );

  const tokenCountParams = {
    enable_thinking: thread.paramsSnapshot.reasoningEnabled === true,
    reasoning_format: thread.paramsSnapshot.reasoningEnabled === true ? ('auto' as const) : ('none' as const),
  };

  const countPromptTokens = async (messages: LlmChatMessage[]) =>
    llmEngineService.countPromptTokens({
      messages,
      params: tokenCountParams,
    });

  const { messages: fullMessages, truncatedMessageIds: baseTruncatedMessageIds } = getThreadInferenceWindow(thread, {
    maxContextMessages: options.maxContextMessages,
  });
  const eligibleMessages = getEligibleThreadMessages(thread);

  if (maxContextTokens === null) {
    return {
      messages: fullMessages,
      promptTokens: await countPromptTokens(fullMessages),
      promptSafetyMarginTokens,
      truncatedMessageIds: baseTruncatedMessageIds,
    };
  }

  const systemMessages: LlmChatMessage[] = [];
  let firstHistoryIndex = 0;
  while (firstHistoryIndex < fullMessages.length && fullMessages[firstHistoryIndex]?.role === 'system') {
    systemMessages.push(fullMessages[firstHistoryIndex]);
    firstHistoryIndex += 1;
  }

  const historyMessages = fullMessages.slice(firstHistoryIndex);
  const historyMessageIds = eligibleMessages
    .slice(baseTruncatedMessageIds.length, baseTruncatedMessageIds.length + historyMessages.length)
    .map((message) => message.id);
  if (historyMessages.length === 0) {
    return {
      messages: fullMessages,
      promptTokens: await countPromptTokens(fullMessages),
      promptSafetyMarginTokens,
      truncatedMessageIds: baseTruncatedMessageIds,
    };
  }

  const promptTokenBudget = Math.max(
    0,
    maxContextTokens - promptSafetyMarginTokens - responseReserveTokens,
  );

  const tokenCountCache = new Map<number, number>();
  const countTokensForHistoryStart = async (historyStartIndex: number) => {
    if (tokenCountCache.has(historyStartIndex)) {
      return tokenCountCache.get(historyStartIndex)!;
    }

    const tokens = await countPromptTokens([
      ...systemMessages,
      ...historyMessages.slice(historyStartIndex),
    ]);
    tokenCountCache.set(historyStartIndex, tokens);
    return tokens;
  };

  const lastHistoryIndex = historyMessages.length - 1;
  const fitsBudget = async (historyStartIndex: number) =>
    (await countTokensForHistoryStart(historyStartIndex)) <= promptTokenBudget;

  let effectiveHistoryStartIndex = 0;

  if (await fitsBudget(0)) {
    effectiveHistoryStartIndex = 0;
  } else if (!(await fitsBudget(lastHistoryIndex))) {
    effectiveHistoryStartIndex = lastHistoryIndex;
  } else {
    let low = 0;
    let high = lastHistoryIndex;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (await fitsBudget(mid)) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    effectiveHistoryStartIndex = low;
  }

  let normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);

  const shouldBackfillLeadingUserMessage =
    effectiveHistoryStartIndex > 0 &&
    normalizedHistoryMessages.length > 0 &&
    normalizedHistoryMessages[0]?.role === 'assistant' &&
    historyMessages[effectiveHistoryStartIndex - 1]?.role === 'user';

  if (shouldBackfillLeadingUserMessage) {
    const leadingUserMessage = historyMessages[effectiveHistoryStartIndex - 1];
    const canBackfillLeadingUserMessage =
      (await countTokensForHistoryStart(effectiveHistoryStartIndex - 1)) <= promptTokenBudget;

    if (canBackfillLeadingUserMessage) {
      effectiveHistoryStartIndex -= 1;
      normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
    } else if (normalizedHistoryMessages.length === 1) {
      const userOnlyTokens = await countPromptTokens([...systemMessages, leadingUserMessage]);
      if (userOnlyTokens <= promptTokenBudget) {
        effectiveHistoryStartIndex -= 1;
        normalizedHistoryMessages = [leadingUserMessage];
      }
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

  const windowMessages = [...systemMessages, ...normalizedHistoryMessages];
  const truncatedMessageIds = [
    ...baseTruncatedMessageIds,
    ...historyMessageIds.slice(0, effectiveHistoryStartIndex),
  ];

  return {
    messages: windowMessages,
    promptTokens: await countTokensForHistoryStart(effectiveHistoryStartIndex),
    promptSafetyMarginTokens,
    truncatedMessageIds,
  };
}

export function getThreadTruncationState(thread: ChatThread, options?: InferenceBudgetOptions) {
  const { truncatedMessageIds } = getThreadInferenceWindow(thread, resolveInferenceOptions(thread, options));

  return createTruncationState(truncatedMessageIds);
}

const EMPTY_TRUNCATION_STATE: ReturnType<typeof getThreadTruncationState> = {
  truncatedMessageIds: [],
  shouldOfferSummary: false,
};

export const useChatSession = () => {
  const activeThread = useChatStore((state) => state.getActiveThread());
  const createThread = useChatStore((state) => state.createThread);
  const appendMessage = useChatStore((state) => state.appendMessage);
  const createAssistantPlaceholder = useChatStore((state) => state.createAssistantPlaceholder);
  const deleteMessageBranch = useChatStore((state) => state.deleteMessageBranch);
  const deleteThreadState = useChatStore((state) => state.deleteThread);
  const stopAssistantMessage = useChatStore((state) => state.stopAssistantMessage);
  const finalizeAssistantMessage = useChatStore((state) => state.finalizeAssistantMessage);
  const patchAssistantMessage = useChatStore((state) => state.patchAssistantMessage);
  const replaceBranchFromUserMessage = useChatStore((state) => state.replaceBranchFromUserMessage);
  const replaceLastAssistantMessage = useChatStore((state) => state.replaceLastAssistantMessage);
  const renameThreadState = useChatStore((state) => state.renameThread);
  const finalizeThreadStatus = useChatStore((state) => state.finalizeThreadStatus);
  const setActiveThread = useChatStore((state) => state.setActiveThread);
  const setThreadSummary = useChatStore((state) => state.setThreadSummary);
  const updateThreadParamsSnapshot = useChatStore((state) => state.updateThreadParamsSnapshot);

  const activeContextTokenBudget =
    activeThread &&
    llmEngineService.getState().status === EngineStatus.READY &&
    llmEngineService.getState().activeModelId === activeThread.modelId
      ? llmEngineService.getContextSize()
      : undefined;

  const activeThreadId = activeThread?.id ?? null;
  const activeThreadStatus = activeThread?.status ?? null;
  const [accurateTruncationState, setAccurateTruncationState] = useState<{
    threadId: string;
    state: ReturnType<typeof getThreadTruncationState>;
  } | null>(null);
  const accurateTruncationCacheRef = useRef<{ key: string | null; state: ReturnType<typeof getThreadTruncationState> }>({
    key: null,
    state: EMPTY_TRUNCATION_STATE,
  });

  const truncationCacheRef = useRef<{ threadId: string | null; state: ReturnType<typeof getThreadTruncationState> }>({
    threadId: null,
    state: EMPTY_TRUNCATION_STATE,
  });
  const heuristicTruncationState = useMemo(() => {
    if (!activeThread) {
      return EMPTY_TRUNCATION_STATE;
    }

    return getThreadTruncationState(activeThread, {
      maxContextTokens: activeContextTokenBudget,
    });
  }, [activeContextTokenBudget, activeThread]);
  useEffect(() => {
    if (!activeThread || activeThread.status === 'generating') {
      setAccurateTruncationState(null);
      return;
    }

    if (activeContextTokenBudget === undefined) {
      setAccurateTruncationState(null);
      return;
    }

    let isCancelled = false;
    const windowOptions = resolveInferenceOptions(activeThread, {
      maxContextTokens: activeContextTokenBudget,
    });
    const cacheKey = [
      activeThread.id,
      activeThread.updatedAt,
      activeContextTokenBudget,
      windowOptions.responseReserveTokens ?? null,
      windowOptions.promptSafetyMarginTokens ?? null,
      activeThread.paramsSnapshot.reasoningEnabled === true ? 1 : 0,
    ].join(':');

    if (accurateTruncationCacheRef.current.key === cacheKey) {
      setAccurateTruncationState({
        threadId: activeThread.id,
        state: accurateTruncationCacheRef.current.state,
      });
      return;
    }

    setAccurateTruncationState(null);

    void buildInferenceWindowWithAccurateTokenCounts(activeThread, windowOptions)
      .then(({ truncatedMessageIds }) => {
        if (!isCancelled) {
          const state = createTruncationState(truncatedMessageIds);
          accurateTruncationCacheRef.current = { key: cacheKey, state };
          setAccurateTruncationState({
            threadId: activeThread.id,
            state,
          });
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          console.warn('[ChatSession] Failed to resolve truncation state accurately, falling back to heuristics', error);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeContextTokenBudget, activeThread]);
  const truncationState = useMemo(() => {
    if (!activeThread) {
      return EMPTY_TRUNCATION_STATE;
    }

    if (activeThread.status === 'generating') {
      return truncationCacheRef.current.threadId === activeThread.id
        ? truncationCacheRef.current.state
        : EMPTY_TRUNCATION_STATE;
    }

    if (accurateTruncationState?.threadId === activeThread.id) {
      return accurateTruncationState.state;
    }

    return heuristicTruncationState;
  }, [accurateTruncationState, activeThread, heuristicTruncationState]);
  useEffect(() => {
    if (!activeThreadId) {
      truncationCacheRef.current = { threadId: null, state: EMPTY_TRUNCATION_STATE };
      return;
    }

    if (activeThreadStatus === 'generating') {
      return;
    }

    truncationCacheRef.current = {
      threadId: activeThreadId,
      state: truncationState,
    };
  }, [activeThreadId, activeThreadStatus, truncationState]);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState ?? 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const previousAppState = appStateRef.current;
      appStateRef.current = nextAppState;

      const returnedToForeground =
        (previousAppState === 'background' || previousAppState === 'inactive') &&
        nextAppState === 'active';

      if (!returnedToForeground) {
        return;
      }

      const state = useChatStore.getState();
      const activeThread = state.getActiveThread();

      // Recovery path: if the app returns with persisted "generating" state but
      // no live completion in flight, treat it as an interrupted session.
      if (activeThread?.status === 'generating' && !sharedGenerationState.current) {
        state.finalizeThreadStatus(activeThread.id, 'stopped');
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const runAssistantCompletion = useCallback(async (threadId: string, assistantMessageId: string) => {
    const thread = useChatStore.getState().getThread(threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }

    performanceMonitor.mark('chat.send.start', { modelId: thread.modelId });
    const generationSpan = performanceMonitor.startSpan('chat.generation', { modelId: thread.modelId });

    sharedGenerationState.current = {
      threadId,
      messageId: assistantMessageId,
      stopRequested: false,
    };

    let currentText = '';
    let currentThoughtText = '';
    let tokensCount = 0;
    let hasMarkedFirstToken = false;
    const startTime = Date.now();
    let flushTimeout: ReturnType<typeof setTimeout> | null = null;

    const recordCompletionStats = (outcome: 'success' | 'stopped' | 'error') => {
      const elapsedSec = (Date.now() - startTime) / 1000;
      const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;

      const existingTokensPerSec = performanceMonitor.snapshot().counters['chat.tokensPerSec'] ?? 0;
      performanceMonitor.incrementCounter('chat.tokensPerSec', tokensPerSec - existingTokensPerSec);

      performanceMonitor.mark('chat.generation.outcome', {
        outcome,
        modelId: thread.modelId,
        tokensCount,
        tokensPerSec,
      });

      generationSpan.end({ outcome, tokensCount, tokensPerSec });
    };

    const maxContextSize =
      typeof llmEngineService.getContextSize === 'function'
        ? llmEngineService.getContextSize()
        : DEFAULT_CONTEXT_SIZE;

    const flushAssistantPatch = () => {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }

      const elapsedSec = (Date.now() - startTime) / 1000;
      const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;

      patchAssistantMessage(threadId, assistantMessageId, {
        content: currentText,
        thoughtContent: currentThoughtText || undefined,
        tokensPerSec,
        state: 'streaming',
      });
    };

    const scheduleAssistantPatch = () => {
      if (flushTimeout) {
        return;
      }

      flushTimeout = setTimeout(() => {
        flushTimeout = null;
        flushAssistantPatch();
      }, STREAM_PATCH_INTERVAL_MS);
    };

    try {
      const windowOptions = resolveInferenceOptions(thread, { maxContextTokens: maxContextSize });
      const { messages, promptTokens, promptSafetyMarginTokens } =
        await buildInferenceWindowWithAccurateTokenCounts(thread, windowOptions)
          .catch((error) => {
            console.warn('[ChatSession] Failed to count prompt tokens accurately, falling back to heuristics', error);
            const messages = getThreadInferenceWindow(thread, windowOptions).messages;
            return {
              messages,
              promptTokens: estimateLlmMessagesTokens(messages),
              promptSafetyMarginTokens: Math.max(
                0,
                Math.round(windowOptions.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
              ),
            };
          });
      const maxPredictTokens = Math.max(
        1,
        maxContextSize - promptTokens - promptSafetyMarginTokens,
      );

      const completion = await llmEngineService.chatCompletion({
        messages,
        params: {
          temperature: thread.paramsSnapshot.temperature,
          top_p: thread.paramsSnapshot.topP,
          top_k: thread.paramsSnapshot.topK,
          min_p: thread.paramsSnapshot.minP,
          penalty_repeat: thread.paramsSnapshot.repetitionPenalty,
          n_predict: Math.min(thread.paramsSnapshot.maxTokens, maxPredictTokens),
          seed: thread.paramsSnapshot.seed ?? undefined,
          enable_thinking: thread.paramsSnapshot.reasoningEnabled === true,
          reasoning_format: thread.paramsSnapshot.reasoningEnabled === true ? 'auto' : 'none',
        },
        onToken: (token) => {
          if (!hasMarkedFirstToken) {
            hasMarkedFirstToken = true;
            performanceMonitor.mark('chat.firstToken', { modelId: thread.modelId });
          }

          if (typeof token === 'string') {
            currentText += token;
          } else {
            if (token.content !== undefined) {
              currentText = token.content;
            } else if (typeof token.accumulatedText === 'string' && token.accumulatedText.length >= currentText.length) {
              currentText = token.accumulatedText;
            } else if (token.reasoningContent === undefined) {
              currentText += token.token;
            }

            if (token.reasoningContent !== undefined) {
              currentThoughtText = token.reasoningContent;
            }
          }

          tokensCount += 1;
          scheduleAssistantPatch();
        },
      });

      if (isMatchingGeneration(threadId, assistantMessageId) && sharedGenerationState.current?.stopRequested) {
        flushAssistantPatch();
        stopAssistantMessage(threadId, assistantMessageId);
        finalizeThreadStatus(threadId, 'stopped');
        recordCompletionStats('stopped');
        return;
      }

      flushAssistantPatch();
      finalizeAssistantMessage(
        threadId,
        assistantMessageId,
        completion.content || currentText,
        completion.reasoning_content || currentThoughtText || undefined,
      );
      finalizeThreadStatus(threadId, 'idle');
      recordCompletionStats('success');
    } catch (error) {
      if (isMatchingGeneration(threadId, assistantMessageId) && sharedGenerationState.current?.stopRequested) {
        flushAssistantPatch();
        stopAssistantMessage(threadId, assistantMessageId);
        finalizeThreadStatus(threadId, 'stopped');
        recordCompletionStats('stopped');
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Unknown chat generation error';

      flushAssistantPatch();
      patchAssistantMessage(threadId, assistantMessageId, {
        content: currentText,
        thoughtContent: currentThoughtText || undefined,
        state: 'error',
        errorCode: 'generation_failed',
        errorMessage: message,
      });
      finalizeThreadStatus(threadId, 'error');
      recordCompletionStats('error');
      throw error;
    } finally {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
      }

      if (isMatchingGeneration(threadId, assistantMessageId)) {
        sharedGenerationState.current = null;
      }
    }
  }, [finalizeAssistantMessage, finalizeThreadStatus, patchAssistantMessage, stopAssistantMessage]);

  const syncThreadParametersCallback = useCallback(
    (thread: ChatThread, nextParams?: GenerationParameters) => syncThreadParameters(
      thread,
      updateThreadParamsSnapshot,
      nextParams,
    ),
    [updateThreadParamsSnapshot],
  );

  const ensureThreadCanGenerate = useCallback((thread: ChatThread, actionLabel: string) => {
    if (thread.status === 'generating') {
      throw new Error('A response is already being generated for this thread.');
    }

    if (llmEngineService.getState().status !== EngineStatus.READY) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    const settings = getSettings();
    if (settings.activeModelId !== thread.modelId) {
      throw new Error(
        `This conversation is pinned to ${thread.modelId}. Load that model before ${actionLabel}.`,
      );
    }
  }, []);

  const appendUserMessage = useCallback(async (text: string) => {
    const settings = getSettings();
    const activeModelId = settings.activeModelId;
    const activeModelParams = getGenerationParametersForModel(activeModelId);

    if (!activeModelId) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    if (llmEngineService.getState().status !== EngineStatus.READY) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    if (activeThread?.status === 'generating') {
      throw new Error('A response is already being generated for this thread.');
    }

    const shouldStartNewThreadForActiveModel =
      activeThread != null && activeThread.modelId !== activeModelId;

    const threadId =
      shouldStartNewThreadForActiveModel
        ? createThread({
            modelId: activeModelId,
            presetId: settings.activePresetId,
            presetSnapshot: resolvePresetSnapshot(settings.activePresetId),
            paramsSnapshot: activeModelParams,
          })
        : activeThread?.id ??
      createThread({
        modelId: activeModelId,
        presetId: settings.activePresetId,
        presetSnapshot: resolvePresetSnapshot(settings.activePresetId),
        paramsSnapshot: activeModelParams,
      });

    setActiveThread(threadId);

    if (activeThread && !shouldStartNewThreadForActiveModel) {
      syncThreadParametersCallback(activeThread, activeModelParams);
    }

    const userMessage: ChatMessage = {
      id: createChatId('message'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      state: 'complete',
    };

    appendMessage(threadId, userMessage);

    const assistantMessageId = createAssistantPlaceholder(threadId);

    await runAssistantCompletion(threadId, assistantMessageId);
  }, [activeThread, appendMessage, createAssistantPlaceholder, createThread, runAssistantCompletion, setActiveThread, syncThreadParametersCallback]);

  const stopGeneration = useCallback(async () => {
    if (!sharedGenerationState.current) {
      return;
    }

    sharedGenerationState.current.stopRequested = true;
    await llmEngineService.stopCompletion();
  }, []);

  const regenerateFromUserMessage = useCallback(async (messageId: string, nextContent: string) => {
    if (!activeThread) {
      return false;
    }

    const normalizedContent = nextContent.trim();
    if (!normalizedContent) {
      throw new Error('Message cannot be empty.');
    }

    ensureThreadCanGenerate(activeThread, 'regenerating this response');
    const syncedThread = syncThreadParametersCallback(activeThread);

    const assistantMessageId = replaceBranchFromUserMessage(
      syncedThread.id,
      messageId,
      normalizedContent,
    );
    if (!assistantMessageId) {
      throw new Error('The selected message could not be regenerated.');
    }

    await runAssistantCompletion(syncedThread.id, assistantMessageId);

    return true;
  }, [activeThread, ensureThreadCanGenerate, replaceBranchFromUserMessage, runAssistantCompletion, syncThreadParametersCallback]);

  const regenerateLastResponse = useCallback(async () => {
    if (!activeThread) {
      return false;
    }

    const lastUserMessage = [...activeThread.messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.trim().length > 0);
    if (!lastUserMessage) {
      return false;
    }

    ensureThreadCanGenerate(activeThread, 'regenerating this response');
    const syncedThread = syncThreadParametersCallback(activeThread);

    const assistantMessageId = replaceLastAssistantMessage(syncedThread.id);
    if (!assistantMessageId) {
      return regenerateFromUserMessage(lastUserMessage.id, lastUserMessage.content);
    }

    await runAssistantCompletion(syncedThread.id, assistantMessageId);

    return true;
  }, [
    activeThread,
    ensureThreadCanGenerate,
    regenerateFromUserMessage,
    replaceLastAssistantMessage,
    runAssistantCompletion,
    syncThreadParametersCallback,
  ]);

  const createSummaryPlaceholder = useCallback(() => {
    if (!activeThread) {
      return false;
    }

    if (!truncationState.shouldOfferSummary) {
      return false;
    }

    setThreadSummary(activeThread.id, {
      content: SUMMARY_PLACEHOLDER_CONTENT,
      createdAt: Date.now(),
      sourceMessageIds: truncationState.truncatedMessageIds,
      isPlaceholder: true,
    });

    return true;
  }, [activeThread, setThreadSummary, truncationState.shouldOfferSummary, truncationState.truncatedMessageIds]);

  const startNewChat = useCallback(() => {
    if (activeThread?.status === 'generating') {
      throw new Error('Stop the current response before starting a new chat.');
    }

    setActiveThread(null);
  }, [activeThread, setActiveThread]);

  const openThread = useCallback((threadId: string) => {
    if (activeThread?.status === 'generating' && activeThread.id !== threadId) {
      throw new Error('Stop the current response before switching conversations.');
    }

    const thread = useChatStore.getState().getThread(threadId);
    if (!thread) {
      throw new Error('The selected conversation is no longer available.');
    }

    syncThreadParametersCallback(thread);
    setActiveThread(threadId);
  }, [activeThread, setActiveThread, syncThreadParametersCallback]);

  const deleteThread = useCallback((threadId: string) => {
    const thread = useChatStore.getState().getThread(threadId);
    if (thread?.status === 'generating') {
      throw new Error('Stop the current response before deleting this conversation.');
    }

    deleteThreadState(threadId);
  }, [deleteThreadState]);

  const renameThread = useCallback((threadId: string, title: string) => {
    const renamed = renameThreadState(threadId, title);
    if (!renamed) {
      throw new Error('The selected conversation is no longer available.');
    }
  }, [renameThreadState]);

  const deleteMessage = useCallback((messageId: string) => {
    if (!activeThread) {
      return false;
    }

    if (activeThread.status === 'generating') {
      throw new Error('Stop the current response before editing this conversation.');
    }

    const deleted = deleteMessageBranch(activeThread.id, messageId);
    return deleted;
  }, [activeThread, deleteMessageBranch]);

  return {
    activeThread,
    messages: activeThread?.messages ?? [],
    isGenerating: activeThread?.status === 'generating',
    shouldOfferSummary: truncationState.shouldOfferSummary,
    truncatedMessageCount: truncationState.truncatedMessageIds.length,
    appendUserMessage,
    deleteMessage,
    deleteThread,
    renameThread,
    openThread,
    stopGeneration,
    regenerateFromUserMessage,
    regenerateLastResponse,
    createSummaryPlaceholder,
    startNewChat,
  };
};
