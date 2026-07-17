import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { ChatMessageBubble } from '../../src/components/ui/ChatMessageBubble';
import { StaticThemeProvider } from '../../src/providers/ThemeProvider';
import { copiedImageAttachment, secondCopiedImageAttachment } from '../fixtures/chatImageAttachmentFixtures';

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

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
    MarkdownRenderer: ({ content, selectable }: any) => mockReact.createElement(
      Text,
      {
        testID: 'markdown-renderer',
        selectableProp: selectable,
      },
      content,
    ),
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
    composeTextRole: (_role: string, className = '') => className,
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
    reactI18nextMock.__resetTranslations();
    reactI18nextMock.__setTranslationOverride(
      'chat.inferenceMetrics.mtpAccepted',
      'MTP {{accepted}}/{{drafted}} · {{percent}}%',
    );
    reactI18nextMock.__setTranslationOverride('chat.inferenceMetrics.mtpNotUsed', 'MTP not used');
    reactI18nextMock.__setTranslationOverride('chat.inferenceMetrics.ttft', 'TTFT {{milliseconds}} ms');
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1024 });
  });

  it('keeps user messages as plain text', () => {
    const { getByText, queryByTestId } = render(
      <ChatMessageBubble id="user-1" isUser content="Hello user" />,
    );

    expect(getByText('Hello user')).toBeTruthy();
    expect(queryByTestId('markdown-renderer')).toBeNull();
  });

  it('renders glass user messages as framed translucent primary surfaces', () => {
    const { getByTestId, getByText } = render(
      <StaticThemeProvider themeId="glass" resolvedMode="dark">
        <ChatMessageBubble id="glass-user" isUser content="Hello glass" />
      </StaticThemeProvider>,
    );
    const shell = getByTestId('message-bubble-shell-glass-user');
    const text = getByText('Hello glass');

    expect(shell.props.className).toContain('relative overflow-hidden');
    expect(shell.props.className).toContain('bg-primary-500/22');
    expect(shell.props.className).not.toContain('bg-primary-500/80');
    expect(shell.props.className).not.toContain('bg-primary-600');
    expect(StyleSheet.flatten(shell.props.style)).toMatchObject({
      borderWidth: 0,
      elevation: 0,
      shadowOpacity: 0,
    });
    expect(StyleSheet.flatten(shell.props.style)?.backgroundColor).toMatch(/^rgba/);
    expect(text.props.className).toContain('dark:text-primary-100');
  });

  it('renders assistant messages through the markdown renderer when stable', () => {
    const { getByTestId } = render(
      <ChatMessageBubble id="assistant-1" isUser={false} content={'**formatted**'} isStreaming={false} />,
    );

    expect(getByTestId('markdown-renderer')).toBeTruthy();
    expect(getByTestId('markdown-renderer').props.selectableProp).toBe(true);
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

  it('renders a thinking-tag disclosure and keeps tags out of the visible answer', async () => {
    const content = '<thinking>internal chain</thinking>\n\n**Visible answer**\n\n- bullet';
    const finalContent = '**Visible answer**\n\n- bullet';
    const { getByTestId, getByText, queryByText } = render(
      <ChatMessageBubble id="assistant-thinking" isUser={false} content={content} />,
    );

    expect(getByText(finalContent)).toBeTruthy();
    expect(queryByText(/<thinking>/i)).toBeNull();

    fireEvent.press(getByTestId('thought-toggle-assistant-thinking'));

    expect(getByText('internal chain')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('copy-message-assistant-thinking'));
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(finalContent);
  });

  it('keeps explicit thought content out of the main assistant message', async () => {
    const { getByTestId, getByText, queryByText } = render(
      <ChatMessageBubble
        id="assistant-explicit"
        isUser={false}
        content="<think>Hidden reasoning</think>Visible answer"
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

  it('shows a live thought panel for an unclosed thinking tag while streaming', () => {
    const content = '<thinking>Planning the answer step by step';
    const { getByTestId, getByText, queryByText } = render(
      <ChatMessageBubble id="assistant-thinking-stream" isUser={false} content={content} isStreaming />,
    );

    expect(queryByText(/<thinking>/i)).toBeNull();

    fireEvent.press(getByTestId('thought-toggle-assistant-thinking-stream'));

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

  it('prefers native throughput and shows MTP acceptance with TTFT', () => {
    const { getByTestId, getByText } = render(
      <ChatMessageBubble
        id="assistant-mtp"
        isUser={false}
        content="Done"
        tokensPerSec={4.2}
        inferenceMetrics={{
          tokensPredicted: 100,
          tokensEvaluated: 20,
          predictedPerSecond: 6.5,
          timeToFirstTokenMs: 910,
          mtp: {
            requested: true,
            attempted: true,
            fallbackUsed: false,
            draftTokens: 40,
            draftTokensAccepted: 18,
            acceptanceRate: 0.45,
          },
        }}
      />,
    );

    expect(getByText('6.5 t/s')).toBeTruthy();
    expect(getByTestId('mtp-telemetry-assistant-mtp')).toBeTruthy();
    expect(getByText('MTP 18/40 · 45%')).toBeTruthy();
    expect(getByTestId('ttft-telemetry-assistant-mtp')).toBeTruthy();
    expect(getByText('TTFT 910 ms')).toBeTruthy();
  });

  it('does not present zero draft counters as MTP acceptance when the request was not attempted', () => {
    const { getByText, queryByText } = render(
      <ChatMessageBubble
        id="assistant-mtp-not-used"
        isUser={false}
        content="Done with media"
        inferenceMetrics={{
          tokensPredicted: 12,
          tokensEvaluated: 8,
          predictedPerSecond: 3.5,
          mtp: {
            requested: true,
            attempted: false,
            fallbackUsed: false,
            draftTokens: 0,
            draftTokensAccepted: 0,
          },
        }}
      />,
    );

    expect(getByText('MTP not used')).toBeTruthy();
    expect(queryByText('MTP 0/0 · 0%')).toBeNull();
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

  it('renders persisted user attachment thumbnails from local storage', async () => {
    const { __setTranslationOverride } = jest.requireMock('react-i18next') as {
      __setTranslationOverride: (key: string, value: string) => void;
    };
    __setTranslationOverride(
      'chat.attachments.messagePreviewIndexedAccessibilityLabel',
      'Message image {{index}} of {{count}} preview',
    );
    const attachmentWithThumbnail = {
      ...copiedImageAttachment,
      thumbnailUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-1-thumb.jpg',
    };
    const { findByTestId, getByLabelText, getByText } = render(
      <ChatMessageBubble
        id="user-attachment"
        isUser
        content="Describe this"
        attachments={[attachmentWithThumbnail]}
      />,
    );

    expect(getByText('Describe this')).toBeTruthy();
    expect((await findByTestId(`message-attachment-image-user-attachment-${copiedImageAttachment.id}`)).props.source).toEqual({
      uri: attachmentWithThumbnail.thumbnailUri,
    });
    expect(getByLabelText('Message image 1 of 1 preview')).toBeTruthy();
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });

  it('falls back to the original persisted attachment when thumbnail decoding fails', async () => {
    const attachmentWithCorruptThumbnail = {
      ...copiedImageAttachment,
      thumbnailUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-1-thumb.jpg',
    };

    const { findByTestId, getByTestId, queryByTestId } = render(
      <ChatMessageBubble
        id="user-attachment-thumbnail-corrupt"
        isUser
        content="Describe this"
        attachments={[attachmentWithCorruptThumbnail]}
      />,
    );

    const imageTestId = `message-attachment-image-user-attachment-thumbnail-corrupt-${copiedImageAttachment.id}`;
    expect((await findByTestId(imageTestId)).props.source).toEqual({
      uri: attachmentWithCorruptThumbnail.thumbnailUri,
    });

    fireEvent(getByTestId(imageTestId), 'error');

    await waitFor(() => {
      expect(getByTestId(imageTestId).props.source).toEqual({
        uri: copiedImageAttachment.localUri,
      });
    });

    expect(queryByTestId(`message-attachment-unavailable-user-attachment-thumbnail-corrupt-${copiedImageAttachment.id}`)).toBeNull();
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });

  it('does not re-probe equivalent persisted attachment props after rerender', async () => {
    const attachmentWithThumbnail = {
      ...copiedImageAttachment,
      thumbnailUri: 'test-dir/chat-attachments/thread-vision-1/attachment-image-1-thumb.jpg',
    };
    const { findByTestId, rerender } = render(
      <ChatMessageBubble
        id="user-attachment-stable"
        isUser
        content="Describe this"
        attachments={[attachmentWithThumbnail]}
      />,
    );

    await findByTestId(`message-attachment-image-user-attachment-stable-${copiedImageAttachment.id}`);
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();

    rerender(
      <ChatMessageBubble
        id="user-attachment-stable"
        isUser
        content="Describe this again"
        attachments={[{ ...attachmentWithThumbnail }]}
      />,
    );

    await act(async () => {});

    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });

  it('renders indexed localized unavailable states when persisted attachment files fail to load', async () => {
    const { __setTranslationOverride } = jest.requireMock('react-i18next') as {
      __setTranslationOverride: (key: string, value: string) => void;
    };
    __setTranslationOverride(
      'chat.attachments.messageUnavailableIndexedAccessibilityLabel',
      'Message image {{index}} of {{count}} unavailable',
    );
    const { getAllByText, getByLabelText, getByTestId, queryByTestId } = render(
      <ChatMessageBubble
        id="user-missing-attachment"
        isUser
        content="Describe this"
        attachments={[copiedImageAttachment, secondCopiedImageAttachment]}
      />,
    );

    fireEvent(getByTestId(`message-attachment-image-user-missing-attachment-${copiedImageAttachment.id}`), 'error');
    fireEvent(getByTestId(`message-attachment-image-user-missing-attachment-${secondCopiedImageAttachment.id}`), 'error');

    await waitFor(() => {
      expect(queryByTestId(`message-attachment-image-user-missing-attachment-${copiedImageAttachment.id}`)).toBeNull();
      expect(queryByTestId(`message-attachment-image-user-missing-attachment-${secondCopiedImageAttachment.id}`)).toBeNull();
    });

    const firstUnavailable = getByTestId(`message-attachment-unavailable-user-missing-attachment-${copiedImageAttachment.id}`);
    const secondUnavailable = getByTestId(`message-attachment-unavailable-user-missing-attachment-${secondCopiedImageAttachment.id}`);

    expect(firstUnavailable).toBeTruthy();
    expect(secondUnavailable.props.accessibilityRole).toBe('image');
    expect(secondUnavailable.props.accessibilityState).toEqual({ disabled: true });
    expect(getByLabelText('Message image 1 of 2 unavailable')).toBeTruthy();
    expect(getByLabelText('Message image 2 of 2 unavailable')).toBeTruthy();
    expect(getAllByText('chat.attachments.unavailable')).toHaveLength(2);
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });
});
