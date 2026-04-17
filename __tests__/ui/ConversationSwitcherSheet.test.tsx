import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

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
    withTiming: (value: unknown) => value,
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
  useMotionPreferences: () => ({
    motionPreset: 'full',
    sheetDurationMs: 0,
  }),
}));

const { ConversationSwitcherSheet } = require('../../src/components/ui/ConversationSwitcherSheet');

describe('ConversationSwitcherSheet', () => {
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
});
