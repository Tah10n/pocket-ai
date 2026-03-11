import React, { useState } from 'react';
import { Box } from '@/components/ui/box';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
            className="bg-transparent border-t border-outline-200 dark:border-outline-800 px-4 py-3"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
            <Box className="flex-row items-end gap-2 bg-background-100 dark:bg-background-800/80 rounded-2xl px-3 py-2 border border-outline-200 dark:border-outline-800">
                <Input className="flex-1 bg-transparent border-0 min-h-[40px] max-h-32">
                    <InputField
                        className="text-typography-900 dark:text-typography-0 text-base"
                        placeholder="Type a message..."
                        placeholderTextColor="text-typography-400"
                        multiline
                        value={message}
                        onChangeText={setMessage}
                    />
                </Input>
                
                <Pressable 
                    onPress={handleSend}
                    className={`p-2 rounded-xl mb-0.5 active:scale-95 transition-all ${message.trim() ? 'bg-primary-500' : 'bg-background-300 dark:bg-background-700'}`}
                >
                    <MaterialSymbols 
                        name="send" 
                        size={20} 
                        className={message.trim() ? 'text-typography-0' : 'text-typography-500'} 
                    />
                </Pressable>
            </Box>
        </Box>
    );
};
