import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ModelCard } from '@/components/ui/ModelCard';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { ScreenCard, ScreenStack } from '@/components/ui/ScreenShell';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { useModelDownload } from '@/hooks/useModelDownload';
import {
  type CatalogServerSort,
  modelCatalogService,
  getModelCatalogErrorMessage,
  getHuggingFaceModelUrl,
} from '@/services/ModelCatalogService';
import { getReportedErrorMessage } from '@/services/AppError';
import { hardwareListenerService } from '@/services/HardwareListenerService';
import { huggingFaceTokenService } from '@/services/HuggingFaceTokenService';
import { llmEngineService } from '@/services/LLMEngineService';
import { registry } from '@/services/LocalStorageRegistry';
import { offloadModel } from '@/services/StorageManagerService';
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
  type ModelLoadParameters,
} from '@/services/SettingsStore';
import {
  useModelsStore,
  MODELS_PAGE_SIZE,
  type ModelFilterCriteria,
  type ModelSortPreference,
} from '@/store/modelsStore';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '@/types/models';
import {
  clampContextWindowTokens,
  resolveContextWindowCeiling,
} from '@/utils/contextWindow';
import { hasPersistedLoadProfileChanges } from '@/utils/modelLoadProfile';
import { ModelsFilter } from './ModelsFilter';
import { type ModelsCatalogTab } from './modelTabs';
import {
  shouldBootstrapCatalogSession,
  shouldResetCatalogForTokenEvent,
} from './modelsListSession';
import { useTranslation } from 'react-i18next';

interface ModelsListProps {
  activeTab: ModelsCatalogTab;
  searchQuery: string;
  searchSessionKey?: number | string;
}

type FetchState = {
  warningMessage: string | null;
  loadMoreError: string | null;
};

function resolveServerSort(sort: ModelSortPreference): CatalogServerSort | null {
  if (sort.field === 'downloads') {
    return 'downloads';
  }

  if (sort.field === 'likes') {
    return 'likes';
  }

  return null;
}

function getStatusWeight(status: LifecycleStatus): number {
  if (status === LifecycleStatus.ACTIVE) return 3;
  if (status === LifecycleStatus.DOWNLOADED) return 2;
  if (status === LifecycleStatus.DOWNLOADING || status === LifecycleStatus.QUEUED) return 1;
  return 0;
}

function matchesActiveTab(model: ModelMetadata, activeTab: ModelsListProps['activeTab']) {
  // "Downloaded" tab should never show remote-only (available) entries.
  if (activeTab === 'downloaded' && model.lifecycleStatus === LifecycleStatus.AVAILABLE) {
    return false;
  }

  return true;
}

function matchesSize(model: ModelMetadata, filters: ModelFilterCriteria): boolean {
  if (filters.sizeRanges.length === 0) {
    return true;
  }

  if (model.size === null) {
    return false;
  }

  const sizeInGb = model.size / (1024 * 1024 * 1024);
  return filters.sizeRanges.some((sizeRange) => {
    if (sizeRange === 'small') return sizeInGb < 2;
    if (sizeRange === 'medium') return sizeInGb >= 2 && sizeInGb <= 5;
    return sizeInGb > 5;
  });
}

function matchesTokenRequirement(model: ModelMetadata, filters: ModelFilterCriteria): boolean {
  if (!filters.noTokenRequiredOnly) {
    return true;
  }

  return (
    model.accessState === ModelAccessState.PUBLIC
    && model.isGated === false
    && model.isPrivate === false
  );
}

function sortModels(models: ModelMetadata[], sort: ModelSortPreference): ModelMetadata[] {
  return [...models].sort((left, right) => {
    if (sort.field === 'size') {
      const leftSize = left.size ?? Number.MAX_SAFE_INTEGER;
      const rightSize = right.size ?? Number.MAX_SAFE_INTEGER;
      return sort.direction === 'asc' ? leftSize - rightSize : rightSize - leftSize;
    }

    if (sort.field === 'downloaded') {
      return getStatusWeight(right.lifecycleStatus) - getStatusWeight(left.lifecycleStatus);
    }

    if (sort.field === 'downloads') {
      return (right.downloads ?? -1) - (left.downloads ?? -1);
    }

    if (sort.field === 'likes') {
      return (right.likes ?? -1) - (left.likes ?? -1);
    }

    return sort.direction === 'asc'
      ? left.name.localeCompare(right.name)
      : right.name.localeCompare(left.name);
  });
}

function mergeUniqueModelsById(models: ModelMetadata[]): ModelMetadata[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }

    seen.add(model.id);
    return true;
  });
}

export const ModelsList = ({ activeTab, searchQuery, searchSessionKey }: ModelsListProps) => {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const router = useRouter();
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [tokenRevision, setTokenRevision] = useState(0);
  const [isTokenStateHydrated, setIsTokenStateHydrated] = useState(false);
  const [isModelParametersOpen, setModelParametersOpen] = useState(false);
  const [modelParametersModelId, setModelParametersModelId] = useState<string | null>(null);
  const [settings, setSettings] = useState(() => getSettings());
  const [recommendedGpuLayers, setRecommendedGpuLayers] = useState(0);
  const [measuredContextWindowCeiling, setMeasuredContextWindowCeiling] = useState<number | null>(null);
  const [draftLoadParams, setDraftLoadParams] = useState<ModelLoadParameters>({
    contextSize: DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
    gpuLayers: 0,
  });
  const [isApplyingModelProfile, setApplyingModelProfile] = useState(false);
  const [hasTokenConfigured, setHasTokenConfigured] = useState(
    () => huggingFaceTokenService.getCachedState().hasToken,
  );
  const [manualRefreshRevision, setManualRefreshRevision] = useState(0);
  const [{ warningMessage, loadMoreError }, setFetchState] = useState<FetchState>({
    warningMessage: null,
    loadMoreError: null,
  });
  const latestFetchIdRef = useRef(0);
  const appendInFlightRef = useRef(false);
  const lastAutoLoadCursorRef = useRef<string | null>(null);
  const hasUserScrolledCatalogRef = useRef(false);
  const loadDraftSourceRef = useRef<{
    contextSize: 'current' | 'default' | 'user';
    gpuLayers: 'current' | 'default' | 'user';
  }>({
    contextSize: 'current',
    gpuLayers: 'current',
  });
  const loadDraftSeedRef = useRef<string | null>(null);

  const { startDownload, cancelDownload, queue } = useModelDownload();
  const { loadModel, unloadModel, state: engineState } = useLLMEngine();
  const {
    filters,
    sort,
    discoveryMode,
    applyDiscoveryPreset,
    syncDiscoveryTokenState,
    showFullCatalog,
    setFitsInRamOnly,
    setNoTokenRequiredOnly,
    toggleSizeRange,
    setSort,
    clearFilters,
  } = useModelsStore();
  const serverSort = useMemo(() => resolveServerSort(sort), [sort]);
  const effectiveSearchSessionKey = searchSessionKey ?? searchQuery;
  const sizeRangesSessionKey = useMemo(
    () => [...filters.sizeRanges].sort().join('|'),
    [filters.sizeRanges],
  );
  const sessionIdentity = useMemo(() => ([
    activeTab,
    String(effectiveSearchSessionKey),
    filters.fitsInRamOnly ? 'fits' : 'any',
    filters.noTokenRequiredOnly ? 'public-only' : 'any-token',
    sizeRangesSessionKey,
    `${sort.field}:${sort.direction}`,
    `token:${tokenRevision}`,
    `refresh:${manualRefreshRevision}`,
  ].join('::')), [
    activeTab,
    effectiveSearchSessionKey,
    filters.fitsInRamOnly,
    filters.noTokenRequiredOnly,
    manualRefreshRevision,
    sizeRangesSessionKey,
    sort.direction,
    sort.field,
    tokenRevision,
  ]);

  const refreshDownloadedModels = useCallback(() => {
    if (activeTab === 'downloaded') {
      modelCatalogService.getLocalModels().then(setModels);
    }
  }, [activeTab]);

  useEffect(() => {
    return subscribeSettings((nextSettings) => {
      setSettings(nextSettings);
    });
  }, []);

  const fetchModels = useCallback(
    async (
      query: string,
      cursor: string | null,
      append: boolean,
      preserveExistingResults: boolean = false,
    ) => {
      const fetchId = latestFetchIdRef.current + 1;
      latestFetchIdRef.current = fetchId;

      if (append) {
        appendInFlightRef.current = true;
        setIsFetchingMore(true);
        setFetchState((current) => ({ ...current, loadMoreError: null }));
      } else {
        appendInFlightRef.current = false;
        setLoading(true);
        setIsFetchingMore(false);
        setFetchState((current) => ({ ...current, warningMessage: null, loadMoreError: null }));
        if (!preserveExistingResults) {
          setHasMore(true);
          setNextCursor(null);
          setModels([]);
        }
      }

      try {
        const result = await modelCatalogService.searchModels(query, {
          cursor,
          pageSize: MODELS_PAGE_SIZE,
          sort: serverSort,
        });

        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
        setModels((current) => (
          append
            ? mergeUniqueModelsById([...current, ...result.models])
            : result.models
        ));
        setFetchState({
          warningMessage: result.warning ? getModelCatalogErrorMessage(result.warning) : null,
          loadMoreError: null,
        });
      } catch (error) {
        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        const message = getModelCatalogErrorMessage(error);

        if (append) {
          setFetchState((current) => ({ ...current, loadMoreError: message }));
        } else {
          if (!preserveExistingResults) {
            setModels([]);
            setHasMore(false);
            setNextCursor(null);
          }
          setFetchState({ warningMessage: message, loadMoreError: null });
        }
      } finally {
        if (append) {
          appendInFlightRef.current = false;
          if (fetchId === latestFetchIdRef.current) {
            setIsFetchingMore(false);
          }
        } else {
          if (fetchId === latestFetchIdRef.current) {
            setLoading(false);
          }
        }
      }
    },
    [serverSort],
  );

  useEffect(() => {
    return huggingFaceTokenService.subscribe((state, source) => {
      setHasTokenConfigured(state.hasToken);
      if (source === 'hydrate' || source === 'mutation') {
        setIsTokenStateHydrated(true);
      }

      if (shouldResetCatalogForTokenEvent(source)) {
        setTokenRevision((current) => current + 1);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void huggingFaceTokenService.refreshState()
      .then((state) => {
        if (cancelled) {
          return;
        }

        setHasTokenConfigured(state.hasToken);
        setIsTokenStateHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          setIsTokenStateHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'all' || !isTokenStateHydrated) {
      return;
    }

    if (discoveryMode === 'uninitialized') {
      applyDiscoveryPreset({ hasToken: hasTokenConfigured });
      return;
    }

    syncDiscoveryTokenState(hasTokenConfigured);
  }, [
    activeTab,
    applyDiscoveryPreset,
    discoveryMode,
    hasTokenConfigured,
    isTokenStateHydrated,
    syncDiscoveryTokenState,
  ]);

  useEffect(() => {
    if (!shouldBootstrapCatalogSession(activeTab, discoveryMode, isTokenStateHydrated)) {
      return;
    }

    latestFetchIdRef.current += 1;
    appendInFlightRef.current = false;
    lastAutoLoadCursorRef.current = null;
    hasUserScrolledCatalogRef.current = false;
    setModels([]);
    setHasMore(activeTab === 'all');
    setNextCursor(null);
    setLoading(false);
    setIsFetchingMore(false);
    setFetchState({ warningMessage: null, loadMoreError: null });

    if (activeTab === 'all') {
      const cachedResult = modelCatalogService.getCachedSearchResult(searchQuery, {
        cursor: null,
        pageSize: MODELS_PAGE_SIZE,
        sort: serverSort,
      });

      if (cachedResult) {
        setModels(cachedResult.models);
        setHasMore(cachedResult.hasMore);
        setNextCursor(cachedResult.nextCursor);
      }

      const timer = setTimeout(() => {
        void fetchModels(searchQuery, null, false, Boolean(cachedResult));
      }, cachedResult ? 0 : 400);
      return () => clearTimeout(timer);
    }

    const fetchId = latestFetchIdRef.current + 1;
    latestFetchIdRef.current = fetchId;
    modelCatalogService.getLocalModels().then((localModels) => {
      if (fetchId !== latestFetchIdRef.current) {
        return;
      }

      setModels(localModels);
      setHasMore(false);
    });
  }, [activeTab, discoveryMode, fetchModels, isTokenStateHydrated, searchQuery, serverSort, sessionIdentity]);

  const displayModels = useMemo(() => {
    const registryModels = typeof registry.getModels === 'function'
      ? registry.getModels()
      : [];
    const localModelsById = new Map(
      registryModels.map((localModel) => [localModel.id, localModel] as const),
    );

    return models.map((model) => {
      let finalModel = { ...model };
      const localModel = localModelsById.get(model.id);

      if (localModel) {
        finalModel = {
          ...finalModel,
          size: finalModel.size ?? localModel.size,
          hfRevision: finalModel.hfRevision ?? localModel.hfRevision,
          resolvedFileName: finalModel.resolvedFileName ?? localModel.resolvedFileName,
          localPath: localModel.localPath,
          downloadedAt: localModel.downloadedAt,
          sha256: finalModel.sha256 ?? localModel.sha256,
          fitsInRam: finalModel.fitsInRam ?? localModel.fitsInRam,
          accessState: finalModel.accessState,
          isGated: finalModel.isGated,
          isPrivate: finalModel.isPrivate,
          lifecycleStatus: localModel.lifecycleStatus,
          downloadProgress: localModel.downloadProgress,
          resumeData: localModel.resumeData,
          maxContextTokens: finalModel.maxContextTokens ?? localModel.maxContextTokens,
          modelType: finalModel.modelType ?? localModel.modelType,
          architectures: finalModel.architectures ?? localModel.architectures,
          downloads: finalModel.downloads ?? localModel.downloads,
          likes: finalModel.likes ?? localModel.likes,
          tags: finalModel.tags ?? localModel.tags,
          description: finalModel.description ?? localModel.description,
        };
      }

      if (engineState.activeModelId === finalModel.id) {
        finalModel.lifecycleStatus = LifecycleStatus.ACTIVE;
      } else if (finalModel.lifecycleStatus === LifecycleStatus.ACTIVE) {
        finalModel.lifecycleStatus = LifecycleStatus.DOWNLOADED;
      }

      const queuedItem = queue.find((item) => item.id === finalModel.id);
      if (queuedItem) {
        finalModel = {
          ...finalModel,
          size: finalModel.size ?? queuedItem.size,
          hfRevision: finalModel.hfRevision ?? queuedItem.hfRevision,
          resolvedFileName: finalModel.resolvedFileName ?? queuedItem.resolvedFileName,
          localPath: queuedItem.localPath ?? finalModel.localPath,
          downloadedAt: queuedItem.downloadedAt ?? finalModel.downloadedAt,
          sha256: finalModel.sha256 ?? queuedItem.sha256,
          fitsInRam: finalModel.fitsInRam ?? queuedItem.fitsInRam,
          lifecycleStatus: queuedItem.lifecycleStatus,
          downloadProgress: queuedItem.downloadProgress,
          resumeData: queuedItem.resumeData,
        };
      }

      return finalModel;
    });
  }, [engineState.activeModelId, models, queue]);

  const filteredModels = useMemo(() => {
    const filtered = displayModels.filter((model) => {
      if (filters.fitsInRamOnly && !model.fitsInRam) {
        return false;
      }

      if (!matchesActiveTab(model, activeTab)) {
        return false;
      }

      if (!matchesTokenRequirement(model, filters)) {
        return false;
      }

      if (!matchesSize(model, filters)) {
        return false;
      }

      return true;
    });

    return sortModels(filtered, sort);
  }, [activeTab, displayModels, filters, sort]);

  const configurableModel = useMemo(() => {
    if (!modelParametersModelId) {
      return undefined;
    }

    return displayModels.find((model) => model.id === modelParametersModelId)
      ?? registry.getModel(modelParametersModelId);
  }, [displayModels, modelParametersModelId]);
  const configurableModelId = configurableModel?.id ?? modelParametersModelId;
  const configurableModelAccessState = configurableModel?.accessState;
  const configurableModelIsGated = configurableModel?.isGated === true;
  const configurableModelIsPrivate = configurableModel?.isPrivate === true;
  const configurableModelHasVerifiedContextWindow = configurableModel?.hasVerifiedContextWindow === true;
  const configurableModelMaxContextTokens = configurableModel?.maxContextTokens;
  const configurableModelSize = configurableModel?.size ?? null;
  const modelParametersLabel = configurableModel?.name
    ?? (configurableModelId?.split('/').pop() ?? configurableModelId ?? '');
  const currentParams = getGenerationParametersForModel(configurableModelId);
  const defaultParams = getGenerationParametersForModel(null);
  const currentLoadParams = getModelLoadParametersForModel(configurableModelId);
  const defaultLoadParams = getModelLoadParametersForModel(null);
  const baseContextWindowCeiling = useMemo(() => resolveContextWindowCeiling({
    modelMaxContextTokens: configurableModelMaxContextTokens,
    modelSizeBytes: configurableModelSize,
  }), [configurableModelMaxContextTokens, configurableModelSize]);
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
  const modelParametersApplyButtonLabel = settings.activeModelId === configurableModelId
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
  const canApplyReload = Boolean(configurableModelId) && !isApplyingModelProfile;

  const showModelActionError = useCallback((scope: string, error: unknown) => {
    Alert.alert(t('models.actionFailedTitle'), getReportedErrorMessage(scope, error, t));
  }, [t]);

  const openTokenSettings = useCallback(() => {
    router.push('/huggingface-token' as any);
  }, [router]);

  const openModelPage = useCallback(async (modelId: string) => {
    try {
      await Linking.openURL(getHuggingFaceModelUrl(modelId));
    } catch (error) {
      showModelActionError('ModelsList.openModelPage', error);
    }
  }, [showModelActionError]);

  const openModelDetails = useCallback((modelId: string) => {
    router.push({
      pathname: '/model-details',
      params: { modelId },
    } as any);
  }, [router]);

  const handleDownload = useCallback((model: ModelMetadata) => {
    const startPreparedDownload = async () => {
      try {
        if (model.accessState === ModelAccessState.AUTH_REQUIRED) {
          openTokenSettings();
          return;
        }

        if (model.accessState === ModelAccessState.ACCESS_DENIED) {
          await openModelPage(model.id);
          return;
        }

        const resolvedModel = model.size === null
          ? await modelCatalogService.refreshModelMetadata(model)
          : model;

        if (resolvedModel.accessState === ModelAccessState.AUTH_REQUIRED) {
          openTokenSettings();
          return;
        }

        if (resolvedModel.accessState === ModelAccessState.ACCESS_DENIED) {
          await openModelPage(resolvedModel.id);
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
        showModelActionError('ModelsList.handleDownload', error);
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
  }, [openModelPage, openTokenSettings, showModelActionError, startDownload, t]);

  const performLoad = useCallback(async (modelId: string) => {
    try {
      await loadModel(modelId);
      refreshDownloadedModels();
    } catch (error) {
      showModelActionError('ModelsList.performLoad', error);
    }
  }, [loadModel, refreshDownloadedModels, showModelActionError]);

  const handleLoad = useCallback(async (modelId: string) => {
    const model = models.find((item) => item.id === modelId);
    if (model && model.fitsInRam === false) {
      Alert.alert(
        t('models.memoryWarningTitle'),
        t('models.memoryWarningMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('models.loadAnyway'),
            onPress: async () => {
              await performLoad(modelId);
            },
          },
        ],
      );
      return;
    }

    await performLoad(modelId);
  }, [models, performLoad, t]);

  const handleUnload = useCallback(async () => {
    try {
      await unloadModel();
      refreshDownloadedModels();
    } catch (error) {
      showModelActionError('ModelsList.handleUnload', error);
    }
  }, [refreshDownloadedModels, showModelActionError, unloadModel]);

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
                setManualRefreshRevision((current) => current + 1);
              } else {
                refreshDownloadedModels();
              }
            } catch (error) {
              showModelActionError('ModelsList.handleDelete.keepSettings', error);
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
                setManualRefreshRevision((current) => current + 1);
              } else {
                refreshDownloadedModels();
              }
            } catch (error) {
              showModelActionError('ModelsList.handleDelete.resetSettings', error);
            }
          },
        },
      ],
    );
  }, [activeTab, refreshDownloadedModels, showModelActionError, t]);

  const handleOpenModelSettings = useCallback((modelId: string) => {
    setModelParametersModelId(modelId);
    setModelParametersOpen(true);
  }, []);

  useEffect(() => {
    if (!isModelParametersOpen) {
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
  }, [
    configurableModelAccessState,
    configurableModelHasVerifiedContextWindow,
    configurableModelId,
    configurableModelIsGated,
    configurableModelIsPrivate,
    configurableModelMaxContextTokens,
    configurableModelSize,
    isModelParametersOpen,
  ]);

  useEffect(() => {
    if (!isModelParametersOpen) {
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
    isModelParametersOpen,
    recommendedGpuLayers,
  ]);

  const handleApplyLoadParams = useCallback(async () => {
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

      if (settings.activeModelId === configurableModelId) {
        await llmEngineService.load(configurableModelId, { forceReload: true });
        refreshDownloadedModels();
      }
    } catch (error) {
      showModelActionError('ModelsList.handleApplyLoadParams', error);
    } finally {
      setApplyingModelProfile(false);
    }
  }, [
    configurableModelId,
    contextWindowCeiling,
    currentLoadParams.gpuLayers,
    draftLoadParams.contextSize,
    draftLoadParams.gpuLayers,
    effectiveDefaultLoadParams.gpuLayers,
    recommendedGpuLayers,
    refreshDownloadedModels,
    settings.activeModelId,
    showModelActionError,
  ]);

  const handleLoadMore = useCallback((source: 'auto' | 'manual' = 'manual') => {
    if (
      activeTab !== 'all' ||
      !hasMore ||
      !nextCursor ||
      loading ||
      isFetchingMore ||
      appendInFlightRef.current
    ) {
      return;
    }

    if (source === 'auto') {
      if (
        !hasUserScrolledCatalogRef.current ||
        loadMoreError ||
        lastAutoLoadCursorRef.current === nextCursor
      ) {
        return;
      }

      lastAutoLoadCursorRef.current = nextCursor;
    }

    void fetchModels(searchQuery, nextCursor, true);
  }, [activeTab, fetchModels, hasMore, isFetchingMore, loadMoreError, loading, nextCursor, searchQuery]);

  const handleCatalogScroll = useCallback((event: any) => {
    const offsetY = event?.nativeEvent?.contentOffset?.y;
    if (typeof offsetY === 'number' && offsetY > 0) {
      hasUserScrolledCatalogRef.current = true;
    }
  }, []);

  const hasFilters =
    filters.fitsInRamOnly
    || filters.noTokenRequiredOnly
    || filters.sizeRanges.length > 0;

  const emptyState = useMemo(() => (
    <Box className="flex-1 items-center px-6 pb-8 pt-12">
      <Text className="text-center text-base font-semibold text-typography-700 dark:text-typography-200">
        {t('models.noResults', 'No models found')}
      </Text>
      <Text className="mt-2 text-center text-sm text-typography-500 dark:text-typography-400">
        {hasFilters
          ? t('models.emptyFiltered')
          : t('models.emptySearchHint')}
      </Text>
      {hasFilters ? (
        <Button size="sm" className="mt-4" onPress={clearFilters}>
          <ButtonText>{t('models.clearFilters')}</ButtonText>
        </Button>
      ) : null}
    </Box>
  ), [clearFilters, hasFilters, t]);

  const discoveryBanner = useMemo(() => {
    if (activeTab !== 'all' || discoveryMode !== 'guided') {
      return null;
    }

    return (
      <ScreenCard padding="compact" tone="accent">
        <Text className="text-sm font-semibold text-primary-700 dark:text-primary-300">
          {t('models.guidedDiscoveryTitle')}
        </Text>
        <Text className="mt-1 text-sm leading-5 text-primary-700/90 dark:text-primary-200">
          {hasTokenConfigured
            ? t('models.guidedDiscoveryWithToken')
            : t('models.guidedDiscoveryWithoutToken')}
        </Text>
        <Button action="secondary" size="sm" className="mt-2 self-start" onPress={showFullCatalog}>
          <ButtonText className="text-typography-900 dark:text-typography-100">
            {t('models.showFullCatalog')}
          </ButtonText>
        </Button>
      </ScreenCard>
    );
  }, [activeTab, discoveryMode, hasTokenConfigured, showFullCatalog, t]);

  const footer = useMemo(() => (activeTab === 'all' ? (
    <Box className="pb-4 pt-1">
      {loadMoreError ? (
        <Box className="mb-2.5 rounded-2xl border border-error-300 bg-background-error px-3 py-2.5 dark:border-error-800">
          <Text className="text-sm text-error-700 dark:text-error-300">{loadMoreError}</Text>
        </Box>
      ) : null}

      {hasMore && nextCursor ? (
        <Button action="secondary" size="sm" onPress={() => handleLoadMore('manual')} disabled={isFetchingMore}>
          <ButtonText className="text-typography-900 dark:text-typography-100">
            {isFetchingMore
              ? t('common.loading')
              : loadMoreError
                ? t('common.retry', 'Retry')
                : t('common.more')}
          </ButtonText>
        </Button>
      ) : filteredModels.length > 0 ? (
        <Text className="text-center text-xs text-typography-400 dark:text-typography-500">
          {t('models.catalogEnd')}
        </Text>
      ) : null}
    </Box>
  ) : null), [activeTab, filteredModels.length, handleLoadMore, hasMore, isFetchingMore, loadMoreError, nextCursor, t]);

  const renderModelItem = useCallback<ListRenderItem<ModelMetadata>>(({ item }) => (
    <ModelCard
      model={item}
      onOpenDetails={openModelDetails}
      onDownload={handleDownload}
      onConfigureToken={openTokenSettings}
      onOpenModelPage={openModelPage}
      onLoad={handleLoad}
      onOpenSettings={handleOpenModelSettings}
      onUnload={handleUnload}
      onDelete={handleDelete}
      onCancel={cancelDownload}
      onChat={() => router.push('/chat')}
      isActive={engineState.activeModelId === item.id}
    />
  ), [cancelDownload, engineState.activeModelId, handleDelete, handleDownload, handleLoad, handleOpenModelSettings, handleUnload, openModelDetails, openModelPage, openTokenSettings, router]);

  const renderItemSeparator = useCallback(() => <Box className="h-2.5" />, []);
  const renderEmptyState = useCallback(() => emptyState, [emptyState]);
  const renderFooter = useCallback(() => footer, [footer]);
  const isCatalogInitializing = activeTab === 'all' && !isTokenStateHydrated;

  return (
    <>
      <ModelsFilter
        filters={filters}
        sort={sort}
        onFitsInRamToggle={setFitsInRamOnly}
        onNoTokenRequiredToggle={setNoTokenRequiredOnly}
        onSizeRangeToggle={toggleSizeRange}
        onSortChange={setSort}
        onClear={clearFilters}
      />

      <ScreenStack className="flex-1 pt-2" gap="compact">
        {discoveryBanner}

        {warningMessage ? (
          <ScreenCard padding="compact" tone="warning">
            <Text className="text-sm text-warning-700 dark:text-warning-300">{warningMessage}</Text>
          </ScreenCard>
        ) : null}

        {(isCatalogInitializing || (loading && models.length === 0)) ? (
          <Box className="flex-1 items-center justify-start pt-10">
            <Spinner size="large" />
            <Text className="mt-2 text-typography-500">{t('models.searching', 'Searching Hugging Face...')}</Text>
          </Box>
        ) : (
          <FlashList
            data={filteredModels}
            keyExtractor={(item) => item.id}
            renderItem={renderModelItem}
            ItemSeparatorComponent={renderItemSeparator}
            ListEmptyComponent={renderEmptyState}
            ListFooterComponent={renderFooter}
            contentContainerStyle={{ flexGrow: 1, paddingBottom: tabBarHeight + 12 }}
            onScroll={handleCatalogScroll}
            onEndReached={() => handleLoadMore('auto')}
            onEndReachedThreshold={0.6}
            showsVerticalScrollIndicator={false}
          />
        )}
      </ScreenStack>

      {engineState.status === EngineStatus.INITIALIZING ? (
        <Box className="absolute bottom-0 left-0 right-0 flex-row items-center justify-center bg-primary-500 p-2">
          <Spinner className="mr-2 text-white" />
          <Text className="font-bold text-white">
            {t('chat.warmingUp')}{' '}
            {Math.round(
              engineState.loadProgress > 1
                ? engineState.loadProgress
                : engineState.loadProgress * 100,
            )}
            %
          </Text>
        </Box>
      ) : null}

      <ModelParametersSheet
        visible={isModelParametersOpen}
        modelId={configurableModelId}
        modelLabel={modelParametersLabel}
        params={currentParams}
        defaultParams={defaultParams}
        contextWindowCeiling={contextWindowCeiling}
        loadParamsDraft={draftLoadParams}
        defaultLoadParams={effectiveDefaultLoadParams}
        recommendedGpuLayers={recommendedGpuLayers}
        applyButtonLabel={modelParametersApplyButtonLabel}
        canApplyReload={canApplyReload}
        isApplyingReload={isApplyingModelProfile}
        showApplyReload={showApplyReload}
        onClose={() => {
          setModelParametersOpen(false);
        }}
        onChangeParams={(partial) => {
          updateGenerationParametersForModel(configurableModelId, partial);
        }}
        onChangeLoadParams={(partial) => {
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
        }}
        onResetParamField={(field) => {
          const resetParams = getGenerationParametersForModel(null);
          const partial = { [field]: resetParams[field] } as Partial<typeof resetParams>;
          updateGenerationParametersForModel(configurableModelId, partial);
        }}
        onResetLoadField={(field) => {
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
        }}
        onReset={() => {
          loadDraftSourceRef.current = {
            contextSize: 'default',
            gpuLayers: 'default',
          };
          resetGenerationParametersForModel(configurableModelId);
          setDraftLoadParams({
            contextSize: effectiveDefaultLoadParams.contextSize,
            gpuLayers: effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers,
          });
        }}
        onApplyReload={handleApplyLoadParams}
      />
    </>
  );
};
