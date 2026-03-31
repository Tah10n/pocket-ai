import React, { useEffect, useState } from 'react';
import { Modal } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { ScreenBadge, ScreenIconButton, ScreenPressableCard, ScreenSheet } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { presetManager, SystemPromptPreset } from '../../services/PresetManager';

interface PresetSelectorSheetProps {
  visible: boolean;
  activePresetId: string | null;
  onClose: () => void;
  onSelectPreset: (presetId: string | null) => void;
  onManagePresets?: () => void;
}

export function PresetSelectorSheet({
  visible,
  activePresetId,
  onClose,
  onSelectPreset,
  onManagePresets,
}: PresetSelectorSheetProps) {
  const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
  const { t } = useTranslation();

  useEffect(() => {
    if (visible) {
      setPresets(presetManager.getPresets());
    }
  }, [visible]);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Box className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" onPress={onClose} />
        <ScreenSheet className="max-h-[75%] pb-8">
          <Box className="mb-4 flex-row items-center justify-between">
            <Box>
              <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                {t('chat.presetSelector.title')}
              </Text>
              <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                {t('chat.presetSelector.subtitle')}
              </Text>
            </Box>
            <ScreenIconButton
              onPress={onClose}
              accessibilityLabel={t('common.cancel')}
              iconName="close"
            />
          </Box>

          {onManagePresets ? (
            <Box className="mb-4">
              <Button
                action="secondary"
                size="sm"
                onPress={() => {
                  onClose();
                  onManagePresets();
                }}
                className="w-full"
              >
                <MaterialSymbols name="tune" size={18} className="text-typography-700 dark:text-typography-200" />
                <ButtonText>{t('chat.presetSelector.manage')}</ButtonText>
              </Button>
            </Box>
          ) : null}

          <ScrollView showsVerticalScrollIndicator={false}>
            <Box className="gap-3 pb-2">
              <ScreenPressableCard
                onPress={() => {
                  onClose();
                  onSelectPreset(null);
                }}
                padding="compact"
                className={activePresetId == null ? 'border-primary-500/30 bg-primary-500/10' : ''}
              >
                <Box className="flex-row items-start justify-between gap-3">
                  <Box className="min-w-0 flex-1">
                    <Text
                      numberOfLines={1}
                      className={`text-sm font-semibold ${activePresetId == null
                        ? 'text-primary-600 dark:text-primary-400'
                        : 'text-typography-900 dark:text-typography-100'}`}
                    >
                      {t('common.default')}
                    </Text>
                    <Text
                      numberOfLines={2}
                      className="mt-1 text-xs text-typography-500 dark:text-typography-400"
                    >
                      {t('chat.presetSelector.defaultDescription')}
                    </Text>
                  </Box>
                  {activePresetId == null ? (
                    <ScreenBadge tone="success" size="micro">
                      {t('common.active')}
                    </ScreenBadge>
                  ) : (
                    <MaterialSymbols name="chevron-right" size={18} className="text-typography-400" />
                  )}
                </Box>
              </ScreenPressableCard>

              {presets.map((preset) => {
                const isActive = preset.id === activePresetId;

                return (
                  <ScreenPressableCard
                    key={preset.id}
                    onPress={() => {
                      onClose();
                      onSelectPreset(preset.id);
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
                          {preset.name}
                        </Text>
                        <Text
                          numberOfLines={2}
                          className="mt-1 text-xs text-typography-500 dark:text-typography-400"
                        >
                          {preset.systemPrompt}
                        </Text>
                      </Box>
                      {isActive ? (
                        <ScreenBadge tone="success" size="micro">
                          {t('common.active')}
                        </ScreenBadge>
                      ) : (
                        <MaterialSymbols name="chevron-right" size={18} className="text-typography-400" />
                      )}
                    </Box>
                  </ScreenPressableCard>
                );
              })}
            </Box>
          </ScrollView>
        </ScreenSheet>
      </Box>
    </Modal>
  );
}
