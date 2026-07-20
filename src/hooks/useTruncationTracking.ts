import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getThreadActiveModelId, type ChatThread, type LlmChatMessage } from '../types/chat';
import { llmEngineService } from '../services/LLMEngineService';
import { registry } from '../services/LocalStorageRegistry';
import { useModelRegistryRevision } from './useModelRegistryRevision';
import type { MultimodalReadinessState } from '../types/multimodal';
import {
  buildInferenceWindowWithAccurateTokenCounts,
  createTruncationState,
  getThreadInferenceWindow,
  resolveThreadInferenceWindowOptions,
} from '../utils/inferenceWindow';
import { resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../utils/modelReasoningCapabilities';
import { performanceMonitor } from '../services/PerformanceMonitor';
import { AppError } from '../services/AppError';
import {
  buildExactPromptTokenCacheKey,
  buildPromptMultimodalReadinessIdentity,
  exactPromptTokenCache,
} from '../services/ExactPromptTokenCache';
import { buildLlmInferenceMessagesSignature } from '../utils/llmInferenceMessageSignature';

type TruncationState = ReturnType<typeof createTruncationState>;

const EMPTY_TRUNCATION_STATE: TruncationState = {
  truncatedMessageIds: [],
  shouldOfferSummary: false,
};

function subscribeToPromptContextIdentity(onStoreChange: () => void): () => void {
  return llmEngineService.subscribe(() => onStoreChange());
}

function getPromptContextIdentitySnapshot(): string {
  return llmEngineService.getPromptContextIdentity();
}

function computeHeuristicTruncationState(
  thread: ChatThread,
  windowOptions: Parameters<typeof getThreadInferenceWindow>[1],
): TruncationState {
  const instrumentationEnabled = performanceMonitor.isEnabled();
  const span = instrumentationEnabled
    ? performanceMonitor.startSpan('chat.prompt.window.heuristic')
    : null;
  if (instrumentationEnabled && thread.status === 'generating') {
    performanceMonitor.incrementCounter('chat.stream.historyTraversal');
  }

  try {
    const { truncatedMessageIds } = getThreadInferenceWindow(thread, windowOptions);
    return createTruncationState(truncatedMessageIds);
  } finally {
    span?.end();
  }
}

function isAudioReady(readiness: MultimodalReadinessState | undefined, expectedModelId: string | null): boolean {
  return readiness?.status === 'ready'
    && readiness.support.includes('audio')
    && (!expectedModelId || readiness.modelId === expectedModelId);
}

function sanitizeTruncationProbeMessages(
  messages: LlmChatMessage[],
  readiness: MultimodalReadinessState | undefined,
  expectedModelId: string | null,
): LlmChatMessage[] {
  const retainAudio = isAudioReady(readiness, expectedModelId);

  return messages.map((message) => {
    const retainedAttachments = message.attachments?.filter((attachment) => {
      if (!('kind' in attachment)) {
        return true;
      }

      if (attachment.kind === 'audio') {
        return retainAudio;
      }

      return attachment.kind !== 'video';
    }) ?? [];
    const retainedContentParts = message.contentParts?.filter((part) => (
      part.type === 'input_audio'
        ? false
        : true
    )) ?? [];
    const retainedMediaPaths = message.mediaPaths ?? [];
    const {
      attachments: _attachments,
      mediaPaths: _mediaPaths,
      contentParts: _contentParts,
      ...messageWithoutAudioInput
    } = message;

    return {
      ...messageWithoutAudioInput,
      ...(retainedAttachments.length > 0 ? { attachments: retainedAttachments } : null),
      ...(retainedMediaPaths.length > 0 ? { mediaPaths: retainedMediaPaths } : null),
      ...(retainedContentParts.length > 0 ? { contentParts: retainedContentParts } : null),
    };
  });
}

export function useTruncationTracking(
  activeThread: ChatThread | null,
  activeContextTokenBudget: number | undefined,
): TruncationState {
  const promptContextIdentity = useSyncExternalStore(
    subscribeToPromptContextIdentity,
    getPromptContextIdentitySnapshot,
    getPromptContextIdentitySnapshot,
  );
  const modelRegistryRevision = useModelRegistryRevision();
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadStatus = activeThread?.status ?? null;
  const [accurateTruncationState, setAccurateTruncationState] = useState<{
    threadId: string;
    state: TruncationState;
  } | null>(null);
  const accurateTruncationCacheRef = useRef<{ key: string | null; state: TruncationState }>({
    key: null,
    state: EMPTY_TRUNCATION_STATE,
  });
  const truncationCacheRef = useRef<{ threadId: string | null; state: TruncationState }>({
    threadId: null,
    state: EMPTY_TRUNCATION_STATE,
  });

  const activeThreadModelId = activeThread ? getThreadActiveModelId(activeThread) : null;
  const activeThreadModel = activeThreadModelId ? registry.getModel(activeThreadModelId) : undefined;
  const activeThreadMultimodalReadiness = activeThreadModel?.multimodalReadiness;

  let activeThreadReasoningEnabled = false;
  let activeThreadReasoningFormat: 'none' | 'auto' | 'deepseek' = 'none';
  let activeThreadResponseReserveTokens: number | undefined;
  if (activeThread && activeThreadModelId) {
    const capability = resolveModelReasoningCapability(activeThreadModel, activeThreadModelId, activeThreadModel?.name);
    const runtimeConfig = resolveReasoningRuntimeConfig({
      reasoningEffort: activeThread.paramsSnapshot.reasoningEffort,
      capability,
      maxTokens: activeThread.paramsSnapshot.maxTokens,
    });
    activeThreadReasoningEnabled = runtimeConfig.enableThinking;
    activeThreadReasoningFormat = runtimeConfig.reasoningFormat;
    activeThreadResponseReserveTokens = runtimeConfig.responseReserveTokens;
  }

  const heuristicTruncationState = useMemo(() => {
    if (!activeThread) {
      return EMPTY_TRUNCATION_STATE;
    }

    if (activeThread.status === 'generating') {
      return truncationCacheRef.current.threadId === activeThread.id
        ? truncationCacheRef.current.state
        : EMPTY_TRUNCATION_STATE;
    }

    const windowOptions = resolveThreadInferenceWindowOptions(activeThread, {
      maxContextTokens: activeContextTokenBudget,
      responseReserveTokens: activeThreadResponseReserveTokens,
    });
    return computeHeuristicTruncationState(activeThread, windowOptions);
  }, [activeContextTokenBudget, activeThread, activeThreadResponseReserveTokens]);

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
    const windowOptions = resolveThreadInferenceWindowOptions(activeThread, {
      maxContextTokens: activeContextTokenBudget,
      responseReserveTokens: activeThreadResponseReserveTokens,
    });
    const cacheKey = [
      activeThread.id,
      activeThread.updatedAt,
      activeContextTokenBudget,
      windowOptions.responseReserveTokens ?? null,
      windowOptions.promptSafetyMarginTokens ?? null,
      activeThreadReasoningEnabled ? 1 : 0,
      activeThreadReasoningFormat,
      activeThreadModelId,
      promptContextIdentity,
      activeThreadMultimodalReadiness?.modelId ?? null,
      activeThreadMultimodalReadiness?.status ?? null,
      activeThreadMultimodalReadiness?.projectorId ?? null,
      activeThreadMultimodalReadiness?.support.join(',') ?? null,
      activeThread.messages
        .map((message) => `${message.id}:${message.attachments?.map((attachment) => attachment.localUri).join(',') ?? ''}`)
        .join('|'),
      modelRegistryRevision,
    ].join(':');

    if (accurateTruncationCacheRef.current.key === cacheKey) {
      const cachedState = accurateTruncationCacheRef.current.state;
      setAccurateTruncationState((currentState) => {
        if (currentState?.threadId === activeThread.id && currentState.state === cachedState) {
          return currentState;
        }

        return {
          threadId: activeThread.id,
          state: cachedState,
        };
      });
      return;
    }

    setAccurateTruncationState(null);

    const tokenCountParams = {
      enable_thinking: activeThreadReasoningEnabled,
      reasoning_format: activeThreadReasoningFormat,
    };

    const throwIfCancelled = () => {
      if (isCancelled) {
        throw new Error('Accurate truncation probe was cancelled.');
      }
    };

    const countPromptTokens = async (messages: LlmChatMessage[]) => {
      throwIfCancelled();
      const sanitizedMessages = sanitizeTruncationProbeMessages(
        messages,
        activeThreadMultimodalReadiness,
        activeThreadModelId,
      );
      const promptTokenCacheKey = buildExactPromptTokenCacheKey({
        contextIdentity: promptContextIdentity,
        modelId: activeThreadModelId ?? 'none',
        multimodalReadinessIdentity: buildPromptMultimodalReadinessIdentity(
          activeThreadMultimodalReadiness,
          activeThreadModelId,
        ),
        messageSignature: buildLlmInferenceMessagesSignature(sanitizedMessages),
        enableThinking: tokenCountParams.enable_thinking,
        reasoningFormat: tokenCountParams.reasoning_format,
        allowMediaFallback: true,
      });
      const lookup = exactPromptTokenCache.getOrCreate(promptTokenCacheKey, () => {
        throwIfCancelled();
        return llmEngineService.countPromptTokens({
          messages: sanitizedMessages,
          params: tokenCountParams,
          multimodalReadiness: activeThreadMultimodalReadiness,
          expectedModelId: activeThreadModelId,
          chatBlocking: false,
          allowMediaFallback: true,
        });
      });
      if (performanceMonitor.isEnabled()) {
        performanceMonitor.incrementCounter(
          lookup.hit ? 'chat.prompt.cache.hit' : 'chat.prompt.cache.miss',
        );
      }

      let cacheOutcome: 'success' | 'discard' = 'discard';
      try {
        const tokens = await lookup.promise;
        throwIfCancelled();
        if (llmEngineService.getPromptContextIdentity() !== promptContextIdentity) {
          throw new AppError('engine_not_ready', 'Engine context changed during prompt tokenization.');
        }
        cacheOutcome = 'success';
        return tokens;
      } finally {
        lookup.release(cacheOutcome);
      }
    };

    const exactSpan = performanceMonitor.isEnabled()
      ? performanceMonitor.startSpan('chat.prompt.window.exact')
      : null;

    void buildInferenceWindowWithAccurateTokenCounts(activeThread, windowOptions, countPromptTokens, { throwIfCancelled })
      .then(({ truncatedMessageIds }) => {
        if (!isCancelled) {
          const state = createTruncationState(truncatedMessageIds);
          accurateTruncationCacheRef.current = { key: cacheKey, state };
          setAccurateTruncationState({
            threadId: activeThread.id,
            state,
          });
          exactSpan?.end({ outcome: 'success' });
        }
      })
      .catch((error) => {
        exactSpan?.end({ outcome: isCancelled ? 'cancelled' : 'error' });
        if (!isCancelled) {
          const errorCode = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : null;
          const errorMessage = error instanceof Error
            ? error.message
            : error && typeof error === 'object' && 'message' in error
              ? String((error as { message?: unknown }).message)
              : String(error);

          // Expected transient failures (and oversized messages): fall back to heuristics without warning spam.
          if (
            errorCode === 'engine_busy'
            || errorCode === 'engine_not_ready'
            || errorCode === 'engine_unloading'
            || errorCode === 'message_too_long'
          ) {
            return;
          }

          // Some chat templates (Jinja tool templates) reject prompts without an explicit user query.
          // Accurate token counting may briefly probe such windows; treat this as expected and fall back.
          if (errorMessage.includes('Jinja Exception') && errorMessage.includes('No user query found in messages')) {
            return;
          }

          console.warn('[ChatSession] Failed to resolve truncation state accurately, falling back to heuristics', error);
        }
      });

    return () => {
      isCancelled = true;
      exactSpan?.end({ outcome: 'cancelled' });
    };
  }, [activeContextTokenBudget, activeThread, activeThreadModelId, activeThreadMultimodalReadiness, activeThreadReasoningEnabled, activeThreadReasoningFormat, activeThreadResponseReserveTokens, modelRegistryRevision, promptContextIdentity]);

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

  return truncationState;
}
