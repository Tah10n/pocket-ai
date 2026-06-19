import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import type { AttachmentDraft } from '@/types/multimodal';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  getSendableDraftImageAttachments,
  validateChatImageAttachmentLimit,
} from '@/utils/chatImageAttachments';
import {
  buildFailedAttachmentDraft,
  chatAttachmentStorageService,
  isChatImageAttachmentTooLargeError,
} from '@/services/ChatAttachmentStorageService';

export type UseChatImageAttachmentsOptions = {
  enabled: boolean;
  disabledReason?: string;
  initialDrafts?: AttachmentDraft[];
  ownerKey?: string | null;
  preserveFailedDraftsOnNewThreadCommit?: boolean;
};

export type RestoreDraftsForRetryOptions = {
  preserveOwnerKey?: string | null;
};

export type UseChatImageAttachmentsResult = {
  drafts: AttachmentDraft[];
  isPicking: boolean;
  remainingSlots: number;
  attachImages: () => Promise<void>;
  removeDraft: (draftOrId: AttachmentDraft | string, index?: number) => void;
  clearDrafts: () => void;
  clearFailedDrafts: () => void;
  commitDrafts: () => void;
  consumeDraftsForSend: () => AttachmentDraft[];
  restoreDraftsForRetry: (drafts: readonly AttachmentDraft[], options?: RestoreDraftsForRetryOptions) => void;
  discardDrafts: (drafts: readonly AttachmentDraft[], context?: string) => void;
};

function getDraftKey(draft: AttachmentDraft): string {
  return draft.id ?? draft.localUri ?? draft.previewUri ?? draft.pickerUri;
}

function hasSameDraftReferences(left: readonly AttachmentDraft[], right: readonly AttachmentDraft[]): boolean {
  return left.length === right.length && left.every((draft, index) => draft === right[index]);
}

function splitOwnerKey(ownerKey: string): { threadKey: string; modelKey: string } {
  const separatorIndex = ownerKey.indexOf('|');
  if (separatorIndex < 0) {
    return { threadKey: ownerKey, modelKey: '' };
  }

  return {
    threadKey: ownerKey.slice(0, separatorIndex),
    modelKey: ownerKey.slice(separatorIndex + 1),
  };
}

function shouldPreserveDraftsForNewThreadCommit({
  drafts,
  enabled,
  expectedNextOwnerKey,
  nextOwnerKey,
  preservedDraftKeys,
  preserveFailedDraftsOnNewThreadCommit,
  previousOwnerKey,
}: {
  drafts: readonly AttachmentDraft[];
  enabled: boolean;
  expectedNextOwnerKey: string | null;
  nextOwnerKey: string;
  preservedDraftKeys: ReadonlySet<string>;
  preserveFailedDraftsOnNewThreadCommit: boolean;
  previousOwnerKey: string;
}): boolean {
  if (!preserveFailedDraftsOnNewThreadCommit || !enabled || drafts.length === 0) {
    return false;
  }

  const previous = splitOwnerKey(previousOwnerKey);
  const next = splitOwnerKey(nextOwnerKey);
  const isNewThreadCommit = previous.threadKey === 'new-thread'
    && next.threadKey !== 'new-thread'
    && previous.modelKey === next.modelKey;

  if (!isNewThreadCommit) {
    return false;
  }

  if (expectedNextOwnerKey === null || nextOwnerKey !== expectedNextOwnerKey) {
    return false;
  }

  return drafts.every((draft) => (
    draft.copyStatus === 'failed'
    || preservedDraftKeys.has(getDraftKey(draft))
  ));
}

function getSanitizedErrorDetails(error: unknown): { errorName: string } | { errorType: string } {
  return error instanceof Error
    ? { errorName: error.name || 'Error' }
    : { errorType: typeof error };
}

function discardDraftsQuietly(drafts: readonly AttachmentDraft[], context: string): void {
  if (drafts.length === 0) {
    return;
  }

  void chatAttachmentStorageService.discardDrafts(drafts).catch((error) => {
    console.warn('[useChatImageAttachments] Failed to discard drafts', {
      context,
      ...getSanitizedErrorDetails(error),
    });
  });
}

function isImagePickerPermissionDeniedError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  const errorLike = error as { code?: unknown; message?: unknown; name?: unknown };
  const details = [
    typeof error === 'string' ? error : undefined,
    errorLike.code,
    errorLike.message,
    errorLike.name,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());

  return details.some((value) => (
    value.includes('permission')
    && (
      value.includes('denied')
      || value.includes('not granted')
      || value.includes('missing')
      || value.includes('rejected')
      || value.includes('unauthorized')
      || value.includes('unauthorised')
    )
  ));
}

export function useChatImageAttachments({
  enabled,
  disabledReason,
  initialDrafts = [],
  ownerKey = null,
  preserveFailedDraftsOnNewThreadCommit = false,
}: UseChatImageAttachmentsOptions): UseChatImageAttachmentsResult {
  const { t } = useTranslation();
  const normalizedOwnerKey = ownerKey ?? 'default';
  const [draftState, setDraftState] = useState<{
    drafts: AttachmentDraft[];
    ownerKey: string;
  }>(() => ({
    drafts: [...initialDrafts],
    ownerKey: normalizedOwnerKey,
  }));
  const [isPicking, setIsPicking] = useState(false);
  const emptyDrafts = useMemo<AttachmentDraft[]>(() => [], []);
  const draftsRef = useRef<AttachmentDraft[]>(draftState.drafts);
  const ownedDraftsRef = useRef<AttachmentDraft[]>(draftState.drafts);
  const mountedRef = useRef(true);
  const pickingLockRef = useRef(false);
  const enabledRef = useRef(enabled);
  const ownerKeyRef = useRef(normalizedOwnerKey);
  const ownerGenerationRef = useRef(0);
  const retryDraftKeysForNewThreadCommitRef = useRef<Set<string>>(new Set());
  const retryDraftOwnerKeyForNewThreadCommitRef = useRef<string | null>(null);

  const drafts = enabled && draftState.ownerKey === normalizedOwnerKey
    ? draftState.drafts
    : emptyDrafts;
  const remainingSlots = Math.max(0, MAX_CHAT_IMAGE_ATTACHMENTS - drafts.length);

  if (ownerKeyRef.current !== normalizedOwnerKey) {
    ownerKeyRef.current = normalizedOwnerKey;
    ownerGenerationRef.current += 1;
  }

  if (enabledRef.current !== enabled) {
    enabledRef.current = enabled;
    ownerGenerationRef.current += 1;
  }

  draftsRef.current = drafts;

  const showAttachmentAlert = useCallback((messageKey: string) => {
    Alert.alert(t('chat.attachments.attachImage'), t(messageKey, { count: MAX_CHAT_IMAGE_ATTACHMENTS }));
  }, [t]);

  const releaseOwnedDrafts = useCallback((draftsToRelease: readonly AttachmentDraft[]): AttachmentDraft[] => {
    if (draftsToRelease.length === 0 || ownedDraftsRef.current.length === 0) {
      return [];
    }

    const remainingDraftsToRelease = [...draftsToRelease];
    const releasedDrafts: AttachmentDraft[] = [];
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

  const discardOwnedDraftsQuietly = useCallback((draftsToDiscard: readonly AttachmentDraft[], context: string) => {
    discardDraftsQuietly(releaseOwnedDrafts(draftsToDiscard), context);
  }, [releaseOwnedDrafts]);

  const attachImages = useCallback(async () => {
    if (!mountedRef.current || pickingLockRef.current) {
      return;
    }

    if (!enabled) {
      showAttachmentAlert(disabledReason ?? 'chat.visionReadiness.unsupported');
      return;
    }

    const ownerKeyAtPickStart = ownerKeyRef.current;
    const ownerGenerationAtPickStart = ownerGenerationRef.current;
    const limit = validateChatImageAttachmentLimit(draftsRef.current.length, 1);
    if (!limit.ok) {
      showAttachmentAlert('chat.attachments.limitReached');
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
      const pickerRemainingSlots = Math.max(0, MAX_CHAT_IMAGE_ATTACHMENTS - draftsRef.current.length);
      if (pickerRemainingSlots < 1) {
        showAttachmentAlert('chat.attachments.limitReached');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: pickerRemainingSlots,
        orderedSelection: true,
        legacy: false,
        base64: false,
        exif: false,
        quality: 1,
      });

      if (!isCurrentFlow()) {
        return;
      }

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const selectedAssets = result.assets.slice(0, pickerRemainingSlots);
      const nextDrafts: AttachmentDraft[] = [];
      for (const asset of selectedAssets) {
        if (!isCurrentFlow()) {
          discardDraftsQuietly(nextDrafts, 'stale picked drafts');
          return;
        }

        let nextDraft: AttachmentDraft;
        try {
          nextDraft = await chatAttachmentStorageService.copyImageAssetToDraft(asset);
        } catch (error) {
          const isTooLarge = isChatImageAttachmentTooLargeError(error);
          const logMessage = isTooLarge
            ? '[useChatImageAttachments] Rejected selected image attachment'
            : '[useChatImageAttachments] Failed to copy selected image';
          console.warn(logMessage, {
            context: 'copy_selected_image',
            reason: isTooLarge ? 'too_large' : 'copy_failed',
            ...getSanitizedErrorDetails(error),
          });
          nextDraft = buildFailedAttachmentDraft(asset, isTooLarge ? 'too_large' : 'copy_failed');
        }

        if (!isCurrentFlow()) {
          discardDraftsQuietly([...nextDrafts, nextDraft], 'stale picked drafts');
          return;
        }

        nextDrafts.push(nextDraft);
      }

      if (!isCurrentFlow()) {
        discardDraftsQuietly(nextDrafts, 'stale picked drafts');
        return;
      }

      const availableSlots = Math.max(0, MAX_CHAT_IMAGE_ATTACHMENTS - draftsRef.current.length);
      const draftsToAppend = nextDrafts.slice(0, availableSlots);
      const draftsToDiscard = nextDrafts.slice(availableSlots);

      if (draftsToAppend.length === 0) {
        discardDraftsQuietly(nextDrafts, 'overflow picked drafts');
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
      discardDraftsQuietly(draftsToDiscard, 'overflow picked drafts');

      if (draftsToAppend.some((draft) => draft.copyStatus === 'failed' && draft.errorReason === 'too_large')) {
        showAttachmentAlert('chat.attachments.tooLarge');
      } else if (draftsToAppend.some((draft) => draft.copyStatus === 'failed')) {
        showAttachmentAlert('chat.attachments.copyFailed');
      }
    } catch (error) {
      console.warn('[useChatImageAttachments] Failed to open image picker', {
        context: 'open_image_picker',
        ...getSanitizedErrorDetails(error),
      });
      if (isCurrentFlow()) {
        showAttachmentAlert(
          isImagePickerPermissionDeniedError(error)
            ? 'chat.attachments.permissionDenied'
            : 'chat.attachments.pickerFailed',
        );
      }
    } finally {
      pickingLockRef.current = false;
      if (mountedRef.current) {
        setIsPicking(false);
      }
    }
  }, [
    disabledReason,
    enabled,
    showAttachmentAlert,
  ]);

  const removeDraft = useCallback((draftOrId: AttachmentDraft | string, index?: number) => {
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
        void chatAttachmentStorageService.discardDraft(draftToDiscard).catch((error) => {
          console.warn('[useChatImageAttachments] Failed to discard removed draft', {
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
    retryDraftKeysForNewThreadCommitRef.current.clear();
    retryDraftOwnerKeyForNewThreadCommitRef.current = null;
    discardOwnedDraftsQuietly(ownedDraftsRef.current, 'drafts');
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
    discardOwnedDraftsQuietly(failedDrafts, 'failed drafts after successful send');
    failedDrafts.forEach((draft) => {
      retryDraftKeysForNewThreadCommitRef.current.delete(getDraftKey(draft));
    });
    if (retryDraftKeysForNewThreadCommitRef.current.size === 0) {
      retryDraftOwnerKeyForNewThreadCommitRef.current = null;
    }
    draftsRef.current = draftsRef.current.filter((draft) => draft.copyStatus !== 'failed');
    setDraftState({
      drafts: draftsRef.current,
      ownerKey: ownerKeyRef.current,
    });
  }, [discardOwnedDraftsQuietly]);

  const commitDrafts = useCallback(() => {
    ownerGenerationRef.current += 1;
    retryDraftKeysForNewThreadCommitRef.current.clear();
    retryDraftOwnerKeyForNewThreadCommitRef.current = null;
    releaseOwnedDrafts(draftsRef.current);
    draftsRef.current = [];
    if (mountedRef.current) {
      setDraftState({
        drafts: [],
        ownerKey: ownerKeyRef.current,
      });
    }
  }, [releaseOwnedDrafts]);

  const consumeDraftsForSend = useCallback((): AttachmentDraft[] => {
    const draftsToConsume = getSendableDraftImageAttachments(draftsRef.current);
    if (draftsToConsume.length === 0) {
      return [];
    }

    ownerGenerationRef.current += 1;
    draftsToConsume.forEach((draft) => {
      retryDraftKeysForNewThreadCommitRef.current.delete(getDraftKey(draft));
    });
    if (retryDraftKeysForNewThreadCommitRef.current.size === 0) {
      retryDraftOwnerKeyForNewThreadCommitRef.current = null;
    }
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

  const restoreDraftsForRetry = useCallback((
    draftsToRestore: readonly AttachmentDraft[],
    options: RestoreDraftsForRetryOptions = {},
  ) => {
    if (draftsToRestore.length === 0 || !mountedRef.current) {
      return;
    }

    const currentDrafts = draftsRef.current;
    const currentDraftKeys = new Set(currentDrafts.map(getDraftKey));
    const restoredDrafts = draftsToRestore.filter((draft) => !currentDraftKeys.has(getDraftKey(draft)));
    if (restoredDrafts.length === 0) {
      return;
    }

    const nextDrafts = [...currentDrafts, ...restoredDrafts].slice(0, MAX_CHAT_IMAGE_ATTACHMENTS);
    const nextDraftKeys = new Set(nextDrafts.map(getDraftKey));
    const ownedDraftKeys = new Set(ownedDraftsRef.current.map(getDraftKey));
    const restoredOwnedDrafts = restoredDrafts.filter((draft) => (
      nextDraftKeys.has(getDraftKey(draft)) && !ownedDraftKeys.has(getDraftKey(draft))
    ));

    if (restoredOwnedDrafts.length > 0) {
      ownedDraftsRef.current = [...ownedDraftsRef.current, ...restoredOwnedDrafts];
    }

    const owner = splitOwnerKey(ownerKeyRef.current);
    if (
      preserveFailedDraftsOnNewThreadCommit
      && owner.threadKey === 'new-thread'
      && restoredDrafts.length > 0
      && options.preserveOwnerKey
    ) {
      retryDraftOwnerKeyForNewThreadCommitRef.current = options.preserveOwnerKey;
      nextDrafts.forEach((draft) => {
        retryDraftKeysForNewThreadCommitRef.current.add(getDraftKey(draft));
      });
    }

    draftsRef.current = nextDrafts;
    setDraftState({
      drafts: nextDrafts,
      ownerKey: ownerKeyRef.current,
    });
  }, [preserveFailedDraftsOnNewThreadCommit]);

  const discardDrafts = useCallback((draftsToDiscard: readonly AttachmentDraft[], context = 'drafts after failed send') => {
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

    if (shouldPreserveDraftsForNewThreadCommit({
      drafts: draftState.drafts,
      enabled,
      expectedNextOwnerKey: retryDraftOwnerKeyForNewThreadCommitRef.current,
      nextOwnerKey: normalizedOwnerKey,
      preservedDraftKeys: retryDraftKeysForNewThreadCommitRef.current,
      preserveFailedDraftsOnNewThreadCommit,
      previousOwnerKey: draftState.ownerKey,
    })) {
      retryDraftKeysForNewThreadCommitRef.current.clear();
      retryDraftOwnerKeyForNewThreadCommitRef.current = null;
      draftsRef.current = draftState.drafts;
      ownedDraftsRef.current = draftState.drafts;
      setDraftState((current) => (
        current === draftState || (
          current.ownerKey === draftState.ownerKey
          && hasSameDraftReferences(current.drafts, draftState.drafts)
        )
          ? {
            drafts: draftState.drafts,
            ownerKey: normalizedOwnerKey,
          }
          : current
      ));
      return;
    }

    discardDraftsQuietly(
      releaseOwnedDrafts(draftState.drafts),
      enabled ? 'drafts from previous owner' : 'drafts while disabled',
    );
    retryDraftKeysForNewThreadCommitRef.current.clear();
    retryDraftOwnerKeyForNewThreadCommitRef.current = null;
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
  }, [draftState, enabled, normalizedOwnerKey, preserveFailedDraftsOnNewThreadCommit, releaseOwnedDrafts]);

  useEffect(() => () => {
    mountedRef.current = false;
    ownerGenerationRef.current += 1;
    pickingLockRef.current = false;
    discardDraftsQuietly(ownedDraftsRef.current, 'drafts during cleanup');
    ownedDraftsRef.current = [];
    draftsRef.current = [];
    retryDraftKeysForNewThreadCommitRef.current.clear();
    retryDraftOwnerKeyForNewThreadCommitRef.current = null;
  }, []);

  return useMemo(() => ({
    drafts,
    isPicking,
    remainingSlots,
    attachImages,
    removeDraft,
    clearDrafts,
    clearFailedDrafts,
    commitDrafts,
    consumeDraftsForSend,
    restoreDraftsForRetry,
    discardDrafts,
  }), [attachImages, clearDrafts, clearFailedDrafts, commitDrafts, consumeDraftsForSend, discardDrafts, drafts, isPicking, remainingSlots, removeDraft, restoreDraftsForRetry]);
}
