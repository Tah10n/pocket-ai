import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');

  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({
    canGoBack: () => false,
    back: jest.fn(),
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
const mockRouterPush = jest.fn();
const mockGetRecommendedGpuLayers = jest.fn(() => new Promise<number>(() => {}));
let lastPresetSelectorProps: any = null;
const mockStartNewChat = jest.fn(() => {
  require('../../src/store/chatStore').useChatStore.getState().setActiveThread(null);
});
let hardwareStatusListener: ((status: any) => void) | null = null;
let mockHardwareBannerInputs = {
  showLowMemoryWarning: false,
  showThermalWarning: false,
  thermalState: 'nominal',
};
let mockEngineState: {
  activeModelId: string | null;
  status: string;
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
    getRecommendedGpuLayers: () => mockGetRecommendedGpuLayers(),
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
      onOpenModelControls,
      canOpenModelControls,
    }: any) =>
      mockReact.createElement(
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
      ),
  };
});

jest.mock('../../src/components/ui/ChatInputBar', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    ChatInputBar: ({ isSending, onStopGeneration, onSendMessage, modeLabel }: any) =>
      mockReact.createElement(
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
      ),
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
              { testID: `regenerate-message-${id}`, onPress: onRegenerate },
              mockReact.createElement(Text, null, 'Regenerate message'),
            )
          : null,
        onDelete
          ? mockReact.createElement(
              Pressable,
              { testID: `delete-message-${id}`, onPress: onDelete },
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
    ModelParametersSheet: ({ visible, onResetParamField, onChangeParams }: any) =>
      visible
        ? mockReact.createElement(
            View,
            { testID: 'model-parameters-sheet' },
            mockReact.createElement(
              Pressable,
              {
                testID: 'enable-reasoning-button',
                onPress: () => onChangeParams({ reasoningEnabled: true }),
              },
              mockReact.createElement(Text, null, 'Enable reasoning'),
            ),
            mockReact.createElement(
              Pressable,
              {
                testID: 'reset-top-p-button',
                onPress: () => onResetParamField('topP'),
              },
              mockReact.createElement(Text, null, 'Reset Top-P'),
            ),
          )
        : null,
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
const { updateSettings } = require('../../src/services/SettingsStore');
const { registry } = require('../../src/services/LocalStorageRegistry');

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
    mockRouterPush.mockClear();
    mockStartNewChat.mockClear();
    alertSpy.mockClear();
    lastPresetSelectorProps = null;
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
    registry.saveModels([]);
    updateSettings({
      activePresetId: 'preset-1',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      modelParamsByModelId: {
        'author/model-q4': {
          temperature: 0.7,
          topP: 0.6,
          maxTokens: 1024,
          reasoningEnabled: false,
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
            reasoningEnabled: false,
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

    const { getByTestId, getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.statusGenerating')).toBeTruthy();
    fireEvent.press(getByTestId('stop-button'));
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('keeps header actions visible but disabled while a response is generating', () => {
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

    fireEvent.press(getByTestId('new-chat-button'));
    fireEvent.press(getByTestId('model-controls-button'));

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
    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/models');
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
    expect(mockRouterPush).toHaveBeenCalledWith({
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

  it('resets a single generation parameter from the model controls sheet', () => {
    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.topP).toBe(0.6);

    fireEvent.press(getByTestId('model-controls-button'));
    fireEvent.press(getByTestId('reset-top-p-button'));
    rerender(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.topP).toBe(0.9);
  });

  it('updates the active thread reasoning toggle from the model controls sheet', () => {
    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEnabled).not.toBe(true);

    fireEvent.press(getByTestId('model-controls-button'));
    fireEvent.press(getByTestId('enable-reasoning-button'));
    rerender(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEnabled).toBe(true);
  });
});
