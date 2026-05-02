import React, { useState } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { ScreenIconButton, ScreenIconTile, ScreenInlineInput, ScreenSurface, useScreenAppearance } from './ScreenShell';
import { getThemeActionContentClassName, screenChromeTokens, withAlpha, type ResolvedThemeMode } from '../../utils/themeTokens';
import { useTheme } from '../../providers/ThemeProvider';
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
    modeLabel,
    modeDescription,
    onCancelMode,
    leadingActions,
    trailingActions,
    attachmentsTray,
}: ChatInputBarProps) => {
    const [internalMessage, setInternalMessage] = useState('');
    const { t } = useTranslation();
    const theme = useTheme();
    const appearance = useScreenAppearance();
    const isDarkGlass = appearance.surfaceKind === 'glass' && theme.resolvedMode === 'dark';
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
    const inputRow = (
        <Box
            testID="chat-input-bar-row"
            className={appearance.surfaceKind === 'glass'
                ? 'h-full flex-row items-center gap-2'
                : 'flex-row items-center gap-2'}
        >
            {leadingActions ? (
                <Box testID="chat-input-bar-leading-actions" className="flex-row items-center gap-2">
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
                editable={!disabled && !isSending}
            />

            <Box testID="chat-input-bar-trailing-actions" className="flex-row items-center gap-2">
                {resolvedTrailingActions}
            </Box>
        </Box>
    );

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
    const attachmentsContent = attachmentsTray ? (
        <Box testID="chat-input-bar-attachments-tray" className="mb-2">
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
                decorative={isDarkGlass ? 'tint' : 'matte'}
                className="h-12 rounded-full px-1.5 py-1"
                style={glassComposerCapsuleStyle}
            >
                {inputRow}
            </ScreenSurface>
        </Box>
    );
};

const styles = StyleSheet.create({
    transparentInlineInput: {
        backgroundColor: 'transparent',
        borderWidth: 0,
    },
});
