import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { ScreenBadge, ScreenIconButton } from './ScreenShell';
import { StreamingCursor } from './StreamingCursor';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingPulse } from './ThinkingPulse';
import { getAssistantPresentation, getCopyableAssistantContent } from '../../utils/chatPresentation';

export interface ChatMessageBubbleProps {
  id: string;
  isUser: boolean;
  content: string;
  thoughtContent?: string;
  errorMessage?: string;
  isStreaming?: boolean;
  tokensPerSec?: number;
  canDelete?: boolean;
  canRegenerate?: boolean;
  onDelete?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}

function areChatMessageBubblePropsEqual(prev: ChatMessageBubbleProps, next: ChatMessageBubbleProps) {
  return (
    prev.id === next.id
    && prev.isUser === next.isUser
    && prev.content === next.content
    && prev.thoughtContent === next.thoughtContent
    && prev.errorMessage === next.errorMessage
    && prev.isStreaming === next.isStreaming
    && prev.tokensPerSec === next.tokensPerSec
    && prev.canDelete === next.canDelete
    && prev.canRegenerate === next.canRegenerate
    && prev.onDelete === next.onDelete
    && prev.onRegenerate === next.onRegenerate
    && prev.onLayout === next.onLayout
  );
}

function IconActionButton({
  testID,
  iconName,
  label,
  onPress,
  isDestructive = false,
}: {
  testID: string;
  iconName: React.ComponentProps<typeof MaterialSymbols>['name'];
  label: string;
  onPress: () => void;
  isDestructive?: boolean;
}) {
  return (
    <ScreenIconButton
      testID={testID}
      onPress={onPress}
      accessibilityLabel={label}
      iconName={iconName}
      iconSize={15}
      size="micro"
      tone={isDestructive ? 'danger' : 'neutral'}
      className={`border-0 ${isDestructive
        ? 'bg-error-500/10 dark:bg-error-500/15'
        : 'bg-primary-500/10 dark:bg-primary-500/15'}`}
      iconClassName={isDestructive ? 'text-error-500' : 'text-typography-500 dark:text-typography-300'}
    />
  );
}

const ChatMessageBubbleComponent = ({
  id,
  isUser,
  content,
  thoughtContent: explicitThoughtContent,
  errorMessage,
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
  const hasErrorMessage = !isUser && typeof errorMessage === 'string' && errorMessage.trim().length > 0;
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
                      <MarkdownRenderer content={thoughtContent} selectable />
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
            <MarkdownRenderer content={assistantBodyContent} selectable />
          ) : null}

          {hasErrorMessage ? (
            <Box className="mt-2 flex-row items-start gap-2 rounded-2xl bg-error-500/10 px-2.5 py-2 dark:bg-error-500/15">
              <MaterialSymbols name="error-outline" size={16} className="mt-0.5 text-error-600 dark:text-error-300" />
              <Text selectable className="min-w-0 flex-1 text-sm leading-5 text-error-800 dark:text-error-200">
                {errorMessage}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>

      {shouldShowMetadataRow ? (
        <Box
          testID={`message-metadata-${id}`}
          className={`mt-0.5 flex-row items-center gap-1.5 ${metadataRowClassName}`}
        >
          {showPerformanceLabel ? (
            <ScreenBadge
              testID={`performance-label-${id}`}
              size="micro"
              className="bg-background-100/90 dark:bg-background-800/90"
              textClassName="text-typography-600 dark:text-typography-300"
            >
              {tokensPerSec?.toFixed(1)} t/s
            </ScreenBadge>
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
              onPress={() => onRegenerate(id)}
            />
          ) : null}
          {canDelete && onDelete ? (
            <IconActionButton
              testID={`delete-message-${id}`}
              iconName="delete-outline"
              label={t('chat.messageActionDeleteAccessibilityLabel')}
              onPress={() => onDelete(id)}
              isDestructive
            />
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};

ChatMessageBubbleComponent.displayName = 'ChatMessageBubble';

export const ChatMessageBubble = React.memo(ChatMessageBubbleComponent, areChatMessageBubblePropsEqual);
ChatMessageBubble.displayName = 'ChatMessageBubble';
