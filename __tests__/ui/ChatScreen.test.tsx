import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

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
const mockOpenThread = jest.fn();
const mockDeleteMessage = jest.fn();
const mockStop = jest.fn();
const mockCreateSummaryPlaceholder = jest.fn();
const mockRouterPush = jest.fn();
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

jest.mock('../../src/components/ui/ChatHeader', () => {
  const mockReact = require('react');
  const { Text, Pressable, View } = require('react-native');

  return {
    ChatHeader: ({
      title,
      canStartNewChat,
      onStartNewChat,
      statusLabel,
      badgeLabel,
      detailLabel,
      onMenu,
      onOpenModelControls,
    }: any) =>
      mockReact.createElement(
        View,
        null,
        mockReact.createElement(Text, null, title),
        badgeLabel ? mockReact.createElement(Text, null, badgeLabel) : null,
        detailLabel ? mockReact.createElement(Text, null, detailLabel) : null,
        statusLabel ? mockReact.createElement(Text, null, statusLabel) : null,
        canStartNewChat
          ? mockReact.createElement(
              Pressable,
              { testID: 'new-chat-button', onPress: onStartNewChat },
              mockReact.createElement(Text, null, 'New chat'),
            )
          : null,
        mockReact.createElement(
          Pressable,
          { testID: 'menu-button', onPress: onMenu },
          mockReact.createElement(Text, null, 'Menu'),
        ),
        onOpenModelControls
          ? mockReact.createElement(
              Pressable,
              { testID: 'model-controls-button', onPress: onOpenModelControls },
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

jest.mock('../../src/components/ui/ConversationSwitcherSheet', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    ConversationSwitcherSheet: ({ visible, conversations, onSelectConversation, onOpenPresetSelector }: any) =>
      visible
        ? mockReact.createElement(
            View,
            { testID: 'conversation-switcher' },
            onOpenPresetSelector
              ? mockReact.createElement(
                  Pressable,
                  {
                    testID: 'open-preset-selector',
                    onPress: onOpenPresetSelector,
                  },
                  mockReact.createElement(Text, null, 'Presets'),
                )
              : null,
            conversations.map((conversation: any) =>
              mockReact.createElement(
                Pressable,
                {
                  key: conversation.id,
                  testID: `conversation-option-${conversation.id}`,
                  onPress: () => onSelectConversation(conversation.id),
                },
                mockReact.createElement(Text, null, conversation.title),
              ),
            ),
          )
        : null,
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
    ModelParametersSheet: ({ visible, onResetParamField }: any) =>
      visible
        ? mockReact.createElement(
            View,
            { testID: 'model-parameters-sheet' },
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
    conversationIndex: require('../../src/store/chatStore').useChatStore.getState().getConversationIndex(),
    deleteMessage: mockDeleteMessage,
    deleteThread: jest.fn(),
    openThread: mockOpenThread,
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

const { ChatScreen, getNextShouldStickToBottom } = require('../../src/ui/screens/ChatScreen');
const { useChatStore } = require('../../src/store/chatStore');
const { updateSettings } = require('../../src/services/SettingsStore');

describe('ChatScreen', () => {
  beforeEach(() => {
    mockRegenerateFromUserMessage.mockClear();
    mockOpenThread.mockClear();
    mockDeleteMessage.mockClear();
    mockStop.mockClear();
    mockCreateSummaryPlaceholder.mockClear();
    mockRouterPush.mockClear();
    mockStartNewChat.mockClear();
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

  it('renders messages from the restored active thread', () => {
    const { getByText } = render(React.createElement(ChatScreen));

    expect(getByText('Restored conversation')).toBeTruthy();
    expect(getByText('Helpful Assistant')).toBeTruthy();
    expect(getByText('T0.7 • TopP 0.6 • 1024 tok')).toBeTruthy();
    expect(getByText('Saved user prompt')).toBeTruthy();
    expect(getByText('Saved assistant reply')).toBeTruthy();
  });

  it('starts message-scoped regenerate flow from a user bubble', async () => {
    const { getByTestId, getByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('regenerate-message-message-1'));
    expect(getByText('chat.editEarlierMessage')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });
    expect(mockRegenerateFromUserMessage).toHaveBeenCalledWith('message-1', 'Edited from test');
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

  it('hides regenerate control when the engine is not ready', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };

    const { queryByTestId, getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.loadModelWarning')).toBeTruthy();
    expect(queryByTestId('regenerate-message-message-1')).toBeNull();
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

  it('opens the conversation switcher and selects another thread', () => {
    useChatStore.setState({
      threads: {
        ...useChatStore.getState().threads,
        'thread-2': {
          ...useChatStore.getState().threads['thread-1'],
          id: 'thread-2',
          title: 'Another conversation',
          messages: [
            {
              id: 'message-4',
              role: 'user',
              content: 'Another thread',
              createdAt: 4,
              state: 'complete',
            },
          ],
          updatedAt: 4,
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('menu-button'));
    fireEvent.press(getByTestId('conversation-option-thread-2'));

    expect(mockOpenThread).toHaveBeenCalledWith('thread-2');
  });

  it('opens preset selection from the overflow sheet and updates the active thread preset', () => {
    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('menu-button'));
    fireEvent.press(getByTestId('open-preset-selector'));
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

    fireEvent.press(getByTestId('menu-button'));
    fireEvent.press(getByTestId('open-preset-selector'));

    expect(lastPresetSelectorProps?.activePresetId).toBe('preset-1');
  });

  it('allows resetting the preset back to the default state', () => {
    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('menu-button'));
    fireEvent.press(getByTestId('open-preset-selector'));
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
    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    expect(getByText('T0.7 • TopP 0.6 • 1024 tok')).toBeTruthy();

    fireEvent.press(getByTestId('model-controls-button'));
    fireEvent.press(getByTestId('reset-top-p-button'));
    rerender(React.createElement(ChatScreen));

    expect(getByText('T0.7 • TopP 0.9 • 1024 tok')).toBeTruthy();
    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.topP).toBe(0.9);
  });
});
