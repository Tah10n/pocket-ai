import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { useTranslation } from 'react-i18next';
import { llmEngineService, type LoadModelOptions } from '@/services/LLMEngineService';
import { toAppError } from '@/services/AppError';
import { inferenceAutotuneService } from '@/services/InferenceAutotuneService';
import { readAutotuneResult, type AutotuneResult } from '@/services/InferenceAutotuneStore';
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
  type ModelLoadProfileField,
} from '@/services/SettingsStore';
import { EngineStatus, LifecycleStatus, type ModelMetadata, type ModelMetadataTrust } from '@/types/models';
import { clampContextWindowTokens, resolveContextWindowCeiling } from '@/utils/contextWindow';
import { resolveModelCapabilitySnapshot } from '@/utils/modelCapabilities';
import { hasPersistedLoadProfileChanges } from '@/utils/modelLoadProfile';
import { handleModelLoadMemoryPolicyError } from '@/utils/modelLoadMemoryPolicyPrompt';
import {
  clampReasoningEnabled,
  normalizeReasoningPreference,
  resolveModelReasoningCapability,
} from '@/utils/modelReasoningCapabilities';
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

function metadataTrustRank(trust: ModelMetadataTrust | undefined): number {
  switch (trust) {
    case 'verified_local':
      return 3;
    case 'trusted_remote':
      return 2;
    case 'inferred':
      return 1;
    case 'unknown':
      return 0;
    default:
      return -1;
  }
}

function resolveHeuristicModel(
  model: ModelMetadata | undefined,
  persistedModel: ModelMetadata | undefined,
): ModelMetadata | undefined {
  if (!model) {
    return persistedModel;
  }

  if (!persistedModel) {
    return model;
  }

  const modelTrustRank = metadataTrustRank(model.metadataTrust);
  const persistedTrustRank = metadataTrustRank(persistedModel.metadataTrust);
  const preferPersisted = persistedTrustRank > modelTrustRank;
  const resolvedMetadataTrust = preferPersisted
    ? persistedModel.metadataTrust ?? model.metadataTrust
    : modelTrustRank > persistedTrustRank
      ? model.metadataTrust ?? persistedModel.metadataTrust
      : model.metadataTrust ?? persistedModel.metadataTrust;
  const resolvedHasVerifiedContextWindow = model.hasVerifiedContextWindow === true || persistedModel.hasVerifiedContextWindow === true
    ? true
    : model.hasVerifiedContextWindow ?? persistedModel.hasVerifiedContextWindow;
  const resolvedMaxContextTokens = persistedModel.hasVerifiedContextWindow === true && typeof persistedModel.maxContextTokens === 'number'
    ? persistedModel.maxContextTokens
    : model.maxContextTokens ?? persistedModel.maxContextTokens;
  const resolvedGguf = model.gguf || persistedModel.gguf
    ? preferPersisted
      ? {
          ...(model.gguf ?? {}),
          ...(persistedModel.gguf ?? {}),
        }
      : {
          ...(persistedModel.gguf ?? {}),
          ...(model.gguf ?? {}),
        }
    : undefined;

  return {
    ...model,
    size: preferPersisted ? persistedModel.size ?? model.size : model.size ?? persistedModel.size,
    lastModifiedAt: preferPersisted ? persistedModel.lastModifiedAt ?? model.lastModifiedAt : model.lastModifiedAt ?? persistedModel.lastModifiedAt,
    sha256: preferPersisted ? persistedModel.sha256 ?? model.sha256 : model.sha256 ?? persistedModel.sha256,
    metadataTrust: resolvedMetadataTrust,
    gguf: resolvedGguf,
    maxContextTokens: resolvedMaxContextTokens,
    hasVerifiedContextWindow: resolvedHasVerifiedContextWindow,
    capabilitySnapshot: preferPersisted
      ? persistedModel.capabilitySnapshot ?? model.capabilitySnapshot
      : model.capabilitySnapshot ?? persistedModel.capabilitySnapshot,
  };
}

function resolveModelContextWindowCeiling({
  modelSizeBytes,
  modelMaxContextTokens,
  modelMetadataTrust,
  modelGgufMetadata,
  totalMemoryBytes,
  contextSize,
  gpuLayers,
  kvCacheType,
  fallbackGpuLayers,
}: {
  modelSizeBytes: number | null | undefined;
  modelMaxContextTokens: number | undefined;
  modelMetadataTrust: ModelMetadata['metadataTrust'];
  modelGgufMetadata: ModelMetadata['gguf'];
  totalMemoryBytes: number | null;
  contextSize: ModelLoadParameters['contextSize'];
  gpuLayers: ModelLoadParameters['gpuLayers'];
  kvCacheType: ModelLoadParameters['kvCacheType'];
  fallbackGpuLayers: number;
}): number {
  return resolveContextWindowCeiling({
    modelMaxContextTokens,
    totalMemoryBytes,
    input: {
      modelSizeBytes: modelSizeBytes ?? null,
      verifiedFileSizeBytes: modelMetadataTrust === 'verified_local'
        ? modelGgufMetadata?.totalBytes ?? modelSizeBytes ?? undefined
        : undefined,
      metadataTrust: modelMetadataTrust ?? 'unknown',
      ggufMetadata: modelGgufMetadata as unknown as Record<string, unknown> | undefined,
      runtimeParams: {
        gpuLayers: gpuLayers ?? fallbackGpuLayers,
        ...resolveKvCacheTypes({
          kvCacheType,
          requestedContextTokens: contextSize,
          totalMemoryBytes,
        }),
        useMmap: true,
      },
    },
  });
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
  const [, setSettingsRevision] = useState(0);
  const [recommendedGpuLayers, setRecommendedGpuLayers] = useState(0);
  const [gpuLayersCeiling, setGpuLayersCeiling] = useState(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
  const [measuredContextWindowCeiling, setMeasuredContextWindowCeiling] = useState<number | null>(null);
  const [deviceTotalMemoryBytes, setDeviceTotalMemoryBytes] = useState<number | null>(null);
  const [backendAvailability, setBackendAvailability] = useState<{
    gpuBackendAvailable: boolean | null;
    npuBackendAvailable: boolean | null;
    discoveryUnavailable: boolean | null;
  }>({
    gpuBackendAvailable: null,
    npuBackendAvailable: null,
    discoveryUnavailable: null,
  });
  const [draftLoadParams, setDraftLoadParams] = useState<ModelLoadParameters>({
    contextSize: DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
    gpuLayers: 0,
    kvCacheType: DEFAULT_MODEL_LOAD_PARAMETERS.kvCacheType,
    backendPolicy: undefined,
  });
  const [isApplyingModelProfile, setApplyingModelProfile] = useState(false);
  const [didSaveLoadProfile, setDidSaveLoadProfile] = useState(false);
  const [subscribedActiveModelId, setSubscribedActiveModelId] = useState<string | null>(
    () => getSettings().activeModelId,
  );
  const showAdvancedInferenceControls = getSettings().showAdvancedInferenceControls === true;
  const [isRunningAutotune, setRunningAutotune] = useState(false);
  const [autotuneResult, setAutotuneResult] = useState<AutotuneResult | null>(null);
  const loadDraftSourceRef = useRef<{
    contextSize: 'current' | 'default' | 'user';
    gpuLayers: 'current' | 'default' | 'user';
    kvCacheType: 'current' | 'default' | 'user';
    backendPolicy: 'current' | 'default' | 'user';
  }>({
    contextSize: 'current',
    gpuLayers: 'current',
    kvCacheType: 'current',
    backendPolicy: 'current',
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

  useEffect(() => {
    if (!isOpen || paramsOverride !== undefined) {
      return undefined;
    }

    return subscribeSettings(() => {
      setSettingsRevision((current) => current + 1);
    });
  }, [isOpen, paramsOverride]);

  useEffect(() => {
    if (!didSaveLoadProfile) {
      return undefined;
    }

    const timeout = setTimeout(() => {
      setDidSaveLoadProfile(false);
    }, 1600);

    return () => clearTimeout(timeout);
  }, [didSaveLoadProfile]);

  const resolvedActiveModelId = activeModelId ?? subscribedActiveModelId;
  const configurableModel = getModelById(selectedModelId);
  const configurableModelId = configurableModel?.id ?? selectedModelId;
  const persistedConfigurableModel = configurableModelId ? registry.getModel(configurableModelId) : undefined;
  const heuristicModel = useMemo(
    () => resolveHeuristicModel(configurableModel, persistedConfigurableModel),
    [
      configurableModel,
      persistedConfigurableModel,
    ],
  );
  const modelLabel = modelLabelOverride
    ?? configurableModel?.name
    ?? (configurableModelId?.split('/').pop() ?? configurableModelId ?? '');
  const currentParams = paramsOverride ?? getGenerationParametersForModel(configurableModelId);
  const defaultParams = defaultParamsOverride ?? getGenerationParametersForModel(null);
  const reasoningCapability = useMemo(() => resolveModelReasoningCapability(
    heuristicModel,
    configurableModelId,
    modelLabel,
  ), [configurableModelId, heuristicModel, modelLabel]);
  const effectiveCurrentParams = useMemo(
    () => normalizeReasoningPreference(currentParams, reasoningCapability),
    [currentParams, reasoningCapability],
  );
  const effectiveDefaultParams = useMemo(
    () => normalizeReasoningPreference(defaultParams, reasoningCapability),
    [defaultParams, reasoningCapability],
  );
  const currentLoadParams = getModelLoadParametersForModel(configurableModelId);
  const defaultLoadParams = getModelLoadParametersForModel(null);
  const currentContextSize = currentLoadParams.contextSize;
  const currentGpuLayers = currentLoadParams.gpuLayers;
  const currentKvCacheType = currentLoadParams.kvCacheType;
  const heuristicModelSize = heuristicModel?.size;
  const heuristicModelMaxContextTokens = heuristicModel?.maxContextTokens;
  const heuristicModelMetadataTrust = heuristicModel?.metadataTrust;
  const heuristicModelGgufMetadata = heuristicModel?.gguf;
  const stableCapability = heuristicModel
    ? resolveModelCapabilitySnapshot(heuristicModel)
    : null;
  const stableGpuLayersCeiling = stableCapability?.snapshot.gpuLayersCeiling ?? UNKNOWN_MODEL_GPU_LAYERS_CEILING;
  const isLoadedProfileActive = Boolean(
    configurableModelId
    && engineState.status === EngineStatus.READY
    && engineState.activeModelId === configurableModelId,
  );
  const loadedContextSize = isLoadedProfileActive ? llmEngineService.getContextSize() : null;
  const loadedGpuLayers = isLoadedProfileActive ? llmEngineService.getLoadedGpuLayers() : null;
  const safeModeLoadLimits = isLoadedProfileActive ? llmEngineService.getSafeModeLoadLimits() : null;
  const engineDiagnostics = isLoadedProfileActive ? engineState.diagnostics ?? null : null;
  const baseContextWindowCeiling = useMemo(() => resolveModelContextWindowCeiling({
    modelSizeBytes: heuristicModelSize,
    modelMaxContextTokens: heuristicModelMaxContextTokens,
    modelMetadataTrust: heuristicModelMetadataTrust,
    modelGgufMetadata: heuristicModelGgufMetadata,
    totalMemoryBytes: deviceTotalMemoryBytes,
    contextSize: currentContextSize,
    gpuLayers: currentGpuLayers,
    kvCacheType: currentKvCacheType,
    fallbackGpuLayers: recommendedGpuLayers,
  }), [
    heuristicModelGgufMetadata,
    heuristicModelMaxContextTokens,
    heuristicModelMetadataTrust,
    heuristicModelSize,
    currentContextSize,
    currentGpuLayers,
    currentKvCacheType,
    deviceTotalMemoryBytes,
    recommendedGpuLayers,
  ]);
  const contextWindowCeiling = measuredContextWindowCeiling ?? baseContextWindowCeiling;
  const isNpuBackendKnownUnavailable = backendAvailability.npuBackendAvailable === false;
  const normalizeBackendPolicy = useCallback((
    policy: ModelLoadParameters['backendPolicy'] | null | undefined,
  ): ModelLoadParameters['backendPolicy'] | undefined => {
    if (!policy || policy === 'auto') {
      return undefined;
    }

    // Preserve a saved NPU preference while availability is unknown (`null`),
    // and only normalize it away once we know the device can't use it.
    if (policy === 'npu' && isNpuBackendKnownUnavailable) {
      return undefined;
    }

    return policy;
  }, [isNpuBackendKnownUnavailable]);
  const effectiveCurrentLoadParams = {
    contextSize: clampContextWindowTokens(currentLoadParams.contextSize, contextWindowCeiling),
    gpuLayers: currentLoadParams.gpuLayers,
    kvCacheType: currentLoadParams.kvCacheType,
    backendPolicy: normalizeBackendPolicy(currentLoadParams.backendPolicy),
  };
  const effectiveDefaultLoadParams = {
    contextSize: clampContextWindowTokens(defaultLoadParams.contextSize, contextWindowCeiling),
    gpuLayers: defaultLoadParams.gpuLayers,
    kvCacheType: defaultLoadParams.kvCacheType,
    backendPolicy: normalizeBackendPolicy(defaultLoadParams.backendPolicy),
  };
  const normalizedPersistedLoadParams = {
    ...currentLoadParams,
    backendPolicy: normalizeBackendPolicy(currentLoadParams.backendPolicy),
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
  const draftPersistedBackendPolicy = loadDraftSourceRef.current.backendPolicy === 'current'
    ? effectiveCurrentLoadParams.backendPolicy
    : loadDraftSourceRef.current.backendPolicy === 'default'
      ? effectiveDefaultLoadParams.backendPolicy
      : draftLoadParams.backendPolicy;
  const isActiveModel = resolvedActiveModelId != null
    && configurableModelId != null
    && resolvedActiveModelId === configurableModelId;
  const applyAction: 'reload' | 'save' = isActiveModel ? 'reload' : 'save';
  const applyButtonLabel = isActiveModel ? t('models.applyAndReload') : t('models.saveLoadProfile');
  const showApplyReload = Boolean(configurableModelId) && (
    hasPersistedLoadProfileChanges({
      draftContextSize: draftLoadParams.contextSize,
      draftPersistedGpuLayers,
      draftKvCacheType: draftPersistedKvCacheType,
      draftBackendPolicy: draftPersistedBackendPolicy ?? null,
      persistedLoadParams: normalizedPersistedLoadParams,
    })
    || isApplyingModelProfile
  );
  const canRunAutotune = Boolean(configurableModelId)
    && Boolean(persistedConfigurableModel?.localPath)
    && (
      persistedConfigurableModel?.lifecycleStatus === LifecycleStatus.DOWNLOADED
      || persistedConfigurableModel?.lifecycleStatus === LifecycleStatus.ACTIVE
    )
    && engineState.status !== EngineStatus.INITIALIZING
    && !isApplyingModelProfile
    && !isRunningAutotune
    && !showApplyReload;

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
      setRecommendedGpuLayers(0);
      setGpuLayersCeiling(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
      setBackendAvailability({
        gpuBackendAvailable: null,
        npuBackendAvailable: null,
        discoveryUnavailable: null,
      });
      setDidSaveLoadProfile(false);
      setRunningAutotune(false);
      setAutotuneResult(null);
      loadDraftSourceRef.current = {
        contextSize: 'current',
        gpuLayers: 'current',
        kvCacheType: 'current',
        backendPolicy: 'current',
      };
      loadDraftSeedRef.current = null;
      return;
    }

    let isCancelled = false;
    const refreshTargetModel = configurableModelId ? registry.getModel(configurableModelId) : undefined;
    const shouldRefreshModelMetadata = refreshTargetModel?.hasVerifiedContextWindow !== true;

    setMeasuredContextWindowCeiling(null);
    setRecommendedGpuLayers(0);
    setGpuLayersCeiling(stableGpuLayersCeiling);

    const autotuneModelFileSizeBytes = (
      typeof refreshTargetModel?.gguf?.totalBytes === 'number'
      && Number.isFinite(refreshTargetModel.gguf.totalBytes)
      && refreshTargetModel.gguf.totalBytes > 0
    )
      ? Math.round(refreshTargetModel.gguf.totalBytes)
      : (
        refreshTargetModel?.metadataTrust === 'verified_local'
        && typeof refreshTargetModel?.size === 'number'
        && Number.isFinite(refreshTargetModel.size)
        && refreshTargetModel.size > 0
      )
        ? Math.round(refreshTargetModel.size)
        : null;
    const autotuneModelSha256 = typeof refreshTargetModel?.sha256 === 'string' ? refreshTargetModel.sha256 : null;

    setAutotuneResult(configurableModelId
      ? readAutotuneResult({
          modelId: configurableModelId,
          contextSize: currentContextSize,
          kvCacheType: currentKvCacheType,
          modelFileSizeBytes: autotuneModelFileSizeBytes,
          modelSha256: autotuneModelSha256,
        })
      : null);
    llmEngineService.ensurePersistedCapabilitySnapshot(refreshTargetModel);

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

    const backendServiceAny = llmEngineService as unknown as {
      getBackendAvailability?: () => Promise<{ gpuBackendAvailable: boolean | null; npuBackendAvailable: boolean | null; discoveryUnavailable?: boolean }>;
    };
    if (typeof backendServiceAny.getBackendAvailability === 'function') {
      void backendServiceAny.getBackendAvailability()
        .then((availability) => {
          if (!isCancelled) {
            setBackendAvailability({
              gpuBackendAvailable: availability.gpuBackendAvailable,
              npuBackendAvailable: availability.npuBackendAvailable,
              discoveryUnavailable: availability.discoveryUnavailable === true,
            });
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setBackendAvailability({
              gpuBackendAvailable: null,
              npuBackendAvailable: null,
              discoveryUnavailable: true,
            });
          }
        });
    }

    void Promise.all([
      DeviceInfo.getTotalMemory().catch(() => null),
      shouldRefreshModelMetadata && refreshTargetModel
        ? modelCatalogService.refreshModelMetadata(refreshTargetModel).catch(() => refreshTargetModel)
        : Promise.resolve(refreshTargetModel),
    ])
      .then(([totalMemoryBytes, resolvedModel]) => {
        const resolvedGpuLayersCeiling = llmEngineService.ensurePersistedCapabilitySnapshot(resolvedModel)?.gpuLayersCeiling
          ?? stableGpuLayersCeiling;

        if (!isCancelled) {
          setDeviceTotalMemoryBytes(totalMemoryBytes);
          setGpuLayersCeiling(resolvedGpuLayersCeiling);
          setMeasuredContextWindowCeiling(resolveModelContextWindowCeiling({
            modelSizeBytes: resolvedModel?.size,
            modelMaxContextTokens: resolvedModel?.maxContextTokens,
            modelMetadataTrust: resolvedModel?.metadataTrust,
            modelGgufMetadata: resolvedModel?.gguf,
            totalMemoryBytes,
            contextSize: currentContextSize,
            gpuLayers: currentGpuLayers,
            kvCacheType: currentKvCacheType,
            fallbackGpuLayers: 0,
          }));
        }

        const resolvedModelId = resolvedModel?.id ?? configurableModelId ?? null;
        void loadRecommendation(resolvedModelId)
          .then((recommendation) => {
            if (!isCancelled) {
              setRecommendedGpuLayers(recommendation.recommendedGpuLayers);
              setGpuLayersCeiling(recommendation.gpuLayersCeiling);
              setMeasuredContextWindowCeiling(resolveModelContextWindowCeiling({
                modelSizeBytes: resolvedModel?.size,
                modelMaxContextTokens: resolvedModel?.maxContextTokens,
                modelMetadataTrust: resolvedModel?.metadataTrust,
                modelGgufMetadata: resolvedModel?.gguf,
                totalMemoryBytes,
                contextSize: currentContextSize,
                gpuLayers: currentGpuLayers,
                kvCacheType: currentKvCacheType,
                fallbackGpuLayers: recommendation.recommendedGpuLayers,
              }));
            }
          })
          .catch(() => {
            if (!isCancelled) {
              setRecommendedGpuLayers(0);
              setGpuLayersCeiling(resolvedGpuLayersCeiling);
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
    currentContextSize,
    currentGpuLayers,
    currentKvCacheType,
    isOpen,
    stableGpuLayersCeiling,
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
        backendPolicy: 'current',
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
      const nextBackendPolicy = shouldInitializeDraft
        ? effectiveCurrentLoadParams.backendPolicy
        : (
          loadDraftSourceRef.current.backendPolicy === 'current'
            ? effectiveCurrentLoadParams.backendPolicy
            : loadDraftSourceRef.current.backendPolicy === 'default'
              ? effectiveDefaultLoadParams.backendPolicy
              : current.backendPolicy
        );
      const clampedNextGpuLayers = clampGpuLayers(nextGpuLayers, gpuLayersCeiling);

      if (
        current.contextSize === nextContextSize
        && current.gpuLayers === clampedNextGpuLayers
        && current.kvCacheType === nextKvCacheType
        && current.backendPolicy === nextBackendPolicy
      ) {
        return current;
      }

      return {
        contextSize: nextContextSize,
        gpuLayers: clampedNextGpuLayers,
        kvCacheType: nextKvCacheType,
        backendPolicy: nextBackendPolicy,
      };
    });
  }, [
    configurableModelId,
    contextWindowCeiling,
    currentLoadParams.gpuLayers,
    effectiveCurrentLoadParams.contextSize,
    effectiveCurrentLoadParams.kvCacheType,
    effectiveCurrentLoadParams.backendPolicy,
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    effectiveDefaultLoadParams.backendPolicy,
    isOpen,
    gpuLayersCeiling,
    recommendedGpuLayers,
  ]);

  const applyLoadParams = useCallback(async () => {
    if (!configurableModelId) {
      return;
    }

    setDidSaveLoadProfile(false);
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
      const nextBackendPolicy = loadDraftSourceRef.current.backendPolicy === 'current'
        ? effectiveCurrentLoadParams.backendPolicy
        : loadDraftSourceRef.current.backendPolicy === 'default'
          ? effectiveDefaultLoadParams.backendPolicy
          : normalizeBackendPolicy(draftLoadParams.backendPolicy);
      const normalizedNextBackendPolicy = nextBackendPolicy;
      const defaultContextSize = clampContextWindowTokens(
        DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
        contextWindowCeiling,
      );
      const clampedNextGpuLayers = clampGpuLayers(nextGpuLayers, gpuLayersCeiling);
      const isResetToDefaultProfile =
        nextContextSize === defaultContextSize
        // Treat GPU layers as "default" only when we stay on Auto (null), to avoid
        // racing async recommendations and accidentally clearing explicit values.
        && clampedNextGpuLayers === null
        && nextKvCacheType === DEFAULT_MODEL_LOAD_PARAMETERS.kvCacheType
        && normalizedNextBackendPolicy === undefined;

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
          backendPolicy: normalizedNextBackendPolicy,
        });
      }

      if (isActiveModel) {
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
      } else {
        setDidSaveLoadProfile(true);
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
    draftLoadParams.backendPolicy,
    draftLoadParams.contextSize,
    draftLoadParams.gpuLayers,
    draftLoadParams.kvCacheType,
    effectiveCurrentLoadParams.backendPolicy,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    effectiveDefaultLoadParams.backendPolicy,
    onAfterActiveModelReload,
    gpuLayersCeiling,
    isActiveModel,
    showError,
    t,
    normalizeBackendPolicy,
  ]);

  const handleRunAutotune = useCallback(async () => {
    if (!configurableModelId || !canRunAutotune) {
      return;
    }

    setRunningAutotune(true);

    try {
      const result = await inferenceAutotuneService.runBackendAutotune({
        modelId: configurableModelId,
      });
      setAutotuneResult(result);
    } catch (error) {
      showError(applyReloadErrorScope, error);
    } finally {
      setRunningAutotune(false);
    }
  }, [
    applyReloadErrorScope,
    canRunAutotune,
    configurableModelId,
    showError,
  ]);

  const normalizeGenerationPartial = useCallback((partial: Partial<GenerationParameters>) => {
    if (!Object.prototype.hasOwnProperty.call(partial, 'reasoningEnabled')) {
      return partial;
    }

    if (partial.reasoningEnabled === undefined) {
      const { reasoningEnabled: _ignored, ...rest } = partial;
      return rest;
    }

    return {
      ...partial,
      reasoningEnabled: clampReasoningEnabled(partial.reasoningEnabled, reasoningCapability),
    };
  }, [reasoningCapability]);

  const handleChangeParams = useCallback((partial: Partial<GenerationParameters>) => {
    const normalizedPartial = normalizeGenerationPartial(partial);

    if (onChangeParams) {
      onChangeParams(configurableModelId, normalizedPartial);
      return;
    }

    updateGenerationParametersForModel(configurableModelId, normalizedPartial);
  }, [configurableModelId, normalizeGenerationPartial, onChangeParams]);

  const handleChangeLoadParams = useCallback((partial: Partial<ModelLoadParameters>) => {
    setDidSaveLoadProfile(false);
    if (partial.contextSize !== undefined) {
      loadDraftSourceRef.current.contextSize = 'user';
    }
    if (partial.gpuLayers !== undefined) {
      loadDraftSourceRef.current.gpuLayers = 'user';
    }
    if (partial.kvCacheType !== undefined) {
      loadDraftSourceRef.current.kvCacheType = 'user';
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'backendPolicy')) {
      loadDraftSourceRef.current.backendPolicy = 'user';
    }

    setDraftLoadParams((current) => {
      const nextGpuLayers = partial.gpuLayers === undefined
        ? current.gpuLayers
        : clampGpuLayers(partial.gpuLayers, gpuLayersCeiling);
      const nextBackendPolicy = Object.prototype.hasOwnProperty.call(partial, 'backendPolicy')
        ? partial.backendPolicy
        : current.backendPolicy;

      return {
        ...current,
        ...partial,
        gpuLayers: nextGpuLayers,
        contextSize: partial.contextSize === undefined
          ? current.contextSize
          : clampContextWindowTokens(partial.contextSize, contextWindowCeiling),
        backendPolicy: nextBackendPolicy,
      };
    });
  }, [contextWindowCeiling, gpuLayersCeiling]);

  const handleResetParamField = useCallback((field: keyof GenerationParameters) => {
    if (onResetParamField && field !== 'reasoningEnabled') {
      onResetParamField(configurableModelId, field);
      return;
    }

    const resetParams = getGenerationParametersForModel(null);
    const partial = normalizeGenerationPartial({ [field]: resetParams[field] } as Partial<typeof resetParams>);

    if (onChangeParams) {
      onChangeParams(configurableModelId, partial);
      return;
    }

    updateGenerationParametersForModel(configurableModelId, partial);
  }, [configurableModelId, normalizeGenerationPartial, onChangeParams, onResetParamField]);

  const handleResetLoadField = useCallback((field: ModelLoadProfileField) => {
    setDidSaveLoadProfile(false);
    if (field === 'contextSize') {
      loadDraftSourceRef.current.contextSize = 'default';
    } else if (field === 'gpuLayers') {
      loadDraftSourceRef.current.gpuLayers = 'default';
    } else if (field === 'kvCacheType') {
      loadDraftSourceRef.current.kvCacheType = 'default';
    } else {
      loadDraftSourceRef.current.backendPolicy = 'default';
    }

    setDraftLoadParams((current) => {
      if (field === 'contextSize') {
        return {
          ...current,
          contextSize: effectiveDefaultLoadParams.contextSize,
        };
      }

      if (field === 'gpuLayers') {
        return {
          ...current,
          gpuLayers: Math.min(
            gpuLayersCeiling,
            effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers,
          ),
        };
      }

      if (field === 'kvCacheType') {
        return {
          ...current,
          kvCacheType: effectiveDefaultLoadParams.kvCacheType,
        };
      }

      return {
        ...current,
        backendPolicy: effectiveDefaultLoadParams.backendPolicy,
      };
    });
  }, [
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    effectiveDefaultLoadParams.backendPolicy,
    gpuLayersCeiling,
    recommendedGpuLayers,
  ]);

  const handleResetAll = useCallback(() => {
    loadDraftSourceRef.current = {
      contextSize: 'default',
      gpuLayers: 'default',
      kvCacheType: 'default',
      backendPolicy: 'default',
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
      backendPolicy: effectiveDefaultLoadParams.backendPolicy,
    });
  }, [
    configurableModelId,
    effectiveDefaultLoadParams.contextSize,
    effectiveDefaultLoadParams.gpuLayers,
    effectiveDefaultLoadParams.kvCacheType,
    effectiveDefaultLoadParams.backendPolicy,
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
      params: effectiveCurrentParams,
      defaultParams: effectiveDefaultParams,
      supportsReasoning: reasoningCapability.supportsReasoning,
      requiresReasoning: reasoningCapability.requiresReasoning,
      contextWindowCeiling,
      gpuLayersCeiling,
      isSafeModeActive: safeModeLoadLimits !== null,
      loadParamsDraft: draftLoadParams,
      defaultLoadParams: effectiveDefaultLoadParams,
      recommendedGpuLayers,
      isGpuBackendAvailable: backendAvailability.gpuBackendAvailable,
      isNpuBackendAvailable: backendAvailability.npuBackendAvailable,
      isBackendDiscoveryUnavailable: backendAvailability.discoveryUnavailable,
      didSaveLoadProfile,
      applyAction,
      applyButtonLabel,
      canApplyReload: Boolean(configurableModelId) && canApplyReload && !isApplyingModelProfile && !isRunningAutotune,
      isApplyingReload: isApplyingModelProfile,
      showApplyReload,
      showAdvancedInferenceControls,
      canRunAutotune,
      isAutotuneRunning: isRunningAutotune,
      autotuneResult,
      onRunAutotune: handleRunAutotune,
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
