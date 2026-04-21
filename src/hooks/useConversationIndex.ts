import { useCallback, useMemo } from 'react';

import { buildConversationIndex, type ConversationIndexItem } from '../types/chat';
import { useChatStore } from '../store/chatStore';

const EMPTY_INDEX: ConversationIndexItem[] = [];

export function useConversationIndex(options: { enabled?: boolean; limit?: number } = {}) {
  const enabled = options.enabled ?? true;
  const limit = options.limit;

  const threads = useChatStore(
    useCallback(
      (state) => (enabled ? state.threads : null),
      [enabled],
    ),
  );

  return useMemo(() => {
    if (!enabled || !threads) {
      return EMPTY_INDEX;
    }
    const index = buildConversationIndex(threads, { limit });
    return index.length > 0 ? index : EMPTY_INDEX;
  }, [enabled, limit, threads]);
}
