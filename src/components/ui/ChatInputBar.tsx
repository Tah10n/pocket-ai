import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Image, Platform, ScrollView, StyleSheet } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { ScreenIconButton, ScreenIconTile, ScreenInlineInput, ScreenSurface, useScreenAppearance } from './ScreenShell';
import { getThemeActionContentClassName, screenChromeTokens, withAlpha, type ResolvedThemeMode } from '../../utils/themeTokens';
import { useTheme } from '../../providers/ThemeProvider';
import { useTranslation } from 'react-i18next';
import { getReportedErrorMessage } from '../../services/AppError';
import { ListPickerSheet, type ListPickerSheetItem } from './ListPickerSheet';
import {
    MAX_CHAT_IMAGE_ATTACHMENTS,
    getSendableDraftImageAttachments,
    hasFailedDraftImageAttachments,
} from '../../utils/chatImageAttachments';
import {
    MAX_CHAT_ATTACHMENTS_BY_KIND,
    getSendableDraftMediaAttachments,
    getSendableDraftDocumentAttachments,
    hasFailedDraftDocumentAttachments,
} from '../../utils/chatAttachments';
import type { AttachmentDraft } from '../../types/multimodal';
import type { ChatDocumentAttachmentDraft, ChatMediaAttachmentDraft } from '../../types/attachments';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';

interface ChatInputBarProps {
    onSendMessage: (content: string) => Promise<void> | void;
    onStopGeneration?: () => Promise<void> | void;
    disabled?: boolean;
    sendDisabled?: boolean;
    isSending?: boolean;
    draft?: string;
    onDraftChange?: (value: string) => void;
    allowEmptyMessageSend?: boolean;
    androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
    modeLabel?: string;
    modeDescription?: string;
    onCancelMode?: () => void;
    leadingActions?: React.ReactNode;
    trailingActions?: React.ReactNode;
    attachmentsTray?: React.ReactNode;
    attachmentDrafts?: AttachmentDraft[];
    documentAttachmentDrafts?: ChatDocumentAttachmentDraft[];
    mediaAttachmentDrafts?: ChatMediaAttachmentDraft[];
    onAttachImages?: () => Promise<void> | void;
    onAttachDocuments?: () => Promise<void> | void;
    onAttachAudio?: () => Promise<void> | void;
    onRemoveAttachmentDraft?: (draft: AttachmentDraft, index: number) => void;
    onRemoveDocumentAttachmentDraft?: (draft: ChatDocumentAttachmentDraft, index: number) => void;
    onRemoveMediaAttachmentDraft?: (draft: ChatMediaAttachmentDraft, index: number) => void;
    imageAttachmentsEnabled?: boolean;
    documentAttachmentsEnabled?: boolean;
    audioAttachmentsEnabled?: boolean;
    imageAttachmentsDisabledReason?: string;
    documentAttachmentsDisabledReason?: string;
    audioAttachmentsDisabledReason?: string;
    isImageAttachmentActionBusy?: boolean;
    isDocumentAttachmentActionBusy?: boolean;
    isAudioAttachmentActionBusy?: boolean;
}

const CHAT_INPUT_DRAFT_CONSUMED_ERROR_KEY = 'chatInputDraftConsumed';

type ChatInputDraftConsumedError = Error & {
    [CHAT_INPUT_DRAFT_CONSUMED_ERROR_KEY]?: true;
};

export function markChatInputDraftConsumedError(error: unknown): unknown {
    if (error && typeof error === 'object') {
        (error as ChatInputDraftConsumedError)[CHAT_INPUT_DRAFT_CONSUMED_ERROR_KEY] = true;
        return error;
    }

    const wrapped = new Error(typeof error === 'string' ? error : 'Message send failed after the draft was consumed.');
    (wrapped as ChatInputDraftConsumedError)[CHAT_INPUT_DRAFT_CONSUMED_ERROR_KEY] = true;
    return wrapped;
}

export function isChatInputDraftConsumedError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as ChatInputDraftConsumedError)[CHAT_INPUT_DRAFT_CONSUMED_ERROR_KEY] === true,
    );
}

export function getPrimaryActionGlassStyle(primaryStrong: string, mode: ResolvedThemeMode) {
    return {
        backgroundColor: withAlpha(primaryStrong, mode === 'dark' ? 0.22 : 0.1),
        borderWidth: 0,
    };
}

export function getGlassComposerCapsuleStyle(highlightColor: string, borderStrong: string, mode: ResolvedThemeMode) {
    const baseStyle = {
        borderRadius: 999,
    };

    if (mode !== 'dark') {
        return baseStyle;
    }

    return {
        ...baseStyle,
        backgroundColor: withAlpha(highlightColor, 0.1),
        borderColor: withAlpha(borderStrong, 0.28),
        borderWidth: 1,
    };
}

export function getModeBannerGlassStyle(highlightColor: string, primaryStrong: string, mode: ResolvedThemeMode) {
    if (mode !== 'dark') {
        return undefined;
    }

    return {
        backgroundColor: withAlpha(highlightColor, 0.09),
        borderColor: withAlpha(primaryStrong, 0.26),
        borderWidth: 1,
    };
}

function getAttachmentDraftPreviewCandidates(draft: AttachmentDraft): string[] {
    const seen = new Set<string>();

    return [draft.thumbnailUri, draft.previewUri, draft.localUri].filter((uri): uri is string => {
        if (!uri || uri.trim().length === 0 || seen.has(uri)) {
            return false;
        }

        seen.add(uri);
        return true;
    });
}

type AttachmentDraftPreviewProps = {
    draft: AttachmentDraft;
    index: number;
    accessibilityLabel: string;
    unavailableAccessibilityLabel: string;
};

function AttachmentDraftUnavailablePreview({ index, accessibilityLabel }: Pick<AttachmentDraftPreviewProps, 'index' | 'accessibilityLabel'>) {
    const { t } = useTranslation();

    return (
        <Box
            testID={`chat-image-attachment-unavailable-preview-${index}`}
            accessibilityRole="image"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled: true }}
            className="h-full w-full items-center justify-center rounded-xl"
        >
            <ScreenIconTile
                iconName="broken-image"
                tone="neutral"
                iconSize="sm"
                size="sm"
                className="h-8 w-8"
            />
            <Text role="status" className="sr-only">
                {t('chat.attachments.unavailable')}
            </Text>
        </Box>
    );
}

function AttachmentDraftPreview({ draft, index, accessibilityLabel, unavailableAccessibilityLabel }: AttachmentDraftPreviewProps) {
    const previewCandidates = getAttachmentDraftPreviewCandidates(draft);
    const previewCandidatesKey = previewCandidates.join('\u0000');
    const [candidateIndex, setCandidateIndex] = useState(0);
    const isUnavailable = previewCandidates.length === 0 || candidateIndex >= previewCandidates.length;
    const previewUri = isUnavailable ? '' : previewCandidates[candidateIndex] ?? '';

    useEffect(() => {
        setCandidateIndex(0);
    }, [previewCandidatesKey]);

    if (isUnavailable) {
        return (
            <AttachmentDraftUnavailablePreview
                index={index}
                accessibilityLabel={unavailableAccessibilityLabel}
            />
        );
    }

    return (
        <Image
            testID={`chat-image-attachment-preview-${index}`}
            accessibilityLabel={accessibilityLabel}
            source={{ uri: previewUri }}
            style={styles.attachmentPreviewImage}
            onError={() => {
                setCandidateIndex((currentIndex) => {
                    if (currentIndex >= previewCandidates.length - 1) {
                        return previewCandidates.length;
                    }

                    return currentIndex + 1;
                });
            }}
        />
    );
}

function formatDocumentAttachmentSize(sizeBytes: number | undefined): string | null {
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        return null;
    }

    if (sizeBytes < 1024) {
        return `${Math.round(sizeBytes)} B`;
    }

    if (sizeBytes < 1024 * 1024) {
        return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
    }

    return `${Math.max(1, Math.round(sizeBytes / (1024 * 1024)))} MB`;
}

function getDocumentAttachmentDisplayName(draft: ChatDocumentAttachmentDraft): string {
    return draft.displayName ?? draft.fileName ?? draft.id ?? 'Document';
}

function getMediaAttachmentDisplayName(draft: ChatMediaAttachmentDraft): string {
    return draft.displayName ?? draft.fileName ?? draft.id ?? 'Audio';
}

function joinUniqueHelperTexts(entries: (string | null)[]): string | null {
    const uniqueEntries = Array.from(new Set(entries.filter((entry): entry is string => Boolean(entry))));
    return uniqueEntries.join(' ') || null;
}

export const ChatInputBar = ({
    onSendMessage,
    onStopGeneration,
    disabled = false,
    sendDisabled = false,
    isSending = false,
    draft,
    onDraftChange,
    allowEmptyMessageSend = false,
    androidContentBlurTargetRef,
    modeLabel,
    modeDescription,
    onCancelMode,
    leadingActions,
    trailingActions,
    attachmentsTray,
    attachmentDrafts = [],
    documentAttachmentDrafts = [],
    mediaAttachmentDrafts = [],
    onAttachImages,
    onAttachDocuments,
    onAttachAudio,
    onRemoveAttachmentDraft,
    onRemoveDocumentAttachmentDraft,
    onRemoveMediaAttachmentDraft,
    imageAttachmentsEnabled = false,
    documentAttachmentsEnabled = false,
    audioAttachmentsEnabled = false,
    imageAttachmentsDisabledReason,
    documentAttachmentsDisabledReason,
    audioAttachmentsDisabledReason,
    isImageAttachmentActionBusy = false,
    isDocumentAttachmentActionBusy = false,
    isAudioAttachmentActionBusy = false,
}: ChatInputBarProps) => {
    const [internalMessage, setInternalMessage] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isAttachmentMenuVisible, setIsAttachmentMenuVisible] = useState(false);
    const submitLockRef = useRef(false);
    const lastIosAttachmentAnnouncementRef = useRef<string | null>(null);
    const { t } = useTranslation();
    const theme = useTheme();
    const appearance = useScreenAppearance();
    const isDarkGlass = appearance.surfaceKind === 'glass' && theme.resolvedMode === 'dark';
    const isControlled = typeof draft === 'string';
    const message = isControlled ? draft : internalMessage;
    const hasAttachmentCopyFailures = imageAttachmentsEnabled && hasFailedDraftImageAttachments(attachmentDrafts);
    const hasDocumentAttachmentCopyFailures = documentAttachmentsEnabled
        && hasFailedDraftDocumentAttachments(documentAttachmentDrafts);
    const hasTooLargeAttachmentFailures = imageAttachmentsEnabled
        && attachmentDrafts.some((attachmentDraft) => (
            attachmentDraft.copyStatus === 'failed'
            && attachmentDraft.errorReason === 'too_large'
        ));
    const hasTooLargeDocumentAttachmentFailures = documentAttachmentsEnabled
        && documentAttachmentDrafts.some((attachmentDraft) => (
            attachmentDraft.copyStatus === 'failed'
            && attachmentDraft.errorReason === 'too_large'
        ));
    const hasUnsupportedDocumentAttachmentFailures = documentAttachmentsEnabled
        && documentAttachmentDrafts.some((attachmentDraft) => (
            attachmentDraft.copyStatus === 'failed'
            && attachmentDraft.errorReason === 'unsupported_type'
        ));
    const hasCopyOrStorageAttachmentFailures = imageAttachmentsEnabled
        && attachmentDrafts.some((attachmentDraft) => (
            attachmentDraft.copyStatus === 'failed'
            && attachmentDraft.errorReason !== 'too_large'
        ));
    const hasCopyOrParseDocumentAttachmentFailures = documentAttachmentsEnabled
        && documentAttachmentDrafts.some((attachmentDraft) => (
            attachmentDraft.copyStatus === 'failed'
            && attachmentDraft.errorReason !== 'too_large'
            && attachmentDraft.errorReason !== 'unsupported_type'
        ));
    const audioMediaAttachmentDrafts = mediaAttachmentDrafts.filter((attachmentDraft) => attachmentDraft.kind === 'audio');
    const hasTooLargeAudioAttachmentFailures = audioMediaAttachmentDrafts.some((attachmentDraft) => (
        attachmentDraft.copyStatus === 'failed'
        && attachmentDraft.errorReason === 'too_large'
    ));
    const hasUnsupportedAudioAttachmentFailures = audioMediaAttachmentDrafts.some((attachmentDraft) => (
        attachmentDraft.copyStatus === 'failed'
        && attachmentDraft.errorReason === 'unsupported_type'
    ));
    const hasAudioAttachmentCopyFailures = audioMediaAttachmentDrafts.some((attachmentDraft) => (
        attachmentDraft.copyStatus === 'failed'
        && attachmentDraft.errorReason !== 'too_large'
        && attachmentDraft.errorReason !== 'unsupported_type'
    ));
    const sendableAttachmentDrafts = imageAttachmentsEnabled
        ? getSendableDraftImageAttachments(attachmentDrafts)
        : [];
    const sendableDocumentAttachmentDrafts = documentAttachmentsEnabled
        ? getSendableDraftDocumentAttachments(documentAttachmentDrafts)
        : [];
    const mediaAttachmentDraftsWithEnabledCapability = mediaAttachmentDrafts.filter((attachmentDraft) => (
        (attachmentDraft.kind === 'audio' && audioAttachmentsEnabled)
    ));
    const sendableMediaAttachmentDrafts = getSendableDraftMediaAttachments(mediaAttachmentDraftsWithEnabledCapability);
    const nonFailedAttachmentDrafts = imageAttachmentsEnabled
        ? attachmentDrafts.filter((attachmentDraft) => attachmentDraft.copyStatus !== 'failed')
        : [];
    const nonFailedDocumentAttachmentDrafts = documentAttachmentsEnabled
        ? documentAttachmentDrafts.filter((attachmentDraft) => attachmentDraft.copyStatus !== 'failed')
        : [];
    const nonFailedMediaAttachmentDrafts = mediaAttachmentDraftsWithEnabledCapability
        .filter((attachmentDraft) => attachmentDraft.copyStatus !== 'failed');
    const hasNonFailedAttachmentDraftsBlockedFromSend = imageAttachmentsEnabled
        && nonFailedAttachmentDrafts.length > 0
        && sendableAttachmentDrafts.length !== nonFailedAttachmentDrafts.length;
    const hasNonFailedDocumentAttachmentDraftsBlockedFromSend = documentAttachmentsEnabled
        && nonFailedDocumentAttachmentDrafts.length > 0
        && sendableDocumentAttachmentDrafts.length !== nonFailedDocumentAttachmentDrafts.length;
    const hasNonFailedMediaAttachmentDraftsBlockedFromSend = nonFailedMediaAttachmentDrafts.length > 0
        && sendableMediaAttachmentDrafts.length !== nonFailedMediaAttachmentDrafts.length;
    const hasReadyAttachmentDrafts = imageAttachmentsEnabled
        && sendableAttachmentDrafts.length > 0
        && sendableAttachmentDrafts.length === nonFailedAttachmentDrafts.length;
    const hasReadyDocumentAttachmentDrafts = documentAttachmentsEnabled
        && sendableDocumentAttachmentDrafts.length > 0
        && sendableDocumentAttachmentDrafts.length === nonFailedDocumentAttachmentDrafts.length;
    const hasReadyMediaAttachmentDrafts = sendableMediaAttachmentDrafts.length > 0
        && sendableMediaAttachmentDrafts.length === nonFailedMediaAttachmentDrafts.length;
    const canSend = !disabled
        && !sendDisabled
        && !isSending
        && !isSubmitting
        && !isImageAttachmentActionBusy
        && !isDocumentAttachmentActionBusy
        && !isAudioAttachmentActionBusy
        && !hasNonFailedAttachmentDraftsBlockedFromSend
        && !hasNonFailedDocumentAttachmentDraftsBlockedFromSend
        && !hasNonFailedMediaAttachmentDraftsBlockedFromSend
        && (message.trim().length > 0 || hasReadyAttachmentDrafts || hasReadyDocumentAttachmentDrafts || hasReadyMediaAttachmentDrafts || allowEmptyMessageSend);
    const placeholder = disabled ? t('chat.inputPlaceholderDisabled') : t('chat.inputPlaceholder');
    const attachmentLimitReached = imageAttachmentsEnabled && attachmentDrafts.length >= MAX_CHAT_IMAGE_ATTACHMENTS;
    const documentAttachmentLimitReached = documentAttachmentsEnabled
        && documentAttachmentDrafts.length >= MAX_CHAT_ATTACHMENTS_BY_KIND.document;
    const audioAttachmentLimitReached = audioMediaAttachmentDrafts.length >= MAX_CHAT_ATTACHMENTS_BY_KIND.audio;
    const canAttachImages = Boolean(onAttachImages)
        && imageAttachmentsEnabled
        && !disabled
        && !isSending
        && !isSubmitting
        && !isImageAttachmentActionBusy
        && !attachmentLimitReached;
    const canAttachDocuments = Boolean(onAttachDocuments)
        && documentAttachmentsEnabled
        && !disabled
        && !isSending
        && !isSubmitting
        && !isDocumentAttachmentActionBusy
        && !documentAttachmentLimitReached;
    const canAttachAudio = Boolean(onAttachAudio)
        && audioAttachmentsEnabled
        && !disabled
        && !isSending
        && !isSubmitting
        && !isAudioAttachmentActionBusy
        && !audioAttachmentLimitReached;
    const setMessage = (value: string) => {
        if (isControlled) {
            onDraftChange?.(value);
            return;
        }

        setInternalMessage(value);
    };

    const handleSend = async () => {
        if (!canSend || submitLockRef.current) {
            return;
        }

        submitLockRef.current = true;
        setIsSubmitting(true);
        const nextMessage = message.trim();
        setMessage('');

        try {
            await onSendMessage(nextMessage);
        } catch (error) {
            if (!isChatInputDraftConsumedError(error)) {
                setMessage(nextMessage);
            }
            throw error;
        } finally {
            submitLockRef.current = false;
            setIsSubmitting(false);
        }
    };

    const handlePrimaryAction = async () => {
        try {
            if (isSending) {
                await onStopGeneration?.();
                return;
            }

            await handleSend();
        } catch (error: any) {
            Alert.alert(
                t('chat.sendErrorTitle'),
                getReportedErrorMessage('ChatInputBar.handlePrimaryAction', error, t),
            );
        }
    };

    const handleAttachImages = async () => {
        if (!canAttachImages) {
            return;
        }

        try {
            await onAttachImages?.();
        } catch (error: any) {
            Alert.alert(
                t('chat.attachments.attachImage'),
                getReportedErrorMessage('ChatInputBar.handleAttachImages', error, t),
            );
        }
    };

    const handleAttachDocuments = async () => {
        if (!canAttachDocuments) {
            return;
        }

        try {
            await onAttachDocuments?.();
        } catch (error: any) {
            Alert.alert(
                t('chat.attachments.attachDocument'),
                getReportedErrorMessage('ChatInputBar.handleAttachDocuments', error, t),
            );
        }
    };

    const handleAttachAudio = async () => {
        if (!canAttachAudio) {
            return;
        }

        try {
            await onAttachAudio?.();
        } catch (error: any) {
            Alert.alert(
                t('chat.attachments.attachAudio'),
                getReportedErrorMessage('ChatInputBar.handleAttachAudio', error, t),
            );
        }
    };

    const closeAttachmentMenu = () => {
        setIsAttachmentMenuVisible(false);
    };

    const selectAttachmentMenuAction = (handler: () => Promise<void>) => {
        setIsAttachmentMenuVisible(false);
        void handler();
    };

    const primaryActionEnabled = isSending || canSend;
    const primaryActionClassName = appearance.surfaceKind === 'glass'
        ? 'bg-primary-500/8'
        : 'border-0 bg-primary-500';
    const primaryActionStyle = appearance.surfaceKind === 'glass' && primaryActionEnabled
        ? getPrimaryActionGlassStyle(theme.colors.primaryStrong, theme.resolvedMode)
        : undefined;
    const glassComposerCapsuleStyle = getGlassComposerCapsuleStyle(
        theme.colors.text,
        theme.colors.borderStrong,
        theme.resolvedMode,
    );
    const modeBannerClassName = isDarkGlass
        ? 'mb-1.5 rounded-2xl px-3 py-2'
        : `mb-1.5 ${appearance.classNames.modeBannerClassName}`;
    const modeBannerStyle = isDarkGlass
        ? getModeBannerGlassStyle(
            theme.colors.text,
            theme.colors.primaryStrong,
            theme.resolvedMode,
        )
        : undefined;
    const resolvedTrailingActions = trailingActions ?? (
        <ScreenIconButton
            onPress={handlePrimaryAction}
            disabled={!isSending && !canSend}
            accessibilityLabel={isSending ? t('chat.stopAccessibilityLabel') : t('chat.sendAccessibilityLabel')}
            iconName={isSending ? 'stop' : 'arrow-upward'}
            className={`${primaryActionEnabled
                ? primaryActionClassName
                : appearance.classNames.toneClassNameByTone.neutral.iconTileClassName}`}
            iconClassName={primaryActionEnabled ? getThemeActionContentClassName(appearance, 'primary') : 'text-typography-500'}
            style={primaryActionStyle}
        />
    );
    const imageAttachmentHelperText = (() => {
        if (hasTooLargeAttachmentFailures && hasCopyOrStorageAttachmentFailures) {
            return t('chat.attachments.mixedFailures');
        }

        if (hasTooLargeAttachmentFailures) {
            return t('chat.attachments.tooLarge');
        }

        if (hasAttachmentCopyFailures) {
            return t('chat.attachments.copyFailed');
        }

        if (attachmentLimitReached) {
            return t('chat.attachments.limitReached', { count: MAX_CHAT_IMAGE_ATTACHMENTS });
        }

        if (!imageAttachmentsEnabled && imageAttachmentsDisabledReason) {
            return t(imageAttachmentsDisabledReason);
        }

        return null;
    })();
    const documentAttachmentHelperText = (() => {
        if (hasTooLargeDocumentAttachmentFailures) {
            return t('chat.attachments.documentTooLarge');
        }

        if (hasUnsupportedDocumentAttachmentFailures) {
            return t('chat.attachments.documentUnsupported');
        }

        if (hasDocumentAttachmentCopyFailures || hasCopyOrParseDocumentAttachmentFailures) {
            return t('chat.attachments.documentCopyFailed');
        }

        if (documentAttachmentLimitReached) {
            return t('chat.attachments.documentLimitReached', { count: MAX_CHAT_ATTACHMENTS_BY_KIND.document });
        }

        if (!documentAttachmentsEnabled && documentAttachmentsDisabledReason) {
            return t(documentAttachmentsDisabledReason);
        }

        return null;
    })();
    const audioAttachmentHelperText = (() => {
        if (hasTooLargeAudioAttachmentFailures) {
            return t('chat.attachments.audioTooLarge');
        }

        if (hasUnsupportedAudioAttachmentFailures) {
            return t('chat.attachments.audioUnsupported');
        }

        if (hasAudioAttachmentCopyFailures) {
            return t('chat.attachments.audioCopyFailed');
        }

        if (audioAttachmentLimitReached) {
            return t('chat.attachments.audioLimitReached', { count: MAX_CHAT_ATTACHMENTS_BY_KIND.audio });
        }

        if (!audioAttachmentsEnabled && audioAttachmentsDisabledReason) {
            return t(audioAttachmentsDisabledReason);
        }

        return null;
    })();
    const mediaAttachmentHelperText = audioAttachmentHelperText;
    const attachmentHelperText = joinUniqueHelperTexts([imageAttachmentHelperText, documentAttachmentHelperText, mediaAttachmentHelperText]);
    const attachImageDisabledContext = [
        isImageAttachmentActionBusy ? t('chat.attachments.preparingImage') : null,
        imageAttachmentHelperText,
        disabled ? placeholder : null,
    ]
        .filter((entry): entry is string => Boolean(entry))
        .join(' ');
    const attachDocumentDisabledContext = [
        isDocumentAttachmentActionBusy ? t('chat.attachments.preparingDocument') : null,
        documentAttachmentHelperText,
        disabled ? placeholder : null,
    ]
        .filter((entry): entry is string => Boolean(entry))
        .join(' ');
    const attachAudioDisabledContext = [
        isAudioAttachmentActionBusy ? t('chat.attachments.preparingAudio') : null,
        audioAttachmentHelperText,
        disabled ? placeholder : null,
    ]
        .filter((entry): entry is string => Boolean(entry))
        .join(' ');
    const attachImageAccessibilityState = isImageAttachmentActionBusy
        ? { disabled: !canAttachImages, busy: true }
        : { disabled: !canAttachImages };
    const attachDocumentAccessibilityState = isDocumentAttachmentActionBusy
        ? { disabled: !canAttachDocuments, busy: true }
        : { disabled: !canAttachDocuments };
    const attachAudioAccessibilityState = isAudioAttachmentActionBusy
        ? { disabled: !canAttachAudio, busy: true }
        : { disabled: !canAttachAudio };
    const isAnyAttachmentActionBusy = isImageAttachmentActionBusy
        || isDocumentAttachmentActionBusy
        || isAudioAttachmentActionBusy;
    const attachmentStatusAnnouncement = isImageAttachmentActionBusy
        ? t('chat.attachments.preparingImage')
        : isDocumentAttachmentActionBusy
            ? t('chat.attachments.preparingDocument')
            : isAudioAttachmentActionBusy
                ? t('chat.attachments.preparingAudio')
                : attachmentHelperText;

    useEffect(() => {
        if (Platform.OS !== 'ios') {
            return;
        }

        const announcement = attachmentStatusAnnouncement?.trim() || null;
        if (!announcement) {
            lastIosAttachmentAnnouncementRef.current = null;
            return;
        }

        if (lastIosAttachmentAnnouncementRef.current === announcement) {
            return;
        }

        lastIosAttachmentAnnouncementRef.current = announcement;
        AccessibilityInfo.announceForAccessibility(announcement);
    }, [attachmentStatusAnnouncement]);

    const attachmentMenuItems = ([
        onAttachImages ? {
            key: 'image',
            title: t('chat.attachments.attachImage'),
            description: !canAttachImages && attachImageDisabledContext ? attachImageDisabledContext : undefined,
            iconName: 'image',
            disabled: !canAttachImages,
            onPress: () => selectAttachmentMenuAction(handleAttachImages),
            accessibilityLabel: t('chat.attachments.attachImageAccessibilityLabel'),
            accessibilityHint: !canAttachImages && attachImageDisabledContext ? attachImageDisabledContext : undefined,
            accessibilityState: attachImageAccessibilityState,
            testID: 'chat-attach-image-button',
        } : null,
        onAttachDocuments ? {
            key: 'document',
            title: t('chat.attachments.attachDocument'),
            description: !canAttachDocuments && attachDocumentDisabledContext ? attachDocumentDisabledContext : undefined,
            iconName: 'description',
            disabled: !canAttachDocuments,
            onPress: () => selectAttachmentMenuAction(handleAttachDocuments),
            accessibilityLabel: t('chat.attachments.attachDocumentAccessibilityLabel'),
            accessibilityHint: !canAttachDocuments && attachDocumentDisabledContext ? attachDocumentDisabledContext : undefined,
            accessibilityState: attachDocumentAccessibilityState,
            testID: 'chat-attach-document-button',
        } : null,
        onAttachAudio ? {
            key: 'audio',
            title: t('chat.attachments.attachAudio'),
            description: !canAttachAudio && attachAudioDisabledContext ? attachAudioDisabledContext : undefined,
            iconName: 'graphic-eq',
            disabled: !canAttachAudio,
            onPress: () => selectAttachmentMenuAction(handleAttachAudio),
            accessibilityLabel: t('chat.attachments.attachAudioAccessibilityLabel'),
            accessibilityHint: !canAttachAudio && attachAudioDisabledContext ? attachAudioDisabledContext : undefined,
            accessibilityState: attachAudioAccessibilityState,
            testID: 'chat-attach-audio-button',
        } : null,
    ] as (ListPickerSheetItem | null)[]).filter((item): item is ListPickerSheetItem => item !== null);
    const hasAttachmentMenuItems = attachmentMenuItems.length > 0;
    const attachmentAction = hasAttachmentMenuItems ? (
        <ScreenIconButton
            onPress={() => setIsAttachmentMenuVisible(true)}
            accessibilityLabel={t('chat.attachments.attachMenuAccessibilityLabel')}
            accessibilityHint={attachmentStatusAnnouncement ?? undefined}
            accessibilityState={isAnyAttachmentActionBusy ? { busy: true } : undefined}
            iconName="attach-file"
            iconSize="sm"
            size="compact"
            testID="chat-attach-menu-button"
        />
    ) : null;
    const attachmentMenuSheet = hasAttachmentMenuItems && isAttachmentMenuVisible ? (
        <ListPickerSheet
            visible={isAttachmentMenuVisible}
            onClose={closeAttachmentMenu}
            title={t('chat.attachments.attachMenuTitle')}
            androidContentBlurTargetRef={androidContentBlurTargetRef}
            items={attachmentMenuItems}
            testID="chat-attachment-menu-sheet"
            sheetClassName="max-h-[76%]"
        />
    ) : null;
    const inputRow = (
        <Box
            testID="chat-input-bar-row"
            className={appearance.surfaceKind === 'glass'
                ? 'h-full flex-row items-center gap-2'
                : 'flex-row items-center gap-2'}
        >
            {attachmentAction || leadingActions ? (
                <Box testID="chat-input-bar-leading-actions" className="flex-row items-center gap-2">
                    {attachmentAction}
                    {leadingActions}
                </Box>
            ) : null}

            <ScreenInlineInput
                variant="composer"
                applyGlassFrame={appearance.surfaceKind !== 'glass'}
                className={disabled
                    ? 'flex-1 opacity-60'
                    : appearance.surfaceKind === 'glass'
                        ? 'flex-1 border-0 bg-transparent'
                        : 'flex-1'}
                style={appearance.surfaceKind === 'glass' ? styles.transparentInlineInput : undefined}
                accessibilityLabel={t('chat.inputAccessibilityLabel')}
                placeholder={placeholder}
                keyboardType="default"
                returnKeyType="send"
                enterKeyHint="send"
                submitBehavior="submit"
                textAlignVertical="center"
                value={message}
                onChangeText={setMessage}
                onSubmitEditing={() => {
                    void handlePrimaryAction();
                }}
                editable={!disabled && !isSending && !isSubmitting}
            />

            <Box testID="chat-input-bar-trailing-actions" className="flex-row items-center gap-2">
                {resolvedTrailingActions}
            </Box>
        </Box>
    );

    const builtInAttachmentsTray = attachmentDrafts.length > 0
        || documentAttachmentDrafts.length > 0
        || mediaAttachmentDrafts.length > 0
        || attachmentHelperText
        || isImageAttachmentActionBusy
        || isDocumentAttachmentActionBusy
        || isAudioAttachmentActionBusy ? (
        <Box testID="chat-image-attachments-tray" className="gap-2">
            {isImageAttachmentActionBusy ? (
                <Box
                    testID="chat-image-attachment-busy-indicator"
                    accessibilityRole="progressbar"
                    accessibilityLabel={t('chat.attachments.preparingImage')}
                    accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
                    accessibilityState={{ busy: true }}
                    className="flex-row items-center gap-2 self-start rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1.5"
                >
                    <ScreenIconTile
                        testID="chat-image-attachment-busy-spinner"
                        iconName="hourglass-empty"
                        iconSize="xs"
                        size="sm"
                        tone="accent"
                        className="h-6 w-6 border-0 bg-transparent"
                        iconClassName="text-primary-500"
                    />
                    <Text className="text-xs font-semibold text-primary-700 dark:text-primary-300">
                        {t('chat.attachments.preparingImage')}
                    </Text>
                </Box>
            ) : null}

            {isDocumentAttachmentActionBusy ? (
                <Box
                    testID="chat-document-attachment-busy-indicator"
                    accessibilityRole="progressbar"
                    accessibilityLabel={t('chat.attachments.preparingDocument')}
                    accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
                    accessibilityState={{ busy: true }}
                    className="flex-row items-center gap-2 self-start rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1.5"
                >
                    <ScreenIconTile
                        testID="chat-document-attachment-busy-spinner"
                        iconName="hourglass-empty"
                        iconSize="xs"
                        size="sm"
                        tone="accent"
                        className="h-6 w-6 border-0 bg-transparent"
                        iconClassName="text-primary-500"
                    />
                    <Text className="text-xs font-semibold text-primary-700 dark:text-primary-300">
                        {t('chat.attachments.preparingDocument')}
                    </Text>
                </Box>
            ) : null}

            {isAudioAttachmentActionBusy ? (
                <Box
                    testID="chat-audio-attachment-busy-indicator"
                    accessibilityRole="progressbar"
                    accessibilityLabel={t('chat.attachments.preparingAudio')}
                    accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
                    accessibilityState={{ busy: true }}
                    className="flex-row items-center gap-2 self-start rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1.5"
                >
                    <ScreenIconTile
                        iconName="hourglass-empty"
                        iconSize="xs"
                        size="sm"
                        tone="accent"
                        className="h-6 w-6 border-0 bg-transparent"
                        iconClassName="text-primary-500"
                    />
                    <Text className="text-xs font-semibold text-primary-700 dark:text-primary-300">
                        {t('chat.attachments.preparingAudio')}
                    </Text>
                </Box>
            ) : null}

            {attachmentDrafts.length > 0 || documentAttachmentDrafts.length > 0 || mediaAttachmentDrafts.length > 0 ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.attachmentsScrollContent}
                >
                    {attachmentDrafts.map((draft, index) => {
                        const draftKey = draft.id ?? draft.localUri ?? draft.previewUri ?? draft.pickerUri;
                        const isFailed = draft.copyStatus === 'failed';
                        const attachmentLabelOptions = { index: index + 1, count: attachmentDrafts.length };
                        const failedAttachmentReason = draft.errorReason === 'too_large'
                            ? t('chat.attachments.tooLarge')
                            : t('chat.attachments.copyFailed');
                        const failedAttachmentLabel = t('chat.attachments.failedPreviewIndexedAccessibilityLabel', {
                            ...attachmentLabelOptions,
                            reason: failedAttachmentReason,
                        });

                        return (
                            <Box key={`${draftKey}-${index}`} className="mr-2">
                                <ScreenSurface
                                    tone={isFailed ? 'danger' : 'default'}
                                    className="relative h-16 w-16 overflow-hidden rounded-2xl p-1"
                                >
                                    {isFailed ? (
                                        <Box
                                            testID={`chat-image-attachment-failed-preview-${index}`}
                                            accessibilityRole="image"
                                            accessibilityLabel={failedAttachmentLabel}
                                            accessibilityState={{ disabled: true }}
                                            className="h-full w-full items-center justify-center rounded-xl"
                                        >
                                            <ScreenIconTile
                                                iconName="warning"
                                                tone="error"
                                                iconSize="sm"
                                                size="sm"
                                                className="h-8 w-8"
                                            />
                                        </Box>
                                    ) : (
                                        <AttachmentDraftPreview
                                            draft={draft}
                                            index={index}
                                            accessibilityLabel={t('chat.attachments.previewIndexedAccessibilityLabel', attachmentLabelOptions)}
                                            unavailableAccessibilityLabel={t('chat.attachments.previewUnavailableIndexedAccessibilityLabel', attachmentLabelOptions)}
                                        />
                                    )}
                                </ScreenSurface>

                                {onRemoveAttachmentDraft ? (
                                    <Box className="absolute -right-1 -top-1">
                                        <ScreenIconButton
                                            onPress={() => onRemoveAttachmentDraft(draft, index)}
                                            accessibilityLabel={t('chat.attachments.removeImageIndexedAccessibilityLabel', attachmentLabelOptions)}
                                            iconName="close"
                                            iconSize="xs"
                                            size="micro"
                                            testID={`chat-image-attachment-remove-${index}`}
                                        />
                                    </Box>
                                ) : null}
                            </Box>
                        );
                    })}
                    {documentAttachmentDrafts.map((draft, index) => {
                        const draftKey = getDocumentAttachmentDisplayName(draft);
                        const isFailed = draft.copyStatus === 'failed';
                        const attachmentLabelOptions = { index: index + 1, count: documentAttachmentDrafts.length };
                        const failedAttachmentReason = draft.errorReason === 'too_large'
                            ? t('chat.attachments.documentTooLarge')
                            : draft.errorReason === 'unsupported_type'
                                ? t('chat.attachments.documentUnsupported')
                                : t('chat.attachments.documentCopyFailed');
                        const title = getDocumentAttachmentDisplayName(draft);
                        const subtitle = isFailed
                            ? failedAttachmentReason
                            : formatDocumentAttachmentSize(draft.sizeBytes) ?? t('chat.attachments.documentReady');
                        const accessibilityLabel = isFailed
                            ? t('chat.attachments.failedDocumentPreviewIndexedAccessibilityLabel', {
                                ...attachmentLabelOptions,
                                reason: failedAttachmentReason,
                            })
                            : t('chat.attachments.documentPreviewIndexedAccessibilityLabel', {
                                ...attachmentLabelOptions,
                                name: title,
                            });

                        return (
                            <Box key={`${draftKey}-${index}`} className="mr-2">
                                <ScreenSurface
                                    tone={isFailed ? 'danger' : 'default'}
                                    className="relative h-16 w-44 rounded-2xl px-3 py-2"
                                    accessibilityRole="summary"
                                    accessibilityLabel={accessibilityLabel}
                                    testID={`chat-document-attachment-chip-${index}`}
                                >
                                    <Box className="min-w-0 flex-1 flex-row items-center gap-2">
                                        <ScreenIconTile
                                            iconName={isFailed ? 'warning' : 'description'}
                                            tone={isFailed ? 'error' : 'neutral'}
                                            iconSize="sm"
                                            size="sm"
                                            className="h-8 w-8"
                                        />
                                        <Box className="min-w-0 flex-1">
                                            <Text numberOfLines={1} className="text-xs font-semibold text-typography-800 dark:text-typography-100">
                                                {title}
                                            </Text>
                                            <Text numberOfLines={1} className="mt-0.5 text-xs leading-4 text-typography-500 dark:text-typography-300">
                                                {subtitle}
                                            </Text>
                                        </Box>
                                    </Box>
                                </ScreenSurface>

                                {onRemoveDocumentAttachmentDraft ? (
                                    <Box className="absolute -right-1 -top-1">
                                        <ScreenIconButton
                                            onPress={() => onRemoveDocumentAttachmentDraft(draft, index)}
                                            accessibilityLabel={t('chat.attachments.removeDocumentIndexedAccessibilityLabel', attachmentLabelOptions)}
                                            iconName="close"
                                            iconSize="xs"
                                            size="micro"
                                            testID={`chat-document-attachment-remove-${index}`}
                                        />
                                    </Box>
                                ) : null}
                            </Box>
                        );
                    })}
                    {mediaAttachmentDrafts.map((draft, index) => {
                        const draftKey = getMediaAttachmentDisplayName(draft);
                        const isFailed = draft.copyStatus === 'failed';
                        const attachmentLabelOptions = { index: index + 1, count: mediaAttachmentDrafts.length };
                        const failedAttachmentReason = draft.errorReason === 'too_large'
                            ? t('chat.attachments.audioTooLarge')
                            : draft.errorReason === 'unsupported_type'
                                ? t('chat.attachments.audioUnsupported')
                                : t('chat.attachments.audioCopyFailed');
                        const title = getMediaAttachmentDisplayName(draft);
                        const subtitle = isFailed
                            ? failedAttachmentReason
                            : formatDocumentAttachmentSize(draft.sizeBytes) ?? t('chat.attachments.audioReady');
                        const accessibilityLabel = isFailed
                            ? t('chat.attachments.failedMediaPreviewIndexedAccessibilityLabel', {
                                ...attachmentLabelOptions,
                                kind: draft.kind,
                                reason: failedAttachmentReason,
                            })
                            : t('chat.attachments.mediaPreviewIndexedAccessibilityLabel', {
                                ...attachmentLabelOptions,
                                kind: draft.kind,
                                name: title,
                            });

                        return (
                            <Box key={`${draftKey}-${index}`} className="mr-2">
                                <ScreenSurface
                                    tone={isFailed ? 'danger' : 'default'}
                                    className="relative h-16 w-44 rounded-2xl px-3 py-2"
                                    accessibilityRole="summary"
                                    accessibilityLabel={accessibilityLabel}
                                    testID={`chat-media-attachment-chip-${index}`}
                                >
                                    <Box className="min-w-0 flex-1 flex-row items-center gap-2">
                                        <ScreenIconTile
                                            iconName={isFailed ? 'warning' : 'graphic-eq'}
                                            tone={isFailed ? 'error' : 'neutral'}
                                            iconSize="sm"
                                            size="sm"
                                            className="h-8 w-8"
                                        />
                                        <Box className="min-w-0 flex-1">
                                            <Text numberOfLines={1} className="text-xs font-semibold text-typography-800 dark:text-typography-100">
                                                {title}
                                            </Text>
                                            <Text numberOfLines={1} className="mt-0.5 text-xs leading-4 text-typography-500 dark:text-typography-300">
                                                {subtitle}
                                            </Text>
                                        </Box>
                                    </Box>
                                </ScreenSurface>

                                {onRemoveMediaAttachmentDraft ? (
                                    <Box className="absolute -right-1 -top-1">
                                        <ScreenIconButton
                                            onPress={() => onRemoveMediaAttachmentDraft(draft, index)}
                                            accessibilityLabel={t('chat.attachments.removeMediaIndexedAccessibilityLabel', {
                                                ...attachmentLabelOptions,
                                                kind: draft.kind,
                                            })}
                                            iconName="close"
                                            iconSize="xs"
                                            size="micro"
                                            testID={`chat-media-attachment-remove-${index}`}
                                        />
                                    </Box>
                                ) : null}
                            </Box>
                        );
                    })}
                </ScrollView>
            ) : null}

            {attachmentHelperText ? (
                <Text
                    testID="chat-image-attachment-readiness-text"
                    accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
                    role="status"
                    className="text-xs leading-4 text-typography-600 dark:text-typography-300"
                >
                    {attachmentHelperText}
                </Text>
            ) : null}
        </Box>
    ) : null;

    const modeBanner = modeLabel ? (
        <ScreenSurface
            tone={isDarkGlass ? 'default' : 'accent'}
            withControlTint={!isDarkGlass}
            className={modeBannerClassName}
            style={modeBannerStyle}
        >
            <Box className="flex-row items-start justify-between gap-3">
                <Box className="min-w-0 flex-1 flex-row items-start gap-3">
                    <ScreenIconTile
                        iconName="edit"
                        tone={isDarkGlass ? 'neutral' : 'accent'}
                        size="sm"
                        iconSize="xs"
                        className="mt-0.5 h-6 w-6"
                        iconClassName="text-primary-500"
                    />
                    <Box className="min-w-0 flex-1">
                        <Text numberOfLines={1} className="text-sm font-semibold text-primary-700 dark:text-primary-300">
                            {modeLabel}
                        </Text>
                        {modeDescription ? (
                            <Text numberOfLines={2} className="mt-0.5 text-xs leading-4 text-primary-700/80 dark:text-primary-300/80">
                                {modeDescription}
                            </Text>
                        ) : null}
                    </Box>
                </Box>

                {onCancelMode ? (
                    <ScreenIconButton
                        onPress={onCancelMode}
                        accessibilityLabel={t('common.cancel')}
                        iconName="close"
                        iconSize="xs"
                        size="micro"
                        className="border-0"
                        iconClassName="text-primary-500"
                    />
                ) : null}
            </Box>
        </ScreenSurface>
    ) : null;
    const attachmentsContent = attachmentsTray || builtInAttachmentsTray ? (
        <Box testID="chat-input-bar-attachments-tray" className="mb-2">
            {builtInAttachmentsTray}
            {attachmentsTray}
        </Box>
    ) : null;

    if (appearance.surfaceKind !== 'glass') {
        return (
            <Box
                testID="chat-input-bar-container"
                className={`${screenChromeTokens.contentHorizontalPaddingClassName} ${screenChromeTokens.bottomBarVerticalPaddingClassName}`}
            >
                {modeBanner}
                {attachmentsContent}
                {inputRow}
                {attachmentMenuSheet}
            </Box>
        );
    }

    return (
        <Box
            testID="chat-input-bar-container"
            className={`${screenChromeTokens.contentHorizontalPaddingClassName} ${screenChromeTokens.bottomBarVerticalPaddingClassName}`}
        >
            {modeBanner}
            {attachmentsContent}
            <ScreenSurface
                testID="chat-input-bar-capsule"
                decorative="matte"
                androidBlurTargetRef={androidContentBlurTargetRef}
                forceNativeAndroidBlur={Boolean(androidContentBlurTargetRef)}
                className="h-12 rounded-full px-1.5 py-1"
                style={glassComposerCapsuleStyle}
            >
                {inputRow}
            </ScreenSurface>
            {attachmentMenuSheet}
        </Box>
    );
};

const styles = StyleSheet.create({
    attachmentPreviewImage: {
        width: 56,
        height: 56,
        borderRadius: 12,
    },
    attachmentsScrollContent: {
        paddingTop: 4,
        paddingRight: 4,
    },
    transparentInlineInput: {
        backgroundColor: 'transparent',
        borderWidth: 0,
    },
});
