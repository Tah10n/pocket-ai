import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { ModelDetailsScreen } from '../../src/ui/screens/ModelDetailsScreen';
import { useDownloadStore } from '../../src/store/downloadStore';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { buildModelCapabilitySnapshot } from '../../src/utils/modelCapabilities';

const mockRouter = {
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  push: jest.fn(),
  replace: jest.fn(),
};

const mockStartDownload = jest.fn();
const mockCancelDownload = jest.fn();
const mockLoadModel = jest.fn();
const mockUnloadModel = jest.fn();
const mockFitsInRam = jest.fn();
const mockRegistryGetModel = jest.fn();
const mockOffloadModel = jest.fn();
const mockGetRecommendedGpuLayers = jest.fn();
const mockGetRecommendedLoadProfile = jest.fn<
  Promise<{ recommendedGpuLayers: number; gpuLayersCeiling: number }>,
  [string | null]
>(() => Promise.resolve({
  recommendedGpuLayers: 0,
  gpuLayersCeiling: 512,
}));
const mockReloadModel = jest.fn();
const mockHardwareStatus = jest.fn();
let lastModelParametersSheetProps: any = null;
const mockEngineState = {
  status: EngineStatus.IDLE,
  activeModelId: undefined as string | undefined,
  loadProgress: 0,
};

const mockDetailModel: ModelMetadata = {
  id: 'org/model',
  name: 'Llama-3.1-8B-Instruct-GGUF',
  author: 'org',
  size: 1024,
  downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
  resolvedFileName: 'Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  fitsInRam: true,
  accessState: ModelAccessState.PUBLIC,
  isGated: false,
  isPrivate: false,
  lifecycleStatus: LifecycleStatus.AVAILABLE,
  downloadProgress: 0,
  parameterSizeLabel: '8B',
  downloads: 1200,
  likes: 88,
  tags: ['gguf', 'chat'],
  description: 'A compact GGUF model.',
  modelType: 'llama',
  architectures: ['LlamaForCausalLM'],
  baseModels: ['meta-llama/Llama-3.1-8B-Instruct'],
  license: 'llama3.1',
  languages: ['en', 'de'],
  datasets: ['ultrachat_200k'],
  quantizedBy: 'bartowski',
  modelCreator: 'Meta',
};

function createModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    ...mockDetailModel,
    ...overrides,
  };
}

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ modelId: 'org/model' }),
}));

jest.mock('../../src/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/components/ui/button', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    Button: ({ children, onPress, disabled, ...props }: any) =>
      mockReact.createElement(Pressable, { onPress, disabled, ...props }, children),
    ButtonText: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

jest.mock('../../src/components/ui/pressable', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable } = jest.requireActual('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../src/components/ui/ScreenShell', () => ({
  ScreenHeaderShell: ({ children }: any) => children,
  ScreenContent: ({ children }: any) => children,
  ScreenStack: ({ children }: any) => children,
  ScreenCard: ({ children }: any) => children,
  ScreenActionPill: ({ children, onPress, ...props }: any) => {
    const mockReact = jest.requireActual('react');
    const { Pressable } = jest.requireActual('react-native');
    return mockReact.createElement(Pressable, { onPress, ...props }, children);
  },
  ScreenBadge: ({ children }: any) => {
    const mockReact = jest.requireActual('react');
    const { View, Text } = jest.requireActual('react-native');
    return mockReact.createElement(View, null, mockReact.createElement(Text, null, children));
  },
  ScreenChip: ({ label, children }: any) => {
    const mockReact = jest.requireActual('react');
    const { View, Text } = jest.requireActual('react-native');
    return mockReact.createElement(View, null, mockReact.createElement(Text, null, label ?? children));
  },
  ScreenSheet: ({ children }: any) => children,
  HeaderBackButton: ({ children, ...props }: any) => {
    const mockReact = jest.requireActual('react');
    const { Pressable, Text } = jest.requireActual('react-native');
    return mockReact.createElement(Pressable, props, children ?? mockReact.createElement(Text, null, 'back'));
  },
  HeaderActionPlaceholder: () => {
    const mockReact = jest.requireActual('react');
    const { View } = jest.requireActual('react-native');
    return mockReact.createElement(View, null);
  },
  ScreenIconButton: ({
    children,
    onPress,
    accessibilityLabel,
    iconName: _iconName,
    iconSize: _iconSize,
    size: _size,
    tone: _tone,
    className: _className,
    iconClassName: _iconClassName,
    ...props
  }: any) => {
    const mockReact = jest.requireActual('react');
    const { Pressable, Text } = jest.requireActual('react-native');
    return mockReact.createElement(
      Pressable,
      { onPress, accessibilityLabel, ...props },
      children ?? mockReact.createElement(Text, null, accessibilityLabel ?? 'icon'),
    );
  },
  HeaderTitleBlock: ({ title, subtitle }: any) => {
    const mockReact = jest.requireActual('react');
    const { Text, View } = jest.requireActual('react-native');
    return mockReact.createElement(
      View,
      null,
      mockReact.createElement(Text, null, title),
      subtitle ? mockReact.createElement(Text, null, subtitle) : null,
    );
  },
}));

jest.mock('../../src/components/ui/scroll-view', () => {
  const mockReact = jest.requireActual('react');
  const { ScrollView } = jest.requireActual('react-native');
  return {
    ScrollView: ({ children, ...props }: any) => mockReact.createElement(ScrollView, props, children),
  };
});

jest.mock('../../src/components/ui/spinner', () => ({
  Spinner: () => null,
}));

jest.mock('../../src/components/ui/ModelParametersSheet', () => {
  const mockReact = jest.requireActual('react');
  const { View, Text } = jest.requireActual('react-native');
  return {
    ModelParametersSheet: (props: any) => {
      lastModelParametersSheetProps = props;
      return props.visible
        ? mockReact.createElement(View, null, mockReact.createElement(Text, null, 'model-parameters-sheet'))
        : null;
    },
  };
});

jest.mock('../../src/components/ui/text', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (...classNames: (string | undefined)[]) => classNames.filter(Boolean).join(' '),
  };
});

jest.mock('../../src/services/ModelCatalogService', () => ({
  getHuggingFaceModelUrl: (modelId: string) => `https://huggingface.co/${modelId}`,
  getModelCatalogErrorMessage: jest.fn(() => 'Could not load'),
  modelCatalogService: {
    getCachedModel: jest.fn(() => mockDetailModel),
    getModelDetails: jest.fn().mockResolvedValue(mockDetailModel),
    refreshModelMetadata: jest.fn().mockResolvedValue(mockDetailModel),
  },
}));

jest.mock('../../src/hooks/useModelDownload', () => ({
  useModelDownload: () => ({
    queueIds: [],
    activeDownloadId: undefined,
    startDownload: mockStartDownload,
    cancelDownload: mockCancelDownload,
    getModelFromQueue: jest.fn(),
  }),
}));

jest.mock('../../src/hooks/useLLMEngine', () => ({
  useLLMEngine: () => ({
    state: mockEngineState,
    loadModel: mockLoadModel,
    unloadModel: mockUnloadModel,
    fitsInRam: mockFitsInRam,
    isReady: mockEngineState.status === 'ready',
    isInitializing: mockEngineState.status === 'initializing',
  }),
}));

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    getCurrentStatus: (...args: any[]) => mockHardwareStatus(...args),
  },
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    ensurePersistedCapabilitySnapshot: (model: any) => {
      if (!model) {
        return null;
      }

      const snapshotLayerCount = typeof model?.capabilitySnapshot?.modelLayerCount === 'number'
        ? model.capabilitySnapshot.modelLayerCount
        : null;
      const ggufLayerCount = typeof model?.gguf?.nLayers === 'number' ? model.gguf.nLayers : null;
      const modelLayerCount = snapshotLayerCount ?? ggufLayerCount;
      const snapshotCeiling = typeof model?.capabilitySnapshot?.gpuLayersCeiling === 'number'
        ? model.capabilitySnapshot.gpuLayersCeiling
        : null;
      const gpuLayersCeiling = snapshotCeiling ?? modelLayerCount ?? 512;

      return { modelLayerCount, gpuLayersCeiling };
    },
    getRecommendedLoadProfile: (modelId: string | null) => mockGetRecommendedLoadProfile(modelId),
    getRecommendedGpuLayers: () => mockGetRecommendedGpuLayers(),
    load: (modelId: string, options?: unknown) => mockReloadModel(modelId, options),
    getSafeModeLoadLimits: jest.fn().mockReturnValue(null),
    getContextSize: jest.fn().mockReturnValue(4096),
    getLoadedGpuLayers: jest.fn().mockReturnValue(0),
  },
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModel: (...args: any[]) => mockRegistryGetModel(...args),
    getModelsRevision: jest.fn(() => 0),
    subscribeModels: jest.fn(() => () => {}),
  },
}));

jest.mock('../../src/services/StorageManagerService', () => ({
  offloadModel: (...args: any[]) => mockOffloadModel(...args),
}));

jest.mock('../../src/services/SettingsStore', () => ({
  DEFAULT_MODEL_LOAD_PARAMETERS: {
    contextSize: 4096,
    gpuLayers: null,
  },
  getSettings: jest.fn(() => ({
    activeModelId: null,
    modelParamsByModelId: {},
    modelLoadParamsByModelId: {},
  })),
  subscribeSettings: jest.fn((listener) => {
    listener({
      activeModelId: null,
      modelParamsByModelId: {},
      modelLoadParamsByModelId: {},
    });
    return () => {};
  }),
  getGenerationParametersForModel: jest.fn(() => ({
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    repetitionPenalty: 1,
    maxTokens: 512,
    reasoningEffort: 'auto',
  })),
  getModelLoadParametersForModel: jest.fn(() => ({
    contextSize: 4096,
    gpuLayers: null,
  })),
  updateGenerationParametersForModel: jest.fn(),
  updateModelLoadParametersForModel: jest.fn(),
  resetGenerationParametersForModel: jest.fn(),
  resetModelLoadParametersForModel: jest.fn(),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
}));

describe('ModelDetailsScreen', () => {
  let openUrlSpy: jest.SpiedFunction<typeof Linking.openURL>;
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

  beforeEach(() => {
    jest.clearAllMocks();
    lastModelParametersSheetProps = null;
    mockFitsInRam.mockResolvedValue(true);
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
    mockEngineState.status = EngineStatus.IDLE;
    mockEngineState.activeModelId = undefined;
    mockEngineState.loadProgress = 0;
    mockLoadModel.mockResolvedValue(undefined);
    mockUnloadModel.mockResolvedValue(undefined);
    mockOffloadModel.mockResolvedValue(undefined);
    mockRegistryGetModel.mockReturnValue(undefined);
    mockGetRecommendedGpuLayers.mockResolvedValue(0);
    mockGetRecommendedLoadProfile.mockResolvedValue({
      recommendedGpuLayers: 0,
      gpuLayersCeiling: 512,
    });
    mockReloadModel.mockResolvedValue(undefined);
    mockHardwareStatus.mockReturnValue({ networkType: 'wifi' });

    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(createModel());
    modelCatalogService.getModelDetails.mockResolvedValue(createModel());
    modelCatalogService.refreshModelMetadata.mockResolvedValue(createModel());

    openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    openUrlSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('opens the Hugging Face model page from the details flow', async () => {
    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.press(screen.getByText('models.openOnHuggingFace'));

    expect(Linking.openURL).toHaveBeenCalledWith('https://huggingface.co/org/model');
  });

  it('offers token setup from the details flow for auth-required models', async () => {
    const authRequiredModel: ModelMetadata = {
      ...mockDetailModel,
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
    };
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(authRequiredModel);
    modelCatalogService.getModelDetails.mockResolvedValue(authRequiredModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.press(screen.getByText('models.setToken'));

    expect(mockRouter.push).toHaveBeenCalledWith('/huggingface-token');
  });

  it('keeps access-denied recovery on Hugging Face instead of showing token setup again', async () => {
    const accessDeniedModel: ModelMetadata = {
      ...mockDetailModel,
      accessState: ModelAccessState.ACCESS_DENIED,
      isGated: true,
    };
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(accessDeniedModel);
    modelCatalogService.getModelDetails.mockResolvedValue(accessDeniedModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('models.setToken')).toBeNull();

    fireEvent.press(screen.getByText('models.openOnHuggingFace'));

    expect(Linking.openURL).toHaveBeenCalledWith('https://huggingface.co/org/model');
    expect(mockRouter.push).not.toHaveBeenCalledWith('/huggingface-token');
  });

  it('shows download action for available public models and starts download from details', async () => {
    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('models.download'));
      await Promise.resolve();
    });

    expect(mockStartDownload).toHaveBeenCalledWith(expect.objectContaining({
      id: 'org/model',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    }));
  });

  it('warns before downloading a model that does not fit in current memory', async () => {
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(createModel({ fitsInRam: false }));
    modelCatalogService.getModelDetails.mockResolvedValue(createModel({ fitsInRam: false }));

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('models.download'));
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'models.memoryWarningTitle',
      'models.downloadMemoryWarningMessage',
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'models.downloadAnyway', onPress: expect.any(Function) }),
      ]),
    );
    expect(mockStartDownload).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    await act(async () => {
      buttons[1]?.onPress?.();
      await Promise.resolve();
    });

    expect(mockStartDownload).toHaveBeenCalledWith(expect.objectContaining({
      id: 'org/model',
    }));
  });

  it('shows load and settings actions for downloaded models', async () => {
    const downloadedModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(downloadedModel);
    modelCatalogService.getModelDetails.mockResolvedValue(downloadedModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('models.load'));
      await Promise.resolve();
    });
    expect(mockLoadModel).toHaveBeenCalledWith('org/model', undefined);

    await act(async () => {
      fireEvent.press(screen.getByText('models.settings'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('model-parameters-sheet')).toBeTruthy();
  });

  it('uses the cached capability snapshot ceiling before async recommendations resolve in the details flow', async () => {
    const downloadedModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    const persistedModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      metadataTrust: 'verified_local',
      size: 512 * 1024 * 1024,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      gguf: {
        totalBytes: 512 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 28,
      },
      capabilitySnapshot: buildModelCapabilitySnapshot({
        size: 512 * 1024 * 1024,
        metadataTrust: 'verified_local',
        gguf: {
          totalBytes: 512 * 1024 * 1024,
          architecture: 'llama',
          nLayers: 28,
        },
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        lastModifiedAt: undefined,
        sha256: undefined,
      }),
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(downloadedModel);
    modelCatalogService.getModelDetails.mockResolvedValue(downloadedModel);
    mockRegistryGetModel.mockImplementation((modelId: string) => (
      modelId === 'org/model' ? persistedModel : undefined
    ));
    mockGetRecommendedLoadProfile.mockImplementation(() => new Promise(() => {}));

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('models.settings'));
      await Promise.resolve();
    });

    expect(screen.getByText('model-parameters-sheet')).toBeTruthy();
    expect(lastModelParametersSheetProps?.gpuLayersCeiling).toBe(28);
  });

  it('warns instead of hard-blocking medium-confidence likely_oom models before load', async () => {
    const riskyModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'medium',
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(riskyModel);
    modelCatalogService.getModelDetails.mockResolvedValue(riskyModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('models.load'));
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'models.memoryWarningTitle',
      'models.loadMemoryWarningMessage',
      expect.any(Array),
    );
    expect(mockLoadModel).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    await act(async () => {
      buttons[1]?.onPress?.();
      await Promise.resolve();
    });

    expect(mockLoadModel).toHaveBeenCalledWith('org/model', { allowUnsafeMemoryLoad: true });
  });

  it('shows chat, settings, and unload actions for active models', async () => {
    const activeModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(activeModel);
    modelCatalogService.getModelDetails.mockResolvedValue(activeModel);
    mockEngineState.activeModelId = 'org/model';

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.chat')).toBeTruthy();
    fireEvent.press(screen.getByText('models.chat'));
    expect(mockRouter.push).toHaveBeenCalledWith('/chat');

    await act(async () => {
      fireEvent.press(screen.getByText('models.unload'));
      await Promise.resolve();
    });
    expect(mockUnloadModel).toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByText('models.settings'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('model-parameters-sheet')).toBeTruthy();
  });

  it('shows cancel action while download is in progress', async () => {
    const downloadingModel = createModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    });
    const queueItem = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      downloadProgress: 0.42,
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(downloadingModel);
    modelCatalogService.getModelDetails.mockResolvedValue(downloadingModel);
    useDownloadStore.setState({ queue: [queueItem], activeDownloadId: queueItem.id });

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('42%')).toBeTruthy();
    fireEvent.press(screen.getByText('models.cancel'));
    expect(mockCancelDownload).toHaveBeenCalledWith('org/model');
  });

  it('renders enriched metadata fields when the model exposes them', async () => {
    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.metadataLabel')).toBeTruthy();
    expect(screen.getByText('8B')).toBeTruthy();
    expect(screen.getByText('Llama-3.1-8B-Instruct-Q4_K_M.gguf')).toBeTruthy();
    expect(screen.getByText('llama')).toBeTruthy();
    expect(screen.getByText('LlamaForCausalLM')).toBeTruthy();
    expect(screen.getByText('meta-llama/Llama-3.1-8B-Instruct')).toBeTruthy();
    expect(screen.getByText('llama3.1')).toBeTruthy();
    expect(screen.getByText('en, de')).toBeTruthy();
    expect(screen.getByText('ultrachat_200k')).toBeTruthy();
    expect(screen.getByText('bartowski')).toBeTruthy();
    expect(screen.getByText('Meta')).toBeTruthy();
  });

  it('does not expose memory-fit confidence badges in the details UI', async () => {
    const confidenceModel = createModel({
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(confidenceModel);
    modelCatalogService.getModelDetails.mockResolvedValue(confidenceModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.ramLikelyOom')).toBeTruthy();
    expect(screen.queryByText('models.ramFitConfidenceHigh')).toBeNull();
    expect(screen.queryByText('models.ramFitConfidenceMedium')).toBeNull();
    expect(screen.queryByText('models.ramFitConfidenceLow')).toBeNull();
  });

  it('hides the metadata section when no metadata fields are available', async () => {
    const metadataFreeModel: ModelMetadata = {
      ...mockDetailModel,
      modelType: undefined,
      architectures: undefined,
      baseModels: undefined,
      license: undefined,
      languages: undefined,
      datasets: undefined,
      quantizedBy: undefined,
      modelCreator: undefined,
      parameterSizeLabel: undefined,
      resolvedFileName: undefined,
      tags: ['context:1m', 'chat'],
      name: 'Model',
    };
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(metadataFreeModel);
    modelCatalogService.getModelDetails.mockResolvedValue(metadataFreeModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('models.metadataLabel')).toBeNull();
    expect(screen.queryByText('1M')).toBeNull();
  });
});
