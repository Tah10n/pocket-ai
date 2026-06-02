import React from 'react';
import { useTranslation } from 'react-i18next';
import { ModelAccessState, LifecycleStatus, type ModelMetadata } from '../../types/models';
import { useDownloadStore } from '../../store/downloadStore';
import { selectModelProjectorLifecycleState, type ModelProjectorLifecycleStatus } from '../../store/modelsStore';
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

function getProjectorDownloadAction(model: ModelMetadata): { labelKey: string; testID: string } | null {
  if (
    model.lifecycleStatus !== LifecycleStatus.DOWNLOADED
    && model.lifecycleStatus !== LifecycleStatus.ACTIVE
  ) {
    return null;
  }

  const projectorState = selectModelProjectorLifecycleState(model);
  if (!projectorState.selectedProjector) {
    return null;
  }

  if (projectorState.status === 'available') {
    return {
      labelKey: 'models.vision.downloadProjector',
      testID: `model-projector-download-${model.id}`,
    };
  }

  if (projectorState.status === 'failed') {
    return {
      labelKey: 'models.vision.retryProjectorDownload',
      testID: `model-projector-retry-${model.id}`,
    };
  }

  if (projectorState.status === 'paused') {
    return {
      labelKey: 'models.vision.resumeProjectorDownload',
      testID: `model-projector-resume-${model.id}`,
    };
  }

  return null;
}

export function ModelDownloadProgress({
  density = 'comfortable',
  model,
  className,
}: {
  density?: 'compact' | 'comfortable';
  model: ModelMetadata;
  className?: string;
}) {
  if (
    !isModelDownloading(model)
    && model.lifecycleStatus !== LifecycleStatus.PAUSED
    && model.lifecycleStatus !== LifecycleStatus.FAILED
  ) {
    return null;
  }

  return (
    <ModelDownloadProgressInner
      model={model}
      density={density}
      className={className}
    />
  );
}

function ModelDownloadProgressInner({
  model,
  density,
  className,
}: {
  model: ModelMetadata;
  density: 'compact' | 'comfortable';
  className?: string;
}) {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const queuedModel = useDownloadStore((state) => state.queue.find((queuedItem) => queuedItem.id === model.id));
  const displayModel = queuedModel ?? model;
  const lifecycleStatus = displayModel.lifecycleStatus;
  const projectorState = selectModelProjectorLifecycleState(displayModel);
  const projectorDownloadStatus = projectorState.status === 'queued'
    || projectorState.status === 'downloading'
    || projectorState.status === 'paused'
    ? projectorState.status
    : undefined;
  const hasCompletedBaseProgress = typeof displayModel.downloadProgress === 'number'
    && displayModel.downloadProgress >= 1;
  const shouldShowProjectorProgress = Boolean(projectorDownloadStatus && hasCompletedBaseProgress);
  const projectorDownloadProgress = projectorState.isDownloading
    ? projectorState.selectedProjector?.downloadProgress
    : undefined;
  const downloadProgress = shouldShowProjectorProgress
    ? (typeof projectorDownloadProgress === 'number' ? projectorDownloadProgress : 0)
    : displayModel.downloadProgress;

  const rawProgressPercent = Number.isFinite(downloadProgress)
    ? Math.round(downloadProgress * 100)
    : 0;
  const progressPercent = Math.max(0, Math.min(100, rawProgressPercent));
  const progressPresentation = getDownloadProgressPresentation(
    lifecycleStatus,
    t,
    shouldShowProjectorProgress ? projectorDownloadStatus : undefined,
  );
  const progressTone = progressPresentation.progressTone === 'primary' ? 'accent' : progressPresentation.progressTone;
  const progressToneClassNames = appearance.classNames.toneClassNameByTone[progressTone];
  const activeProgressFillClassName = appearance.classNames.toneClassNameByTone.primary.progressFillClassName;
  const isCompact = density === 'compact';

  return (
    <ScreenSurface
      testID={`model-download-progress-${model.id}`}
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
        testID={`model-download-progress-track-${model.id}`}
        fillTestID={`model-download-progress-fill-${model.id}`}
        valuePercent={progressPercent}
        size={isCompact ? 'md' : 'lg'}
        tone={progressPresentation.progressTone}
        variant="framed"
        fillClassName={activeProgressFillClassName}
      />
    </ScreenSurface>
  );
}

function getDownloadProgressPresentation(
  lifecycleStatus: LifecycleStatus,
  t: (key: string) => string,
  projectorDownloadStatus?: Extract<ModelProjectorLifecycleStatus, 'queued' | 'downloading' | 'paused'>,
): {
  iconName: MaterialSymbolName;
  label: string;
  progressTone: 'neutral' | 'primary' | 'success' | 'warning' | 'error';
} {
  if (projectorDownloadStatus) {
    const labelKey = projectorDownloadStatus === 'queued'
      ? 'models.vision.projectorQueued'
      : projectorDownloadStatus === 'paused'
        ? 'models.vision.projectorPaused'
        : 'models.vision.projectorDownloading';

    return {
      iconName: projectorDownloadStatus === 'paused' ? 'pause-circle-outline' : 'download',
      label: t(labelKey),
      progressTone: projectorDownloadStatus === 'paused' ? 'warning' : 'primary',
    };
  }

  if (lifecycleStatus === LifecycleStatus.FAILED) {
    return {
      iconName: 'error-outline',
      label: t('models.downloadFailed'),
      progressTone: 'error',
    };
  }

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

function getProjectorStatusPresentation(
  status: ModelProjectorLifecycleStatus,
): {
  titleKey: string;
  descriptionKey: string;
  iconName: MaterialSymbolName;
  tone: 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info';
} {
  if (status === 'downloaded' || status === 'active') {
    return {
      titleKey: 'models.vision.projectorStatusReadyTitle',
      descriptionKey: 'models.vision.projectorStatusReadyDescription',
      iconName: 'visibility',
      tone: 'success',
    };
  }

  if (status === 'ambiguous') {
    return {
      titleKey: 'models.vision.projectorStatusAmbiguousTitle',
      descriptionKey: 'models.vision.projectorStatusAmbiguousDescription',
      iconName: 'extension',
      tone: 'warning',
    };
  }

  if (status === 'queued' || status === 'downloading' || status === 'paused') {
    return {
      titleKey: 'models.vision.projectorStatusDownloadingTitle',
      descriptionKey: 'models.vision.projectorStatusDownloadingDescription',
      iconName: status === 'paused' ? 'pause-circle-outline' : 'download',
      tone: 'info',
    };
  }

  if (status === 'failed') {
    return {
      titleKey: 'models.vision.projectorStatusFailedTitle',
      descriptionKey: 'models.vision.projectorStatusFailedDescription',
      iconName: 'error-outline',
      tone: 'error',
    };
  }

  return {
    titleKey: 'models.vision.projectorStatusMissingTitle',
    descriptionKey: 'models.vision.projectorStatusMissingDescription',
    iconName: 'extension',
    tone: 'warning',
  };
}

export function ModelProjectorStatus({
  model,
  onChooseProjector,
  className,
}: {
  model: ModelMetadata;
  onChooseProjector?: (model: ModelMetadata) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const projectorState = selectModelProjectorLifecycleState(model);

  if (projectorState.status === 'text_only') {
    return null;
  }

  const presentation = getProjectorStatusPresentation(projectorState.status);
  const toneClassNames = appearance.classNames.toneClassNameByTone[presentation.tone];

  return (
    <ScreenSurface
      testID={`model-projector-status-${model.id}`}
      tone={presentation.tone}
      withControlTint
      className={joinClassNames('rounded-2xl border px-3 py-2.5', toneClassNames.surfaceClassName, className)}
    >
      <Box className="flex-row items-start gap-3">
        <ScreenIconTile
          iconName={presentation.iconName}
          tone={presentation.tone}
          iconSize="sm"
          size="sm"
          className="h-8 w-8 rounded-full"
        >
          <MaterialSymbols name={presentation.iconName} size="sm" className={toneClassNames.iconClassName} />
        </ScreenIconTile>
        <Box className="min-w-0 flex-1">
          <Text className={joinClassNames('text-sm font-semibold', toneClassNames.textClassName)}>
            {t(presentation.titleKey)}
          </Text>
          <Text className="mt-1 text-xs leading-5 text-typography-600 dark:text-typography-300">
            {t(presentation.descriptionKey)}
          </Text>
        </Box>
      </Box>
      {projectorState.shouldPromptForChoice && onChooseProjector ? (
        <Box className="mt-3">
          <ActionPill
            label={t('models.vision.chooseProjectorAction')}
            tone="primary"
            onPress={() => onChooseProjector(model)}
            className="self-start"
            testID={`model-projector-choice-${model.id}`}
          />
        </Box>
      ) : null}
    </ScreenSurface>
  );
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
  const projectorDownloadAction = getProjectorDownloadAction(model);

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

      {model.lifecycleStatus === LifecycleStatus.FAILED ? (
        <ActionPill
          label={t('models.retryDownload')}
          tone="primary"
          onPress={() => onDownload(model)}
          className={pillClassName}
        />
      ) : null}

      {model.lifecycleStatus === LifecycleStatus.PAUSED ? (
        <ActionPill
          label={t('models.resume')}
          tone="primary"
          onPress={() => onDownload(model)}
          className={pillClassName}
        />
      ) : null}

      {isModelDownloading(model)
      || model.lifecycleStatus === LifecycleStatus.PAUSED
      || model.lifecycleStatus === LifecycleStatus.FAILED ? (
        <ActionPill
          label={t('models.cancel')}
          onPress={() => onCancel(model.id)}
          className={pillClassName}
        />
      ) : null}

      {projectorDownloadAction ? (
        <ActionPill
          testID={projectorDownloadAction.testID}
          label={t(projectorDownloadAction.labelKey)}
          tone="primary"
          onPress={() => onDownload(model)}
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
