import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import type { AttachmentDraft } from '@/types/multimodal';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
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
};

export type UseChatImageAttachmentsResult = {
  drafts: AttachmentDraft[];
  isPicking: boolean;
  remainingSlots: number;
  attachImages: () => Promise<void>;
  removeDraft: (draftOrId: AttachmentDraft | string) => void;
  clearDrafts: () => void;
  commitDrafts: () => void;
};

function getDraftKey(draft: AttachmentDraft): string {
  return draft.id ?? draft.localUri ?? draft.previewUri ?? draft.pickerUri;
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
  const mountedRef = useRef(true);
  const pickingLockRef = useRef(false);
  const enabledRef = useRef(enabled);
  const ownerKeyRef = useRef(normalizedOwnerKey);
  const ownerGenerationRef = useRef(0);

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

  const removeDraft = useCallback((draftOrId: AttachmentDraft | string) => {
    if (!mountedRef.current) {
      return;
    }

    const targetKey = typeof draftOrId === 'string' ? draftOrId : getDraftKey(draftOrId);

    const removedDraft = draftsRef.current.find((draft) => getDraftKey(draft) === targetKey);
    if (removedDraft) {
      void chatAttachmentStorageService.discardDraft(removedDraft).catch((error) => {
        console.warn('[useChatImageAttachments] Failed to discard removed draft', {
          context: 'remove_draft',
          ...getSanitizedErrorDetails(error),
        });
      });
    }

    draftsRef.current = draftsRef.current.filter((draft) => getDraftKey(draft) !== targetKey);
    setDraftState({
      drafts: draftsRef.current,
      ownerKey: ownerKeyRef.current,
    });
  }, []);

  const clearDrafts = useCallback(() => {
    discardDraftsQuietly(draftsRef.current, 'drafts');
    draftsRef.current = [];
    if (mountedRef.current) {
      setDraftState({
        drafts: [],
        ownerKey: ownerKeyRef.current,
      });
    }
  }, []);

  const commitDrafts = useCallback(() => {
    draftsRef.current = [];
    if (mountedRef.current) {
      setDraftState({
        drafts: [],
        ownerKey: ownerKeyRef.current,
      });
    }
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
      draftState.drafts,
      enabled ? 'drafts from previous owner' : 'drafts while disabled',
    );
    setDraftState((current) => (
      current === draftState
        ? {
          drafts: [],
          ownerKey: normalizedOwnerKey,
        }
        : current
    ));
  }, [draftState, enabled, normalizedOwnerKey]);

  useEffect(() => () => {
    mountedRef.current = false;
    ownerGenerationRef.current += 1;
    pickingLockRef.current = false;
    discardDraftsQuietly(draftsRef.current, 'drafts during cleanup');
    draftsRef.current = [];
  }, []);

  return useMemo(() => ({
    drafts,
    isPicking,
    remainingSlots,
    attachImages,
    removeDraft,
    clearDrafts,
    commitDrafts,
  }), [attachImages, clearDrafts, commitDrafts, drafts, isPicking, remainingSlots, removeDraft]);
}
