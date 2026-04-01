import React from 'react';
import { useTranslation } from 'react-i18next';
import { ModelAccessState, LifecycleStatus, type ModelMetadata } from '../../types/models';
import { Box } from './box';
import { ScreenActionPill, ScreenIconButton } from './ScreenShell';
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
  return (
    <ScreenActionPill
      testID={testID}
      onPress={onPress}
      tone={tone}
      size="compact"
      className={className ?? 'min-w-0 basis-0 flex-1'}
    >
      <Text
        numberOfLines={1}
        className={`text-center text-sm font-semibold ${tone === 'primary'
          ? 'text-typography-0'
          : 'text-primary-600 dark:text-primary-300'}`}
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
  model,
  className,
}: {
  model: Pick<ModelMetadata, 'downloadProgress' | 'lifecycleStatus'>;
  className?: string;
}) {
  const { t } = useTranslation();

  if (!isModelDownloading(model)) {
    return null;
  }

  const rawProgressPercent = Number.isFinite(model.downloadProgress)
    ? Math.round(model.downloadProgress * 100)
    : 0;
  const progressPercent = Math.max(0, Math.min(100, rawProgressPercent));

  return (
    <Box className={className}>
      <Box className="mb-1 flex-row justify-between">
        <Text className="text-xs text-typography-500">
          {model.lifecycleStatus === LifecycleStatus.VERIFYING
            ? t('models.verifying')
            : t('models.downloading')}
        </Text>
        <Text className="text-xs font-bold text-primary-500">{progressPercent}%</Text>
      </Box>
      <Box className="h-1.5 w-full overflow-hidden rounded-full bg-background-200 dark:bg-background-800">
        <Box className="h-full bg-primary-500" style={{ width: `${progressPercent}%` }} />
      </Box>
    </Box>
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

      {isModelDownloading(model) ? (
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
