import { useCallback } from 'react';

import { useChatStore } from '../store/chatStore';
import { syncThreadParameters } from '../utils/chatThreadParameters';

export function useChatCommands() {
  const setActiveThread = useChatStore((state) => state.setActiveThread);
  const deleteThreadState = useChatStore((state) => state.deleteThread);
  const renameThreadState = useChatStore((state) => state.renameThread);
  const updateThreadParamsSnapshot = useChatStore((state) => state.updateThreadParamsSnapshot);

  const startNewChat = useCallback(() => {
    const activeThread = useChatStore.getState().getActiveThread();
    if (activeThread?.status === 'generating') {
      throw new Error('Stop the current response before starting a new chat.');
    }

    setActiveThread(null);
  }, [setActiveThread]);

  const openThread = useCallback((threadId: string) => {
    const activeThread = useChatStore.getState().getActiveThread();
    if (activeThread?.status === 'generating' && activeThread.id !== threadId) {
      throw new Error('Stop the current response before switching conversations.');
    }

    const thread = useChatStore.getState().getThread(threadId);
    if (!thread) {
      throw new Error('The selected conversation is no longer available.');
    }

    syncThreadParameters(thread, updateThreadParamsSnapshot);
    setActiveThread(threadId);
  }, [setActiveThread, updateThreadParamsSnapshot]);

  const deleteThread = useCallback((threadId: string) => {
    const thread = useChatStore.getState().getThread(threadId);
    if (thread?.status === 'generating') {
      throw new Error('Stop the current response before deleting this conversation.');
    }

    deleteThreadState(threadId);
  }, [deleteThreadState]);

  const renameThread = useCallback((threadId: string, title: string) => {
    const renamed = renameThreadState(threadId, title);
    if (!renamed) {
      throw new Error('The selected conversation is no longer available.');
    }
  }, [renameThreadState]);

  return {
    deleteThread,
    openThread,
    renameThread,
    startNewChat,
  };
}
