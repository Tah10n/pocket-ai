import React, { useDeferredValue, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Input, InputField } from '@/components/ui/input';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useChatSession } from '../../hooks/useChatSession';
import { ConversationIndexItem } from '../../types/chat';
import {
  formatConversationUpdatedAt,
  getConversationModelLabel,
  matchesConversationSearch,
} from '../../utils/conversations';
import { typographyColors } from '../../utils/themeTokens';

export function ConversationsScreen() {
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

  const filteredConversations = conversationIndex.filter((conversation) =>
    matchesConversationSearch(conversation, deferredSearchQuery),
  );

  const resetRenameState = () => {
    setEditingThreadId(null);
    setEditingTitle('');
  };

  const handleOpenConversation = (threadId: string) => {
    try {
      openThread(threadId);
      router.push('/(tabs)/chat' as any);
    } catch (error: any) {
      Alert.alert('Cannot open conversation', error?.message || 'Action failed');
    }
  };

  const handleDeleteConversation = (conversation: ConversationIndexItem) => {
    Alert.alert(
      'Delete conversation',
      `Delete "${conversation.title}" from your saved chats?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            try {
              deleteThread(conversation.id);
              if (editingThreadId === conversation.id) {
                resetRenameState();
              }
            } catch (error: any) {
              Alert.alert('Cannot delete conversation', error?.message || 'Action failed');
            }
          },
        },
      ],
    );
  };

  const handleSaveRename = () => {
    if (!editingThreadId) {
      return;
    }

    const normalizedTitle = editingTitle.trim();
    if (!normalizedTitle) {
      Alert.alert('Rename conversation', 'Enter a title before saving.');
      return;
    }

    try {
      renameThread(editingThreadId, normalizedTitle);
      resetRenameState();
    } catch (error: any) {
      Alert.alert('Cannot rename conversation', error?.message || 'Action failed');
    }
  };

  const renderItem: ListRenderItem<ConversationIndexItem> = ({ item }) => {
    const isActive = activeThread?.id === item.id;
    const isEditing = editingThreadId === item.id;

    return (
      <Box className="rounded-3xl border border-outline-200 bg-background-50 p-4 dark:border-outline-800 dark:bg-background-900/60">
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
                    Active
                  </Text>
                </Box>
              ) : null}
            </Box>

            <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
              {getConversationModelLabel(item.modelId)} • {item.messageCount} message{item.messageCount === 1 ? '' : 's'} • {formatConversationUpdatedAt(item.updatedAt)}
            </Text>

            {item.lastMessagePreview ? (
              <Text numberOfLines={2} className="mt-3 text-sm text-typography-700 dark:text-typography-300">
                {item.lastMessagePreview}
              </Text>
            ) : (
              <Text className="mt-3 text-sm text-typography-500 dark:text-typography-400">
                No messages in this conversation yet.
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
          <Box className="mt-4 rounded-2xl border border-primary-500/20 bg-primary-500/5 p-3">
            <Text className="text-xs font-semibold uppercase tracking-wide text-primary-500">
              Rename Conversation
            </Text>

            <Box className="mt-3 rounded-2xl border border-outline-200 bg-background-0 px-3 dark:border-outline-800 dark:bg-background-950">
              <Input className="min-h-12 justify-center">
                <InputField
                  testID={`rename-input-${item.id}`}
                  className="text-base text-typography-900 dark:text-typography-100"
                  placeholder="Conversation title"
                  placeholderTextColor={typographyColors[400]}
                  value={editingTitle}
                  onChangeText={setEditingTitle}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleSaveRename}
                />
              </Input>
            </Box>

            <Box className="mt-3 flex-row justify-end gap-3">
              <Pressable
                onPress={resetRenameState}
                className="rounded-full border border-outline-200 bg-background-0 px-4 py-2 active:opacity-70 dark:border-outline-800 dark:bg-background-950"
              >
                <Text className="text-sm font-medium text-typography-700 dark:text-typography-200">
                  Cancel
                </Text>
              </Pressable>

              <Pressable
                testID={`save-rename-${item.id}`}
                onPress={handleSaveRename}
                className="rounded-full border border-primary-500/20 bg-primary-500 px-4 py-2 active:opacity-80"
              >
                <Text className="text-sm font-semibold text-typography-0">
                  Save
                </Text>
              </Pressable>
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  };

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <Box
        className="border-b border-outline-200 bg-background-0 px-4 pb-4 dark:border-outline-800 dark:bg-background-950"
        style={{ paddingTop: insets.top + 8 }}
      >
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
            className="h-11 w-11 items-center justify-center rounded-full bg-background-100 active:opacity-70 dark:bg-background-900/60"
          >
            <MaterialSymbols name="arrow-back-ios-new" size={20} className="text-primary-500" />
          </Pressable>

          <Box className="flex-1">
            <Text className="text-xl font-bold text-typography-900 dark:text-typography-100">
              All Conversations
            </Text>
            <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
              Search, rename, open, and delete saved chats.
            </Text>
          </Box>

          <Pressable
            testID="start-new-chat"
            onPress={() => {
              try {
                startNewChat();
                router.push('/(tabs)/chat' as any);
              } catch (error: any) {
                Alert.alert('Cannot start a new chat', error?.message || 'Action failed');
              }
            }}
            className="rounded-full border border-primary-500/20 bg-primary-500 px-4 py-3 active:opacity-80"
          >
            <Text className="text-sm font-semibold text-typography-0">
              New Chat
            </Text>
          </Pressable>
        </Box>

        <Box className="mt-4 flex-row items-center rounded-2xl border border-outline-200 bg-background-50 px-3 dark:border-outline-800 dark:bg-background-900/60">
          <MaterialSymbols name="search" size={20} className="text-typography-500 dark:text-typography-400" />
          <Input className="ml-2 flex-1 min-h-12 justify-center">
            <InputField
              testID="conversation-search-input"
              className="text-base text-typography-900 dark:text-typography-100"
              placeholder="Search conversations"
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
      </Box>

      {filteredConversations.length > 0 ? (
        <FlashList
          data={filteredConversations}
          estimatedItemSize={172}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
          ItemSeparatorComponent={() => <Box className="h-4" />}
        />
      ) : (
        <Box className="flex-1 px-4 pb-6" style={{ paddingTop: 24 + insets.top / 4 }}>
          <Box className="rounded-3xl border border-dashed border-outline-200 bg-background-50 px-5 py-6 dark:border-outline-800 dark:bg-background-900/60">
            <Text className="text-base font-semibold text-typography-800 dark:text-typography-100">
              {conversationIndex.length === 0 ? 'No saved conversations yet' : 'No conversations match your search'}
            </Text>
            <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
              {conversationIndex.length === 0
                ? 'Start a chat and it will appear here for later search, rename, and cleanup.'
                : 'Try a different title, model name, or preview keyword.'}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
