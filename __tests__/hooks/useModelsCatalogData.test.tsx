import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { useModelsCatalogData } from '../../src/hooks/useModelsCatalogData';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import {
  type ModelCatalogCacheInvalidationSource,
  modelCatalogService,
} from '../../src/services/ModelCatalogService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

jest.mock('../../src/services/HuggingFaceTokenService', () => ({
  huggingFaceTokenService: {
    getCachedState: jest.fn(() => ({ hasToken: false, updatedAt: 0 })),
    refreshState: jest.fn(() => Promise.resolve({ hasToken: false, updatedAt: 0 })),
    subscribe: jest.fn(() => jest.fn()),
  },
}));

jest.mock('../../src/services/ModelCatalogService', () => ({
  getModelCatalogErrorMessage: jest.fn((error: unknown) => (
    error instanceof Error ? error.message : String(error)
  )),
  modelCatalogService: {
    getCachedSearchResult: jest.fn(),
    getLocalModels: jest.fn(),
    searchModels: jest.fn(),
    subscribeCacheInvalidations: jest.fn(() => jest.fn()),
    subscribeMetadataUpdates: jest.fn(() => jest.fn()),
  },
}));

jest.mock('../../src/services/PerformanceMonitor', () => ({
  performanceMonitor: {
    incrementCounter: jest.fn(),
    startSpan: jest.fn(() => ({ end: jest.fn() })),
  },
}));

const baseFilters = {
  fitsInRamOnly: false,
  noTokenRequiredOnly: false,
  sizeRanges: [],
};

const baseSort = {
  field: 'downloads' as const,
  direction: 'desc' as const,
};

function createModel(id: string): ModelMetadata {
  return {
    id,
    name: id.split('/').at(-1) ?? id,
    author: id.split('/')[0] ?? 'org',
    size: 1024,
    downloadUrl: `https://huggingface.co/${id}/resolve/main/model.gguf`,
    resolvedFileName: 'model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  };
}

function renderHookHarness() {
  let currentValue: ReturnType<typeof useModelsCatalogData> | null = null;
  const applyDiscoveryPreset = jest.fn();
  const syncDiscoveryTokenState = jest.fn();

  const Harness = () => {
    const value = useModelsCatalogData({
      activeTab: 'all',
      searchQuery: 'phi',
      filters: baseFilters,
      sort: baseSort,
      serverSort: 'downloads',
      discoveryMode: 'full',
      applyDiscoveryPreset,
      syncDiscoveryTokenState,
    });

    useEffect(() => {
      currentValue = value;
    }, [value]);

    return null;
  };

  const rendered = render(<Harness />);

  return {
    getCurrentValue: () => currentValue,
    applyDiscoveryPreset,
    syncDiscoveryTokenState,
    ...rendered,
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useModelsCatalogData', () => {
  const mockTokenService = huggingFaceTokenService as jest.Mocked<typeof huggingFaceTokenService>;
  const mockCatalogService = modelCatalogService as jest.Mocked<typeof modelCatalogService>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockTokenService.getCachedState.mockReturnValue({ hasToken: false, updatedAt: 0 });
    mockTokenService.refreshState.mockResolvedValue({ hasToken: false, updatedAt: 0 });
    mockTokenService.subscribe.mockReturnValue(jest.fn());
    mockCatalogService.subscribeCacheInvalidations.mockImplementation(() => jest.fn());
    mockCatalogService.subscribeMetadataUpdates.mockImplementation(() => jest.fn());
    mockCatalogService.getLocalModels.mockResolvedValue([]);
    mockCatalogService.getCachedSearchResult.mockReturnValue({
      models: [createModel('org/first-model')],
      hasMore: true,
      nextCursor: 'https://huggingface.co/api/models?cursor=page-2',
    });
    mockCatalogService.searchModels.mockResolvedValue({
      models: [createModel('org/second-model')],
      hasMore: true,
      nextCursor: 'https://huggingface.co/api/models?cursor=page-3',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hydrates Hugging Face token state independently when the catalog hook mounts', async () => {
    const { getCurrentValue, syncDiscoveryTokenState } = renderHookHarness();

    await flushMicrotasks();

    expect(mockTokenService.refreshState).toHaveBeenCalledTimes(1);
    expect(getCurrentValue()?.isTokenStateHydrated).toBe(true);
    expect(getCurrentValue()?.hasTokenConfigured).toBe(false);
    expect(syncDiscoveryTokenState).toHaveBeenCalledWith(false);
  });

  it('refreshes the active catalog session after late persistent-cache hydration', async () => {
    let invalidationListener: ((
      revision: number,
      source: ModelCatalogCacheInvalidationSource,
    ) => void) | undefined;
    mockCatalogService.subscribeCacheInvalidations.mockImplementation((listener) => {
      invalidationListener = listener;
      listener(0, 'replay');
      return jest.fn();
    });
    mockCatalogService.getCachedSearchResult
      .mockReturnValueOnce({
        models: [createModel('org/pre-hydration-model')],
        hasMore: false,
        nextCursor: null,
      })
      .mockReturnValue({
        models: [createModel('org/persisted-hydration-model')],
        hasMore: false,
        nextCursor: null,
      });

    const { getCurrentValue } = renderHookHarness();
    await flushMicrotasks();

    expect(getCurrentValue()?.models.map((model) => model.id)).toEqual([
      'org/pre-hydration-model',
    ]);
    expect(invalidationListener).toBeDefined();

    await act(async () => {
      invalidationListener?.(1, 'hydrate');
      await Promise.resolve();
    });

    expect(getCurrentValue()?.models.map((model) => model.id)).toEqual([
      'org/persisted-hydration-model',
    ]);
    expect(mockCatalogService.getCachedSearchResult).toHaveBeenCalledTimes(2);
    expect(mockCatalogService.searchModels).not.toHaveBeenCalled();
  });

  it('renders cold catalog summaries before deferred metadata arrives and applies updates in place', async () => {
    let metadataListener: ((update: {
      query: string;
      sort: 'downloads' | 'likes' | 'lastModified' | null;
      gated: boolean | undefined;
      models: ModelMetadata[];
      removedModelIds: string[];
    }) => void) | undefined;
    const summaryModel: ModelMetadata = {
      ...createModel('org/deferred-model'),
      size: null,
      fitsInRam: null,
      requiresTreeProbe: true,
    };
    const resolvedModel: ModelMetadata = {
      ...summaryModel,
      size: 2_048,
      fitsInRam: true,
      requiresTreeProbe: false,
    };
    mockCatalogService.subscribeMetadataUpdates.mockImplementation((listener) => {
      metadataListener = listener;
      return jest.fn();
    });
    mockCatalogService.getCachedSearchResult.mockReturnValue(null);
    mockCatalogService.searchModels.mockResolvedValue({
      models: [summaryModel],
      hasMore: true,
      nextCursor: 'https://huggingface.co/api/models?cursor=page-2',
    });

    const { getCurrentValue } = renderHookHarness();
    await flushMicrotasks();

    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCatalogService.searchModels).toHaveBeenCalledWith('phi', expect.objectContaining({
      cursor: null,
      pageSize: 20,
      metadataResolution: 'deferred',
    }));
    expect(getCurrentValue()?.models).toEqual([summaryModel]);
    expect(getCurrentValue()?.loading).toBe(false);

    await act(async () => {
      metadataListener?.({
        query: 'stale-query',
        sort: 'downloads',
        gated: undefined,
        models: [resolvedModel],
        removedModelIds: [],
      });
      await Promise.resolve();
    });
    expect(getCurrentValue()?.models).toEqual([summaryModel]);

    await act(async () => {
      metadataListener?.({
        query: 'phi',
        sort: 'downloads',
        gated: undefined,
        models: [resolvedModel],
        removedModelIds: [],
      });
      await Promise.resolve();
    });

    expect(getCurrentValue()?.models).toEqual([resolvedModel]);
    expect(mockCatalogService.searchModels).toHaveBeenCalledTimes(1);
  });

  it('requires fresh user drag input before auto-loading the next catalog page', async () => {
    const { getCurrentValue, syncDiscoveryTokenState } = renderHookHarness();
    await flushMicrotasks();

    expect(getCurrentValue()?.nextCursor).toBe('https://huggingface.co/api/models?cursor=page-2');
    expect(syncDiscoveryTokenState).toHaveBeenCalledWith(false);
    expect(mockCatalogService.searchModels).not.toHaveBeenCalled();

    await act(async () => {
      getCurrentValue()?.handleLoadMore('auto');
      await Promise.resolve();
    });

    expect(mockCatalogService.searchModels).not.toHaveBeenCalled();

    await act(async () => {
      getCurrentValue()?.handleCatalogScrollBeginDrag();
      getCurrentValue()?.handleLoadMore('auto');
      await Promise.resolve();
    });

    expect(mockCatalogService.searchModels).toHaveBeenCalledTimes(1);
    expect(mockCatalogService.searchModels).toHaveBeenCalledWith('phi', expect.objectContaining({
      cursor: 'https://huggingface.co/api/models?cursor=page-2',
      pageSize: 20,
      sort: 'downloads',
    }));

    await act(async () => {
      getCurrentValue()?.handleLoadMore('auto');
      await Promise.resolve();
    });

    expect(mockCatalogService.searchModels).toHaveBeenCalledTimes(1);
  });

  it('blocks repeated auto-load attempts after a load-more error while preserving manual retry', async () => {
    mockCatalogService.searchModels
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({
        models: [createModel('org/retry-model')],
        hasMore: false,
        nextCursor: null,
      });
    const { getCurrentValue } = renderHookHarness();
    await flushMicrotasks();

    await act(async () => {
      getCurrentValue()?.handleCatalogScrollBeginDrag();
      getCurrentValue()?.handleLoadMore('auto');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getCurrentValue()?.loadMoreError).toBe('rate limited');
    });
    expect(mockCatalogService.searchModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      getCurrentValue()?.handleCatalogScrollBeginDrag();
      getCurrentValue()?.handleLoadMore('auto');
      await Promise.resolve();
    });

    expect(mockCatalogService.searchModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      getCurrentValue()?.handleLoadMore('manual');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getCurrentValue()?.loadMoreError).toBeNull();
    });
    expect(mockCatalogService.searchModels).toHaveBeenCalledTimes(2);
  });
});
