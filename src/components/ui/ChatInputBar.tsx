import React, { useState } from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { typographyColors } from '../../utils/themeTokens';
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
}

export const BASE_COMPOSER_TOP_PADDING = 5;
export const BASE_COMPOSER_BOTTOM_PADDING = 15;

export function getComposerContainerPadding(bottomInset: number) {
    return {
        paddingTop: BASE_COMPOSER_TOP_PADDING,
        paddingBottom: BASE_COMPOSER_BOTTOM_PADDING + Math.max(bottomInset, 0),
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
}: ChatInputBarProps) => {
    const [internalMessage, setInternalMessage] = useState('');
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const isControlled = typeof draft === 'string';
    const message = isControlled ? draft : internalMessage;
    const canSend = !disabled && !isSending && message.trim().length > 0;
    const placeholder = disabled ? t('chat.inputPlaceholderDisabled') : t('chat.inputPlaceholder');
    const containerStyle = getComposerContainerPadding(insets.bottom);

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

    return (
        <Box
            testID="chat-input-bar-container"
            className="border-t border-outline-200 bg-background-0/95 px-4 dark:border-outline-800 dark:bg-background-950/95"
            style={containerStyle}
        >
            {modeLabel ? (
                <Box className="mb-1.5 rounded-[20px] border border-primary-500/15 bg-primary-500/5 px-3 py-2">
                    <Box className="flex-row items-start justify-between gap-3">
                        <Box className="min-w-0 flex-1 flex-row items-start gap-3">
                            <Box className="mt-0.5 h-6 w-6 items-center justify-center rounded-full bg-primary-500/10 dark:bg-primary-500/20">
                                <MaterialSymbols name="edit" size={14} className="text-primary-500" />
                            </Box>
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
                            <Pressable
                                onPress={onCancelMode}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.cancel')}
                                hitSlop={8}
                                className="h-6 w-6 items-center justify-center rounded-full bg-primary-500/10 active:opacity-70"
                            >
                                <MaterialSymbols name="close" size={14} className="text-primary-500" />
                            </Pressable>
                        ) : null}
                    </Box>
                </Box>
            ) : null}

            <Box className="flex-row items-center gap-2">
                <Box
                    className={`flex-1 flex-row items-center rounded-[26px] border px-3.5 min-h-10 ${disabled
                        ? 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900/70'
                        : 'border-outline-200 bg-background-50 dark:border-outline-700 dark:bg-background-900/80'}`}
                >
                    <Input className="flex-1 bg-transparent border-0 h-10 max-h-28">
                        <InputField
                            accessibilityLabel={t('chat.inputAccessibilityLabel')}
                            className="h-10 py-0 text-[15px] text-typography-900 dark:text-typography-0"
                            placeholder={placeholder}
                            placeholderTextColor={typographyColors[400]}
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
                    </Input>
                </Box>

                <Pressable
                    onPress={handlePrimaryAction}
                    disabled={!isSending && !canSend}
                    accessibilityRole="button"
                    accessibilityLabel={isSending ? t('chat.stopAccessibilityLabel') : t('chat.sendAccessibilityLabel')}
                    hitSlop={8}
                    className={`h-10 w-10 items-center justify-center rounded-full active:opacity-70 ${isSending || canSend
                        ? 'bg-primary-500'
                        : 'bg-background-200 dark:bg-background-800'}`}
                >
                    <MaterialSymbols
                        name={isSending ? 'stop' : 'arrow-upward'}
                        size={18}
                        className={isSending || canSend ? 'text-typography-0' : 'text-typography-500'}
                    />
                </Pressable>
            </Box>
        </Box>
    );
};
