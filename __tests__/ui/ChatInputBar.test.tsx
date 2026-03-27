import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  ChatInputBar,
  getComposerContainerPadding,
} from '../../src/components/ui/ChatInputBar';

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
  function flattenStyle(style: unknown) {
    if (!Array.isArray(style)) {
      return style as Record<string, unknown>;
    }

    return style.reduce<Record<string, unknown>>((acc, entry) => {
      if (entry && typeof entry === 'object') {
        Object.assign(acc, entry);
      }

      return acc;
    }, {});
  }

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

  it('clears the input immediately while an async send is still pending', async () => {
    let resolveSend!: () => void;
    const onSendMessage = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));

    const { getByPlaceholderText } = render(
      <ChatInputBar onSendMessage={onSendMessage} />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');

    fireEvent.changeText(input, 'Hold while sending');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Hold while sending',
      },
    });

    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('');

    resolveSend();
    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('Hold while sending');
    });
  });

  it('keeps composer bottom padding larger than top padding', () => {
    const onSendMessage = jest.fn();
    const { getByTestId } = render(
      <ChatInputBar onSendMessage={onSendMessage} />,
    );
    const expectedPadding = getComposerContainerPadding(0);
    const style = flattenStyle(getByTestId('chat-input-bar-container').props.style);

    expect(style).toEqual(
      expect.objectContaining({
        paddingBottom: expectedPadding.paddingBottom,
        paddingTop: expectedPadding.paddingTop,
      }),
    );
    expect((style.paddingBottom as number) > (style.paddingTop as number)).toBe(true);
  });

  it('preserves large bottom safe-area insets instead of capping them away', () => {
    expect(getComposerContainerPadding(34)).toEqual({
      paddingTop: 5,
      paddingBottom: 49,
    });
  });
});
