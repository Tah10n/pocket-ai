import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { StreamingCursor } from './StreamingCursor';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingPulse } from './ThinkingPulse';
import { getAssistantPresentation, getCopyableAssistantContent } from '../../utils/chatPresentation';

export interface ChatMessageBubbleProps {
  id: string;
  isUser: boolean;
  content: string;
  thoughtContent?: string;
  isStreaming?: boolean;
  tokensPerSec?: number;
  canDelete?: boolean;
  canRegenerate?: boolean;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}

function IconActionButton({
  testID,
  iconName,
  label,
  onPress,
  isDestructive = false,
}: {
  testID: string;
  iconName: string;
  label: string;
  onPress: () => void;
  isDestructive?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      className={`h-7 w-7 items-center justify-center rounded-full active:opacity-70 ${isDestructive
        ? 'bg-error-500/10 dark:bg-error-500/15'
        : 'bg-background-100 dark:bg-background-800'}`}
    >
      <MaterialSymbols
        name={iconName}
        size={15}
        className={isDestructive ? 'text-error-500' : 'text-typography-500 dark:text-typography-300'}
      />
    </Pressable>
  );
}

export const ChatMessageBubble = ({
  id,
  isUser,
  content,
  thoughtContent: explicitThoughtContent,
  isStreaming,
  tokensPerSec,
  canDelete = false,
  canRegenerate = false,
  onDelete,
  onRegenerate,
  onLayout,
}: ChatMessageBubbleProps) => {
  const [copied, setCopied] = useState(false);
  const [isThoughtExpanded, setThoughtExpanded] = useState(false);
  const { t } = useTranslation();
  const hasExplicitThoughtContent = explicitThoughtContent !== undefined;
  const assistantPresentation = isUser
    ? null
    : hasExplicitThoughtContent
      ? null
      : getAssistantPresentation(content, {
          isStreaming: Boolean(isStreaming),
        });
  const isAssistantStreaming = !isUser && Boolean(isStreaming);
  const thoughtContent = hasExplicitThoughtContent
    ? explicitThoughtContent ?? ''
    : assistantPresentation?.thoughtContent ?? '';
  const hasThought = hasExplicitThoughtContent
    ? thoughtContent.trim().length > 0
    : Boolean(assistantPresentation?.hasThought);
  const finalContent = hasExplicitThoughtContent
    ? content
    : assistantPresentation?.finalContent ?? content;
  const shouldAnimateThought = isAssistantStreaming && hasThought;
  const showPerformanceLabel =
    !isUser &&
    tokensPerSec !== undefined &&
    typeof __DEV__ !== 'undefined' &&
    __DEV__;
  const copyableContent = isUser || hasExplicitThoughtContent ? content : getCopyableAssistantContent(content);
  const hasCopyableContent = copyableContent.trim().length > 0;
  const shouldShowActionRow = !isStreaming && (
    hasCopyableContent
    || (canRegenerate && Boolean(onRegenerate))
    || (canDelete && Boolean(onDelete))
  );
  const shouldShowMetadataRow = shouldShowActionRow || showPerformanceLabel;

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
    await Clipboard.setStringAsync(copyableContent);
    setCopied(true);
  };

  const metadataRowClassName = isUser ? 'self-end mr-1' : 'self-start ml-1';
  const bubbleAlignmentClassName = isUser ? 'self-end' : 'self-start';
  const bubbleClassName = isUser
    ? 'rounded-[24px] rounded-br-lg bg-primary-500 px-3.5 py-2'
    : 'rounded-[22px] rounded-bl-lg border border-outline-200 bg-background-50 px-3 py-1.5 dark:border-outline-800 dark:bg-background-900/70';
  const shouldShowThoughtSection = !isUser && hasThought;
  const thoughtLabel = shouldAnimateThought ? t('chat.thinkingTitle') : t('chat.thoughtTitle');
  const thoughtDescription = shouldAnimateThought
    ? t('chat.thinkingDescription')
    : t('chat.thoughtDescription');
  const assistantBodyContent = isUser ? content : finalContent;
  const shouldShowStreamingPlaceholder = isAssistantStreaming && !shouldShowThoughtSection && !assistantBodyContent;
  const thoughtBubbleClassName = 'min-w-[220px] max-w-full rounded-[20px] border border-primary-500/15 bg-background-0/95 px-3 py-2 dark:border-primary-500/20 dark:bg-background-950/75';

  return (
    <Box className={`w-full flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`} onLayout={onLayout}>
      <Box className={`w-full flex-row ${isUser ? 'items-end justify-end pl-8' : 'items-start justify-start pr-8'}`}>
        <Box
          testID={`message-bubble-shell-${id}`}
          className={`max-w-full min-w-0 flex-shrink ${bubbleAlignmentClassName} ${bubbleClassName}`}
        >
          {shouldShowThoughtSection ? (
            <Box className={`${assistantBodyContent ? 'mb-1.5 ' : ''}${thoughtBubbleClassName}`}>
              <Pressable
                testID={`thought-toggle-${id}`}
                onPress={() => {
                  setThoughtExpanded((current) => !current);
                }}
                accessibilityRole="button"
                accessibilityLabel={isThoughtExpanded
                  ? t('chat.thoughtCollapseAccessibilityLabel')
                  : t('chat.thoughtExpandAccessibilityLabel')}
                className="active:opacity-80"
              >
                <Box className="flex-row items-center gap-2.5">
                  <Box className="h-7 w-7 items-center justify-center rounded-full bg-primary-500/10 dark:bg-primary-500/20">
                    {shouldAnimateThought ? (
                      <ThinkingPulse />
                    ) : (
                      <MaterialSymbols name="psychology-alt" size={15} className="text-primary-500" />
                    )}
                  </Box>

                  <Box className="min-w-0 flex-1">
                    <Text className="text-xs font-semibold text-typography-900 dark:text-typography-100">
                      {thoughtLabel}
                    </Text>
                    <Text className="mt-0.5 text-[11px] leading-4 text-typography-500 dark:text-typography-400">
                      {thoughtDescription}
                    </Text>
                  </Box>

                  <MaterialSymbols
                    name={isThoughtExpanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                    size={17}
                    className="text-typography-500 dark:text-typography-400"
                  />
                </Box>
              </Pressable>

              {isThoughtExpanded ? (
                <Box
                  testID={`thought-panel-${id}`}
                  className="mt-1.5 border-t border-primary-500/12 pt-1.5 dark:border-primary-500/20"
                >
                  {thoughtContent ? (
                    isAssistantStreaming && (hasExplicitThoughtContent || assistantPresentation?.isThoughtStreaming) ? (
                      <Text className="text-sm leading-6 text-typography-700 dark:text-typography-200">
                        {thoughtContent}
                        <StreamingCursor />
                      </Text>
                    ) : (
                      <MarkdownRenderer content={thoughtContent} />
                    )
                  ) : (
                    <Text className="text-sm leading-6 text-typography-500 dark:text-typography-400">
                      {t('chat.thinkingWaiting')}
                    </Text>
                  )}
                </Box>
              ) : null}
            </Box>
          ) : null}

          {isUser ? (
            <Text selectable className="text-base leading-relaxed text-typography-0">
              {content}
            </Text>
          ) : shouldShowStreamingPlaceholder ? (
            <StreamingCursor compact />
          ) : isStreaming && assistantBodyContent ? (
            <Text className="text-base leading-relaxed text-typography-900 dark:text-typography-100">
              {assistantBodyContent}
              <StreamingCursor />
            </Text>
          ) : assistantBodyContent ? (
            <MarkdownRenderer content={assistantBodyContent} />
          ) : null}
        </Box>
      </Box>

      {shouldShowMetadataRow ? (
        <Box
          testID={`message-metadata-${id}`}
          className={`mt-0.5 flex-row items-center gap-1.5 ${metadataRowClassName}`}
        >
          {showPerformanceLabel ? (
            <Box
              testID={`performance-label-${id}`}
              className="rounded-full border border-outline-200 bg-background-100/90 px-2 py-0.5 dark:border-outline-700 dark:bg-background-800/90"
            >
              <Text className="text-[10px] font-semibold text-typography-600 dark:text-typography-300">
                {tokensPerSec?.toFixed(1)} t/s
              </Text>
            </Box>
          ) : null}
          {hasCopyableContent ? (
            <IconActionButton
              testID={`copy-message-${id}`}
              iconName={copied ? 'check' : 'content-copy'}
              label={t('chat.messageActionCopyAccessibilityLabel')}
              onPress={() => {
                void handleCopy();
              }}
            />
          ) : null}
          {canRegenerate && onRegenerate ? (
            <IconActionButton
              testID={`regenerate-message-${id}`}
              iconName="refresh"
              label={t('chat.messageActionRegenerateAccessibilityLabel')}
              onPress={onRegenerate}
            />
          ) : null}
          {canDelete && onDelete ? (
            <IconActionButton
              testID={`delete-message-${id}`}
              iconName="delete-outline"
              label={t('chat.messageActionDeleteAccessibilityLabel')}
              onPress={onDelete}
              isDestructive
            />
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};
