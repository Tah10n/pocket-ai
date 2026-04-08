import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
import { useModelDownload } from '@/hooks/useModelDownload';
import { useModelRegistryRevision } from '@/hooks/useModelRegistryRevision';
import { useErrorReportSheetController, type ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import { useDownloadStore } from '@/store/downloadStore';
import { llmEngineService, type LoadModelOptions } from '@/services/LLMEngineService';
import { registry } from '@/services/LocalStorageRegistry';
import {
  getHuggingFaceModelUrl,
  getModelCatalogErrorMessage,
  modelCatalogService,
} from '@/services/ModelCatalogService';
import { offloadModel } from '@/services/StorageManagerService';
import { LifecycleStatus, type ModelMetadata } from '@/types/models';
import { getReportedErrorMessage, toAppError } from '../services/AppError';
import {
  buildModelDetailsHeroMetrics,
  buildModelDetailsMetadataMetrics,
  createModelDetailsPlaceholder,
  getModelDetailsAccessBadge,
} from '../utils/modelDetailsPresentation';
import { isHighConfidenceLikelyOomMemoryFit, shouldWarnForModelMemoryLoad } from '../utils/modelMemoryFitState';
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
  const modelsRegistryRevision = useModelRegistryRevision();
  const { startDownload, cancelDownload } = useModelDownload();
  const queuedItem = useDownloadStore((state) => state.queue.find((item) => item.id === modelId));
  const { loadModel, unloadModel, state: engineState } = useLLMEngine();
  const { openErrorReport, sheetProps: errorReportSheetProps } = useErrorReportSheetController();

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
    void modelsRegistryRevision;

    return mergeModelWithRuntimeState(model, {
      activeModelId: engineState.activeModelId,
      localModel: registry.getModel(model.id),
      queuedItem: queuedItem?.id === model.id ? queuedItem : undefined,
    });
  }, [engineState.activeModelId, model, modelsRegistryRevision, queuedItem, runtimeRevision]);

  const getConfigurableModelById = useCallback((targetModelId: string | null) => {
    if (!targetModelId) {
      return undefined;
    }

    void runtimeRevision;
    void modelsRegistryRevision;

    return targetModelId === displayModel?.id
      ? displayModel
      : registry.getModel(targetModelId);
  }, [displayModel, modelsRegistryRevision, runtimeRevision]);

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

  const showModelActionError = useCallback((scope: string, error: unknown, reportContext?: ErrorReportContext) => {
    const message = getReportedErrorMessage(scope, error, t);
    const appError = toAppError(error);
    const isReportable = (
      appError.code === 'model_load_failed'
      || appError.code === 'model_memory_insufficient'
      || appError.code === 'model_incompatible'
    );

    if (!isReportable) {
      Alert.alert(t('models.actionFailedTitle'), message);
      return;
    }

    Alert.alert(
      t('models.actionFailedTitle'),
      message,
      [
        { text: t('common.close'), style: 'cancel' },
        {
          text: t('models.errorReport.reportButton'),
          onPress: () => {
            openErrorReport({
              scope,
              error,
              context: reportContext,
            });
          },
        },
      ],
    );
  }, [openErrorReport, t]);

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

  const reportEngineError = useCallback(() => {
    const lastError = llmEngineService.getLastModelLoadError();
    const lastErrorDetails = lastError?.error.details;
    const modelIdFromError = typeof lastErrorDetails?.modelId === 'string'
      ? lastErrorDetails.modelId
      : engineState.activeModelId;
    const model = modelIdFromError ? registry.getModel(modelIdFromError) : undefined;
    const allowUnsafeMemoryLoad = typeof lastErrorDetails?.allowUnsafeMemoryLoad === 'boolean'
      ? lastErrorDetails.allowUnsafeMemoryLoad
      : undefined;
    const forceReload = typeof lastErrorDetails?.forceReload === 'boolean'
      ? lastErrorDetails.forceReload
      : undefined;

    openErrorReport({
      scope: lastError?.scope ?? 'LLMEngineService.load',
      error: lastError?.error ?? new Error(engineState.lastError ?? 'Model load failed'),
      context: {
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
        } : modelIdFromError ? { id: modelIdFromError } : undefined,
        engine: {
          status: engineState.status,
          activeModelId: engineState.activeModelId,
          loadProgress: engineState.loadProgress,
          lastError: engineState.lastError,
        },
        options: allowUnsafeMemoryLoad !== undefined || forceReload !== undefined
          ? {
              allowUnsafeMemoryLoad,
              forceReload,
            }
          : undefined,
      },
    });
  }, [
    engineState.activeModelId,
    engineState.lastError,
    engineState.loadProgress,
    engineState.status,
    openErrorReport,
  ]);

  const dismissEngineError = useCallback(() => {
    llmEngineService.clearLastModelLoadError();
    void unloadModel()
      .catch(() => undefined)
      .finally(() => {
        setRuntimeRevision((current) => current + 1);
      });
  }, [unloadModel]);

  const handleDownload = useCallback((targetModel: ModelMetadata) => {
    startModelDownloadFlow({
      model: targetModel,
      t,
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
  }, [handleOpenModelPage, handleOpenTokenSettings, showModelActionError, startDownload, t]);

  const performLoad = useCallback(async (targetModelId: string, options?: LoadModelOptions) => {
    try {
      await loadModel(targetModelId, options);
      setRuntimeRevision((current) => current + 1);
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === 'model_load_blocked') {
        setRuntimeRevision((current) => current + 1);
        Alert.alert(
          t('models.ramLikelyOom'),
          t('models.loadMemoryBlockedMessage'),
          [
            { text: t('common.close') },
          ],
        );
        return;
      }
      if (appError.code === 'model_memory_warning') {
        Alert.alert(
          t('models.memoryWarningTitle'),
          t('models.loadMemoryWarningMessage'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('models.loadAnyway'), onPress: () => { setTimeout(() => { void performLoad(targetModelId, { ...options, allowUnsafeMemoryLoad: true }); }, 0); } },
          ],
        );
        return;
      }

      if (
        appError.code === 'model_load_failed'
        || appError.code === 'model_memory_insufficient'
        || appError.code === 'model_incompatible'
      ) {
        return;
      }

      const model = targetModelId === displayModel?.id
        ? displayModel
        : registry.getModel(targetModelId);
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
        } : { id: targetModelId },
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

      showModelActionError('ModelDetailsScreen.performLoad', error, reportContext);
    }
  }, [displayModel, engineState.activeModelId, engineState.loadProgress, engineState.status, loadModel, showModelActionError, t]);

  const handleLoad = useCallback(async () => {
    if (!displayModel) {
      return;
    }

    if (isHighConfidenceLikelyOomMemoryFit(displayModel)) {
      Alert.alert(
        t('models.ramLikelyOom'),
        t('models.loadMemoryBlockedMessage'),
        [
          { text: t('common.close') },
        ],
      );
      return;
    }

    if (shouldWarnForModelMemoryLoad(displayModel)) {
      Alert.alert(
        t('models.memoryWarningTitle'),
        t('models.loadMemoryWarningMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('models.loadAnyway'), onPress: () => { void performLoad(displayModel.id, { allowUnsafeMemoryLoad: true }); } },
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
    engineState,
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
    dismissEngineError,
    errorReportSheetProps,
    modelParametersSheetProps,
    openModelParameters,
    reportEngineError,
  };
}
