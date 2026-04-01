import React, { ComponentProps, useCallback, useMemo } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { Box } from '@/components/ui/box';
import { Text, composeTextRole } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { useTranslation } from 'react-i18next';
import { useConversationIndex } from '../../hooks/useConversationIndex';
import { ConversationIndexItem } from '../../types/chat';
import { Pressable } from '@/components/ui/pressable';
import { ScreenActionPill, ScreenCard, ScreenIconButton, ScreenStack } from './ScreenShell';
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
  const isFocused = useIsFocused();
  const summaries = useConversationIndex({ enabled: isFocused, limit: maxVisible });

  const conversations: Conversation[] = useMemo(() => summaries.map((summary) => ({
    ...summary,
    model: getConversationModelLabel(summary.modelId),
    time: formatConversationUpdatedAt(summary.updatedAt),
    icon: 'chat-bubble',
  })), [summaries]);
  const visibleConversations = conversations;
  const canManageConversations = Boolean(onViewAllConversations);

  const renderConversation = useCallback((conv: Conversation) => (
    <ScreenCard className="flex-row items-center" padding="none">
      <Pressable 
        testID={`recent-conversation-${conv.id}`}
        onPress={() => {
          onOpenConversation?.(conv);
        }}
        accessibilityRole="button"
        accessibilityLabel={conv.title}
        className="flex-1 flex-row items-center gap-3 p-4 active:opacity-70"
      >
        <Box className="size-11 shrink-0 items-center justify-center">
          <MaterialSymbols name={conv.icon} size={18} className="text-primary-500" />
        </Box>
        
        <Box className="min-w-0 flex-1 overflow-hidden">
          <Text className={composeTextRole('sectionTitle')} numberOfLines={1}>
            {conv.title}
          </Text>
          <Box className="mt-1 flex-row items-center gap-2">
            <Text className={composeTextRole('caption')}>
              {conv.model}
            </Text>
            <Box className="w-1 h-1 rounded-full bg-outline-400" />
            <Text className={composeTextRole('caption')}>
              {conv.time}
            </Text>
          </Box>
        </Box>
      </Pressable>

      <Box className="mr-3 flex-row items-center gap-2">
        <ScreenIconButton
          testID={`delete-conversation-${conv.id}`}
          onPress={() => {
            onDeleteConversation?.(conv);
          }}
          accessibilityLabel={`${t('common.delete')} ${conv.title}`}
          iconName="delete-outline"
          size="compact"
          tone="danger"
          className="shrink-0 border-0"
        />
        <Box>
          <MaterialSymbols name="chevron-right" size={20} className="text-typography-400" />
        </Box>
      </Box>
    </ScreenCard>
  ), [onDeleteConversation, onOpenConversation, t]);

  return (
    <ScreenStack gap="default">
      <Box className="mb-3 flex-row items-center justify-between gap-3">
        <Text className={composeTextRole('sectionTitle', 'text-lg tracking-tight')}>
          {t('home.recentConversations')}
        </Text>
        {canManageConversations ? (
          <ScreenActionPill
            testID="manage-conversations-button"
            onPress={onViewAllConversations}
            accessibilityLabel={t('common.manage')}
            className="self-start"
          >
            <MaterialSymbols name="history" size={16} className="text-primary-500" />
            <Text className="text-xs font-semibold uppercase tracking-wide text-primary-500">
              {t('common.manage')}
            </Text>
          </ScreenActionPill>
        ) : null}
      </Box>

      <Box>
        {visibleConversations.length > 0 ? (
          <ScreenStack>
            {visibleConversations.map((conversation) => (
              <React.Fragment key={conversation.id}>
                {renderConversation(conversation)}
              </React.Fragment>
            ))}
          </ScreenStack>
        ) : (
          <ScreenCard dashed className="dark:border-outline-700" padding="large">
            <Text className={composeTextRole('sectionTitle', 'text-sm')}>
              {t('home.noConversationsTitle')}
            </Text>
            <Text className={composeTextRole('bodyMuted', 'mt-2')}>
              {t('home.noConversationsDescription')}
            </Text>
          </ScreenCard>
        )}
      </Box>
    </ScreenStack>
  );
};
