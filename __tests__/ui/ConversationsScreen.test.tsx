import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConversationsScreen } from '../../src/ui/screens/ConversationsScreen';
import { useChatSession } from '../../src/hooks/useChatSession';

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
}));

jest.mock('@shopify/flash-list', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    FlashList: ({ data, renderItem, keyExtractor, ItemSeparatorComponent, ListEmptyComponent }: any) =>
      data.length > 0
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

jest.mock('../../src/hooks/useChatSession', () => ({
  useChatSession: jest.fn(),
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');

  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('@/components/ui/input', () => {
  const mockReact = require('react');
  const { View, TextInput } = require('react-native');

  return {
    Input: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    InputField: (props: any) => mockReact.createElement(TextInput, props),
  };
});

const mockUseChatSession = useChatSession as jest.MockedFunction<typeof useChatSession>;

describe('ConversationsScreen', () => {
  it('filters conversations and saves a renamed title', () => {
    const renameThread = jest.fn();

    mockUseChatSession.mockReturnValue({
      activeThread: null,
      conversationIndex: [
        {
          id: 'thread-1',
          title: 'Shopping ideas',
          updatedAt: 1_000_000,
          modelId: 'author/model-a',
          presetId: null,
          messageCount: 3,
          lastMessagePreview: 'Groceries and meal prep',
        },
        {
          id: 'thread-2',
          title: 'Sprint retro notes',
          updatedAt: 900_000,
          modelId: 'author/model-b',
          presetId: null,
          messageCount: 5,
          lastMessagePreview: 'Action items for next week',
        },
      ],
      messages: [],
      isGenerating: false,
      shouldOfferSummary: false,
      truncatedMessageCount: 0,
      appendUserMessage: jest.fn(),
      deleteMessage: jest.fn(),
      deleteThread: jest.fn(),
      renameThread,
      openThread: jest.fn(),
      stopGeneration: jest.fn(),
      regenerateFromUserMessage: jest.fn(),
      regenerateLastResponse: jest.fn(),
      createSummaryPlaceholder: jest.fn(),
      startNewChat: jest.fn(),
    } as any);

    const { getByTestId, getByText, queryByText } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <ConversationsScreen />
      </SafeAreaProvider>,
    );

    fireEvent.changeText(getByTestId('conversation-search-input'), 'sprint');

    expect(getByText('Sprint retro notes')).toBeTruthy();
    expect(queryByText('Shopping ideas')).toBeNull();

    fireEvent.press(getByTestId('rename-conversation-thread-2'));
    fireEvent.changeText(getByTestId('rename-input-thread-2'), 'Renamed Retro');
    fireEvent.press(getByTestId('save-rename-thread-2'));

    expect(renameThread).toHaveBeenCalledWith('thread-2', 'Renamed Retro');
  });
});
