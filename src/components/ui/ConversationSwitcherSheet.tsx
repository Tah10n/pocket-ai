import React, { useEffect } from 'react';
import { Modal, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { ScreenBadge, ScreenIconButton, ScreenPressableCard, ScreenSheet } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { ConversationIndexItem } from '../../types/chat';
import { useMotionPreferences } from '../../hooks/useDeviceMetrics';

const AnimatedView = Animated.createAnimatedComponent(View);

interface ConversationSwitcherSheetProps {
  visible: boolean;
  activeThreadId: string | null;
  conversations: ConversationIndexItem[];
  activePresetName?: string;
  canOpenPresetSelector?: boolean;
  onClose: () => void;
  onSelectConversation: (threadId: string) => void;
  onStartNewChat: () => void;
  onOpenPresetSelector?: () => void;
  onManageConversations?: () => void;
}

export function ConversationSwitcherSheet({
  visible,
  activeThreadId,
  conversations,
  activePresetName,
  canOpenPresetSelector = true,
  onClose,
  onSelectConversation,
  onStartNewChat,
  onOpenPresetSelector,
  onManageConversations,
}: ConversationSwitcherSheetProps) {
  const { t } = useTranslation();
  const motion = useMotionPreferences();
  const overlayOpacity = useSharedValue(visible ? 1 : 0);
  const sheetTranslateY = useSharedValue(visible ? 0 : 28);

  useEffect(() => {
    overlayOpacity.value = withTiming(visible ? 1 : 0, {
      duration: motion.sheetDurationMs,
      easing: Easing.out(Easing.ease),
    });
    sheetTranslateY.value = withTiming(visible ? 0 : motion.motionPreset === 'full' ? 28 : 0, {
      duration: motion.sheetDurationMs,
      easing: Easing.out(Easing.cubic),
    });
  }, [motion.motionPreset, motion.sheetDurationMs, overlayOpacity, sheetTranslateY, visible]);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={onClose}>
      <AnimatedView style={[{ flex: 1 }, overlayStyle]}>
      <Box className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" onPress={onClose} />
        <AnimatedView style={sheetStyle}>
        <ScreenSheet className="max-h-[75%] pb-8">
          <Box className="mb-4 flex-row items-center justify-between">
            <Box>
              <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                {t('chat.conversationSwitcher.title')}
              </Text>
              <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                {t('chat.conversationSwitcher.subtitle')}
              </Text>
            </Box>
            <ScreenIconButton
              onPress={onClose}
              accessibilityLabel={t('common.cancel')}
              iconName="close"
            />
          </Box>

          <Box className="mb-3 flex-row gap-3">
            <Button
              action="softPrimary"
              size="sm"
              onPress={() => {
                onClose();
                onStartNewChat();
              }}
              className="flex-1"
            >
              <MaterialSymbols name="edit-square" size={18} className="text-primary-500" />
              <ButtonText>{t('chat.conversationSwitcher.startNewChat')}</ButtonText>
            </Button>

            {onManageConversations ? (
              <Button
                action="secondary"
                size="sm"
                onPress={() => {
                  onClose();
                  onManageConversations();
                }}
                className="flex-1"
              >
                <MaterialSymbols name="manage-search" size={18} className="text-typography-700 dark:text-typography-200" />
                <ButtonText>{t('common.manage')}</ButtonText>
              </Button>
              ) : null}
          </Box>

          {onOpenPresetSelector ? (
            <Box className="mb-4">
              <ScreenPressableCard
                onPress={() => {
                  onClose();
                  onOpenPresetSelector();
                }}
                disabled={!canOpenPresetSelector}
                padding="compact"
                className={!canOpenPresetSelector ? 'border-outline-100 bg-background-100/80 dark:border-outline-900 dark:bg-background-900/40' : ''}
              >
                <Box className="flex-row items-center justify-between gap-3">
                  <Box className="min-w-0 flex-1">
                    <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">
                      {t('chat.conversationSwitcher.presetTitle')}
                    </Text>
                    <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400" numberOfLines={1}>
                      {canOpenPresetSelector
                        ? t('chat.conversationSwitcher.presetCurrent', { name: activePresetName ?? t('common.default') })
                        : t('chat.conversationSwitcher.presetBlocked')}
                    </Text>
                  </Box>

                  <MaterialSymbols
                    name="tune"
                    size={18}
                    className={canOpenPresetSelector ? 'text-typography-500 dark:text-typography-300' : 'text-typography-300 dark:text-typography-600'}
                  />
                </Box>
              </ScreenPressableCard>
            </Box>
          ) : null}

          <ScrollView showsVerticalScrollIndicator={false}>
            <Box className="gap-3 pb-2">
              {conversations.length > 0 ? (
                conversations.map((conversation) => {
                  const isActive = conversation.id === activeThreadId;
                  const modelLabel = conversation.modelId.split('/').pop() ?? conversation.modelId;

                  return (
                    <ScreenPressableCard
                      key={conversation.id}
                      onPress={() => {
                        onClose();
                        onSelectConversation(conversation.id);
                      }}
                      padding="compact"
                      className={isActive ? 'border-primary-500/30 bg-primary-500/10' : ''}
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
                            {modelLabel} • {t('chat.messageCount', { count: conversation.messageCount })}
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
                          <ScreenBadge tone="accent" size="micro">
                            {t('common.active')}
                          </ScreenBadge>
                        ) : (
                          <MaterialSymbols name="chevron-right" size={18} className="text-typography-400" />
                        )}
                      </Box>
                    </ScreenPressableCard>
                  );
                })
              ) : (
                <Box className="rounded-2xl border border-dashed border-outline-200 px-4 py-6 dark:border-outline-800">
                  <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
                    {t('chat.conversationSwitcher.emptyTitle')}
                  </Text>
                  <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
                    {t('chat.conversationSwitcher.emptyDescription')}
                  </Text>
                </Box>
              )}
            </Box>
          </ScrollView>
        </ScreenSheet>
        </AnimatedView>
      </Box>
      </AnimatedView>
    </Modal>
  );
}
