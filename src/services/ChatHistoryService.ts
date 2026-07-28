import { useChatStore } from '../store/chatStore';
import { AppError } from './AppError';
import { stopAllGenerationWork } from './ChatGenerationService';
import { clearLegacyChatHistory } from './SettingsStore';

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
  const drainResult = await stopAllGenerationWork();
  const store = useChatStore.getState();
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

  const removedLegacyEntries = clearLegacyChatHistory();
  return removedThreads + removedLegacyEntries;
}
