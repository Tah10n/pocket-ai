import { AppState, AppStateStatus } from 'react-native';
import { useCallback, useEffect, useRef } from 'react';
import { llmEngineService } from '../services/LLMEngineService';
import { performanceMonitor } from '../services/PerformanceMonitor';
import { GenerationParameters, getGenerationParametersForModel, getSettings } from '../services/SettingsStore';
import { presetManager } from '../services/PresetManager';
import { AppError, toAppError } from '../services/AppError';
import { EngineStatus } from '../types/models';
import { backgroundTaskService } from '../services/BackgroundTaskService';
import { notificationService } from '../services/NotificationService';
import { registry } from '../services/LocalStorageRegistry';
import {
  ChatMessage,
  ChatThread,
  LlmChatMessage,
  DEFAULT_PRESET_SNAPSHOT,
  DEFAULT_SYSTEM_PROMPT,
  PresetSnapshot,
  createChatId,
  getThreadActiveModelId,
} from '../types/chat';
import { useChatStore } from '../store/chatStore';
import {
  DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS,
  buildInferenceWindowWithAccurateTokenCounts,
  createTruncationState,
  estimateLlmMessagesTokens,
  getThreadInferenceWindow,
  resolveThreadInferenceWindowOptions,
  type InferenceBudgetOptions,
} from '../utils/inferenceWindow';
import { getVisibleAssistantContent } from '../utils/chatPresentation';
import { resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../utils/modelReasoningCapabilities';
import { syncThreadParameters } from '../utils/chatThreadParameters';
import { useTruncationTracking } from './useTruncationTracking';

export const SUMMARY_PLACEHOLDER_CONTENT =
  'Summary generation is not available yet. Older messages stay visible in the thread, but only the most recent context is sent to the model right now.';
export { SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES } from '../utils/inferenceWindow';
const DEFAULT_CONTEXT_SIZE = 4096;
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

function resolveThreadReasoningRuntimeConfig(thread: Pick<ChatThread, 'modelId' | 'activeModelId' | 'paramsSnapshot'>) {
  const activeModelId = getThreadActiveModelId(thread);
  const model = registry.getModel(activeModelId);
  const modelName = model?.name ?? activeModelId;
  const capability = resolveModelReasoningCapability(model, activeModelId, modelName);
  const runtimeConfig = resolveReasoningRuntimeConfig({
    reasoningEffort: thread.paramsSnapshot.reasoningEffort,
    capability,
    maxTokens: thread.paramsSnapshot.maxTokens,
  });

  return {
    model,
    modelName,
    capability,
    runtimeConfig,
  };
}

function resolveVisibleAssistantContentFromCandidates(
  fallback: string,
  ...candidates: (string | undefined)[]
) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const visibleContent = getVisibleAssistantContent(candidate);
    if (visibleContent.length > 0) {
      return visibleContent;
    }
  }

  return fallback;
}

export function buildInferenceMessagesForThread(thread: ChatThread, options?: InferenceBudgetOptions) {
  const { runtimeConfig } = resolveThreadReasoningRuntimeConfig(thread);

  return getThreadInferenceWindow(thread, resolveThreadInferenceWindowOptions(thread, {
    ...options,
    responseReserveTokens: options?.responseReserveTokens ?? runtimeConfig.responseReserveTokens,
  })).messages;
}

export function getThreadTruncationState(thread: ChatThread, options?: InferenceBudgetOptions) {
  const { runtimeConfig } = resolveThreadReasoningRuntimeConfig(thread);
  const { truncatedMessageIds } = getThreadInferenceWindow(thread, resolveThreadInferenceWindowOptions(thread, {
    ...options,
    responseReserveTokens: options?.responseReserveTokens ?? runtimeConfig.responseReserveTokens,
  }));

  return createTruncationState(truncatedMessageIds);
}

export const useChatSession = () => {
  const activeThread = useChatStore((state) => state.getActiveThread());
  const createThread = useChatStore((state) => state.createThread);
  const appendMessage = useChatStore((state) => state.appendMessage);
  const createAssistantPlaceholder = useChatStore((state) => state.createAssistantPlaceholder);
  const switchThreadModel = useChatStore((state) => state.switchThreadModel);
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

  const activeContextTokenBudget = (() => {
    if (!activeThread) {
      return undefined;
    }

    const engineState = llmEngineService.getState();
    if (engineState.status !== EngineStatus.READY) {
      return undefined;
    }

    return engineState.activeModelId === getThreadActiveModelId(activeThread)
      ? llmEngineService.getContextSize()
      : undefined;
  })();

  const truncationState = useTruncationTracking(activeThread, activeContextTokenBudget);
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
        if (backgroundTaskService.isTaskActive('inference')) {
          return;
        }

        if (llmEngineService.hasActiveCompletion()) {
          return;
        }

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

    const modelId = getThreadActiveModelId(thread);

    performanceMonitor.mark('chat.send.start', { modelId });
    const generationSpan = performanceMonitor.startSpan('chat.generation', { modelId });

    sharedGenerationState.current = {
      threadId,
      messageId: assistantMessageId,
      stopRequested: false,
    };

    let currentText = '';
    let currentRawText = '';
    let currentThoughtText = '';
    let tokensCount = 0;
    let hasMarkedFirstToken = false;
    const startTime = Date.now();
    let flushTimeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeExpiration: (() => void) | null = null;
    let sentBackgroundOutcomeNotification: 'interrupted' | 'error' | null = null;

    let needsVisibleRefresh = false;

    const refreshVisibleAssistantContent = () => {
      if (!needsVisibleRefresh) {
        return;
      }

      if (currentRawText.length === 0) {
        needsVisibleRefresh = false;
        return;
      }

      currentText = getVisibleAssistantContent(currentRawText, { isStreaming: true });
      needsVisibleRefresh = false;
    };

    const recordCompletionStats = (outcome: 'success' | 'stopped' | 'error') => {
      const elapsedSec = (Date.now() - startTime) / 1000;
      const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;

      const existingTokensPerSec = performanceMonitor.snapshot().counters['chat.tokensPerSec'] ?? 0;
      performanceMonitor.incrementCounter('chat.tokensPerSec', tokensPerSec - existingTokensPerSec);

      performanceMonitor.mark('chat.generation.outcome', {
        outcome,
        modelId,
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

      refreshVisibleAssistantContent();

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

    const sendOutcomeNotificationOnce = (outcome: 'interrupted' | 'error') => {
      if (AppState.currentState === 'active') {
        return;
      }

      if (sentBackgroundOutcomeNotification === 'error') {
        return;
      }

      if (sentBackgroundOutcomeNotification === outcome) {
        return;
      }

      sentBackgroundOutcomeNotification = outcome;

      if (outcome === 'interrupted') {
        void notificationService.sendInterruptedNotification({ threadId });
        return;
      }

      void notificationService.sendInferenceErrorNotification({ threadId });
    };

    try {
      const {
        modelName,
        runtimeConfig: reasoningRuntimeConfig,
      } = resolveThreadReasoningRuntimeConfig(thread);

      await backgroundTaskService.startBackgroundInference(modelName);

      unsubscribeExpiration = backgroundTaskService.subscribeToExpiration(() => {
        if (!isMatchingGeneration(threadId, assistantMessageId)) {
          return;
        }

        try {
          flushAssistantPatch();
          stopAssistantMessage(threadId, assistantMessageId);
          finalizeThreadStatus(threadId, 'stopped');
          sharedGenerationState.current!.stopRequested = true;
          sendOutcomeNotificationOnce('interrupted');
        } finally {
          void llmEngineService.stopCompletion();
        }
      });

      const windowOptions = resolveThreadInferenceWindowOptions(thread, {
        maxContextTokens: maxContextSize,
        responseReserveTokens: reasoningRuntimeConfig.responseReserveTokens,
      });

      const MESSAGE_TOO_LONG_ERROR_MESSAGE =
        'This message is too long for the current context window. Shorten it or increase the context size in Model Controls.';

      let forcedDisableThinking = false;
      let messages: LlmChatMessage[] = [];
      let promptTokens = 0;
      let promptSafetyMarginTokens = 0;

      const countPromptTokens = async (
        windowMessages: LlmChatMessage[],
        params: { enable_thinking: boolean; reasoning_format: 'none' | 'auto' | 'deepseek' },
      ) => llmEngineService.countPromptTokens({
        messages: windowMessages,
        params,
      });

      try {
        const tokenCountParams = {
          enable_thinking: reasoningRuntimeConfig.enableThinking,
          reasoning_format: reasoningRuntimeConfig.reasoningFormat,
        };

        const result = await buildInferenceWindowWithAccurateTokenCounts(
          thread,
          windowOptions,
          async (windowMessages) => countPromptTokens(windowMessages, tokenCountParams),
        );
        messages = result.messages;
        promptTokens = result.promptTokens;
        promptSafetyMarginTokens = result.promptSafetyMarginTokens;
      } catch (error) {
        const appError = toAppError(error);

        if (appError.code === 'message_too_long' && reasoningRuntimeConfig.enableThinking) {
          forcedDisableThinking = true;

          const noThinkingWindowOptions = resolveThreadInferenceWindowOptions(thread, {
            maxContextTokens: maxContextSize,
            responseReserveTokens: Math.max(1, Math.round(thread.paramsSnapshot.maxTokens)),
          });
          const tokenCountParams = {
            enable_thinking: false,
            reasoning_format: 'none' as const,
          };

          const result = await buildInferenceWindowWithAccurateTokenCounts(
            thread,
            noThinkingWindowOptions,
            async (windowMessages) => countPromptTokens(windowMessages, tokenCountParams),
          );
          messages = result.messages;
          promptTokens = result.promptTokens;
          promptSafetyMarginTokens = result.promptSafetyMarginTokens;
        } else if (appError.code === 'message_too_long') {
          throw appError;
        } else {
          console.warn('[ChatSession] Failed to count prompt tokens accurately, falling back to heuristics', error);
          messages = getThreadInferenceWindow(thread, windowOptions).messages;
          promptTokens = estimateLlmMessagesTokens(messages);
          promptSafetyMarginTokens = Math.max(
            0,
            Math.round(windowOptions.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
          );
        }
      }

      const nonSystemMessages = messages.filter((message) => message.role !== 'system');
      const lastNonSystemRole = nonSystemMessages.length > 0
        ? nonSystemMessages[nonSystemMessages.length - 1]?.role
        : null;
      if (lastNonSystemRole !== 'user') {
        throw new AppError('message_too_long', MESSAGE_TOO_LONG_ERROR_MESSAGE);
      }

      const availablePredictTokens = maxContextSize - promptTokens - promptSafetyMarginTokens;
      if (availablePredictTokens <= 0) {
        throw new AppError('message_too_long', MESSAGE_TOO_LONG_ERROR_MESSAGE, {
          details: {
            maxContextSize,
            promptTokens,
            promptSafetyMarginTokens,
          },
        });
      }

      const maxPredictTokens = Math.max(
        1,
        maxContextSize - promptTokens - promptSafetyMarginTokens,
      );
      const visiblePredictTokens = Math.max(1, Math.round(thread.paramsSnapshot.maxTokens));
      const guaranteedVisibleTokens = Math.min(visiblePredictTokens, maxPredictTokens);
      const effectiveThinkingBudgetTokens = reasoningRuntimeConfig.enableThinking
        ? Math.max(0, Math.min(reasoningRuntimeConfig.thinkingBudgetTokens, maxPredictTokens - guaranteedVisibleTokens))
        : 0;
      const enableThinkingForRequest = !forcedDisableThinking && reasoningRuntimeConfig.enableThinking && effectiveThinkingBudgetTokens > 0;
      const reasoningFormatForRequest = enableThinkingForRequest
        ? reasoningRuntimeConfig.reasoningFormat
        : 'none';

      const completion = await llmEngineService.chatCompletion({
        messages,
        params: {
          temperature: thread.paramsSnapshot.temperature,
          top_p: thread.paramsSnapshot.topP,
          top_k: thread.paramsSnapshot.topK,
          min_p: thread.paramsSnapshot.minP,
          penalty_repeat: thread.paramsSnapshot.repetitionPenalty,
          n_predict: Math.max(
            1,
            guaranteedVisibleTokens + (enableThinkingForRequest ? effectiveThinkingBudgetTokens : 0),
          ),
          seed: thread.paramsSnapshot.seed ?? undefined,
          enable_thinking: enableThinkingForRequest,
          thinking_budget_tokens: enableThinkingForRequest
            ? effectiveThinkingBudgetTokens
            : undefined,
          reasoning_format: reasoningFormatForRequest,
        },
        onToken: (token) => {
          if (!hasMarkedFirstToken) {
            hasMarkedFirstToken = true;
            performanceMonitor.mark('chat.firstToken', { modelId });
          }

          if (typeof token === 'string') {
            if (currentRawText.length === 0 && currentText.length > 0) {
              currentRawText = currentText;
            }
            currentRawText += token;
            needsVisibleRefresh = true;
          } else {
            const hasReasoningUpdate = token.reasoningContent !== undefined;

            if (token.content !== undefined) {
              currentText = getVisibleAssistantContent(token.content);
              needsVisibleRefresh = false;
              if (typeof token.accumulatedText === 'string' && token.accumulatedText.length >= currentRawText.length) {
                currentRawText = token.accumulatedText;
              } else {
                currentRawText = token.content;
              }
            } else if (hasReasoningUpdate) {
              // When the engine is still producing reasoning (no parsed `content` yet), never derive
              // the visible assistant message from raw accumulated text. Some templates use non-<think>
              // markers (e.g. [THINK] or <|channel>thought) which would otherwise leak into the main bubble.
              if (typeof token.accumulatedText === 'string' && token.accumulatedText.length >= currentRawText.length) {
                currentRawText = token.accumulatedText;
              }
              needsVisibleRefresh = false;
            } else if (typeof token.accumulatedText === 'string' && token.accumulatedText.length >= currentRawText.length) {
              currentRawText = token.accumulatedText;
              needsVisibleRefresh = true;
            } else {
              if (currentRawText.length === 0 && currentText.length > 0) {
                currentRawText = currentText;
              }
              currentRawText += token.token;
              needsVisibleRefresh = true;
            }

            if (token.reasoningContent !== undefined) {
              const nextReasoning = token.reasoningContent;

              // `reasoningContent` may be streamed either as an accumulated buffer or as deltas.
              // Prefer treating it as accumulated when it prefixes the existing buffer.
              currentThoughtText = nextReasoning.startsWith(currentThoughtText)
                ? nextReasoning
                : (currentThoughtText + nextReasoning);
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

        sendOutcomeNotificationOnce('interrupted');
        return;
      }

      flushAssistantPatch();
      const finalThoughtContent = completion.reasoning_content || currentThoughtText || undefined;
      finalizeAssistantMessage(
        threadId,
        assistantMessageId,
        resolveVisibleAssistantContentFromCandidates(
          '',
          completion.content,
          currentText,
          completion.text,
          currentRawText,
        ),
        finalThoughtContent,
      );
      finalizeThreadStatus(threadId, 'idle');
      recordCompletionStats('success');

      if (AppState.currentState !== 'active') {
        void notificationService.sendCompletionNotification('inference', { threadId });
      }
    } catch (error) {
      if (isMatchingGeneration(threadId, assistantMessageId) && sharedGenerationState.current?.stopRequested) {
        flushAssistantPatch();
        stopAssistantMessage(threadId, assistantMessageId);
        finalizeThreadStatus(threadId, 'stopped');
        recordCompletionStats('stopped');

        sendOutcomeNotificationOnce('interrupted');
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

      sendOutcomeNotificationOnce('error');
      throw error;
    } finally {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
      }

      unsubscribeExpiration?.();
      unsubscribeExpiration = null;

      if (isMatchingGeneration(threadId, assistantMessageId)) {
        sharedGenerationState.current = null;
      }

      if (backgroundTaskService.isTaskActive('inference')) {
        await backgroundTaskService.stopBackgroundTask('inference');
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

    const engineState = llmEngineService.getState();
    if (engineState.status !== EngineStatus.READY) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    const threadModelId = getThreadActiveModelId(thread);
    if (engineState.activeModelId !== threadModelId) {
      throw new Error(`Load ${threadModelId} before ${actionLabel}.`);
    }
  }, []);

  const ensureThreadUsesModelForSend = useCallback((thread: ChatThread, nextModelId: string) => {
    const currentModelId = getThreadActiveModelId(thread);
    if (nextModelId === currentModelId) {
      return;
    }

    switchThreadModel(thread.id, nextModelId);
    updateThreadParamsSnapshot(thread.id, getGenerationParametersForModel(nextModelId));
  }, [switchThreadModel, updateThreadParamsSnapshot]);

  const appendUserMessage = useCallback(async (text: string) => {
    const settings = getSettings();
    const activeModelId = settings.activeModelId;
    const activeModelParams = getGenerationParametersForModel(activeModelId);

    if (!activeModelId) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    const engineState = llmEngineService.getState();
    if (engineState.status !== EngineStatus.READY) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    if (engineState.activeModelId !== activeModelId) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    if (activeThread?.status === 'generating') {
      throw new Error('A response is already being generated for this thread.');
    }

    const threadId = activeThread?.id
      ?? createThread({
        modelId: activeModelId,
        presetId: settings.activePresetId,
        presetSnapshot: resolvePresetSnapshot(settings.activePresetId),
        paramsSnapshot: activeModelParams,
      });

    setActiveThread(threadId);

    const existingThread = activeThread;
    if (existingThread) {
      ensureThreadUsesModelForSend(existingThread, activeModelId);
      const nextThread = useChatStore.getState().getThread(threadId);
      if (nextThread) {
        syncThreadParametersCallback(nextThread, activeModelParams);
      }
    }

    const threadAfterPossibleSwitch = useChatStore.getState().getThread(threadId);
    const threadModelId = threadAfterPossibleSwitch
      ? getThreadActiveModelId(threadAfterPossibleSwitch)
      : activeModelId;

    const userMessage: ChatMessage = {
      id: createChatId('message'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      state: 'complete',
      kind: 'message',
      modelId: threadModelId,
    };

    appendMessage(threadId, userMessage);

    const assistantMessageId = createAssistantPlaceholder(threadId, threadModelId);

    await runAssistantCompletion(threadId, assistantMessageId);
  }, [activeThread, appendMessage, createAssistantPlaceholder, createThread, ensureThreadUsesModelForSend, runAssistantCompletion, setActiveThread, syncThreadParametersCallback]);

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
