import React from 'react';
import { View, Text } from 'react-native';
import { MaterialSymbols } from './MaterialSymbols';
import { StreamingCursor } from './StreamingCursor';

export interface ChatMessageBubbleProps {
  id: string;
  isUser: boolean;
  content: string;
  isStreaming?: boolean;
  tokensPerSec?: number;
}

export const ChatMessageBubble = ({ isUser, content, isStreaming, tokensPerSec }: ChatMessageBubbleProps) => {
  if (isUser) {
    return (
      <View className="flex-col items-end gap-1 mb-6">
        <View className="flex-row items-end gap-2 max-w-[85%]">
          <View className="bg-primary px-4 py-2.5 rounded-xl rounded-br-none shadow-sm">
            <Text className="text-white text-[15px] leading-relaxed">{content}</Text>
          </View>
          <View className="w-6 h-6 rounded-full bg-primary/20 items-center justify-center shrink-0">
            <MaterialSymbols name="person" size={14} className="text-primary" />
          </View>
        </View>
      </View>
    );
  }

  // AI Bubble
  return (
    <View className="flex-col items-start gap-1 mb-6">
      <View className="flex-row items-end gap-2 max-w-[85%]">
        <View className="w-6 h-6 rounded-full bg-primary items-center justify-center shrink-0 shadow-lg">
          <MaterialSymbols name="smart-toy" size={14} className="text-white" />
        </View>
        <View className="bg-primary/5 dark:bg-primary/10 border border-primary/10 px-4 py-2.5 rounded-xl rounded-bl-none">
          <Text className={`text-[15px] leading-relaxed text-slate-900 dark:text-slate-100 ${isStreaming ? 'italic' : ''}`}>
            {content}
            {isStreaming && <StreamingCursor />}
          </Text>
        </View>
      </View>
      
      {tokensPerSec !== undefined && (
        <View className="ml-8 mt-1">
          <View className="flex-row items-center gap-1">
            <MaterialSymbols name="bolt" size={12} className="text-slate-500 dark:text-slate-400" />
            <Text className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
              {tokensPerSec.toFixed(1)} t/s
            </Text>
          </View>
        </View>
      )}
    </View>
  );
};
