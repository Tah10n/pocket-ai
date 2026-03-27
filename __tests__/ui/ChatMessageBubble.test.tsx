import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { ChatMessageBubble } from '../../src/components/ui/ChatMessageBubble';

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
    StreamingCursor: () => mockReact.createElement(Text, { testID: 'streaming-cursor' }, '|'),
  };
});

jest.mock('../../src/components/ui/ThinkingPulse', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    ThinkingPulse: () => mockReact.createElement(Text, { testID: 'thinking-pulse' }, 'pulse'),
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
    expect(getByTestId('message-bubble-shell-assistant-1').props.className).toContain('px-3 py-1.5');
  });

  it('renders a persisted thought disclosure and copies only the final markdown', async () => {
    const content = '<think>internal chain</think>\n\n**Visible answer**\n\n- bullet';
    const finalContent = '**Visible answer**\n\n- bullet';
    const { getByTestId, getByText, queryByTestId } = render(
      <ChatMessageBubble id="assistant-2" isUser={false} content={content} />,
    );

    expect(getByText(finalContent)).toBeTruthy();
    expect(queryByTestId('thought-panel-assistant-2')).toBeNull();

    fireEvent.press(getByTestId('thought-toggle-assistant-2'));

    expect(getByTestId('thought-panel-assistant-2')).toBeTruthy();
    expect(getByText('internal chain')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('copy-message-assistant-2'));
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(finalContent);
  });

  it('keeps explicit thought content out of the main assistant message', async () => {
    const { getByTestId, getByText, queryByText } = render(
      <ChatMessageBubble
        id="assistant-explicit"
        isUser={false}
        content="Visible answer"
        thoughtContent="Hidden reasoning"
      />,
    );

    expect(getByText('Visible answer')).toBeTruthy();
    expect(queryByText('Hidden reasoning')).toBeNull();

    fireEvent.press(getByTestId('thought-toggle-assistant-explicit'));

    expect(getByText('Hidden reasoning')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('copy-message-assistant-explicit'));
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Visible answer');
  });

  it('shows a live thought panel while the assistant is still reasoning', () => {
    const content = '<think>Planning the answer step by step';
    const { getByTestId, getByText, queryByTestId } = render(
      <ChatMessageBubble id="assistant-3" isUser={false} content={content} isStreaming />,
    );

    expect(getByTestId('thinking-pulse')).toBeTruthy();
    expect(queryByTestId('copy-message-assistant-3')).toBeNull();

    fireEvent.press(getByTestId('thought-toggle-assistant-3'));

    expect(getByTestId('thought-panel-assistant-3')).toBeTruthy();
    expect(getByText(/Planning the answer step by step/)).toBeTruthy();
    expect(getByTestId('streaming-cursor')).toBeTruthy();
  });

  it('keeps a normal streaming bubble when no reasoning trace is present', () => {
    const { queryByTestId, getByText } = render(
      <ChatMessageBubble id="assistant-4" isUser={false} content="Drafting the answer" isStreaming />,
    );

    expect(getByText(/Drafting the answer/)).toBeTruthy();
    expect(queryByTestId('thinking-pulse')).toBeNull();
    expect(queryByTestId('thought-toggle-assistant-4')).toBeNull();
    expect(queryByTestId('thought-panel-assistant-4')).toBeNull();
  });

  it('uses a compact placeholder shell before a non-reasoning streaming reply has visible text', () => {
    const { getByTestId, queryByTestId } = render(
      <ChatMessageBubble id="assistant-empty" isUser={false} content="" isStreaming />,
    );

    expect(getByTestId('streaming-cursor')).toBeTruthy();
    expect(queryByTestId('thought-toggle-assistant-empty')).toBeNull();
    expect(getByTestId('message-bubble-shell-assistant-empty').props.className).toContain('px-3 py-1.5');
  });

  it('treats leading blank lines as empty visible content while streaming', () => {
    const { getByTestId, queryByText } = render(
      <ChatMessageBubble id="assistant-blank-lines" isUser={false} content={'\n\n'} isStreaming />,
    );

    expect(getByTestId('message-bubble-shell-assistant-blank-lines').props.className).toContain('px-3 py-1.5');
    expect(queryByText(/\n/)).toBeNull();
  });

  it('keeps the performance label in the metadata row after assistant generation completes', () => {
    const { getByTestId } = render(
      <ChatMessageBubble
        id="assistant-5"
        isUser={false}
        content="Done"
        isStreaming={false}
        canDelete
        onDelete={jest.fn()}
        tokensPerSec={12.34}
      />,
    );

    const metadataRow = getByTestId('message-metadata-assistant-5');

    expect(within(metadataRow).getByTestId('delete-message-assistant-5')).toBeTruthy();
    expect(within(metadataRow).getByTestId('performance-label-assistant-5')).toBeTruthy();
    expect(within(metadataRow).getByText('12.3 t/s')).toBeTruthy();
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
