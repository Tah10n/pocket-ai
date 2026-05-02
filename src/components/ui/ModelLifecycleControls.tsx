import React from 'react';
import { useTranslation } from 'react-i18next';
import { ModelAccessState, LifecycleStatus, type ModelMetadata } from '../../types/models';
import { useDownloadStore } from '../../store/downloadStore';
import { Box } from './box';
import { ProgressBar } from './ProgressBar';
import { joinClassNames, ScreenActionPill, ScreenIconButton, ScreenIconTile, ScreenSurface, useScreenAppearance } from './ScreenShell';
import { getThemeActionContentClassName } from '../../utils/themeTokens';
import { MaterialSymbols, type MaterialSymbolName } from './MaterialSymbols';
import { Text } from './text';

interface ModelLifecycleActionRowProps {
  model: ModelMetadata;
  onDownload: (model: ModelMetadata) => void;
  onConfigureToken: () => void;
  onOpenModelPage: (modelId: string) => void;
  onLoad: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onUnload: () => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
  onChat: () => void;
  className?: string;
  pillClassName?: string;
}

function ActionPill({
  label,
  onPress,
  tone = 'soft',
  testID,
  className,
}: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'soft';
  testID?: string;
  className?: string;
}) {
  const appearance = useScreenAppearance();

  return (
    <ScreenActionPill
      testID={testID}
      onPress={onPress}
      tone={tone}
      size="sm"
      className={className ?? 'min-w-0 basis-0 flex-1'}
    >
      <Text
        numberOfLines={1}
        className={`text-center text-sm font-semibold ${getThemeActionContentClassName(appearance, tone)}`}
      >
        {label}
      </Text>
    </ScreenActionPill>
  );
}

export function isModelDownloading(model: Pick<ModelMetadata, 'lifecycleStatus'> | null | undefined): boolean {
  return model?.lifecycleStatus === LifecycleStatus.DOWNLOADING
    || model?.lifecycleStatus === LifecycleStatus.QUEUED
    || model?.lifecycleStatus === LifecycleStatus.VERIFYING;
}

export function ModelDownloadProgress({
  density = 'comfortable',
  model,
  className,
}: {
  density?: 'compact' | 'comfortable';
  model: Pick<ModelMetadata, 'id' | 'downloadProgress' | 'lifecycleStatus'>;
  className?: string;
}) {
  if (!isModelDownloading(model) && model.lifecycleStatus !== LifecycleStatus.PAUSED) {
    return null;
  }

  return (
    <ModelDownloadProgressInner
      modelId={model.id}
      lifecycleStatus={model.lifecycleStatus}
      fallbackProgress={model.downloadProgress}
      density={density}
      className={className}
    />
  );
}

function ModelDownloadProgressInner({
  modelId,
  lifecycleStatus,
  fallbackProgress,
  density,
  className,
}: {
  modelId: string;
  lifecycleStatus: LifecycleStatus;
  fallbackProgress: number;
  density: 'compact' | 'comfortable';
  className?: string;
}) {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const downloadProgress = useDownloadStore((state) => {
    const queuedModel = state.queue.find((queuedItem) => queuedItem.id === modelId);
    return queuedModel?.downloadProgress ?? fallbackProgress;
  });

  const rawProgressPercent = Number.isFinite(downloadProgress)
    ? Math.round(downloadProgress * 100)
    : 0;
  const progressPercent = Math.max(0, Math.min(100, rawProgressPercent));
  const progressPresentation = getDownloadProgressPresentation(lifecycleStatus, t);
  const progressTone = progressPresentation.progressTone === 'primary' ? 'accent' : progressPresentation.progressTone;
  const progressToneClassNames = appearance.classNames.toneClassNameByTone[progressTone];
  const isCompact = density === 'compact';

  return (
    <ScreenSurface
      testID={`model-download-progress-${modelId}`}
      tone={progressTone}
      withControlTint
      className={joinClassNames(
        'rounded-2xl border',
        isCompact ? 'px-2.5 py-2' : 'px-3 py-2.5',
        progressToneClassNames.surfaceClassName,
        className,
      )}
    >
      <Box className={joinClassNames('flex-row items-center justify-between gap-3', isCompact ? 'mb-1.5' : 'mb-2')}>
        <Box className={joinClassNames('min-w-0 flex-1 flex-row items-center', isCompact ? 'gap-1.5' : 'gap-2')}>
          <ScreenIconTile
            iconName={progressPresentation.iconName}
            tone={progressTone}
            iconSize="sm"
            size="sm"
            className={isCompact ? 'h-7 w-7 rounded-full' : 'h-8 w-8 rounded-full'}
          >
            <MaterialSymbols name={progressPresentation.iconName} size="sm" className={progressToneClassNames.iconClassName} />
          </ScreenIconTile>
          <Text numberOfLines={1} className={joinClassNames('min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide', progressToneClassNames.textClassName)}>
            {progressPresentation.label}
          </Text>
        </Box>

        <ScreenSurface tone={progressTone} withControlTint className={joinClassNames('rounded-full', isCompact ? 'px-2 py-0.5' : 'px-2.5 py-1', progressToneClassNames.percentPillClassName)}>
          <Text className={joinClassNames('text-xs font-bold', progressToneClassNames.textClassName)}>{progressPercent}%</Text>
        </ScreenSurface>
      </Box>
      <ProgressBar
        testID={`model-download-progress-track-${modelId}`}
        fillTestID={`model-download-progress-fill-${modelId}`}
        valuePercent={progressPercent}
        size={isCompact ? 'md' : 'lg'}
        tone={progressPresentation.progressTone}
        variant="framed"
      />
    </ScreenSurface>
  );
}

function getDownloadProgressPresentation(lifecycleStatus: LifecycleStatus, t: (key: string) => string): {
  iconName: MaterialSymbolName;
  label: string;
  progressTone: 'neutral' | 'primary' | 'success' | 'warning';
} {
  if (lifecycleStatus === LifecycleStatus.VERIFYING) {
    return {
      iconName: 'check-circle',
      label: t('models.verifying'),
      progressTone: 'success',
    };
  }

  if (lifecycleStatus === LifecycleStatus.PAUSED) {
    return {
      iconName: 'pause-circle-outline',
      label: t('models.paused'),
      progressTone: 'warning',
    };
  }

  if (lifecycleStatus === LifecycleStatus.QUEUED) {
    return {
      iconName: 'schedule',
      label: t('models.statusQueued'),
      progressTone: 'primary',
    };
  }

  return {
    iconName: 'download',
    label: t('models.downloading'),
    progressTone: 'primary',
  };
}

export function ModelLifecycleActionRow({
  model,
  onDownload,
  onConfigureToken,
  onOpenModelPage,
  onLoad,
  onOpenSettings,
  onUnload,
  onDelete,
  onCancel,
  onChat,
  className,
  pillClassName,
}: ModelLifecycleActionRowProps) {
  const { t } = useTranslation();

  return (
    <Box className={className ?? 'flex-row items-center gap-2'}>
      {model.lifecycleStatus === LifecycleStatus.AVAILABLE ? (
        model.accessState === ModelAccessState.AUTH_REQUIRED ? (
          <ActionPill label={t('models.setToken')} onPress={onConfigureToken} className={pillClassName} />
        ) : model.accessState === ModelAccessState.ACCESS_DENIED ? (
          <ActionPill
            label={t('models.openOnHuggingFace')}
            onPress={() => onOpenModelPage(model.id)}
            className={pillClassName}
          />
        ) : (
          <ActionPill
            label={t('models.download')}
            tone="primary"
            onPress={() => onDownload(model)}
            className={pillClassName}
          />
        )
      ) : null}

      {model.lifecycleStatus === LifecycleStatus.PAUSED ? (
        <ActionPill
          label={t('models.resume')}
          tone="primary"
          onPress={() => onDownload(model)}
          className={pillClassName}
        />
      ) : null}

      {isModelDownloading(model) || model.lifecycleStatus === LifecycleStatus.PAUSED ? (
        <ActionPill
          label={t('models.cancel')}
          onPress={() => onCancel(model.id)}
          className={pillClassName}
        />
      ) : null}

      {model.lifecycleStatus === LifecycleStatus.DOWNLOADED ? (
        <>
          <ActionPill
            label={t('models.load')}
            tone="primary"
            onPress={() => onLoad(model.id)}
            className={pillClassName}
          />
          <ActionPill
            testID={`settings-${model.id}`}
            label={t('models.settings')}
            onPress={() => onOpenSettings(model.id)}
            className={pillClassName}
          />
          <ScreenIconButton
            onPress={() => onDelete(model.id)}
            accessibilityLabel={t('common.delete')}
            iconName="delete-outline"
            size="compact"
            tone="danger"
            className="shrink-0 border-0"
          />
        </>
      ) : null}

      {model.lifecycleStatus === LifecycleStatus.ACTIVE ? (
        <>
          <ActionPill
            label={t('models.chat')}
            tone="primary"
            onPress={onChat}
            className={pillClassName}
          />
          <ActionPill
            testID={`settings-${model.id}`}
            label={t('models.settings')}
            onPress={() => onOpenSettings(model.id)}
            className={pillClassName}
          />
          <ActionPill
            label={t('models.unload')}
            onPress={onUnload}
            className={pillClassName}
          />
          <ScreenIconButton
            onPress={() => onDelete(model.id)}
            accessibilityLabel={t('common.delete')}
            iconName="delete-outline"
            size="compact"
            tone="danger"
            className="shrink-0 border-0"
          />
        </>
      ) : null}
    </Box>
  );
}
