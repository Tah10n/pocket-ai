import type { GenerationParameters } from '../services/SettingsStore';
import { type ChatThread } from '../types/chat';
import { advancedGenerationIdentity, sanitizeAdvancedGenerationParameters } from './generationControls';

export function resolveThreadGenerationParameters(thread: ChatThread): GenerationParameters {
  // Existing chats own their settings. Model defaults seed new chats and explicit
  // model changes; they must not overwrite another chat at Send or Regenerate.
  return {
    ...thread.paramsSnapshot,
    ...sanitizeAdvancedGenerationParameters(thread.paramsSnapshot),
    topK: thread.paramsSnapshot.topK ?? 40,
    minP: thread.paramsSnapshot.minP ?? 0.05,
    repetitionPenalty: thread.paramsSnapshot.repetitionPenalty ?? 1,
  };
}

export function areThreadGenerationParametersEqual(
  paramsSnapshot: ChatThread['paramsSnapshot'],
  resolvedParams: GenerationParameters,
): boolean {
  return (
    paramsSnapshot.temperature === resolvedParams.temperature
    && advancedGenerationIdentity(paramsSnapshot) === advancedGenerationIdentity(resolvedParams)
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
