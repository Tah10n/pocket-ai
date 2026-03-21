import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ChatMessageBubble } from '../../src/components/ui/ChatMessageBubble';
import * as Clipboard from 'expo-clipboard';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('../../src/components/ui/MarkdownRenderer', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MarkdownRenderer: ({ content }: any) => mockReact.createElement(Text, { testID: 'markdown-renderer' }, content),
  };
});

jest.mock('../../src/components/ui/StreamingCursor', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    StreamingCursor: () => mockReact.createElement(Text, null, '|'),
  };
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
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

describe('ChatMessageBubble', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps user messages as plain text', () => {
    const { getByText, queryByTestId } = render(
      <ChatMessageBubble id="user-1" isUser content="Hello user" />,
    );

    expect(getByText('Hello user')).toBeTruthy();
    expect(queryByTestId('markdown-renderer')).toBeNull();
  });

  it('renders assistant messages through the markdown renderer when stable', () => {
    const { getByTestId } = render(
      <ChatMessageBubble id="assistant-1" isUser={false} content={'**formatted**'} isStreaming={false} />,
    );

    expect(getByTestId('markdown-renderer')).toBeTruthy();
  });

  it('copies a message from the action row', () => {
    const { getByTestId } = render(
      <ChatMessageBubble id="assistant-1" isUser={false} content="Copy this" />,
    );

    fireEvent.press(getByTestId('copy-message-assistant-1'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Copy this');
  });

  it('renders regenerate and delete actions for eligible user messages', () => {
    const onRegenerate = jest.fn();
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <ChatMessageBubble
        id="user-1"
        isUser
        content="Try again"
        canRegenerate
        canDelete
        onRegenerate={onRegenerate}
        onDelete={onDelete}
      />,
    );

    fireEvent.press(getByTestId('regenerate-message-user-1'));
    fireEvent.press(getByTestId('delete-message-user-1'));

    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
