import React from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { ScrollView } from '@/components/ui/scroll-view';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ActiveModelCard } from '@/components/ui/ActiveModelCard';
import { RecentConversationsList } from '@/components/ui/RecentConversationsList';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useChatSession } from '../../hooks/useChatSession';
import { ConversationIndexItem } from '../../types/chat';

export const HomeScreen = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const { deleteThread, openThread } = useChatSession();

    const handleOpenConversation = (conversation: ConversationIndexItem) => {
        try {
            openThread(conversation.id);
            router.push('/(tabs)/chat' as any);
        } catch (error: any) {
            Alert.alert(t('home.openConversationErrorTitle'), error?.message || t('common.actionFailed'));
        }
    };

    const handleDeleteConversation = (conversation: ConversationIndexItem) => {
        Alert.alert(
            t('home.deleteConversationTitle'),
            t('home.deleteConversationMessage', { title: conversation.title }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () => {
                        try {
                            deleteThread(conversation.id);
                        } catch (error: any) {
                            Alert.alert(t('home.deleteConversationErrorTitle'), error?.message || t('common.actionFailed'));
                        }
                    },
                },
            ],
        );
    };

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <HeaderBar title="Pocket AI" showProfile={false} />
            
            <ScrollView 
                className="flex-1"
                contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
                showsVerticalScrollIndicator={false}
            >
                <ActiveModelCard onSwapModel={() => router.push('/(tabs)/models' as any)} />
                
                <Box className="px-4 py-6">
                    <Pressable 
                        onPress={() => router.push('/(tabs)/chat')}
                        className="flex-row w-full items-center justify-center rounded-xl h-14 bg-primary-500 shadow-xl gap-3 active:opacity-80"
                    >
                        <MaterialSymbols name="add-comment" size={22} className="text-typography-0" />
                        <Text className="text-typography-0 text-base font-bold">{t('home.newChat')}</Text>
                    </Pressable>
                </Box>
                
                <RecentConversationsList
                    onOpenConversation={handleOpenConversation}
                    onDeleteConversation={handleDeleteConversation}
                    onViewAllConversations={() => router.push('/conversations' as any)}
                />
            </ScrollView>
        </Box>
    );
};
