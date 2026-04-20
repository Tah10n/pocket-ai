import React, { useEffect } from 'react';
import { Modal, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { ScreenPressableCard } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { ListPickerSheetContent, type ListPickerSheetItem } from './ListPickerSheet';
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

  const items: ListPickerSheetItem[] = conversations.map((conversation) => {
    const modelLabel = conversation.modelId.split('/').pop() ?? conversation.modelId;

    return {
      key: conversation.id,
      title: conversation.title,
      description: `${modelLabel} • ${t('chat.messageCount', { count: conversation.messageCount })}`,
      supportingText: conversation.lastMessagePreview,
      selected: conversation.id === activeThreadId,
      testID: `conversation-option-${conversation.id}`,
      onPress: () => {
        onClose();
        onSelectConversation(conversation.id);
      },
    };
  });

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={onClose}>
      <AnimatedView style={[{ flex: 1 }, overlayStyle]}>
      <Box className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" onPress={onClose} />
        <AnimatedView style={sheetStyle}>
        <ListPickerSheetContent
          title={t('chat.conversationSwitcher.title')}
          subtitle={t('chat.conversationSwitcher.subtitle')}
          onClose={onClose}
          items={items}
          sheetClassName={conversations.length === 0 ? 'min-h-[45%]' : undefined}
          actions={(
            <>
              <Box className="flex-row gap-3">
                <Button
                  action="softPrimary"
                  size="sm"
                  onPress={() => {
                    onClose();
                    onStartNewChat();
                  }}
                  className="flex-1"
                >
                  <MaterialSymbols name="edit-square" size="md" className="text-primary-500" />
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
                    <MaterialSymbols name="manage-search" size="md" className="text-typography-700 dark:text-typography-200" />
                    <ButtonText>{t('common.manage')}</ButtonText>
                  </Button>
                ) : null}
              </Box>

              {onOpenPresetSelector ? (
                <ScreenPressableCard
                  testID="conversation-switcher-preset-card"
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
                      size="md"
                      className={canOpenPresetSelector ? 'text-typography-500 dark:text-typography-300' : 'text-typography-300 dark:text-typography-600'}
                    />
                  </Box>
                </ScreenPressableCard>
              ) : null}
            </>
          )}
          emptyState={{
            iconName: 'forum',
            title: t('chat.conversationSwitcher.emptyTitle'),
            description: t('chat.conversationSwitcher.emptyDescription'),
            testID: 'conversation-switcher-empty-state',
          }}
        />
        </AnimatedView>
      </Box>
      </AnimatedView>
    </Modal>
  );
}
