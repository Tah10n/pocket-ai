import React from 'react';
import { View, ScrollView, Text } from 'react-native';
import { HeaderBar } from '../../components/ui/HeaderBar';
import { ChatMessageBubble } from '../../components/ui/ChatMessageBubble';
import { ChatInputBar } from '../../components/ui/ChatInputBar';
import { useChatSession } from '../../../src/hooks/useChatSession';


export const ChatScreen = () => {
    const { messages, appendUserMessage } = useChatSession();

    return (
        <View className="flex-1 bg-background-light dark:bg-background-dark max-w-2xl w-full mx-auto border-x border-primary/10">
            {/* Custom Header with Memory Pill */}
            <HeaderBar title="Llama 3 (8B)" onBack={() => {}} />
            
            <View className="absolute top-16 right-16 z-20 pointer-events-none mt-2">
                <View className="bg-primary/10 dark:bg-primary/20 px-3 py-1 rounded-full border border-primary/20">
                    <Text className="text-[11px] font-bold text-primary tracking-tight uppercase">4.2GB / 8GB Used</Text>
                </View>
            </View>

            <ScrollView 
                className="flex-1 p-4"
                contentContainerStyle={{ gap: 24, paddingBottom: 24 }}
            >
                {messages.map(msg => (
                    <ChatMessageBubble key={msg.id} {...msg} />
                ))}
            </ScrollView>

            <ChatInputBar onSubmit={appendUserMessage} />
        </View>
    );
};