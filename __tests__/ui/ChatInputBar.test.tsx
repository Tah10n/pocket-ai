import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Text as RNText } from 'react-native';
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
import { copiedDraftImageAttachment } from '../fixtures/chatImageAttachmentFixtures';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

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

  it('renders image attachment previews and removes a selected draft', () => {
    const onRemoveAttachmentDraft = jest.fn();
    const drafts: AttachmentDraft[] = [
      {
        id: 'draft-1',
        pickerUri: 'ph://library-image-1',
        previewUri: 'file:///document/chat-attachments/draft-1.jpg',
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
    expect(getByTestId('chat-image-attachment-preview-0')).toBeTruthy();

    fireEvent.press(getByLabelText('chat.attachments.removeImageAccessibilityLabel'));

    expect(onRemoveAttachmentDraft).toHaveBeenCalledWith(drafts[0], 0);
  });

  it('disables image picking and shows the limit once four drafts are selected', () => {
    const onAttachImages = jest.fn();
    const drafts: AttachmentDraft[] = Array.from({ length: 4 }, (_, index) => ({
      id: `draft-${index}`,
      pickerUri: `ph://library-image-${index}`,
      previewUri: `file:///document/chat-attachments/draft-${index}.jpg`,
      copyStatus: 'copied',
    }));

    const { getByLabelText, getByText } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={onAttachImages}
        attachmentDrafts={drafts}
        imageAttachmentsEnabled
      />,
    );

    const attachButton = getByLabelText('chat.attachments.attachImageAccessibilityLabel');

    expect(attachButton.props.accessibilityState).toEqual({ disabled: true });
    expect(getByText('chat.attachments.limitReached')).toBeTruthy();

    fireEvent.press(attachButton);

    expect(onAttachImages).not.toHaveBeenCalled();
  });

  it('keeps attachment controls disabled with every non-ready readiness explanation', () => {
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

    for (const readinessKey of readinessKeys) {
      const onAttachImages = jest.fn();
      const { getByLabelText, getByTestId, getByText, unmount } = render(
        <ChatInputBar
          onSendMessage={jest.fn()}
          onAttachImages={onAttachImages}
          imageAttachmentsEnabled={false}
          imageAttachmentsDisabledReason={readinessKey}
        />,
      );

      const attachButton = getByLabelText('chat.attachments.attachImageAccessibilityLabel');

      expect(attachButton.props.accessibilityState).toEqual({ disabled: true });
      expect(getByTestId('chat-image-attachment-readiness-text')).toBeTruthy();
      expect(getByText(readinessKey)).toBeTruthy();

      fireEvent.press(attachButton);

      expect(onAttachImages).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('shows a busy attachment affordance while the image picker or copy is running', () => {
    const onAttachImages = jest.fn();
    const { getByLabelText, getByTestId, getByText } = render(
      <ChatInputBar
        onSendMessage={jest.fn()}
        onAttachImages={onAttachImages}
        imageAttachmentsEnabled
        isImageAttachmentActionBusy
      />,
    );

    const attachButton = getByLabelText('chat.attachments.attachImageAccessibilityLabel');

    expect(attachButton.props.accessibilityState).toEqual({ disabled: true });
    expect(getByTestId('chat-image-attachment-busy-indicator')).toBeTruthy();
    expect(getByTestId('chat-image-attachment-busy-spinner')).toBeTruthy();
    expect(getByText('chat.attachments.preparingImage')).toBeTruthy();

    fireEvent.press(attachButton);

    expect(onAttachImages).not.toHaveBeenCalled();
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

  it('blocks send while a copied image draft failed and restores the message', async () => {
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
      expect(onSendMessage).not.toHaveBeenCalled();
    });
    expect(getByText('chat.attachments.copyFailed')).toBeTruthy();
    expect(getByPlaceholderText('chat.inputPlaceholder').props.value).toBe('Describe this image');
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
