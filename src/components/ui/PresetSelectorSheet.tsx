import React, { useEffect, useState } from 'react';
import { Modal } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
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
        <Box className="max-h-[75%] rounded-t-3xl bg-background-0 px-5 pb-8 pt-5 dark:bg-background-950">
          <Box className="mb-4 flex-row items-center justify-between">
            <Box>
              <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                {t('chat.presetSelector.title')}
              </Text>
              <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                {t('chat.presetSelector.subtitle')}
              </Text>
            </Box>
            <Pressable
              onPress={onClose}
              className="h-10 w-10 items-center justify-center rounded-full bg-background-100 active:opacity-70 dark:bg-background-900/60"
            >
              <MaterialSymbols name="close" size={20} className="text-typography-600 dark:text-typography-300" />
            </Pressable>
          </Box>

          {onManagePresets ? (
            <Box className="mb-4">
              <Pressable
                onPress={() => {
                  onClose();
                  onManagePresets();
                }}
                className="flex-row items-center justify-center gap-2 rounded-2xl border border-outline-200 bg-background-50 px-4 py-3 active:opacity-80 dark:border-outline-800 dark:bg-background-900/60"
              >
                <MaterialSymbols name="tune" size={18} className="text-typography-700 dark:text-typography-200" />
                <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
                  {t('chat.presetSelector.manage')}
                </Text>
              </Pressable>
            </Box>
          ) : null}

          <ScrollView showsVerticalScrollIndicator={false}>
            <Box className="gap-3 pb-2">
              <Pressable
                onPress={() => {
                  onClose();
                  onSelectPreset(null);
                }}
                className={`rounded-2xl border px-4 py-3 active:opacity-80 ${activePresetId == null
                  ? 'border-primary-500/30 bg-primary-500/10'
                  : 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900/60'}`}
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
                    <Box className="rounded-full bg-primary-500/10 px-2 py-1">
                      <Text className="text-2xs font-semibold uppercase tracking-wide text-primary-500">
                        {t('common.active')}
                      </Text>
                    </Box>
                  ) : (
                    <MaterialSymbols name="chevron-right" size={18} className="text-typography-400" />
                  )}
                </Box>
              </Pressable>

              {presets.map((preset) => {
                const isActive = preset.id === activePresetId;

                return (
                  <Pressable
                    key={preset.id}
                    onPress={() => {
                      onClose();
                      onSelectPreset(preset.id);
                    }}
                    className={`rounded-2xl border px-4 py-3 active:opacity-80 ${isActive
                      ? 'border-primary-500/30 bg-primary-500/10'
                      : 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900/60'}`}
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
                        <Box className="rounded-full bg-primary-500/10 px-2 py-1">
                          <Text className="text-2xs font-semibold uppercase tracking-wide text-primary-500">
                            {t('common.active')}
                          </Text>
                        </Box>
                      ) : (
                        <MaterialSymbols name="chevron-right" size={18} className="text-typography-400" />
                      )}
                    </Box>
                  </Pressable>
                );
              })}
            </Box>
          </ScrollView>
        </Box>
      </Box>
    </Modal>
  );
}
