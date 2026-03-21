import React, { ComponentProps } from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../store/chatStore';
import { ConversationIndexItem, toConversationIndexItem } from '../../types/chat';
import {
  formatConversationUpdatedAt,
  getConversationModelLabel,
} from '../../utils/conversations';

type IconName = ComponentProps<typeof MaterialSymbols>['name'];

interface Conversation extends ConversationIndexItem {
  model: string;
  time: string;
  icon: IconName;
}

interface RecentConversationsListProps {
  onDeleteConversation?: (conversation: ConversationIndexItem) => void;
  onOpenConversation?: (conversation: ConversationIndexItem) => void;
  onViewAllConversations?: () => void;
  maxVisible?: number;
}

const DEFAULT_MAX_VISIBLE_CONVERSATIONS = 5;

export const RecentConversationsList = ({
  onDeleteConversation,
  onOpenConversation,
  onViewAllConversations,
  maxVisible = DEFAULT_MAX_VISIBLE_CONVERSATIONS,
}: RecentConversationsListProps) => {
  const { t } = useTranslation();
  const threads = useChatStore((state) => state.threads);
  const summaries = Object.values(threads)
    .map(toConversationIndexItem)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const conversations: Conversation[] = summaries.map((summary) => ({
    ...summary,
    model: getConversationModelLabel(summary.modelId),
    time: formatConversationUpdatedAt(summary.updatedAt),
    icon: 'chat-bubble',
  }));
  const visibleConversations = conversations.slice(0, maxVisible);
  const shouldShowViewAll = Boolean(onViewAllConversations) && conversations.length > maxVisible;

  const renderItem: ListRenderItem<Conversation> = ({ item: conv }) => (
    <Box className="flex-row items-center rounded-xl bg-background-50 dark:bg-primary-500/5 border border-outline-200 dark:border-primary-500/10">
      <Pressable 
        testID={`recent-conversation-${conv.id}`}
        onPress={() => {
          onOpenConversation?.(conv);
        }}
        className="flex-1 flex-row items-center p-4 active:opacity-70"
      >
        <Box className="size-10 rounded-lg bg-background-100 dark:bg-primary-500/20 items-center justify-center shrink-0">
          <MaterialSymbols name={conv.icon} size={20} className="text-primary-500" />
        </Box>
        
        <Box className="ml-3 flex-1 overflow-hidden">
          <Text className="text-typography-900 dark:text-typography-100 font-semibold truncate" numberOfLines={1}>{conv.title}</Text>
          <Box className="flex-row items-center gap-2 mt-0.5">
            <Text className="text-typography-500 dark:text-typography-400 text-xs">{conv.model}</Text>
            <Box className="w-1 h-1 rounded-full bg-outline-400" />
            <Text className="text-typography-500 dark:text-typography-400 text-xs">{conv.time}</Text>
          </Box>
        </Box>
      </Pressable>

      <Box className="ml-3 flex-row items-center gap-1">
        <Pressable
          testID={`delete-conversation-${conv.id}`}
          onPress={() => {
            onDeleteConversation?.(conv);
          }}
          className="h-9 w-9 items-center justify-center rounded-full bg-background-100 dark:bg-background-900/60 active:opacity-70"
        >
          <MaterialSymbols name="delete-outline" size={18} className="text-error-500" />
        </Pressable>
        <Box className="pr-4">
          <MaterialSymbols name="chevron-right" size={20} className="text-typography-400" />
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box className="px-4 mt-8 pb-4">
      <Box className="mb-4 flex-row items-center justify-between gap-3">
        <Text className="text-typography-900 dark:text-typography-100 text-lg font-bold leading-tight tracking-tight">{t('home.recentConversations')}</Text>
        {shouldShowViewAll ? (
          <Pressable
            testID="view-all-conversations"
            onPress={onViewAllConversations}
            className="rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-2 active:opacity-70"
          >
            <Text className="text-xs font-semibold uppercase tracking-wide text-primary-500">
              {t('home.seeAll')}
            </Text>
          </Pressable>
        ) : null}
      </Box>

      <Box className="flex-1 min-h-80">
        {visibleConversations.length > 0 ? (
          <FlashList<Conversation>
            data={visibleConversations}
            ItemSeparatorComponent={() => <Box className="h-3" />}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
            renderItem={renderItem}
          />
        ) : (
          <Box className="rounded-xl border border-dashed border-outline-200 bg-background-50 px-4 py-6 dark:border-primary-500/10 dark:bg-primary-500/5">
            <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
              {t('home.noConversationsTitle')}
            </Text>
            <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
              {t('home.noConversationsDescription')}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
