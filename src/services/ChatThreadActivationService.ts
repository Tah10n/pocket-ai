import { useChatStore } from '../store/chatStore';
import { getThreadActiveModelId } from '../types/chat';
import {
  areThreadGenerationParametersEqual,
  resolveThreadGenerationParameters,
} from '../utils/chatThreadParameters';
import { hasActiveChatGenerationWork } from './ChatGenerationService';

export type ChatThreadActivationResult =
  | { status: 'opened'; threadId: string }
  | { status: 'already_active'; threadId: string }
  | { status: 'missing' }
  | { status: 'generation_busy' }
  | { status: 'stale' }
  | { status: 'persistence_failed'; error: unknown };

export function activateThreadForNavigation(
  requestedThreadId: string,
): ChatThreadActivationResult {
  const threadId = typeof requestedThreadId === 'string'
    ? requestedThreadId.trim()
    : '';
  if (!threadId) {
    return { status: 'missing' };
  }

  const snapshot = useChatStore.getState();
  const targetThread = snapshot.threads[threadId];
  if (!targetThread) {
    return { status: 'missing' };
  }

  if (snapshot.activeThreadId === threadId) {
    return { status: 'already_active', threadId };
  }

  const activeThread = snapshot.activeThreadId
    ? snapshot.threads[snapshot.activeThreadId]
    : null;
  if (
    hasActiveChatGenerationWork()
    || activeThread?.status === 'generating'
  ) {
    return { status: 'generation_busy' };
  }

  try {
    const paramsSnapshot = resolveThreadGenerationParameters(targetThread);
    const commitResult = snapshot.commitThreadActivation({
      threadId,
      expectedActiveThreadId: snapshot.activeThreadId,
      paramsSnapshot,
    });

    if (commitResult.status !== 'applied') {
      return commitResult;
    }

    const committedState = useChatStore.getState();
    const committedThread = committedState.threads[threadId];
    if (
      !committedThread
      || committedState.activeThreadId !== threadId
      || getThreadActiveModelId(committedThread) !== getThreadActiveModelId(targetThread)
      || !areThreadGenerationParametersEqual(
        committedThread.paramsSnapshot,
        paramsSnapshot,
      )
    ) {
      return { status: 'stale' };
    }

    return { status: 'opened', threadId };
  } catch (error) {
    return { status: 'persistence_failed', error };
  }
}
