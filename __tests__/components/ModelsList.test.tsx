import React from 'react';
import { act, render } from '@testing-library/react-native';
import { View } from 'react-native';
import { ModelsList } from '../../src/components/models/ModelsList';
import { useModelsCatalogData } from '../../src/hooks/useModelsCatalogData';
import { useModelsStore } from '../../src/store/modelsStore';
import type { ModelFilterCriteria, ModelSortPreference } from '../../src/store/modelsStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { buildProjectorArtifactId } from '../../src/utils/modelProjectors';

let mockLastFlashListProps: any = null;
let mockModelCardPropsLog: any[] = [];
let mockLastVariantPickerProps: any = null;
let mockLastProjectorChoiceSheetProps: any = null;
let mockDownloadQueue: ModelMetadata[] = [];
let mockOpenModelDetails = jest.fn();
let mockUseModelActionsInput: any = null;
let mockHandleDownload = jest.fn();
let mockRegistryModel: ModelMetadata | undefined;
let mockRegistryUpdateModel = jest.fn((model: ModelMetadata) => {
  mockRegistryModel = model;
});

const defaultFilters: ModelFilterCriteria = {
  fitsInRamOnly: true,
  noTokenRequiredOnly: false,
  sizeRanges: [],
};

const defaultSort: ModelSortPreference = {
  field: 'downloads',
  direction: 'desc',
};

function getCanonicalProjectorId(projector: {
  repoId: string;
  hfRevision?: string;
  ownerVariantId?: string;
  fileName: string;
}): string {
  return buildProjectorArtifactId(projector);
}

jest.mock('@shopify/flash-list', () => ({
  FlashList: (props: any) => {
    mockLastFlashListProps = props;
    const mockReact = require('react');
    return mockReact.createElement(
      mockReact.Fragment,
      null,
      props.data?.map((item: any, index: number) => mockReact.createElement(
        mockReact.Fragment,
        { key: props.keyExtractor?.(item, index) ?? index },
        props.renderItem({ item, index }),
      )),
    );
  },
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
  ModelCard: (props: any) => {
    mockModelCardPropsLog.push(props);
    return null;
  },
}));

jest.mock('@/components/ui/ModelWarmupBanner', () => ({
  MODEL_WARMUP_BANNER_RESERVED_HEIGHT: 0,
  ModelWarmupBanner: () => null,
}));

jest.mock('@/components/ui/ModelParametersSheet', () => ({
  ModelParametersSheet: () => null,
}));

jest.mock('@/components/ui/ModelVariantPickerSheet', () => ({
  ModelVariantPickerSheet: (props: any) => {
    mockLastVariantPickerProps = props;
    return null;
  },
}));

jest.mock('@/components/ui/ProjectorChoiceSheet', () => ({
  ProjectorChoiceSheet: (props: any) => {
    mockLastProjectorChoiceSheetProps = props;
    return null;
  },
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
  useModelActions: (input: any) => {
    mockUseModelActionsInput = input;
    return {
    cancelDownload: jest.fn(),
    handleDelete: jest.fn(),
    handleDownload: mockHandleDownload,
    handleLoad: jest.fn(),
    handleUnload: jest.fn(),
    openChat: jest.fn(),
    openModelDetails: mockOpenModelDetails,
    openModelPage: jest.fn(),
    openTokenSettings: jest.fn(),
    };
  },
}));

jest.mock('@/hooks/useModelsCatalogData', () => ({
  useModelsCatalogData: jest.fn(),
}));

jest.mock('@/services/LocalStorageRegistry', () => ({
  registry: {
    getModel: jest.fn(() => mockRegistryModel),
    getModels: jest.fn(() => []),
    updateModel: (model: ModelMetadata) => mockRegistryUpdateModel(model),
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

jest.mock('@/store/downloadStore', () => {
  const useDownloadStoreMock = jest.fn((selector: any) => selector({ queue: mockDownloadQueue }));
  (useDownloadStoreMock as any).getState = () => ({ queue: mockDownloadQueue });
  return {
    useDownloadStore: useDownloadStoreMock,
  };
});

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

function createModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 4_000_000_000,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
    resolvedFileName: 'model.Q4_K_M.gguf',
    activeVariantId: 'model.Q4_K_M.gguf',
    fitsInRam: true,
    memoryFitDecision: 'fits_low_confidence',
    memoryFitConfidence: 'medium',
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    variants: [
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        ramFit: 'fits_low_confidence',
        ramFitConfidence: 'medium',
      },
      {
        variantId: 'model.Q8_0.gguf',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
        ramFit: 'likely_oom',
        ramFitConfidence: 'medium',
      },
    ],
    ...overrides,
  };
}

function createProjectorCandidate(id: string, fileName: string) {
  return {
    id,
    ownerModelId: 'org/model',
    repoId: 'org/model',
    fileName,
    downloadUrl: `https://huggingface.co/org/model/resolve/main/${fileName}`,
    size: 512,
    lifecycleStatus: 'available' as const,
    matchStatus: 'ambiguous' as const,
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
    mockLastFlashListProps = null;
    mockModelCardPropsLog = [];
    mockLastVariantPickerProps = null;
    mockLastProjectorChoiceSheetProps = null;
    mockDownloadQueue = [];
    mockOpenModelDetails = jest.fn();
    mockUseModelActionsInput = null;
    mockHandleDownload = jest.fn();
    mockRegistryModel = undefined;
    mockRegistryUpdateModel = jest.fn((model: ModelMetadata) => {
      mockRegistryModel = model;
    });
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

  it('routes picker chrome through a provided full-screen blur target', async () => {
    const handleLoadMore = jest.fn();
    const androidBlurTargetRef = React.createRef<any>();
    const renderContentContainer = jest.fn((content) => (
      <View testID="external-catalog-content-container">{content}</View>
    ));
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel()],
    } as any);

    const { getByTestId, queryByTestId } = render(
      <ModelsList
        activeTab="all"
        searchQuery="phi"
        androidContentBlurTargetRef={androidBlurTargetRef}
        renderContentContainer={renderContentContainer}
      />,
    );

    expect(renderContentContainer).toHaveBeenCalledTimes(1);
    expect(getByTestId('external-catalog-content-container')).toBeTruthy();
    expect(queryByTestId('models-warmup-content-blur-target')).toBeNull();

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });

    expect(mockLastVariantPickerProps.androidContentBlurTargetRef).toBe(androidBlurTargetRef);
  });

  it('opens projector choice from the list download flow and resumes download after selection', async () => {
    const handleLoadMore = jest.fn();
    const firstProjector = createProjectorCandidate('projector-a', 'mmproj-a.gguf');
    const secondProjector = createProjectorCandidate('projector-b', 'mmproj-b.gguf');
    const firstProjectorId = getCanonicalProjectorId(firstProjector);
    const secondProjectorId = getCanonicalProjectorId(secondProjector);
    const model = createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [firstProjector, secondProjector],
    });
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [model],
    } as any);

    render(<ModelsList activeTab="all" searchQuery="vision" />);

    expect(mockUseModelActionsInput.openProjectorChoice).toEqual(expect.any(Function));

    act(() => {
      mockUseModelActionsInput.openProjectorChoice(model);
    });

    expect(mockLastProjectorChoiceSheetProps).toEqual(expect.objectContaining({
      visible: true,
      model,
    }));

    act(() => {
      mockLastProjectorChoiceSheetProps.onSelectProjector(secondProjector.id);
    });

    expect(mockHandleDownload).toHaveBeenCalledWith(expect.objectContaining({
      id: model.id,
      selectedProjectorId: secondProjectorId,
      projectorCandidates: [
        expect.objectContaining({ id: firstProjectorId }),
        expect.objectContaining({
          id: secondProjectorId,
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        }),
      ],
    }));
    expect(mockLastProjectorChoiceSheetProps.visible).toBe(false);
  });

  it('uses the selected projector from the sheet when the registry has stale projector metadata', async () => {
    const handleLoadMore = jest.fn();
    const firstProjector = createProjectorCandidate('projector-a', 'mmproj-a.gguf');
    const secondProjector = createProjectorCandidate('projector-b', 'mmproj-b.gguf');
    const firstProjectorId = getCanonicalProjectorId(firstProjector);
    const secondProjectorId = getCanonicalProjectorId(secondProjector);
    const model = createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [firstProjector, secondProjector],
    });
    mockRegistryModel = createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [firstProjector],
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.Q4_K_M.gguf',
    });
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [model],
    } as any);

    render(<ModelsList activeTab="all" searchQuery="vision" />);

    act(() => {
      mockUseModelActionsInput.openProjectorChoice(model);
    });
    act(() => {
      mockLastProjectorChoiceSheetProps.onSelectProjector(secondProjector.id);
    });

    expect(mockRegistryUpdateModel).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.Q4_K_M.gguf',
      selectedProjectorId: secondProjectorId,
      projectorCandidates: [
        expect.objectContaining({ id: firstProjectorId }),
        expect.objectContaining({ id: secondProjectorId, matchStatus: 'user_selected' }),
      ],
    }));
    expect(mockHandleDownload).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      selectedProjectorId: secondProjectorId,
    }));
  });

  it('merges a variant-only projector selection into stale registry fallback state', async () => {
    const handleLoadMore = jest.fn();
    const firstProjector = {
      ...createProjectorCandidate('projector-audio-a', 'mmproj-audio-a.gguf'),
      ownerVariantId: 'model.Q4_K_M.gguf',
    };
    const secondProjector = {
      ...createProjectorCandidate('projector-audio-b', 'mmproj-audio-b.gguf'),
      ownerVariantId: 'model.Q4_K_M.gguf',
    };
    const firstProjectorId = getCanonicalProjectorId(firstProjector);
    const secondProjectorId = getCanonicalProjectorId(secondProjector);
    const activeVariant = {
      ...createModel().variants![0],
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      projectorCandidates: [firstProjector, secondProjector],
    };
    const model = createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      variants: [activeVariant, createModel().variants![1]],
    });
    mockRegistryModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.Q4_K_M.gguf',
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      variants: [{
        ...activeVariant,
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        projectorCandidates: [firstProjector],
      }, createModel().variants![1]],
    });
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [model],
    } as any);

    render(<ModelsList activeTab="all" searchQuery="audio" />);
    act(() => {
      mockUseModelActionsInput.openProjectorChoice(model);
    });
    act(() => {
      mockLastProjectorChoiceSheetProps.onSelectProjector(secondProjector.id);
    });

    expect(mockRegistryUpdateModel).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.Q4_K_M.gguf',
      selectedProjectorId: undefined,
      projectorCandidates: undefined,
      variants: expect.arrayContaining([
        expect.objectContaining({
          variantId: activeVariant.variantId,
          visionSource: undefined,
          visionConfidence: undefined,
          selectedProjectorId: secondProjectorId,
          projectorCandidates: [
            expect.objectContaining({ id: firstProjectorId }),
            expect.objectContaining({
              id: secondProjectorId,
              matchStatus: 'user_selected',
            }),
          ],
        }),
      ]),
    }));
    expect(mockHandleDownload).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      variants: expect.arrayContaining([
        expect.objectContaining({
          selectedProjectorId: secondProjectorId,
          visionSource: undefined,
          visionConfidence: undefined,
        }),
      ]),
    }));
  });

  it('preserves fresh vision metadata when merging projector selection into a stale registry model', async () => {
    const handleLoadMore = jest.fn();
    const firstProjector = createProjectorCandidate('projector-a', 'mmproj-a.gguf');
    const secondProjector = createProjectorCandidate('projector-b', 'mmproj-b.gguf');
    const firstProjectorId = getCanonicalProjectorId(firstProjector);
    const secondProjectorId = getCanonicalProjectorId(secondProjector);
    const model = createModel({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'],
      visionSource: 'tree_probe',
      visionConfidence: 'trusted',
      projectorCandidates: [firstProjector, secondProjector],
    });
    mockRegistryModel = createModel({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text'],
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.Q4_K_M.gguf',
      projectorCandidates: [firstProjector],
    });
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [model],
    } as any);

    render(<ModelsList activeTab="all" searchQuery="vision" />);

    act(() => {
      mockUseModelActionsInput.openProjectorChoice(model);
    });
    act(() => {
      mockLastProjectorChoiceSheetProps.onSelectProjector(secondProjector.id);
    });

    expect(mockRegistryUpdateModel).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.Q4_K_M.gguf',
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'],
      visionSource: 'user_selected_projector',
      visionConfidence: 'trusted',
      selectedProjectorId: secondProjectorId,
      projectorCandidates: [
        expect.objectContaining({ id: firstProjectorId }),
        expect.objectContaining({ id: secondProjectorId, matchStatus: 'user_selected' }),
      ],
    }));
    expect(mockHandleDownload).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      chatModalities: ['text', 'vision'],
      visionConfidence: 'trusted',
      selectedProjectorId: secondProjectorId,
    }));
  });

  it('hides a selected variant that no longer satisfies RAM filters', async () => {
    const handleLoadMore = jest.fn();
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel()],
    } as any);

    render(<ModelsList activeTab="all" searchQuery="phi" />);

    expect(mockLastFlashListProps.data).toHaveLength(1);
    expect(mockModelCardPropsLog.at(-1)?.model.resolvedFileName).toBe('model.Q4_K_M.gguf');

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });
    expect(mockLastVariantPickerProps.visible).toBe(true);
    expect(mockLastVariantPickerProps.model).toEqual(expect.objectContaining({
      id: 'org/model',
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
    }));
    act(() => {
      mockLastVariantPickerProps.onSelectVariant('model.Q4_K_M.gguf');
    });

    expect(mockLastFlashListProps.data).toHaveLength(1);
    expect(mockLastFlashListProps.extraData).toEqual({ 'org/model': 'model.Q4_K_M.gguf' });
    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      memoryFitDecision: 'fits_low_confidence',
    }));

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });
    expect(mockLastVariantPickerProps.visible).toBe(true);
    act(() => {
      mockLastVariantPickerProps.onSelectVariant('model.Q8_0.gguf');
    });

    expect(mockLastFlashListProps.data).toHaveLength(0);
    expect(mockLastFlashListProps.extraData).toEqual({ 'org/model': 'model.Q8_0.gguf' });
  });

  it('defaults available catalog cards to Q4_K_M before explicit selection', async () => {
    const handleLoadMore = jest.fn();
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [
        createModel({
          size: 8_000_000_000,
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf',
          resolvedFileName: 'model.Q8_0.gguf',
          activeVariantId: 'model.Q8_0.gguf',
          fitsInRam: false,
          memoryFitDecision: 'likely_oom',
          gguf: {
            sizeLabel: 'Q8_0',
            totalBytes: 8_000_000_000,
          },
          variants: [
            createModel().variants![1],
            createModel().variants![0],
          ],
        }),
      ],
    } as any);

    render(<ModelsList activeTab="all" searchQuery="phi" />);

    expect(mockLastFlashListProps.data).toHaveLength(1);
    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      size: 4_000_000_000,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
      fitsInRam: true,
      memoryFitDecision: 'fits_low_confidence',
    }));
  });

  it('keeps stale paused queue state read-only instead of applying another variant', async () => {
    const handleLoadMore = jest.fn();
    setModelsStoreState({
      ...defaultFilters,
      fitsInRamOnly: false,
    });
    mockDownloadQueue = [createModel({
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.4,
      resumeData: JSON.stringify({ resumeData: 'resume-q4' }),
    })];
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel()],
    } as any);

    render(<ModelsList activeTab="all" searchQuery="phi" />);

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });
    expect(mockLastVariantPickerProps.visible).toBe(false);
    act(() => {
      mockLastVariantPickerProps.onSelectVariant('model.Q8_0.gguf');
    });

    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.4,
      resumeData: JSON.stringify({ resumeData: 'resume-q4' }),
    }));
    expect(mockLastFlashListProps.extraData).toEqual({});
  });

  it('prunes selected variants when the unfiltered catalog no longer contains them', async () => {
    const handleLoadMore = jest.fn();
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel()],
    } as any);

    const { rerender } = render(<ModelsList activeTab="all" searchQuery="phi" />);

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });
    act(() => {
      mockLastVariantPickerProps.onSelectVariant('model.Q8_0.gguf');
    });

    expect(mockLastFlashListProps.extraData).toEqual({ 'org/model': 'model.Q8_0.gguf' });

    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel({
        variants: [createModel().variants![0]],
      })],
    } as any);

    await act(async () => {
      rerender(<ModelsList activeTab="all" searchQuery="phi" />);
      await Promise.resolve();
    });

    expect(mockLastFlashListProps.extraData).toEqual({});
    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
    }));
  });

  it('preserves selected variants while the model is absent from temporary catalog results', async () => {
    const handleLoadMore = jest.fn();
    setModelsStoreState({
      ...defaultFilters,
      fitsInRamOnly: false,
    });
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel()],
    } as any);

    const { rerender } = render(<ModelsList activeTab="all" searchQuery="phi" />);

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });
    act(() => {
      mockLastVariantPickerProps.onSelectVariant('model.Q8_0.gguf');
    });

    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [],
    } as any);

    await act(async () => {
      rerender(<ModelsList activeTab="all" searchQuery="missing" />);
      await Promise.resolve();
    });

    expect(mockLastFlashListProps.extraData).toEqual({ 'org/model': 'model.Q8_0.gguf' });

    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel()],
    } as any);

    await act(async () => {
      rerender(<ModelsList activeTab="all" searchQuery="phi" />);
      await Promise.resolve();
    });

    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
    }));
  });

  it('keeps paused downloaded-tab items visible and ignores alternate variant selection', async () => {
    const handleLoadMore = jest.fn();
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel({ lifecycleStatus: LifecycleStatus.PAUSED })],
    } as any);

    render(<ModelsList activeTab="downloaded" searchQuery="phi" />);

    expect(mockLastFlashListProps.data).toHaveLength(1);
    expect(mockLastVariantPickerProps.visible).toBe(false);

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });
    expect(mockLastVariantPickerProps.visible).toBe(false);

    act(() => {
      mockLastVariantPickerProps.onSelectVariant('model.Q8_0.gguf');
    });

    expect(mockLastFlashListProps.data).toHaveLength(1);
    expect(mockLastFlashListProps.extraData).toEqual({});
    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.PAUSED,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
    }));
  });

  it('stops applying a previously selected variant when runtime state becomes paused', async () => {
    const handleLoadMore = jest.fn();
    setModelsStoreState({
      ...defaultFilters,
      fitsInRamOnly: false,
    });
    mockUseModelsCatalogData.mockReturnValue({
      ...createCatalogData(null, handleLoadMore),
      models: [createModel()],
    } as any);

    const { rerender } = render(<ModelsList activeTab="all" searchQuery="phi" />);

    act(() => {
      mockModelCardPropsLog.at(-1)?.onOpenVariantSelector('org/model');
    });
    expect(mockLastVariantPickerProps.visible).toBe(true);

    act(() => {
      mockLastVariantPickerProps.onSelectVariant('model.Q8_0.gguf');
    });
    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
    }));

    mockDownloadQueue = [createModel({
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.4,
      resumeData: JSON.stringify({ resumeData: 'resume-q4' }),
    })];

    await act(async () => {
      rerender(<ModelsList activeTab="all" searchQuery="phi" />);
      await Promise.resolve();
    });

    expect(mockModelCardPropsLog.at(-1)?.model).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.PAUSED,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      downloadProgress: 0.4,
      resumeData: JSON.stringify({ resumeData: 'resume-q4' }),
    }));
    expect(mockLastFlashListProps.extraData).toEqual({});
  });
});
