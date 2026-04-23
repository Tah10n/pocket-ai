import { ConversationIndexItem } from '../types/chat';
import { getShortModelLabel } from './modelLabel';

export function formatConversationUpdatedAt(timestamp: number) {
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(1, Math.floor(diffMs / (60 * 1000)));

  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hr ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }

  return new Date(timestamp).toLocaleDateString();
}

export function getConversationModelLabel(modelId: string) {
  return getShortModelLabel(modelId) || modelId;
}

export function matchesConversationSearch(
  conversation: ConversationIndexItem,
  searchQuery: string,
) {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return [
    conversation.title,
    conversation.lastMessagePreview,
    conversation.modelId,
    getConversationModelLabel(conversation.modelId),
  ]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(normalizedQuery));
}
