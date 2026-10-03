import React, { useEffect } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  useChatMediaAttachments,
  type UseChatMediaAttachmentsResult,
} from '../../src/hooks/useChatMediaAttachments';
import type { ChatMediaAttachmentDraft } from '../../src/types/attachments';
import type { PreparedAudio } from '../../src/services/AudioPreparationService';
import { chatAttachmentStorageService } from '../../src/services/ChatAttachmentStorageService';

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __resetTranslations: () => void;
};

describe('useChatMediaAttachments', () => {
  let latestHook: UseChatMediaAttachmentsResult | null = null;
  let consoleWarnSpy: jest.SpyInstance;

  function renderHarness(options: Parameters<typeof useChatMediaAttachments>[0]) {
    latestHook = null;

    const Harness = ({ hookOptions }: { hookOptions: Parameters<typeof useChatMediaAttachments>[0] }) => {
      const value = useChatMediaAttachments(hookOptions);
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const view = render(<Harness hookOptions={options} />);
    return { ...view, rerenderOptions: (hookOptions: Parameters<typeof useChatMediaAttachments>[0]) => view.rerender(<Harness hookOptions={hookOptions} />) };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    reactI18nextMock.__resetTranslations();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    consoleWarnSpy.mockRestore();
    (Alert.alert as jest.Mock).mockRestore?.();
  });

  const prepared: PreparedAudio = { uri: 'test-cache/audio-preparation/abc.wav', sourceSha256: 'a'.repeat(64),
    identity: 'preparation-v1', sampleRate: 16_000, channels: 1, sampleCount: 1600, durationMs: 100, sizeBytes: 3244 };
  const recordedDraft: ChatMediaAttachmentDraft = { id: 'recorded', kind: 'audio', pickerUri: prepared.uri,
    localUri: 'test-dir/chat-attachments/draft-recorded.wav', pathCategory: 'chat_attachment',
    fileName: 'draft-recorded.wav', mimeType: 'audio/wav', sizeBytes: 3244, source: 'microphone',
    createdAt: 1, copyStatus: 'copied', audio: { format: 'wav', durationMs: 100 } };

  it('transfers recorded draft ownership on Send so closing the recorder/composer does not delete message audio', async () => {
    jest.spyOn(chatAttachmentStorageService, 'copyPreparedAudioToDraft').mockResolvedValue(recordedDraft);
    const discard = jest.spyOn(chatAttachmentStorageService, 'discardMediaDrafts').mockResolvedValue(undefined);
    const view = renderHarness({ audioEnabled: true, ownerKey: 'chat-a|model-a' });
    await act(async () => { await latestHook!.attachRecordedAudio(prepared); });
    expect(latestHook!.drafts).toEqual([recordedDraft]);
    let consumed: ChatMediaAttachmentDraft[] = [];
    act(() => { consumed = latestHook!.consumeDraftsForSend(); });
    view.unmount();
    expect(consumed).toEqual([recordedDraft]);
    expect(discard).not.toHaveBeenCalled();
  });

  it('discards a late recorder copy after the chat/model owner changes instead of attaching it to another chat', async () => {
    let finish!: (draft: ChatMediaAttachmentDraft) => void;
    jest.spyOn(chatAttachmentStorageService, 'copyPreparedAudioToDraft').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const discard = jest.spyOn(chatAttachmentStorageService, 'discardMediaDraft').mockResolvedValue(undefined);
    const view = renderHarness({ audioEnabled: true, ownerKey: 'chat-a|model-a' });
    let attaching!: Promise<void>;
    act(() => { attaching = latestHook!.attachRecordedAudio(prepared); });
    const rejected = expect(attaching).rejects.toThrow('owner changed');
    view.rerenderOptions({ audioEnabled: true, ownerKey: 'chat-b|model-b' });
    await act(async () => { finish(recordedDraft); await rejected; });
    expect(latestHook!.drafts).toEqual([]);
    expect(discard).toHaveBeenCalledWith(recordedDraft);
  });

  it('restores failed pre-append audio for retry and preserves draft cleanup ownership', async () => {
    jest.spyOn(chatAttachmentStorageService, 'copyPreparedAudioToDraft').mockResolvedValue(recordedDraft);
    const discard = jest.spyOn(chatAttachmentStorageService, 'discardMediaDrafts').mockResolvedValue(undefined);
    const view = renderHarness({ audioEnabled: true, ownerKey: 'chat-a|model-a' });
    await act(async () => { await latestHook!.attachRecordedAudio(prepared); });
    let consumed: ChatMediaAttachmentDraft[] = [];
    act(() => { consumed = latestHook!.consumeDraftsForSend(); });
    act(() => { latestHook!.restoreDraftsForRetry(consumed); });
    expect(latestHook!.drafts).toEqual([recordedDraft]);
    view.unmount();
    expect(discard).toHaveBeenCalledWith([recordedDraft]);
  });

  it('rolls back a completed copy when the recorder sheet is discarded while Attach is pending', async () => {
    let finish!: (draft: ChatMediaAttachmentDraft) => void;
    jest.spyOn(chatAttachmentStorageService, 'copyPreparedAudioToDraft').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const discard = jest.spyOn(chatAttachmentStorageService, 'discardMediaDraft').mockResolvedValue(undefined);
    renderHarness({ audioEnabled: true, ownerKey: 'chat-a|model-a' });
    let sheetCurrent = true;
    const assertCurrent = () => { if (!sheetCurrent) throw new Error('Recording sheet cancelled.'); };
    let attaching!: Promise<void>;
    act(() => { attaching = latestHook!.attachRecordedAudio(prepared, { assertCurrent }); });
    const rejected = expect(attaching).rejects.toThrow('sheet cancelled');
    sheetCurrent = false;
    await act(async () => { finish(recordedDraft); await rejected; });
    expect(latestHook!.drafts).toEqual([]);
    expect(discard).toHaveBeenCalledWith(recordedDraft);
  });

  it('latches uncertain decoder cleanup without publishing a retryable draft or reopening the picker', async () => {
    jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({ canceled: false, assets: [{
      uri: 'file:///test-cache/selected.wav', name: 'selected.wav', mimeType: 'audio/wav', size: 1024, lastModified: 1,
    }] });
    const copy = jest.spyOn(chatAttachmentStorageService, 'copyAudioAssetToDraft')
      .mockRejectedValueOnce(Object.assign(new Error('private native cleanup details'), { code: 'cleanup_failed' }));
    const onAudioCleanupFailure = jest.fn();
    renderHarness({ audioEnabled: true, ownerKey: 'chat-a', onAudioCleanupFailure });
    await act(async () => { await latestHook!.attachAudio(); });
    expect(onAudioCleanupFailure).toHaveBeenCalledTimes(1);
    expect(latestHook!.drafts).toEqual([]);
    expect(Alert.alert).toHaveBeenLastCalledWith('chat.attachments.attachAudio', 'audioRecording.errors.cleanup_failed');
    await act(async () => { await latestHook!.attachAudio(); });
    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledTimes(1);
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
