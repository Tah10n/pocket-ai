import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ButtonText } from '@/components/ui/button';
import type { AndroidBlurTargetRef } from '@/utils/androidBlur';
import { ListPickerSheet, type ListPickerSheetItem } from './ListPickerSheet';
import { MaterialSymbols } from './MaterialSymbols';
import { presetManager, SystemPromptPreset } from '../../services/PresetManager';

interface PresetSelectorSheetProps {
  visible: boolean;
  activePresetId: string | null;
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
  onClose: () => void;
  onSelectPreset: (presetId: string | null) => void;
  onManagePresets?: () => void;
}

export function PresetSelectorSheet({
  visible,
  activePresetId,
  androidContentBlurTargetRef,
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

  const items: ListPickerSheetItem[] = [
    {
      key: 'default',
      title: t('common.default'),
      description: t('chat.presetSelector.defaultDescription'),
      selected: activePresetId == null,
      testID: 'preset-option-default',
      onPress: () => {
        onClose();
        onSelectPreset(null);
      },
    },
    ...presets.map((preset) => ({
      key: preset.id,
      title: preset.name,
      description: preset.systemPrompt,
      selected: preset.id === activePresetId,
      testID: `preset-option-${preset.id}`,
      onPress: () => {
        onClose();
        onSelectPreset(preset.id);
      },
    })),
  ];

  return (
    <ListPickerSheet
      visible={visible}
      onClose={onClose}
      title={t('chat.presetSelector.title')}
      subtitle={t('chat.presetSelector.subtitle')}
      androidContentBlurTargetRef={androidContentBlurTargetRef}
      items={items}
      actions={onManagePresets ? (
        <Button
          action="secondary"
          size="sm"
          onPress={() => {
            onClose();
            onManagePresets();
          }}
          className="w-full"
        >
          <MaterialSymbols name="tune" size="md" className="text-typography-700 dark:text-typography-200" />
          <ButtonText>{t('chat.presetSelector.manage')}</ButtonText>
        </Button>
      ) : null}
    />
  );
}
