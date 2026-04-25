import React, { useState } from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { ScreenChromeBar, ScreenIconButton, ScreenIconTile, ScreenInlineInput, useScreenAppearance } from './ScreenShell';
import { screenChromeTokens } from '../../utils/themeTokens';
import { useTranslation } from 'react-i18next';
import { getReportedErrorMessage } from '../../services/AppError';

interface ChatInputBarProps {
    onSendMessage: (content: string) => Promise<void> | void;
    onStopGeneration?: () => Promise<void> | void;
    disabled?: boolean;
    isSending?: boolean;
    draft?: string;
    onDraftChange?: (value: string) => void;
    modeLabel?: string;
    modeDescription?: string;
    onCancelMode?: () => void;
    leadingActions?: React.ReactNode;
    trailingActions?: React.ReactNode;
    attachmentsTray?: React.ReactNode;
}

export const ChatInputBar = ({
    onSendMessage,
    onStopGeneration,
    disabled = false,
    isSending = false,
    draft,
    onDraftChange,
    modeLabel,
    modeDescription,
    onCancelMode,
    leadingActions,
    trailingActions,
    attachmentsTray,
}: ChatInputBarProps) => {
    const [internalMessage, setInternalMessage] = useState('');
    const { t } = useTranslation();
    const appearance = useScreenAppearance();
    const isControlled = typeof draft === 'string';
    const message = isControlled ? draft : internalMessage;
    const canSend = !disabled && !isSending && message.trim().length > 0;
    const placeholder = disabled ? t('chat.inputPlaceholderDisabled') : t('chat.inputPlaceholder');

    const setMessage = (value: string) => {
        if (isControlled) {
            onDraftChange?.(value);
            return;
        }

        setInternalMessage(value);
    };

    const handleSend = async () => {
        if (canSend) {
            const nextMessage = message.trim();
            setMessage('');

            try {
                await onSendMessage(nextMessage);
            } catch (error) {
                setMessage(nextMessage);
                throw error;
            }
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

    const resolvedTrailingActions = trailingActions ?? (
        <ScreenIconButton
            onPress={handlePrimaryAction}
            disabled={!isSending && !canSend}
            accessibilityLabel={isSending ? t('chat.stopAccessibilityLabel') : t('chat.sendAccessibilityLabel')}
            iconName={isSending ? 'stop' : 'arrow-upward'}
            className={`border-0 ${isSending || canSend
                ? 'bg-primary-500'
                : appearance.classNames.toneClassNameByTone.neutral.iconTileClassName}`}
            iconClassName={isSending || canSend ? 'text-typography-0' : 'text-typography-500'}
        />
    );

    return (
        <ScreenChromeBar
            testID="chat-input-bar-container"
            className={`${screenChromeTokens.contentHorizontalPaddingClassName} ${screenChromeTokens.bottomBarVerticalPaddingClassName}`}
        >
            {modeLabel ? (
                <Box className={`mb-1.5 ${appearance.classNames.modeBannerClassName}`}>
                    <Box className="flex-row items-start justify-between gap-3">
                        <Box className="min-w-0 flex-1 flex-row items-start gap-3">
                            <ScreenIconTile iconName="edit" tone="accent" size="sm" iconSize="xs" className="mt-0.5 h-6 w-6" iconClassName="text-primary-500" />
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
                </Box>
            ) : null}

            {attachmentsTray ? (
                <Box testID="chat-input-bar-attachments-tray" className="mb-2">
                    {attachmentsTray}
                </Box>
            ) : null}

            <Box testID="chat-input-bar-row" className="flex-row items-center gap-2">
                {leadingActions ? (
                    <Box testID="chat-input-bar-leading-actions" className="flex-row items-center gap-2">
                        {leadingActions}
                    </Box>
                ) : null}

                <ScreenInlineInput
                    variant="composer"
                    className={disabled ? 'flex-1 opacity-60' : 'flex-1'}
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
                    editable={!disabled && !isSending}
                />

                <Box testID="chat-input-bar-trailing-actions" className="flex-row items-center gap-2">
                    {resolvedTrailingActions}
                </Box>
            </Box>
        </ScreenChromeBar>
    );
};
