import { GenerationParameters, getGenerationParametersForModel } from '../services/SettingsStore';
import { type ChatThread } from '../types/chat';

export function syncThreadParameters(
  thread: ChatThread,
  updateThreadParamsSnapshot: (threadId: string, paramsSnapshot: GenerationParameters) => void,
  nextParams?: GenerationParameters,
): ChatThread {
  const resolvedParams = nextParams ?? getGenerationParametersForModel(thread.modelId);
  const paramsChanged =
    thread.paramsSnapshot.temperature !== resolvedParams.temperature
    || thread.paramsSnapshot.topP !== resolvedParams.topP
    || thread.paramsSnapshot.topK !== resolvedParams.topK
    || thread.paramsSnapshot.minP !== resolvedParams.minP
    || thread.paramsSnapshot.repetitionPenalty !== resolvedParams.repetitionPenalty
    || thread.paramsSnapshot.maxTokens !== resolvedParams.maxTokens
    || (thread.paramsSnapshot.reasoningEnabled === true) !== (resolvedParams.reasoningEnabled === true);

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
