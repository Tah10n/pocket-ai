import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';
import { ModelCard } from '@/components/ui/ModelCard';
import { ModelWarmupBanner } from '@/components/ui/ModelWarmupBanner';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { ScreenCard, ScreenStack } from '@/components/ui/ScreenShell';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useErrorReportSheetController, type ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import type { LoadModelOptions } from '@/services/LLMEngineService';
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
import { useModelDownload } from '@/hooks/useModelDownload';
import {
  type CatalogServerSort,
  modelCatalogService,
  getModelCatalogErrorMessage,
  getHuggingFaceModelUrl,
} from '@/services/ModelCatalogService';
import { getReportedErrorMessage, toAppError } from '@/services/AppError';
import { huggingFaceTokenService } from '@/services/HuggingFaceTokenService';
import { registry } from '@/services/LocalStorageRegistry';
import { llmEngineService } from '@/services/LLMEngineService';
import { offloadModel } from '@/services/StorageManagerService';
import { performanceMonitor } from '@/services/PerformanceMonitor';
import {
  useModelsStore,
  MODELS_PAGE_SIZE,
  type ModelFilterCriteria,
  type ModelSortPreference,
} from '@/store/modelsStore';
import { useDownloadStore } from '@/store/downloadStore';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '@/types/models';
import { mergeModelWithRuntimeState } from '@/utils/modelRuntimeState';
import { startModelDownloadFlow } from '@/utils/modelDownloadFlow';
import { DECIMAL_GIGABYTE } from '@/utils/modelSize';
import { screenLayoutMetrics } from '@/utils/themeTokens';
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

interface ModelCardWithRuntimeStateProps {
  model: ModelMetadata;
  activeModelId: string | null | undefined;
  onOpenDetails: (modelId: string) => void;
  onDownload: (model: ModelMetadata) => void;
  onConfigureToken: () => void;
  onOpenModelPage: (modelId: string) => void;
  onLoad: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onUnload: () => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
  onChat: () => void;
}

const ModelCardWithRuntimeState = React.memo(({
  model,
  activeModelId,
  onOpenDetails,
  onDownload,
  onConfigureToken,
  onOpenModelPage,
  onLoad,
  onOpenSettings,
  onUnload,
  onDelete,
  onCancel,
  onChat,
}: ModelCardWithRuntimeStateProps) => {
  const queuedItem = useDownloadStore((state) => state.queue.find((item) => item.id === model.id));
  const localModel = registry.getModel(model.id);

  const displayModel = mergeModelWithRuntimeState(model, {
    activeModelId: activeModelId ?? undefined,
    localModel,
    queuedItem: queuedItem?.id === model.id ? queuedItem : undefined,
  });

  return (
    <ModelCard
      model={displayModel}
      onOpenDetails={onOpenDetails}
      onDownload={onDownload}
      onConfigureToken={onConfigureToken}
      onOpenModelPage={onOpenModelPage}
      onLoad={onLoad}
      onOpenSettings={onOpenSettings}
      onUnload={onUnload}
      onDelete={onDelete}
      onCancel={onCancel}
      onChat={onChat}
      isActive={activeModelId === model.id}
    />
  );
});

ModelCardWithRuntimeState.displayName = 'ModelCardWithRuntimeState';

function resolveServerSort(sort: ModelSortPreference): CatalogServerSort | null {
  if (sort.field === 'downloads') {
    return 'downloads';
  }

  if (sort.field === 'likes') {
    return 'likes';
  }

  if (sort.field === 'lastModified') {
    return 'lastModified';
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

  const sizeInGb = model.size / DECIMAL_GIGABYTE;
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
    if (sort.field === 'downloaded') {
      return getStatusWeight(right.lifecycleStatus) - getStatusWeight(left.lifecycleStatus);
    }

    if (sort.field === 'downloads') {
      return (right.downloads ?? -1) - (left.downloads ?? -1);
    }

    if (sort.field === 'likes') {
      return (right.likes ?? -1) - (left.likes ?? -1);
    }

    if (sort.field === 'lastModified') {
      const leftModifiedAt = left.lastModifiedAt ?? left.downloadedAt ?? -1;
      const rightModifiedAt = right.lastModifiedAt ?? right.downloadedAt ?? -1;
      return rightModifiedAt - leftModifiedAt;
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
  const router = useRouter();
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [tokenRevision, setTokenRevision] = useState(0);
  const [isTokenStateHydrated, setIsTokenStateHydrated] = useState(false);
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
  const autoFillAttemptsRef = useRef(0);
  const hasUserScrolledCatalogRef = useRef(false);
  const catalogFirstResultsShownSessionRef = useRef<string | null>(null);
  const { startDownload, cancelDownload } = useModelDownload();
  const queueLifecycleSignature = useDownloadStore((state) => state.queue
    .map((model) => `${model.id}:${model.lifecycleStatus}`)
    .join('|'));
  const { loadModel, unloadModel, state: engineState } = useLLMEngine();
  const { openErrorReport, sheetProps: errorReportSheetProps } = useErrorReportSheetController();
  const {
    tabPreferences,
    applyDiscoveryPreset,
    syncDiscoveryTokenState,
    showFullCatalog,
    setFitsInRamOnly,
    setNoTokenRequiredOnly,
    toggleSizeRange,
    setSort,
    clearFilters,
  } = useModelsStore();
  const { filters, sort, discoveryMode } = tabPreferences[activeTab];
  const serverSort = useMemo(() => resolveServerSort(sort), [sort]);
  const shouldAutoLoadMore = serverSort !== null;
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
    if (activeTab !== 'downloaded') {
      return;
    }

    void modelCatalogService.getLocalModels()
      .then(setModels)
      .catch((error) => {
        console.warn('[ModelsList] Failed to refresh local models', error);
        setFetchState((current) => ({
          ...current,
          warningMessage: getModelCatalogErrorMessage(error),
          loadMoreError: null,
        }));
      });
  }, [activeTab]);

  const fetchModels = useCallback(
    async (
      query: string,
      cursor: string | null,
      append: boolean,
      preserveExistingResults: boolean = false,
      forceRefresh: boolean = false,
    ) => {
      const fetchId = latestFetchIdRef.current + 1;
      latestFetchIdRef.current = fetchId;
      const fetchSpan = performanceMonitor.startSpan(
        append ? 'catalog.fetch.more' : 'catalog.fetch.initial',
        {
          cursorType: cursor ? 'cursor' : 'initial',
          cursorIsBuffered: cursor ? cursor.startsWith('catalog-buffer:') : undefined,
          pageSize: MODELS_PAGE_SIZE,
          sort: serverSort ?? undefined,
        },
      );
      let fetchOutcome: 'success' | 'error' | 'stale' = 'success';
      let resultCount = 0;
      let resultHasMore = false;

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
          forceRefresh,
          gated: filters.noTokenRequiredOnly ? false : undefined,
        });
        resultCount = result.models.length;
        resultHasMore = result.hasMore;

        if (fetchId !== latestFetchIdRef.current) {
          fetchOutcome = 'stale';
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
          fetchOutcome = 'stale';
          return;
        }

        fetchOutcome = 'error';
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

        fetchSpan.end({ outcome: fetchOutcome, count: resultCount, hasMore: resultHasMore });
      }
    },
    [filters.noTokenRequiredOnly, serverSort],
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
    return modelCatalogService.subscribeCacheInvalidations((_revision, source) => {
      if (source !== 'manual') {
        return;
      }

      setManualRefreshRevision((current) => current + 1);
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
    setIsRefreshing(false);

    if (activeTab === 'all') {
      const cachedResult = modelCatalogService.getCachedSearchResult(searchQuery, {
        cursor: null,
        pageSize: MODELS_PAGE_SIZE,
        sort: serverSort,
        gated: filters.noTokenRequiredOnly ? false : undefined,
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
    void modelCatalogService.getLocalModels()
      .then((localModels) => {
        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        setModels(localModels);
        setHasMore(false);
      })
      .catch((error) => {
        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        console.warn('[ModelsList] Failed to load local models', error);
        setFetchState({ warningMessage: getModelCatalogErrorMessage(error), loadMoreError: null });
        setModels([]);
        setHasMore(false);
      });
  }, [activeTab, discoveryMode, fetchModels, filters.noTokenRequiredOnly, isTokenStateHydrated, searchQuery, serverSort, sessionIdentity]);

  const displayModels = useMemo(() => {
    const registryModels = typeof registry.getModels === 'function'
      ? registry.getModels()
      : [];
    const localModelsById = new Map(
      registryModels.map((localModel) => [localModel.id, localModel] as const),
    );
    const queuedItems = queueLifecycleSignature.length > 0
      ? useDownloadStore.getState().queue
      : [];
    const queuedItemsById = new Map(queuedItems.map((queuedItem) => [queuedItem.id, queuedItem] as const));

    const baseModels = activeTab === 'downloaded'
      ? mergeUniqueModelsById([...models, ...queuedItems])
      : models;

    return baseModels.map((model) => mergeModelWithRuntimeState(model, {
      activeModelId: engineState.activeModelId,
      localModel: localModelsById.get(model.id),
      queuedItem: queuedItemsById.get(model.id),
    }));
  }, [activeTab, engineState.activeModelId, models, queueLifecycleSignature]);

  const filteredModels = useMemo(() => {
    const filtered = displayModels.filter((model) => {
      if (filters.fitsInRamOnly) {
        const decision = model.memoryFitDecision;
        if (decision) {
          const decisionFitsInRam =
            decision === 'fits_high_confidence'
            || decision === 'fits_low_confidence';
          if (!decisionFitsInRam) {
            return false;
          }
        } else if (model.fitsInRam !== true) {
          return false;
        }
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

    if (activeTab === 'all' && serverSort) {
      return filtered;
    }

    return sortModels(filtered, sort);
  }, [activeTab, displayModels, filters, serverSort, sort]);

  useEffect(() => {
    autoFillAttemptsRef.current = 0;
  }, [sessionIdentity]);

  useEffect(() => {
    if (activeTab !== 'all') {
      return;
    }

    if (filteredModels.length === 0) {
      return;
    }

    if (catalogFirstResultsShownSessionRef.current === sessionIdentity) {
      return;
    }

    catalogFirstResultsShownSessionRef.current = sessionIdentity;
    performanceMonitor.mark('catalog.firstResultsShown');
  }, [activeTab, filteredModels.length, sessionIdentity]);

  const handleReportEngineError = useCallback(() => {
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

  const handleDismissEngineError = useCallback(() => {
    llmEngineService.clearLastModelLoadError();
    void unloadModel().catch(() => undefined);
  }, [unloadModel]);

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

  const getConfigurableModelById = useCallback((targetModelId: string | null) => {
    if (!targetModelId) {
      return undefined;
    }

    return displayModels.find((model) => model.id === targetModelId)
      ?? registry.getModel(targetModelId);
  }, [displayModels]);

  const {
    openModelParameters,
    sheetProps: modelParametersSheetProps,
  } = useModelParametersSheetController({
    getModelById: getConfigurableModelById,
    showError: showModelActionError,
    applyReloadErrorScope: 'ModelsList.handleApplyLoadParams',
    onAfterActiveModelReload: refreshDownloadedModels,
  });

  const openTokenSettings = useCallback(() => {
    router.push('/huggingface-token');
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
        showModelActionError('ModelsList.handleDownload', error);
      },
    });
  }, [openModelPage, openTokenSettings, showModelActionError, startDownload, t]);

  const performLoad = useCallback(async (modelId: string, options?: LoadModelOptions) => {
    try {
      await loadModel(modelId, options);
      refreshDownloadedModels();
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === 'model_memory_warning') {
        Alert.alert(
          t('models.memoryWarningTitle'),
          t('models.loadMemoryWarningMessage'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('models.loadAnyway'), onPress: () => { setTimeout(() => { void performLoad(modelId, { ...options, allowUnsafeMemoryLoad: true }); }, 0); } },
          ],
        );
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

      const model = models.find((item) => item.id === modelId) ?? registry.getModel(modelId);
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

      showModelActionError('ModelsList.performLoad', error, reportContext);
    }
  }, [engineState.activeModelId, engineState.loadProgress, engineState.status, loadModel, models, refreshDownloadedModels, showModelActionError, t]);

  const handleLoad = useCallback(async (modelId: string) => {
    const model = models.find((item) => item.id === modelId);
    if (model?.memoryFitDecision === 'likely_oom') {
      Alert.alert(
        t('models.ramLikelyOom'),
        t('models.loadMemoryBlockedMessage'),
        [
          { text: t('common.close') },
        ],
      );
      return;
    }

    const shouldWarnForMemory = model?.memoryFitDecision === 'borderline'
      || (model?.memoryFitDecision === undefined && model?.fitsInRam === false);
    if (shouldWarnForMemory) {
      Alert.alert(
        t('models.memoryWarningTitle'),
        t('models.loadMemoryWarningMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('models.loadAnyway'), onPress: () => { void performLoad(modelId, { allowUnsafeMemoryLoad: true }); } },
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

  useEffect(() => {
    if (activeTab !== 'all') {
      return;
    }

    const needsAutoFill = filters.fitsInRamOnly || filters.noTokenRequiredOnly;
    if (!needsAutoFill) {
      return;
    }

    if (
      !hasMore ||
      !nextCursor ||
      loading ||
      isFetchingMore ||
      appendInFlightRef.current ||
      loadMoreError
    ) {
      return;
    }

    if (filteredModels.length >= MODELS_PAGE_SIZE) {
      return;
    }

    if (autoFillAttemptsRef.current >= 4) {
      return;
    }

    if (lastAutoLoadCursorRef.current === nextCursor) {
      return;
    }

    autoFillAttemptsRef.current += 1;
    lastAutoLoadCursorRef.current = nextCursor;
    void fetchModels(searchQuery, nextCursor, true);
  }, [
    activeTab,
    fetchModels,
    filters.fitsInRamOnly,
    filters.noTokenRequiredOnly,
    filteredModels.length,
    hasMore,
    isFetchingMore,
    loadMoreError,
    loading,
    nextCursor,
    searchQuery,
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
      // Prevent back-to-back auto loads caused by content reordering or list re-renders.
      // Auto loading should require fresh user scroll input between pages.
      hasUserScrolledCatalogRef.current = false;
    }

    void fetchModels(searchQuery, nextCursor, true);
  }, [activeTab, fetchModels, hasMore, isFetchingMore, loadMoreError, loading, nextCursor, searchQuery]);

  const handlePullToRefresh = useCallback(() => {
    if (loading || isRefreshing || isFetchingMore || appendInFlightRef.current) {
      return;
    }

    setIsRefreshing(true);
    appendInFlightRef.current = false;
    lastAutoLoadCursorRef.current = null;
    hasUserScrolledCatalogRef.current = false;
    setFetchState((current) => ({ ...current, warningMessage: null, loadMoreError: null }));

    if (activeTab === 'all') {
      void fetchModels(searchQuery, null, false, true, true).finally(() => {
        setIsRefreshing(false);
      });
      return;
    }

    const fetchId = latestFetchIdRef.current + 1;
    latestFetchIdRef.current = fetchId;
    setLoading(true);
    setIsFetchingMore(false);
    void modelCatalogService.getLocalModels()
      .then((localModels) => {
        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        setModels(localModels);
        setHasMore(false);
        setNextCursor(null);
      })
      .catch((error) => {
        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        console.warn('[ModelsList] Pull-to-refresh failed to load local models', error);
        setFetchState({ warningMessage: getModelCatalogErrorMessage(error), loadMoreError: null });
      })
      .finally(() => {
        setIsRefreshing(false);
        if (fetchId === latestFetchIdRef.current) {
          setLoading(false);
        }
      });
  }, [activeTab, fetchModels, isFetchingMore, isRefreshing, loading, searchQuery]);

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
        <Button size="sm" className="mt-4" onPress={() => clearFilters(activeTab)}>
          <ButtonText>{t('models.clearFilters')}</ButtonText>
        </Button>
      ) : null}
    </Box>
  ), [activeTab, clearFilters, hasFilters, t]);

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
    <Box className="pt-1">
      {loadMoreError ? (
        <Box className="mb-2.5 rounded-2xl border border-error-300 bg-background-error px-3 py-2.5 dark:border-error-800">
          <Text className="text-sm text-error-700 dark:text-error-300">{loadMoreError}</Text>
        </Box>
      ) : null}

      {!shouldAutoLoadMore && hasMore && nextCursor ? (
        <Text className="mb-2 text-xs text-typography-500 dark:text-typography-400">
          {t(
            'models.paginationLocalSortHint',
            'This sort is applied on-device. Newly loaded models may appear earlier in the list.',
          )}
        </Text>
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
  ) : null), [activeTab, filteredModels.length, handleLoadMore, hasMore, isFetchingMore, loadMoreError, nextCursor, shouldAutoLoadMore, t]);

  const renderModelItem = useCallback<ListRenderItem<ModelMetadata>>(({ item }) => (
    <ModelCardWithRuntimeState
      model={item}
      activeModelId={engineState.activeModelId}
      onOpenDetails={openModelDetails}
      onDownload={handleDownload}
      onConfigureToken={openTokenSettings}
      onOpenModelPage={openModelPage}
      onLoad={handleLoad}
      onOpenSettings={openModelParameters}
      onUnload={handleUnload}
      onDelete={handleDelete}
      onCancel={cancelDownload}
      onChat={openChat}
    />
  ), [
    cancelDownload,
    engineState.activeModelId,
    handleDelete,
    handleDownload,
    handleLoad,
    handleUnload,
    openChat,
    openModelDetails,
    openModelPage,
    openModelParameters,
    openTokenSettings,
  ]);

  const renderItemSeparator = useCallback(() => <Box className="h-2.5" />, []);
  const renderEmptyState = useCallback(() => emptyState, [emptyState]);
  const renderFooter = useCallback(() => footer, [footer]);
  const isCatalogInitializing = activeTab === 'all' && !isTokenStateHydrated;

  return (
    <>
      <ModelsFilter
        filters={filters}
        sort={sort}
        onFitsInRamToggle={(enabled) => setFitsInRamOnly(activeTab, enabled)}
        onNoTokenRequiredToggle={(enabled) => setNoTokenRequiredOnly(activeTab, enabled)}
        onSizeRangeToggle={(sizeRange) => toggleSizeRange(activeTab, sizeRange)}
        onSortChange={(nextSort) => setSort(activeTab, nextSort)}
        onClear={() => clearFilters(activeTab)}
      />

      <ScreenStack className="flex-1 pt-2" gap="compact">
        {discoveryBanner}

        {engineState.status === EngineStatus.ERROR && engineState.lastError ? (
          <ScreenCard padding="compact" tone="error">
            <Text className="text-sm font-semibold text-error-700 dark:text-error-300">
              {t('common.errors.modelLoadFailed')}
            </Text>
            <Text selectable className="mt-1 text-sm text-error-700 dark:text-error-300">
              {engineState.lastError}
            </Text>
            <Box className="mt-3 flex-row gap-2">
              <Button action="secondary" size="sm" onPress={handleDismissEngineError} className="flex-1">
                <ButtonText>{t('common.close')}</ButtonText>
              </Button>
              <Button action="softPrimary" size="sm" onPress={handleReportEngineError} className="flex-1">
                <ButtonText>{t('models.errorReport.reportButton')}</ButtonText>
              </Button>
            </Box>
          </ScreenCard>
        ) : null}

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
            contentContainerStyle={{ flexGrow: 1, paddingBottom: screenLayoutMetrics.contentBottomInset }}
            refreshing={isRefreshing}
            onRefresh={handlePullToRefresh}
            onScroll={handleCatalogScroll}
            onEndReached={() => handleLoadMore('auto')}
            onEndReachedThreshold={0.6}
            showsVerticalScrollIndicator={false}
          />
        )}
      </ScreenStack>

      <ModelWarmupBanner engineState={engineState} />

      <ModelParametersSheet {...modelParametersSheetProps} />
      <ErrorReportSheet {...errorReportSheetProps} />
    </>
  );
};
