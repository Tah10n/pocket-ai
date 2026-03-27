import React from 'react';
import { Alert } from 'react-native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { Box } from '@/components/ui/box';
import { ScrollView } from '@/components/ui/scroll-view';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenContent } from '@/components/ui/ScreenShell';
import { ActiveModelCard } from '@/components/ui/ActiveModelCard';
import { RecentConversationsList } from '@/components/ui/RecentConversationsList';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useChatSession } from '../../hooks/useChatSession';
import { ConversationIndexItem } from '../../types/chat';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { registry } from '@/services/LocalStorageRegistry';
import { getReportedErrorMessage } from '../../services/AppError';

export const HomeScreen = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const tabBarHeight = useBottomTabBarHeight();
    const router = useRouter();
    const { deleteThread, openThread, startNewChat } = useChatSession();
    const { state: engineState } = useLLMEngine();

    const handleOpenModelPicker = () => {
        const hasDownloadedModels = registry.getModels().some((model) => Boolean(model.localPath));
        const params = engineState.activeModelId || !hasDownloadedModels
            ? undefined
            : { initialTab: 'downloaded' as const };
        router.push({ pathname: '/(tabs)/models', params } as any);
    };

    const handleOpenConversation = (conversation: ConversationIndexItem) => {
        try {
            openThread(conversation.id);
            router.push('/(tabs)/chat' as any);
        } catch (error: any) {
            Alert.alert(
                t('home.openConversationErrorTitle'),
                getReportedErrorMessage('HomeScreen.handleOpenConversation', error, t),
            );
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
                            Alert.alert(
                                t('home.deleteConversationErrorTitle'),
                                getReportedErrorMessage('HomeScreen.handleDeleteConversation', error, t),
                            );
                        }
                    },
                },
            ],
        );
    };

    const handleStartNewChat = () => {
        try {
            startNewChat();
            router.push('/(tabs)/chat' as any);
        } catch (error: any) {
            Alert.alert(
                t('conversations.startNewChatErrorTitle'),
                getReportedErrorMessage('HomeScreen.handleStartNewChat', error, t),
            );
        }
    };

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <HeaderBar title="Pocket AI" showProfile={false} />

            <ScreenContent className="flex-1">
                <ScrollView
                    className="flex-1"
                    contentContainerStyle={{ paddingBottom: tabBarHeight + Math.max(insets.bottom, 24) }}
                    showsVerticalScrollIndicator={false}
                >
                    <ActiveModelCard onSwapModel={handleOpenModelPicker} />

                    <Box className="px-4 pb-2 pt-3">
                        <Pressable
                            onPress={handleStartNewChat}
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
            </ScreenContent>
        </Box>
    );
};
