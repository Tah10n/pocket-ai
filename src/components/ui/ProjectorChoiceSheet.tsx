import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelMetadata } from '../../types/models';
import type { ProjectorArtifact, ProjectorLifecycleStatus } from '../../types/multimodal';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';
import { formatModelFileSize } from '../../utils/modelSize';
import { projectorArtifactService } from '../../services/ProjectorArtifactService';
import { ListPickerSheet, type ListPickerSheetBadge, type ListPickerSheetItem } from './ListPickerSheet';
import type { MaterialSymbolsProps } from './MaterialSymbols';

interface ProjectorChoiceSheetProps {
  visible: boolean;
  model: ModelMetadata | null;
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
  onSelectProjector: (projectorId: string) => void;
  onClose: () => void;
}

function getProjectorLifecycleBadge(
  projector: ProjectorArtifact,
  t: (key: string) => string,
): ListPickerSheetBadge {
  const presentationByStatus: Record<
    ProjectorLifecycleStatus,
    {
      labelKey: string;
      tone: ListPickerSheetBadge['tone'];
      iconName: MaterialSymbolsProps['name'];
    }
  > = {
    available: {
      labelKey: 'models.vision.projectorAvailable',
      tone: 'neutral',
      iconName: 'extension',
    },
    queued: {
      labelKey: 'models.vision.projectorQueued',
      tone: 'info',
      iconName: 'schedule',
    },
    downloading: {
      labelKey: 'models.vision.projectorDownloading',
      tone: 'info',
      iconName: 'download',
    },
    paused: {
      labelKey: 'models.vision.projectorPaused',
      tone: 'warning',
      iconName: 'pause-circle-outline',
    },
    failed: {
      labelKey: 'models.vision.projectorFailed',
      tone: 'error',
      iconName: 'error-outline',
    },
    downloaded: {
      labelKey: 'models.vision.projectorDownloaded',
      tone: 'success',
      iconName: 'check-circle',
    },
    active: {
      labelKey: 'models.vision.projectorActive',
      tone: 'success',
      iconName: 'visibility',
    },
  };
  const presentation = presentationByStatus[projector.lifecycleStatus];

  return {
    key: 'lifecycle',
    label: t(presentation.labelKey),
    tone: presentation.tone,
    iconName: presentation.iconName,
    testID: `projector-choice-${projector.id}-lifecycle`,
  };
}

export function ProjectorChoiceSheet({
  visible,
  model,
  androidContentBlurTargetRef,
  onSelectProjector,
  onClose,
}: ProjectorChoiceSheetProps) {
  const { t } = useTranslation();
  const items = useMemo<ListPickerSheetItem[]>(() => {
    if (!visible || !model) {
      return [];
    }

    const resolution = projectorArtifactService.resolveProjectorForModel(model);
    return resolution.candidates.map((projector) => {
      const sizeLabel = formatModelFileSize(projector.size, t('models.sizeUnknown'));
      const title = `${projector.fileName} - ${sizeLabel}`;
      const selected = projector.id === model.selectedProjectorId || projector.matchStatus === 'user_selected';
      return {
        key: projector.id,
        title,
        description: projector.ownerVariantId ?? projector.repoId,
        badges: [getProjectorLifecycleBadge(projector, t)],
        selected,
        accessibilityLabel: t('models.vision.projectorChoiceItemAccessibilityLabel', {
          modelName: model.name,
          title,
          fileName: projector.fileName,
        }),
        accessibilityHint: selected
          ? t('models.vision.projectorChoiceItemSelectedAccessibilityHint')
          : t('models.vision.projectorChoiceItemAccessibilityHint'),
        accessibilityState: { selected },
        onPress: () => {
          if (selected) {
            onClose();
          } else {
            onSelectProjector(projector.id);
          }
        },
        testID: `projector-choice-${model.id}-${projector.id}`,
      };
    });
  }, [model, onClose, onSelectProjector, t, visible]);

  return (
    <ListPickerSheet
      visible={visible}
      title={t('models.vision.projectorChoiceTitle')}
      subtitle={t('models.vision.projectorChoiceSubtitle')}
      items={items}
      onClose={onClose}
      androidContentBlurTargetRef={androidContentBlurTargetRef}
      testID="projector-choice-sheet"
      emptyState={{
        title: t('models.vision.projectorChoiceEmptyTitle'),
        description: t('models.vision.projectorChoiceEmptyDescription'),
        iconName: 'extension',
      }}
    />
  );
}
