import React, { memo } from 'react';
import { Box } from './box';
import { Text } from './text';
import { Button, ButtonText } from './button';
import { ModelMetadata, LifecycleStatus } from '../../types/models';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

interface ModelCardProps {
  model: ModelMetadata;
  onDownload: (model: ModelMetadata) => void;
  onLoad: (id: string) => void;
  onUnload: () => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
  onChat: () => void;
  isActive: boolean;
}

export const ModelCard = memo(({
  model,
  onDownload,
  onLoad,
  onUnload,
  onDelete,
  onCancel,
  onChat,
  isActive,
}: ModelCardProps) => {
  const isDownloading = model.lifecycleStatus === LifecycleStatus.DOWNLOADING || 
                        model.lifecycleStatus === LifecycleStatus.QUEUED || 
                        model.lifecycleStatus === LifecycleStatus.VERIFYING;

  const progressPercent = Math.round(model.downloadProgress * 100);

  return (
    <Box className="bg-background-50 dark:bg-background-900 rounded-xl p-4 mb-4 border border-outline-200 dark:border-outline-800">
      <Box className="flex-row justify-between items-start mb-2">
        <Box className="flex-1">
          <Text className="text-base font-bold text-typography-900 dark:text-typography-100">{model.name}</Text>
          <Text className="text-xs text-typography-500 dark:text-typography-400">{model.author}</Text>
        </Box>
        {model.fitsInRam === false && (
          <Box className="bg-warning-100 dark:bg-warning-900/30 px-2 py-0.5 rounded flex-row items-center">
            <MaterialIcons name="warning" size={12} className="text-warning-600 mr-1" />
            <Text className="text-[10px] font-bold text-warning-600">RAM Warning</Text>
          </Box>
        )}
      </Box>

      <Box className="flex-row gap-4 mb-4">
        <Box>
          <Text className="text-[10px] text-typography-400 uppercase font-bold">Size</Text>
          <Text className="text-sm text-typography-700 dark:text-typography-300">
            {(model.size / (1024 * 1024 * 1024)).toFixed(2)} GB
          </Text>
        </Box>
        <Box>
          <Text className="text-[10px] text-typography-400 uppercase font-bold">Status</Text>
          <Text className="text-sm text-typography-700 dark:text-typography-300 capitalize">
            {model.lifecycleStatus}
          </Text>
        </Box>
      </Box>

      {isDownloading && (
        <Box className="mb-4">
          <Box className="flex-row justify-between mb-1">
            <Text className="text-xs text-typography-500">
              {model.lifecycleStatus === LifecycleStatus.VERIFYING ? 'Verifying...' : 'Downloading...'}
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

      <Box className="flex-row gap-2">
        {model.lifecycleStatus === LifecycleStatus.AVAILABLE && (
          <Button size="sm" className="flex-1" onPress={() => onDownload(model)}>
            <ButtonText>Download</ButtonText>
          </Button>
        )}

        {isDownloading && (
          <Button size="sm" action="secondary" className="flex-1" onPress={() => onCancel(model.id)}>
            <ButtonText>Cancel</ButtonText>
          </Button>
        )}

        {model.lifecycleStatus === LifecycleStatus.DOWNLOADED && (
          <>
            <Button size="sm" className="flex-1" onPress={() => onLoad(model.id)}>
              <ButtonText>Load</ButtonText>
            </Button>
            <Button size="sm" action="negative" onPress={() => onDelete(model.id)}>
              <MaterialIcons name="delete" size={16} className="text-white" />
            </Button>
          </>
        )}

        {model.lifecycleStatus === LifecycleStatus.ACTIVE && (
          <>
            <Button size="sm" action="positive" className="flex-1" onPress={onChat}>
              <ButtonText>Chat</ButtonText>
            </Button>
            <Button size="sm" action="secondary" onPress={() => onUnload()}>
              <ButtonText>Unload</ButtonText>
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
}, (prevProps, nextProps) => {
  // Custom comparison to ensure fast check since model is an object
  return prevProps.isActive === nextProps.isActive &&
         prevProps.model.id === nextProps.model.id &&
         prevProps.model.lifecycleStatus === nextProps.model.lifecycleStatus &&
         prevProps.model.downloadProgress === nextProps.model.downloadProgress &&
         prevProps.model.fitsInRam === nextProps.model.fitsInRam;
});

