import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ChatInputBar } from '../../src/components/ui/ChatInputBar';
import { screenChromeTokens } from '../../src/utils/themeTokens';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

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

  it('uses standardized chrome padding tokens for the composer container', () => {
    const onSendMessage = jest.fn();
    const { getByTestId } = render(
      <ChatInputBar onSendMessage={onSendMessage} />,
    );
    const container = getByTestId('chat-input-bar-container');

    expect(container.props.className).toContain(screenChromeTokens.contentHorizontalPaddingClassName);
    expect(container.props.className).toContain(screenChromeTokens.bottomBarVerticalPaddingClassName);
    expect(flattenStyle(container.props.style)).toBeUndefined();
  });

  it('centers single-line composer text without extra vertical padding', () => {
    const onSendMessage = jest.fn();
    const { getByPlaceholderText } = render(
      <ChatInputBar onSendMessage={onSendMessage} />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');

    expect(input.props.textAlignVertical).toBe('center');
    expect(input.props.className).toContain('py-0');
    expect(input.props.className).not.toContain('leading-5');
  });
});
