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
import { scheduleIdleTask } from '../utils/idleTask';

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
  inferenceRevision: number,
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
    identity: string;
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
  const heuristicTruncationCacheRef = useRef<{ key: string | null; state: TruncationState }>({
    key: null,
    state: EMPTY_TRUNCATION_STATE,
  });
  const currentAccurateIdentityRef = useRef<string | null>(null);

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

  const activeWindowOptions = activeThread
    ? resolveThreadInferenceWindowOptions(activeThread, {
      maxContextTokens: activeContextTokenBudget,
      responseReserveTokens: activeThreadResponseReserveTokens,
    })
    : null;
  const readinessIdentity = buildPromptMultimodalReadinessIdentity(
    activeThreadMultimodalReadiness,
    activeThreadModelId,
  );
  const accurateIdentity = activeThread
    && activeThread.status !== 'generating'
    && activeContextTokenBudget !== undefined
    && activeWindowOptions
    ? JSON.stringify([
        activeThread.id,
        inferenceRevision,
        activeContextTokenBudget,
        activeWindowOptions.responseReserveTokens ?? null,
        activeWindowOptions.promptSafetyMarginTokens ?? null,
        activeThreadReasoningEnabled ? 1 : 0,
        activeThreadReasoningFormat,
        activeThreadModelId,
        promptContextIdentity,
        readinessIdentity,
        modelRegistryRevision,
      ])
    : null;
  currentAccurateIdentityRef.current = accurateIdentity;

  const probeInputRef = useRef<{
    identity: string;
    thread: ChatThread;
    windowOptions: NonNullable<typeof activeWindowOptions>;
    modelId: string | null;
    multimodalReadiness: MultimodalReadinessState | undefined;
    reasoningEnabled: boolean;
    reasoningFormat: 'none' | 'auto' | 'deepseek';
    contextIdentity: string;
    readinessIdentity: string;
  } | null>(null);
  probeInputRef.current = accurateIdentity && activeThread && activeWindowOptions
    ? {
        identity: accurateIdentity,
        thread: activeThread,
        windowOptions: activeWindowOptions,
        modelId: activeThreadModelId,
        multimodalReadiness: activeThreadMultimodalReadiness,
        reasoningEnabled: activeThreadReasoningEnabled,
        reasoningFormat: activeThreadReasoningFormat,
        contextIdentity: promptContextIdentity,
        readinessIdentity,
      }
    : null;

  let heuristicTruncationState = EMPTY_TRUNCATION_STATE;
  if (activeThread) {
    if (activeThread.status === 'generating') {
      heuristicTruncationState = truncationCacheRef.current.threadId === activeThread.id
        ? truncationCacheRef.current.state
        : EMPTY_TRUNCATION_STATE;
    } else if (activeWindowOptions) {
      const heuristicKey = JSON.stringify([
        activeThread.id,
        inferenceRevision,
        activeContextTokenBudget ?? null,
        activeWindowOptions.responseReserveTokens ?? null,
        activeWindowOptions.promptSafetyMarginTokens ?? null,
        activeThreadModelId,
        modelRegistryRevision,
      ]);
      if (heuristicTruncationCacheRef.current.key !== heuristicKey) {
        heuristicTruncationCacheRef.current = {
          key: heuristicKey,
          state: computeHeuristicTruncationState(activeThread, activeWindowOptions),
        };
      }
      heuristicTruncationState = heuristicTruncationCacheRef.current.state;
    }
  }

  useEffect(() => {
    const input = probeInputRef.current;
    if (!accurateIdentity || !input || input.identity !== accurateIdentity) {
      setAccurateTruncationState(null);
      return;
    }

    let isCancelled = false;
    const cacheKey = accurateIdentity;

    if (accurateTruncationCacheRef.current.key === cacheKey) {
      const cachedState = accurateTruncationCacheRef.current.state;
      setAccurateTruncationState((currentState) => {
        if (currentState?.identity === cacheKey && currentState.state === cachedState) {
          return currentState;
        }

        return {
          identity: cacheKey,
          threadId: input.thread.id,
          state: cachedState,
        };
      });
      return;
    }

    setAccurateTruncationState(null);

    const tokenCountParams = {
      enable_thinking: input.reasoningEnabled,
      reasoning_format: input.reasoningFormat,
    };

    const throwIfCancelled = () => {
      if (isCancelled || currentAccurateIdentityRef.current !== cacheKey) {
        throw new Error('Accurate truncation probe was cancelled.');
      }
      if (llmEngineService.getPromptContextIdentity() !== input.contextIdentity) {
        throw new AppError('engine_not_ready', 'Engine context changed during prompt tokenization.');
      }
    };

    const countPromptTokens = async (messages: LlmChatMessage[]) => {
      throwIfCancelled();
      const sanitizedMessages = sanitizeTruncationProbeMessages(
        messages,
        input.multimodalReadiness,
        input.modelId,
      );
      const promptTokenCacheKey = buildExactPromptTokenCacheKey({
        contextIdentity: input.contextIdentity,
        modelId: input.modelId ?? 'none',
        multimodalReadinessIdentity: input.readinessIdentity,
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
          multimodalReadiness: input.multimodalReadiness,
          expectedModelId: input.modelId,
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
        cacheOutcome = 'success';
        return tokens;
      } finally {
        lookup.release(cacheOutcome);
      }
    };

    let exactSpan: ReturnType<typeof performanceMonitor.startSpan> | null = null;
    const endExactSpan = (outcome: 'success' | 'cancelled' | 'error') => {
      const span = exactSpan;
      exactSpan = null;
      span?.end({ outcome });
    };
    const cancelScheduledProbe = scheduleIdleTask(() => {
      if (
        isCancelled
        || currentAccurateIdentityRef.current !== cacheKey
        || llmEngineService.getPromptContextIdentity() !== input.contextIdentity
      ) {
        return;
      }

      exactSpan = performanceMonitor.isEnabled()
        ? performanceMonitor.startSpan('chat.prompt.window.exact')
        : null;

      void buildInferenceWindowWithAccurateTokenCounts(
        input.thread,
        input.windowOptions,
        countPromptTokens,
        { throwIfCancelled },
      ).then(({ truncatedMessageIds }) => {
        if (!isCancelled && currentAccurateIdentityRef.current === cacheKey) {
          const state = createTruncationState(truncatedMessageIds);
          accurateTruncationCacheRef.current = { key: cacheKey, state };
          setAccurateTruncationState({
            identity: cacheKey,
            threadId: input.thread.id,
            state,
          });
          endExactSpan('success');
        }
      }).catch((error) => {
        const probeWasCancelled = isCancelled || currentAccurateIdentityRef.current !== cacheKey;
        endExactSpan(probeWasCancelled ? 'cancelled' : 'error');
        if (!probeWasCancelled) {
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

          console.warn('[ChatSession] Failed to resolve truncation state accurately, falling back to heuristics', {
            errorCode,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      });
    });

    return () => {
      isCancelled = true;
      cancelScheduledProbe();
      endExactSpan('cancelled');
    };
  }, [accurateIdentity]);

  const truncationState = useMemo(() => {
    if (!activeThread) {
      return EMPTY_TRUNCATION_STATE;
    }

    if (activeThread.status === 'generating') {
      return truncationCacheRef.current.threadId === activeThread.id
        ? truncationCacheRef.current.state
        : EMPTY_TRUNCATION_STATE;
    }

    if (
      accurateTruncationState?.threadId === activeThread.id
      && accurateTruncationState.identity === accurateIdentity
    ) {
      return accurateTruncationState.state;
    }

    return heuristicTruncationState;
  }, [accurateIdentity, accurateTruncationState, activeThread, heuristicTruncationState]);

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
