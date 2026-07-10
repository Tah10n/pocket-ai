import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { ModelDetailsScreen } from '../../src/ui/screens/ModelDetailsScreen';
import { useDownloadStore } from '../../src/store/downloadStore';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { buildModelCapabilitySnapshot } from '../../src/utils/modelCapabilities';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  SafeAreaView: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: jest.fn(),
  },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'models.variantSelectorAccessibilityLabel') {
        return `${key}:${String(options?.modelName ?? '')}:${String(options?.value ?? '')}`;
      }

      return key;
    },
  }),
}));

const mockRouter = {
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  push: jest.fn(),
  replace: jest.fn(),
  setParams: jest.fn(),
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
let lastErrorReportSheetProps: any = null;
let lastContentBlurTargetProps: any = null;
let lastModelVariantPickerSheetProps: any = null;
let lastProjectorChoiceSheetProps: any = null;
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
  getGlassCornerRadiusStyle: () => undefined,
  getGlassSurfaceFrameStyle: () => undefined,
  joinClassNames: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' '),
  useScreenAppearance: () => require('../../src/utils/themeTokens').getThemeAppearance('default', 'light'),
  ScreenHeaderShell: ({ children }: any) => children,
  ScreenAndroidContentBlurTarget: (props: any) => {
    lastContentBlurTargetProps = props;
    return props.children;
  },
  ScreenRoot: ({ children }: any) => children,
  ScreenContent: ({ children }: any) => children,
  ScreenStack: ({ children }: any) => children,
  ScreenCard: ({ children }: any) => children,
  ScreenSurface: ({ children, ...props }: any) => {
    const mockReact = jest.requireActual('react');
    const { View } = jest.requireActual('react-native');
    return mockReact.createElement(View, props, children);
  },
  ScreenPressableSurface: ({ children, onPress, ...props }: any) => {
    const mockReact = jest.requireActual('react');
    const { Pressable } = jest.requireActual('react-native');
    return mockReact.createElement(Pressable, { onPress, ...props }, children);
  },
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
  ScreenIconTile: ({ iconName }: any) => {
    const mockReact = jest.requireActual('react');
    const { Text } = jest.requireActual('react-native');
    return mockReact.createElement(Text, null, iconName);
  },
  ScreenModalOverlay: ({ children }: any) => children,
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

jest.mock('../../src/components/ui/ModelVariantPickerSheet', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable, Text, View } = jest.requireActual('react-native');
  return {
    ModelVariantPickerSheet: (props: any) => {
      lastModelVariantPickerSheetProps = props;
      return props.visible
        ? mockReact.createElement(
          View,
          null,
          mockReact.createElement(Text, null, 'model-variant-picker'),
          ...(props.model?.variants ?? []).map((variant: any) => mockReact.createElement(
            Pressable,
            {
              key: variant.variantId,
              onPress: () => props.onSelectVariant(variant.variantId),
            },
            mockReact.createElement(Text, null, variant.quantizationLabel),
          )),
        )
        : null;
    },
  };
});

jest.mock('../../src/components/ui/ProjectorChoiceSheet', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable, Text, View } = jest.requireActual('react-native');
  return {
    ProjectorChoiceSheet: (props: any) => {
      lastProjectorChoiceSheetProps = props;
      return props.visible
        ? mockReact.createElement(
          View,
          null,
          mockReact.createElement(Text, null, 'projector-choice-sheet'),
          ...(props.model?.projectorCandidates ?? []).map((projector: any) => mockReact.createElement(
            Pressable,
            {
              key: projector.id,
              onPress: () => props.onSelectProjector(projector.id),
            },
            mockReact.createElement(Text, null, projector.fileName),
          )),
        )
        : null;
    },
  };
});

jest.mock('../../src/components/ui/ErrorReportSheet', () => ({
  ErrorReportSheet: (props: any) => {
    lastErrorReportSheetProps = props;
    return null;
  },
}));

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
    lastErrorReportSheetProps = null;
    lastContentBlurTargetProps = null;
    lastModelVariantPickerSheetProps = null;
    lastProjectorChoiceSheetProps = null;
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

  it('passes the details content blur target to modal sheets', async () => {
    render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    const blurTarget = lastContentBlurTargetProps?.blurTargetRef;

    expect(blurTarget).toBeTruthy();
    expect(lastModelParametersSheetProps?.androidContentBlurTargetRef).toBe(blurTarget);
    expect(lastModelVariantPickerSheetProps?.androidContentBlurTargetRef).toBe(blurTarget);
    expect(lastProjectorChoiceSheetProps?.androidContentBlurTargetRef).toBe(blurTarget);
    expect(lastErrorReportSheetProps?.androidContentBlurTargetRef).toBe(blurTarget);
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

  it('uses the selected GGUF variant as the details download target', async () => {
    const variantModel = createModel({
      size: 4_000_000_000,
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      gguf: {
        sizeLabel: 'Q4_K_M',
        totalBytes: 4_000_000_000,
      },
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
          sha256: 'a'.repeat(64),
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          sha256: 'b'.repeat(64),
        },
      ],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(variantModel);
    modelCatalogService.getModelDetails.mockResolvedValue(variantModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    const selectorRow = screen.getByTestId('model-details-variant-selector-org/model');
    expect(selectorRow.props.accessibilityLabel).toBe('models.variantSelectorAccessibilityLabel:Llama-3.1-8B-Instruct-GGUF:Q4_K_M - 4.00 GB');
    expect(selectorRow.props.accessibilityHint).toBe('models.variantSelectorAccessibilityHint');

    fireEvent.press(selectorRow);
    expect(lastModelVariantPickerSheetProps?.visible).toBe(true);

    await act(async () => {
      lastModelVariantPickerSheetProps.onSelectVariant('model.Q8_0.gguf');
      await Promise.resolve();
    });

    expect(mockRouter.setParams).toHaveBeenCalledWith({
      modelId: 'org/model',
      variantId: 'model.Q8_0.gguf',
    });

    await act(async () => {
      fireEvent.press(screen.getByText('models.download'));
      await Promise.resolve();
    });

    expect(mockStartDownload).toHaveBeenCalledWith(expect.objectContaining({
      id: 'org/model',
      size: 8_000_000_000,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf',
      sha256: 'b'.repeat(64),
    }));
  });

  it('marks the details variant selector as read-only when no alternate variant is selectable', async () => {
    const variantModel = createModel({
      size: 4_000_000_000,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      gguf: {
        sizeLabel: 'Q4_K_M',
        totalBytes: 4_000_000_000,
      },
      variants: [{
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
      }],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(variantModel);
    modelCatalogService.getModelDetails.mockResolvedValue(variantModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    const selectorRow = screen.getByTestId('model-details-variant-selector-org/model');
    expect(selectorRow.props.accessibilityLabel).toBe('models.variantSelectorAccessibilityLabel:Llama-3.1-8B-Instruct-GGUF:Q4_K_M - 4.00 GB');
    expect(selectorRow.props.accessibilityHint).toBe('models.variantSelectorReadOnlyAccessibilityHint');

    fireEvent.press(selectorRow);
    expect(lastModelVariantPickerSheetProps?.visible).toBe(false);
  });

  it.each([
    LifecycleStatus.PAUSED,
    LifecycleStatus.FAILED,
  ])('does not allow selecting another details variant for %s models', async (lifecycleStatus) => {
    const variantModel = createModel({
      lifecycleStatus,
      size: 4_000_000_000,
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      gguf: {
        sizeLabel: 'Q4_K_M',
        totalBytes: 4_000_000_000,
      },
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
        },
      ],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(variantModel);
    modelCatalogService.getModelDetails.mockResolvedValue(variantModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    const selectorRow = screen.getByTestId('model-details-variant-selector-org/model');
    expect(selectorRow.props.accessibilityHint).toBe('models.variantSelectorReadOnlyAccessibilityHint');

    fireEvent.press(selectorRow);
    expect(lastModelVariantPickerSheetProps?.visible).toBe(false);

    await act(async () => {
      lastModelVariantPickerSheetProps.onSelectVariant('model.Q8_0.gguf');
      await Promise.resolve();
    });

    expect(mockRouter.setParams).not.toHaveBeenCalledWith(expect.objectContaining({
      variantId: 'model.Q8_0.gguf',
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

  it('shows downloaded model quantization in the selector row without a separate label', async () => {
    const downloadedModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: 4_000_000_000,
      gguf: {
        sizeLabel: 'Q4_K_M',
      },
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(downloadedModel);
    modelCatalogService.getModelDetails.mockResolvedValue(downloadedModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Q4_K_M - 4.00 GB')).toBeTruthy();
    expect(screen.queryByText('models.quantizationLabel')).toBeNull();
    expect(screen.queryByText('Q4_K_M')).toBeNull();
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

  it('keeps text chat available while ambiguous projector status blocks image readiness', async () => {
    const activeVisionModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
          size: 512_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
        {
          id: 'projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-b.gguf',
          size: 256_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
      ],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(activeVisionModel);
    modelCatalogService.getModelDetails.mockResolvedValue(activeVisionModel);
    mockEngineState.activeModelId = 'org/model';

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.multimodal.projectorStatusAmbiguousTitle')).toBeTruthy();
    expect(screen.getByText('models.multimodal.projectorStatusAmbiguousDescription')).toBeTruthy();
    expect(screen.getByText('models.chat')).toBeTruthy();

    fireEvent.press(screen.getByText('models.chat'));

    expect(mockRouter.push).toHaveBeenCalledWith('/chat');
  });

  it('uses active variant vision projector state for details badges and projector choice', async () => {
    const variantVisionModel = createModel({
      chatModalities: ['text'],
      selectedProjectorId: 'projector-a',
      projectorCandidates: [{
        id: 'projector-a',
        ownerModelId: 'org/model',
        repoId: 'org/model',
        fileName: 'mmproj-stale-a.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-stale-a.gguf',
        size: 512_000_000,
        lifecycleStatus: 'downloaded',
        matchStatus: 'matched',
      }],
      activeVariantId: 'model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      variants: [{
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [
          {
            id: 'projector-b',
            ownerModelId: 'org/model',
            ownerVariantId: 'model.Q4_K_M.gguf',
            repoId: 'org/model',
            fileName: 'mmproj-variant-b.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-variant-b.gguf',
            size: 256_000_000,
            lifecycleStatus: 'available',
            matchStatus: 'ambiguous',
          },
          {
            id: 'projector-c',
            ownerModelId: 'org/model',
            ownerVariantId: 'model.Q4_K_M.gguf',
            repoId: 'org/model',
            fileName: 'mmproj-variant-c.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-variant-c.gguf',
            size: 256_000_000,
            lifecycleStatus: 'available',
            matchStatus: 'ambiguous',
          },
        ],
      }],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(variantVisionModel);
    modelCatalogService.getModelDetails.mockResolvedValue(variantVisionModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.vision.badge')).toBeTruthy();
    expect(screen.getByText('models.multimodal.projectorStatusAmbiguousTitle')).toBeTruthy();
    expect(screen.queryByText('models.multimodal.projectorStatusReadyTitle')).toBeNull();

    fireEvent.press(screen.getByText('models.multimodal.chooseProjectorAction'));

    expect(lastProjectorChoiceSheetProps?.visible).toBe(true);
    expect(lastProjectorChoiceSheetProps?.model?.selectedProjectorId).toBeUndefined();
    expect(lastProjectorChoiceSheetProps?.model?.projectorCandidates?.map((projector: any) => projector.id)).toEqual([
      'projector-b',
      'projector-c',
    ]);
    expect(screen.getByText('mmproj-variant-b.gguf')).toBeTruthy();
    expect(screen.queryByText('mmproj-stale-a.gguf')).toBeNull();
  });

  it('renders an audio badge for native-audio model details', async () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const audioModel = createModel({
      chatModalities: ['text', 'audio'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [audioProjector],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(audioModel);
    modelCatalogService.getModelDetails.mockResolvedValue(audioModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.audio.badge')).toBeTruthy();
    expect(screen.queryByText('models.vision.badge')).toBeNull();
  });

  it('renders vision and audio badges together for dual-capability model details', async () => {
    const dualProjector = {
      id: 'dual-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-vision-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-vision-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const dualModel = createModel({
      chatModalities: ['text', 'vision', 'audio'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [dualProjector],
      artifacts: [{
        id: dualProjector.id,
        kind: 'multimodal_projector',
        requiredFor: ['image', 'audio'],
        remoteFileName: dualProjector.fileName,
        downloadUrl: dualProjector.downloadUrl,
        sizeBytes: dualProjector.size,
        installState: 'remote',
      }],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(dualModel);
    modelCatalogService.getModelDetails.mockResolvedValue(dualModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.vision.badge')).toBeTruthy();
    expect(screen.getByText('models.audio.badge')).toBeTruthy();
  });

  it('does not inherit stale top-level vision state for an active text-only variant', async () => {
    const variantTextOnlyModel = createModel({
      chatModalities: ['text', 'vision'],
      selectedProjectorId: 'projector-a',
      projectorCandidates: [{
        id: 'projector-a',
        ownerModelId: 'org/model',
        repoId: 'org/model',
        fileName: 'mmproj-stale-a.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-stale-a.gguf',
        size: 512_000_000,
        lifecycleStatus: 'downloaded',
        matchStatus: 'matched',
      }],
      activeVariantId: 'model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      variants: [{
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        chatModalities: ['text'],
      }],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(variantTextOnlyModel);
    modelCatalogService.getModelDetails.mockResolvedValue(variantTextOnlyModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('models.vision.badge')).toBeNull();
    expect(screen.queryByText('models.multimodal.projectorStatusReadyTitle')).toBeNull();
    expect(screen.queryByText('models.multimodal.chooseProjectorAction')).toBeNull();
  });

  it('does not inherit stale top-level audio state for an active text-only variant', async () => {
    const variantTextOnlyModel = createModel({
      chatModalities: ['text', 'audio'],
      activeVariantId: 'model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      variants: [{
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        chatModalities: ['text'],
      }],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(variantTextOnlyModel);
    modelCatalogService.getModelDetails.mockResolvedValue(variantTextOnlyModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('models.audio.badge')).toBeNull();
    expect(screen.queryByText('models.vision.badge')).toBeNull();
  });

  it('does not show the parent vision badge for an active audio-only variant', async () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      ownerVariantId: 'audio-variant',
      repoId: 'org/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const activeAudioModel = createModel({
      chatModalities: ['text', 'vision'],
      activeVariantId: 'audio-variant',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio-variant',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [audioProjector],
      }],
      projectorCandidates: [audioProjector],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(activeAudioModel);
    modelCatalogService.getModelDetails.mockResolvedValue(activeAudioModel);

    const screen = render(<ModelDetailsScreen />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.audio.badge')).toBeTruthy();
    expect(screen.queryByText('models.vision.badge')).toBeNull();
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

  it('continues the details download after choosing a projector for an ambiguous vision model', async () => {
    const ambiguousVisionModel = createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
          size: 512_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
        {
          id: 'projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-b.gguf',
          size: 256_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
      ],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(ambiguousVisionModel);
    modelCatalogService.getModelDetails.mockResolvedValue(ambiguousVisionModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.multimodal.projectorStatusAmbiguousTitle')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('models.download'));
      await Promise.resolve();
    });

    expect(mockStartDownload).not.toHaveBeenCalled();
    expect(lastProjectorChoiceSheetProps?.visible).toBe(true);
    expect(screen.getByText('projector-choice-sheet')).toBeTruthy();

    await act(async () => {
      lastProjectorChoiceSheetProps.onSelectProjector('projector-b');
      await Promise.resolve();
    });

    expect(mockStartDownload).toHaveBeenCalledWith(expect.objectContaining({
      id: 'org/model',
      selectedProjectorId: 'projector-b',
      projectorCandidates: expect.arrayContaining([
        expect.objectContaining({
          id: 'projector-b',
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        }),
      ]),
    }));
  });

  it('renders vision capability and projector metadata in the details flow', async () => {
    const visionModel = createModel({
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      projectorCandidates: [{
        id: 'projector-org-model-main-mmproj-model-f16.gguf',
        ownerModelId: 'org/model',
        ownerVariantId: 'Llama-3.1-8B-Instruct-Q4_K_M.gguf',
        repoId: 'org/model',
        fileName: 'mmproj-model-f16.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
        size: 536_870_912,
        lifecycleStatus: 'available',
        matchStatus: 'matched',
      }],
    });
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(visionModel);
    modelCatalogService.getModelDetails.mockResolvedValue(visionModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.vision.badge')).toBeTruthy();
    expect(screen.getByText('models.vision.capabilityLabel')).toBeTruthy();
    expect(screen.getByText('models.vision.capabilityNeedsProjector')).toBeTruthy();
    expect(screen.getByText('models.multimodal.projectorCandidates')).toBeTruthy();
    expect(screen.getByText('mmproj-model-f16.gguf')).toBeTruthy();
  });

  it('shows memory-fit badges in the details UI without confidence labels', async () => {
    const confidenceModel = createModel({
      fitsInRam: false,
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
