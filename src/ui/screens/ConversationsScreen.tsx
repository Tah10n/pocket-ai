import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Input, InputField } from '@/components/ui/input';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import { ScreenContent, ScreenHeaderShell } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { useChatSession } from '../../hooks/useChatSession';
import { ConversationIndexItem } from '../../types/chat';
import {
  formatConversationUpdatedAt,
  getConversationModelLabel,
  matchesConversationSearch,
} from '../../utils/conversations';
import { getSettings, subscribeSettings, updateSettings } from '../../services/SettingsStore';
import { useChatStore } from '../../store/chatStore';
import { typographyColors } from '../../utils/themeTokens';
import { getReportedErrorMessage } from '../../services/AppError';

const CHAT_RETENTION_OPTIONS = [
  {
    labelKey: 'conversations.retention.foreverLabel',
    descriptionKey: 'conversations.retention.foreverDescription',
    days: null,
  },
  {
    labelKey: 'conversations.retention.days30Label',
    descriptionKey: 'conversations.retention.days30Description',
    days: 30,
  },
  {
    labelKey: 'conversations.retention.days90Label',
    descriptionKey: 'conversations.retention.days90Description',
    days: 90,
  },
  {
    labelKey: 'conversations.retention.year1Label',
    descriptionKey: 'conversations.retention.year1Description',
    days: 365,
  },
] as const;

function formatRetentionLabel(days: number | null, t: (key: string, options?: Record<string, unknown>) => string) {
  if (days == null) {
    return t('conversations.retention.foreverShort');
  }

  if (days === 365) {
    return t('conversations.retention.year1Short');
  }

  return t('conversations.retention.daysShort', { count: days });
}

export function ConversationsScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const canGoBack = router.canGoBack();
  const {
    activeThread,
    conversationIndex,
    deleteThread,
    openThread,
    renameThread,
    startNewChat,
  } = useChatSession();
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [chatRetentionDays, setChatRetentionDays] = useState<number | null>(() => getSettings().chatRetentionDays);
  const [isRetentionExpanded, setRetentionExpanded] = useState(false);

  const filteredConversations = useMemo(() => (
    conversationIndex.filter((conversation) =>
      matchesConversationSearch(conversation, deferredSearchQuery),
    )
  ), [conversationIndex, deferredSearchQuery]);

  const activeRetentionOption = useMemo(
    () => CHAT_RETENTION_OPTIONS.find((option) => option.days === chatRetentionDays) ?? CHAT_RETENTION_OPTIONS[0],
    [chatRetentionDays],
  );

  useEffect(() => {
    return subscribeSettings((settings) => {
      setChatRetentionDays(settings.chatRetentionDays);
    });
  }, []);

  const resetRenameState = useCallback(() => {
    setEditingThreadId(null);
    setEditingTitle('');
  }, []);

  const handleOpenConversation = useCallback((threadId: string) => {
    try {
      openThread(threadId);
      router.push('/(tabs)/chat' as any);
    } catch (error: any) {
      Alert.alert(
        t('conversations.openErrorTitle'),
        getReportedErrorMessage('ConversationsScreen.handleOpenConversation', error, t),
      );
    }
  }, [openThread, router, t]);

  const handleDeleteConversation = useCallback((conversation: ConversationIndexItem) => {
    Alert.alert(
      t('conversations.deleteTitle'),
      t('conversations.deleteMessage', { title: conversation.title }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            try {
              deleteThread(conversation.id);
              if (editingThreadId === conversation.id) {
                resetRenameState();
              }
            } catch (error: any) {
              Alert.alert(
                t('conversations.deleteErrorTitle'),
                getReportedErrorMessage('ConversationsScreen.handleDeleteConversation', error, t),
              );
            }
          },
        },
      ],
    );
  }, [deleteThread, editingThreadId, resetRenameState, t]);

  const handleSaveRename = useCallback(() => {
    if (!editingThreadId) {
      return;
    }

    const normalizedTitle = editingTitle.trim();
    if (!normalizedTitle) {
      Alert.alert(t('conversations.renameTitle'), t('conversations.renamePrompt'));
      return;
    }

    try {
      renameThread(editingThreadId, normalizedTitle);
      resetRenameState();
    } catch (error: any) {
      Alert.alert(
        t('conversations.renameErrorTitle'),
        getReportedErrorMessage('ConversationsScreen.handleSaveRename', error, t),
      );
    }
  }, [editingThreadId, editingTitle, renameThread, resetRenameState, t]);

  const applyChatRetention = (days: number | null) => {
    updateSettings({ chatRetentionDays: days });
    const deletedCount = useChatStore.getState().pruneExpiredThreads(days);
    setRetentionExpanded(false);

    if (deletedCount > 0) {
      Alert.alert(
        t('conversations.retention.cleanupTitle'),
        t('conversations.retention.cleanupMessage', { count: deletedCount }),
      );
    }
  };

  const handleChatRetentionPress = (days: number | null) => {
    if (days === chatRetentionDays) {
      return;
    }

    if (days == null) {
      applyChatRetention(days);
      return;
    }

    Alert.alert(
      t('conversations.retention.confirmTitle'),
      t('conversations.retention.confirmMessage', { retention: formatRetentionLabel(days, t) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.apply'),
          style: 'destructive',
          onPress: () => {
            applyChatRetention(days);
          },
        },
      ],
    );
  };

  const renderRetentionCard = () => (
    <Box className="rounded-3xl border border-outline-200 bg-background-50 p-3.5 dark:border-outline-800 dark:bg-background-900/60">
      <Pressable
        testID="retention-toggle"
        onPress={() => {
          setRetentionExpanded((current) => !current);
        }}
        className="active:opacity-80"
      >
        <Box className="flex-row items-start gap-3">
          <Box className="mt-0.5 h-10 w-10 items-center justify-center rounded-2xl bg-primary-500/10 dark:bg-primary-500/15">
            <MaterialSymbols name="history" size={18} className="text-primary-500" />
          </Box>

          <Box className="min-w-0 flex-1">
            <Box className="flex-row items-center justify-between gap-3">
              <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                {t('conversations.retention.title')}
              </Text>

              <Box className="flex-row items-center gap-2">
                <Box className="rounded-full bg-primary-500/10 px-2.5 py-1 dark:bg-primary-500/15">
                  <Text className="text-2xs font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400">
                    {formatRetentionLabel(chatRetentionDays, t)}
                  </Text>
                </Box>
                <MaterialSymbols
                  name={isRetentionExpanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                  size={20}
                  className="text-typography-500 dark:text-typography-400"
                />
              </Box>
            </Box>

            <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
              {t(activeRetentionOption.descriptionKey)}
            </Text>
          </Box>
        </Box>
      </Pressable>

      {isRetentionExpanded ? (
        <Box className="mt-3 gap-2.5 border-t border-outline-200 pt-3 dark:border-outline-800">
          <Text className="text-sm text-typography-500 dark:text-typography-400">
            {t('conversations.retention.description')}
          </Text>

          {CHAT_RETENTION_OPTIONS.map((option) => {
            const isActive = option.days === chatRetentionDays;

            return (
              <Pressable
                key={option.labelKey}
                testID={`retention-option-${option.days == null ? 'forever' : option.days}`}
                onPress={() => {
                  handleChatRetentionPress(option.days);
                }}
                className={`rounded-2xl border px-3.5 py-2.5 active:opacity-80 ${isActive
                  ? 'border-primary-500/30 bg-primary-500/10'
                  : 'border-outline-200 bg-background-0 dark:border-outline-800 dark:bg-background-950/60'}`}
              >
                <Box className="flex-row items-start justify-between gap-3">
                  <Box className="min-w-0 flex-1">
                    <Text className={`text-sm font-semibold ${isActive
                      ? 'text-primary-600 dark:text-primary-400'
                      : 'text-typography-900 dark:text-typography-100'}`}>
                      {t(option.labelKey)}
                    </Text>
                    <Text className="mt-1 text-xs leading-5 text-typography-500 dark:text-typography-400">
                      {t(option.descriptionKey)}
                    </Text>
                  </Box>

                  <Box className={`rounded-full px-2 py-1 ${isActive ? 'bg-primary-500/15' : 'bg-background-100 dark:bg-background-900/60'}`}>
                    <Text className={`text-2xs font-semibold uppercase tracking-wide ${isActive
                      ? 'text-primary-600 dark:text-primary-400'
                      : 'text-typography-500 dark:text-typography-400'}`}>
                      {isActive ? t('common.active') : formatRetentionLabel(option.days, t)}
                    </Text>
                  </Box>
                </Box>
              </Pressable>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );

  const renderItem = useCallback<ListRenderItem<ConversationIndexItem>>(({ item }) => {
    const isActive = activeThread?.id === item.id;
    const isEditing = editingThreadId === item.id;

    return (
      <Box className="rounded-3xl border border-outline-200 bg-background-50 p-3.5 dark:border-outline-800 dark:bg-background-900/60">
        <Box className="flex-row items-start justify-between gap-3">
          <Pressable
            testID={`conversation-row-${item.id}`}
            onPress={() => {
              if (!isEditing) {
                handleOpenConversation(item.id);
              }
            }}
            className="flex-1 active:opacity-80"
          >
            <Box className="flex-row items-center gap-2">
              <Text
                numberOfLines={isEditing ? undefined : 1}
                className="flex-1 text-base font-semibold text-typography-900 dark:text-typography-100"
              >
                {item.title}
              </Text>
              {isActive ? (
                <Box className="rounded-full bg-primary-500/10 px-2 py-1">
                  <Text className="text-2xs font-semibold uppercase tracking-wide text-primary-500">
                    {t('common.active')}
                  </Text>
                </Box>
              ) : null}
            </Box>

            <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
              {getConversationModelLabel(item.modelId)} • {t('chat.messageCount', { count: item.messageCount })} • {formatConversationUpdatedAt(item.updatedAt)}
            </Text>

            {item.lastMessagePreview ? (
              <Text numberOfLines={2} className="mt-2.5 text-sm text-typography-700 dark:text-typography-300">
                {item.lastMessagePreview}
              </Text>
            ) : (
              <Text className="mt-2.5 text-sm text-typography-500 dark:text-typography-400">
                {t('conversations.noMessagesYet')}
              </Text>
            )}
          </Pressable>

          {!isEditing ? (
            <Box className="flex-row items-center gap-2">
              <Pressable
                testID={`rename-conversation-${item.id}`}
                onPress={() => {
                  setEditingThreadId(item.id);
                  setEditingTitle(item.title);
                }}
                className="h-10 w-10 items-center justify-center rounded-full bg-background-100 active:opacity-70 dark:bg-background-950/70"
              >
                <MaterialSymbols name="edit" size={18} className="text-typography-700 dark:text-typography-200" />
              </Pressable>

              <Pressable
                testID={`delete-conversation-${item.id}`}
                onPress={() => {
                  handleDeleteConversation(item);
                }}
                className="h-10 w-10 items-center justify-center rounded-full bg-background-100 active:opacity-70 dark:bg-background-950/70"
              >
                <MaterialSymbols name="delete-outline" size={18} className="text-error-500" />
              </Pressable>
            </Box>
          ) : null}
        </Box>

        {isEditing ? (
          <Box className="mt-3.5 rounded-2xl border border-primary-500/20 bg-primary-500/5 p-2.5">
            <Text className="text-xs font-semibold uppercase tracking-wide text-primary-500">
              {t('conversations.renameLabel')}
            </Text>

            <Box className="mt-2.5 rounded-2xl border border-outline-200 bg-background-0 px-3 dark:border-outline-800 dark:bg-background-950">
              <Input className="min-h-11 justify-center">
                <InputField
                  testID={`rename-input-${item.id}`}
                  className="text-base text-typography-900 dark:text-typography-100"
                  placeholder={t('conversations.renamePlaceholder')}
                  placeholderTextColor={typographyColors[400]}
                  value={editingTitle}
                  onChangeText={setEditingTitle}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleSaveRename}
                />
              </Input>
            </Box>

            <Box className="mt-2.5 flex-row justify-end gap-3">
              <Pressable
                onPress={resetRenameState}
                className="rounded-full border border-outline-200 bg-background-0 px-4 py-2 active:opacity-70 dark:border-outline-800 dark:bg-background-950"
              >
                <Text className="text-sm font-medium text-typography-700 dark:text-typography-200">
                  {t('common.cancel')}
                </Text>
              </Pressable>

              <Pressable
                testID={`save-rename-${item.id}`}
                onPress={handleSaveRename}
                className="rounded-full border border-primary-500/20 bg-primary-500 px-4 py-2 active:opacity-80"
              >
                <Text className="text-sm font-semibold text-typography-0">
                  {t('common.save')}
                </Text>
              </Pressable>
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  }, [activeThread?.id, editingThreadId, editingTitle, handleDeleteConversation, handleOpenConversation, handleSaveRename, resetRenameState, t]);

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <ScreenHeaderShell contentClassName="px-4 pb-3 pt-1">
        <Box className="flex-row items-center gap-3">
          <Pressable
            testID="conversations-back"
            onPress={() => {
              if (canGoBack) {
                router.back();
                return;
              }

              router.replace('/' as any);
            }}
            className="h-11 w-11 items-center justify-center rounded-full bg-background-50 active:opacity-70 dark:bg-background-900/60"
          >
            <MaterialSymbols name="arrow-back-ios-new" size={20} className="text-primary-500" />
          </Pressable>

          <Box className="flex-1">
            <Text className="text-xl font-bold text-typography-900 dark:text-typography-100">
              {t('conversations.title')}
            </Text>
            <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
              {t('conversations.subtitle')}
            </Text>
          </Box>

          <Pressable
            testID="start-new-chat"
            onPress={() => {
              try {
                startNewChat();
                router.push('/(tabs)/chat' as any);
              } catch (error: any) {
                Alert.alert(
                  t('conversations.startNewChatErrorTitle'),
                  getReportedErrorMessage('ConversationsScreen.startNewChat', error, t),
                );
              }
            }}
            className="rounded-full border border-primary-500/20 bg-primary-500 px-4 py-3 active:opacity-80"
          >
            <Text className="text-sm font-semibold text-typography-0">
              {t('conversations.newChat')}
            </Text>
          </Pressable>
        </Box>

        <Box className="mt-3 flex-row items-center rounded-2xl border border-outline-200 bg-background-50 px-3 dark:border-outline-800 dark:bg-background-900/60">
          <MaterialSymbols name="search" size={20} className="text-typography-500 dark:text-typography-400" />
          <Input className="ml-2 flex-1 min-h-11 justify-center">
            <InputField
              testID="conversation-search-input"
              className="text-base text-typography-900 dark:text-typography-100"
              placeholder={t('conversations.searchPlaceholder')}
              placeholderTextColor={typographyColors[400]}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </Input>
          {searchQuery.length > 0 ? (
            <Pressable
              testID="clear-conversation-search"
              onPress={() => {
                setSearchQuery('');
              }}
              className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
            >
              <MaterialSymbols name="close" size={18} className="text-typography-400" />
            </Pressable>
          ) : null}
        </Box>
      </ScreenHeaderShell>

      <ScreenContent className="flex-1 px-4 pt-3">
        {renderRetentionCard()}

        {filteredConversations.length > 0 ? (
          <Box className="flex-1 pt-3">
            <FlashList
              data={filteredConversations}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
              ItemSeparatorComponent={() => <Box className="h-3" />}
            />
          </Box>
        ) : (
          <Box className="flex-1 pb-5 pt-3">
            <Box className="rounded-2xl border border-dashed border-outline-200 bg-background-50 px-4 py-5 dark:border-outline-800 dark:bg-background-900/60">
              <Text className="text-base font-semibold text-typography-800 dark:text-typography-100">
                {conversationIndex.length === 0 ? t('conversations.emptyTitle') : t('conversations.emptySearchTitle')}
              </Text>
              <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
                {conversationIndex.length === 0
                  ? t('conversations.emptyDescription')
                  : t('conversations.emptySearchDescription')}
              </Text>
            </Box>
          </Box>
        )}
      </ScreenContent>
    </Box>
  );
}
