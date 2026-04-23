import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelMetadata } from '@/types/models';
import { getShortModelLabel } from '@/utils/modelLabel';
import { ListPickerSheet, type ListPickerSheetItem } from './ListPickerSheet';

interface ChatModelSelectorSheetProps {
  visible: boolean;
  models: ModelMetadata[];
  currentModelId: string | null;
  canSelect?: boolean;
  onClose: () => void;
  onSelectModel: (modelId: string) => void;
}

export function ChatModelSelectorSheet({
  visible,
  models,
  currentModelId,
  canSelect = true,
  onClose,
  onSelectModel,
}: ChatModelSelectorSheetProps) {
  const { t } = useTranslation();

  const items = useMemo<ListPickerSheetItem[]>(() => (
    models.map((model) => {
      const isSelected = model.id === currentModelId;

      return {
        key: model.id,
        title: model.name ?? model.id,
        description: getShortModelLabel(model.id) || model.id,
        selected: isSelected,
        disabled: !canSelect,
        testID: `model-option-${model.id}`,
        onPress: () => {
          onSelectModel(model.id);
        },
      };
    })
  ), [canSelect, currentModelId, models, onSelectModel]);

  return (
    <ListPickerSheet
      visible={visible}
      onClose={onClose}
      title={t('chat.modelSelector.title')}
      subtitle={t('chat.modelSelector.subtitle')}
      items={items}
      emptyState={models.length === 0
        ? {
          title: t('chat.modelSelector.emptyTitle'),
          description: t('chat.modelSelector.emptyDescription'),
          iconName: 'memory',
          testID: 'model-selector-empty',
        }
        : undefined}
      testID="chat-model-selector-sheet"
    />
  );
}
