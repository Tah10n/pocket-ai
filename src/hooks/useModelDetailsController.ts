import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
import { useModelDownload } from '@/hooks/useModelDownload';
import { hardwareListenerService } from '@/services/HardwareListenerService';
import { registry } from '@/services/LocalStorageRegistry';
import {
  getHuggingFaceModelUrl,
  getModelCatalogErrorMessage,
  modelCatalogService,
} from '@/services/ModelCatalogService';
import { offloadModel } from '@/services/StorageManagerService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '@/types/models';
import { getReportedErrorMessage } from '../services/AppError';
import {
  buildModelDetailsHeroMetrics,
  buildModelDetailsMetadataMetrics,
  createModelDetailsPlaceholder,
  getModelDetailsAccessBadge,
} from '../utils/modelDetailsPresentation';
import { mergeModelWithRuntimeState } from '../utils/modelRuntimeState';

export function useModelDetailsController(modelId: string) {
  const router = useRouter();
  const { t } = useTranslation();
  const missingModelMessage = t('models.detailMissingModel');
  const [model, setModel] = useState<ModelMetadata | null>(
    () => (modelId
      ? modelCatalogService.getCachedModel(modelId) ?? createModelDetailsPlaceholder(modelId)
      : null),
  );
  const [loading, setLoading] = useState(Boolean(modelId));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const { startDownload, cancelDownload, queue } = useModelDownload();
  const { loadModel, unloadModel, state: engineState } = useLLMEngine();

  useEffect(() => {
    let cancelled = false;

    if (!modelId) {
      setLoading(false);
      setErrorMessage(missingModelMessage);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setErrorMessage(null);

    void modelCatalogService.getModelDetails(modelId)
      .then((resolvedModel) => {
        if (cancelled) {
          return;
        }

        setModel(resolvedModel);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setErrorMessage(getModelCatalogErrorMessage(error));
        setModel(modelCatalogService.getCachedModel(modelId));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [missingModelMessage, modelId]);

  const displayModel = useMemo(() => {
    if (!model) {
      return null;
    }

    void runtimeRevision;

    return mergeModelWithRuntimeState(model, {
      activeModelId: engineState.activeModelId,
      localModel: registry.getModel(model.id),
      queuedItem: queue.find((item) => item.id === model.id),
    });
  }, [engineState.activeModelId, model, queue, runtimeRevision]);

  const getConfigurableModelById = useCallback((targetModelId: string | null) => {
    if (!targetModelId) {
      return undefined;
    }

    void runtimeRevision;

    return targetModelId === displayModel?.id
      ? displayModel
      : registry.getModel(targetModelId);
  }, [displayModel, runtimeRevision]);

  const accessBadge = useMemo(
    () => getModelDetailsAccessBadge(displayModel?.accessState, t),
    [displayModel?.accessState, t],
  );

  const heroMetrics = useMemo(
    () => (displayModel ? buildModelDetailsHeroMetrics(displayModel, t) : []),
    [displayModel, t],
  );

  const metadataMetrics = useMemo(
    () => (displayModel ? buildModelDetailsMetadataMetrics(displayModel, t) : []),
    [displayModel, t],
  );

  const showModelActionError = useCallback((scope: string, error: unknown) => {
    Alert.alert(t('models.actionFailedTitle'), getReportedErrorMessage(scope, error, t));
  }, [t]);

  const {
    openModelParameters,
    closeModelParameters,
    sheetProps: modelParametersSheetProps,
  } = useModelParametersSheetController({
    getModelById: getConfigurableModelById,
    showError: showModelActionError,
    applyReloadErrorScope: 'ModelDetailsScreen.handleApplyLoadParams',
    onAfterActiveModelReload: () => {
      setRuntimeRevision((current) => current + 1);
    },
  });

  const handleOpenModelPage = useCallback(async (targetModelId?: string) => {
    const resolvedModelId = targetModelId ?? modelId;
    if (!resolvedModelId) {
      return;
    }

    try {
      await Linking.openURL(getHuggingFaceModelUrl(resolvedModelId));
    } catch (error) {
      showModelActionError('ModelDetailsScreen.handleOpenModelPage', error);
    }
  }, [modelId, showModelActionError]);

  const handleOpenTokenSettings = useCallback(() => {
    router.push('/huggingface-token' as any);
  }, [router]);

  const handleChat = useCallback(() => {
    router.push('/chat' as any);
  }, [router]);

  const handleDownload = useCallback((targetModel: ModelMetadata) => {
    const startPreparedDownload = async () => {
      try {
        if (targetModel.accessState === ModelAccessState.AUTH_REQUIRED) {
          handleOpenTokenSettings();
          return;
        }

        if (targetModel.accessState === ModelAccessState.ACCESS_DENIED) {
          await handleOpenModelPage(targetModel.id);
          return;
        }

        const resolvedModel = targetModel.size === null || targetModel.requiresTreeProbe === true
          ? await modelCatalogService.refreshModelMetadata(targetModel)
          : targetModel;

        setModel((current) => (current ? { ...current, ...resolvedModel } : resolvedModel));

        if (resolvedModel.accessState === ModelAccessState.AUTH_REQUIRED) {
          handleOpenTokenSettings();
          return;
        }

        if (resolvedModel.accessState === ModelAccessState.ACCESS_DENIED) {
          await handleOpenModelPage(resolvedModel.id);
          return;
        }

        if (resolvedModel.size === null) {
          Alert.alert(
            t('models.unknownSizeWarningTitle'),
            t('models.unknownSizeWarningMessage'),
            [
              { text: t('common.cancel'), style: 'cancel' },
              {
                text: t('models.downloadWithLimitedVerification'),
                onPress: () => {
                  startDownload({
                    ...resolvedModel,
                    allowUnknownSizeDownload: true,
                  });
                },
              },
            ],
          );
          return;
        }

        startDownload(resolvedModel);
      } catch (error) {
        showModelActionError('ModelDetailsScreen.handleDownload', error);
      }
    };

    const status = hardwareListenerService.getCurrentStatus();
    if (status.networkType === 'cellular') {
      Alert.alert(
        t('models.cellularWarningTitle'),
        t('models.cellularWarningMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('models.downloadAnyway'), onPress: () => { void startPreparedDownload(); } },
        ],
      );
      return;
    }

    void startPreparedDownload();
  }, [handleOpenModelPage, handleOpenTokenSettings, showModelActionError, startDownload, t]);

  const performLoad = useCallback(async (targetModelId: string) => {
    try {
      await loadModel(targetModelId);
      setRuntimeRevision((current) => current + 1);
    } catch (error) {
      showModelActionError('ModelDetailsScreen.performLoad', error);
    }
  }, [loadModel, showModelActionError]);

  const handleLoad = useCallback(async () => {
    if (!displayModel) {
      return;
    }

    if (displayModel.fitsInRam === false) {
      Alert.alert(
        t('models.memoryWarningTitle'),
        t('models.memoryWarningMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('models.loadAnyway'),
            onPress: async () => {
              await performLoad(displayModel.id);
            },
          },
        ],
      );
      return;
    }

    await performLoad(displayModel.id);
  }, [displayModel, performLoad, t]);

  const handleUnload = useCallback(async () => {
    try {
      await unloadModel();
      setRuntimeRevision((current) => current + 1);
    } catch (error) {
      showModelActionError('ModelDetailsScreen.handleUnload', error);
    }
  }, [showModelActionError, unloadModel]);

  const handleDelete = useCallback(() => {
    if (!displayModel) {
      return;
    }

    const applyDeletedState = () => {
      closeModelParameters();
      setModel((current) => (current ? {
        ...current,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        localPath: undefined,
        downloadedAt: undefined,
        resumeData: undefined,
      } : current));
      setRuntimeRevision((current) => current + 1);
    };

    Alert.alert(
      t('models.deleteTitle'),
      t('models.deleteMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('models.deleteKeepSettings'),
          onPress: async () => {
            try {
              await offloadModel(displayModel.id, { preserveSettings: true });
              applyDeletedState();
            } catch (error) {
              showModelActionError('ModelDetailsScreen.handleDelete.keepSettings', error);
            }
          },
        },
        {
          text: t('models.deleteResetSettings'),
          style: 'destructive',
          onPress: async () => {
            try {
              await offloadModel(displayModel.id, { preserveSettings: false });
              applyDeletedState();
            } catch (error) {
              showModelActionError('ModelDetailsScreen.handleDelete.resetSettings', error);
            }
          },
        },
      ],
    );
  }, [closeModelParameters, displayModel, showModelActionError, t]);

  return {
    accessBadge,
    cancelDownload,
    displayModel,
    errorMessage,
    handleChat,
    handleDelete,
    handleDownload,
    handleLoad,
    handleOpenModelPage,
    handleOpenTokenSettings,
    handleUnload,
    heroMetrics,
    loading,
    metadataMetrics,
    modelParametersSheetProps,
    openModelParameters,
  };
}
