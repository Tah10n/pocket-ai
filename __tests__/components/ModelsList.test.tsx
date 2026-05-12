import React from 'react';
import { act, render } from '@testing-library/react-native';
import { ModelsList } from '../../src/components/models/ModelsList';
import { useModelsCatalogData } from '../../src/hooks/useModelsCatalogData';
import { useModelsStore } from '../../src/store/modelsStore';
import type { ModelFilterCriteria, ModelSortPreference } from '../../src/store/modelsStore';

const defaultFilters: ModelFilterCriteria = {
  fitsInRamOnly: true,
  noTokenRequiredOnly: false,
  sizeRanges: [],
};

const defaultSort: ModelSortPreference = {
  field: 'downloads',
  direction: 'desc',
};

jest.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

jest.mock('../../src/components/models/ModelsFilter', () => ({
  ModelsFilter: () => null,
}));

jest.mock('@/components/ui/box', () => ({
  Box: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onPress, ...props }: any) => {
    const mockReact = require('react');
    const { Pressable } = require('react-native');
    return mockReact.createElement(Pressable, { ...props, onPress }, children);
  },
  ButtonText: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { Text } = require('react-native');
    return mockReact.createElement(Text, props, children);
  },
}));

jest.mock('@/components/ui/ErrorReportSheet', () => ({
  ErrorReportSheet: () => null,
}));

jest.mock('@/components/ui/ModelCard', () => ({
  ModelCard: () => null,
}));

jest.mock('@/components/ui/ModelWarmupBanner', () => ({
  MODEL_WARMUP_BANNER_RESERVED_HEIGHT: 0,
  ModelWarmupBanner: () => null,
}));

jest.mock('@/components/ui/ModelParametersSheet', () => ({
  ModelParametersSheet: () => null,
}));

jest.mock('@/components/ui/ScreenShell', () => ({
  ScreenAndroidContentBlurTarget: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
  ScreenBanner: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
  ScreenCard: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
  ScreenStack: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
}));

jest.mock('@/components/ui/spinner', () => ({
  Spinner: () => null,
}));

jest.mock('@/components/ui/text', () => ({
  Text: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { Text } = require('react-native');
    return mockReact.createElement(Text, props, children);
  },
}));

jest.mock('@/hooks/useErrorReportSheetController', () => ({
  useErrorReportSheetController: () => ({
    openErrorReport: jest.fn(),
    sheetProps: {},
  }),
}));

jest.mock('@/hooks/useTabBarContentInset', () => ({
  useFloatingScrollInsets: () => ({
    paddingBottom: 0,
    paddingTop: 0,
  }),
}));

jest.mock('@/hooks/useLLMEngine', () => ({
  useLLMEngine: () => ({
    loadModel: jest.fn(),
    unloadModel: jest.fn(),
    state: {
      activeModelId: null,
      lastError: null,
      loadProgress: 0,
      status: 'idle',
    },
  }),
}));

jest.mock('@/hooks/useModelParametersSheetController', () => ({
  useModelParametersSheetController: () => ({
    openModelParameters: jest.fn(),
    sheetProps: {},
  }),
}));

jest.mock('@/hooks/useModelDownload', () => ({
  useModelDownload: () => ({
    cancelDownload: jest.fn(),
    startDownload: jest.fn(),
  }),
}));

jest.mock('@/hooks/useModelRegistryRevision', () => ({
  useModelRegistryRevision: () => 0,
}));

jest.mock('@/hooks/useModelActions', () => ({
  useModelActions: () => ({
    cancelDownload: jest.fn(),
    handleDelete: jest.fn(),
    handleDownload: jest.fn(),
    handleLoad: jest.fn(),
    handleUnload: jest.fn(),
    openChat: jest.fn(),
    openModelDetails: jest.fn(),
    openModelPage: jest.fn(),
    openTokenSettings: jest.fn(),
  }),
}));

jest.mock('@/hooks/useModelsCatalogData', () => ({
  useModelsCatalogData: jest.fn(),
}));

jest.mock('@/services/LocalStorageRegistry', () => ({
  registry: {
    getModel: jest.fn(() => undefined),
    getModels: jest.fn(() => []),
  },
}));

jest.mock('@/services/LLMEngineService', () => ({
  llmEngineService: {
    clearLastModelLoadError: jest.fn(),
    getLastModelLoadError: jest.fn(() => null),
  },
}));

jest.mock('@/services/PerformanceMonitor', () => ({
  performanceMonitor: {
    mark: jest.fn(),
  },
}));

jest.mock('@/store/downloadStore', () => ({
  useDownloadStore: jest.fn((selector: any) => selector({ queue: [] })),
}));

jest.mock('@/store/modelsStore', () => {
  const actual = jest.requireActual('@/store/modelsStore');
  return {
    ...actual,
    useModelsStore: jest.fn(),
  };
});

function createCatalogData(nextCursor: string | null, handleLoadMore: jest.Mock) {
  return {
    models: [],
    loading: false,
    isRefreshing: false,
    isFetchingMore: false,
    hasMore: true,
    nextCursor,
    warningMessage: null,
    loadMoreError: null,
    hasTokenConfigured: false,
    isTokenStateHydrated: true,
    sessionIdentity: `session:${nextCursor ?? 'none'}`,
    handleLoadMore,
    handlePullToRefresh: jest.fn(),
    handleCatalogScrollBeginDrag: jest.fn(),
    refreshDownloadedModels: jest.fn(),
    requestCatalogRefresh: jest.fn(),
  };
}

function setModelsStoreState(filters: ModelFilterCriteria = defaultFilters) {
  (useModelsStore as unknown as jest.Mock).mockReturnValue({
    tabPreferences: {
      all: {
        filters,
        sort: defaultSort,
        discoveryMode: 'full',
      },
      downloaded: {
        filters: {
          fitsInRamOnly: false,
          noTokenRequiredOnly: false,
          sizeRanges: [],
        },
        sort: {
          field: 'name',
          direction: 'asc',
        },
        discoveryMode: 'full',
      },
    },
    applyDiscoveryPreset: jest.fn(),
    clearFilters: jest.fn(),
    setFitsInRamOnly: jest.fn(),
    setNoTokenRequiredOnly: jest.fn(),
    setSort: jest.fn(),
    showFullCatalog: jest.fn(),
    syncDiscoveryTokenState: jest.fn(),
    toggleSizeRange: jest.fn(),
  });
}

describe('ModelsList', () => {
  const mockUseModelsCatalogData = useModelsCatalogData as jest.MockedFunction<typeof useModelsCatalogData>;

  beforeEach(() => {
    jest.clearAllMocks();
    setModelsStoreState();
  });

  it('does not auto-fill filtered catalog results from a network cursor', async () => {
    const handleLoadMore = jest.fn();
    mockUseModelsCatalogData.mockReturnValue(createCatalogData(
      'https://huggingface.co/api/models?cursor=page-2',
      handleLoadMore,
    ) as any);

    render(<ModelsList activeTab="all" searchQuery="phi" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(handleLoadMore).not.toHaveBeenCalled();
  });

  it('auto-fills filtered catalog results from a buffered cursor', async () => {
    const handleLoadMore = jest.fn();
    mockUseModelsCatalogData.mockReturnValue(createCatalogData('catalog-buffer:0:1', handleLoadMore) as any);

    render(<ModelsList activeTab="all" searchQuery="phi" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(handleLoadMore).toHaveBeenCalledTimes(1);
    expect(handleLoadMore).toHaveBeenCalledWith('manual');
  });
});
