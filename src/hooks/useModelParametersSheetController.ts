import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { useTranslation } from 'react-i18next';
import { llmEngineService, type LoadModelOptions } from '@/services/LLMEngineService';
import { toAppError } from '@/services/AppError';
import { registry } from '@/services/LocalStorageRegistry';
import { modelCatalogService } from '@/services/ModelCatalogService';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import {
  DEFAULT_MODEL_LOAD_PARAMETERS,
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
  getGenerationParametersForModel,
  getModelLoadParametersForModel,
  getSettings,
  resetGenerationParametersForModel,
  resetModelLoadParametersForModel,
  subscribeSettings,
  updateGenerationParametersForModel,
  updateModelLoadParametersForModel,
  type GenerationParameters,
  type ModelLoadParameters,
} from '@/services/SettingsStore';
import { EngineStatus, type ModelMetadata } from '@/types/models';
import { clampContextWindowTokens, resolveContextWindowCeiling } from '@/utils/contextWindow';
import { hasPersistedLoadProfileChanges } from '@/utils/modelLoadProfile';
import { handleModelLoadMemoryPolicyError } from '@/utils/modelLoadMemoryPolicyPrompt';
import { resolveKvCacheTypes } from '@/utils/kvCache';

interface UseModelParametersSheetControllerOptions {
  getModelById: (modelId: string | null) => ModelMetadata | undefined;
  showError: (scope: string, error: unknown) => void;
  applyReloadErrorScope: string;
  activeModelId?: string | null;
  canApplyReload?: boolean;
  modelLabelOverride?: string;
  paramsOverride?: GenerationParameters;
  defaultParamsOverride?: GenerationParameters;
  onChangeParams?: (modelId: string | null, partial: Partial<GenerationParameters>) => void;
  onResetParamField?: (modelId: string | null, field: keyof GenerationParameters) => void;
  onResetAllParams?: (modelId: string | null) => void;
  onAfterActiveModelReload?: (modelId: string) => void | Promise<void>;
}

function clampGpuLayers(gpuLayers: number | null | undefined, ceiling: number): number | null {
  if (gpuLayers === null || gpuLayers === undefined || !Number.isFinite(gpuLayers)) {
    return null;
  }

  return Math.min(Math.max(0, Math.round(gpuLayers)), ceiling);
}

export function useModelParametersSheetController({
  getModelById,
  showError,
  applyReloadErrorScope,
  activeModelId,
  canApplyReload = true,
  modelLabelOverride,
  paramsOverride,
  defaultParamsOverride,
  onChangeParams,
  onResetParamField,
  onResetAllParams,
  onAfterActiveModelReload,
}: UseModelParametersSheetControllerOptions) {
  const { t } = useTranslation();
  const { state: engineState } = useLLMEngine();
  const [isOpen, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [recommendedGpuLayers, setRecommendedGpuLayers] = useState(0);
  const [gpuLayersCeiling, setGpuLayersCeiling] = useState(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
  const [measuredContextWindowCeiling, setMeasuredContextWindowCeiling] = useState<number | null>(null);
  const [deviceTotalMemoryBytes, setDeviceTotalMemoryBytes] = useState<number | null>(null);
  const [draftLoadParams, setDraftLoadParams] = useState<ModelLoadParameters>({
    contextSize: DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
    gpuLayers: 0,
    kvCacheType: DEFAULT_MODEL_LOAD_PARAMETERS.kvCacheType,
  });
  const [isApplyingModelProfile, setApplyingModelProfile] = useState(false);
  const [subscribedActiveModelId, setSubscribedActiveModelId] = useState<string | null>(
    () => getSettings().activeModelId,
  );
  const loadDraftSourceRef = useRef<{
    contextSize: 'current' | 'default' | 'user';
    gpuLayers: 'current' | 'default' | 'user';
    kvCacheType: 'current' | 'default' | 'user';
  }>({
    contextSize: 'current',
    gpuLayers: 'current',
    kvCacheType: 'current',
  });
  const loadDraftSeedRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeModelId !== undefined) {
      return undefined;
    }

    return subscribeSettings((nextSettings) => {
      setSubscribedActiveModelId(nextSettings.activeModelId);
    });
  }, [activeModelId]);

  const resolvedActiveModelId = activeModelId ?? subscribedActiveModelId;
  const configurableModel = getModelById(selectedModelId);
  const configurableModelId = configurableModel?.id ?? selectedModelId;
  const modelLabel = modelLabelOverride
    ?? configurableModel?.name
    ?? (configurableModelId?.split('/').pop() ?? configurableModelId ?? '');
  const currentParams = paramsOverride ?? getGenerationParametersForModel(configurableModelId);
  const defaultParams = defaultParamsOverride ?? getGenerationParametersForModel(null);
  const currentLoadParams = getModelLoadParametersForModel(configurableModelId);
  const defaultLoadParams = getModelLoadParametersForModel(null);
  const isLoadedProfileActive = Boolean(
    configurableModelId
    && engineState.status === EngineStatus.READY
    && engineState.activeModelId === configurableModelId,
  );
  const loadedContextSize = isLoadedProfileActive ? llmEngineService.getContextSize() : null;
  const loadedGpuLayers = isLoadedProfileActive ? llmEngineService.getLoadedGpuLayers() : null;
  const safeModeLoadLimits = isLoadedProfileActive ? llmEngineService.getSafeModeLoadLimits() : null;
  const engineDiagnostics = isLoadedProfileActive ? engineState.diagnostics ?? null : null;
  const baseContextWindowCeiling = useMemo(() => resolveContextWindowCeiling({
    modelMaxContextTokens: configurableModel?.maxContextTokens,
    totalMemoryBytes: deviceTotalMemoryBytes,
    input: {
      modelSizeBytes: configurableModel?.size ?? null,
      verifiedFileSizeBytes: configurableModel?.metadataTrust === 'verified_local'
        ? configurableModel?.gguf?.totalBytes ?? configurableModel?.size ?? undefined
        : undefined,
      metadataTrust: configurableModel?.metadataTrust ?? 'unknown',
      ggufMetadata: configurableModel?.gguf as unknown as Record<string, unknown> | undefined,
      runtimeParams: {
        gpuLayers: currentLoadParams.gpuLayers ?? recommendedGpuLayers,
        ...resolveKvCacheTypes({
          kvCacheType: currentLoadParams.kvCacheType,
          requestedContextTokens: currentLoadParams.contextSize,
          totalMemoryBytes: deviceTotalMemoryBytes,
        }),
        useMmap: true,
      },
    },
  }), [
    configurableModel?.gguf,
    configurableModel?.maxContextTokens,
    configurableModel?.metadataTrust,
    configurableModel?.size,
    currentLoadParams.contextSize,
    currentLoadParams.gpuLayers,
    currentLoadParams.kvCacheType,
    deviceTotalMemoryBytes,
    recommendedGpuLayers,
  ]);
  const contextWindowCeiling = measuredContextWindowCeiling ?? baseContextWindowCeiling;
  const effectiveCurrentLoadParams = {
    contextSize: clampContextWindowTokens(currentLoadParams.contextSize, contextWindowCeiling),
    gpuLayers: currentLoadParams.gpuLayers,
    kvCacheType: currentLoadParams.kvCacheType,
  };
  const effectiveDefaultLoadParams = {
    contextSize: clampContextWindowTokens(defaultLoadParams.contextSize, contextWindowCeiling),
    gpuLayers: defaultLoadParams.gpuLayers,
    kvCacheType: defaultLoadParams.kvCacheType,
  };
  const draftPersistedGpuLayers = loadDraftSourceRef.current.gpuLayers === 'current'
    ? (currentLoadParams.gpuLayers ?? null)
    : loadDraftSourceRef.current.gpuLayers === 'default'
      ? (effectiveDefaultLoadParams.gpuLayers ?? null)
      : draftLoadParams.gpuLayers;
  const draftPersistedKvCacheType = loadDraftSourceRef.current.kvCacheType === 'current'
    ? currentLoadParams.kvCacheType
    : loadDraftSourceRef.current.kvCacheType === 'default'
      ? effectiveDefaultLoadParams.kvCacheType
      : draftLoadParams.kvCacheType;
  const applyButtonLabel = resolvedActiveModelId === configurableModelId
    ? t('models.applyAndReload')
    : t('models.saveLoadProfile');
  const showApplyReload = Boolean(configurableModelId) && (
    hasPersistedLoadProfileChanges({
      draftContextSize: draftLoadParams.contextSize,
      draftPersistedGpuLayers,
      draftKvCacheType: draftPersistedKvCacheType,
      persistedLoadParams: currentLoadParams,
    })
    || isApplyingModelProfile
  );

  const openModelParameters = useCallback((modelId: string | null | undefined) => {
    if (!modelId) {
      return;
    }

    setSelectedModelId(modelId);
    setOpen(true);
  }, []);

  const closeModelParameters = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setMeasuredContextWindowCeiling(null);
      setGpuLayersCeiling(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
      loadDraftSourceRef.current = {
        contextSize: 'current',
        gpuLayers: 'current',
        kvCacheType: 'current',
      };
      loadDraftSeedRef.current = null;
      return;
    }

    let isCancelled = false;
    const refreshTargetModel = configurableModelId ? registry.getModel(configurableModelId) : undefined;
    const shouldRefreshModelMetadata = refreshTargetModel?.hasVerifiedContextWindow !== true;

    setMeasuredContextWindowCeiling(null);
    setGpuLayersCeiling(UNKNOWN_MODEL_GPU_LAYERS_CEILING);

    const serviceAny = llmEngineService as unknown as {
      getRecommendedLoadProfile?: (modelId: string | null) => Promise<{ recommendedGpuLayers: number; gpuLayersCeiling: number }>;
      getRecommendedGpuLayers?: () => Promise<number>;
    };
    const loadRecommendation = (modelId: string | null) => {
      if (typeof serviceAny.getRecommendedLoadProfile === 'function') {
        return serviceAny.getRecommendedLoadProfile(modelId);
      }

      if (typeof serviceAny.getRecommendedGpuLayers === 'function') {
        return serviceAny.getRecommendedGpuLayers().then((nextGpuLayers) => ({
          recommendedGpuLayers: nextGpuLayers,
          gpuLayersCeiling: UNKNOWN_MODEL_GPU_LAYERS_CEILING,
        }));
      }

      return Promise.resolve({
        recommendedGpuLayers: 0,
        gpuLayersCeiling: UNKNOWN_MODEL_GPU_LAYERS_CEILING,
      });
    };

    void Promise.all([
      DeviceInfo.getTotalMemory().catch(() => null),
      shouldRefreshModelMetadata && refreshTargetModel
        ? modelCatalogService.refreshModelMetadata(refreshTargetModel).catch(() => refreshTargetModel)
        : Promise.resolve(refreshTargetModel),
    ])
      .then(([totalMemoryBytes, resolvedModel]) => {
        if (!isCancelled) {
          setDeviceTotalMemoryBytes(totalMemoryBytes);
          setMeasuredContextWindowCeiling(resolveContextWindowCeiling({
            modelMaxContextTokens: resolvedModel?.maxContextTokens,
            totalMemoryBytes,
            input: {
              modelSizeBytes: resolvedModel?.size ?? null,
              verifiedFileSizeBytes: resolvedModel?.metadataTrust === 'verified_local'
                ? resolvedModel?.gguf?.totalBytes ?? resolvedModel?.size ?? undefined
                : undefined,
              metadataTrust: resolvedModel?.metadataTrust ?? 'unknown',
              ggufMetadata: resolvedModel?.gguf as unknown as Record<string, unknown> | undefined,
              runtimeParams: {
                gpuLayers: currentLoadParams.gpuLayers ?? recommendedGpuLayers,
                ...resolveKvCacheTypes({
                  kvCacheType: currentLoadParams.kvCacheType,
                  requestedContextTokens: currentLoadParams.contextSize,
                  totalMemoryBytes,
                }),
                useMmap: true,
              },
            },
          }));
        }

        const resolvedModelId = resolvedModel?.id ?? configurableModelId ?? null;
        void loadRecommendation(resolvedModelId)
          .then((recommendation) => {
            if (!isCancelled) {
              setRecommendedGpuLayers(recommendation.recommendedGpuLayers);
              setGpuLayersCeiling(recommendation.gpuLayersCeiling);
            }
          })
          .catch(() => {
            if (!isCancelled) {
              setRecommendedGpuLayers(0);
              setGpuLayersCeiling(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
            }
          });
      })
      .catch(() => {
        if (!isCancelled) {
          setMeasuredContextWindowCeiling(null);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [
    configurableModelId,
    currentLoadParams.contextSize,
    currentLoadParams.gpuLayers,
    currentLoadParams.kvCacheType,
    isOpen,
    recommendedGpuLayers,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const seedKey = configurableModelId ?? '__no-model__';
    const shouldInitializeDraft = loadDraftSeedRef.current !== seedKey;

    if (shouldInitializeDraft) {
      loadDraftSourceRef.current = {
        contextSize: 'current',
        gpuLayers: 'current',
        kvCacheType: 'current',
      };
      loadDraftSeedRef.current = seedKey;
    }

    setDraftLoadParams((current) => {
      const nextContextSize = shouldInitializeDraft
        ? effectiveCurrentLoadParams.contextSize
        : (
          loadDraftSourceRef.current.contextSize === 'current'
            ? effectiveCurrentLoadParams.contextSize
            : loadDraftSourceRef.current.contextSize === 'default'
              ? effectiveDefaultLoadParams.contextSize
              : clampContextWindowTokens(current.contextSize, contextWindowCeiling)
        );
      const nextGpuLayers = shouldInitializeDraft
        ? (currentLoadParams.gpuLayers ?? recommendedGpuLayers)
        : (
          loadDraftSourceRef.current.gpuLayers === 'current'
            ? (currentLoadParams.gpuLayers ?? recommendedGpuLayers)
            : loadDraftSourceRef.current.gpuLayers === 'default'
              ? (effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers)
              : current.gpuLayers
        );
      const nextKvCacheType = shouldInitializeDraft
        ? effectiveCurrentLoadParams.kvCacheType
        : (
          loadDraftSourceRef.current.kvCacheType === 'current'
            ? effectiveCurrentLoadParams.kvCacheType
            : loadDraftSourceRef.current.kvCacheType === 'default'
              ? effectiveDefaultLoadParams.kvCacheType
              : current.kvCacheType
        );
      const clampedNextGpuLayers = clampGpuLayers(nextGpuLayers, gpuLayersCeiling);

      if (
        current.contextSize === nextContextSize
        && current.gpuLayers === clampedNextGpuLayers
        && current.kvCacheType === nextKvCacheType
      ) {
        return current;
      }

      return {
        contextSize: nextContextSize,
        gpuLayers: clampedNextGpuLayers,
        kvCacheType: nextKvCacheType,
      };
    });
  }, [
    configurableModelId,
    contextWindowCeiling,
    currentLoadParams.gpuLayers,
    effectiveCurrentLoadParams.contextSize,
    effectiveCurrentLoadParams.kvCacheType,
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    isOpen,
    gpuLayersCeiling,
    recommendedGpuLayers,
  ]);

  const applyLoadParams = useCallback(async () => {
    if (!configurableModelId) {
      return;
    }

    setApplyingModelProfile(true);

    try {
      const nextContextSize = clampContextWindowTokens(
        draftLoadParams.contextSize,
        contextWindowCeiling,
      );
      const nextGpuLayers = loadDraftSourceRef.current.gpuLayers === 'current'
        ? (currentLoadParams.gpuLayers ?? null)
        : loadDraftSourceRef.current.gpuLayers === 'default'
          ? (effectiveDefaultLoadParams.gpuLayers ?? null)
          : draftLoadParams.gpuLayers;
      const nextKvCacheType = loadDraftSourceRef.current.kvCacheType === 'current'
        ? currentLoadParams.kvCacheType
        : loadDraftSourceRef.current.kvCacheType === 'default'
          ? effectiveDefaultLoadParams.kvCacheType
          : draftLoadParams.kvCacheType;
      const defaultContextSize = clampContextWindowTokens(
        DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
        contextWindowCeiling,
      );
      const clampedNextGpuLayers = clampGpuLayers(nextGpuLayers, gpuLayersCeiling);
      const isResetToDefaultProfile =
        nextContextSize === defaultContextSize
        && (clampedNextGpuLayers ?? recommendedGpuLayers) === recommendedGpuLayers
        && nextKvCacheType === DEFAULT_MODEL_LOAD_PARAMETERS.kvCacheType;

      if (nextContextSize !== draftLoadParams.contextSize) {
        setDraftLoadParams((current) => ({
          ...current,
          contextSize: nextContextSize,
        }));
      }

      if (isResetToDefaultProfile) {
        resetModelLoadParametersForModel(configurableModelId);
      } else {
        updateModelLoadParametersForModel(configurableModelId, {
          contextSize: nextContextSize,
          gpuLayers: clampedNextGpuLayers,
          kvCacheType: nextKvCacheType,
        });
      }

      if (resolvedActiveModelId === configurableModelId) {
        await llmEngineService.load(configurableModelId, { forceReload: true });

        const effectiveLoadedContextSize = llmEngineService.getContextSize();
        if (
          Number.isFinite(effectiveLoadedContextSize)
          && effectiveLoadedContextSize > 0
          && effectiveLoadedContextSize < nextContextSize
        ) {
          const didLoadInSafeMode = llmEngineService.getSafeModeLoadLimits() !== null;
          Alert.alert(
            t('chat.modelControls.runtimeMismatchTitle'),
            didLoadInSafeMode
              ? t('chat.modelControls.runtimeMismatchDescriptionSafe', {
                  requested: nextContextSize,
                  loaded: effectiveLoadedContextSize,
                })
              : t('chat.modelControls.runtimeMismatchDescription', {
                  requested: nextContextSize,
                  loaded: effectiveLoadedContextSize,
                }),
          );
        }

        await Promise.resolve(onAfterActiveModelReload?.(configurableModelId));
      }
    } catch (error) {
      const appError = toAppError(error);

      const baseLoadOptions: LoadModelOptions = { forceReload: true };
      const retryLoad = (loadOptions: LoadModelOptions) => {
        void (async () => {
          try {
            await llmEngineService.load(configurableModelId, loadOptions);
            await Promise.resolve(onAfterActiveModelReload?.(configurableModelId));
          } catch (retryError) {
            const retryAppError = toAppError(retryError);
            if (handleModelLoadMemoryPolicyError({
              t,
              appError: retryAppError,
              options: loadOptions,
              onRetry: retryLoad,
            })) {
              return;
            }
            showError(applyReloadErrorScope, retryError);
          }
        })();
      };

      if (handleModelLoadMemoryPolicyError({
        t,
        appError,
        options: baseLoadOptions,
        onRetry: retryLoad,
      })) {
        return;
      }

      showError(applyReloadErrorScope, error);
    } finally {
      setApplyingModelProfile(false);
    }
  }, [
    applyReloadErrorScope,
    configurableModelId,
    contextWindowCeiling,
    currentLoadParams.gpuLayers,
    currentLoadParams.kvCacheType,
    draftLoadParams.contextSize,
    draftLoadParams.gpuLayers,
    draftLoadParams.kvCacheType,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    onAfterActiveModelReload,
    gpuLayersCeiling,
    recommendedGpuLayers,
    resolvedActiveModelId,
    showError,
    t,
  ]);

  const handleChangeParams = useCallback((partial: Partial<GenerationParameters>) => {
    if (onChangeParams) {
      onChangeParams(configurableModelId, partial);
      return;
    }

    updateGenerationParametersForModel(configurableModelId, partial);
  }, [configurableModelId, onChangeParams]);

  const handleChangeLoadParams = useCallback((partial: Partial<ModelLoadParameters>) => {
    if (partial.contextSize !== undefined) {
      loadDraftSourceRef.current.contextSize = 'user';
    }
    if (partial.gpuLayers !== undefined) {
      loadDraftSourceRef.current.gpuLayers = 'user';
    }
    if (partial.kvCacheType !== undefined) {
      loadDraftSourceRef.current.kvCacheType = 'user';
    }

    setDraftLoadParams((current) => {
      const nextGpuLayers = partial.gpuLayers === undefined
        ? current.gpuLayers
        : clampGpuLayers(partial.gpuLayers, gpuLayersCeiling);

      return {
        ...current,
        ...partial,
        gpuLayers: nextGpuLayers,
        contextSize: partial.contextSize === undefined
          ? current.contextSize
          : clampContextWindowTokens(partial.contextSize, contextWindowCeiling),
      };
    });
  }, [contextWindowCeiling, gpuLayersCeiling]);

  const handleResetParamField = useCallback((field: keyof GenerationParameters) => {
    if (onResetParamField) {
      onResetParamField(configurableModelId, field);
      return;
    }

    const resetParams = getGenerationParametersForModel(null);
    const partial = { [field]: resetParams[field] } as Partial<typeof resetParams>;
    updateGenerationParametersForModel(configurableModelId, partial);
  }, [configurableModelId, onResetParamField]);

  const handleResetLoadField = useCallback((field: keyof ModelLoadParameters) => {
    if (field === 'contextSize') {
      loadDraftSourceRef.current.contextSize = 'default';
    } else if (field === 'gpuLayers') {
      loadDraftSourceRef.current.gpuLayers = 'default';
    } else {
      loadDraftSourceRef.current.kvCacheType = 'default';
    }

    setDraftLoadParams((current) => ({
      ...current,
      [field]: field === 'gpuLayers'
        ? Math.min(
            gpuLayersCeiling,
            effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers,
          )
        : field === 'kvCacheType'
          ? effectiveDefaultLoadParams.kvCacheType
          : effectiveDefaultLoadParams.contextSize,
    }));
  }, [
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    gpuLayersCeiling,
    recommendedGpuLayers,
  ]);

  const handleResetAll = useCallback(() => {
    loadDraftSourceRef.current = {
      contextSize: 'default',
      gpuLayers: 'default',
      kvCacheType: 'default',
    };

    if (onResetAllParams) {
      onResetAllParams(configurableModelId);
    } else {
      resetGenerationParametersForModel(configurableModelId);
    }

    setDraftLoadParams({
      contextSize: effectiveDefaultLoadParams.contextSize,
      gpuLayers: Math.min(
        gpuLayersCeiling,
        effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers,
      ),
      kvCacheType: effectiveDefaultLoadParams.kvCacheType,
    });
  }, [
    configurableModelId,
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    gpuLayersCeiling,
    onResetAllParams,
    recommendedGpuLayers,
  ]);

  return {
    openModelParameters,
    closeModelParameters,
    sheetProps: {
      visible: isOpen,
      modelId: configurableModelId,
      modelLabel,
      params: currentParams,
      defaultParams,
      contextWindowCeiling,
      gpuLayersCeiling,
      isSafeModeActive: safeModeLoadLimits !== null,
      loadParamsDraft: draftLoadParams,
      defaultLoadParams: effectiveDefaultLoadParams,
      recommendedGpuLayers,
      applyButtonLabel,
      canApplyReload: Boolean(configurableModelId) && canApplyReload && !isApplyingModelProfile,
      isApplyingReload: isApplyingModelProfile,
      showApplyReload,
      onClose: closeModelParameters,
      onChangeParams: handleChangeParams,
      onChangeLoadParams: handleChangeLoadParams,
      onResetParamField: handleResetParamField,
      onResetLoadField: handleResetLoadField,
      onReset: handleResetAll,
      onApplyReload: applyLoadParams,
      loadedContextSize,
      loadedGpuLayers,
      engineDiagnostics,
    },
  };
}
