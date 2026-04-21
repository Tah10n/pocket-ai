import { GenerationParameters, getGenerationParametersForModel } from '../services/SettingsStore';
import { getThreadActiveModelId, type ChatThread } from '../types/chat';

export function syncThreadParameters(
  thread: ChatThread,
  updateThreadParamsSnapshot: (threadId: string, paramsSnapshot: GenerationParameters) => void,
  nextParams?: GenerationParameters,
): ChatThread {
  const resolvedParams = nextParams ?? getGenerationParametersForModel(getThreadActiveModelId(thread));
  const paramsChanged =
    thread.paramsSnapshot.temperature !== resolvedParams.temperature
    || thread.paramsSnapshot.topP !== resolvedParams.topP
    || thread.paramsSnapshot.topK !== resolvedParams.topK
    || thread.paramsSnapshot.minP !== resolvedParams.minP
    || thread.paramsSnapshot.repetitionPenalty !== resolvedParams.repetitionPenalty
    || thread.paramsSnapshot.maxTokens !== resolvedParams.maxTokens
    || (thread.paramsSnapshot.seed ?? null) !== (resolvedParams.seed ?? null)
    || (thread.paramsSnapshot.reasoningEffort ?? 'auto') !== (resolvedParams.reasoningEffort ?? 'auto');

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
