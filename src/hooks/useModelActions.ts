import { useCallback } from 'react';
import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import type { TFunction } from 'i18next';
import type { LoadModelOptions } from '@/services/LLMEngineService';
import { getHuggingFaceModelUrl } from '@/services/ModelCatalogService';
import { registry } from '@/services/LocalStorageRegistry';
import { offloadModel } from '@/services/StorageManagerService';
import { toAppError } from '@/services/AppError';
import type { EngineState, ModelMetadata } from '@/types/models';
import { startModelDownloadFlow } from '@/utils/modelDownloadFlow';
import { handleModelLoadMemoryPolicyError, promptModelLoadMemoryPolicyIfNeeded } from '@/utils/modelLoadMemoryPolicyPrompt';
import type { ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import type { ModelsCatalogTab } from '@/store/modelsCatalogTabs';

type UseModelActionsInput = {
  activeTab: ModelsCatalogTab;
  models: ModelMetadata[];
  engineState: EngineState;
  loadModel: (modelId: string, options?: LoadModelOptions) => Promise<void>;
  unloadModel: () => Promise<void>;
  startDownload: (model: ModelMetadata) => void;
  cancelDownload: (modelId: string) => void;
  refreshDownloadedModels: () => void;
  requestCatalogRefresh: () => void;
  showError: (scope: string, error: unknown, reportContext?: ErrorReportContext) => void;
  t: TFunction;
};

export function useModelActions({
  activeTab,
  models,
  engineState,
  loadModel,
  unloadModel,
  startDownload,
  cancelDownload,
  refreshDownloadedModels,
  requestCatalogRefresh,
  showError,
  t,
}: UseModelActionsInput) {
  const router = useRouter();

  const openTokenSettings = useCallback(() => {
    router.push('/huggingface-token');
  }, [router]);

  const openModelPage = useCallback(async (modelId: string) => {
    try {
      await Linking.openURL(getHuggingFaceModelUrl(modelId));
    } catch (error) {
      showError('ModelsList.openModelPage', error);
    }
  }, [showError]);

  const openModelDetails = useCallback((modelId: string) => {
    router.push({
      pathname: '/model-details',
      params: { modelId },
    });
  }, [router]);

  const openChat = useCallback(() => {
    router.push('/chat');
  }, [router]);

  const handleDownload = useCallback((model: ModelMetadata) => {
    startModelDownloadFlow({
      model,
      t,
      startDownload,
      openTokenSettings,
      openModelPage,
      onError: (error) => {
        showError('ModelsList.handleDownload', error);
      },
    });
  }, [openModelPage, openTokenSettings, showError, startDownload, t]);

  const performLoad = useCallback(async (modelId: string, options?: LoadModelOptions) => {
    try {
      await loadModel(modelId, options);
      refreshDownloadedModels();
    } catch (error) {
      const appError = toAppError(error);

      if (handleModelLoadMemoryPolicyError({
        t,
        appError,
        options,
        onBlocked: refreshDownloadedModels,
        onRetry: (nextOptions) => {
          void performLoad(modelId, nextOptions);
        },
      })) {
        return;
      }

      if (
        appError.code === 'model_load_failed'
        || appError.code === 'model_memory_insufficient'
        || appError.code === 'model_incompatible'
      ) {
        // ModelsList renders a persistent engine error card (with report action) for these cases.
        return;
      }

      const model = registry.getModel(modelId) ?? models.find((item) => item.id === modelId);
      const reportContext: ErrorReportContext = {
        model: model ? {
          id: model.id,
          name: model.name,
          author: model.author,
          size: model.size,
          localPath: model.localPath,
          downloadUrl: model.downloadUrl,
          memoryFitDecision: model.memoryFitDecision,
          memoryFitConfidence: model.memoryFitConfidence,
          fitsInRam: model.fitsInRam,
          lifecycleStatus: model.lifecycleStatus,
          accessState: model.accessState,
          gguf: model.gguf,
        } : { id: modelId },
        engine: {
          status: engineState.status,
          activeModelId: engineState.activeModelId,
          loadProgress: engineState.loadProgress,
        },
        options: options ? {
          allowUnsafeMemoryLoad: options.allowUnsafeMemoryLoad,
          forceReload: options.forceReload,
        } : undefined,
      };

      showError('ModelsList.performLoad', error, reportContext);
    }
  }, [
    engineState.activeModelId,
    engineState.loadProgress,
    engineState.status,
    refreshDownloadedModels,
    loadModel,
    models,
    showError,
    t,
  ]);

  const handleLoad = useCallback(async (modelId: string) => {
    const model = registry.getModel(modelId) ?? models.find((item) => item.id === modelId);
    if (promptModelLoadMemoryPolicyIfNeeded({
      t,
      model,
      onProceed: (nextOptions) => {
        void performLoad(modelId, nextOptions);
      },
    })) {
      return;
    }

    await performLoad(modelId);
  }, [models, performLoad, t]);

  const handleUnload = useCallback(async () => {
    try {
      await unloadModel();
      refreshDownloadedModels();
    } catch (error) {
      showError('ModelsList.handleUnload', error);
    }
  }, [refreshDownloadedModels, showError, unloadModel]);

  const handleDelete = useCallback((modelId: string) => {
    Alert.alert(
      t('models.deleteTitle'),
      t('models.deleteMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('models.deleteKeepSettings'),
          onPress: async () => {
            try {
              await offloadModel(modelId, { preserveSettings: true });
              if (activeTab === 'all') {
                requestCatalogRefresh();
              } else {
                refreshDownloadedModels();
              }
            } catch (error) {
              showError('ModelsList.handleDelete.keepSettings', error);
            }
          },
        },
        {
          text: t('models.deleteResetSettings'),
          style: 'destructive',
          onPress: async () => {
            try {
              await offloadModel(modelId, { preserveSettings: false });
              if (activeTab === 'all') {
                requestCatalogRefresh();
              } else {
                refreshDownloadedModels();
              }
            } catch (error) {
              showError('ModelsList.handleDelete.resetSettings', error);
            }
          },
        },
      ],
    );
  }, [activeTab, refreshDownloadedModels, requestCatalogRefresh, showError, t]);

  return {
    cancelDownload,
    openChat,
    openModelDetails,
    openModelPage,
    openTokenSettings,
    handleDelete,
    handleDownload,
    handleLoad,
    handleUnload,
  };
}
