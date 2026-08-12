import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import {
  useChatDocumentAttachments,
  type UseChatDocumentAttachmentsResult,
} from '../../src/hooks/useChatDocumentAttachments';
import { chatAttachmentStorageService } from '../../src/services/ChatAttachmentStorageService';

jest.mock('../../src/services/ChatAttachmentStorageService', () => {
  const actual = jest.requireActual('../../src/services/ChatAttachmentStorageService');
  return {
    ...actual,
    chatAttachmentStorageService: {
      copyDocumentAssetToDraft: jest.fn(),
      discardDocumentDraft: jest.fn().mockResolvedValue(undefined),
      discardDocumentDrafts: jest.fn().mockResolvedValue(undefined),
    },
  };
});

describe('useChatDocumentAttachments', () => {
  let latestHook: UseChatDocumentAttachmentsResult | null = null;
  let consoleWarnSpy: jest.SpyInstance;

  const copiedDraft = {
    id: 'document-retry-1',
    pickerUri: 'content://picked/report.txt',
    localUri: 'test-dir/chat-attachments/document-retry-1.txt',
    pathCategory: 'chat_attachment' as const,
    fileName: 'document-retry-1.txt',
    displayName: 'report.txt',
    mimeType: 'text/plain',
    sizeBytes: 128,
    source: 'document_picker' as const,
    createdAt: 1,
    copyStatus: 'copied' as const,
  };

  const Harness = ({ ownerKey }: { ownerKey: string }) => {
    const value = useChatDocumentAttachments({
      enabled: true,
      ownerKey,
      preserveFailedDraftsOnNewThreadCommit: true,
    });
    useEffect(() => {
      latestHook = value;
    }, [value]);
    return null;
  };

  function renderHarness(ownerKey: string) {
    return render(<Harness ownerKey={ownerKey} />);
  }

  beforeEach(() => {
    latestHook = null;
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{
        uri: copiedDraft.pickerUri,
        name: copiedDraft.displayName,
        mimeType: copiedDraft.mimeType,
        size: copiedDraft.sizeBytes,
      }],
    });
    (chatAttachmentStorageService.copyDocumentAssetToDraft as jest.Mock).mockResolvedValue(copiedDraft);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('preserves an explicitly restored retry draft for the exact new-thread commit owner', async () => {
    const { rerender } = renderHarness('new-thread:1|model-text');

    await act(async () => {
      await latestHook?.attachDocuments();
    });
    let consumed = [] as typeof copiedDraft[];
    await act(async () => {
      consumed = latestHook?.consumeDraftsForSend() as typeof copiedDraft[];
      latestHook?.restoreDraftsForRetry(consumed, {
        preserveOwnerKey: 'created-thread|model-text',
      });
    });

    rerender(<Harness ownerKey="created-thread|model-text" />);

    await waitFor(() => {
      expect(latestHook?.drafts).toEqual([copiedDraft]);
    });
    expect(chatAttachmentStorageService.discardDocumentDrafts).not.toHaveBeenCalled();
  });

  it('discards an armed retry draft when the owner transition is not the expected commit', async () => {
    const { rerender } = renderHarness('new-thread:1|model-text');

    await act(async () => {
      await latestHook?.attachDocuments();
    });
    await act(async () => {
      const consumed = latestHook?.consumeDraftsForSend() as typeof copiedDraft[];
      latestHook?.restoreDraftsForRetry(consumed, {
        preserveOwnerKey: 'created-thread|model-text',
      });
    });

    rerender(<Harness ownerKey="unrelated-thread|model-text" />);

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDocumentDrafts).toHaveBeenCalledWith([copiedDraft]);
  });

  it('discards a restored retry draft when an uncommitted new chat is explicitly restarted', async () => {
    const { rerender } = renderHarness('new-thread:1|model-text');

    await act(async () => {
      await latestHook?.attachDocuments();
    });
    await act(async () => {
      const consumed = latestHook?.consumeDraftsForSend() as typeof copiedDraft[];
      latestHook?.restoreDraftsForRetry(consumed);
    });

    rerender(<Harness ownerKey="new-thread:2|model-text" />);

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDocumentDrafts).toHaveBeenCalledWith([copiedDraft]);
  });
});
