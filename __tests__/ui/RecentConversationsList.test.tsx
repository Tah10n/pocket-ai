import React from 'react';
import { render } from '@testing-library/react-native';
import { RecentConversationsList } from '../../src/components/ui/RecentConversationsList';
import { useChatStore } from '../../src/store/chatStore';
import { ChatThread } from '../../src/types/chat';

jest.mock('@shopify/flash-list', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    FlashList: ({ data, renderItem, keyExtractor, ItemSeparatorComponent }: any) =>
      mockReact.createElement(
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
      ),
  };
});

jest.mock('../../src/store/chatStore', () => ({
  useChatStore: jest.fn(),
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

const mockUseChatStore = useChatStore as jest.MockedFunction<typeof useChatStore>;

function createThread(index: number, updatedAt: number): ChatThread {
  return {
    id: `thread-${index}`,
    title: `Conversation ${index}`,
    modelId: `openai/model-${index}`,
    presetId: null,
    presetSnapshot: {
      id: null,
      name: 'Default',
      systemPrompt: '',
    },
    paramsSnapshot: {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 512,
    },
    messages: [
      {
        id: `message-${index}`,
        role: 'user',
        content: `Message ${index}`,
        createdAt: updatedAt,
        state: 'complete',
      },
    ],
    createdAt: updatedAt,
    updatedAt,
    status: 'idle',
  };
}

describe('RecentConversationsList', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders only the recent slice and shows See All when more conversations exist', () => {
    const threads = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => {
        const thread = createThread(index + 1, 1_000_000 - index * 60_000);
        return [thread.id, thread];
      }),
    );

    mockUseChatStore.mockImplementation((selector: any) =>
      selector({
        threads,
      }),
    );

    const { getByText, queryByText } = render(<RecentConversationsList onViewAllConversations={jest.fn()} />);

    expect(getByText('Conversation 1')).toBeTruthy();
    expect(getByText('Conversation 2')).toBeTruthy();
    expect(getByText('Conversation 3')).toBeTruthy();
    expect(getByText('Conversation 4')).toBeTruthy();
    expect(getByText('Conversation 5')).toBeTruthy();
    expect(queryByText('Conversation 6')).toBeNull();
    expect(getByText('home.seeAll')).toBeTruthy();
  });
});

