import React, { useRef, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { ScreenIconButton, ScreenIconTile, ScreenInlineInput, ScreenSurface, useScreenAppearance } from './ScreenShell';
import { getThemeActionContentClassName, screenChromeTokens, withAlpha, type ResolvedThemeMode } from '../../utils/themeTokens';
import { useTheme } from '../../providers/ThemeProvider';
import { useTranslation } from 'react-i18next';
import { getReportedErrorMessage } from '../../services/AppError';
import {
    MAX_CHAT_IMAGE_ATTACHMENTS,
    getSendableDraftImageAttachments,
    hasFailedDraftImageAttachments,
} from '../../utils/chatImageAttachments';
import type { AttachmentDraft } from '../../types/multimodal';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';

interface ChatInputBarProps {
    onSendMessage: (content: string) => Promise<void> | void;
    onStopGeneration?: () => Promise<void> | void;
    disabled?: boolean;
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
    onAttachImages?: () => Promise<void> | void;
    onRemoveAttachmentDraft?: (draft: AttachmentDraft, index: number) => void;
    imageAttachmentsEnabled?: boolean;
    imageAttachmentsDisabledReason?: string;
    isImageAttachmentActionBusy?: boolean;
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

export const ChatInputBar = ({
    onSendMessage,
    onStopGeneration,
    disabled = false,
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
    onAttachImages,
    onRemoveAttachmentDraft,
    imageAttachmentsEnabled = false,
    imageAttachmentsDisabledReason,
    isImageAttachmentActionBusy = false,
}: ChatInputBarProps) => {
    const [internalMessage, setInternalMessage] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const submitLockRef = useRef(false);
    const { t } = useTranslation();
    const theme = useTheme();
    const appearance = useScreenAppearance();
    const isDarkGlass = appearance.surfaceKind === 'glass' && theme.resolvedMode === 'dark';
    const isControlled = typeof draft === 'string';
    const message = isControlled ? draft : internalMessage;
    const hasAttachmentCopyFailures = imageAttachmentsEnabled && hasFailedDraftImageAttachments(attachmentDrafts);
    const hasTooLargeAttachmentFailures = imageAttachmentsEnabled
        && attachmentDrafts.some((attachmentDraft) => (
            attachmentDraft.copyStatus === 'failed'
            && attachmentDraft.errorReason === 'too_large'
        ));
    const hasCopyOrStorageAttachmentFailures = imageAttachmentsEnabled
        && attachmentDrafts.some((attachmentDraft) => (
            attachmentDraft.copyStatus === 'failed'
            && attachmentDraft.errorReason !== 'too_large'
        ));
    const sendableAttachmentDrafts = imageAttachmentsEnabled
        ? getSendableDraftImageAttachments(attachmentDrafts)
        : [];
    const hasReadyAttachmentDrafts = imageAttachmentsEnabled
        && attachmentDrafts.length > 0
        && sendableAttachmentDrafts.length === attachmentDrafts.length;
    const canSend = !disabled
        && !isSending
        && !isSubmitting
        && !isImageAttachmentActionBusy
        && !hasAttachmentCopyFailures
        && (message.trim().length > 0 || hasReadyAttachmentDrafts || allowEmptyMessageSend);
    const placeholder = disabled ? t('chat.inputPlaceholderDisabled') : t('chat.inputPlaceholder');
    const attachmentLimitReached = imageAttachmentsEnabled && attachmentDrafts.length >= MAX_CHAT_IMAGE_ATTACHMENTS;
    const canAttachImages = Boolean(onAttachImages)
        && imageAttachmentsEnabled
        && !disabled
        && !isSending
        && !isSubmitting
        && !isImageAttachmentActionBusy
        && !attachmentLimitReached;

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
    const attachmentAction = onAttachImages ? (
        <ScreenIconButton
            onPress={() => {
                void handleAttachImages();
            }}
            disabled={!canAttachImages}
            accessibilityLabel={t('chat.attachments.attachImageAccessibilityLabel')}
            accessibilityState={{ disabled: !canAttachImages }}
            iconName="image"
            iconSize="sm"
            size="compact"
            testID="chat-attach-image-button"
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

    const attachmentHelperText = (() => {
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
    const builtInAttachmentsTray = attachmentDrafts.length > 0 || attachmentHelperText || isImageAttachmentActionBusy ? (
        <Box testID="chat-image-attachments-tray" className="gap-2">
            {isImageAttachmentActionBusy ? (
                <Box
                    testID="chat-image-attachment-busy-indicator"
                    accessibilityRole="progressbar"
                    accessibilityLabel={t('chat.attachments.preparingImage')}
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

            {attachmentDrafts.length > 0 ? (
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
                                        <Image
                                            testID={`chat-image-attachment-preview-${index}`}
                                            accessibilityLabel={t('chat.attachments.previewIndexedAccessibilityLabel', attachmentLabelOptions)}
                                            source={{ uri: draft.previewUri }}
                                            style={styles.attachmentPreviewImage}
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
                </ScrollView>
            ) : null}

            {attachmentHelperText ? (
                <Text
                    testID="chat-image-attachment-readiness-text"
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
