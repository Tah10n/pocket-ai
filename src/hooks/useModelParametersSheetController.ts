import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeviceInfo from 'react-native-device-info';
import { useTranslation } from 'react-i18next';
import { llmEngineService } from '@/services/LLMEngineService';
import { registry } from '@/services/LocalStorageRegistry';
import { modelCatalogService } from '@/services/ModelCatalogService';
import {
  DEFAULT_MODEL_LOAD_PARAMETERS,
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
import type { ModelMetadata } from '@/types/models';
import { clampContextWindowTokens, resolveContextWindowCeiling } from '@/utils/contextWindow';
import { hasPersistedLoadProfileChanges } from '@/utils/modelLoadProfile';

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
  const [isOpen, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [recommendedGpuLayers, setRecommendedGpuLayers] = useState(0);
  const [measuredContextWindowCeiling, setMeasuredContextWindowCeiling] = useState<number | null>(null);
  const [draftLoadParams, setDraftLoadParams] = useState<ModelLoadParameters>({
    contextSize: DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
    gpuLayers: 0,
  });
  const [isApplyingModelProfile, setApplyingModelProfile] = useState(false);
  const [subscribedActiveModelId, setSubscribedActiveModelId] = useState<string | null>(
    () => getSettings().activeModelId,
  );
  const loadDraftSourceRef = useRef<{
    contextSize: 'current' | 'default' | 'user';
    gpuLayers: 'current' | 'default' | 'user';
  }>({
    contextSize: 'current',
    gpuLayers: 'current',
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
  const baseContextWindowCeiling = useMemo(() => resolveContextWindowCeiling({
    modelMaxContextTokens: configurableModel?.maxContextTokens,
    modelSizeBytes: configurableModel?.size ?? null,
  }), [configurableModel?.maxContextTokens, configurableModel?.size]);
  const contextWindowCeiling = measuredContextWindowCeiling ?? baseContextWindowCeiling;
  const effectiveCurrentLoadParams = {
    contextSize: clampContextWindowTokens(currentLoadParams.contextSize, contextWindowCeiling),
    gpuLayers: currentLoadParams.gpuLayers,
  };
  const effectiveDefaultLoadParams = {
    contextSize: clampContextWindowTokens(defaultLoadParams.contextSize, contextWindowCeiling),
    gpuLayers: defaultLoadParams.gpuLayers,
  };
  const draftPersistedGpuLayers = loadDraftSourceRef.current.gpuLayers === 'current'
    ? (currentLoadParams.gpuLayers ?? null)
    : loadDraftSourceRef.current.gpuLayers === 'default'
      ? (effectiveDefaultLoadParams.gpuLayers ?? null)
      : draftLoadParams.gpuLayers;
  const applyButtonLabel = resolvedActiveModelId === configurableModelId
    ? t('models.applyAndReload')
    : t('models.saveLoadProfile');
  const showApplyReload = Boolean(configurableModelId) && (
    hasPersistedLoadProfileChanges({
      draftContextSize: draftLoadParams.contextSize,
      draftPersistedGpuLayers,
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
      loadDraftSourceRef.current = {
        contextSize: 'current',
        gpuLayers: 'current',
      };
      loadDraftSeedRef.current = null;
      return;
    }

    let isCancelled = false;
    const refreshTargetModel = configurableModelId ? registry.getModel(configurableModelId) : undefined;
    const shouldRefreshModelMetadata = refreshTargetModel?.hasVerifiedContextWindow !== true;

    setMeasuredContextWindowCeiling(null);

    void llmEngineService.getRecommendedGpuLayers()
      .then((nextGpuLayers: number) => {
        if (!isCancelled) {
          setRecommendedGpuLayers(nextGpuLayers);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setRecommendedGpuLayers(0);
        }
      });

    void Promise.all([
      DeviceInfo.getTotalMemory().catch(() => null),
      shouldRefreshModelMetadata && refreshTargetModel
        ? modelCatalogService.refreshModelMetadata(refreshTargetModel).catch(() => refreshTargetModel)
        : Promise.resolve(refreshTargetModel),
    ])
      .then(([totalMemoryBytes, resolvedModel]) => {
        if (!isCancelled) {
          setMeasuredContextWindowCeiling(resolveContextWindowCeiling({
            modelMaxContextTokens: resolvedModel?.maxContextTokens,
            modelSizeBytes: resolvedModel?.size ?? null,
            totalMemoryBytes,
          }));
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setMeasuredContextWindowCeiling(null);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [configurableModelId, isOpen]);

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

      if (
        current.contextSize === nextContextSize
        && current.gpuLayers === nextGpuLayers
      ) {
        return current;
      }

      return {
        contextSize: nextContextSize,
        gpuLayers: nextGpuLayers,
      };
    });
  }, [
    configurableModelId,
    contextWindowCeiling,
    currentLoadParams.gpuLayers,
    effectiveCurrentLoadParams.contextSize,
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
    isOpen,
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
      const defaultContextSize = clampContextWindowTokens(
        DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
        contextWindowCeiling,
      );
      const isResetToDefaultProfile =
        nextContextSize === defaultContextSize
        && (nextGpuLayers ?? recommendedGpuLayers) === recommendedGpuLayers;

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
          gpuLayers: nextGpuLayers,
        });
      }

      if (resolvedActiveModelId === configurableModelId) {
        await llmEngineService.load(configurableModelId, { forceReload: true });
        await Promise.resolve(onAfterActiveModelReload?.(configurableModelId));
      }
    } catch (error) {
      showError(applyReloadErrorScope, error);
    } finally {
      setApplyingModelProfile(false);
    }
  }, [
    applyReloadErrorScope,
    configurableModelId,
    contextWindowCeiling,
    currentLoadParams.gpuLayers,
    draftLoadParams.contextSize,
    draftLoadParams.gpuLayers,
    effectiveDefaultLoadParams.gpuLayers,
    onAfterActiveModelReload,
    recommendedGpuLayers,
    resolvedActiveModelId,
    showError,
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

    setDraftLoadParams((current) => ({
      ...current,
      ...partial,
      contextSize: partial.contextSize === undefined
        ? current.contextSize
        : clampContextWindowTokens(partial.contextSize, contextWindowCeiling),
    }));
  }, [contextWindowCeiling]);

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
    } else {
      loadDraftSourceRef.current.gpuLayers = 'default';
    }

    setDraftLoadParams((current) => ({
      ...current,
      [field]: field === 'gpuLayers'
        ? (effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers)
        : effectiveDefaultLoadParams.contextSize,
    }));
  }, [effectiveDefaultLoadParams.contextSize, effectiveDefaultLoadParams.gpuLayers, recommendedGpuLayers]);

  const handleResetAll = useCallback(() => {
    loadDraftSourceRef.current = {
      contextSize: 'default',
      gpuLayers: 'default',
    };

    if (onResetAllParams) {
      onResetAllParams(configurableModelId);
    } else {
      resetGenerationParametersForModel(configurableModelId);
    }

    setDraftLoadParams({
      contextSize: effectiveDefaultLoadParams.contextSize,
      gpuLayers: effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers,
    });
  }, [
    configurableModelId,
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
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
    },
  };
}
