import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { FlashList } from '@shopify/flash-list';
import { ChatHeader } from '../../components/ui/ChatHeader';
import { ChatMessageBubble } from '../../components/ui/ChatMessageBubble';
import { ChatInputBar } from '../../components/ui/ChatInputBar';
import { useChatSession } from '../../../src/hooks/useChatSession';
import { useRouter } from 'expo-router';


export const ChatScreen = () => {
    const { messages, appendUserMessage } = useChatSession();
    const router = useRouter();
    const canGoBack = router.canGoBack();

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950 max-w-2xl w-full mx-auto border-x border-primary-500/10">
            <ChatHeader 
                title="Llama 3 (8B)" 
                badgeLabel="Local Model"
                memoryLabel="4.2GB / 8GB Used"
                onBack={canGoBack ? () => router.back() : undefined}
            />

            <Box className="flex-1 p-4">
                <FlashList
                    data={messages}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
                    ItemSeparatorComponent={() => <Box className="h-6" />}
                    keyExtractor={(item) => item.id}
                    ListEmptyComponent={() => (
                        <Box className="flex-1 items-center justify-center px-6">
                            <Text className="text-base font-semibold text-typography-700 dark:text-typography-300">
                                No messages yet
                            </Text>
                            <Text className="mt-2 text-center text-sm text-typography-500 dark:text-typography-400">
                                Type something below to start the conversation.
                            </Text>
                        </Box>
                    )}
                    renderItem={({ item: msg }) => (
                        <ChatMessageBubble {...msg} />
                    )}
                />
            </Box>

            <ChatInputBar onSendMessage={appendUserMessage} />
        </Box>
    );
};
