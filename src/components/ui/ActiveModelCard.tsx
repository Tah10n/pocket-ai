import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { registry } from '@/services/LocalStorageRegistry';
import { EngineStatus } from '@/types/models';

interface ActiveModelCardProps {
  onSwapModel?: () => void;
}

export const ActiveModelCard = ({ onSwapModel }: ActiveModelCardProps) => {
  const { state } = useLLMEngine();
  const activeModel = state.activeModelId ? registry.getModel(state.activeModelId) : undefined;
  const downloadedModels = registry.getModels().filter((model) => Boolean(model.localPath));
  const isReady = state.status === EngineStatus.READY;
  const hasActiveModel = Boolean(activeModel);
  const hasDownloadedModels = downloadedModels.length > 0;
  const statusDotClassName = isReady ? 'w-2 h-2 rounded-full bg-success-500' : 'w-2 h-2 rounded-full bg-warning-400';
  const statusLabel = isReady ? 'Model Ready' : state.status === EngineStatus.INITIALIZING ? 'Warming Up' : 'No Model Loaded';
  const modelName = activeModel?.name ?? 'Choose a local model';
  const modelTag = activeModel ? activeModel.author : 'Offline';
  const memoryLabel = activeModel
    ? `${(activeModel.size / (1024 * 1024 * 1024)).toFixed(1)} GB file`
    : hasDownloadedModels
      ? `${downloadedModels.length} downloaded ${downloadedModels.length === 1 ? 'model' : 'models'}`
      : 'Download and load a GGUF model';
  const speedLabel = isReady
    ? 'Engine loaded'
    : hasActiveModel
      ? 'Ready to load'
      : hasDownloadedModels
        ? 'Choose from downloaded models'
        : 'Chat is unavailable';
  const ctaLabel = hasActiveModel ? 'Swap Model' : hasDownloadedModels ? 'Choose Model' : 'Browse Models';

  return (
    <Box className="mx-4 mt-4 rounded-xl shadow-xl bg-background-50 dark:bg-primary-500/10 border border-outline-200 dark:border-primary-500/20 overflow-hidden">
      <Box className="border-b border-outline-200 px-4 py-3 dark:border-outline-800">
        <Box className="flex-row items-center gap-2">
          <Box className={statusDotClassName} />
          <Text className="text-xs font-medium text-typography-500 dark:text-typography-400 uppercase tracking-widest">
            {statusLabel}
          </Text>
        </Box>
      </Box>

      <Box className="px-4 py-4 gap-1">
        <Text className="text-typography-500 dark:text-typography-400 text-sm font-medium">Active Model</Text>
        <Box className="flex-row items-baseline gap-2">
            <Text className="text-typography-900 dark:text-typography-100 text-xl font-bold tracking-tight">{modelName}</Text>
            <Box className="px-2 py-0.5 bg-primary-500/20 rounded-full">
                <Text className="text-xs font-normal text-primary-500">{modelTag}</Text>
            </Box>
        </Box>

        <Box className="flex-row items-end justify-between mt-2">
          <Box className="gap-1">
            <Box className="flex-row items-center gap-1">
              <MaterialSymbols name="memory" size={16} className="text-typography-500 dark:text-typography-400" />
              <Text className="text-typography-500 dark:text-typography-400 text-xs">{memoryLabel}</Text>
            </Box>
            <Box className="flex-row items-center gap-1">
              <MaterialSymbols name="speed" size={16} className="text-typography-500 dark:text-typography-400" />
              <Text className="text-typography-500 dark:text-typography-400 text-xs">{speedLabel}</Text>
            </Box>
          </Box>
          
          <Pressable 
            onPress={onSwapModel} 
            className="px-4 h-9 bg-primary-500 items-center justify-center rounded-lg active:opacity-80"
          >
            <Text className="text-typography-0 text-sm font-semibold">{ctaLabel}</Text>
          </Pressable>
        </Box>
      </Box>
    </Box>
  );
};
