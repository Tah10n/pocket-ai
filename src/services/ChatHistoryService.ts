import { useChatStore } from '../store/chatStore';
import { AppError } from './AppError';
import { stopAllGenerationWork } from './ChatGenerationService';
import { notificationService } from './NotificationService';
import { performanceMonitor } from './PerformanceMonitor';
import { clearLegacyChatHistory } from './SettingsStore';
import { documentSessionContextCache } from './DocumentSessionContextCache';

function getChatHistoryPostcondition() {
  const state = useChatStore.getState();
  const remainingThreadCount = Object.keys(state.threads).length;
  const hasValidActiveThread = state.activeThreadId === null
    || state.threads[state.activeThreadId] != null;

  return {
    remainingThreadCount,
    hasValidActiveThread,
  };
}

export async function clearChatHistory(): Promise<number> {
  let generationWorkStopped = false;

  try {
    const drainResult = await stopAllGenerationWork();
    generationWorkStopped = drainResult === 'drained';
    const store = useChatStore.getState();
    const removedThreadIds = Object.keys(store.threads);
    let removedThreads = store.clearAllThreads();
    let postcondition = getChatHistoryPostcondition();

    if (postcondition.remainingThreadCount > 0 && drainResult === 'drained') {
      // Allow the just-drained branch transaction to publish its terminal store
      // state, then make one controlled retry. There is deliberately no loop.
      await Promise.resolve();
      removedThreads += useChatStore.getState().clearAllThreads();
      postcondition = getChatHistoryPostcondition();
    }

    if (postcondition.remainingThreadCount > 0 || !postcondition.hasValidActiveThread) {
      throw new AppError(
        'chat_history_busy',
        'Chat history is still busy. Stop the current generation and try again.',
        {
          details: {
            drainResult,
            remainingThreadCount: postcondition.remainingThreadCount,
          },
        },
      );
    }

    await documentSessionContextCache.clearAll();
    const removedLegacyEntries = clearLegacyChatHistory();
    removedThreadIds.forEach((threadId) => {
      void notificationService.dismissInferenceNotificationForThread(threadId);
    });
    performanceMonitor.mark('chat.history.clear', {
      generationWorkStopped,
      clearHistoryOutcome: 'success',
    });
    return removedThreads + removedLegacyEntries;
  } catch (error) {
    performanceMonitor.mark('chat.history.clear', {
      generationWorkStopped,
      clearHistoryOutcome: 'failure',
      clearHistoryFailureCategory:
        error instanceof AppError ? error.code : 'unknown',
    });
    throw error;
  }
}
