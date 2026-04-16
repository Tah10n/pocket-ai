import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatThread, LlmChatMessage } from '../types/chat';
import { llmEngineService } from '../services/LLMEngineService';
import { registry } from '../services/LocalStorageRegistry';
import { useModelRegistryRevision } from './useModelRegistryRevision';
import {
  buildInferenceWindowWithAccurateTokenCounts,
  createTruncationState,
  getThreadInferenceWindow,
  resolveThreadInferenceWindowOptions,
} from '../utils/inferenceWindow';
import { resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../utils/modelReasoningCapabilities';

type TruncationState = ReturnType<typeof createTruncationState>;

const EMPTY_TRUNCATION_STATE: TruncationState = {
  truncatedMessageIds: [],
  shouldOfferSummary: false,
};

export function useTruncationTracking(
  activeThread: ChatThread | null,
  activeContextTokenBudget: number | undefined,
): TruncationState {
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

  let activeThreadReasoningEnabled = false;
  let activeThreadReasoningFormat: 'none' | 'auto' | 'deepseek' = 'none';
  let activeThreadResponseReserveTokens: number | undefined;
  if (activeThread) {
    const model = registry.getModel(activeThread.modelId);
    const capability = resolveModelReasoningCapability(model, activeThread.modelId, model?.name);
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

    const windowOptions = resolveThreadInferenceWindowOptions(activeThread, {
      maxContextTokens: activeContextTokenBudget,
      responseReserveTokens: activeThreadResponseReserveTokens,
    });
    const { truncatedMessageIds } = getThreadInferenceWindow(activeThread, windowOptions);
    return createTruncationState(truncatedMessageIds);
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
      modelRegistryRevision,
    ].join(':');

    if (accurateTruncationCacheRef.current.key === cacheKey) {
      setAccurateTruncationState({
        threadId: activeThread.id,
        state: accurateTruncationCacheRef.current.state,
      });
      return;
    }

    setAccurateTruncationState(null);

    const tokenCountParams = {
      enable_thinking: activeThreadReasoningEnabled,
      reasoning_format: activeThreadReasoningFormat,
    };

    const countPromptTokens = async (messages: LlmChatMessage[]) =>
      llmEngineService.countPromptTokens({
        messages,
        params: tokenCountParams,
      });

    void buildInferenceWindowWithAccurateTokenCounts(activeThread, windowOptions, countPromptTokens)
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
          const errorCode = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : null;

          // Expected transient failures (and oversized messages): fall back to heuristics without warning spam.
          if (
            errorCode === 'engine_busy'
            || errorCode === 'engine_not_ready'
            || errorCode === 'engine_unloading'
            || errorCode === 'message_too_long'
          ) {
            return;
          }

          console.warn('[ChatSession] Failed to resolve truncation state accurately, falling back to heuristics', error);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeContextTokenBudget, activeThread, activeThreadReasoningEnabled, activeThreadReasoningFormat, activeThreadResponseReserveTokens, modelRegistryRevision]);

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
