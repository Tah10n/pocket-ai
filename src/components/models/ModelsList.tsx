import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ModelCard } from '@/components/ui/ModelCard';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useLLMEngine } from '@/hooks/useLLMEngine';
import { useModelDownload } from '@/hooks/useModelDownload';
import {
  modelCatalogService,
  getModelCatalogErrorMessage,
} from '@/services/ModelCatalogService';
import { hardwareListenerService } from '@/services/HardwareListenerService';
import { registry } from '@/services/LocalStorageRegistry';
import {
  useModelsStore,
  type ModelFilterCriteria,
  type ModelSortPreference,
} from '@/store/modelsStore';
import { EngineStatus, LifecycleStatus, type ModelMetadata } from '@/types/models';
import { ModelsFilter } from './ModelsFilter';
import { useTranslation } from 'react-i18next';
import { getReportedErrorMessage } from '@/services/AppError';

interface ModelsListProps {
  activeTab: 'All Models' | 'Downloaded';
  searchQuery: string;
}

type FetchState = {
  warningMessage: string | null;
  loadMoreError: string | null;
};

function getStatusWeight(status: LifecycleStatus): number {
  if (status === LifecycleStatus.ACTIVE) return 3;
  if (status === LifecycleStatus.DOWNLOADED) return 2;
  if (status === LifecycleStatus.DOWNLOADING || status === LifecycleStatus.QUEUED) return 1;
  return 0;
}

function matchesStatus(model: ModelMetadata, filters: ModelFilterCriteria, activeTab: ModelsListProps['activeTab']) {
  if (activeTab !== 'All Models' || filters.statuses.length === 0) {
    return true;
  }

  return filters.statuses.some((status) => {
    if (status === LifecycleStatus.DOWNLOADED) {
      return (
        model.lifecycleStatus === LifecycleStatus.DOWNLOADED ||
        model.lifecycleStatus === LifecycleStatus.ACTIVE
      );
    }

    if (status === LifecycleStatus.DOWNLOADING) {
      return (
        model.lifecycleStatus === LifecycleStatus.DOWNLOADING ||
        model.lifecycleStatus === LifecycleStatus.QUEUED ||
        model.lifecycleStatus === LifecycleStatus.VERIFYING
      );
    }

    return model.lifecycleStatus === status;
  });
}

function matchesSize(model: ModelMetadata, filters: ModelFilterCriteria): boolean {
  if (filters.sizeRanges.length === 0) {
    return true;
  }

  const sizeInGb = model.size / (1024 * 1024 * 1024);
  return filters.sizeRanges.some((sizeRange) => {
    if (sizeRange === 'small') return sizeInGb < 2;
    if (sizeRange === 'medium') return sizeInGb >= 2 && sizeInGb <= 5;
    return sizeInGb > 5;
  });
}

function sortModels(models: ModelMetadata[], sort: ModelSortPreference): ModelMetadata[] {
  return [...models].sort((left, right) => {
    if (sort.field === 'size') {
      return sort.direction === 'asc' ? left.size - right.size : right.size - left.size;
    }

    if (sort.field === 'downloaded') {
      return getStatusWeight(right.lifecycleStatus) - getStatusWeight(left.lifecycleStatus);
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

export const ModelsList = ({ activeTab, searchQuery }: ModelsListProps) => {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const router = useRouter();
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [{ warningMessage, loadMoreError }, setFetchState] = useState<FetchState>({
    warningMessage: null,
    loadMoreError: null,
  });
  const latestFetchIdRef = useRef(0);

  const { startDownload, cancelDownload, queue } = useModelDownload();
  const { loadModel, unloadModel, state: engineState } = useLLMEngine();
  const {
    filters,
    sort,
    pagination,
    setFitsInRamOnly,
    toggleStatus,
    toggleSizeRange,
    setSort,
    clearFilters,
    resetPagination,
    fetchNextPage,
    setPage,
  } = useModelsStore();

  const refreshDownloadedModels = useCallback(() => {
    if (activeTab === 'Downloaded') {
      modelCatalogService.getLocalModels().then(setModels);
    }
  }, [activeTab]);

  const fetchModels = useCallback(
    async (query: string, page: number, append: boolean) => {
      const fetchId = latestFetchIdRef.current + 1;
      latestFetchIdRef.current = fetchId;

      if (append) {
        setIsFetchingMore(true);
        setFetchState((current) => ({ ...current, loadMoreError: null }));
      } else {
        setLoading(true);
        setIsFetchingMore(false);
        setFetchState({ warningMessage: null, loadMoreError: null });
      }

      try {
        const result = await modelCatalogService.searchModels(query, {
          page,
          pageSize: pagination.pageSize,
        });

        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        setHasMore(result.hasMore);
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
          setPage(Math.max(page - 1, 0));
          setFetchState((current) => ({ ...current, loadMoreError: message }));
        } else {
          setFetchState({ warningMessage: message, loadMoreError: null });
        }
      } finally {
        if (fetchId !== latestFetchIdRef.current) {
          return;
        }

        if (append) {
          setIsFetchingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [pagination.pageSize, setPage],
  );

  useEffect(() => {
    if (activeTab === 'All Models') {
      const currentPage = pagination.page;
      const append = currentPage > 0;
      const timer = setTimeout(() => fetchModels(searchQuery, currentPage, append), 400);
      return () => clearTimeout(timer);
    }

    latestFetchIdRef.current += 1;
    setHasMore(false);
    setLoading(false);
    setIsFetchingMore(false);
    setFetchState({ warningMessage: null, loadMoreError: null });
    modelCatalogService.getLocalModels().then(setModels);
  }, [activeTab, fetchModels, pagination.page, searchQuery]);

  const displayModels = useMemo(() => {
    return models.map((model) => {
      let finalModel = { ...model };
      const localModel = registry.getModel(model.id);

      if (localModel) {
        finalModel = { ...finalModel, ...localModel };
      }

      if (engineState.activeModelId === finalModel.id) {
        finalModel.lifecycleStatus = LifecycleStatus.ACTIVE;
      } else if (finalModel.lifecycleStatus === LifecycleStatus.ACTIVE) {
        finalModel.lifecycleStatus = LifecycleStatus.DOWNLOADED;
      }

      const queuedItem = queue.find((item) => item.id === finalModel.id);
      if (queuedItem) {
        finalModel = { ...finalModel, ...queuedItem };
      }

      return finalModel;
    });
  }, [engineState.activeModelId, models, queue]);

  const filteredModels = useMemo(() => {
    const filtered = displayModels.filter((model) => {
      if (filters.fitsInRamOnly && !model.fitsInRam) {
        return false;
      }

      if (!matchesStatus(model, filters, activeTab)) {
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

  const handleDownload = useCallback((model: ModelMetadata) => {
    const status = hardwareListenerService.getCurrentStatus();
    if (status.networkType === 'cellular') {
      Alert.alert(
        t('models.cellularWarningTitle'),
        t('models.cellularWarningMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('models.downloadAnyway'), onPress: () => startDownload(model) },
        ],
      );
      return;
    }

    startDownload(model);
  }, [startDownload, t]);

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
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              if (engineState.activeModelId === modelId) {
                await unloadModel();
              }
              await registry.removeModel(modelId);
              if (activeTab === 'All Models') {
                resetPagination();
                await fetchModels(searchQuery, 0, false);
              } else {
                refreshDownloadedModels();
              }
            } catch (error) {
              showModelActionError('ModelsList.handleDelete', error);
            }
          },
        },
      ],
    );
  }, [activeTab, engineState.activeModelId, fetchModels, refreshDownloadedModels, resetPagination, searchQuery, showModelActionError, t, unloadModel]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || isFetchingMore || activeTab !== 'All Models') {
      return;
    }

    fetchNextPage();
  }, [activeTab, fetchNextPage, hasMore, isFetchingMore]);

  const hasFilters =
    filters.fitsInRamOnly || filters.statuses.length > 0 || filters.sizeRanges.length > 0;

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

  const footer = useMemo(() => (activeTab === 'All Models' ? (
    <Box className="pb-5 pt-1">
      {loadMoreError ? (
        <Box className="mb-3 rounded-xl border border-error-300 bg-background-error px-4 py-3 dark:border-error-800">
          <Text className="text-sm text-error-700 dark:text-error-300">{loadMoreError}</Text>
        </Box>
      ) : null}

      {hasMore ? (
        <Button action="secondary" size="md" onPress={handleLoadMore} disabled={isFetchingMore}>
          <ButtonText className="text-typography-900 dark:text-typography-100">
            {isFetchingMore ? t('common.loading') : t('common.more')}
          </ButtonText>
        </Button>
      ) : filteredModels.length > 0 ? (
        <Text className="text-center text-xs text-typography-400 dark:text-typography-500">
          {t('models.catalogEnd')}
        </Text>
      ) : null}
    </Box>
  ) : null), [activeTab, filteredModels.length, handleLoadMore, hasMore, isFetchingMore, loadMoreError, t]);

  const renderModelItem = useCallback<ListRenderItem<ModelMetadata>>(({ item }) => (
    <ModelCard
      model={item}
      onDownload={handleDownload}
      onLoad={handleLoad}
      onUnload={handleUnload}
      onDelete={handleDelete}
      onCancel={cancelDownload}
      onChat={() => router.push('/chat')}
      isActive={engineState.activeModelId === item.id}
    />
  ), [cancelDownload, engineState.activeModelId, handleDelete, handleDownload, handleLoad, handleUnload, router]);

  const renderEmptyState = useCallback(() => emptyState, [emptyState]);
  const renderFooter = useCallback(() => footer, [footer]);

  return (
    <>
      <ModelsFilter
        filters={filters}
        sort={sort}
        onFitsInRamToggle={setFitsInRamOnly}
        onStatusToggle={toggleStatus}
        onSizeRangeToggle={toggleSizeRange}
        onSortChange={setSort}
        onClear={clearFilters}
        showStatusFilters={activeTab === 'All Models'}
      />

      <Box className="flex-1 px-4 pt-2">
        {warningMessage ? (
          <Box className="mb-3 rounded-xl border border-warning-300 bg-background-warning px-4 py-3 dark:border-warning-800">
            <Text className="text-sm text-warning-700 dark:text-warning-300">{warningMessage}</Text>
          </Box>
        ) : null}

        {loading && models.length === 0 ? (
          <Box className="flex-1 items-center justify-start pt-16">
            <Spinner size="large" />
            <Text className="mt-3 text-typography-500">{t('models.searching', 'Searching Hugging Face...')}</Text>
          </Box>
        ) : (
          <FlashList
            data={filteredModels}
            keyExtractor={(item) => item.id}
            renderItem={renderModelItem}
            ListEmptyComponent={renderEmptyState}
            ListFooterComponent={renderFooter}
            contentContainerStyle={{ paddingBottom: tabBarHeight + 16 }}
          />
        )}
      </Box>

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
    </>
  );
};
