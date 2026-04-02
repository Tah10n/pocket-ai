import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
import { useModelDownload } from '@/hooks/useModelDownload';
import { registry } from '@/services/LocalStorageRegistry';
import {
  getHuggingFaceModelUrl,
  getModelCatalogErrorMessage,
  modelCatalogService,
} from '@/services/ModelCatalogService';
import { offloadModel } from '@/services/StorageManagerService';
import { LifecycleStatus, type ModelMetadata } from '@/types/models';
import { getReportedErrorMessage } from '../services/AppError';
import {
  buildModelDetailsHeroMetrics,
  buildModelDetailsMetadataMetrics,
  createModelDetailsPlaceholder,
  getModelDetailsAccessBadge,
} from '../utils/modelDetailsPresentation';
import { startModelDownloadFlow } from '../utils/modelDownloadFlow';
import { mergeModelWithRuntimeState } from '../utils/modelRuntimeState';

export function useModelDetailsController(modelId: string) {
  const router = useRouter();
  const { t } = useTranslation();
  const missingModelMessage = t('models.detailMissingModel');
  const previousModelIdRef = useRef<string | null>(null);
  const [model, setModel] = useState<ModelMetadata | null>(
    () => (modelId
      ? modelCatalogService.getCachedModel(modelId) ?? createModelDetailsPlaceholder(modelId)
      : null),
  );
  const [loading, setLoading] = useState(Boolean(modelId));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const { startDownload, cancelDownload, queue } = useModelDownload();
  const { loadModel, unloadModel, fitsInRam, state: engineState } = useLLMEngine();

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
    const previousModelId = previousModelIdRef.current;
    if (previousModelId !== modelId) {
      previousModelIdRef.current = modelId;
      setModel(modelCatalogService.getCachedModel(modelId) ?? createModelDetailsPlaceholder(modelId));
    }

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
    router.push('/huggingface-token');
  }, [router]);

  const handleChat = useCallback(() => {
    router.push('/chat');
  }, [router]);

  const handleDownload = useCallback((targetModel: ModelMetadata) => {
    startModelDownloadFlow({
      model: targetModel,
      t,
      fitsInRam,
      startDownload,
      openTokenSettings: handleOpenTokenSettings,
      openModelPage: handleOpenModelPage,
      onResolvedModel: (resolvedModel) => {
        setModel((current) => (current ? { ...current, ...resolvedModel } : resolvedModel));
      },
      onError: (error) => {
        showModelActionError('ModelDetailsScreen.handleDownload', error);
      },
    });
  }, [fitsInRam, handleOpenModelPage, handleOpenTokenSettings, showModelActionError, startDownload, t]);

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

    if (typeof displayModel.size === 'number' && Number.isFinite(displayModel.size) && displayModel.size > 0) {
      const liveFitsInRam = await fitsInRam(displayModel.size);
      if (!liveFitsInRam) {
        Alert.alert(
          t('models.memoryWarningTitle'),
          t('common.errors.modelMemoryInsufficient'),
          [{ text: t('common.close') }],
        );
        return;
      }
    }

    await performLoad(displayModel.id);
  }, [displayModel, fitsInRam, performLoad, t]);

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
