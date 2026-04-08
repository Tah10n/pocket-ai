import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import {
  type CatalogServerSort,
  getModelCatalogErrorMessage,
  modelCatalogService,
} from '@/services/ModelCatalogService';
import { huggingFaceTokenService } from '@/services/HuggingFaceTokenService';
import { performanceMonitor } from '@/services/PerformanceMonitor';
import { MODELS_PAGE_SIZE, type CatalogDiscoveryMode, type ModelFilterCriteria, type ModelSortPreference } from '@/store/modelsStore';
import type { ModelMetadata } from '@/types/models';
import type { ModelsCatalogTab } from '@/store/modelsCatalogTabs';
import { shouldBootstrapCatalogSession, shouldResetCatalogForTokenEvent } from '@/store/modelsCatalogSession';
import { uniqueByKey } from '@/utils/uniqueBy';

type FetchState = {
  warningMessage: string | null;
  loadMoreError: string | null;
};

type UseModelsCatalogDataInput = {
  activeTab: ModelsCatalogTab;
  searchQuery: string;
  searchSessionKey?: number | string;
  filters: ModelFilterCriteria;
  sort: ModelSortPreference;
  serverSort: CatalogServerSort | null;
  discoveryMode: CatalogDiscoveryMode;
  applyDiscoveryPreset: (input: { hasToken: boolean }) => void;
  syncDiscoveryTokenState: (hasToken: boolean) => void;
};

export function useModelsCatalogData({
  activeTab,
  searchQuery,
  searchSessionKey,
  filters,
  sort,
  serverSort,
  discoveryMode,
  applyDiscoveryPreset,
  syncDiscoveryTokenState,
}: UseModelsCatalogDataInput) {
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
  const hasUserScrolledCatalogRef = useRef(false);

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
        console.warn('[ModelsCatalogData] Failed to refresh local models', error);
        setFetchState((current) => ({
          ...current,
          warningMessage: getModelCatalogErrorMessage(error),
        }));
      });
  }, [activeTab]);

  const requestCatalogRefresh = useCallback(() => {
    setManualRefreshRevision((current) => current + 1);
  }, []);

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
            ? uniqueByKey([...current, ...result.models], (model) => model.id)
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
      } else {
        setLoading(true);
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

        console.warn('[ModelsCatalogData] Failed to load local models', error);
        setFetchState({ warningMessage: getModelCatalogErrorMessage(error), loadMoreError: null });
        setModels([]);
        setHasMore(false);
      });
  }, [
    activeTab,
    discoveryMode,
    fetchModels,
    filters.noTokenRequiredOnly,
    isTokenStateHydrated,
    searchQuery,
    serverSort,
    sessionIdentity,
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

        console.warn('[ModelsCatalogData] Pull-to-refresh failed to load local models', error);
        setFetchState({ warningMessage: getModelCatalogErrorMessage(error), loadMoreError: null });
      })
      .finally(() => {
        setIsRefreshing(false);
        if (fetchId === latestFetchIdRef.current) {
          setLoading(false);
        }
      });
  }, [activeTab, fetchModels, isFetchingMore, isRefreshing, loading, searchQuery]);

  const handleCatalogScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    if (typeof offsetY === 'number' && offsetY > 0) {
      hasUserScrolledCatalogRef.current = true;
    }
  }, []);

  return {
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
  };
}
