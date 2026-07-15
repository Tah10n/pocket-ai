import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Platform, Text as RNText } from 'react-native';
import {
  ChatInputBar,
  getGlassComposerCapsuleStyle,
  getModeBannerGlassStyle,
  getPrimaryActionGlassStyle,
  markChatInputDraftConsumedError,
} from '../../src/components/ui/ChatInputBar';
import { screenChromeTokens } from '../../src/utils/themeTokens';
import { getSendableDraftImageAttachments } from '../../src/utils/chatImageAttachments';
import type { AttachmentDraft } from '../../src/types/multimodal';
import type { ChatDocumentAttachmentDraft, ChatMediaAttachmentDraft } from '../../src/types/attachments';
import { copiedDraftImageAttachment } from '../fixtures/chatImageAttachmentFixtures';

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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('@/components/ui/input', () => {
  const mockReact = require('react');
  const { TextInput, View } = require('react-native');
  return {
    Input: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    InputField: (props: any) => mockReact.createElement(TextInput, props),
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
  afterEach(() => {
    reactI18nextMock.__resetTranslations();
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  });

  function mockPlatformOS(nextPlatform: 'android' | 'ios') {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => nextPlatform });

    return () => {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    };
  }

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

  it('blocks duplicate submits while the first attachment send is still pending', async () => {
    let resolveSend!: () => void;
    const onSendMessage = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const copiedDraft: AttachmentDraft = {
      ...copiedDraftImageAttachment,
    };

    const { getByPlaceholderText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[copiedDraft]}
        imageAttachmentsEnabled
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');

    fireEvent.changeText(input, 'Describe this image');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Describe this image',
      },
    });
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Describe this image',
      },
    });

    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(input.props.editable).toBe(false);

    resolveSend();
    await waitFor(() => {
      expect(getByPlaceholderText('chat.inputPlaceholder').props.editable).toBe(true);
    });
  });

  it('does not restore a draft when the send error says the message was consumed', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSendMessage = jest.fn().mockRejectedValue(markChatInputDraftConsumedError(new Error('generation failed')));

    try {
      const { getByPlaceholderText } = render(
        <ChatInputBar onSendMessage={onSendMessage} />,
      );

      const input = getByPlaceholderText('chat.inputPlaceholder');
      fireEvent.changeText(input, 'Already sent');
      fireEvent(input, 'submitEditing', {
        nativeEvent: {
          text: 'Already sent',
        },
      });

      await waitFor(() => {
        expect(onSendMessage).toHaveBeenCalledWith('Already sent');
      });
      expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('');
    } finally {
      consoleErrorSpy.mockRestore();
    }
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

  it('collapses built-in attachment actions behind a single menu button', () => {
    const onAttachImages = jest.fn();
    const onAttachDocuments = jest.fn();
    const onAttachAudio = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={onAttachImages}
        onAttachDocuments={onAttachDocuments}
        onAttachAudio={onAttachAudio}
        imageAttachmentsEnabled
        documentAttachmentsEnabled
        audioAttachmentsSupported
        audioAttachmentsEnabled
      />,
    );

    expect(getByTestId('chat-attach-menu-button')).toBeTruthy();
    expect(queryByTestId('chat-attach-image-button')).toBeNull();
    expect(queryByTestId('chat-attach-document-button')).toBeNull();
    expect(queryByTestId('chat-attach-audio-button')).toBeNull();
    expect(queryByTestId('chat-attach-video-button')).toBeNull();

    fireEvent.press(getByTestId('chat-attach-menu-button'));

    expect(getByTestId('chat-attachment-menu-sheet')).toBeTruthy();
    expect(getByTestId('chat-attach-image-button')).toBeTruthy();
    expect(getByTestId('chat-attach-document-button')).toBeTruthy();
    expect(getByTestId('chat-attach-audio-button')).toBeTruthy();
    expect(queryByTestId('chat-attach-video-button')).toBeNull();

    fireEvent.press(getByTestId('chat-attach-image-button'));

    expect(onAttachImages).toHaveBeenCalledTimes(1);
    expect(onAttachDocuments).not.toHaveBeenCalled();
    expect(onAttachAudio).not.toHaveBeenCalled();
    expect(queryByTestId('chat-attachment-menu-sheet')).toBeNull();
  });

  it('renders document attachment chips and allows attachment-only sends', async () => {
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    const onAttachDocuments = jest.fn();
    const onRemoveDocumentAttachmentDraft = jest.fn();
    const documentDraft: ChatDocumentAttachmentDraft = {
      id: 'document-1',
      pickerUri: 'content://documents/document-1.txt',
      localUri: 'test-dir/chat-attachments/document-1.txt',
      pathCategory: 'chat_attachment',
      fileName: 'document-1.txt',
      displayName: 'Meeting notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 1536,
      source: 'document_picker',
      createdAt: 1,
      copyStatus: 'copied',
    };

    const { getByLabelText, getByTestId, getByText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        documentAttachmentDrafts={[documentDraft]}
        onAttachDocuments={onAttachDocuments}
        onRemoveDocumentAttachmentDraft={onRemoveDocumentAttachmentDraft}
        documentAttachmentsEnabled
      />,
    );

    fireEvent.press(getByTestId('chat-attach-menu-button'));
    fireEvent.press(getByLabelText('chat.attachments.attachDocumentAccessibilityLabel'));
    expect(onAttachDocuments).toHaveBeenCalledTimes(1);
    expect(getByTestId('chat-document-attachment-chip-0')).toBeTruthy();
    expect(getByText('Meeting notes.txt')).toBeTruthy();
    expect(getByText('2 KB')).toBeTruthy();

    fireEvent.press(getByTestId('chat-document-attachment-remove-0'));
    expect(onRemoveDocumentAttachmentDraft).toHaveBeenCalledWith(documentDraft, 0);

    fireEvent.press(getByLabelText('chat.sendAccessibilityLabel'));
    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('');
    });
  });

  it('blocks media attachment-only sends while preserving text fallback when the draft modality is disabled', async () => {
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    const audioDraft: ChatMediaAttachmentDraft = {
      id: 'audio-1',
      kind: 'audio',
      pickerUri: 'content://audio/audio-1.mp3',
      localUri: 'test-dir/chat-attachments/audio-1.mp3',
      pathCategory: 'chat_attachment',
      fileName: 'audio-1.mp3',
      displayName: 'Meeting audio.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 4096,
      source: 'document_picker',
      createdAt: 1,
      copyStatus: 'copied',
      audio: {
        format: 'mp3',
      },
    };

    const { getByPlaceholderText, getByLabelText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        mediaAttachmentDrafts={[audioDraft]}
        onAttachAudio={jest.fn()}
        audioAttachmentsSupported
        audioAttachmentsEnabled={false}
        audioAttachmentsDisabledReason="chat.attachments.audioRuntimeUnavailable"
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: '',
      },
    });
    fireEvent.press(getByLabelText('chat.sendAccessibilityLabel'));

    expect(onSendMessage).not.toHaveBeenCalled();

    fireEvent.changeText(input, 'Send text without audio');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Send text without audio',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('Send text without audio');
    });
  });

  it('keeps supported-but-not-ready audio hints scoped to the audio menu action', () => {
    const { getByLabelText, getByTestId, getByText, queryByTestId, queryByText } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachAudio={jest.fn()}
        audioAttachmentsSupported
        audioAttachmentsEnabled={false}
        audioAttachmentsDisabledReason="chat.attachments.audioRuntimeUnavailable"
      />,
    );

    expect(queryByTestId('chat-image-attachment-readiness-text')).toBeNull();
    expect(queryByText('chat.attachments.audioRuntimeUnavailable')).toBeNull();

    fireEvent.press(getByTestId('chat-attach-menu-button'));

    expect(getByLabelText('chat.attachments.attachAudioAccessibilityLabel').props.accessibilityHint)
      .toBe('chat.attachments.audioRuntimeUnavailable');
    expect(getByText('chat.attachments.audioRuntimeUnavailable')).toBeTruthy();
    expect(queryByTestId('chat-image-attachment-readiness-text')).toBeNull();
  });

  it('hides audio actions and audio readiness copy for models without audio capability', () => {
    const { getByTestId, queryByTestId, queryByText } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={jest.fn()}
        onAttachDocuments={jest.fn()}
        onAttachAudio={jest.fn()}
        imageAttachmentsEnabled
        documentAttachmentsEnabled
        audioAttachmentsSupported={false}
        audioAttachmentsEnabled={false}
        audioAttachmentsDisabledReason="chat.attachments.audioModelUnsupported"
      />,
    );

    expect(queryByTestId('chat-image-attachment-readiness-text')).toBeNull();
    expect(queryByText('chat.attachments.audioModelUnsupported')).toBeNull();

    fireEvent.press(getByTestId('chat-attach-menu-button'));

    expect(getByTestId('chat-attach-image-button')).toBeTruthy();
    expect(getByTestId('chat-attach-document-button')).toBeTruthy();
    expect(queryByTestId('chat-attach-audio-button')).toBeNull();
    expect(queryByText('chat.attachments.audioModelUnsupported')).toBeNull();
  });

  it('renders a retained attachments tray and allows blank sends when explicitly enabled', async () => {
    const onSendMessage = jest.fn();
    const { getByPlaceholderText, getByTestId, getByText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        allowEmptyMessageSend
        attachmentsTray={<RNText testID="retained-attachments-tray">Retained attachments stay attached</RNText>}
      />,
    );

    expect(getByTestId('chat-input-bar-attachments-tray')).toBeTruthy();
    expect(getByTestId('retained-attachments-tray')).toBeTruthy();
    expect(getByText('Retained attachments stay attached')).toBeTruthy();

    fireEvent(getByPlaceholderText('chat.inputPlaceholder'), 'submitEditing', {
      nativeEvent: {
        text: '',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('');
    });
  });

  it('blocks retained attachment sends while the parent marks send disabled', () => {
    const onSendMessage = jest.fn();
    const { getByPlaceholderText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        allowEmptyMessageSend
        sendDisabled
        attachmentsTray={<RNText testID="retained-attachments-tray">Retained attachments wait for vision</RNText>}
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: '',
      },
    });
    fireEvent.changeText(input, 'Text while image is retained');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Text while image is retained',
      },
    });

    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('renders image attachment previews and removes a selected draft', () => {
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.previewIndexedAccessibilityLabel',
      'Attached image {{index}} of {{count}} preview',
    );
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.removeImageIndexedAccessibilityLabel',
      'Remove attached image {{index}} of {{count}}',
    );
    const onRemoveAttachmentDraft = jest.fn();
    const drafts: AttachmentDraft[] = [
      {
        id: 'draft-1',
        pickerUri: 'ph://library-image-1',
        previewUri: 'file:///document/chat-attachments/draft-1.jpg',
        thumbnailUri: 'file:///document/chat-attachments/draft-1-thumb.jpg',
        mediaType: 'image/jpeg',
        width: 1024,
        height: 768,
        copyStatus: 'copied',
      },
    ];

    const { getByTestId, getByLabelText } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={jest.fn()}
        onRemoveAttachmentDraft={onRemoveAttachmentDraft}
        attachmentDrafts={drafts}
        imageAttachmentsEnabled
      />,
    );

    expect(getByTestId('chat-image-attachments-tray')).toBeTruthy();
    expect(getByTestId('chat-image-attachment-preview-0').props.source).toEqual({
      uri: 'file:///document/chat-attachments/draft-1-thumb.jpg',
    });
    expect(getByLabelText('Attached image 1 of 1 preview')).toBeTruthy();

    fireEvent.press(getByLabelText('Remove attached image 1 of 1'));

    expect(onRemoveAttachmentDraft).toHaveBeenCalledWith(drafts[0], 0);
  });

  it('falls back from a corrupt thumbnail to preview and local attachment URIs', () => {
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.previewUnavailableIndexedAccessibilityLabel',
      'Attached image {{index}} of {{count}} preview unavailable',
    );
    const drafts: AttachmentDraft[] = [
      {
        id: 'draft-fallback',
        pickerUri: 'ph://library-image-fallback',
        thumbnailUri: 'file:///document/chat-attachments/draft-fallback-thumb.jpg',
        previewUri: 'file:///document/chat-attachments/draft-fallback-preview.jpg',
        localUri: 'file:///document/chat-attachments/draft-fallback-local.jpg',
        mediaType: 'image/jpeg',
        copyStatus: 'copied',
      },
    ];

    const { getByLabelText, getByTestId, queryByTestId } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={jest.fn()}
        attachmentDrafts={drafts}
        imageAttachmentsEnabled
      />,
    );

    expect(getByTestId('chat-image-attachment-preview-0').props.source).toEqual({
      uri: 'file:///document/chat-attachments/draft-fallback-thumb.jpg',
    });

    fireEvent(getByTestId('chat-image-attachment-preview-0'), 'error');

    expect(getByTestId('chat-image-attachment-preview-0').props.source).toEqual({
      uri: 'file:///document/chat-attachments/draft-fallback-preview.jpg',
    });

    fireEvent(getByTestId('chat-image-attachment-preview-0'), 'error');

    expect(getByTestId('chat-image-attachment-preview-0').props.source).toEqual({
      uri: 'file:///document/chat-attachments/draft-fallback-local.jpg',
    });

    fireEvent(getByTestId('chat-image-attachment-preview-0'), 'error');

    expect(queryByTestId('chat-image-attachment-preview-0')).toBeNull();
    expect(getByTestId('chat-image-attachment-unavailable-preview-0').props.accessibilityState).toEqual({ disabled: true });
    expect(getByLabelText('Attached image 1 of 1 preview unavailable')).toBeTruthy();
  });

  it('skips empty preview candidates and collapses duplicate attachment URIs', () => {
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.previewUnavailableIndexedAccessibilityLabel',
      'Attached image {{index}} of {{count}} preview unavailable',
    );
    const drafts: AttachmentDraft[] = [
      {
        id: 'draft-duplicate',
        pickerUri: 'ph://library-image-duplicate',
        thumbnailUri: ' ',
        previewUri: 'file:///document/chat-attachments/draft-duplicate.jpg',
        localUri: 'file:///document/chat-attachments/draft-duplicate.jpg',
        mediaType: 'image/jpeg',
        copyStatus: 'copied',
      },
      {
        id: 'draft-local-only',
        pickerUri: 'ph://library-image-local-only',
        thumbnailUri: '',
        previewUri: '',
        localUri: 'file:///document/chat-attachments/draft-local-only.jpg',
        mediaType: 'image/jpeg',
        copyStatus: 'copied',
      },
      {
        id: 'draft-empty',
        pickerUri: 'ph://library-image-empty',
        thumbnailUri: '',
        previewUri: ' ',
        mediaType: 'image/jpeg',
        copyStatus: 'copied',
      },
    ];

    const { getByLabelText, getByTestId, queryByTestId } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={jest.fn()}
        attachmentDrafts={drafts}
        imageAttachmentsEnabled
      />,
    );

    expect(getByTestId('chat-image-attachment-preview-0').props.source).toEqual({
      uri: 'file:///document/chat-attachments/draft-duplicate.jpg',
    });
    expect(getByTestId('chat-image-attachment-preview-1').props.source).toEqual({
      uri: 'file:///document/chat-attachments/draft-local-only.jpg',
    });
    expect(queryByTestId('chat-image-attachment-preview-2')).toBeNull();
    expect(getByLabelText('Attached image 3 of 3 preview unavailable')).toBeTruthy();

    fireEvent(getByTestId('chat-image-attachment-preview-0'), 'error');

    expect(queryByTestId('chat-image-attachment-preview-0')).toBeNull();
    expect(getByLabelText('Attached image 1 of 3 preview unavailable')).toBeTruthy();
  });

  it('marks failed attachment previews with a distinct id, localized label, and disabled state', () => {
    reactI18nextMock.__setTranslationOverride('chat.attachments.tooLarge', 'Attachment is too large');
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.failedPreviewIndexedAccessibilityLabel',
      'Failed attached image {{index}} of {{count}}: {{reason}}',
    );
    const failedDraft: AttachmentDraft = {
      id: 'draft-too-large',
      pickerUri: 'ph://library-image-too-large',
      previewUri: 'ph://library-image-too-large',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'too_large',
    };

    const { getByLabelText, getByTestId, getByText, queryByTestId } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={jest.fn()}
        attachmentDrafts={[failedDraft]}
        imageAttachmentsEnabled
      />,
    );

    const failedPreview = getByTestId('chat-image-attachment-failed-preview-0');

    expect(queryByTestId('chat-image-attachment-preview-0')).toBeNull();
    expect(getByLabelText('Failed attached image 1 of 1: Attachment is too large')).toBe(failedPreview);
    expect(failedPreview.props.accessibilityRole).toBe('image');
    expect(failedPreview.props.accessibilityState).toEqual({ disabled: true });
    expect(getByText('Attachment is too large')).toBeTruthy();
  });

  it('uses distinct indexed accessibility labels for multiple failed attachment previews', () => {
    reactI18nextMock.__setTranslationOverride('chat.attachments.copyFailed', 'Copy failed');
    reactI18nextMock.__setTranslationOverride('chat.attachments.tooLarge', 'Attachment is too large');
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.failedPreviewIndexedAccessibilityLabel',
      'Failed attached image {{index}} of {{count}}: {{reason}}',
    );
    const failedCopyDraft: AttachmentDraft = {
      id: 'draft-copy-failed',
      pickerUri: 'ph://library-image-copy-failed',
      previewUri: 'ph://library-image-copy-failed',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'copy_failed',
    };
    const failedTooLargeDraft: AttachmentDraft = {
      id: 'draft-too-large',
      pickerUri: 'ph://library-image-too-large',
      previewUri: 'ph://library-image-too-large',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'too_large',
    };

    const { getByLabelText, getByTestId, queryByLabelText } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={jest.fn()}
        attachmentDrafts={[failedCopyDraft, failedTooLargeDraft]}
        imageAttachmentsEnabled
      />,
    );

    expect(getByLabelText('Failed attached image 1 of 2: Copy failed')).toBe(getByTestId('chat-image-attachment-failed-preview-0'));
    expect(getByLabelText('Failed attached image 2 of 2: Attachment is too large')).toBe(getByTestId('chat-image-attachment-failed-preview-1'));
    expect(queryByLabelText('Copy failed')).toBeNull();
    expect(queryByLabelText('Attachment is too large')).toBeNull();
  });

  it('surfaces both too-large and copy failures when persistent drafts fail for mixed reasons', () => {
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.mixedFailures',
      'Attachment is too large. Copy failed.',
    );
    const failedCopyDraft: AttachmentDraft = {
      id: 'draft-copy-failed',
      pickerUri: 'ph://library-image-copy-failed',
      previewUri: 'ph://library-image-copy-failed',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'copy_failed',
    };
    const failedTooLargeDraft: AttachmentDraft = {
      id: 'draft-too-large',
      pickerUri: 'ph://library-image-too-large',
      previewUri: 'ph://library-image-too-large',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'too_large',
    };

    const { getByText, queryByText } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={jest.fn()}
        attachmentDrafts={[failedCopyDraft, failedTooLargeDraft]}
        imageAttachmentsEnabled
      />,
    );

    expect(getByText('Attachment is too large. Copy failed.')).toBeTruthy();
    expect(queryByText('chat.attachments.tooLarge')).toBeNull();
    expect(queryByText('chat.attachments.copyFailed')).toBeNull();
  });

  it('disables image picking and shows the limit once four drafts are selected', () => {
    const restorePlatform = mockPlatformOS('android');
    const onAttachImages = jest.fn();
    const drafts: AttachmentDraft[] = Array.from({ length: 4 }, (_, index) => ({
      id: `draft-${index}`,
      pickerUri: `ph://library-image-${index}`,
      previewUri: `file:///document/chat-attachments/draft-${index}.jpg`,
      copyStatus: 'copied',
    }));

    try {
      const { getByLabelText, getByTestId, getAllByText } = render(
        <ChatInputBar
          onSendMessage={jest.fn()}
          onAttachImages={onAttachImages}
          attachmentDrafts={drafts}
          imageAttachmentsEnabled
        />,
      );

      fireEvent.press(getByTestId('chat-attach-menu-button'));
      const attachButton = getByLabelText('chat.attachments.attachImageAccessibilityLabel');

      expect(attachButton.props.accessibilityState).toEqual({ selected: false, disabled: true });
      expect(attachButton.props.accessibilityHint).toBe('chat.attachments.limitReached');
      expect(getByTestId('chat-image-attachment-readiness-text').props.accessibilityLiveRegion).toBe('polite');
      expect(getByTestId('chat-image-attachment-readiness-text').props.role).toBe('status');
      expect(getAllByText('chat.attachments.limitReached').length).toBeGreaterThan(0);

      fireEvent.press(attachButton);

      expect(onAttachImages).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('keeps attachment controls disabled with every non-ready readiness explanation', () => {
    const restorePlatform = mockPlatformOS('android');
    const readinessKeys = [
      'chat.visionReadiness.textOnly',
      'chat.visionReadiness.missingProjector',
      'chat.visionReadiness.ambiguousProjector',
      'chat.visionReadiness.projectorDownloading',
      'chat.visionReadiness.failed',
      'chat.visionReadiness.noModel',
      'chat.visionReadiness.editingMessage',
      'chat.visionReadiness.unsupported',
    ];

    try {
      for (const readinessKey of readinessKeys) {
        const onAttachImages = jest.fn();
        const { getByLabelText, getByTestId, getAllByText, unmount } = render(
          <ChatInputBar
            onSendMessage={jest.fn()}
            onAttachImages={onAttachImages}
            imageAttachmentsEnabled={false}
            imageAttachmentsDisabledReason={readinessKey}
          />,
        );

        fireEvent.press(getByTestId('chat-attach-menu-button'));
        const attachButton = getByLabelText('chat.attachments.attachImageAccessibilityLabel');

        expect(attachButton.props.accessibilityState).toEqual({ selected: false, disabled: true });
        expect(attachButton.props.accessibilityHint).toBe(readinessKey);
        expect(getByTestId('chat-image-attachment-readiness-text')).toBeTruthy();
        expect(getByTestId('chat-image-attachment-readiness-text').props.accessibilityLiveRegion).toBe('polite');
        expect(getByTestId('chat-image-attachment-readiness-text').props.role).toBe('status');
        expect(getAllByText(readinessKey).length).toBeGreaterThan(0);

        fireEvent.press(attachButton);

        expect(onAttachImages).not.toHaveBeenCalled();
        unmount();
      }
    } finally {
      restorePlatform();
    }
  });

  it('shows a busy attachment affordance while the image picker or copy is running', () => {
    const restorePlatform = mockPlatformOS('android');
    const onAttachImages = jest.fn();

    try {
      const { getByLabelText, getByTestId, getAllByText } = render(
        <ChatInputBar
          onSendMessage={jest.fn()}
          onAttachImages={onAttachImages}
          imageAttachmentsEnabled
          isImageAttachmentActionBusy
        />,
      );

      fireEvent.press(getByTestId('chat-attach-menu-button'));
      const attachButton = getByLabelText('chat.attachments.attachImageAccessibilityLabel');

      expect(attachButton.props.accessibilityHint).toBe('chat.attachments.preparingImage');
      expect(attachButton.props.accessibilityState).toEqual({ selected: false, disabled: true, busy: true });
      expect(getByTestId('chat-image-attachment-busy-indicator')).toBeTruthy();
      expect(getByTestId('chat-image-attachment-busy-indicator').props.accessibilityLiveRegion).toBe('polite');
      expect(getByTestId('chat-image-attachment-busy-indicator').props.accessibilityState).toEqual({ busy: true });
      expect(getByTestId('chat-image-attachment-busy-spinner')).toBeTruthy();
      expect(getAllByText('chat.attachments.preparingImage').length).toBeGreaterThan(0);

      fireEvent.press(attachButton);

      expect(onAttachImages).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('announces attachment helper and busy changes on iOS without duplicate rerender announcements', () => {
    const restorePlatform = mockPlatformOS('ios');
    const drafts: AttachmentDraft[] = Array.from({ length: 4 }, (_, index) => ({
      id: `draft-${index}`,
      pickerUri: `ph://library-image-${index}`,
      previewUri: `file:///document/chat-attachments/draft-${index}.jpg`,
      copyStatus: 'copied',
    }));

    try {
      const screen = render(
        <ChatInputBar
          onSendMessage={jest.fn()}
          onAttachImages={jest.fn()}
          imageAttachmentsEnabled={false}
          imageAttachmentsDisabledReason="chat.visionReadiness.missingProjector"
        />,
      );

      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
      expect(AccessibilityInfo.announceForAccessibility)
        .toHaveBeenLastCalledWith('chat.visionReadiness.missingProjector');

      screen.rerender(
        <ChatInputBar
          onSendMessage={jest.fn()}
          onAttachImages={jest.fn()}
          imageAttachmentsEnabled={false}
          imageAttachmentsDisabledReason="chat.visionReadiness.missingProjector"
        />,
      );

      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);

      screen.rerender(
        <ChatInputBar
          onSendMessage={jest.fn()}
          onAttachImages={jest.fn()}
          imageAttachmentsEnabled
          isImageAttachmentActionBusy
        />,
      );

      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(2);
      expect(AccessibilityInfo.announceForAccessibility)
        .toHaveBeenLastCalledWith('chat.attachments.preparingImage');

      screen.rerender(
        <ChatInputBar
          onSendMessage={jest.fn()}
          onAttachImages={jest.fn()}
          attachmentDrafts={drafts}
          imageAttachmentsEnabled
        />,
      );

      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(3);
      expect(AccessibilityInfo.announceForAccessibility)
        .toHaveBeenLastCalledWith('chat.attachments.limitReached');
      expect(screen.getByTestId('chat-image-attachment-readiness-text').props.accessibilityLiveRegion).toBeUndefined();
    } finally {
      restorePlatform();
    }
  });

  it('blocks send and keeps the draft while an image attachment action is busy', () => {
    const onSendMessage = jest.fn();
    const { getByPlaceholderText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        isImageAttachmentActionBusy
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');
    fireEvent.changeText(input, 'Describe this pending image');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Describe this pending image',
      },
    });

    expect(onSendMessage).not.toHaveBeenCalled();
    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('Describe this pending image');
  });

  it('allows text-only send when copied drafts exist after vision readiness turns off', async () => {
    const onSendMessage = jest.fn();
    const copiedDraft: AttachmentDraft = {
      ...copiedDraftImageAttachment,
    };

    const { getByPlaceholderText, getByText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[copiedDraft]}
        imageAttachmentsEnabled={false}
        imageAttachmentsDisabledReason="chat.visionReadiness.textOnly"
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');
    fireEvent.changeText(input, 'Send text only');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Send text only',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('Send text only');
    });
    expect(getByText('chat.visionReadiness.textOnly')).toBeTruthy();
    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('');
  });

  it('allows text-only send when disabled stale failed or unsendable drafts exist', async () => {
    const onSendMessage = jest.fn();
    const failedDraft: AttachmentDraft = {
      pickerUri: 'ph://library-image-failed',
      previewUri: 'ph://library-image-failed',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'copy_failed',
    };
    const unsendableDraft: AttachmentDraft = {
      id: 'draft-unsendable',
      pickerUri: 'ph://library-image-unsendable',
      previewUri: 'test-dir/chat-attachments/draft-unsendable.jpg',
      mediaType: 'image/jpeg',
      copyStatus: 'copied',
    };

    const { getByPlaceholderText, getByText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[failedDraft, unsendableDraft]}
        imageAttachmentsEnabled={false}
        imageAttachmentsDisabledReason="chat.visionReadiness.textOnly"
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');
    fireEvent.changeText(input, 'Send text only');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Send text only',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('Send text only');
    });
    expect(getByText('chat.visionReadiness.textOnly')).toBeTruthy();
    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('');
  });

  it('does not send image-only drafts when image attachments are disabled', async () => {
    const onSendMessage = jest.fn();
    const copiedDraft: AttachmentDraft = {
      id: 'draft-1',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-1.jpg',
      localUri: 'test-dir/chat-attachments/draft-1.jpg',
      pathCategory: 'chat_attachment',
      fileName: 'draft-1.jpg',
      mediaType: 'image/jpeg',
      copyStatus: 'copied',
    };

    const { getByPlaceholderText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[copiedDraft]}
        imageAttachmentsEnabled={false}
        imageAttachmentsDisabledReason="chat.visionReadiness.textOnly"
      />,
    );

    fireEvent(getByPlaceholderText('chat.inputPlaceholder'), 'submitEditing', {
      nativeEvent: {
        text: '',
      },
    });

    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('allows sending ready image drafts without text when vision is enabled', async () => {
    const onSendMessage = jest.fn();
    const copiedDraft: AttachmentDraft = {
      ...copiedDraftImageAttachment,
    };
    expect(getSendableDraftImageAttachments([copiedDraft])).toHaveLength(1);

    const { getByPlaceholderText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[copiedDraft]}
        imageAttachmentsEnabled
      />,
    );

    fireEvent(getByPlaceholderText('chat.inputPlaceholder'), 'submitEditing', {
      nativeEvent: {
        text: '',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('');
    });
  });

  it('allows text send while failed-only image drafts remain visible', async () => {
    const onSendMessage = jest.fn();
    const failedDraft: AttachmentDraft = {
      pickerUri: 'ph://library-image-failed',
      previewUri: 'ph://library-image-failed',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'copy_failed',
    };

    const { getByPlaceholderText, getByText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[failedDraft]}
        imageAttachmentsEnabled
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');
    fireEvent.changeText(input, 'Describe this image');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Describe this image',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('Describe this image');
    });
    expect(getByText('chat.attachments.copyFailed')).toBeTruthy();
    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('');
  });

  it('allows copied image sends when failed drafts are also present', async () => {
    const onSendMessage = jest.fn();
    const copiedDraft: AttachmentDraft = {
      ...copiedDraftImageAttachment,
    };
    const failedDraft: AttachmentDraft = {
      pickerUri: 'ph://library-image-failed',
      previewUri: 'ph://library-image-failed',
      mediaType: 'image/jpeg',
      copyStatus: 'failed',
      errorReason: 'copy_failed',
    };

    const { getByPlaceholderText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[copiedDraft, failedDraft]}
        imageAttachmentsEnabled
      />,
    );

    fireEvent(getByPlaceholderText('chat.inputPlaceholder'), 'submitEditing', {
      nativeEvent: {
        text: '',
      },
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith('');
    });
  });

  it('blocks text send while a nonfailed image draft is not sendable yet', async () => {
    const onSendMessage = jest.fn();
    const pendingDraft: AttachmentDraft = {
      id: 'draft-pending',
      pickerUri: 'ph://library-image-pending',
      previewUri: 'ph://library-image-pending',
      mediaType: 'image/jpeg',
      copyStatus: 'pending',
    };

    const { getByPlaceholderText } = render(
      <ChatInputBar
        onSendMessage={onSendMessage}
        onAttachImages={jest.fn()}
        attachmentDrafts={[pendingDraft]}
        imageAttachmentsEnabled
      />,
    );

    const input = getByPlaceholderText('chat.inputPlaceholder');
    fireEvent.changeText(input, 'Wait for this image');
    fireEvent(input, 'submitEditing', {
      nativeEvent: {
        text: 'Wait for this image',
      },
    });

    expect(onSendMessage).not.toHaveBeenCalled();
    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('Wait for this image');
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
