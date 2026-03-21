import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { StreamingCursor } from './StreamingCursor';
import { MarkdownRenderer } from './MarkdownRenderer';

export interface ChatMessageBubbleProps {
  id: string;
  isUser: boolean;
  content: string;
  isStreaming?: boolean;
  tokensPerSec?: number;
  canDelete?: boolean;
  canRegenerate?: boolean;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}

export const ChatMessageBubble = ({
  id,
  isUser,
  content,
  isStreaming,
  tokensPerSec,
  canDelete = false,
  canRegenerate = false,
  onDelete,
  onRegenerate,
  onLayout,
}: ChatMessageBubbleProps) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = setTimeout(() => {
      setCopied(false);
    }, 1500);

    return () => clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(content);
    setCopied(true);
  };

  const actionLabelClassName = isUser
    ? 'text-primary-500'
    : 'text-typography-500 dark:text-typography-400';
  const actionContainerClassName = isUser
    ? 'mr-8 justify-end'
    : 'ml-8 justify-start';

  if (isUser) {
    return (
      <Box className="w-full flex-col items-end gap-1" onLayout={onLayout}>
        <Box className="w-full flex-row items-end justify-end gap-2 pl-12">
          <Box className="max-w-full min-w-0 flex-shrink rounded-xl rounded-br-none bg-primary-500 px-4 py-2.5 shadow-sm">
            <Text selectable className="text-typography-0 text-base leading-relaxed">{content}</Text>
          </Box>
          <Box className="h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-500/20">
            <MaterialSymbols name="person" size={14} className="text-primary-500" />
          </Box>
        </Box>
        <Box className={`flex-row items-center gap-4 ${actionContainerClassName}`}>
          <Pressable
            testID={`copy-message-${id}`}
            onPress={() => {
              void handleCopy();
            }}
            className="py-1 active:opacity-70"
          >
            <Text className={`text-xs font-semibold uppercase tracking-wide ${actionLabelClassName}`}>
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </Pressable>
          {canRegenerate && onRegenerate ? (
            <Pressable
              testID={`regenerate-message-${id}`}
              onPress={onRegenerate}
              className="py-1 active:opacity-70"
            >
              <Text className={`text-xs font-semibold uppercase tracking-wide ${actionLabelClassName}`}>
                Regenerate
              </Text>
            </Pressable>
          ) : null}
          {canDelete && onDelete ? (
            <Pressable
              testID={`delete-message-${id}`}
              onPress={onDelete}
              className="py-1 active:opacity-70"
            >
              <Text className="text-xs font-semibold uppercase tracking-wide text-error-500">
                Delete
              </Text>
            </Pressable>
          ) : null}
        </Box>
      </Box>
    );
  }

  // AI Bubble
  return (
    <Box className="w-full flex-col items-start gap-1" onLayout={onLayout}>
      <Box className="w-full flex-row items-end justify-start gap-2 pr-12">
        <Box className="h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-500 shadow-lg">
          <MaterialSymbols name="smart-toy" size={14} className="text-typography-0" />
        </Box>
        <Box className="max-w-full min-w-0 flex-shrink rounded-xl rounded-bl-none border border-primary-500/10 bg-primary-500/5 px-4 py-2.5 dark:bg-primary-500/10">
          {isStreaming ? (
            <Text className="text-base leading-relaxed italic text-typography-900 dark:text-typography-100">
              {content}
              <StreamingCursor />
            </Text>
          ) : (
            <MarkdownRenderer content={content} />
          )}
        </Box>
      </Box>
      {!isStreaming ? (
        <Box className={`flex-row items-center gap-4 ${actionContainerClassName}`}>
          <Pressable
            testID={`copy-message-${id}`}
            onPress={() => {
              void handleCopy();
            }}
            className="py-1 active:opacity-70"
          >
            <Text className={`text-xs font-semibold uppercase tracking-wide ${actionLabelClassName}`}>
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </Pressable>
          {canDelete && onDelete ? (
            <Pressable
              testID={`delete-message-${id}`}
              onPress={onDelete}
              className="py-1 active:opacity-70"
            >
              <Text className="text-xs font-semibold uppercase tracking-wide text-error-500">
                Delete
              </Text>
            </Pressable>
          ) : null}
        </Box>
      ) : null}
      
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
