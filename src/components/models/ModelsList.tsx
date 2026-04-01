import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
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
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
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
import { registry } from '@/services/LocalStorageRegistry';
import { offloadModel } from '@/services/StorageManagerService';
import {
  useModelsStore,
  MODELS_PAGE_SIZE,
  type ModelFilterCriteria,
  type ModelSortPreference,
} from '@/store/modelsStore';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '@/types/models';
import { mergeModelWithRuntimeState } from '@/utils/modelRuntimeState';
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
  const router = useRouter();
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [loading, setLoading] = useState(false);
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
  const hasUserScrolledCatalogRef = useRef(false);
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
    const queuedItemsById = new Map(
      queue.map((queuedItem) => [queuedItem.id, queuedItem] as const),
    );

    return models.map((model) => mergeModelWithRuntimeState(model, {
      activeModelId: engineState.activeModelId,
      localModel: localModelsById.get(model.id),
      queuedItem: queuedItemsById.get(model.id),
    }));
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

  const showModelActionError = useCallback((scope: string, error: unknown) => {
    Alert.alert(t('models.actionFailedTitle'), getReportedErrorMessage(scope, error, t));
  }, [t]);

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

        const resolvedModel = model.size === null || model.requiresTreeProbe === true
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
    <Box className="pt-1">
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
      onOpenSettings={openModelParameters}
      onUnload={handleUnload}
      onDelete={handleDelete}
      onCancel={cancelDownload}
      onChat={() => router.push('/chat')}
      isActive={engineState.activeModelId === item.id}
    />
  ), [cancelDownload, engineState.activeModelId, handleDelete, handleDownload, handleLoad, handleUnload, openModelDetails, openModelPage, openModelParameters, openTokenSettings, router]);

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
            contentContainerStyle={{ flexGrow: 1, paddingBottom: screenLayoutMetrics.contentBottomInset }}
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

      <ModelParametersSheet {...modelParametersSheetProps} />
    </>
  );
};
