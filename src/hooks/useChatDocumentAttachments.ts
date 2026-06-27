import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import type { ChatDocumentAttachmentDraft } from '@/types/attachments';
import {
  MAX_CHAT_ATTACHMENTS_BY_KIND,
  getSendableDraftDocumentAttachments,
  validateChatDocumentAttachmentLimit,
} from '@/utils/chatAttachments';
import {
  buildFailedDocumentAttachmentDraft,
  chatAttachmentStorageService,
  isChatDocumentAttachmentTooLargeError,
  isChatDocumentAttachmentUnsupportedTypeError,
} from '@/services/ChatAttachmentStorageService';

export type UseChatDocumentAttachmentsOptions = {
  enabled: boolean;
  disabledReason?: string;
  ownerKey?: string | null;
};

export type UseChatDocumentAttachmentsResult = {
  drafts: ChatDocumentAttachmentDraft[];
  isPicking: boolean;
  remainingSlots: number;
  attachDocuments: () => Promise<void>;
  removeDraft: (draftOrId: ChatDocumentAttachmentDraft | string, index?: number) => void;
  clearDrafts: () => void;
  clearFailedDrafts: () => void;
  consumeDraftsForSend: () => ChatDocumentAttachmentDraft[];
  restoreDraftsForRetry: (drafts: readonly ChatDocumentAttachmentDraft[]) => void;
  discardDrafts: (drafts: readonly ChatDocumentAttachmentDraft[], context?: string) => void;
};

const DOCUMENT_PICKER_MIME_TYPES = [
  'application/json',
  'application/pdf',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
];

function getDraftKey(draft: ChatDocumentAttachmentDraft): string {
  return draft.id ?? draft.localUri ?? draft.pickerUri;
}

function getSanitizedErrorDetails(error: unknown): { errorName: string } | { errorType: string } {
  return error instanceof Error
    ? { errorName: error.name || 'Error' }
    : { errorType: typeof error };
}

function discardDraftsQuietly(drafts: readonly ChatDocumentAttachmentDraft[], context: string): void {
  if (drafts.length === 0) {
    return;
  }

  void chatAttachmentStorageService.discardDocumentDrafts(drafts).catch((error) => {
    console.warn('[useChatDocumentAttachments] Failed to discard drafts', {
      context,
      ...getSanitizedErrorDetails(error),
    });
  });
}

function hasSameDraftReferences(
  left: readonly ChatDocumentAttachmentDraft[],
  right: readonly ChatDocumentAttachmentDraft[],
): boolean {
  return left.length === right.length && left.every((draft, index) => draft === right[index]);
}

export function useChatDocumentAttachments({
  enabled,
  disabledReason,
  ownerKey = null,
}: UseChatDocumentAttachmentsOptions): UseChatDocumentAttachmentsResult {
  const { t } = useTranslation();
  const normalizedOwnerKey = ownerKey ?? 'default';
  const [draftState, setDraftState] = useState<{
    drafts: ChatDocumentAttachmentDraft[];
    ownerKey: string;
  }>(() => ({
    drafts: [],
    ownerKey: normalizedOwnerKey,
  }));
  const [isPicking, setIsPicking] = useState(false);
  const emptyDrafts = useMemo<ChatDocumentAttachmentDraft[]>(() => [], []);
  const drafts = enabled && draftState.ownerKey === normalizedOwnerKey
    ? draftState.drafts
    : emptyDrafts;
  const draftsRef = useRef<ChatDocumentAttachmentDraft[]>(drafts);
  const ownedDraftsRef = useRef<ChatDocumentAttachmentDraft[]>(draftState.drafts);
  const mountedRef = useRef(true);
  const pickingLockRef = useRef(false);
  const ownerKeyRef = useRef(normalizedOwnerKey);
  const ownerGenerationRef = useRef(0);
  const remainingSlots = Math.max(0, MAX_CHAT_ATTACHMENTS_BY_KIND.document - drafts.length);

  if (ownerKeyRef.current !== normalizedOwnerKey) {
    ownerKeyRef.current = normalizedOwnerKey;
    ownerGenerationRef.current += 1;
  }

  draftsRef.current = drafts;

  const showAttachmentAlert = useCallback((messageKey: string) => {
    Alert.alert(t('chat.attachments.attachDocument'), t(messageKey, {
      count: MAX_CHAT_ATTACHMENTS_BY_KIND.document,
    }));
  }, [t]);

  const releaseOwnedDrafts = useCallback((draftsToRelease: readonly ChatDocumentAttachmentDraft[]) => {
    if (draftsToRelease.length === 0 || ownedDraftsRef.current.length === 0) {
      return [];
    }

    const remainingDraftsToRelease = [...draftsToRelease];
    const releasedDrafts: ChatDocumentAttachmentDraft[] = [];
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
    draftsToDiscard: readonly ChatDocumentAttachmentDraft[],
    context: string,
  ) => {
    discardDraftsQuietly(releaseOwnedDrafts(draftsToDiscard), context);
  }, [releaseOwnedDrafts]);

  const attachDocuments = useCallback(async () => {
    if (!mountedRef.current || pickingLockRef.current) {
      return;
    }

    if (!enabled) {
      showAttachmentAlert(disabledReason ?? 'chat.attachments.documentPickerDisabled');
      return;
    }

    const ownerKeyAtPickStart = ownerKeyRef.current;
    const ownerGenerationAtPickStart = ownerGenerationRef.current;
    const limit = validateChatDocumentAttachmentLimit(draftsRef.current.length, 1);
    if (!limit.ok) {
      showAttachmentAlert('chat.attachments.documentLimitReached');
      return;
    }

    const isCurrentFlow = () => (
      mountedRef.current
      && ownerKeyRef.current === ownerKeyAtPickStart
      && ownerGenerationRef.current === ownerGenerationAtPickStart
    );

    pickingLockRef.current = true;
    setIsPicking(true);
    try {
      const pickerRemainingSlots = Math.max(0, MAX_CHAT_ATTACHMENTS_BY_KIND.document - draftsRef.current.length);
      if (pickerRemainingSlots < 1) {
        showAttachmentAlert('chat.attachments.documentLimitReached');
        return;
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: DOCUMENT_PICKER_MIME_TYPES,
        multiple: true,
        copyToCacheDirectory: true,
        base64: false,
      });

      if (!isCurrentFlow() || result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const selectedAssets = result.assets.slice(0, pickerRemainingSlots);
      const nextDrafts: ChatDocumentAttachmentDraft[] = [];
      for (const asset of selectedAssets) {
        if (!isCurrentFlow()) {
          discardDraftsQuietly(nextDrafts, 'stale picked document drafts');
          return;
        }

        let nextDraft: ChatDocumentAttachmentDraft;
        try {
          nextDraft = await chatAttachmentStorageService.copyDocumentAssetToDraft(asset);
        } catch (error) {
          const reason = isChatDocumentAttachmentTooLargeError(error)
            ? 'too_large'
            : isChatDocumentAttachmentUnsupportedTypeError(error)
              ? 'unsupported_type'
              : 'copy_failed';
          console.warn('[useChatDocumentAttachments] Failed to copy selected document', {
            context: 'copy_selected_document',
            reason,
            ...getSanitizedErrorDetails(error),
          });
          nextDraft = buildFailedDocumentAttachmentDraft(asset, reason);
        }

        if (!isCurrentFlow()) {
          discardDraftsQuietly([...nextDrafts, nextDraft], 'stale picked document drafts');
          return;
        }

        nextDrafts.push(nextDraft);
      }

      const availableSlots = Math.max(0, MAX_CHAT_ATTACHMENTS_BY_KIND.document - draftsRef.current.length);
      const draftsToAppend = nextDrafts.slice(0, availableSlots);
      const draftsToDiscard = nextDrafts.slice(availableSlots);
      if (draftsToAppend.length === 0) {
        discardDraftsQuietly(nextDrafts, 'overflow picked document drafts');
        return;
      }

      draftsRef.current = [
        ...draftsRef.current,
        ...draftsToAppend,
      ];
      ownedDraftsRef.current = draftsRef.current;
      setDraftState({
        drafts: draftsRef.current,
        ownerKey: ownerKeyRef.current,
      });
      discardDraftsQuietly(draftsToDiscard, 'overflow picked document drafts');

      if (draftsToAppend.some((draft) => draft.copyStatus === 'failed' && draft.errorReason === 'too_large')) {
        showAttachmentAlert('chat.attachments.documentTooLarge');
      } else if (draftsToAppend.some((draft) => draft.copyStatus === 'failed' && draft.errorReason === 'unsupported_type')) {
        showAttachmentAlert('chat.attachments.documentUnsupported');
      } else if (draftsToAppend.some((draft) => draft.copyStatus === 'failed')) {
        showAttachmentAlert('chat.attachments.documentCopyFailed');
      }
    } catch (error) {
      console.warn('[useChatDocumentAttachments] Failed to open document picker', {
        context: 'open_document_picker',
        ...getSanitizedErrorDetails(error),
      });
      if (isCurrentFlow()) {
        showAttachmentAlert('chat.attachments.documentPickerFailed');
      }
    } finally {
      pickingLockRef.current = false;
      if (mountedRef.current) {
        setIsPicking(false);
      }
    }
  }, [disabledReason, enabled, showAttachmentAlert]);

  const removeDraft = useCallback((draftOrId: ChatDocumentAttachmentDraft | string, index?: number) => {
    if (!mountedRef.current) {
      return;
    }

    const targetKey = typeof draftOrId === 'string' ? draftOrId : getDraftKey(draftOrId);
    const targetIndex = (() => {
      if (
        typeof index === 'number'
        && index >= 0
        && index < draftsRef.current.length
      ) {
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
        void chatAttachmentStorageService.discardDocumentDraft(draftToDiscard).catch((error) => {
          console.warn('[useChatDocumentAttachments] Failed to discard removed draft', {
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
    discardOwnedDraftsQuietly(ownedDraftsRef.current, 'document drafts');
    draftsRef.current = [];
    if (mountedRef.current) {
      setDraftState({
        drafts: [],
        ownerKey: ownerKeyRef.current,
      });
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
    discardOwnedDraftsQuietly(failedDrafts, 'failed document drafts after successful send');
    draftsRef.current = draftsRef.current.filter((draft) => draft.copyStatus !== 'failed');
    setDraftState({
      drafts: draftsRef.current,
      ownerKey: ownerKeyRef.current,
    });
  }, [discardOwnedDraftsQuietly]);

  const consumeDraftsForSend = useCallback((): ChatDocumentAttachmentDraft[] => {
    const draftsToConsume = getSendableDraftDocumentAttachments(draftsRef.current);
    if (draftsToConsume.length === 0) {
      return [];
    }

    ownerGenerationRef.current += 1;
    releaseOwnedDrafts(draftsToConsume);
    const draftsToConsumeQueue = [...draftsToConsume];
    draftsRef.current = draftsRef.current.filter((draft) => {
      const matchingReferenceIndex = draftsToConsumeQueue.findIndex((draftToConsume) => draftToConsume === draft);
      if (matchingReferenceIndex >= 0) {
        draftsToConsumeQueue.splice(matchingReferenceIndex, 1);
        return false;
      }

      return true;
    });
    if (mountedRef.current) {
      setDraftState({
        drafts: draftsRef.current,
        ownerKey: ownerKeyRef.current,
      });
    }

    return draftsToConsume;
  }, [releaseOwnedDrafts]);

  const restoreDraftsForRetry = useCallback((draftsToRestore: readonly ChatDocumentAttachmentDraft[]) => {
    if (draftsToRestore.length === 0 || !mountedRef.current) {
      return;
    }

    const currentDrafts = draftsRef.current;
    const currentDraftKeys = new Set(currentDrafts.map(getDraftKey));
    const restoredDrafts = draftsToRestore.filter((draft) => !currentDraftKeys.has(getDraftKey(draft)));
    if (restoredDrafts.length === 0) {
      return;
    }

    const nextDrafts = [...currentDrafts, ...restoredDrafts].slice(0, MAX_CHAT_ATTACHMENTS_BY_KIND.document);
    const nextDraftKeys = new Set(nextDrafts.map(getDraftKey));
    const ownedDraftKeys = new Set(ownedDraftsRef.current.map(getDraftKey));
    const restoredOwnedDrafts = restoredDrafts.filter((draft) => (
      nextDraftKeys.has(getDraftKey(draft)) && !ownedDraftKeys.has(getDraftKey(draft))
    ));

    if (restoredOwnedDrafts.length > 0) {
      ownedDraftsRef.current = [...ownedDraftsRef.current, ...restoredOwnedDrafts];
    }

    draftsRef.current = nextDrafts;
    setDraftState({
      drafts: nextDrafts,
      ownerKey: ownerKeyRef.current,
    });
  }, []);

  const discardDrafts = useCallback((draftsToDiscard: readonly ChatDocumentAttachmentDraft[], context = 'document drafts') => {
    discardDraftsQuietly(draftsToDiscard, context);
  }, []);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    if (draftState.drafts.length === 0) {
      return;
    }

    if (enabled && draftState.ownerKey === normalizedOwnerKey) {
      return;
    }

    discardDraftsQuietly(
      releaseOwnedDrafts(draftState.drafts),
      enabled ? 'document drafts from previous owner' : 'document drafts while disabled',
    );
    setDraftState((current) => (
      current === draftState || (
        current.ownerKey === draftState.ownerKey
        && hasSameDraftReferences(current.drafts, draftState.drafts)
      )
        ? {
          drafts: [],
          ownerKey: normalizedOwnerKey,
        }
        : current
    ));
  }, [draftState, enabled, normalizedOwnerKey, releaseOwnedDrafts]);

  useEffect(() => () => {
    mountedRef.current = false;
    ownerGenerationRef.current += 1;
    pickingLockRef.current = false;
    discardDraftsQuietly(ownedDraftsRef.current, 'document drafts during cleanup');
    ownedDraftsRef.current = [];
    draftsRef.current = [];
  }, []);

  return useMemo(() => ({
    drafts,
    isPicking,
    remainingSlots,
    attachDocuments,
    removeDraft,
    clearDrafts,
    clearFailedDrafts,
    consumeDraftsForSend,
    restoreDraftsForRetry,
    discardDrafts,
  }), [
    attachDocuments,
    clearDrafts,
    clearFailedDrafts,
    consumeDraftsForSend,
    discardDrafts,
    drafts,
    isPicking,
    remainingSlots,
    removeDraft,
    restoreDraftsForRetry,
  ]);
}
