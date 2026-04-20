import { useCallback, useMemo } from 'react';

import { type ConversationIndexItem, toConversationIndexItem } from '../types/chat';
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

     const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
       ? Math.max(0, Math.round(limit))
       : null;

     if (normalizedLimit === 0) {
       return EMPTY_INDEX;
     }

     if (normalizedLimit === 1) {
       let mostRecent: ConversationIndexItem | null = null;
       for (const thread of Object.values(threads)) {
         const item = toConversationIndexItem(thread);
         if (!mostRecent || item.updatedAt > mostRecent.updatedAt) {
           mostRecent = item;
         }
       }

       return mostRecent ? [mostRecent] : EMPTY_INDEX;
     }

    const items = Object.values(threads)
      .map(toConversationIndexItem)
      .sort((left, right) => right.updatedAt - left.updatedAt);

    if (typeof normalizedLimit === 'number') {
      return items.slice(0, normalizedLimit);
    }

    return items;
  }, [enabled, limit, threads]);
}
