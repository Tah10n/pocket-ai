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

    const items = Object.values(threads)
      .map(toConversationIndexItem)
      .sort((left, right) => right.updatedAt - left.updatedAt);

    if (typeof limit === 'number' && Number.isFinite(limit)) {
      return items.slice(0, Math.max(0, Math.round(limit)));
    }

    return items;
  }, [enabled, limit, threads]);
}

