import React, { useEffect } from 'react';
import { Modal, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { ScreenModalOverlay, ScreenPressableCard } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { getShortModelLabel } from '@/utils/modelLabel';
import type { AndroidBlurTargetRef } from '@/utils/androidBlur';
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
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
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
  androidContentBlurTargetRef,
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
    const modelLabel = getShortModelLabel(conversation.modelId) || conversation.modelId;

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
      <ScreenModalOverlay>
        <Pressable className="flex-1" onPress={onClose} />
        <AnimatedView style={sheetStyle}>
        <ListPickerSheetContent
          title={t('chat.conversationSwitcher.title')}
          subtitle={t('chat.conversationSwitcher.subtitle')}
          onClose={onClose}
          androidContentBlurTargetRef={androidContentBlurTargetRef}
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
                  <MaterialSymbols colorRole="accent" name="edit-square" size="md" className="" />
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
                    <MaterialSymbols colorRole="secondary" name="manage-search" size="md" className=" " />
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
                  className={!canOpenPresetSelector ? 'opacity-60' : ''}
                >
                  <Box className="flex-row items-center justify-between gap-3">
                    <Box className="min-w-0 flex-1">
                      <Text colorRole="primary" className="text-sm font-semibold  ">
                        {t('chat.conversationSwitcher.presetTitle')}
                      </Text>
                      <Text colorRole="tertiary" className="mt-1 text-sm  " numberOfLines={1}>
                        {canOpenPresetSelector
                          ? t('chat.conversationSwitcher.presetCurrent', { name: activePresetName ?? t('common.default') })
                          : t('chat.conversationSwitcher.presetBlocked')}
                      </Text>
                    </Box>

                    <MaterialSymbols colorRole="tertiary"
                      name="tune"
                      size="md"
                      className={canOpenPresetSelector ? ' ' : ' '}
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
      </ScreenModalOverlay>
      </AnimatedView>
    </Modal>
  );
}
