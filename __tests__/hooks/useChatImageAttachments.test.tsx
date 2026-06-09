import React, { useEffect } from 'react';
import { Alert } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  useChatImageAttachments,
  type UseChatImageAttachmentsResult,
} from '../../src/hooks/useChatImageAttachments';
import {
  ChatImageAttachmentTooLargeError,
  chatAttachmentStorageService,
} from '../../src/services/ChatAttachmentStorageService';
import { MAX_CHAT_IMAGE_ATTACHMENTS } from '../../src/utils/chatImageAttachments';

const en = require('../../src/i18n/locales/en.json');

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

jest.mock('../../src/services/ChatAttachmentStorageService', () => {
  const actual = jest.requireActual('../../src/services/ChatAttachmentStorageService');
  return {
    ...actual,
    chatAttachmentStorageService: {
      copyImageAssetToDraft: jest.fn(),
      discardDraft: jest.fn().mockResolvedValue(undefined),
      discardDrafts: jest.fn().mockResolvedValue(undefined),
    },
  };
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe('useChatImageAttachments', () => {
  let latestHook: UseChatImageAttachmentsResult | null = null;
  let consoleWarnSpy: jest.SpyInstance;

  function setLocalizedAttachmentTranslations() {
    reactI18nextMock.__setTranslationOverride('chat.attachments.attachImage', en.chat.attachments.attachImage);
    reactI18nextMock.__setTranslationOverride('chat.attachments.permissionDenied', en.chat.attachments.permissionDenied);
  }

  function renderHarness(options: Parameters<typeof useChatImageAttachments>[0]) {
    latestHook = null;

    const Harness = () => {
      const value = useChatImageAttachments(options);
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
    (ImagePicker.getMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({
      granted: true,
      status: 'granted',
      canAskAgain: true,
    });
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({
      granted: true,
      status: 'granted',
      canAskAgain: true,
    });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{
        uri: 'ph://library-image-1',
        width: 1024,
        height: 768,
        mimeType: 'image/jpeg',
        fileName: 'image.jpg',
        fileSize: 1234,
        type: 'image',
      }],
    });
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock).mockResolvedValue({
      id: 'draft-1',
      pickerUri: 'ph://library-image-1',
      previewUri: 'file:///document/chat-attachments/draft-1.jpg',
      localUri: 'file:///document/chat-attachments/draft-1.jpg',
      mediaType: 'image/jpeg',
      width: 1024,
      height: 768,
      copyStatus: 'copied',
    });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    (Alert.alert as jest.Mock).mockRestore?.();
  });

  it('opens the gallery with the remaining slot limit and stores copied drafts', async () => {
    renderHarness({ enabled: true });

    await act(async () => {
      await latestHook?.attachImages();
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(1);
    });
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_CHAT_IMAGE_ATTACHMENTS,
      legacy: false,
      base64: false,
      exif: false,
    }));
    expect(ImagePicker.getMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(chatAttachmentStorageService.copyImageAssetToDraft).toHaveBeenCalledWith(expect.objectContaining({
      uri: 'ph://library-image-1',
    }));
    expect(latestHook?.drafts[0]).toEqual(expect.objectContaining({
      copyStatus: 'copied',
      localUri: 'file:///document/chat-attachments/draft-1.jpg',
    }));
  });

  it('ignores rapid duplicate attach calls before picking state renders', async () => {
    const pickerDeferred = createDeferred<{
      canceled: false;
      assets: Array<{
        uri: string;
        width: number;
        height: number;
        mimeType: string;
        fileName: string;
        fileSize: number;
        type: string;
      }>;
    }>();
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockReturnValueOnce(pickerDeferred.promise);
    renderHarness({ enabled: true });

    let firstAttachPromise = Promise.resolve();
    let secondAttachPromise = Promise.resolve();
    await act(async () => {
      firstAttachPromise = latestHook?.attachImages() ?? Promise.resolve();
      secondAttachPromise = latestHook?.attachImages() ?? Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      pickerDeferred.resolve({
        canceled: false,
        assets: [{
          uri: 'ph://library-image-1',
          width: 1024,
          height: 768,
          mimeType: 'image/jpeg',
          fileName: 'image.jpg',
          fileSize: 1234,
          type: 'image',
        }],
      });
      await Promise.all([firstAttachPromise, secondAttachPromise]);
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(1);
    });
    expect(chatAttachmentStorageService.copyImageAssetToDraft).toHaveBeenCalledTimes(1);
  });

  it('ignores extra picker assets beyond the remaining slot limit', async () => {
    const initialDrafts = Array.from({ length: MAX_CHAT_IMAGE_ATTACHMENTS - 1 }, (_, index) => ({
      id: `initial-draft-${index}`,
      pickerUri: `ph://initial-image-${index}`,
      previewUri: `file:///document/chat-attachments/initial-draft-${index}.jpg`,
      localUri: `file:///document/chat-attachments/initial-draft-${index}.jpg`,
      copyStatus: 'copied' as const,
    }));
    const appendedDraft = {
      id: 'draft-appended',
      pickerUri: 'ph://library-image-1',
      previewUri: 'file:///document/chat-attachments/draft-appended.jpg',
      localUri: 'file:///document/chat-attachments/draft-appended.jpg',
      copyStatus: 'copied' as const,
    };
    const overflowDraft = {
      id: 'draft-overflow',
      pickerUri: 'ph://library-image-2',
      previewUri: 'file:///document/chat-attachments/draft-overflow.jpg',
      localUri: 'file:///document/chat-attachments/draft-overflow.jpg',
      copyStatus: 'copied' as const,
    };
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{
        uri: 'ph://library-image-1',
        width: 1024,
        height: 768,
        mimeType: 'image/jpeg',
        fileName: 'image-1.jpg',
        fileSize: 1234,
        type: 'image',
      }, {
        uri: 'ph://library-image-2',
        width: 1024,
        height: 768,
        mimeType: 'image/jpeg',
        fileName: 'image-2.jpg',
        fileSize: 5678,
        type: 'image',
      }],
    });
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock)
      .mockResolvedValueOnce(appendedDraft);
    renderHarness({ enabled: true, initialDrafts });

    await act(async () => {
      await latestHook?.attachImages();
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(MAX_CHAT_IMAGE_ATTACHMENTS);
    });
    expect(latestHook?.drafts).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'draft-appended',
    })]));
    expect(latestHook?.drafts).not.toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'draft-overflow',
    })]));
    expect(chatAttachmentStorageService.copyImageAssetToDraft).toHaveBeenCalledTimes(1);
    expect(chatAttachmentStorageService.discardDrafts).not.toHaveBeenCalledWith([overflowDraft]);
  });

  it('blocks selection when the draft limit is already reached', async () => {
    renderHarness({
      enabled: true,
      initialDrafts: Array.from({ length: MAX_CHAT_IMAGE_ATTACHMENTS }, (_, index) => ({
        id: `draft-${index}`,
        pickerUri: `ph://image-${index}`,
        previewUri: `file:///draft-${index}.jpg`,
        copyStatus: 'copied' as const,
      })),
    });

    await act(async () => {
      await latestHook?.attachImages();
    });

    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'chat.attachments.attachImage',
      'chat.attachments.limitReached',
    );
  });

  it('adds failed drafts when copying a picked image fails', async () => {
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock)
      .mockRejectedValueOnce(new Error('copy failed file:///private/image.jpg'));
    renderHarness({ enabled: true });

    await act(async () => {
      await latestHook?.attachImages();
    });

    await waitFor(() => {
      expect(latestHook?.drafts[0]).toEqual(expect.objectContaining({
        pickerUri: 'ph://library-image-1',
        copyStatus: 'failed',
        errorReason: 'copy_failed',
      }));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      'chat.attachments.attachImage',
      'chat.attachments.copyFailed',
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[useChatImageAttachments] Failed to copy selected image',
      expect.objectContaining({
        context: 'copy_selected_image',
        reason: 'copy_failed',
        errorName: 'Error',
      }),
    );
    expect(consoleWarnSpy.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain('file:///private/image.jpg');
  });

  it('marks oversized picked images as failed and shows the too large alert', async () => {
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock)
      .mockRejectedValueOnce(new ChatImageAttachmentTooLargeError());
    renderHarness({ enabled: true });

    await act(async () => {
      await latestHook?.attachImages();
    });

    await waitFor(() => {
      expect(latestHook?.drafts[0]).toEqual(expect.objectContaining({
        pickerUri: 'ph://library-image-1',
        copyStatus: 'failed',
        errorReason: 'too_large',
      }));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      'chat.attachments.attachImage',
      'chat.attachments.tooLarge',
    );
  });

  it('launches the picker without preflighting media-library permission APIs', async () => {
    (ImagePicker.getMediaLibraryPermissionsAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('must not preflight'));
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('must not request'));
    renderHarness({ enabled: true });

    await act(async () => {
      await latestHook?.attachImages();
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(1);
    });
    expect(ImagePicker.getMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
  });

  it('shows localized permission denied alert when the picker rejects for permission without requesting permission', async () => {
    setLocalizedAttachmentTranslations();
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockRejectedValueOnce(Object.assign(
      new Error('Media library permission denied'),
      { code: 'ERR_MEDIA_LIBRARY_PERMISSION_DENIED' },
    ));
    renderHarness({ enabled: true });

    await act(async () => {
      await latestHook?.attachImages();
    });

    expect(ImagePicker.getMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      en.chat.attachments.attachImage,
      en.chat.attachments.permissionDenied,
    );
  });

  it('removes drafts and discards app-owned copied files', async () => {
    renderHarness({
      enabled: true,
      initialDrafts: [{
        id: 'draft-1',
        pickerUri: 'ph://library-image-1',
        previewUri: 'file:///document/chat-attachments/draft-1.jpg',
        localUri: 'file:///document/chat-attachments/draft-1.jpg',
        copyStatus: 'copied',
      }],
    });

    await act(async () => {
      latestHook?.removeDraft('draft-1');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDraft).toHaveBeenCalledWith(expect.objectContaining({
      id: 'draft-1',
    }));
  });

  it('commits drafts without deleting copied attachment files', async () => {
    renderHarness({
      enabled: true,
      initialDrafts: [{
        id: 'draft-1',
        pickerUri: 'ph://library-image-1',
        previewUri: 'file:///document/chat-attachments/draft-1.jpg',
        localUri: 'file:///document/chat-attachments/draft-1.jpg',
        copyStatus: 'copied',
      }],
    });

    await act(async () => {
      latestHook?.commitDrafts();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDrafts).not.toHaveBeenCalled();
    expect(chatAttachmentStorageService.discardDraft).not.toHaveBeenCalled();
  });

  it('hands off drafts for send so cleanup cannot delete in-flight files', async () => {
    const initialDraft = {
      id: 'draft-1',
      pickerUri: 'ph://library-image-1',
      previewUri: 'file:///document/chat-attachments/draft-1.jpg',
      localUri: 'file:///document/chat-attachments/draft-1.jpg',
      copyStatus: 'copied' as const,
    };
    const rendered = renderHarness({
      enabled: true,
      initialDrafts: [initialDraft],
    });
    let consumedDrafts: unknown[] = [];

    await act(async () => {
      consumedDrafts = latestHook?.consumeDraftsForSend() ?? [];
      await Promise.resolve();
    });

    expect(consumedDrafts).toEqual([initialDraft]);
    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });

    rendered.unmount();

    expect(chatAttachmentStorageService.discardDrafts).not.toHaveBeenCalled();
    expect(chatAttachmentStorageService.discardDraft).not.toHaveBeenCalled();
  });

  it('can explicitly discard consumed drafts when send rolls back before append', async () => {
    const initialDraft = {
      id: 'draft-1',
      pickerUri: 'ph://library-image-1',
      previewUri: 'file:///document/chat-attachments/draft-1.jpg',
      localUri: 'file:///document/chat-attachments/draft-1.jpg',
      copyStatus: 'copied' as const,
    };
    renderHarness({
      enabled: true,
      initialDrafts: [initialDraft],
    });
    let consumedDrafts: typeof initialDraft[] = [];

    await act(async () => {
      consumedDrafts = latestHook?.consumeDraftsForSend() as typeof initialDraft[];
      latestHook?.discardDrafts(consumedDrafts, 'send rollback');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([initialDraft]);
    });
  });

  it('can restore consumed drafts for retry and re-own cleanup responsibility', async () => {
    const initialDraft = {
      id: 'draft-1',
      pickerUri: 'ph://library-image-1',
      previewUri: 'file:///document/chat-attachments/draft-1.jpg',
      localUri: 'file:///document/chat-attachments/draft-1.jpg',
      copyStatus: 'copied' as const,
    };
    const rendered = renderHarness({
      enabled: true,
      initialDrafts: [initialDraft],
    });
    let consumedDrafts: typeof initialDraft[] = [];

    await act(async () => {
      consumedDrafts = latestHook?.consumeDraftsForSend() as typeof initialDraft[];
      latestHook?.restoreDraftsForRetry(consumedDrafts);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toEqual([initialDraft]);
    });
    expect(chatAttachmentStorageService.discardDrafts).not.toHaveBeenCalled();

    rendered.unmount();

    await waitFor(() => {
      expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([initialDraft]);
    });
  });

  it('clears and discards drafts when the attachment owner context changes', async () => {
    const initialDraft = {
      id: 'draft-1',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-1.jpg',
      localUri: 'test-dir/chat-attachments/draft-1.jpg',
      copyStatus: 'copied' as const,
    };
    const renderSnapshots: Array<{ draftCount: number; ownerKey: string }> = [];
    const Harness = ({ ownerKey }: { ownerKey: string }) => {
      const value = useChatImageAttachments({
        enabled: true,
        initialDrafts: [initialDraft],
        ownerKey,
      });
      renderSnapshots.push({
        draftCount: value.drafts.length,
        ownerKey,
      });
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const { rerender } = render(<Harness ownerKey="thread-1:model-vision" />);

    expect(latestHook?.drafts).toHaveLength(1);

    rerender(<Harness ownerKey="thread-2:model-vision" />);

    expect(renderSnapshots).not.toEqual(expect.arrayContaining([{
      draftCount: 1,
      ownerKey: 'thread-2:model-vision',
    }]));
    expect(latestHook?.drafts).toHaveLength(0);
    expect(latestHook?.remainingSlots).toBe(MAX_CHAT_IMAGE_ATTACHMENTS);

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([initialDraft]);
  });

  it('clears and discards drafts when image attachments become disabled', async () => {
    const initialDraft = {
      id: 'draft-1',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-1.jpg',
      localUri: 'test-dir/chat-attachments/draft-1.jpg',
      copyStatus: 'copied' as const,
    };
    const renderSnapshots: Array<{ draftCount: number; enabled: boolean }> = [];
    const Harness = ({ enabled }: { enabled: boolean }) => {
      const value = useChatImageAttachments({
        enabled,
        disabledReason: enabled ? 'chat.visionReadiness.ready' : 'chat.visionReadiness.textOnly',
        initialDrafts: [initialDraft],
        ownerKey: 'thread-1:model-vision',
      });
      renderSnapshots.push({
        draftCount: value.drafts.length,
        enabled,
      });
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const { rerender } = render(<Harness enabled />);

    expect(latestHook?.drafts).toHaveLength(1);

    rerender(<Harness enabled={false} />);

    expect(renderSnapshots).not.toEqual(expect.arrayContaining([{
      draftCount: 1,
      enabled: false,
    }]));
    expect(latestHook?.drafts).toHaveLength(0);
    expect(latestHook?.remainingSlots).toBe(MAX_CHAT_IMAGE_ATTACHMENTS);

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([initialDraft]);
  });

  it('discards owned drafts once when the attachment owner changes and immediately unmounts', async () => {
    const initialDraft = {
      id: 'draft-owner-unmount',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-owner-unmount.jpg',
      localUri: 'test-dir/chat-attachments/draft-owner-unmount.jpg',
      copyStatus: 'copied' as const,
    };
    const Harness = ({ ownerKey }: { ownerKey: string }) => {
      const value = useChatImageAttachments({
        enabled: true,
        initialDrafts: [initialDraft],
        ownerKey,
      });
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const { rerender, unmount } = render(<Harness ownerKey="thread-1:model-vision" />);

    expect(latestHook?.drafts).toHaveLength(1);

    await act(async () => {
      rerender(<Harness ownerKey="thread-2:model-vision" />);
      unmount();
    });

    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledTimes(1);
    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([initialDraft]);
  });

  it('discards owned drafts once when image attachments become disabled and immediately unmounts', async () => {
    const initialDraft = {
      id: 'draft-disabled-unmount',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-disabled-unmount.jpg',
      localUri: 'test-dir/chat-attachments/draft-disabled-unmount.jpg',
      copyStatus: 'copied' as const,
    };
    const Harness = ({ enabled }: { enabled: boolean }) => {
      const value = useChatImageAttachments({
        enabled,
        disabledReason: enabled ? 'chat.visionReadiness.ready' : 'chat.visionReadiness.textOnly',
        initialDrafts: [initialDraft],
        ownerKey: 'thread-1:model-vision',
      });
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const { rerender, unmount } = render(<Harness enabled />);

    expect(latestHook?.drafts).toHaveLength(1);

    await act(async () => {
      rerender(<Harness enabled={false} />);
      unmount();
    });

    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledTimes(1);
    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([initialDraft]);
  });

  it('discards picker results that arrive after the attachment owner context changes', async () => {
    const staleDraft = {
      id: 'draft-stale',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-stale.jpg',
      localUri: 'test-dir/chat-attachments/draft-stale.jpg',
      copyStatus: 'copied' as const,
    };
    let resolveCopy: ((draft: typeof staleDraft) => void) | null = null;
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCopy = resolve;
      }),
    );
    const Harness = ({ ownerKey }: { ownerKey: string }) => {
      const value = useChatImageAttachments({ enabled: true, ownerKey });
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const { rerender } = render(<Harness ownerKey="thread-1:model-vision" />);

    await act(async () => {
      const attachPromise = latestHook?.attachImages() ?? Promise.resolve();
      for (let attempt = 0; attempt < 10 && !resolveCopy; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      if (!resolveCopy) {
        throw new Error('copy promise was not created');
      }
      rerender(<Harness ownerKey="thread-2:model-vision" />);
      resolveCopy?.(staleDraft);
      await attachPromise;
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([staleDraft]);
  });

  it('does not start copying later picker assets after the owner context changes', async () => {
    const firstDraft = {
      id: 'draft-first-stale',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-first-stale.jpg',
      localUri: 'test-dir/chat-attachments/draft-first-stale.jpg',
      copyStatus: 'copied' as const,
    };
    const firstCopyGate: { resolve?: (draft: typeof firstDraft) => void } = {};
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'ph://library-image-1',
          width: 1024,
          height: 768,
          mimeType: 'image/jpeg',
          fileName: 'image-1.jpg',
          fileSize: 1234,
          type: 'image',
        },
        {
          uri: 'ph://library-image-2',
          width: 1024,
          height: 768,
          mimeType: 'image/jpeg',
          fileName: 'image-2.jpg',
          fileSize: 1234,
          type: 'image',
        },
      ],
    });
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        firstCopyGate.resolve = resolve;
      }),
    );
    const Harness = ({ ownerKey }: { ownerKey: string }) => {
      const value = useChatImageAttachments({ enabled: true, ownerKey });
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const { rerender } = render(<Harness ownerKey="thread-1:model-vision" />);

    let attachPromise = Promise.resolve();
    await act(async () => {
      attachPromise = latestHook?.attachImages() ?? Promise.resolve();
      for (let attempt = 0; attempt < 10 && !firstCopyGate.resolve; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      if (!firstCopyGate.resolve) {
        throw new Error('copy promise was not created');
      }
    });

    const releaseFirstCopy = firstCopyGate.resolve;
    if (!releaseFirstCopy) {
      throw new Error('copy promise was not created');
    }
    await act(async () => {
      rerender(<Harness ownerKey="thread-2:model-vision" />);
    });

    await act(async () => {
      releaseFirstCopy(firstDraft);
      await attachPromise;
    });

    expect(chatAttachmentStorageService.copyImageAssetToDraft).toHaveBeenCalledTimes(1);
    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([firstDraft]);
  });

  it('discards picker results that arrive after image attachments become disabled', async () => {
    const staleDraft = {
      id: 'draft-disabled-stale',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-disabled-stale.jpg',
      localUri: 'test-dir/chat-attachments/draft-disabled-stale.jpg',
      copyStatus: 'copied' as const,
    };
    let resolveCopy: ((draft: typeof staleDraft) => void) | null = null;
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCopy = resolve;
      }),
    );
    const Harness = ({ enabled }: { enabled: boolean }) => {
      const value = useChatImageAttachments({
        enabled,
        disabledReason: enabled ? 'chat.visionReadiness.ready' : 'chat.visionReadiness.textOnly',
        ownerKey: 'thread-1:model-vision',
      });
      useEffect(() => {
        latestHook = value;
      }, [value]);
      return null;
    };

    const { rerender } = render(<Harness enabled />);

    await act(async () => {
      const attachPromise = latestHook?.attachImages() ?? Promise.resolve();
      for (let attempt = 0; attempt < 10 && !resolveCopy; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      if (!resolveCopy) {
        throw new Error('copy promise was not created');
      }
      rerender(<Harness enabled={false} />);
      resolveCopy?.(staleDraft);
      await attachPromise;
    });

    await waitFor(() => {
      expect(latestHook?.drafts).toHaveLength(0);
    });
    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([staleDraft]);
  });

  it('discards copied drafts when unmounted during a pending copy', async () => {
    const copiedDraft = {
      id: 'draft-after-unmount',
      pickerUri: 'ph://library-image-1',
      previewUri: 'test-dir/chat-attachments/draft-after-unmount.jpg',
      localUri: 'test-dir/chat-attachments/draft-after-unmount.jpg',
      copyStatus: 'copied' as const,
    };
    let resolveCopy: ((draft: typeof copiedDraft) => void) | null = null;
    (chatAttachmentStorageService.copyImageAssetToDraft as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCopy = resolve;
      }),
    );
    const { unmount } = renderHarness({ enabled: true });

    let attachPromise = Promise.resolve();
    await act(async () => {
      attachPromise = latestHook?.attachImages() ?? Promise.resolve();
      for (let attempt = 0; attempt < 10 && !resolveCopy; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });
    if (!resolveCopy) {
      throw new Error('copy promise was not created');
    }

    await act(async () => {
      unmount();
    });
    await act(async () => {
      resolveCopy?.(copiedDraft);
      await attachPromise;
    });

    expect(chatAttachmentStorageService.discardDrafts).toHaveBeenCalledWith([copiedDraft]);
  });

  it('does not open the picker when image attachments are disabled', async () => {
    renderHarness({
      enabled: false,
      disabledReason: 'chat.visionReadiness.textOnly',
    });

    await act(async () => {
      await latestHook?.attachImages();
    });

    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'chat.attachments.attachImage',
      'chat.visionReadiness.textOnly',
    );
  });
});
