import React from 'react';
import { Modal } from 'react-native';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { ConversationIndexItem } from '../../types/chat';

interface ConversationSwitcherSheetProps {
  visible: boolean;
  activeThreadId: string | null;
  conversations: ConversationIndexItem[];
  onClose: () => void;
  onSelectConversation: (threadId: string) => void;
  onStartNewChat: () => void;
}

export function ConversationSwitcherSheet({
  visible,
  activeThreadId,
  conversations,
  onClose,
  onSelectConversation,
  onStartNewChat,
}: ConversationSwitcherSheetProps) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Box className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" onPress={onClose} />
        <Box className="max-h-[75%] rounded-t-3xl bg-background-0 px-5 pb-8 pt-5 dark:bg-background-950">
          <Box className="mb-4 flex-row items-center justify-between">
            <Box>
              <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                Conversations
              </Text>
              <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                Switch threads without losing your current context.
              </Text>
            </Box>
            <Pressable
              onPress={onClose}
              className="h-10 w-10 items-center justify-center rounded-full bg-background-100 active:opacity-70 dark:bg-background-900/60"
            >
              <MaterialSymbols name="close" size={20} className="text-typography-600 dark:text-typography-300" />
            </Pressable>
          </Box>

          <Pressable
            onPress={() => {
              onClose();
              onStartNewChat();
            }}
            className="mb-4 flex-row items-center justify-center gap-2 rounded-2xl border border-primary-500/20 bg-primary-500/10 px-4 py-3 active:opacity-80"
          >
            <MaterialSymbols name="edit-square" size={18} className="text-primary-500" />
            <Text className="text-sm font-semibold text-primary-500">
              Start New Chat
            </Text>
          </Pressable>

          <ScrollView showsVerticalScrollIndicator={false}>
            <Box className="gap-3 pb-2">
              {conversations.length > 0 ? (
                conversations.map((conversation) => {
                  const isActive = conversation.id === activeThreadId;
                  const modelLabel = conversation.modelId.split('/').pop() ?? conversation.modelId;

                  return (
                    <Pressable
                      key={conversation.id}
                      onPress={() => {
                        onClose();
                        onSelectConversation(conversation.id);
                      }}
                      className={`rounded-2xl border px-4 py-3 active:opacity-80 ${isActive
                        ? 'border-primary-500/30 bg-primary-500/10'
                        : 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900/60'}`}
                    >
                      <Box className="flex-row items-start justify-between gap-3">
                        <Box className="min-w-0 flex-1">
                          <Text
                            numberOfLines={1}
                            className={`text-sm font-semibold ${isActive
                              ? 'text-primary-600 dark:text-primary-400'
                              : 'text-typography-900 dark:text-typography-100'}`}
                          >
                            {conversation.title}
                          </Text>
                          <Text
                            numberOfLines={1}
                            className="mt-1 text-xs text-typography-500 dark:text-typography-400"
                          >
                            {modelLabel} • {conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}
                          </Text>
                          {conversation.lastMessagePreview ? (
                            <Text
                              numberOfLines={2}
                              className="mt-2 text-sm text-typography-600 dark:text-typography-300"
                            >
                              {conversation.lastMessagePreview}
                            </Text>
                          ) : null}
                        </Box>

                        {isActive ? (
                          <Box className="rounded-full bg-primary-500/10 px-2 py-1">
                            <Text className="text-2xs font-semibold uppercase tracking-wide text-primary-500">
                              Active
                            </Text>
                          </Box>
                        ) : (
                          <MaterialSymbols name="chevron-right" size={18} className="text-typography-400" />
                        )}
                      </Box>
                    </Pressable>
                  );
                })
              ) : (
                <Box className="rounded-2xl border border-dashed border-outline-200 px-4 py-6 dark:border-outline-800">
                  <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
                    No saved conversations yet
                  </Text>
                  <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
                    Start chatting and your saved threads will appear here.
                  </Text>
                </Box>
              )}
            </Box>
          </ScrollView>
        </Box>
      </Box>
    </Modal>
  );
}
