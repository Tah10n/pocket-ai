import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { Text } from './text';
import { Button, ButtonText } from './button';
import { Pressable } from './pressable';
import { ModelAccessState, ModelMetadata, LifecycleStatus } from '../../types/models';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

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
  const isDownloading = model.lifecycleStatus === LifecycleStatus.DOWNLOADING || 
                        model.lifecycleStatus === LifecycleStatus.QUEUED || 
                        model.lifecycleStatus === LifecycleStatus.VERIFYING;

  const progressPercent = Math.round(model.downloadProgress * 100);
  const sizeLabel = model.size === null
    ? t('models.sizeUnknown')
    : `${(model.size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  const accessBadge = model.accessState === ModelAccessState.AUTH_REQUIRED
    ? {
        text: t('models.requiresToken'),
        className: 'bg-primary-100 dark:bg-primary-900/30',
        textClassName: 'text-primary-600 dark:text-primary-300',
      }
    : model.accessState === ModelAccessState.ACCESS_DENIED
      ? {
          text: t('models.accessDenied'),
          className: 'bg-error-100 dark:bg-error-900/30',
          textClassName: 'text-error-600 dark:text-error-300',
        }
      : null;
  const statusLabel = {
    [LifecycleStatus.AVAILABLE]: t('models.statusAvailable'),
    [LifecycleStatus.DOWNLOADING]: t('models.statusDownloading'),
    [LifecycleStatus.QUEUED]: t('models.statusQueued'),
    [LifecycleStatus.VERIFYING]: t('models.statusVerifying'),
    [LifecycleStatus.DOWNLOADED]: t('models.statusDownloaded'),
    [LifecycleStatus.ACTIVE]: t('models.statusActive'),
  }[model.lifecycleStatus];

  return (
    <Box className="bg-background-50 dark:bg-background-900 rounded-xl p-4 mb-4 border border-outline-200 dark:border-outline-800">
      <Box className="flex-row justify-between items-start mb-2">
        <Box className="flex-1">
          <Text className="text-base font-bold text-typography-900 dark:text-typography-100">{model.name}</Text>
          <Text className="text-xs text-typography-500 dark:text-typography-400">{model.author}</Text>
        </Box>
        <Box className="items-end gap-1.5">
          <Pressable
            testID={`model-details-${model.id}`}
            onPress={() => onOpenDetails(model.id)}
            className="h-8 w-8 items-center justify-center rounded-full bg-background-100 active:opacity-80 dark:bg-background-800"
            accessibilityRole="button"
            accessibilityLabel={t('models.details')}
          >
            <MaterialIcons name="open-in-new" size={16} className="text-typography-700 dark:text-typography-200" />
          </Pressable>
          {accessBadge ? (
            <Box className={`${accessBadge.className} px-2 py-0.5 rounded`}>
              <Text className={`text-[10px] font-bold ${accessBadge.textClassName}`}>{accessBadge.text}</Text>
            </Box>
          ) : null}
          {model.fitsInRam === false && (
            <Box className="bg-warning-100 dark:bg-warning-900/30 px-2 py-0.5 rounded flex-row items-center">
              <MaterialIcons name="warning" size={12} className="text-warning-600 mr-1" />
              <Text className="text-[10px] font-bold text-warning-600">{t('models.ramWarning')}</Text>
            </Box>
          )}
        </Box>
      </Box>

      <Box className="flex-row gap-4 mb-4">
        <Box>
          <Text className="text-[10px] text-typography-400 uppercase font-bold">{t('models.sizeLabel')}</Text>
          <Text className="text-sm text-typography-700 dark:text-typography-300">
            {sizeLabel}
          </Text>
        </Box>
        <Box>
          <Text className="text-[10px] text-typography-400 uppercase font-bold">{t('models.statusLabel')}</Text>
          <Text className="text-sm text-typography-700 dark:text-typography-300 capitalize">
            {statusLabel}
          </Text>
        </Box>
      </Box>

      {isDownloading && (
        <Box className="mb-4">
          <Box className="flex-row justify-between mb-1">
            <Text className="text-xs text-typography-500">
              {model.lifecycleStatus === LifecycleStatus.VERIFYING ? t('models.verifying') : t('models.downloading')}
            </Text>
            <Text className="text-xs font-bold text-primary-500">{progressPercent}%</Text>
          </Box>
          <Box className="h-1.5 w-full bg-background-200 dark:bg-background-800 rounded-full overflow-hidden">
            <Box 
              className="h-full bg-primary-500" 
              style={{ width: `${progressPercent}%` }} 
            />
          </Box>
        </Box>
      )}

      <Box className="flex-row flex-wrap gap-2">
        {model.lifecycleStatus === LifecycleStatus.AVAILABLE && (
          model.accessState === ModelAccessState.AUTH_REQUIRED ? (
            <Button size="sm" className="flex-1" onPress={onConfigureToken}>
              <ButtonText>{t('models.setToken')}</ButtonText>
            </Button>
          ) : model.accessState === ModelAccessState.ACCESS_DENIED ? (
            <Button size="sm" action="secondary" className="flex-1" onPress={() => onOpenModelPage(model.id)}>
              <ButtonText>{t('models.openOnHuggingFace')}</ButtonText>
            </Button>
          ) : (
            <Button size="sm" className="flex-1" onPress={() => onDownload(model)}>
              <ButtonText>{t('models.download')}</ButtonText>
            </Button>
          )
        )}

        {isDownloading && (
          <Button size="sm" action="secondary" className="flex-1" onPress={() => onCancel(model.id)}>
            <ButtonText>{t('models.cancel')}</ButtonText>
          </Button>
        )}

        {model.lifecycleStatus === LifecycleStatus.DOWNLOADED && (
          <>
            <Button size="sm" className="flex-1" onPress={() => onLoad(model.id)}>
              <ButtonText>{t('models.load')}</ButtonText>
            </Button>
            <Button size="sm" action="secondary" className="flex-1" onPress={() => onOpenSettings(model.id)}>
              <ButtonText>{t('models.settings')}</ButtonText>
            </Button>
            <Button size="sm" action="negative" onPress={() => onDelete(model.id)}>
              <MaterialIcons name="delete" size={16} className="text-white" />
            </Button>
          </>
        )}

        {model.lifecycleStatus === LifecycleStatus.ACTIVE && (
          <>
            <Button size="sm" action="positive" className="flex-1" onPress={onChat}>
              <ButtonText>{t('models.chat')}</ButtonText>
            </Button>
            <Button size="sm" action="secondary" className="flex-1" onPress={() => onOpenSettings(model.id)}>
              <ButtonText>{t('models.settings')}</ButtonText>
            </Button>
            <Button size="sm" action="secondary" onPress={() => onUnload()}>
              <ButtonText>{t('models.unload')}</ButtonText>
            </Button>
            <Button size="sm" action="negative" onPress={() => onDelete(model.id)}>
              <MaterialIcons name="delete" size={16} className="text-white" />
            </Button>
          </>
        )}
      </Box>
    </Box>
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

