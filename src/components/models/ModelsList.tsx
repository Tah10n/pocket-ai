import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Alert } from 'react-native';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';
import { ModelCard } from '@/components/ui/ModelCard';
import { MODEL_WARMUP_BANNER_RESERVED_HEIGHT, ModelWarmupBanner } from '@/components/ui/ModelWarmupBanner';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { ScreenCard, ScreenStack } from '@/components/ui/ScreenShell';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useErrorReportSheetController, type ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
import { useModelDownload } from '@/hooks/useModelDownload';
import { useModelRegistryRevision } from '@/hooks/useModelRegistryRevision';
import type { CatalogServerSort } from '@/services/ModelCatalogService';
import { getReportedErrorMessage, toAppError } from '@/services/AppError';
import { registry } from '@/services/LocalStorageRegistry';
import { llmEngineService } from '@/services/LLMEngineService';
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
import { DECIMAL_GIGABYTE } from '@/utils/modelSize';
import { screenLayoutMetrics } from '@/utils/themeTokens';
import { uniqueByKey } from '@/utils/uniqueBy';
import { ModelsFilter } from './ModelsFilter';
import { type ModelsCatalogTab } from '@/store/modelsCatalogTabs';
import { useTranslation } from 'react-i18next';
import { useModelsCatalogData } from '@/hooks/useModelsCatalogData';
import { useModelActions } from '@/hooks/useModelActions';

interface ModelsListProps {
  activeTab: ModelsCatalogTab;
  searchQuery: string;
  searchSessionKey?: number | string;
}

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
  if (
    status === LifecycleStatus.DOWNLOADING
    || status === LifecycleStatus.QUEUED
    || status === LifecycleStatus.VERIFYING
    || status === LifecycleStatus.PAUSED
  ) return 1;
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

export const ModelsList = ({ activeTab, searchQuery, searchSessionKey }: ModelsListProps) => {
  const { t } = useTranslation();
  const { startDownload, cancelDownload } = useModelDownload();
  const modelsRegistryRevision = useModelRegistryRevision();
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
  const autoFillAttemptsRef = useRef(0);
  const lastAutoFillCursorRef = useRef<string | null>(null);
  const catalogFirstResultsShownSessionRef = useRef<string | null>(null);

  const {
    models,
    loading,
    isRefreshing,
    isFetchingMore,
    hasMore,
    nextCursor,
    warningMessage,
    loadMoreError,
    hasTokenConfigured,
    isTokenStateHydrated,
    sessionIdentity,
    handleLoadMore,
    handlePullToRefresh,
    handleCatalogScroll,
    refreshDownloadedModels,
    requestCatalogRefresh,
  } = useModelsCatalogData({
    activeTab,
    searchQuery,
    searchSessionKey,
    filters,
    sort,
    serverSort,
    discoveryMode,
    applyDiscoveryPreset,
    syncDiscoveryTokenState,
  });

  const displayModels = useMemo(() => {
    void modelsRegistryRevision;

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
      // Downloaded tab: merge local models from the hook, the live registry, and in-flight downloads.
      // This avoids a flicker where a model is removed from the download queue before the local list refreshes.
      ? uniqueByKey([...models, ...registryModels, ...queuedItems], (model) => model.id)
      : models;

    return baseModels.map((model) => mergeModelWithRuntimeState(model, {
      activeModelId: engineState.activeModelId,
      localModel: localModelsById.get(model.id),
      queuedItem: queuedItemsById.get(model.id),
    }));
  }, [activeTab, engineState.activeModelId, models, modelsRegistryRevision, queueLifecycleSignature]);

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
    lastAutoFillCursorRef.current = null;
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

  const {
    cancelDownload: cancelModelDownload,
    openChat,
    openModelDetails,
    openModelPage,
    openTokenSettings,
    handleDelete,
    handleDownload,
    handleLoad,
    handleUnload,
  } = useModelActions({
    activeTab,
    models,
    engineState,
    loadModel,
    unloadModel,
    startDownload,
    cancelDownload,
    refreshDownloadedModels,
    requestCatalogRefresh,
    showError: showModelActionError,
    t,
  });

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

    if (lastAutoFillCursorRef.current === nextCursor) {
      return;
    }

    autoFillAttemptsRef.current += 1;
    lastAutoFillCursorRef.current = nextCursor;
    handleLoadMore('manual');
  }, [
    activeTab,
    filters.fitsInRamOnly,
    filters.noTokenRequiredOnly,
    filteredModels.length,
    handleLoadMore,
    hasMore,
    isFetchingMore,
    loadMoreError,
    loading,
    nextCursor,
  ]);

  const hasFilters =
    filters.fitsInRamOnly
    || filters.noTokenRequiredOnly
    || filters.sizeRanges.length > 0;

  const emptyState = useMemo(() => (
    <Box className="flex-1 justify-center py-6">
      <ScreenCard dashed padding="compact" className="items-center dark:border-outline-700">
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
      </ScreenCard>
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
      onCancel={cancelModelDownload}
      onChat={openChat}
    />
  ), [
    cancelModelDownload,
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

  const renderItemSeparator = useCallback(() => <Box className="h-2" />, []);
  const renderEmptyState = useCallback(() => emptyState, [emptyState]);
  const renderFooter = useCallback(() => footer, [footer]);
  const isCatalogInitializing = activeTab === 'all' && !isTokenStateHydrated;
  const isModelWarmingUp = engineState.status === EngineStatus.INITIALIZING;
  const listBottomInset = screenLayoutMetrics.contentBottomInset
    + (isModelWarmingUp ? MODEL_WARMUP_BANNER_RESERVED_HEIGHT : 0);

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
          <Box className="flex-1 items-center justify-center pb-8 pt-6">
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
            contentContainerStyle={{ flexGrow: 1, paddingBottom: listBottomInset }}
            refreshing={isRefreshing}
            onRefresh={handlePullToRefresh}
            onScroll={handleCatalogScroll}
            onEndReached={() => handleLoadMore('auto')}
            onEndReachedThreshold={0.6}
            showsVerticalScrollIndicator={false}
          />
        )}
      </ScreenStack>

      <ModelWarmupBanner engineState={engineState} bottomOffset={0} />

      <ModelParametersSheet {...modelParametersSheetProps} />
      <ErrorReportSheet {...errorReportSheetProps} />
    </>
  );
};
