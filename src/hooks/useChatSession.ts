import { AppState, AppStateStatus } from 'react-native';
import { useCallback, useEffect, useRef } from 'react';
import { llmEngineService } from '../services/LLMEngineService';
import { GenerationParameters, getGenerationParametersForModel, getSettings } from '../services/SettingsStore';
import { presetManager } from '../services/PresetManager';
import { EngineStatus } from '../types/models';
import {
  ChatMessage,
  ChatThread,
  DEFAULT_PRESET_SNAPSHOT,
  DEFAULT_SYSTEM_PROMPT,
  PresetSnapshot,
  createChatId,
  toConversationIndexItem,
} from '../types/chat';
import { getThreadInferenceWindow, useChatStore } from '../store/chatStore';

export const MAX_CONTEXT_MESSAGES = 24;
export const SUMMARY_PLACEHOLDER_CONTENT =
  'Summary generation is not available yet. Older messages stay visible in the thread, but only the most recent context is sent to the model right now.';
export const SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES = 1;
const DEFAULT_CONTEXT_SIZE = 2048;

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

export function buildInferenceMessagesForThread(thread: ChatThread) {
  return getThreadInferenceWindow(thread, MAX_CONTEXT_MESSAGES).messages;
}

export function getThreadTruncationState(thread: ChatThread) {
  const { truncatedMessageIds } = getThreadInferenceWindow(thread, MAX_CONTEXT_MESSAGES);

  return {
    truncatedMessageIds,
    shouldOfferSummary:
      truncatedMessageIds.length >= SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES,
  };
}

export const useChatSession = () => {
  const activeThread = useChatStore((state) => state.getActiveThread());
  const threads = useChatStore((state) => state.threads);
  const conversationIndex = Object.values(threads)
    .map(toConversationIndexItem)
    .sort((left, right) => right.updatedAt - left.updatedAt);
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

    sharedGenerationState.current = {
      threadId,
      messageId: assistantMessageId,
      stopRequested: false,
    };

    let currentText = '';
    let tokensCount = 0;
    const startTime = Date.now();

    const maxContextSize =
      typeof llmEngineService.getContextSize === 'function'
        ? llmEngineService.getContextSize()
        : DEFAULT_CONTEXT_SIZE;

    try {
      const messages = buildInferenceMessagesForThread(thread);

      await llmEngineService.chatCompletion({
        messages,
        params: {
          temperature: thread.paramsSnapshot.temperature,
          top_p: thread.paramsSnapshot.topP,
          top_k: thread.paramsSnapshot.topK,
          min_p: thread.paramsSnapshot.minP,
          penalty_repeat: thread.paramsSnapshot.repetitionPenalty,
          n_predict: Math.min(thread.paramsSnapshot.maxTokens, maxContextSize),
        },
        onToken: (token) => {
          currentText += token;
          tokensCount += 1;
          const elapsedSec = (Date.now() - startTime) / 1000;
          const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;

          patchAssistantMessage(threadId, assistantMessageId, {
            content: currentText,
            tokensPerSec,
            state: 'streaming',
          });
        },
      });

      if (isMatchingGeneration(threadId, assistantMessageId) && sharedGenerationState.current?.stopRequested) {
        stopAssistantMessage(threadId, assistantMessageId);
        finalizeThreadStatus(threadId, 'stopped');
        return;
      }

      finalizeAssistantMessage(threadId, assistantMessageId, currentText);
      finalizeThreadStatus(threadId, 'idle');
    } catch (error) {
      if (isMatchingGeneration(threadId, assistantMessageId) && sharedGenerationState.current?.stopRequested) {
        stopAssistantMessage(threadId, assistantMessageId);
        finalizeThreadStatus(threadId, 'stopped');
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Unknown chat generation error';

      patchAssistantMessage(threadId, assistantMessageId, {
        content:
          currentText + (currentText.length > 0 ? '\n\n' : '') + `[Error: ${message}]`,
        state: 'error',
        errorCode: 'generation_failed',
      });
      finalizeThreadStatus(threadId, 'error');
      throw error;
    } finally {
      if (isMatchingGeneration(threadId, assistantMessageId)) {
        sharedGenerationState.current = null;
      }
    }
  }, [finalizeAssistantMessage, finalizeThreadStatus, patchAssistantMessage, stopAssistantMessage]);

  const syncThreadParameters = useCallback((thread: ChatThread, nextParams?: GenerationParameters) => {
    const resolvedParams = nextParams ?? getGenerationParametersForModel(thread.modelId);
    const paramsChanged =
      thread.paramsSnapshot.temperature !== resolvedParams.temperature
      || thread.paramsSnapshot.topP !== resolvedParams.topP
      || thread.paramsSnapshot.topK !== resolvedParams.topK
      || thread.paramsSnapshot.minP !== resolvedParams.minP
      || thread.paramsSnapshot.repetitionPenalty !== resolvedParams.repetitionPenalty
      || thread.paramsSnapshot.maxTokens !== resolvedParams.maxTokens;

    if (paramsChanged) {
      updateThreadParamsSnapshot(thread.id, resolvedParams);
    }

    return paramsChanged
      ? {
          ...thread,
          paramsSnapshot: resolvedParams,
        }
      : thread;
  }, [updateThreadParamsSnapshot]);

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

    if (activeThread && activeThread.modelId !== activeModelId) {
      throw new Error(
        `This conversation is pinned to ${activeThread.modelId}. Load that model before continuing this thread.`,
      );
    }

    const threadId =
      activeThread?.id ??
      createThread({
        modelId: activeModelId,
        presetId: settings.activePresetId,
        presetSnapshot: resolvePresetSnapshot(settings.activePresetId),
        paramsSnapshot: activeModelParams,
      });

    setActiveThread(threadId);

    if (activeThread) {
      syncThreadParameters(activeThread, activeModelParams);
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
  }, [activeThread, appendMessage, createAssistantPlaceholder, createThread, runAssistantCompletion, setActiveThread, syncThreadParameters]);

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

    const syncedThread = syncThreadParameters(activeThread);
    ensureThreadCanGenerate(syncedThread, 'regenerating this response');

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
  }, [activeThread, ensureThreadCanGenerate, replaceBranchFromUserMessage, runAssistantCompletion, syncThreadParameters]);

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

    const syncedThread = syncThreadParameters(activeThread);
    ensureThreadCanGenerate(syncedThread, 'regenerating this response');

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
    syncThreadParameters,
  ]);

  const createSummaryPlaceholder = useCallback(() => {
    if (!activeThread) {
      return false;
    }

    const { truncatedMessageIds, shouldOfferSummary } = getThreadTruncationState(activeThread);
    if (!shouldOfferSummary) {
      return false;
    }

    setThreadSummary(activeThread.id, {
      content: SUMMARY_PLACEHOLDER_CONTENT,
      createdAt: Date.now(),
      sourceMessageIds: truncatedMessageIds,
    });

    return true;
  }, [activeThread, setThreadSummary]);

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

    syncThreadParameters(thread);
    setActiveThread(threadId);
  }, [activeThread, setActiveThread, syncThreadParameters]);

  const deleteThread = useCallback((threadId: string) => {
    if (sharedGenerationState.current?.threadId === threadId) {
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

  const truncationState = activeThread
    ? getThreadTruncationState(activeThread)
    : { truncatedMessageIds: [], shouldOfferSummary: false };

  return {
    activeThread,
    conversationIndex,
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
