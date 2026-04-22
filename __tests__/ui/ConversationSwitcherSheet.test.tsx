import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

const mockWithTiming = jest.fn((value: unknown, _config?: unknown) => value);
let mockMotionPreferences = {
  motionPreset: 'full',
  sheetDurationMs: 0,
};

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');

  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');

  return {
    __esModule: true,
    default: {
      createAnimatedComponent: () => View,
    },
    Easing: {
      out: (value: unknown) => value,
      ease: 'ease',
      cubic: 'cubic',
    },
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (updater: () => unknown) => updater(),
    withTiming: (value: unknown, config: unknown) => mockWithTiming(value, config),
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');

  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('@/components/ui/scroll-view', () => {
  const mockReact = require('react');
  const { ScrollView } = require('react-native');

  return {
    ScrollView: ({ children, ...props }: any) => mockReact.createElement(ScrollView, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: () => null,
}));

jest.mock('../../src/hooks/useDeviceMetrics', () => ({
  useMotionPreferences: () => mockMotionPreferences,
}));

const { ConversationSwitcherSheet } = require('../../src/components/ui/ConversationSwitcherSheet');
const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

describe('ConversationSwitcherSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMotionPreferences = {
      motionPreset: 'full',
      sheetDurationMs: 0,
    };
    reactI18nextMock.__resetTranslations();
    reactI18nextMock.__setTranslationOverride('chat.messageCount', '{{count}} messages');
    reactI18nextMock.__setTranslationOverride('chat.conversationSwitcher.presetCurrent', 'Preset: {{name}}');
    reactI18nextMock.__setTranslationOverride('common.default', 'Default');
  });

  it('starts a new chat from the shared action area', () => {
    const onClose = jest.fn();
    const onStartNewChat = jest.fn();

    const { getByText } = render(
      React.createElement(ConversationSwitcherSheet, {
        visible: true,
        activeThreadId: null,
        conversations: [],
        onClose,
        onSelectConversation: jest.fn(),
        onStartNewChat,
      }),
    );

    fireEvent.press(getByText('chat.conversationSwitcher.startNewChat'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStartNewChat).toHaveBeenCalledTimes(1);
  });

  it('renders shortened model labels in conversation descriptions', () => {
    const { getByText } = render(
      React.createElement(ConversationSwitcherSheet, {
        visible: true,
        activeThreadId: 'thread-1',
        conversations: [
          {
            id: 'thread-1',
            title: 'Thread one',
            updatedAt: 1,
            modelId: 'author/model-q4',
            presetId: null,
            messageCount: 3,
            lastMessagePreview: 'Latest reply',
          },
        ],
        onClose: jest.fn(),
        onSelectConversation: jest.fn(),
        onStartNewChat: jest.fn(),
      }),
    );

    expect(getByText('Thread one')).toBeTruthy();
    expect(getByText('model-q4 • 3 messages')).toBeTruthy();
    expect(getByText('Latest reply')).toBeTruthy();
  });

  it('selects a conversation and closes the sheet', () => {
    const onClose = jest.fn();
    const onSelectConversation = jest.fn();

    const { getByTestId } = render(
      React.createElement(ConversationSwitcherSheet, {
        visible: true,
        activeThreadId: null,
        conversations: [
          {
            id: 'thread-1',
            title: 'Thread one',
            updatedAt: 1,
            modelId: 'author/model-q4',
            presetId: null,
            messageCount: 3,
            lastMessagePreview: 'Latest reply',
          },
        ],
        onClose,
        onSelectConversation,
        onStartNewChat: jest.fn(),
      }),
    );

    fireEvent.press(getByTestId('conversation-option-thread-1'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectConversation).toHaveBeenCalledWith('thread-1');
  });

  it('opens manage conversations and the preset selector from the action area', () => {
    const onClose = jest.fn();
    const onManageConversations = jest.fn();
    const onOpenPresetSelector = jest.fn();

    const screen = render(
      React.createElement(ConversationSwitcherSheet, {
        visible: true,
        activeThreadId: null,
        conversations: [],
        activePresetName: 'Research Analyst',
        onClose,
        onSelectConversation: jest.fn(),
        onStartNewChat: jest.fn(),
        onManageConversations,
        onOpenPresetSelector,
      }),
    );

    fireEvent.press(screen.getByText('common.manage'));
    fireEvent.press(screen.getByTestId('conversation-switcher-preset-card'));

    expect(onManageConversations).toHaveBeenCalledTimes(1);
    expect(onOpenPresetSelector).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Preset: Research Analyst')).toBeTruthy();
  });

  it('shows the blocked preset state when the preset selector is disabled', () => {
    const onClose = jest.fn();
    const onOpenPresetSelector = jest.fn();
    const screen = render(
      React.createElement(ConversationSwitcherSheet, {
        visible: true,
        activeThreadId: null,
        conversations: [],
        canOpenPresetSelector: false,
        onClose,
        onSelectConversation: jest.fn(),
        onStartNewChat: jest.fn(),
        onOpenPresetSelector,
      }),
    );

    expect(screen.getByText('chat.conversationSwitcher.presetBlocked')).toBeTruthy();
    expect(screen.getByTestId('conversation-switcher-preset-card').props.className).toContain('border-outline-100');

    fireEvent.press(screen.getByTestId('conversation-switcher-preset-card'));

    expect(onOpenPresetSelector).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to the default preset name when no active preset is supplied', () => {
    const screen = render(
      React.createElement(ConversationSwitcherSheet, {
        visible: true,
        activeThreadId: null,
        conversations: [],
        onClose: jest.fn(),
        onSelectConversation: jest.fn(),
        onStartNewChat: jest.fn(),
        onOpenPresetSelector: jest.fn(),
      }),
    );

    expect(screen.getByText('Preset: Default')).toBeTruthy();
  });

  it('uses the raw model id fallback in conversation descriptions', () => {
    mockMotionPreferences = {
      motionPreset: 'reduced',
      sheetDurationMs: 0,
    };

    const screen = render(
      React.createElement(ConversationSwitcherSheet, {
        visible: true,
        activeThreadId: null,
        conversations: [
          {
            id: 'thread-raw-id',
            title: 'Raw model thread',
            updatedAt: 1,
            modelId: '///',
            presetId: null,
            messageCount: 2,
            lastMessagePreview: 'Preview',
          },
        ],
        onClose: jest.fn(),
        onSelectConversation: jest.fn(),
        onStartNewChat: jest.fn(),
      }),
    );

    expect(screen.getByText('/// • 2 messages')).toBeTruthy();
  });

  it('uses the reduced-motion hidden translation path when the sheet is closed', () => {
    mockMotionPreferences = {
      motionPreset: 'reduced',
      sheetDurationMs: 0,
    };

    render(
      React.createElement(ConversationSwitcherSheet, {
        visible: false,
        activeThreadId: null,
        conversations: [],
        onClose: jest.fn(),
        onSelectConversation: jest.fn(),
        onStartNewChat: jest.fn(),
      }),
    );

    expect(mockWithTiming).toHaveBeenCalledTimes(2);
    expect(mockWithTiming.mock.calls[0]).toEqual([0, expect.objectContaining({ duration: 0 })]);
    expect(mockWithTiming.mock.calls[1]).toEqual([0, expect.objectContaining({ duration: 0 })]);
  });

  it('uses the full-motion hidden translation offset when the sheet is closed', () => {
    mockMotionPreferences = {
      motionPreset: 'full',
      sheetDurationMs: 0,
    };

    render(
      React.createElement(ConversationSwitcherSheet, {
        visible: false,
        activeThreadId: null,
        conversations: [],
        onClose: jest.fn(),
        onSelectConversation: jest.fn(),
        onStartNewChat: jest.fn(),
      }),
    );

    expect(mockWithTiming).toHaveBeenCalledTimes(2);
    expect(mockWithTiming.mock.calls[0]).toEqual([0, expect.objectContaining({ duration: 0 })]);
    expect(mockWithTiming.mock.calls[1]).toEqual([28, expect.objectContaining({ duration: 0 })]);
  });
});
