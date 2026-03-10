import React from 'react';
import { View, TextInput, Pressable } from 'react-native';
import { MaterialSymbols } from './MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ChatInputBarProps {
  onSubmit?: (text: string) => void;
}

export const ChatInputBar = ({ onSubmit }: ChatInputBarProps) => {
  const insets = useSafeAreaInsets();
  const [text, setText] = React.useState('');

  const handleSubmit = () => {
      if (text.trim() && onSubmit) {
          onSubmit(text.trim());
          setText('');
      }
  };

  return (
    <View 
      className="p-4 bg-background-light dark:bg-background-dark border-t border-primary/10"
      style={{ paddingBottom: Math.max(insets.bottom, 16) }}
    >
      <View className="flex-row items-end gap-2">
        <Pressable className="p-2 text-primary hover:bg-primary/10 rounded-full transition-colors active:opacity-70">
          <MaterialSymbols name="add-circle" size={24} className="text-primary" />
        </Pressable>
        
        <View className="flex-1 relative">
          <View className="w-full bg-primary/5 dark:bg-primary/10 border border-primary/20 rounded-2xl px-4 py-2 min-h-[44px] justify-center">
            <TextInput 
              className="text-slate-900 dark:text-slate-100 text-sm max-h-32"
              placeholder="Ask anything..."
              placeholderTextColor="#94a3b8"
              multiline
              value={text}
              onChangeText={setText}
            />
          </View>
        </View>
        
        <Pressable 
          onPress={handleSubmit} 
          className="bg-primary h-[44px] w-[44px] rounded-full shadow-lg items-center justify-center active:opacity-90"
        >
          <MaterialSymbols name="arrow-upward" size={20} className="text-white" />
        </Pressable>
      </View>
      
      {insets.bottom === 0 && (
        <View className="mt-3 items-center">
            <View className="h-1 w-32 bg-slate-300 dark:bg-slate-700 rounded-full opacity-50" />
        </View>
      )}
    </View>
  );
};
