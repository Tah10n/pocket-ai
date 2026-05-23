import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelMetadata } from '../../types/models';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';
import { getVariantMemoryBadgePresentation } from '../../utils/modelMemoryBadgePresentation';
import { formatModelFileSize } from '../../utils/modelSize';
import { getActiveModelVariant, getSelectableModelVariants } from '../../utils/modelVariants';
import { ListPickerSheet, type ListPickerSheetItem } from './ListPickerSheet';

interface ModelVariantPickerSheetProps {
  visible: boolean;
  model: ModelMetadata | null;
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
  onSelectVariant: (variantId: string) => void;
  onClose: () => void;
}

export function ModelVariantPickerSheet({
  visible,
  model,
  androidContentBlurTargetRef,
  onSelectVariant,
  onClose,
}: ModelVariantPickerSheetProps) {
  const { t } = useTranslation();
  const activeVariant = visible && model ? getActiveModelVariant(model) : undefined;
  const items = useMemo<ListPickerSheetItem[]>(() => {
    if (!visible || !model?.variants) {
      return [];
    }

    return getSelectableModelVariants(model).map((variant) => {
      const sizeLabel = formatModelFileSize(variant.size, t('models.sizeUnknown'));
      const selected = variant.variantId === activeVariant?.variantId;
      const memoryBadge = getVariantMemoryBadgePresentation(model, variant, { useModelFallback: selected });
      const title = `${variant.quantizationLabel} - ${sizeLabel}`;
      return {
        key: variant.variantId,
        title,
        description: variant.fileName,
        badges: [{
          key: 'memory-fit',
          label: t(memoryBadge.labelKey),
          tone: memoryBadge.tone,
          iconName: memoryBadge.iconName,
          testID: `model-variant-${model.id}-${variant.variantId}-memory-fit`,
        }],
        selected,
        accessibilityLabel: t('models.variantPickerItemAccessibilityLabel', {
          modelName: model.name,
          title,
          fileName: variant.fileName,
        }),
        accessibilityHint: selected
          ? t('models.variantPickerItemSelectedAccessibilityHint')
          : t('models.variantPickerItemAccessibilityHint'),
        accessibilityState: { selected },
        onPress: () => {
          if (selected) {
            onClose();
          } else {
            onSelectVariant(variant.variantId);
          }
        },
        testID: `model-variant-${model.id}-${variant.variantId}`,
      };
    });
  }, [activeVariant?.variantId, model, onClose, onSelectVariant, t, visible]);

  return (
    <ListPickerSheet
      visible={visible}
      title={t('models.variantPickerTitle')}
      subtitle={t('models.variantPickerSubtitle')}
      items={items}
      onClose={onClose}
      androidContentBlurTargetRef={androidContentBlurTargetRef}
      testID="model-variant-picker"
      emptyState={{
        title: t('models.variantPickerEmptyTitle'),
        description: t('models.variantPickerEmptyDescription'),
        iconName: 'storage',
      }}
    />
  );
}
