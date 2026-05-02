import React from 'react';
import { Box } from '@/components/ui/box';
import { Text, composeTextRole } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { ScreenActionPill, ScreenBadge, ScreenCard, ScreenStack, useScreenAppearance } from './ScreenShell';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { useModelRegistryRevision } from '@/hooks/useModelRegistryRevision';
import { registry } from '@/services/LocalStorageRegistry';
import { EngineStatus } from '@/types/models';
import { DECIMAL_GIGABYTE } from '@/utils/modelSize';
import { getThemeActionContentClassName } from '@/utils/themeTokens';
import { useTranslation } from 'react-i18next';

interface ActiveModelCardProps {
  onSwapModel?: () => void;
}

export const ActiveModelCard = ({ onSwapModel }: ActiveModelCardProps) => {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const neutralToneClassNames = appearance.classNames.toneClassNameByTone.neutral;
  const primaryActionContentClassName = getThemeActionContentClassName(appearance, 'primary');
  const { state } = useLLMEngine();
  useModelRegistryRevision();
  const activeModel = state.activeModelId ? registry.getModel(state.activeModelId) : undefined;
  const downloadedModelsCount = registry.getDownloadedModelsCount();
  const isReady = state.status === EngineStatus.READY;
  const hasActiveModel = Boolean(activeModel);
  const hasDownloadedModels = downloadedModelsCount > 0;
  const statusLabel = isReady
    ? t('home.activeModelStatusReady')
    : state.status === EngineStatus.INITIALIZING
      ? t('chat.warmingUp')
      : t('home.activeModelStatusIdle');
  const statusTone = isReady
    ? 'success'
    : state.status === EngineStatus.INITIALIZING
      ? 'warning'
      : 'neutral';
  const modelName = activeModel?.name ?? t('home.activeModelEmptyTitle');
  const modelId = activeModel?.id;
  const inferredAuthor = modelId && modelId.includes('/') ? modelId.split('/')[0] : null;
  const modelTag = activeModel
    ? activeModel.author || inferredAuthor || t('common.unknown')
    : t('home.activeModelOfflineTag');
  const memoryLabel = activeModel
    ? activeModel.size === null
      ? t('models.sizeUnknown')
      : t('home.activeModelDiskFootprint', { size: (activeModel.size / DECIMAL_GIGABYTE).toFixed(1) })
    : hasDownloadedModels
      ? t('home.activeModelDownloadedCount', { count: downloadedModelsCount })
      : t('home.activeModelEmptyDescription');
  const speedLabel = isReady
    ? t('home.activeModelEngineLoaded')
    : hasActiveModel
      ? t('home.activeModelReadyToLoad')
      : hasDownloadedModels
        ? t('home.activeModelChooseDownloaded')
        : t('home.activeModelUnavailable');
  const ctaLabel = hasActiveModel
    ? t('home.swapModel')
    : hasDownloadedModels
      ? t('home.chooseModel')
      : t('home.browseModels');

  return (
    <ScreenCard className="overflow-hidden" tone={hasActiveModel ? 'accent' : 'default'} padding="none">
      <Box className={`border-b px-4 py-2 ${appearance.classNames.dividerClassName}`}>
        <ScreenBadge tone={statusTone} size="micro" className="self-start">
          {statusLabel}
        </ScreenBadge>
      </Box>

      <ScreenStack className="px-4 py-3" gap="compact">
        <Text className={composeTextRole('caption')}>
          {t('home.activeModelTitle')}
        </Text>
        <Box className="flex-row flex-wrap items-center gap-2">
          <Text className={composeTextRole('screenTitle', 'flex-1 tracking-tight')}>
            {modelName}
          </Text>
          <ScreenBadge tone={hasActiveModel ? 'accent' : 'neutral'} size="micro">
            {modelTag}
          </ScreenBadge>
        </Box>

        <Box className="mt-1 flex-row items-start justify-between gap-4">
          <Box className="flex-1 gap-1.5">
            <Box className="flex-row items-center gap-1">
              <MaterialSymbols name="memory" size="sm" className={neutralToneClassNames.iconClassName} />
              <Text className={composeTextRole('caption')}>{memoryLabel}</Text>
            </Box>
            <Box className="flex-row items-center gap-1">
              <MaterialSymbols name="speed" size="sm" className={neutralToneClassNames.iconClassName} />
              <Text className={composeTextRole('caption')}>{speedLabel}</Text>
            </Box>
          </Box>

          <ScreenActionPill onPress={onSwapModel} tone="primary" size="sm" className="shrink-0">
            <Text className={composeTextRole('action', primaryActionContentClassName)}>{ctaLabel}</Text>
          </ScreenActionPill>
        </Box>
      </ScreenStack>
    </ScreenCard>
  );
};
