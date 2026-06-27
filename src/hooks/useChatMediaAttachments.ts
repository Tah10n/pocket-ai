import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import type { ChatMediaAttachmentDraft } from '@/types/attachments';
import {
  MAX_CHAT_ATTACHMENTS_BY_KIND,
  getSendableDraftMediaAttachments,
  validateChatMediaAttachmentLimit,
} from '@/utils/chatAttachments';
import {
  buildFailedMediaAttachmentDraft,
  chatAttachmentStorageService,
  isChatMediaAttachmentTooLargeError,
  isChatMediaAttachmentUnsupportedTypeError,
} from '@/services/ChatAttachmentStorageService';

export type UseChatMediaAttachmentsOptions = {
  audioEnabled: boolean;
  audioDisabledReason?: string;
  ownerKey?: string | null;
};

export type ConsumeChatMediaDraftsForSendOptions = {
  includeAudio?: boolean;
};

export type UseChatMediaAttachmentsResult = {
  drafts: ChatMediaAttachmentDraft[];
  isPickingAudio: boolean;
  remainingAudioSlots: number;
  attachAudio: () => Promise<void>;
  removeDraft: (draftOrId: ChatMediaAttachmentDraft | string, index?: number) => void;
  clearDrafts: () => void;
  clearFailedDrafts: () => void;
  consumeDraftsForSend: (options?: ConsumeChatMediaDraftsForSendOptions) => ChatMediaAttachmentDraft[];
  restoreDraftsForRetry: (drafts: readonly ChatMediaAttachmentDraft[]) => void;
  discardDrafts: (drafts: readonly ChatMediaAttachmentDraft[], context?: string) => void;
};

const AUDIO_PICKER_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
];

function getDraftKey(draft: ChatMediaAttachmentDraft): string {
  return draft.id ?? draft.localUri ?? draft.pickerUri;
}

function getSanitizedErrorDetails(error: unknown): { errorName: string } | { errorType: string } {
  return error instanceof Error
    ? { errorName: error.name || 'Error' }
    : { errorType: typeof error };
}

function discardDraftsQuietly(drafts: readonly ChatMediaAttachmentDraft[], context: string): void {
  if (drafts.length === 0) {
    return;
  }

  void chatAttachmentStorageService.discardMediaDrafts(drafts).catch((error) => {
    console.warn('[useChatMediaAttachments] Failed to discard drafts', {
      context,
      ...getSanitizedErrorDetails(error),
    });
  });
}

function hasSameDraftReferences(
  left: readonly ChatMediaAttachmentDraft[],
  right: readonly ChatMediaAttachmentDraft[],
): boolean {
  return left.length === right.length && left.every((draft, index) => draft === right[index]);
}

function shouldConsumeMediaDraftForSend(
  draft: ChatMediaAttachmentDraft,
  options: ConsumeChatMediaDraftsForSendOptions | undefined,
): boolean {
  const includeAudio = options?.includeAudio ?? true;

  return draft.kind === 'audio' && includeAudio;
}

export function useChatMediaAttachments({
  audioEnabled,
  audioDisabledReason,
  ownerKey = null,
}: UseChatMediaAttachmentsOptions): UseChatMediaAttachmentsResult {
  const { t } = useTranslation();
  const normalizedOwnerKey = ownerKey ?? 'default';
  const [draftState, setDraftState] = useState<{
    drafts: ChatMediaAttachmentDraft[];
    ownerKey: string;
  }>(() => ({ drafts: [], ownerKey: normalizedOwnerKey }));
  const [isPickingAudio, setIsPickingAudio] = useState(false);
  const emptyDrafts = useMemo<ChatMediaAttachmentDraft[]>(() => [], []);
  const drafts = draftState.ownerKey === normalizedOwnerKey ? draftState.drafts : emptyDrafts;
  const draftsRef = useRef<ChatMediaAttachmentDraft[]>(drafts);
  const ownedDraftsRef = useRef<ChatMediaAttachmentDraft[]>(draftState.drafts);
  const mountedRef = useRef(true);
  const pickingLockRef = useRef(false);
  const ownerKeyRef = useRef(normalizedOwnerKey);
  const ownerGenerationRef = useRef(0);
  const audioCount = drafts.filter((draft) => draft.kind === 'audio').length;
  const remainingAudioSlots = Math.max(0, MAX_CHAT_ATTACHMENTS_BY_KIND.audio - audioCount);

  if (ownerKeyRef.current !== normalizedOwnerKey) {
    ownerKeyRef.current = normalizedOwnerKey;
    ownerGenerationRef.current += 1;
  }

  draftsRef.current = drafts;

  const releaseOwnedDrafts = useCallback((draftsToRelease: readonly ChatMediaAttachmentDraft[]) => {
    if (draftsToRelease.length === 0 || ownedDraftsRef.current.length === 0) {
      return [];
    }

    const remainingDraftsToRelease = [...draftsToRelease];
    const releasedDrafts: ChatMediaAttachmentDraft[] = [];
    ownedDraftsRef.current = ownedDraftsRef.current.filter((draft) => {
      const matchingReferenceIndex = remainingDraftsToRelease.findIndex((draftToRelease) => draftToRelease === draft);
      if (matchingReferenceIndex < 0) {
        return true;
      }

      remainingDraftsToRelease.splice(matchingReferenceIndex, 1);
      releasedDrafts.push(draft);
      return false;
    });

    return releasedDrafts;
  }, []);

  const discardOwnedDraftsQuietly = useCallback((
    draftsToDiscard: readonly ChatMediaAttachmentDraft[],
    context: string,
  ) => {
    discardDraftsQuietly(releaseOwnedDrafts(draftsToDiscard), context);
  }, [releaseOwnedDrafts]);

  const showAttachmentAlert = useCallback((titleKey: string, messageKey: string, count?: number) => {
    Alert.alert(t(titleKey), t(messageKey, { count }));
  }, [t]);

  const appendDrafts = useCallback((nextDrafts: readonly ChatMediaAttachmentDraft[]) => {
    draftsRef.current = [...draftsRef.current, ...nextDrafts];
    ownedDraftsRef.current = draftsRef.current;
    setDraftState({
      drafts: draftsRef.current,
      ownerKey: ownerKeyRef.current,
    });
  }, []);

  const attachAudio = useCallback(async () => {
    if (!mountedRef.current || pickingLockRef.current) {
      return;
    }

    if (!audioEnabled) {
      showAttachmentAlert('chat.attachments.attachAudio', audioDisabledReason ?? 'chat.attachments.audioPickerDisabled');
      return;
    }

    const limit = validateChatMediaAttachmentLimit('audio', draftsRef.current.filter((draft) => draft.kind === 'audio').length, 1);
    if (!limit.ok) {
      showAttachmentAlert('chat.attachments.attachAudio', 'chat.attachments.audioLimitReached', MAX_CHAT_ATTACHMENTS_BY_KIND.audio);
      return;
    }

    const ownerKeyAtPickStart = ownerKeyRef.current;
    const ownerGenerationAtPickStart = ownerGenerationRef.current;
    const isCurrentFlow = () => (
      mountedRef.current
      && ownerKeyRef.current === ownerKeyAtPickStart
      && ownerGenerationRef.current === ownerGenerationAtPickStart
    );

    pickingLockRef.current = true;
    setIsPickingAudio(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: AUDIO_PICKER_MIME_TYPES,
        multiple: false,
        copyToCacheDirectory: true,
        base64: false,
      });

      if (!isCurrentFlow() || result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      let nextDraft: ChatMediaAttachmentDraft;
      try {
        nextDraft = await chatAttachmentStorageService.copyAudioAssetToDraft(asset);
      } catch (error) {
        const reason = isChatMediaAttachmentTooLargeError(error)
          ? 'too_large'
          : isChatMediaAttachmentUnsupportedTypeError(error)
            ? 'unsupported_type'
            : 'copy_failed';
        console.warn('[useChatMediaAttachments] Failed to copy selected audio', {
          context: 'copy_selected_audio',
          reason,
          ...getSanitizedErrorDetails(error),
        });
        nextDraft = buildFailedMediaAttachmentDraft('audio', asset, reason);
      }

      if (!isCurrentFlow()) {
        discardDraftsQuietly([nextDraft], 'stale picked audio draft');
        return;
      }

      appendDrafts([nextDraft]);
      if (nextDraft.copyStatus === 'failed') {
        const key = nextDraft.errorReason === 'too_large'
          ? 'chat.attachments.audioTooLarge'
          : nextDraft.errorReason === 'unsupported_type'
            ? 'chat.attachments.audioUnsupported'
            : 'chat.attachments.audioCopyFailed';
        showAttachmentAlert('chat.attachments.attachAudio', key);
      }
    } catch (error) {
      console.warn('[useChatMediaAttachments] Failed to open audio picker', {
        context: 'open_audio_picker',
        ...getSanitizedErrorDetails(error),
      });
      if (isCurrentFlow()) {
        showAttachmentAlert('chat.attachments.attachAudio', 'chat.attachments.audioPickerFailed');
      }
    } finally {
      pickingLockRef.current = false;
      if (mountedRef.current) {
        setIsPickingAudio(false);
      }
    }
  }, [appendDrafts, audioDisabledReason, audioEnabled, showAttachmentAlert]);

  const removeDraft = useCallback((draftOrId: ChatMediaAttachmentDraft | string, index?: number) => {
    if (!mountedRef.current) {
      return;
    }

    const targetKey = typeof draftOrId === 'string' ? draftOrId : getDraftKey(draftOrId);
    const targetIndex = (() => {
      if (typeof index === 'number' && index >= 0 && index < draftsRef.current.length) {
        const draftAtIndex = draftsRef.current[index];
        if (
          typeof draftOrId === 'string'
            ? getDraftKey(draftAtIndex) === targetKey
            : draftAtIndex === draftOrId || getDraftKey(draftAtIndex) === targetKey
        ) {
          return index;
        }
      }

      if (typeof draftOrId !== 'string') {
        const referenceIndex = draftsRef.current.findIndex((draft) => draft === draftOrId);
        if (referenceIndex >= 0) {
          return referenceIndex;
        }
      }

      return draftsRef.current.findIndex((draft) => getDraftKey(draft) === targetKey);
    })();

    const removedDraft = targetIndex >= 0 ? draftsRef.current[targetIndex] : undefined;
    if (removedDraft) {
      releaseOwnedDrafts([removedDraft]).forEach((draftToDiscard) => {
        void chatAttachmentStorageService.discardMediaDraft(draftToDiscard).catch((error) => {
          console.warn('[useChatMediaAttachments] Failed to discard removed draft', {
            context: 'remove_draft',
            ...getSanitizedErrorDetails(error),
          });
        });
      });
    }

    draftsRef.current = targetIndex >= 0
      ? draftsRef.current.filter((_, draftIndex) => draftIndex !== targetIndex)
      : draftsRef.current;
    setDraftState({
      drafts: draftsRef.current,
      ownerKey: ownerKeyRef.current,
    });
  }, [releaseOwnedDrafts]);

  const clearDrafts = useCallback(() => {
    ownerGenerationRef.current += 1;
    discardOwnedDraftsQuietly(ownedDraftsRef.current, 'media drafts');
    draftsRef.current = [];
    if (mountedRef.current) {
      setDraftState({ drafts: [], ownerKey: ownerKeyRef.current });
    }
  }, [discardOwnedDraftsQuietly]);

  const clearFailedDrafts = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    const failedDrafts = draftsRef.current.filter((draft) => draft.copyStatus === 'failed');
    if (failedDrafts.length === 0) {
      return;
    }

    ownerGenerationRef.current += 1;
    discardOwnedDraftsQuietly(failedDrafts, 'failed media drafts after successful send');
    draftsRef.current = draftsRef.current.filter((draft) => draft.copyStatus !== 'failed');
    setDraftState({ drafts: draftsRef.current, ownerKey: ownerKeyRef.current });
  }, [discardOwnedDraftsQuietly]);

  const consumeDraftsForSend = useCallback((options?: ConsumeChatMediaDraftsForSendOptions): ChatMediaAttachmentDraft[] => {
    const draftsToConsume = getSendableDraftMediaAttachments(draftsRef.current)
      .filter((draft) => shouldConsumeMediaDraftForSend(draft, options));
    if (draftsToConsume.length === 0) {
      return [];
    }

    ownerGenerationRef.current += 1;
    releaseOwnedDrafts(draftsToConsume);
    const queue = [...draftsToConsume];
    draftsRef.current = draftsRef.current.filter((draft) => {
      const matchingReferenceIndex = queue.findIndex((draftToConsume) => draftToConsume === draft);
      if (matchingReferenceIndex >= 0) {
        queue.splice(matchingReferenceIndex, 1);
        return false;
      }
      return true;
    });
    if (mountedRef.current) {
      setDraftState({ drafts: draftsRef.current, ownerKey: ownerKeyRef.current });
    }

    return draftsToConsume;
  }, [releaseOwnedDrafts]);

  const restoreDraftsForRetry = useCallback((draftsToRestore: readonly ChatMediaAttachmentDraft[]) => {
    if (draftsToRestore.length === 0 || !mountedRef.current) {
      return;
    }

    const currentKeys = new Set(draftsRef.current.map(getDraftKey));
    const restoredDrafts = draftsToRestore.filter((draft) => !currentKeys.has(getDraftKey(draft)));
    if (restoredDrafts.length === 0) {
      return;
    }

    const nextDrafts = [...draftsRef.current, ...restoredDrafts]
      .filter((draft, index, allDrafts) => (
        draft.kind !== 'audio'
        || allDrafts.slice(0, index + 1).filter((entry) => entry.kind === 'audio').length <= MAX_CHAT_ATTACHMENTS_BY_KIND.audio
      ));
    const ownedKeys = new Set(ownedDraftsRef.current.map(getDraftKey));
    const restoredOwnedDrafts = restoredDrafts.filter((draft) => (
      nextDrafts.some((entry) => getDraftKey(entry) === getDraftKey(draft)) && !ownedKeys.has(getDraftKey(draft))
    ));
    if (restoredOwnedDrafts.length > 0) {
      ownedDraftsRef.current = [...ownedDraftsRef.current, ...restoredOwnedDrafts];
    }

    draftsRef.current = nextDrafts;
    setDraftState({ drafts: nextDrafts, ownerKey: ownerKeyRef.current });
  }, []);

  const discardDrafts = useCallback((draftsToDiscard: readonly ChatMediaAttachmentDraft[], context = 'media drafts') => {
    discardDraftsQuietly(draftsToDiscard, context);
  }, []);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    if (draftState.drafts.length === 0) {
      return;
    }

    if (draftState.ownerKey === normalizedOwnerKey) {
      return;
    }

    discardDraftsQuietly(releaseOwnedDrafts(draftState.drafts), 'media drafts from previous owner');
    setDraftState((current) => (
      current === draftState || (
        current.ownerKey === draftState.ownerKey
        && hasSameDraftReferences(current.drafts, draftState.drafts)
      )
        ? { drafts: [], ownerKey: normalizedOwnerKey }
        : current
    ));
  }, [draftState, normalizedOwnerKey, releaseOwnedDrafts]);

  useEffect(() => () => {
    mountedRef.current = false;
    ownerGenerationRef.current += 1;
    pickingLockRef.current = false;
    discardDraftsQuietly(ownedDraftsRef.current, 'media drafts during cleanup');
    ownedDraftsRef.current = [];
    draftsRef.current = [];
  }, []);

  return useMemo(() => ({
    drafts,
    isPickingAudio,
    remainingAudioSlots,
    attachAudio,
    removeDraft,
    clearDrafts,
    clearFailedDrafts,
    consumeDraftsForSend,
    restoreDraftsForRetry,
    discardDrafts,
  }), [
    attachAudio,
    clearDrafts,
    clearFailedDrafts,
    consumeDraftsForSend,
    discardDrafts,
    drafts,
    isPickingAudio,
    remainingAudioSlots,
    removeDraft,
    restoreDraftsForRetry,
  ]);
}
