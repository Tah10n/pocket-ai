import { GenerationParameters, getGenerationParametersForModel } from '../services/SettingsStore';
import { getThreadActiveModelId, type ChatThread } from '../types/chat';

export function resolveThreadGenerationParameters(thread: ChatThread): GenerationParameters {
  return getGenerationParametersForModel(getThreadActiveModelId(thread));
}

export function areThreadGenerationParametersEqual(
  paramsSnapshot: ChatThread['paramsSnapshot'],
  resolvedParams: GenerationParameters,
): boolean {
  return (
    paramsSnapshot.temperature === resolvedParams.temperature
    && paramsSnapshot.topP === resolvedParams.topP
    && paramsSnapshot.topK === resolvedParams.topK
    && paramsSnapshot.minP === resolvedParams.minP
    && paramsSnapshot.repetitionPenalty === resolvedParams.repetitionPenalty
    && paramsSnapshot.maxTokens === resolvedParams.maxTokens
    && (paramsSnapshot.seed ?? null) === (resolvedParams.seed ?? null)
    && (paramsSnapshot.reasoningEffort ?? 'auto') === (resolvedParams.reasoningEffort ?? 'auto')
  );
}

export function syncThreadParameters(
  thread: ChatThread,
  updateThreadParamsSnapshot: (threadId: string, paramsSnapshot: GenerationParameters) => void,
  nextParams?: GenerationParameters,
): ChatThread {
  const resolvedParams = nextParams ?? resolveThreadGenerationParameters(thread);
  const paramsChanged = !areThreadGenerationParametersEqual(
    thread.paramsSnapshot,
    resolvedParams,
  );

  if (paramsChanged) {
    updateThreadParamsSnapshot(thread.id, resolvedParams);
  }

  return paramsChanged
    ? {
        ...thread,
        paramsSnapshot: resolvedParams,
      }
    : thread;
}
