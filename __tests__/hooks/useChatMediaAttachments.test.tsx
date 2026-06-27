import React, { useEffect } from 'react';
import { Alert } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  useChatMediaAttachments,
  type UseChatMediaAttachmentsResult,
} from '../../src/hooks/useChatMediaAttachments';
import type { ChatMediaAttachmentDraft } from '../../src/types/attachments';

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __resetTranslations: () => void;
};

describe('useChatMediaAttachments', () => {
  let latestHook: UseChatMediaAttachmentsResult | null = null;
  let consoleWarnSpy: jest.SpyInstance;

  function renderHarness(options: Parameters<typeof useChatMediaAttachments>[0]) {
    latestHook = null;

    const Harness = () => {
      const value = useChatMediaAttachments(options);
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    return render(<Harness />);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    reactI18nextMock.__resetTranslations();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    (Alert.alert as jest.Mock).mockRestore?.();
  });

  it('consumes audio drafts only when audio is included for send', async () => {
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

    renderHarness({
      audioEnabled: true,
    });

    await act(async () => {
      latestHook?.restoreDraftsForRetry([audioDraft]);
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toEqual([audioDraft]);
    });

    let consumedDrafts: ChatMediaAttachmentDraft[] = [];
    await act(async () => {
      consumedDrafts = latestHook?.consumeDraftsForSend({
        includeAudio: false,
      }) ?? [];
    });

    expect(consumedDrafts).toEqual([]);
    expect(latestHook?.drafts).toEqual([audioDraft]);

    await act(async () => {
      consumedDrafts = latestHook?.consumeDraftsForSend({
        includeAudio: true,
      }) ?? [];
    });

    expect(consumedDrafts).toEqual([audioDraft]);
    expect(latestHook?.drafts).toEqual([]);
  });
});
