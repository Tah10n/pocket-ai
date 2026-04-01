import React, { useEffect } from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { ScrollView } from '@/components/ui/scroll-view';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenActionPill, ScreenContent, ScreenStack } from '@/components/ui/ScreenShell';
import { ActiveModelCard } from '@/components/ui/ActiveModelCard';
import { RecentConversationsList } from '@/components/ui/RecentConversationsList';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { useTranslation } from 'react-i18next';
import { useChatCommands } from '../../hooks/useChatCommands';
import { ConversationIndexItem } from '../../types/chat';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { registry } from '@/services/LocalStorageRegistry';
import { performanceMonitor } from '@/services/PerformanceMonitor';
import { getReportedErrorMessage } from '../../services/AppError';
import { useBootstrapStore } from '@/store/bootstrapStore';
import { screenLayoutMetrics } from '../../utils/themeTokens';

let hasMarkedFirstUsableScreen = false;

export const HomeScreen = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const { deleteThread, openThread, startNewChat } = useChatCommands();
  const { state: engineState } = useLLMEngine();
  const bootstrapBackgroundState = useBootstrapStore((state) => state.backgroundState);
  const bootstrapBackgroundError = useBootstrapStore((state) => state.backgroundError);

  useEffect(() => {
    if (!hasMarkedFirstUsableScreen) {
      hasMarkedFirstUsableScreen = true;
      performanceMonitor.mark('startup.firstUsableScreen');
    }
  }, []);

  const handleOpenModelPicker = () => {
    const hasDownloadedModels = registry.getModels().some((model) => Boolean(model.localPath));
    const params = engineState.activeModelId || !hasDownloadedModels
      ? undefined
      : { initialTab: 'downloaded' as const };
    router.navigate({ pathname: '/(tabs)/models', params } as any);
  };

  const handleOpenConversation = (conversation: ConversationIndexItem) => {
    try {
      openThread(conversation.id);
      router.navigate('/(tabs)/chat' as any);
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
      router.navigate('/(tabs)/chat' as any);
    } catch (error: any) {
      Alert.alert(
        t('conversations.startNewChatErrorTitle'),
        getReportedErrorMessage('HomeScreen.handleStartNewChat', error, t),
      );
    }
  };

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <HeaderBar title="Pocket AI" showBrand />

      {bootstrapBackgroundState === 'running' ? (
        <Box className="mx-4 mt-2 flex-row items-center gap-2 rounded-xl border border-outline-200 bg-background-50 px-3 py-2 dark:border-outline-700 dark:bg-background-900/80">
          <Spinner size="small" />
          <Text className="text-sm text-typography-600 dark:text-typography-300">
            {t('home.initializing')}
          </Text>
        </Box>
      ) : null}

      {bootstrapBackgroundState === 'error' ? (
        <Box className="mx-4 mt-2 rounded-2xl border border-error-300 bg-background-error px-3 py-2.5 dark:border-error-800">
          <Text className="text-sm font-semibold text-error-700 dark:text-error-200">
            {t('home.initializationFailedTitle')}
          </Text>
          <Text className="mt-1 text-sm text-error-700 dark:text-error-300">
            {t('home.initializationFailedMessage')}
          </Text>
          {__DEV__ && bootstrapBackgroundError ? (
            <Text className="mt-2 text-xs text-error-700 dark:text-error-300">{bootstrapBackgroundError}</Text>
          ) : null}
        </Box>
      ) : null}

      <ScreenContent testID="home-screen-content" className="flex-1" style={{ paddingBottom: 0 }}>
        <ScrollView
          testID="home-scroll-view"
          className="flex-1"
          contentContainerStyle={{ paddingBottom: screenLayoutMetrics.contentBottomInset }}
          showsVerticalScrollIndicator={false}
        >
          <ScreenStack className="pt-3" gap="loose">
            <ActiveModelCard onSwapModel={handleOpenModelPicker} />

            <ScreenActionPill
              onPress={handleStartNewChat}
              accessibilityRole="button"
              accessibilityLabel={t('home.newChat')}
              tone="primary"
              size="prominent"
              className="w-full gap-3 shadow-xl"
            >
              <MaterialSymbols name="add-comment" size={22} className="text-typography-0" />
              <Text className="text-typography-0 text-base font-bold">{t('home.newChat')}</Text>
            </ScreenActionPill>

            <RecentConversationsList
              onOpenConversation={handleOpenConversation}
              onDeleteConversation={handleDeleteConversation}
              onViewAllConversations={() => router.push('/conversations' as any)}
            />
          </ScreenStack>
        </ScrollView>
      </ScreenContent>
    </Box>
  );
};
