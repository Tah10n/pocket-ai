import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import {
  ScreenActionPill,
  ScreenBadge,
  ScreenCard,
  ScreenContent,
  ScreenIconButton,
  ScreenIconTile,
  ScreenInlineInput,
  ScreenModalOverlay,
  ScreenPressableCard,
  ScreenRoot,
  ScreenSheet,
  ScreenStack,
  useFloatingHeaderInset,
  useScreenAppearance,
} from '@/components/ui/ScreenShell';
import { Text, composeTextRole } from '@/components/ui/text';
import { useChatSession } from '../../hooks/useChatSession';
import { useConversationIndex } from '../../hooks/useConversationIndex';
import { ConversationIndexItem } from '../../types/chat';
import {
  formatConversationUpdatedAt,
  getConversationModelLabel,
  matchesConversationSearch,
} from '../../utils/conversations';
import { getSettings, subscribeSettings, updateSettings } from '../../services/SettingsStore';
import { getReportedErrorMessage } from '../../services/AppError';
import { useChatStore } from '../../store/chatStore';
import { getThemeActionContentClassName } from '../../utils/themeTokens';

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
  const appearance = useScreenAppearance();
  const headerInset = useFloatingHeaderInset();
  const primaryActionContentClassName = getThemeActionContentClassName(appearance, 'primary');
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const router = useRouter();
  const canGoBack = router.canGoBack();
  const conversationIndex = useConversationIndex({ enabled: isFocused });
  const activeThreadId = useChatStore((state) => state.activeThreadId);
  const { deleteThread, openThread, renameThread, startNewChat } = useChatSession();
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [chatRetentionDays, setChatRetentionDays] = useState<number | null>(() => getSettings().chatRetentionDays);
  const [isRetentionExpanded, setRetentionExpanded] = useState(false);
  const handleBack = useCallback(() => {
    if (canGoBack) {
      router.back();
      return;
    }

    router.replace('/');
  }, [canGoBack, router]);

  const filteredConversations = useMemo(() => (
    conversationIndex.filter((conversation) =>
      matchesConversationSearch(conversation, deferredSearchQuery),
    )
  ), [conversationIndex, deferredSearchQuery]);

  const activeRetentionOption = useMemo(
    () => CHAT_RETENTION_OPTIONS.find((option) => option.days === chatRetentionDays) ?? CHAT_RETENTION_OPTIONS[0],
    [chatRetentionDays],
  );
  const editingConversation = useMemo(
    () => conversationIndex.find((conversation) => conversation.id === editingThreadId) ?? null,
    [conversationIndex, editingThreadId],
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
      router.push('/(tabs)/chat');
    } catch (error: any) {
      Alert.alert(
        t('conversations.openErrorTitle'),
        getReportedErrorMessage('ConversationsScreen.handleOpenConversation', error, t),
      );
    }
  }, [openThread, router, t]);

  const handleStartNewChat = useCallback(() => {
    try {
      startNewChat();
      router.push('/(tabs)/chat');
    } catch (error: any) {
      Alert.alert(
        t('conversations.startNewChatErrorTitle'),
        getReportedErrorMessage('ConversationsScreen.startNewChat', error, t),
      );
    }
  }, [router, startNewChat, t]);

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
    <ScreenCard padding="compact">
      <Pressable
        testID="retention-toggle"
        onPress={() => {
          setRetentionExpanded((current) => !current);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('conversations.retention.title')}
        className="active:opacity-80"
      >
        <Box className="flex-row items-start gap-3">
          <ScreenIconTile iconName="history" tone="accent" className="mt-0.5" iconClassName="text-primary-500" />

          <Box className="min-w-0 flex-1">
            <Box className="flex-row items-center justify-between gap-3">
              <Text className={composeTextRole('sectionTitle')}>
                {t('conversations.retention.title')}
              </Text>

              <Box className="flex-row items-center gap-2">
                <ScreenBadge tone="accent" size="micro">
                  {formatRetentionLabel(chatRetentionDays, t)}
                </ScreenBadge>
                <MaterialSymbols
                  name={isRetentionExpanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                  size="lg"
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
        <Box className={`mt-3 gap-2 border-t pt-3 ${appearance.classNames.dividerClassName}`}>
          <Text className="text-sm text-typography-500 dark:text-typography-400">
            {t('conversations.retention.description')}
          </Text>

          {CHAT_RETENTION_OPTIONS.map((option) => {
            const isActive = option.days === chatRetentionDays;

            return (
              <ScreenPressableCard
                key={option.labelKey}
                testID={`retention-option-${option.days == null ? 'forever' : option.days}`}
                onPress={() => {
                  handleChatRetentionPress(option.days);
                }}
                accessibilityLabel={t(option.labelKey)}
                accessibilityState={{ selected: isActive }}
                variant="inset"
                padding="compact"
                className={isActive ? appearance.classNames.selectedInsetCardClassName : ''}
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

                  <ScreenBadge tone={isActive ? 'success' : 'neutral'} size="micro">
                    {isActive ? t('common.active') : formatRetentionLabel(option.days, t)}
                  </ScreenBadge>
                </Box>
              </ScreenPressableCard>
            );
          })}
        </Box>
      ) : null}
    </ScreenCard>
  );

  const renderItem = useCallback<ListRenderItem<ConversationIndexItem>>(({ item }) => {
    const isActive = activeThreadId === item.id;

    return (
      <ScreenCard decorative="tint" padding="compact">
        <Box className="flex-row items-start justify-between gap-3">
          <Pressable
            testID={`conversation-row-${item.id}`}
            onPress={() => {
              handleOpenConversation(item.id);
            }}
            accessibilityRole="button"
            accessibilityLabel={item.title}
            className="flex-1 active:opacity-80"
          >
            <Box className="flex-row items-center gap-2">
              <Text
                numberOfLines={1}
                className={composeTextRole('sectionTitle', 'flex-1')}
              >
                {item.title}
              </Text>
              {isActive ? (
                <ScreenBadge tone="success" size="micro">
                  {t('common.active')}
                </ScreenBadge>
              ) : null}
            </Box>

            <Text className={composeTextRole('caption', 'mt-1.5')}>
              {getConversationModelLabel(item.modelId)} • {t('chat.messageCount', { count: item.messageCount })} • {formatConversationUpdatedAt(item.updatedAt)}
            </Text>

            {item.lastMessagePreview ? (
              <Text numberOfLines={2} className={composeTextRole('body', 'mt-2')}>
                {item.lastMessagePreview}
              </Text>
            ) : (
              <Text className={composeTextRole('bodyMuted', 'mt-2')}>
                {t('conversations.noMessagesYet')}
              </Text>
            )}
          </Pressable>

          <Box className="flex-row items-center gap-2">
            <ScreenIconButton
              testID={`rename-conversation-${item.id}`}
              onPress={() => {
                setEditingThreadId(item.id);
                setEditingTitle(item.title);
              }}
              accessibilityLabel={`${t('conversations.renameLabel')} ${item.title}`}
              iconName="edit"
            />

            <ScreenIconButton
              testID={`delete-conversation-${item.id}`}
              onPress={() => {
                handleDeleteConversation(item);
              }}
              accessibilityLabel={`${t('common.delete')} ${item.title}`}
              iconName="delete-outline"
              size="compact"
              tone="danger"
              className="shrink-0 border-0"
            />
          </Box>
        </Box>
      </ScreenCard>
    );
  }, [activeThreadId, handleDeleteConversation, handleOpenConversation, t]);

  return (
    <ScreenRoot>
      <HeaderBar
        title={t('conversations.title')}
        subtitle={t('conversations.subtitle')}
        onBack={handleBack}
        backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
        rightAccessory={(
          <ScreenActionPill
            testID="start-new-chat"
            onPress={handleStartNewChat}
            accessibilityLabel={t('conversations.newChat')}
            tone="primary"
            size="lg"
            className="shrink-0"
          >
            <MaterialSymbols name="edit-square" size="sm" className={primaryActionContentClassName} />
            <Text className={`text-sm font-semibold ${primaryActionContentClassName}`}>
              {t('conversations.newChat')}
            </Text>
          </ScreenActionPill>
        )}
      />

      <ScreenContent
        className="flex-1"
        respectFloatingHeader={false}
        style={{ paddingTop: headerInset + 8 }}
      >
        <ScreenStack className="flex-1" gap="compact">
          <ScreenInlineInput
            variant="search"
            testID="conversation-search-input"
            accessibilityLabel={t('conversations.searchPlaceholder')}
            placeholder={t('conversations.searchPlaceholder')}
            value={searchQuery}
            onChangeText={setSearchQuery}
            leadingAccessory={<MaterialSymbols name="search" size="sm" className="text-typography-500 dark:text-typography-400" />}
            trailingAccessory={searchQuery.length > 0 ? (
              <ScreenIconButton
                testID="clear-conversation-search"
                onPress={() => {
                  setSearchQuery('');
                }}
                accessibilityLabel={t('common.clear')}
                iconName="close"
                size="compact"
                className="border-0 bg-transparent dark:bg-transparent"
                iconClassName="text-typography-400"
              />
            ) : null}
          />

          {renderRetentionCard()}

          {filteredConversations.length > 0 ? (
            <Box className="flex-1">
              <FlashList
                data={filteredConversations}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
                ItemSeparatorComponent={() => <Box className="h-2" />}
              />
            </Box>
          ) : (
            <Box className="flex-1 pt-4">
              <ScreenCard padding="compact" decorative="matte">
                <ScreenIconTile
                  iconName={conversationIndex.length === 0 ? 'forum' : 'search'}
                  tone="accent"
                  size="lg"
                  iconSize="xl"
                  className="h-10 w-10 rounded-xl"
                  iconClassName="text-primary-500"
                />

                <Text className={composeTextRole('screenTitle', 'mt-3')}>
                  {conversationIndex.length === 0 ? t('conversations.emptyTitle') : t('conversations.emptySearchTitle')}
                </Text>

                <Text className={composeTextRole('bodyMuted', 'mt-2')}>
                  {conversationIndex.length === 0
                    ? t('conversations.emptyDescription')
                    : t('conversations.emptySearchDescription')}
                </Text>

                {conversationIndex.length === 0 ? null : (
                  <Button action="secondary" size="sm" className="mt-5 self-start" onPress={() => setSearchQuery('')}>
                    <ButtonText>{t('common.clear')}</ButtonText>
                  </Button>
                )}
              </ScreenCard>
            </Box>
          )}
        </ScreenStack>
      </ScreenContent>

      <Modal visible={editingThreadId !== null} animationType="fade" transparent onRequestClose={resetRenameState}>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={0}>
          <ScreenModalOverlay>
            <Pressable className="flex-1" onPress={resetRenameState} />
            <ScreenSheet>
              <Box className="mb-5 flex-row items-start justify-between gap-4">
                <Box className="min-w-0 flex-1">
                  <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                    {t('conversations.renameTitle')}
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                    {editingConversation?.title ?? t('conversations.renameLabel')}
                  </Text>
                </Box>

                <ScreenIconButton
                  onPress={resetRenameState}
                  accessibilityLabel={t('common.cancel')}
                  iconName="close"
                />
              </Box>

              <ScreenInlineInput
                testID={editingThreadId ? `rename-input-${editingThreadId}` : 'rename-input'}
                className="mt-1"
                placeholder={t('conversations.renamePlaceholder')}
                value={editingTitle}
                onChangeText={setEditingTitle}
                autoFocus
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={handleSaveRename}
              />

              <Box className="mt-4 flex-row gap-3">
                <Button action="secondary" className="flex-1" onPress={resetRenameState}>
                  <ButtonText>{t('common.cancel')}</ButtonText>
                </Button>
                <Button
                  testID={editingThreadId ? `save-rename-${editingThreadId}` : 'save-rename'}
                  className="flex-1"
                  onPress={handleSaveRename}
                >
                  <ButtonText>{t('common.save')}</ButtonText>
                </Button>
              </Box>
            </ScreenSheet>
          </ScreenModalOverlay>
        </KeyboardAvoidingView>
      </Modal>
    </ScreenRoot>
  );
}
