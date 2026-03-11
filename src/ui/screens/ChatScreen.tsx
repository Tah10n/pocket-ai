import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { FlashList } from '@shopify/flash-list';
import { HeaderBar } from '../../components/ui/HeaderBar';
import { ChatMessageBubble } from '../../components/ui/ChatMessageBubble';
import { ChatInputBar } from '../../components/ui/ChatInputBar';
import { useChatSession } from '../../../src/hooks/useChatSession';


export const ChatScreen = () => {
    const { messages, appendUserMessage } = useChatSession();

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950 max-w-2xl w-full mx-auto border-x border-primary-500/10">
            {/* Custom Header with Memory Pill */}
            <HeaderBar title="Llama 3 (8B)" onBack={() => {}} />
            
            <Box className="absolute top-16 right-16 z-20 pointer-events-none mt-2">
                <Box className="bg-primary-500/10 dark:bg-primary-500/20 px-3 py-1 rounded-full border border-primary-500/20">
                    <Text className="text-xs font-bold text-primary-500 tracking-tight uppercase">4.2GB / 8GB Used</Text>
                </Box>
            </Box>

            <Box className="flex-1 p-4">
                <FlashList
                    data={messages}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingBottom: 24 }}
                    ItemSeparatorComponent={() => <Box className="h-6" />}
                    renderItem={({ item: msg }) => (
                        <ChatMessageBubble {...msg} />
                    )}
                />
            </Box>

            <ChatInputBar onSendMessage={appendUserMessage} />
        </Box>
    );
};