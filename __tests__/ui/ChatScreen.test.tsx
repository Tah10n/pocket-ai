import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');

  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('@shopify/flash-list', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    FlashList: ({ data, renderItem, keyExtractor, ItemSeparatorComponent, ListEmptyComponent }: any) =>
      data?.length > 0
        ? mockReact.createElement(
            View,
            null,
            data.map((item: any, index: number) =>
              mockReact.createElement(
                mockReact.Fragment,
                { key: keyExtractor ? keyExtractor(item, index) : index },
                renderItem({ item, index }),
                index < data.length - 1 && ItemSeparatorComponent
                  ? mockReact.createElement(ItemSeparatorComponent)
                  : null,
              ),
            ),
          )
        : ListEmptyComponent
          ? mockReact.createElement(ListEmptyComponent)
          : null,
  };
});

jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    canGoBack: () => false,
    back: jest.fn(),
    navigate: mockRouterNavigate,
    push: mockRouterPush,
  }),
}));

beforeAll(() => {
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof global.requestAnimationFrame;
  global.cancelAnimationFrame = ((_: number) => {}) as typeof global.cancelAnimationFrame;
});

const mockRegenerateFromUserMessage = jest.fn();
const mockDeleteMessage = jest.fn();
const mockStop = jest.fn();
const mockCreateSummaryPlaceholder = jest.fn();
const mockRouterNavigate = jest.fn();
const mockRouterPush = jest.fn();
const mockRunBackendAutotune = jest.fn();
const mockGetRecommendedGpuLayers = jest.fn(() => new Promise<number>(() => {}));
const mockGetRecommendedLoadProfile = jest.fn<Promise<{ recommendedGpuLayers: number; gpuLayersCeiling: number }>, [string | null]>(() =>
  mockGetRecommendedGpuLayers().then((recommendedGpuLayers) => ({
    recommendedGpuLayers,
    gpuLayersCeiling: 512,
  })),
);
const mockLoadModel = jest.fn().mockResolvedValue(undefined);
const mockGetTotalMemory = jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024);
const mockRefreshModelMetadata = jest.fn((model) => Promise.resolve(model));
let lastPresetSelectorProps: any = null;
let lastModelParametersSheetProps: any = null;
let lastChatHeaderProps: any = null;
let lastChatInputBarProps: any = null;
const mockStartNewChat = jest.fn(() => {
  require('../../src/store/chatStore').useChatStore.getState().setActiveThread(null);
});
  let mockSafeModeLoadLimits: {
    maxContextTokens: number;
    requestedGpuLayers: number;
    loadedGpuLayers: number;
  } | null = null;
let mockLoadedContextSize: number | null = null;
let mockLoadedGpuLayers: number | null = null;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
let hardwareStatusListener: ((status: any) => void) | null = null;
let mockHardwareBannerInputs = {
  showLowMemoryWarning: false,
  showThermalWarning: false,
  thermalState: 'nominal',
};
let mockEngineState: {
  activeModelId: string | null;
  status: string;
  diagnostics?: {
    backendMode: 'cpu' | 'gpu' | 'npu' | 'unknown';
    backendDevices: string[];
    reasonNoGPU?: string;
    systemInfo?: string;
    androidLib?: string;
    requestedGpuLayers?: number;
    loadedGpuLayers?: number;
    actualGpuAccelerated?: boolean;
  };
} = {
  activeModelId: 'author/model-q4',
  status: 'ready',
};

jest.mock('../../src/hooks/useLLMEngine', () => ({
  useLLMEngine: () => ({
    state: mockEngineState,
  }),
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
    load: (...args: any[]) => mockLoadModel(...args),
    getSafeModeLoadLimits: () => mockSafeModeLoadLimits,
    getContextSize: () => {
      if (typeof mockLoadedContextSize === 'number') {
        return mockLoadedContextSize;
      }

      const { getSettings } = require('../../src/services/SettingsStore');
      if (!mockEngineState.activeModelId) {
        return 4096;
      }

      return getSettings().modelLoadParamsByModelId?.[mockEngineState.activeModelId]?.contextSize ?? 4096;
    },
    getLoadedGpuLayers: () => {
      if (typeof mockLoadedGpuLayers === 'number') {
        return mockLoadedGpuLayers;
      }

      const { getSettings } = require('../../src/services/SettingsStore');
      if (!mockEngineState.activeModelId) {
        return null;
      }

      return getSettings().modelLoadParamsByModelId?.[mockEngineState.activeModelId]?.gpuLayers ?? null;
    },
  },
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: () => mockGetTotalMemory(),
}));

jest.mock('../../src/services/ModelCatalogService', () => ({
  modelCatalogService: {
    refreshModelMetadata: (model: any) => mockRefreshModelMetadata(model),
  },
}));

jest.mock('@/services/InferenceAutotuneService', () => ({
  inferenceAutotuneService: {
    runBackendAutotune: (...args: any[]) => mockRunBackendAutotune(...args),
  },
}));

jest.mock('../../src/components/ui/ChatHeader', () => {
  const mockReact = require('react');
  const { Text, Pressable, View } = require('react-native');

  return {
    ChatHeader: ({
      title,
      canStartNewChat,
      onStartNewChat,
      statusLabel,
      presetLabel,
      modelLabel,
      onOpenPresetSelector,
      canOpenPresetSelector,
      modelSelectable,
      onOpenModelSelector,
      canOpenModelSelector,
      onOpenModelControls,
      canOpenModelControls,
    }: any) => {
      lastChatHeaderProps = {
        title,
        canStartNewChat,
        onStartNewChat,
        statusLabel,
        presetLabel,
        modelLabel,
        onOpenPresetSelector,
        canOpenPresetSelector,
        modelSelectable,
        onOpenModelSelector,
        canOpenModelSelector,
        onOpenModelControls,
        canOpenModelControls,
      };

      return mockReact.createElement(
        View,
        null,
        mockReact.createElement(Text, null, title),
        presetLabel
          ? mockReact.createElement(
              Pressable,
              {
                testID: 'preset-button',
                onPress: onOpenPresetSelector,
                disabled: !canOpenPresetSelector,
              },
              mockReact.createElement(Text, null, presetLabel),
            )
          : null,
        modelLabel ? mockReact.createElement(Text, null, modelLabel) : null,
        statusLabel ? mockReact.createElement(Text, null, statusLabel) : null,
        onStartNewChat
          ? mockReact.createElement(
              Pressable,
              {
                testID: 'new-chat-button',
                onPress: onStartNewChat,
                disabled: !canStartNewChat,
              },
              mockReact.createElement(Text, null, 'New chat'),
            )
          : null,
        onOpenModelControls
          ? mockReact.createElement(
              Pressable,
              {
                testID: 'model-controls-button',
                onPress: onOpenModelControls,
                disabled: !canOpenModelControls,
              },
              mockReact.createElement(Text, null, 'Model controls'),
            )
          : null,
      );
    },
  };
});

jest.mock('../../src/components/ui/ChatInputBar', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    ChatInputBar: ({ isSending, onStopGeneration, onSendMessage, modeLabel, leadingActions, attachmentsTray }: any) => {
      lastChatInputBarProps = {
        isSending,
        onStopGeneration,
        onSendMessage,
        modeLabel,
        leadingActions,
        attachmentsTray,
      };

      return mockReact.createElement(
        View,
        { testID: 'chat-input-bar' },
        modeLabel ? mockReact.createElement(Text, null, modeLabel) : null,
        mockReact.createElement(
          Pressable,
          { testID: 'send-button', onPress: () => onSendMessage('Edited from test') },
          mockReact.createElement(Text, null, 'Send'),
        ),
        isSending
          ? mockReact.createElement(
              Pressable,
              { testID: 'stop-button', onPress: onStopGeneration },
              mockReact.createElement(Text, null, 'Stop'),
            )
          : null,
      );
    },
  };
});

jest.mock('../../src/components/ui/ChatMessageBubble', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    ChatMessageBubble: ({ id, content, canRegenerate, onRegenerate, onDelete }: any) =>
      mockReact.createElement(
        View,
        null,
        mockReact.createElement(Text, null, content),
        canRegenerate && onRegenerate
          ? mockReact.createElement(
              Pressable,
              { testID: `regenerate-message-${id}`, onPress: () => onRegenerate(id) },
              mockReact.createElement(Text, null, 'Regenerate message'),
            )
          : null,
        onDelete
          ? mockReact.createElement(
              Pressable,
              { testID: `delete-message-${id}`, onPress: () => onDelete(id) },
              mockReact.createElement(Text, null, 'Delete message'),
            )
          : null,
      ),
  };
});

jest.mock('@/components/ui/PresetSelectorSheet', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    PresetSelectorSheet: (props: any) => {
      lastPresetSelectorProps = props;
      const { visible, onSelectPreset } = props;
      return visible
        ? mockReact.createElement(
            View,
            { testID: 'preset-selector' },
            mockReact.createElement(
              Pressable,
              {
                testID: 'preset-option-default',
                onPress: () => onSelectPreset(null),
              },
              mockReact.createElement(Text, null, 'Default preset'),
            ),
            mockReact.createElement(
              Pressable,
              {
                testID: 'preset-option-preset-2',
                onPress: () => onSelectPreset('preset-2'),
              },
              mockReact.createElement(Text, null, 'Preset 2'),
            ),
          )
        : null;
    },
  };
});

jest.mock('@/components/ui/ModelParametersSheet', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    ModelParametersSheet: (props: any) => {
      lastModelParametersSheetProps = props;
      const { visible, onReset, onResetParamField, onChangeParams, loadParamsDraft } = props;
      return visible
        ? mockReact.createElement(
            View,
            { testID: 'model-parameters-sheet' },
            mockReact.createElement(Text, { testID: 'context-size-value' }, String(loadParamsDraft.contextSize)),
            mockReact.createElement(
              Pressable,
              {
                testID: 'set-medium-reasoning-effort-button',
                onPress: () => onChangeParams({ reasoningEffort: 'medium' }),
              },
              mockReact.createElement(Text, null, 'Set medium reasoning effort'),
            ),
            mockReact.createElement(
              Pressable,
              {
                testID: 'reset-top-p-button',
                onPress: () => onResetParamField('topP'),
              },
              mockReact.createElement(Text, null, 'Reset Top-P'),
            ),
            mockReact.createElement(
              Pressable,
              {
                testID: 'reset-all-button',
                onPress: onReset,
              },
              mockReact.createElement(Text, null, 'Reset all'),
            ),
          )
        : null;
    },
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    Box: ({ children }: any) => mockReact.createElement(View, null, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    composeTextRole: (_role: string, className?: string) => className ?? '',
    Text: ({ children }: any) => mockReact.createElement(Text, null, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');

  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../src/hooks/useChatSession', () => ({
  useChatSession: () => ({
    activeThread: require('../../src/store/chatStore').useChatStore.getState().getActiveThread(),
    messages: require('../../src/store/chatStore').useChatStore.getState().getActiveThread()?.messages ?? [],
    isGenerating: require('../../src/store/chatStore').useChatStore.getState().getActiveThread()?.status === 'generating',
    shouldOfferSummary: Boolean(
      require('../../src/store/chatStore').useChatStore
        .getState()
        .getActiveThread()
        ?.messages?.length > 24,
    ),
    truncatedMessageCount: Math.max(
      (require('../../src/store/chatStore').useChatStore.getState().getActiveThread()?.messages?.length ?? 0) - 24,
      0,
    ),
    appendUserMessage: jest.fn(),
    deleteMessage: mockDeleteMessage,
    deleteThread: jest.fn(),
    stopGeneration: mockStop,
    regenerateFromUserMessage: mockRegenerateFromUserMessage,
    createSummaryPlaceholder: mockCreateSummaryPlaceholder,
    startNewChat: mockStartNewChat,
  }),
  resolvePresetSnapshot: (presetId: string | null) => {
    if (presetId === 'preset-2') {
      return {
        id: 'preset-2',
        name: 'Research Analyst',
        systemPrompt: 'Organize findings clearly.',
      };
    }

    if (presetId === 'preset-1') {
      return {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      };
    }

    return {
      id: null,
      name: 'Default',
      systemPrompt: 'You are a helpful AI assistant.',
    };
  },
}));

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    getCurrentStatus: () => ({
      isLowMemory: false,
      isConnected: true,
      networkType: 'wifi',
      thermalState: 'nominal',
    }),
    subscribe: (listener: (status: any) => void) => {
      hardwareStatusListener = listener;
      listener({
        isLowMemory: false,
        isConnected: true,
        networkType: 'wifi',
        thermalState: 'nominal',
      });
      return jest.fn();
    },
  },
  getChatHardwareBannerInputs: () => mockHardwareBannerInputs,
}));

const {
  ChatScreen,
  getNextShouldStickToBottom,
  getAndroidKeyboardOverlapCompensation,
  getAndroidKeyboardSpacerHeight,
  handleAndroidBackNavigation,
} = require('../../src/ui/screens/ChatScreen');
const { useChatStore } = require('../../src/store/chatStore');
const {
  getSettings,
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
  updateSettings,
} = require('../../src/services/SettingsStore');
const { registry } = require('../../src/services/LocalStorageRegistry');
const { buildModelCapabilitySnapshot } = require('../../src/utils/modelCapabilities');

describe('ChatScreen', () => {
  let alertSpy: jest.SpyInstance;

  beforeAll(() => {
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterAll(() => {
    alertSpy.mockRestore();
  });

  beforeEach(() => {
    mockRegenerateFromUserMessage.mockClear();
    mockDeleteMessage.mockClear();
    mockStop.mockClear();
    mockCreateSummaryPlaceholder.mockClear();
    mockRouterNavigate.mockClear();
    mockRouterPush.mockClear();
    mockRunBackendAutotune.mockReset();
    mockRunBackendAutotune.mockResolvedValue({
      createdAtMs: 1,
      modelId: 'author/model-q4',
      contextSize: 4096,
      kvCacheType: 'f16',
      candidates: [],
    });
    mockStartNewChat.mockClear();
    alertSpy.mockClear();
    lastPresetSelectorProps = null;
    lastModelParametersSheetProps = null;
    lastChatHeaderProps = null;
    lastChatInputBarProps = null;
    mockLoadModel.mockClear();
    hardwareStatusListener = null;
    mockHardwareBannerInputs = {
      showLowMemoryWarning: false,
      showThermalWarning: false,
      thermalState: 'nominal',
    };
    mockEngineState = {
      activeModelId: 'author/model-q4',
      status: 'ready',
    };
    mockGetRecommendedGpuLayers.mockReset();
    mockGetRecommendedGpuLayers.mockImplementation(() => new Promise<number>(() => {}));
    mockGetRecommendedLoadProfile.mockReset();
    mockGetRecommendedLoadProfile.mockImplementation(() =>
      mockGetRecommendedGpuLayers().then((recommendedGpuLayers) => ({
        recommendedGpuLayers,
        gpuLayersCeiling: 512,
      })),
    );
    registry.saveModels([]);
    mockGetTotalMemory.mockClear();
    mockGetTotalMemory.mockResolvedValue(8 * 1024 * 1024 * 1024);
    mockRefreshModelMetadata.mockClear();
    mockRefreshModelMetadata.mockImplementation((model) => Promise.resolve(model));
    mockSafeModeLoadLimits = null;
    mockLoadedContextSize = null;
    mockLoadedGpuLayers = null;
    updateSettings({
      activePresetId: 'preset-1',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 512,
      modelParamsByModelId: {
        'author/model-q4': {
          temperature: 0.7,
          topP: 0.6,
          maxTokens: 1024,
          reasoningEffort: 'auto',
        },
      },
      modelLoadParamsByModelId: {},
    });
    useChatStore.setState({
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: 'Restored conversation',
          modelId: 'author/model-q4',
          presetId: 'preset-1',
          presetSnapshot: {
            id: 'preset-1',
            name: 'Helpful Assistant',
            systemPrompt: 'Be concise.',
          },
          paramsSnapshot: {
            temperature: 0.7,
            topP: 0.6,
            maxTokens: 1024,
            reasoningEffort: 'auto',
          },
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Saved user prompt',
              createdAt: 1,
              state: 'complete',
            },
            {
              id: 'message-2',
              role: 'assistant',
              content: 'Saved assistant reply',
              createdAt: 2,
              state: 'complete',
            },
          ],
          createdAt: 1,
          updatedAt: 2,
          status: 'idle',
        },
      },
      activeThreadId: 'thread-1',
    });
  });

  it('keeps auto-scroll armed when content grows without user dragging the list', () => {
    expect(
      getNextShouldStickToBottom(
        true,
        {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
        false,
      ),
    ).toBe(true);
  });

  it('turns off auto-scroll only after the user drags away from the bottom', () => {
    expect(
      getNextShouldStickToBottom(
        true,
        {
          contentOffset: { x: 0, y: 240 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
        true,
      ),
    ).toBe(false);
  });

  it('compensates only the portion of the Android keyboard that still overlaps the resized viewport', () => {
    expect(getAndroidKeyboardOverlapCompensation({
      baseWindowHeight: 2400,
      currentWindowHeight: 2140,
      keyboardHeight: 320,
    })).toBe(60);
  });

  it('keeps only a small gap when the tab bar area is already part of the covered keyboard space', () => {
    expect(getAndroidKeyboardOverlapCompensation({
      baseWindowHeight: 2400,
      currentWindowHeight: 2154,
      keyboardHeight: 320,
      coveredBottomInset: 74,
      gap: 12,
    })).toBe(12);
  });

  it('keeps enough spacer to lift the composer above the keyboard when resize alone is not enough', () => {
    expect(getAndroidKeyboardSpacerHeight({
      viewportCompensation: 20,
      composerBottomY: 2190,
      keyboardTopY: 2140,
    })).toBe(58);
  });

  it('uses stack history first for Android back when chat was pushed from another screen', () => {
    const onGoBack = jest.fn();

    expect(handleAndroidBackNavigation({
      canGoBack: true,
      onGoBack,
    })).toBe(true);
    expect(onGoBack).toHaveBeenCalledTimes(1);
  });

  it('lets the navigator fall through when there is no stack history for Android back', () => {
    const onGoBack = jest.fn();

    expect(handleAndroidBackNavigation({
      canGoBack: false,
      onGoBack,
    })).toBe(false);
    expect(onGoBack).not.toHaveBeenCalled();
  });

  it('renders messages from the restored active thread', () => {
    const { getByTestId, getByText, queryByText } = render(React.createElement(ChatScreen));

    expect(getByTestId('chat-keyboard-avoiding-view')).toBeTruthy();
    expect(getByText('Restored conversation')).toBeTruthy();
    expect(getByText('Helpful Assistant')).toBeTruthy();
    expect(getByText('model-q4')).toBeTruthy();
    expect(getByText('Saved user prompt')).toBeTruthy();
    expect(getByText('Saved assistant reply')).toBeTruthy();
    expect(queryByText('T0.7 • P0.6 • K40 • 1024 tok')).toBeNull();
  });

  it('threads future-ready header and composer contracts as no-op production props', () => {
    render(React.createElement(ChatScreen));

    expect(lastChatHeaderProps.modelSelectable).toBe(false);
    expect(lastChatHeaderProps.onOpenModelSelector).toBeUndefined();
    expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);
    expect(lastChatInputBarProps.leadingActions).toBeUndefined();
    expect(lastChatInputBarProps.attachmentsTray).toBeUndefined();
  });

  it('starts message-scoped regenerate flow from a user bubble', async () => {
    const { getByTestId, getByText, queryByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('regenerate-message-message-1'));
    expect(getByText('chat.editEarlierMessage')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });
    expect(mockRegenerateFromUserMessage).toHaveBeenCalledWith('message-1', 'Edited from test');
    expect(queryByText('chat.editEarlierMessage')).toBeNull();
  });

  it('starts a new chat and clears the current thread from the screen', () => {
    const { getByTestId, getByText, queryByText, rerender } = render(React.createElement(ChatScreen));

    expect(getByText('Saved user prompt')).toBeTruthy();
    fireEvent.press(getByTestId('new-chat-button'));
    rerender(React.createElement(ChatScreen));

    expect(mockStartNewChat).toHaveBeenCalledTimes(1);
    expect(getByText('chat.noMessages')).toBeTruthy();
    expect(queryByText('Saved user prompt')).toBeNull();
  });

  it('shows an alert instead of throwing when header new chat fails synchronously', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockStartNewChat.mockImplementationOnce(() => {
        throw new Error('Stop the current response before starting a new chat.');
      });

      const { getByTestId, getByText } = render(React.createElement(ChatScreen));

      expect(getByText('Saved user prompt')).toBeTruthy();

      fireEvent.press(getByTestId('new-chat-button'));

      expect(alertSpy).toHaveBeenCalledWith(
        'conversations.startNewChatErrorTitle',
        'common.errors.engineBusy',
      );
      expect(getByText('Saved user prompt')).toBeTruthy();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('hides regenerate control when the engine is not ready', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };

    const { queryByTestId, getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.loadModelWarning')).toBeTruthy();
    expect(queryByTestId('regenerate-message-message-1')).toBeNull();
  });

  it('replaces the empty-state prompt with a recovery card when no model is loaded for a new chat', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };
    useChatStore.setState({
      threads: {},
      activeThreadId: null,
    });

    const { getByText, queryByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.loadModelWarning')).toBeTruthy();
    expect(queryByText('chat.noMessages')).toBeNull();
  });

  it('shows stop control while a response is generating', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: [
            ...useChatStore.getState().threads['thread-1'].messages,
            {
              id: 'message-3',
              role: 'assistant',
              content: 'Streaming reply',
              createdAt: 3,
              state: 'streaming',
            },
          ],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId, queryByText } = render(React.createElement(ChatScreen));

    expect(queryByText('chat.statusGenerating')).toBeNull();
    fireEvent.press(getByTestId('stop-button'));
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('keeps header actions visible but disabled while a response is generating', async () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: [
            ...useChatStore.getState().threads['thread-1'].messages,
            {
              id: 'message-3',
              role: 'assistant',
              content: 'Streaming reply',
              createdAt: 3,
              state: 'streaming',
            },
          ],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId, queryByTestId } = render(React.createElement(ChatScreen));

    expect(getByTestId('new-chat-button')).toBeTruthy();
    expect(getByTestId('model-controls-button')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('new-chat-button'));
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    expect(mockStartNewChat).not.toHaveBeenCalled();
    expect(queryByTestId('model-parameters-sheet')).toBeNull();
  });

  it('does not stop generation when the screen unmounts', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { unmount } = render(React.createElement(ChatScreen));
    unmount();

    expect(mockStop).not.toHaveBeenCalled();
  });

  it('shows a low-memory warning banner when hardware inputs require it', () => {
    mockHardwareBannerInputs = {
      showLowMemoryWarning: true,
      showThermalWarning: false,
      thermalState: 'nominal',
    };

    const { getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.memoryPressureTitle')).toBeTruthy();
    expect(getByText('chat.memoryPressureDescription')).toBeTruthy();
  });

  it('offers a model recovery action from the disabled banner', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };

    const { getByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByText('chat.downloadModel'));
    expect(mockRouterNavigate).toHaveBeenCalledWith('/(tabs)/models');
  });

  it('offers a load-model recovery action when downloaded models already exist', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };
    registry.saveModels([
      {
        id: 'downloaded-model',
        name: 'Downloaded model',
        author: 'Test',
        size: 1024,
        localPath: 'downloaded-model.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByText('chat.loadModel'));
    expect(mockRouterNavigate).toHaveBeenCalledWith({
      pathname: '/(tabs)/models',
      params: { initialTab: 'downloaded' },
    });
  });

  it('shows an overheating warning banner when thermal state is elevated', () => {
    mockHardwareBannerInputs = {
      showLowMemoryWarning: false,
      showThermalWarning: true,
      thermalState: 'critical',
    };

    const { getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.thermalTitle')).toBeTruthy();
    expect(getByText('chat.thermalDescriptionCritical')).toBeTruthy();
  });

  it('updates hardware warning banners when the service publishes a new status', () => {
    const { queryByText, getByText } = render(React.createElement(ChatScreen));

    expect(queryByText('Device is running hot')).toBeNull();

    mockHardwareBannerInputs = {
      showLowMemoryWarning: false,
      showThermalWarning: true,
      thermalState: 'critical',
    };

    act(() => {
      hardwareStatusListener?.({
        isLowMemory: false,
        isConnected: true,
        networkType: 'wifi',
        thermalState: 'critical',
      });
    });

    expect(getByText('chat.thermalTitle')).toBeTruthy();
  });

  it('shows summarize affordance when older messages are truncated from prompt context', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: Array.from({ length: 26 }, (_, index) => ({
            id: `message-${index + 1}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${index + 1}`,
            createdAt: index + 1,
            state: 'complete',
          })),
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.summaryTrimmedTitle')).toBeTruthy();
    fireEvent.press(getByText('chat.summarizeChat'));
    expect(mockCreateSummaryPlaceholder).toHaveBeenCalledTimes(1);
  });

  it('renders a summary placeholder card when the thread already has summary metadata', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          summary: {
            content: 'Summary generation is not available yet.',
            createdAt: 10,
            sourceMessageIds: ['message-1'],
          },
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.summaryPlaceholderTitle')).toBeTruthy();
    expect(getByText('Summary generation is not available yet.')).toBeTruthy();
  });

  it('opens preset selection from the header and updates the active thread preset', () => {
    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('preset-button'));
    fireEvent.press(getByTestId('preset-option-preset-2'));
    rerender(React.createElement(ChatScreen));

    expect(getByText('Research Analyst')).toBeTruthy();
    expect(useChatStore.getState().getActiveThread()?.presetSnapshot).toEqual(
      expect.objectContaining({
        id: 'preset-2',
        name: 'Research Analyst',
        systemPrompt: 'Organize findings clearly.',
      }),
    );
  });

  it('passes the current thread preset to the selector instead of the global preset', () => {
    updateSettings({ activePresetId: 'preset-2' });
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          presetId: 'preset-1',
          presetSnapshot: {
            id: 'preset-1',
            name: 'Helpful Assistant',
            systemPrompt: 'Be concise.',
          },
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('preset-button'));

    expect(lastPresetSelectorProps?.activePresetId).toBe('preset-1');
  });

  it('allows resetting the preset back to the default state', () => {
    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('preset-button'));
    fireEvent.press(getByTestId('preset-option-default'));
    rerender(React.createElement(ChatScreen));

    expect(getByText('Default')).toBeTruthy();
    expect(useChatStore.getState().getActiveThread()?.presetId).toBeNull();
    expect(useChatStore.getState().getActiveThread()?.presetSnapshot).toEqual(
      expect.objectContaining({
        id: null,
        name: 'Default',
        systemPrompt: 'You are a helpful AI assistant.',
      }),
    );
  });

  it('resets a single generation parameter from the model controls sheet', async () => {
    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.topP).toBe(0.6);

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByTestId('reset-top-p-button'));
      await Promise.resolve();
    });
    rerender(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.topP).toBe(0.9);
  });

  it('updates the active thread reasoning effort from the model controls sheet', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Qwen3-4B-Instruct-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'qwen3',
        tags: ['gguf', 'chat'],
      },
    ]);
    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('auto');

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByTestId('set-medium-reasoning-effort-button'));
      await Promise.resolve();
    });
    rerender(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('medium');
  });

  it('alerts when autotune cannot restore the previously loaded model', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Qwen3-4B-Instruct-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'qwen3',
        tags: ['gguf', 'chat'],
      },
    ]);
    mockRunBackendAutotune.mockResolvedValueOnce({
      createdAtMs: 1,
      modelId: 'author/model-q4',
      contextSize: 4096,
      kvCacheType: 'f16',
      candidates: [],
      restorationError: 'native reload crashed',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      await lastModelParametersSheetProps?.onRunAutotune();
    });

    expect(mockRunBackendAutotune).toHaveBeenCalledWith({ modelId: 'author/model-q4' });
    expect(alertSpy).toHaveBeenCalledWith(
      'chat.modelControls.backendBenchmarkRestoreWarningTitle',
      'chat.modelControls.backendBenchmarkRestoreWarningDescription',
    );
  });

  it('keeps reasoning disabled for models without reasoning support', async () => {
    updateSettings({
      modelParamsByModelId: {
        'author/model-q4': {
          temperature: 0.7,
          topP: 0.6,
          maxTokens: 1024,
          reasoningEffort: 'high',
        },
      },
    });
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          paramsSnapshot: {
            ...useChatStore.getState().threads['thread-1'].paramsSnapshot,
            reasoningEffort: 'high',
          },
        },
      },
      activeThreadId: 'thread-1',
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'gemma-2-2b-it-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'gemma2',
        tags: ['gguf', 'chat'],
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.supportsReasoning).toBe(false);
      expect(lastModelParametersSheetProps?.params.reasoningEffort).toBe('auto');
      // Opening the sheet should not mutate persisted/thread params.
      expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('high');
    });

    await act(async () => {
      lastModelParametersSheetProps?.onChangeParams({ reasoningEffort: 'high' });
      await Promise.resolve();
    });

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('auto');
  });

  it('keeps auto reasoning effort enabled for reasoning-first models', async () => {
    updateSettings({
      activeModelId: 'author/model-r1',
      modelParamsByModelId: {
        'author/model-r1': {
          temperature: 0.7,
          topP: 0.6,
          maxTokens: 1024,
          reasoningEffort: 'auto',
        },
      },
    });
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          modelId: 'author/model-r1',
          paramsSnapshot: {
            ...useChatStore.getState().threads['thread-1'].paramsSnapshot,
            reasoningEffort: 'auto',
          },
        },
      },
      activeThreadId: 'thread-1',
    });
    mockEngineState.activeModelId = 'author/model-r1';
    registry.saveModels([
      {
        id: 'author/model-r1',
        name: 'DeepSeek-R1-Distill-Qwen-7B-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-r1.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'deepseek-r1',
        baseModels: ['deepseek-ai/DeepSeek-R1'],
        tags: ['gguf', 'reasoning'],
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.requiresReasoning).toBe(true);
      expect(lastModelParametersSheetProps?.params.reasoningEffort).toBe('auto');
      // Opening the sheet should not mutate persisted/thread params.
      expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('auto');
    });

    await act(async () => {
      lastModelParametersSheetProps?.onChangeParams({ reasoningEffort: 'low' });
      await Promise.resolve();
    });

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('low');
  });

  it('keeps the reset context window draft instead of restoring the saved override', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 8192,
          gpuLayers: null,
        },
      },
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });
    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);

    await act(async () => {
      fireEvent.press(getByTestId('reset-all-button'));
      await Promise.resolve();
    });

    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(4096);
    expect(getByTestId('context-size-value').props.children).toBe('4096');
  });

  it('keeps apply visible when an old saved context override is clamped by the current ceiling', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 32768,
          gpuLayers: null,
        },
      },
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);
      expect(lastModelParametersSheetProps?.showApplyReload).toBe(true);
    });
  });

  it('keeps the saved load profile intact when the active model is running in safe mode', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 8192,
          gpuLayers: 12,
        },
      },
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockSafeModeLoadLimits = {
      maxContextTokens: 4096,
      requestedGpuLayers: 12,
      loadedGpuLayers: 4,
    };
    mockLoadedContextSize = 4096;
    mockLoadedGpuLayers = 4;

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(8192);
      expect(lastModelParametersSheetProps?.loadParamsDraft).toEqual(
        expect.objectContaining({
          contextSize: 8192,
          gpuLayers: 12,
        }),
      );
      expect(lastModelParametersSheetProps?.loadedContextSize).toBe(4096);
      expect(lastModelParametersSheetProps?.loadedGpuLayers).toBe(4);
      expect(lastModelParametersSheetProps?.isSafeModeActive).toBe(true);
      expect(lastModelParametersSheetProps?.showApplyReload).toBe(false);
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 8192,
      gpuLayers: 12,
      kvCacheType: 'auto',
    });
  });

  it('passes runtime backend diagnostics separately from the saved load profile', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 4096,
          gpuLayers: 12,
        },
      },
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockLoadedContextSize = 4096;
    mockLoadedGpuLayers = 0;
    mockEngineState = {
      activeModelId: 'author/model-q4',
      status: 'ready',
      diagnostics: {
        backendMode: 'cpu',
        backendDevices: [],
        reasonNoGPU: 'OpenCL backend unavailable',
        requestedGpuLayers: 12,
        loadedGpuLayers: 0,
        actualGpuAccelerated: false,
      },
    };

    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.loadParamsDraft).toEqual(expect.objectContaining({
        contextSize: 4096,
        gpuLayers: 12,
      }));
      expect(lastModelParametersSheetProps?.loadedGpuLayers).toBe(0);
      expect(lastModelParametersSheetProps?.engineDiagnostics).toEqual(expect.objectContaining({
        backendMode: 'cpu',
        requestedGpuLayers: 12,
        loadedGpuLayers: 0,
        actualGpuAccelerated: false,
        reasonNoGPU: 'OpenCL backend unavailable',
      }));
    });
  });

  it('resets the GPU ceiling when reopening model controls for a different model before recommendations resolve', async () => {
    const highModelRecommendation = createDeferred<{ recommendedGpuLayers: number; gpuLayersCeiling: number }>();

    mockGetRecommendedLoadProfile.mockImplementation((modelId: string | null) => {
      if (modelId === 'author/model-q4') {
        return Promise.resolve({
          recommendedGpuLayers: 4,
          gpuLayersCeiling: 4,
        });
      }

      if (modelId === 'author/model-q8') {
        return highModelRecommendation.promise;
      }

      return Promise.resolve({
        recommendedGpuLayers: 0,
        gpuLayersCeiling: UNKNOWN_MODEL_GPU_LAYERS_CEILING,
      });
    });

    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Q8 model',
        author: 'Test',
        size: 768 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.modelId).toBe('author/model-q4');
      expect(lastModelParametersSheetProps?.gpuLayersCeiling).toBe(4);
    });

    await act(async () => {
      lastModelParametersSheetProps.onClose();
      await Promise.resolve();
    });

    await act(async () => {
      useChatStore.setState({
        threads: {
          'thread-1': {
            ...useChatStore.getState().threads['thread-1'],
            modelId: 'author/model-q8',
          },
        },
        activeThreadId: 'thread-1',
      });
      await Promise.resolve();
    });

    rerender(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.modelId).toBe('author/model-q8');
      expect(lastModelParametersSheetProps?.gpuLayersCeiling).toBe(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        gpuLayers: 100,
      });
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q8']).toEqual({
      contextSize: 4096,
      gpuLayers: 100,
      kvCacheType: 'auto',
    });
  });

  it('shows the cached stable GPU ceiling before async recommendations resolve', async () => {
    mockGetRecommendedLoadProfile.mockImplementation(() => new Promise(() => {}));

    const modelSizeBytes = 512 * 1024 * 1024;
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: modelSizeBytes,
        metadataTrust: 'verified_local',
        gguf: {
          totalBytes: modelSizeBytes,
          architecture: 'llama',
          nLayers: 28,
        },
        hasVerifiedContextWindow: true,
        maxContextTokens: 8192,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        capabilitySnapshot: buildModelCapabilitySnapshot({
          size: modelSizeBytes,
          metadataTrust: 'verified_local',
          gguf: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 28,
          },
          hasVerifiedContextWindow: true,
          maxContextTokens: 8192,
          lastModifiedAt: undefined,
          sha256: undefined,
        }),
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.gpuLayersCeiling).toBe(28);
    });
  });

  it('does not persist a gpuLayers=0 override when apply runs before recommendations resolve', async () => {
    mockGetRecommendedGpuLayers.mockReturnValueOnce(new Promise<number>(() => {}));

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
      });
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 8192,
      gpuLayers: null,
      kvCacheType: 'auto',
    });
  });

  it('keeps gpuLayers on auto when the field is reset before recommendations resolve', async () => {
    mockGetRecommendedGpuLayers.mockReturnValueOnce(new Promise<number>(() => {}));
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 4096,
          gpuLayers: 12,
        },
      },
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      lastModelParametersSheetProps.onResetLoadField('gpuLayers');
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
      });
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 8192,
      gpuLayers: null,
      kvCacheType: 'auto',
    });
  });

  it('keeps gpuLayers on auto when reset all is applied before recommendations resolve', async () => {
    mockGetRecommendedGpuLayers.mockReturnValueOnce(new Promise<number>(() => {}));
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 4096,
          gpuLayers: 12,
        },
      },
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByTestId('reset-all-button'));
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toBeUndefined();
  });

  it('passes a RAM-aware context window ceiling into the model controls sheet', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const { resolveContextWindowCeiling } = require('../../src/utils/contextWindow');
    const modelSizeBytes = 4 * 1024 * 1024 * 1024;

    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: modelSizeBytes,
        metadataTrust: 'verified_local',
        gguf: {
          totalBytes: modelSizeBytes,
          architecture: 'llama',
          nLayers: 32,
          nHeadKv: 16,
          nEmbdHeadK: 128,
          nEmbdHeadV: 128,
        },
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(resolveContextWindowCeiling({
        modelMaxContextTokens: 8192,
        totalMemoryBytes,
        input: {
          modelSizeBytes,
          verifiedFileSizeBytes: modelSizeBytes,
          metadataTrust: 'verified_local',
          ggufMetadata: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 32,
            nHeadKv: 16,
            nEmbdHeadK: 128,
            nEmbdHeadV: 128,
          },
          runtimeParams: {
            gpuLayers: 0,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            useMmap: true,
          },
        },
      }));
    });
  });

  it('surfaces context window ceilings above 8192 when the model supports them', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 32768,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(32768);
    });
  });

  it('refreshes stale model metadata before calculating the context window ceiling', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: false,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockRefreshModelMetadata.mockResolvedValueOnce({
      id: 'author/model-q4',
      name: 'Q4 model',
      author: 'Test',
      size: 512 * 1024 * 1024,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
      localPath: 'author-model-q4.gguf',
      lifecycleStatus: 'downloaded',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockRefreshModelMetadata).toHaveBeenCalledWith(expect.objectContaining({
        id: 'author/model-q4',
        maxContextTokens: 8192,
      }));
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(32768);
    });
  });

  it('refreshes unverified long-context metadata before calculating the context window ceiling', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 32768,
        hasVerifiedContextWindow: false,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockRefreshModelMetadata.mockResolvedValueOnce({
      id: 'author/model-q4',
      name: 'Q4 model',
      author: 'Test',
      size: 512 * 1024 * 1024,
      maxContextTokens: 65536,
      hasVerifiedContextWindow: true,
      localPath: 'author-model-q4.gguf',
      lifecycleStatus: 'downloaded',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockRefreshModelMetadata).toHaveBeenCalledWith(expect.objectContaining({
        id: 'author/model-q4',
        maxContextTokens: 32768,
        hasVerifiedContextWindow: false,
      }));
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(65536);
    });
  });

  it('preserves unsaved load-parameter edits while async recommendations are still resolving', async () => {
    const recommendedGpuLayers = createDeferred<number>();
    const refreshedModel = {
      id: 'author/model-q4',
      name: 'Q4 model',
      author: 'Test',
      size: 512 * 1024 * 1024,
      maxContextTokens: 32768,
      localPath: 'author-model-q4.gguf',
      lifecycleStatus: 'downloaded',
    };
    const refreshedMetadata = createDeferred<typeof refreshedModel>();

    mockGetRecommendedGpuLayers.mockReturnValueOnce(recommendedGpuLayers.promise);
    mockRefreshModelMetadata.mockReturnValueOnce(refreshedMetadata.promise);
    registry.saveModels([
      {
        ...refreshedModel,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: false,
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
        gpuLayers: 12,
      });
    });

    await act(async () => {
      recommendedGpuLayers.resolve(20);
      refreshedMetadata.resolve(refreshedModel);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);
    expect(lastModelParametersSheetProps?.loadParamsDraft.gpuLayers).toBe(12);
  });

  it('re-clamps a user draft when async RAM checks lower the context window ceiling', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const { resolveContextWindowCeiling } = require('../../src/utils/contextWindow');
    const modelSizeBytes = 4 * 1024 * 1024 * 1024;
    const totalMemory = createDeferred<number>();

    mockGetTotalMemory.mockReturnValueOnce(totalMemory.promise);
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: modelSizeBytes,
        metadataTrust: 'verified_local',
        gguf: {
          totalBytes: modelSizeBytes,
          architecture: 'llama',
          nLayers: 32,
          nHeadKv: 16,
          nEmbdHeadK: 128,
          nEmbdHeadV: 128,
        },
        maxContextTokens: 32768,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(32768);

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
      });
    });

    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);
    expect(getByTestId('context-size-value').props.children).toBe('8192');

    await act(async () => {
      totalMemory.resolve(totalMemoryBytes);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const loweredCeiling = resolveContextWindowCeiling({
        modelMaxContextTokens: 32768,
        totalMemoryBytes,
        input: {
          modelSizeBytes,
          verifiedFileSizeBytes: modelSizeBytes,
          metadataTrust: 'verified_local',
          ggufMetadata: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 32,
            nHeadKv: 16,
            nEmbdHeadK: 128,
            nEmbdHeadV: 128,
          },
          runtimeParams: {
            gpuLayers: 0,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            useMmap: true,
          },
        },
      });

      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(resolveContextWindowCeiling({
        modelMaxContextTokens: 32768,
        totalMemoryBytes,
        input: {
          modelSizeBytes,
          verifiedFileSizeBytes: modelSizeBytes,
          metadataTrust: 'verified_local',
          ggufMetadata: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 32,
            nHeadKv: 16,
            nEmbdHeadK: 128,
            nEmbdHeadV: 128,
          },
          runtimeParams: {
            gpuLayers: 0,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            useMmap: true,
          },
        },
      }));
      expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(loweredCeiling);
      expect(getByTestId('context-size-value').props.children).toBe(String(loweredCeiling));
    });
  });
});
