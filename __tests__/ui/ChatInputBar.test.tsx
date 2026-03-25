import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ChatInputBar } from '../../src/components/ui/ChatInputBar';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  }),
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

describe('ChatInputBar', () => {
  it('sends the message when the input submits', async () => {
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    const { getByPlaceholderText } = render(
      <ChatInputBar onSendMessage={onSendMessage} />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');

    fireEvent.changeText(input, 'Hello from enter');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Hello from enter',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('Hello from enter');
    });

    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('');
  });
});
