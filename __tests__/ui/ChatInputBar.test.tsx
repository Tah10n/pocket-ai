import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Text as RNText } from 'react-native';
import {
  ChatInputBar,
  getGlassComposerCapsuleStyle,
  getModeBannerGlassStyle,
  getPrimaryActionGlassStyle,
} from '../../src/components/ui/ChatInputBar';
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

  it('does not render a full-width shaded chrome strip behind the composer', () => {
    const onSendMessage = jest.fn();
    const { getByTestId } = render(
      <ChatInputBar onSendMessage={onSendMessage} />,
    );
    const container = getByTestId('chat-input-bar-container');

    expect(container.props.className).not.toContain('bg-background');
    expect(container.props.className).not.toContain('border-t');
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

  it('renders optional leading, trailing, and attachments slots for structural preview states', () => {
    const onSendMessage = jest.fn();
    const { getByTestId, queryByText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        leadingActions={<RNText testID="leading-action">leading</RNText>}
        trailingActions={<RNText testID="custom-trailing">custom</RNText>}
        attachmentsTray={<RNText testID="attachments-tray">attachments</RNText>}
      />,
    );

    expect(getByTestId('chat-input-bar-leading-actions')).toBeTruthy();
    expect(getByTestId('chat-input-bar-trailing-actions')).toBeTruthy();
    expect(getByTestId('chat-input-bar-attachments-tray')).toBeTruthy();
    expect(getByTestId('chat-input-bar-row').props.className).toContain('flex-row');
    expect(queryByText('arrow-upward')).toBeNull();
  });

  it('derives glass primary action colors from the active primary token', () => {
    expect(getPrimaryActionGlassStyle('#2563eb', 'light')).toEqual({
      backgroundColor: 'rgba(37, 99, 235, 0.1)',
      borderWidth: 0,
    });
    expect(getPrimaryActionGlassStyle('#38bdf8', 'dark')).toEqual({
      backgroundColor: 'rgba(56, 189, 248, 0.22)',
      borderWidth: 0,
    });
  });

  it('softens dark glass composer and mode banner shells without changing light-mode fallbacks', () => {
    expect(getGlassComposerCapsuleStyle('#020617', '#475569', 'light')).toEqual({
      borderRadius: 999,
    });
    expect(getGlassComposerCapsuleStyle('#f7fbff', '#475569', 'dark')).toEqual({
      backgroundColor: 'rgba(247, 251, 255, 0.1)',
      borderColor: 'rgba(71, 85, 105, 0.28)',
      borderRadius: 999,
      borderWidth: 1,
    });
    expect(getModeBannerGlassStyle('#020617', '#60a5fa', 'light')).toBeUndefined();
    expect(getModeBannerGlassStyle('#f7fbff', '#60a5fa', 'dark')).toEqual({
      backgroundColor: 'rgba(247, 251, 255, 0.09)',
      borderColor: 'rgba(96, 165, 250, 0.26)',
      borderWidth: 1,
    });
  });
});
