import React, { useState } from 'react';
import { Box } from '@/components/ui/box';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { typographyColors } from '../../utils/themeTokens';

interface ChatInputBarProps {
    onSendMessage: (content: string) => void;
}

export const ChatInputBar = ({ onSendMessage }: ChatInputBarProps) => {
    const [message, setMessage] = useState('');
    const insets = useSafeAreaInsets();

    const handleSend = () => {
        if (message.trim()) {
            onSendMessage(message.trim());
            setMessage('');
        }
    };

    return (
        <Box 
            className="bg-background-0/80 dark:bg-background-950/80 border-t border-outline-200 dark:border-outline-800 px-4 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
            <Box className="flex-row items-end gap-2">
                <Pressable className="h-10 w-10 items-center justify-center rounded-full bg-background-50 dark:bg-background-900/60 border border-outline-200 dark:border-outline-700 active:opacity-70">
                    <MaterialSymbols name="add-circle" size={22} className="text-typography-600 dark:text-typography-300" />
                </Pressable>

                <Box className="flex-1 flex-row items-end rounded-2xl px-3 py-2 border border-outline-200 dark:border-outline-800 bg-background-50 dark:bg-background-900/60">
                    <Input className="flex-1 bg-transparent border-0 min-h-10 max-h-32">
                        <InputField
                            className="text-typography-900 dark:text-typography-0 text-base leading-relaxed"
                            placeholder="Type a message..."
                            placeholderTextColor={typographyColors[400]}
                            multiline
                            value={message}
                            onChangeText={setMessage}
                        />
                    </Input>
                </Box>

                <Pressable 
                    onPress={handleSend}
                    className={`h-10 w-10 items-center justify-center rounded-full active:scale-95 transition-all ${message.trim() ? 'bg-primary-500' : 'bg-background-200 dark:bg-background-800'}`}
                >
                    <MaterialSymbols 
                        name="arrow-upward" 
                        size={20} 
                        className={message.trim() ? 'text-typography-0' : 'text-typography-500'} 
                    />
                </Pressable>
            </Box>
        </Box>
    );
};
