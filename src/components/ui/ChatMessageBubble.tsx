import React, { useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { ChatAttachment } from '@/types/attachments';
import type { ChatMessageState } from '@/types/chat';
import type { InferenceCompletionTelemetry } from '@/types/models';
import type { ChatImageAttachment } from '@/types/multimodal';
import { MaterialSymbols } from './MaterialSymbols';
import { ScreenBadge, ScreenIconButton, ScreenIconTile, ScreenSurface, useScreenAppearance } from './ScreenShell';
import { StreamingCursor } from './StreamingCursor';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingPulse } from './ThinkingPulse';
import { getAssistantPresentation } from '../../utils/chatPresentation';
import { getThemeActionContentClassName } from '../../utils/themeTokens';

export interface ChatMessageBubbleProps {
  id: string;
  isUser: boolean;
  content: string;
  attachments?: (ChatImageAttachment | ChatAttachment)[];
  thoughtContent?: string;
  errorMessage?: string;
  isStreaming?: boolean;
  messageState?: ChatMessageState;
  tokensPerSec?: number;
  inferenceMetrics?: InferenceCompletionTelemetry;
  canDelete?: boolean;
  canRegenerate?: boolean;
  onDelete?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}

function areChatImageAttachmentPropsEqual(
  prev: (ChatImageAttachment | ChatAttachment)[] | undefined,
  next: (ChatImageAttachment | ChatAttachment)[] | undefined,
) {
  if (prev === next) {
    return true;
  }

  if (!prev || !next || prev.length !== next.length) {
    return false;
  }

  return prev.every((attachment, index) => {
    const nextAttachment = next[index];
    return (
      attachment.id === nextAttachment.id
      && ('kind' in attachment ? attachment.kind : 'image') === ('kind' in nextAttachment ? nextAttachment.kind : 'image')
      && attachment.localUri === nextAttachment.localUri
      && getAttachmentPreferredPreviewUri(attachment) === getAttachmentPreferredPreviewUri(nextAttachment)
      && attachment.fileName === nextAttachment.fileName
    );
  });
}

function isImageMessageAttachment(
  attachment: ChatImageAttachment | ChatAttachment,
): boolean {
  return !('kind' in attachment) || attachment.kind === 'image';
}

function getAttachmentPreferredPreviewUri(attachment: ChatImageAttachment | ChatAttachment): string {
  if ('kind' in attachment) {
    return attachment.kind === 'image'
      ? attachment.image?.thumbnailUri ?? attachment.localUri
      : attachment.localUri;
  }

  return attachment.thumbnailUri ?? attachment.localUri;
}

function getAttachmentPreviewUriCandidates(attachment: ChatImageAttachment | ChatAttachment): string[] {
  const previewUri = 'kind' in attachment && attachment.kind !== 'image'
    ? undefined
    : 'kind' in attachment
      ? attachment.image?.thumbnailUri
      : attachment.thumbnailUri;

  return Array.from(new Set([
    previewUri,
    attachment.localUri,
  ].filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)));
}

function getAttachmentIconName(attachment: ChatAttachment): React.ComponentProps<typeof MaterialSymbols>['name'] {
  switch (attachment.kind) {
    case 'audio':
      return 'graphic-eq';
    case 'document':
      return 'description';
    case 'video':
      return 'movie';
    case 'image':
    default:
      return 'image';
  }
}

function getAttachmentLabel(attachment: ChatAttachment): string {
  switch (attachment.kind) {
    case 'audio':
      return 'Audio';
    case 'document':
      return 'Document';
    case 'video':
      return 'Video';
    case 'image':
    default:
      return 'Image';
  }
}

function areAttachmentPreviewUriMapsEqual(
  prev: Record<string, string | null>,
  next: Record<string, string | null>,
) {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);

  return prevKeys.length === nextKeys.length
    && nextKeys.every((key) => prev[key] === next[key]);
}

function areChatMessageBubblePropsEqual(prev: ChatMessageBubbleProps, next: ChatMessageBubbleProps) {
  return (
    prev.id === next.id
    && prev.isUser === next.isUser
    && prev.content === next.content
    && areChatImageAttachmentPropsEqual(prev.attachments, next.attachments)
    && prev.thoughtContent === next.thoughtContent
    && prev.errorMessage === next.errorMessage
    && prev.isStreaming === next.isStreaming
    && prev.messageState === next.messageState
    && prev.tokensPerSec === next.tokensPerSec
    && prev.inferenceMetrics === next.inferenceMetrics
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
      iconSize="sm"
      size="micro"
      tone={isDestructive ? 'danger' : 'neutral'}
      className="border-0"
      iconClassName={isDestructive ? 'text-error-500' : 'text-typography-500 dark:text-typography-300'}
    />
  );
}

const ChatMessageBubbleComponent = ({
  id,
  isUser,
  content,
  attachments,
  thoughtContent: explicitThoughtContent,
  errorMessage,
  isStreaming,
  messageState,
  tokensPerSec,
  inferenceMetrics,
  canDelete = false,
  canRegenerate = false,
  onDelete,
  onRegenerate,
  onLayout,
}: ChatMessageBubbleProps) => {
  const [copied, setCopied] = useState(false);
  const [isThoughtExpanded, setThoughtExpanded] = useState(false);
  const [attachmentPreviewUris, setAttachmentPreviewUris] = useState<Record<string, string | null>>({});
  const failedAttachmentPreviewUrisRef = useRef<Record<string, Set<string>>>({});
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const hasExplicitThoughtContent = explicitThoughtContent !== undefined;
  const assistantPresentation = isUser
    ? null
    : hasExplicitThoughtContent
      ? null
      : getAssistantPresentation(content, {
          isStreaming: Boolean(isStreaming),
        });
  const isAssistantStreaming = !isUser && Boolean(isStreaming);
  const assistantMessageState = messageState
    ?? (isStreaming ? 'streaming' : errorMessage ? 'error' : 'complete');
  const thoughtContent = hasExplicitThoughtContent
    ? explicitThoughtContent ?? ''
    : assistantPresentation?.thoughtContent ?? '';
  const hasThought = hasExplicitThoughtContent
    ? thoughtContent.trim().length > 0
    : Boolean(assistantPresentation?.hasThought);
  const sanitizedExplicitAssistantContent = hasExplicitThoughtContent
    ? getAssistantPresentation(content).finalContent
    : content;
  const finalContent = hasExplicitThoughtContent
    ? sanitizedExplicitAssistantContent
    : assistantPresentation?.finalContent ?? content;
  const shouldAnimateThought = isAssistantStreaming && hasThought;
  const displayedTokensPerSecond = typeof inferenceMetrics?.predictedPerSecond === 'number'
    && Number.isFinite(inferenceMetrics.predictedPerSecond)
    ? inferenceMetrics.predictedPerSecond
    : tokensPerSec;
  const showPerformanceLabel =
    !isUser &&
    typeof displayedTokensPerSecond === 'number' &&
    Number.isFinite(displayedTokensPerSecond);
  const showInferenceTelemetry = !isUser && inferenceMetrics !== undefined;
  const mtpTelemetryLabel = (() => {
    const mtp = inferenceMetrics?.mtp;
    if (!mtp) {
      return null;
    }

    if (!mtp.requested) {
      return t('chat.inferenceMetrics.mtpOff');
    }

    if (mtp.fallbackUsed || mtp.fallbackReason) {
      return t('chat.inferenceMetrics.mtpFallback');
    }

    if (!mtp.attempted) {
      return t('chat.inferenceMetrics.mtpNotUsed');
    }

    const acceptancePercent = typeof mtp.acceptanceRate === 'number'
      ? Math.round(mtp.acceptanceRate * 100)
      : 0;
    return t('chat.inferenceMetrics.mtpAccepted', {
      accepted: mtp.draftTokensAccepted,
      drafted: mtp.draftTokens,
      percent: acceptancePercent,
    });
  })();
  const copyableContent = isUser
    ? content
    : hasExplicitThoughtContent
      ? sanitizedExplicitAssistantContent
      : (assistantPresentation?.hasThought ? assistantPresentation.finalContent : content);
  const hasCopyableContent = copyableContent.trim().length > 0;
  const shouldShowActionRow = !isStreaming && (
    hasCopyableContent
    || (canRegenerate && Boolean(onRegenerate))
    || (canDelete && Boolean(onDelete))
  );
  const shouldShowMetadataRow = shouldShowActionRow || showPerformanceLabel || showInferenceTelemetry;

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
  // Chat bubbles keep asymmetric radii as a deliberate visual affordance between user and assistant turns.
  const bubbleClassName = isUser
    ? appearance.classNames.chatUserBubbleClassName
    : appearance.classNames.chatAssistantBubbleClassName;
  const shouldShowThoughtSection = !isUser && hasThought;
  const thoughtLabel = shouldAnimateThought ? t('chat.thinkingTitle') : t('chat.thoughtTitle');
  const thoughtDescription = shouldAnimateThought
    ? t('chat.thinkingDescription')
    : t('chat.thoughtDescription');
  const assistantBodyContent = isUser ? content : finalContent;
  const hasErrorMessage = !isUser && typeof errorMessage === 'string' && errorMessage.trim().length > 0;
  const shouldShowStreamingPlaceholder = isAssistantStreaming && !shouldShowThoughtSection && !assistantBodyContent;
  // Thought containers keep a minimum width so the collapsible panel does not jitter while content streams in.
  const thoughtBubbleClassName = appearance.classNames.chatThoughtBubbleClassName;
  const shouldUseGlassBubble = appearance.surfaceKind === 'glass';
  const shouldUseAssistantGlass = appearance.surfaceKind === 'glass' && !isUser;
  const userTextClassName = getThemeActionContentClassName(appearance, 'primary');
  const userAttachments = React.useMemo(
    () => (isUser ? attachments ?? [] : []),
    [attachments, isUser],
  );

  useEffect(() => {
    const nextAttachmentsById = new Map(userAttachments.map((attachment) => [attachment.id, attachment]));
    failedAttachmentPreviewUrisRef.current = Object.fromEntries(
      Object.entries(failedAttachmentPreviewUrisRef.current)
        .filter(([attachmentId]) => nextAttachmentsById.has(attachmentId)),
    );

    if (userAttachments.length === 0) {
      failedAttachmentPreviewUrisRef.current = {};
      setAttachmentPreviewUris((current) => (
        areAttachmentPreviewUriMapsEqual(current, {}) ? current : {}
      ));
      return;
    }

    setAttachmentPreviewUris((current) => {
      const nextPreviewUris: Record<string, string | null> = {};

      for (const [attachmentId, currentUri] of Object.entries(current)) {
        const attachment = nextAttachmentsById.get(attachmentId);
        if (!attachment) {
          continue;
        }

        const candidates = getAttachmentPreviewUriCandidates(attachment);
        const failedUris = failedAttachmentPreviewUrisRef.current[attachmentId];
        const nextPreviewUri = candidates.find((uri) => !failedUris?.has(uri)) ?? null;

        if (currentUri === null) {
          if (nextPreviewUri === null) {
            nextPreviewUris[attachmentId] = null;
          }
          continue;
        }

        nextPreviewUris[attachmentId] = nextPreviewUri;
      }

      return areAttachmentPreviewUriMapsEqual(current, nextPreviewUris) ? current : nextPreviewUris;
    });

  }, [userAttachments]);

  const handleAttachmentPreviewError = (attachment: ChatImageAttachment | ChatAttachment, attemptedUri: string) => {
    failedAttachmentPreviewUrisRef.current[attachment.id] ??= new Set<string>();
    failedAttachmentPreviewUrisRef.current[attachment.id].add(attemptedUri);

    const nextPreviewUri = getAttachmentPreviewUriCandidates(attachment)
      .find((previewUri) => !failedAttachmentPreviewUrisRef.current[attachment.id]?.has(previewUri)) ?? null;

    setAttachmentPreviewUris((current) => {
      const currentUri = current[attachment.id];
      if (currentUri !== undefined && currentUri !== attemptedUri) {
        return current;
      }

      return currentUri === nextPreviewUri ? current : { ...current, [attachment.id]: nextPreviewUri };
    });
  };

  return (
    <Box
      testID={isUser
        ? `user-message-state-${messageState}-${id}`
        : `assistant-message-state-${assistantMessageState}-${id}`}
      className={`w-full flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}
      onLayout={onLayout}
    >
      <Box className={`w-full flex-row ${isUser ? 'items-end justify-end pl-8' : 'items-start justify-start pr-8'}`}>
        <ScreenSurface
          testID={`message-bubble-shell-${id}`}
          tone={isUser ? 'primary' : 'default'}
          decorative="matte"
          applyGlassFrame={shouldUseGlassBubble}
          withControlTint={shouldUseGlassBubble && isUser}
          className={`max-w-full min-w-0 flex-shrink ${bubbleAlignmentClassName} ${bubbleClassName}`}
        >
          {shouldShowThoughtSection ? (
            <ScreenSurface
              tone="accent"
              decorative="matte"
              withControlTint={shouldUseAssistantGlass}
              className={`${assistantBodyContent ? 'mb-1.5 ' : ''}${thoughtBubbleClassName}`}
            >
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
                  <ScreenIconTile iconName="psychology-alt" tone="accent" size="sm" iconSize="sm" className="h-7 w-7 rounded-full">
                    {shouldAnimateThought ? (
                      <ThinkingPulse />
                    ) : (
                      <MaterialSymbols name="psychology-alt" size="sm" className="text-primary-500" />
                    )}
                  </ScreenIconTile>

                  <Box className="min-w-0 flex-1">
                    <Text className="text-xs font-semibold text-typography-900 dark:text-typography-100">
                      {thoughtLabel}
                    </Text>
                    <Text className="mt-0.5 text-xs leading-4 text-typography-500 dark:text-typography-400">
                      {thoughtDescription}
                    </Text>
                  </Box>

                  <MaterialSymbols
                    name={isThoughtExpanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                    size="sm"
                    className="text-typography-500 dark:text-typography-400"
                  />
                </Box>
              </Pressable>

              {isThoughtExpanded ? (
                <Box
                  testID={`thought-panel-${id}`}
                  className={`mt-1.5 border-t pt-1.5 ${appearance.classNames.dividerClassName}`}
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
            </ScreenSurface>
          ) : null}

          {isUser ? (
            <>
              {userAttachments.length > 0 ? (
                <Box
                  testID={`message-attachments-${id}`}
                  className={`${content ? 'mb-2 ' : ''}flex-row flex-wrap gap-1.5`}
                >
                  {userAttachments.map((attachment, index) => {
                    const attachmentLabelOptions = {
                      index: index + 1,
                      count: userAttachments.length,
                    };
                    if (!isImageMessageAttachment(attachment) && 'kind' in attachment) {
                      return (
                        <ScreenSurface
                          key={attachment.id}
                          testID={`message-attachment-${attachment.kind}-${id}-${attachment.id}`}
                          tone="default"
                          decorative="matte"
                          accessible
                          accessibilityRole="summary"
                          accessibilityLabel={t('chat.attachments.messageFileIndexedAccessibilityLabel', {
                            ...attachmentLabelOptions,
                            kind: getAttachmentLabel(attachment),
                            name: attachment.fileName,
                          })}
                          className="w-44 flex-row items-center gap-2 px-2.5 py-2"
                        >
                          <ScreenIconTile iconName={getAttachmentIconName(attachment)} tone="neutral" size="sm" iconSize="sm" className="h-8 w-8" />
                          <Box className="min-w-0 flex-1">
                            <Text numberOfLines={1} className="text-xs font-semibold text-typography-800 dark:text-typography-100">
                              {attachment.fileName}
                            </Text>
                            <Text numberOfLines={1} className="mt-0.5 text-xs leading-4 text-typography-500 dark:text-typography-300">
                              {getAttachmentLabel(attachment)}
                            </Text>
                          </Box>
                        </ScreenSurface>
                      );
                    }

                    const resolvedPreviewUri = attachmentPreviewUris[attachment.id];
                    const previewUri = resolvedPreviewUri ?? getAttachmentPreferredPreviewUri(attachment);
                    return resolvedPreviewUri !== null ? (
                      <Image
                        key={attachment.id}
                        testID={`message-attachment-image-${id}-${attachment.id}`}
                        source={{ uri: previewUri }}
                        onError={() => handleAttachmentPreviewError(attachment, previewUri)}
                        accessibilityLabel={t('chat.attachments.messagePreviewIndexedAccessibilityLabel', attachmentLabelOptions)}
                        resizeMode="cover"
                        className="h-[72px] w-[72px] rounded-lg"
                      />
                    ) : (
                      <ScreenSurface
                        key={attachment.id}
                        testID={`message-attachment-unavailable-${id}-${attachment.id}`}
                        tone="default"
                        decorative="matte"
                        accessible
                        accessibilityRole="image"
                        accessibilityLabel={t('chat.attachments.messageUnavailableIndexedAccessibilityLabel', attachmentLabelOptions)}
                        accessibilityState={{ disabled: true }}
                        className="w-36 flex-row items-center gap-1.5 px-2 py-1.5"
                      >
                        <MaterialSymbols name="broken-image" size="sm" className="text-typography-500 dark:text-typography-300" />
                        <Text className="min-w-0 flex-1 text-xs leading-4 text-typography-700 dark:text-typography-200">
                          {t('chat.attachments.unavailable')}
                        </Text>
                      </ScreenSurface>
                    );
                  })}
                </Box>
              ) : null}
              {content ? (
                <Text selectable className={`text-base leading-relaxed ${userTextClassName}`}>
                  {content}
                </Text>
              ) : null}
            </>
          ) : shouldShowStreamingPlaceholder ? (
            <StreamingCursor compact />
          ) : isStreaming && assistantBodyContent ? (
            <Text
              testID={`assistant-message-content-${id}`}
              className="text-base leading-relaxed text-typography-900 dark:text-typography-100"
            >
              {assistantBodyContent}
              <StreamingCursor />
            </Text>
          ) : assistantBodyContent ? (
            <Box testID={`assistant-message-content-${id}`}>
              <MarkdownRenderer content={assistantBodyContent} selectable />
            </Box>
          ) : null}

          {hasErrorMessage ? (
            <ScreenSurface tone="error" withControlTint className={`mt-2 flex-row items-start gap-2 px-2.5 py-2 ${appearance.classNames.chatInlineErrorClassName}`}>
              <MaterialSymbols name="error-outline" size="sm" className="mt-0.5 text-error-600 dark:text-error-300" />
              <Text selectable className="min-w-0 flex-1 text-sm leading-5 text-error-800 dark:text-error-200">
                {errorMessage}
              </Text>
            </ScreenSurface>
          ) : null}
        </ScreenSurface>
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
              className={appearance.classNames.chatMetadataBadgeClassName}
              textClassName="text-typography-600 dark:text-typography-300"
            >
              {displayedTokensPerSecond?.toFixed(1)} t/s
            </ScreenBadge>
          ) : null}
          {mtpTelemetryLabel ? (
            <ScreenBadge
              testID={`mtp-telemetry-${id}`}
              size="micro"
              className={appearance.classNames.chatMetadataBadgeClassName}
              textClassName="text-typography-600 dark:text-typography-300"
            >
              {mtpTelemetryLabel}
            </ScreenBadge>
          ) : null}
          {typeof inferenceMetrics?.timeToFirstTokenMs === 'number' ? (
            <ScreenBadge
              testID={`ttft-telemetry-${id}`}
              size="micro"
              className={appearance.classNames.chatMetadataBadgeClassName}
              textClassName="text-typography-600 dark:text-typography-300"
            >
              {t('chat.inferenceMetrics.ttft', {
                milliseconds: Math.round(inferenceMetrics.timeToFirstTokenMs),
              })}
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
