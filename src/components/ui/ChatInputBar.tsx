import React, { useState } from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { typographyColors } from '../../utils/themeTokens';

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
    const isControlled = typeof draft === 'string';
    const message = isControlled ? draft : internalMessage;
    const canSend = !disabled && !isSending && message.trim().length > 0;
    const placeholder = disabled ? 'Load a model to start chatting...' : 'Type a message...';

    const setMessage = (value: string) => {
        if (isControlled) {
            onDraftChange?.(value);
            return;
        }

        setInternalMessage(value);
    };

    const handleSend = async () => {
        if (canSend) {
            await onSendMessage(message.trim());
            setMessage('');
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
            Alert.alert('Cannot send message', error.message || 'Action failed');
        }
    };

    return (
        <Box 
            className="bg-background-0/80 dark:bg-background-950/80 border-t border-outline-200 dark:border-outline-800 px-4 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
            {modeLabel ? (
                <Box className="mb-3 rounded-2xl border border-primary-500/15 bg-primary-500/5 px-4 py-3">
                    <Box className="flex-row items-start justify-between gap-3">
                        <Box className="min-w-0 flex-1">
                            <Text className="text-sm font-semibold text-primary-700 dark:text-primary-300">
                                {modeLabel}
                            </Text>
                            {modeDescription ? (
                                <Text className="mt-1 text-sm text-primary-700/80 dark:text-primary-300/80">
                                    {modeDescription}
                                </Text>
                            ) : null}
                        </Box>
                        {onCancelMode ? (
                            <Pressable
                                onPress={onCancelMode}
                                className="rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1.5 active:opacity-70"
                            >
                                <Text className="text-xs font-semibold uppercase tracking-wide text-primary-500">
                                    Cancel
                                </Text>
                            </Pressable>
                        ) : null}
                    </Box>
                </Box>
            ) : null}

            <Box className="flex-row items-end gap-2">
                <Pressable className="h-10 w-10 items-center justify-center rounded-full bg-background-50 dark:bg-background-900/60 border border-outline-200 dark:border-outline-700 active:opacity-70">
                    <MaterialSymbols name="add-circle" size={22} className="text-typography-600 dark:text-typography-300" />
                </Pressable>

                <Box className="flex-1 flex-row items-end rounded-2xl px-3 py-2 border border-outline-200 dark:border-outline-800 bg-background-50 dark:bg-background-900/60">
                    <Input className="flex-1 bg-transparent border-0 min-h-10 max-h-32">
                        <InputField
                            className="text-typography-900 dark:text-typography-0 text-base leading-relaxed"
                            placeholder={placeholder}
                            placeholderTextColor={typographyColors[400]}
                            keyboardType="default"
                            returnKeyType="send"
                            enterKeyHint="send"
                            submitBehavior="submit"
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
                    className={`h-10 w-10 items-center justify-center rounded-full active:opacity-70 ${isSending || canSend ? 'bg-primary-500' : 'bg-background-200 dark:bg-background-800'}`}
                >
                    <MaterialSymbols 
                        name={isSending ? 'stop' : 'arrow-upward'} 
                        size={20} 
                        className={isSending || canSend ? 'text-typography-0' : 'text-typography-500'} 
                    />
                </Pressable>
            </Box>
        </Box>
    );
};
