import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { ScreenActionPill, ScreenBadge, ScreenCard, ScreenIconButton } from './ScreenShell';
import { Text, composeTextRole } from './text';
import { ModelAccessState, ModelMetadata, LifecycleStatus } from '../../types/models';

interface ModelCardProps {
  model: ModelMetadata;
  onOpenDetails: (modelId: string) => void;
  onDownload: (model: ModelMetadata) => void;
  onConfigureToken: () => void;
  onOpenModelPage: (modelId: string) => void;
  onLoad: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onUnload: () => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
  onChat: () => void;
  isActive: boolean;
}

function ModelActionPill({
  label,
  tone = 'soft',
  onPress,
  testID,
}: {
  label: string;
  tone?: 'primary' | 'soft';
  onPress: () => void;
  testID?: string;
}) {
  return (
    <ScreenActionPill
      testID={testID}
      onPress={onPress}
      tone={tone}
      size="compact"
      className="min-w-0 basis-0 flex-1"
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

function ModelMetaPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Box className="flex-row items-center gap-1.5 rounded-full border border-outline-200 bg-background-0 px-2.5 py-1 dark:border-outline-700 dark:bg-background-950/70">
      <Text className="text-2xs font-medium uppercase tracking-wide text-typography-500 dark:text-typography-400">
        {label}
      </Text>
      <Text className="text-xs font-semibold text-typography-800 dark:text-typography-100">
        {value}
      </Text>
    </Box>
  );
}

const ModelCardComponent = ({
  model,
  onOpenDetails,
  onDownload,
  onConfigureToken,
  onOpenModelPage,
  onLoad,
  onOpenSettings,
  onUnload,
  onDelete,
  onCancel,
  onChat,
  isActive,
}: ModelCardProps) => {
  const { t } = useTranslation();
  const isDownloading = model.lifecycleStatus === LifecycleStatus.DOWNLOADING
    || model.lifecycleStatus === LifecycleStatus.QUEUED
    || model.lifecycleStatus === LifecycleStatus.VERIFYING;

  const progressPercent = Math.round(model.downloadProgress * 100);
  const sizeLabel = model.size === null
    ? t('models.sizeUnknown')
    : `${(model.size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  const accessBadge = model.accessState === ModelAccessState.AUTH_REQUIRED
    ? {
        text: t('models.requiresToken'),
        tone: 'accent' as const,
      }
    : model.accessState === ModelAccessState.ACCESS_DENIED
      ? {
          text: t('models.accessDenied'),
          tone: 'error' as const,
        }
      : null;
  return (
    <ScreenCard
      className={isActive ? 'bg-primary-500/5 dark:bg-primary-500/10' : ''}
      padding="compact"
      tone={isActive ? 'accent' : 'default'}
    >
      <Box className="flex-row items-start justify-between gap-2.5">
        <Box className="min-w-0 flex-1">
          <Box className="flex-row flex-wrap items-start gap-2">
            <Text numberOfLines={2} className={composeTextRole('sectionTitle', 'flex-1 text-base tracking-tight')}>
              {model.name}
            </Text>
            {isActive ? (
              <ScreenBadge tone="success" size="micro">
                {t('common.active')}
              </ScreenBadge>
            ) : null}
          </Box>
          <Text numberOfLines={1} className={composeTextRole('caption', 'mt-0.5')}>
            {model.author}
          </Text>
        </Box>

        <ScreenIconButton
          testID={`model-details-${model.id}`}
          onPress={() => onOpenDetails(model.id)}
          accessibilityLabel={t('models.details')}
          iconName="open-in-new"
          size="compact"
        />
      </Box>

      <Box className="mt-2 flex-row flex-wrap gap-1.5">
        {accessBadge ? (
          <ScreenBadge tone={accessBadge.tone} size="micro">
            {accessBadge.text}
          </ScreenBadge>
        ) : null}
        {model.fitsInRam === false ? (
          <ScreenBadge tone="warning" size="micro" iconName="warning">
            {t('models.ramWarning')}
          </ScreenBadge>
        ) : null}
        <ModelMetaPill label={t('models.sizeLabel')} value={sizeLabel} />
      </Box>

      {isDownloading ? (
        <Box className="mt-2.5">
          <Box className="mb-1 flex-row justify-between">
            <Text className="text-xs text-typography-500">
              {model.lifecycleStatus === LifecycleStatus.VERIFYING ? t('models.verifying') : t('models.downloading')}
            </Text>
            <Text className="text-xs font-bold text-primary-500">{progressPercent}%</Text>
          </Box>
          <Box className="h-1.5 w-full overflow-hidden rounded-full bg-background-200 dark:bg-background-800">
            <Box className="h-full bg-primary-500" style={{ width: `${progressPercent}%` }} />
          </Box>
        </Box>
      ) : null}

      <Box className="mt-3 flex-row items-center gap-2">
        {model.lifecycleStatus === LifecycleStatus.AVAILABLE ? (
          model.accessState === ModelAccessState.AUTH_REQUIRED ? (
            <ModelActionPill label={t('models.setToken')} onPress={onConfigureToken} />
          ) : model.accessState === ModelAccessState.ACCESS_DENIED ? (
            <ModelActionPill label={t('models.openOnHuggingFace')} onPress={() => onOpenModelPage(model.id)} />
          ) : (
            <ModelActionPill label={t('models.download')} tone="primary" onPress={() => onDownload(model)} />
          )
        ) : null}

        {isDownloading ? (
          <ModelActionPill label={t('models.cancel')} onPress={() => onCancel(model.id)} />
        ) : null}

        {model.lifecycleStatus === LifecycleStatus.DOWNLOADED ? (
          <>
            <ModelActionPill label={t('models.load')} tone="primary" onPress={() => onLoad(model.id)} />
            <ModelActionPill
              testID={`settings-${model.id}`}
              label={t('models.settings')}
              onPress={() => onOpenSettings(model.id)}
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
            <ModelActionPill label={t('models.chat')} tone="primary" onPress={onChat} />
            <ModelActionPill
              testID={`settings-${model.id}`}
              label={t('models.settings')}
              onPress={() => onOpenSettings(model.id)}
            />
            <ModelActionPill label={t('models.unload')} onPress={onUnload} />
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
    </ScreenCard>
  );
};

ModelCardComponent.displayName = 'ModelCard';

export const ModelCard = memo(ModelCardComponent, (prevProps, nextProps) => {
  // Custom comparison to ensure fast check since model is an object
  return prevProps.isActive === nextProps.isActive &&
         prevProps.model.id === nextProps.model.id &&
         prevProps.model.name === nextProps.model.name &&
         prevProps.model.author === nextProps.model.author &&
         prevProps.model.lifecycleStatus === nextProps.model.lifecycleStatus &&
         prevProps.model.downloadProgress === nextProps.model.downloadProgress &&
         prevProps.model.fitsInRam === nextProps.model.fitsInRam &&
         prevProps.model.size === nextProps.model.size &&
         prevProps.model.accessState === nextProps.model.accessState;
});

