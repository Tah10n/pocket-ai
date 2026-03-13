import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
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
      <Box className="flex-col items-end gap-1">
        <Box className="flex-row items-end gap-2 w-5/6 justify-end">
          <Box className="bg-primary-500 px-4 py-2.5 rounded-xl rounded-br-none shadow-sm flex-shrink">
            <Text className="text-typography-0 text-base leading-relaxed">{content}</Text>
          </Box>
          <Box className="w-6 h-6 rounded-full bg-primary-500/20 items-center justify-center shrink-0">
            <MaterialSymbols name="person" size={14} className="text-primary-500" />
          </Box>
        </Box>
      </Box>
    );
  }

  // AI Bubble
  return (
    <Box className="flex-col items-start gap-1">
      <Box className="flex-row items-end gap-2 w-5/6 justify-start">
        <Box className="w-6 h-6 rounded-full bg-primary-500 items-center justify-center shrink-0 shadow-lg">
          <MaterialSymbols name="smart-toy" size={14} className="text-typography-0" />
        </Box>
        <Box className="bg-primary-500/5 dark:bg-primary-500/10 border border-primary-500/10 px-4 py-2.5 rounded-xl rounded-bl-none flex-shrink">
          <Text className={`text-base leading-relaxed text-typography-900 dark:text-typography-100 ${isStreaming ? 'italic' : ''}`}>
            {content}
            {isStreaming && <StreamingCursor />}
          </Text>
        </Box>
      </Box>
      
      {tokensPerSec !== undefined && (
        <Box className="ml-8 mt-1">
          <Box className="flex-row items-center gap-1">
            <MaterialSymbols name="bolt" size={12} className="text-typography-500 dark:text-typography-400" />
            <Text className="text-xs font-medium text-typography-500 dark:text-typography-400">
              {tokensPerSec.toFixed(1)} t/s
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
