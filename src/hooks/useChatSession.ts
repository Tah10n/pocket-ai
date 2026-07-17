import { AppState, AppStateStatus } from 'react-native';
import { useCallback, useEffect, useRef } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { llmEngineService } from '../services/LLMEngineService';
import { performanceMonitor } from '../services/PerformanceMonitor';
import { GenerationParameters, getGenerationParametersForModel, getSettings } from '../services/SettingsStore';
import { presetManager } from '../services/PresetManager';
import { AppError, toAppError } from '../services/AppError';
import { EngineStatus } from '../types/models';
import { backgroundTaskService } from '../services/BackgroundTaskService';
import { notificationService } from '../services/NotificationService';
import { registry } from '../services/LocalStorageRegistry';
import {
  ChatMessage,
  ChatThread,
  LlmChatMessage,
  LlmContentPart,
  LlmInputAudioContentPart,
  LlmTextContentPart,
  DEFAULT_PRESET_SNAPSHOT,
  DEFAULT_SYSTEM_PROMPT,
  DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER,
  PresetSnapshot,
  createChatId,
  getThreadActiveModelId,
} from '../types/chat';
import type { ChatAttachment, ChatDocumentAttachmentDraft, ChatMediaAttachmentDraft } from '../types/attachments';
import type { AttachmentDraft, MultimodalReadinessState } from '../types/multimodal';
import { flushPendingChatPersistenceWrites, useChatStore } from '../store/chatStore';
import {
  DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS,
  buildInferenceWindowWithAccurateTokenCounts,
  createTruncationState,
  estimateLlmMessagesTokens,
  getThreadInferenceWindow,
  resolveThreadInferenceWindowOptions,
  type InferenceBudgetOptions,
} from '../utils/inferenceWindow';
import { getVisibleAssistantContent } from '../utils/chatPresentation';
import { resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../utils/modelReasoningCapabilities';
import { syncThreadParameters } from '../utils/chatThreadParameters';
import { PrivateStorageUnavailableError, getPrivateStorageHealthSnapshot, isPrivateStorageWritable } from '../services/storage';
import { useTruncationTracking } from './useTruncationTracking';
import {
  materializeAttachmentDraftsForMessage,
  materializeDocumentDraftsForProcessing,
  materializeMediaDraftsForMessage,
} from '../services/ChatAttachmentStorageService';
import {
  buildDocumentAttachmentTextPart,
  chatAttachmentProcessorRegistry,
  withProcessedDocumentAttachmentMetadata,
} from '../services/ChatAttachmentProcessorRegistry';
import { sanitizeMultimodalFailureReason } from '../utils/multimodalFailureReason';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  getChatImageAttachmentMediaPaths,
  getSendableDraftImageAttachments,
  normalizeChatAttachmentLocalUri,
  toAttachmentMediaPath,
  validateChatImageAttachmentLimit,
} from '../utils/chatImageAttachments';
import {
  getSendableDraftDocumentAttachments,
  getSendableDraftMediaAttachments,
  validateChatDocumentAttachmentLimit,
  validateChatMediaAttachmentLimit,
} from '../utils/chatAttachments';
import { getLlmContentPartSignatureEntry } from '../utils/llmContentPartSignature';

export { SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES } from '../utils/inferenceWindow';
const DEFAULT_CONTEXT_SIZE = 4096;
export const INITIAL_STREAM_PATCH_INTERVAL_MS = 80;
export const DEFAULT_STREAM_PATCH_INTERVAL_MS = 140;
export const LONG_STREAM_PATCH_INTERVAL_MS = 320;
export const LONG_STREAM_PATCH_TOKEN_THRESHOLD = 64;
export const LONG_STREAM_PATCH_CHAR_THRESHOLD = 1200;
const STREAM_BOUNDARY_PATTERN = /[.!?。！？](?:["')\]}]|[\s])*$/;
const ATTACHMENT_FILE_CHECK_CONCURRENCY = 8;
const ESTIMATED_MEDIA_PROMPT_TOKENS_PER_INPUT = 576;
const EXACT_MEDIA_PROMPT_RECOUNT_MARGIN_TOKENS_PER_INPUT = 1024;

type ProcessedDocumentAttachmentDraftsForInference = {
  attachments: Extract<ChatAttachment, { kind: 'document' }>[];
  contentParts: LlmTextContentPart[];
};

interface ActiveGenerationState {
  threadId: string;
  messageId: string;
  stopRequested: boolean;
  nativeCompletionStarted: boolean;
  flushPendingAssistantPatch?: () => void;
}

export type AppendUserMessageOptions = {
  attachmentDrafts?: readonly AttachmentDraft[];
  documentAttachmentDrafts?: readonly ChatDocumentAttachmentDraft[];
  mediaAttachmentDrafts?: readonly ChatMediaAttachmentDraft[];
  multimodalReadiness?: MultimodalReadinessState;
  onUserMessageAppended?: (message: ChatMessage) => void;
};

export type RegenerateUserMessageOptions = {
  multimodalReadiness?: MultimodalReadinessState;
};

const sharedGenerationState: { current: ActiveGenerationState | null } = {
  current: null,
};

function resolveReadyAttachmentDrafts({
  drafts,
  readiness,
  expectedModelId,
}: {
  drafts: readonly AttachmentDraft[];
  readiness?: MultimodalReadinessState;
  expectedModelId?: string | null;
}): AttachmentDraft[] {
  if (drafts.length === 0) {
    return [];
  }

  const nonFailedDrafts = drafts.filter((draft) => draft.copyStatus !== 'failed');
  if (nonFailedDrafts.length === 0) {
    return [];
  }

  const limit = validateChatImageAttachmentLimit(0, nonFailedDrafts.length);
  if (!limit.ok) {
    throw new AppError('chat_attachment_limit_exceeded', 'Too many image attachments.');
  }

  const sendableDrafts = getSendableDraftImageAttachments(nonFailedDrafts);
  if (
    sendableDrafts.length !== nonFailedDrafts.length
    || sendableDrafts.some((draft) => draft.copyStatus !== 'copied')
  ) {
    throw new AppError('chat_attachment_not_ready', 'Image attachments are not ready to send.');
  }

  if (!isVisionReady(readiness, expectedModelId)) {
    throw new AppError('multimodal_not_ready', 'Vision chat is not ready for image attachments.', {
      details: {
        readinessStatus: readiness?.status ?? 'unknown',
        readinessModelId: readiness?.modelId,
        expectedModelId: expectedModelId ?? undefined,
        attachmentCount: sendableDrafts.length,
      },
    });
  }

  return sendableDrafts;
}

function resolveReadyDocumentAttachmentDrafts(
  drafts: readonly ChatDocumentAttachmentDraft[],
): ChatDocumentAttachmentDraft[] {
  if (drafts.length === 0) {
    return [];
  }

  const nonFailedDrafts = drafts.filter((draft) => draft.copyStatus !== 'failed');
  if (nonFailedDrafts.length === 0) {
    return [];
  }

  const limit = validateChatDocumentAttachmentLimit(0, nonFailedDrafts.length);
  if (!limit.ok) {
    throw new AppError('chat_attachment_limit_exceeded', 'Too many document attachments.');
  }

  const sendableDrafts = getSendableDraftDocumentAttachments(nonFailedDrafts);
  if (
    sendableDrafts.length !== nonFailedDrafts.length
    || sendableDrafts.some((draft) => draft.copyStatus !== 'copied')
  ) {
    throw new AppError('chat_attachment_not_ready', 'Document attachments are not ready to send.');
  }

  return sendableDrafts;
}

function resolveReadyMediaAttachmentDrafts({
  drafts,
  readiness,
  expectedModelId,
}: {
  drafts: readonly ChatMediaAttachmentDraft[];
  readiness?: MultimodalReadinessState;
  expectedModelId?: string | null;
}): ChatMediaAttachmentDraft[] {
  if (drafts.length === 0) {
    return [];
  }

  const nonFailedDrafts = drafts.filter((draft) => draft.copyStatus !== 'failed');
  if (nonFailedDrafts.length === 0) {
    return [];
  }

  const audioCount = nonFailedDrafts.filter((draft) => draft.kind === 'audio').length;
  const audioLimit = validateChatMediaAttachmentLimit('audio', 0, audioCount);
  if (!audioLimit.ok) {
    throw new AppError('chat_attachment_limit_exceeded', 'Too many media attachments.');
  }

  const sendableDrafts = getSendableDraftMediaAttachments(nonFailedDrafts);
  if (
    sendableDrafts.length !== nonFailedDrafts.length
    || sendableDrafts.some((draft) => draft.copyStatus !== 'copied')
  ) {
    throw new AppError('chat_attachment_not_ready', 'Media attachments are not ready to send.');
  }

  if (sendableDrafts.some((draft) => draft.kind === 'audio')) {
    if (
      readiness?.status !== 'ready'
      || !readiness.support.includes('audio')
      || (expectedModelId && readiness.modelId !== expectedModelId)
    ) {
      throw new AppError('multimodal_not_ready', 'Audio chat is not ready for audio attachments.', {
        details: {
          readinessStatus: readiness?.status ?? 'unknown',
          readinessModelId: readiness?.modelId,
          expectedModelId: expectedModelId ?? undefined,
          attachmentKind: 'audio',
        },
      });
    }
  }

  return sendableDrafts;
}

async function processDocumentAttachmentDraftsForInference(
  drafts: readonly ChatDocumentAttachmentDraft[],
): Promise<ProcessedDocumentAttachmentDraftsForInference> {
  if (drafts.length === 0) {
    return { attachments: [], contentParts: [] };
  }

  const processingAttachments = materializeDocumentDraftsForProcessing({
    threadId: 'pending',
    messageId: 'pending',
    drafts,
  });
  const results = await mapWithConcurrency(
    processingAttachments,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    async (attachment: Extract<ChatAttachment, { kind: 'document' }>) => {
      const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(attachment);
      return {
        attachment: withProcessedDocumentAttachmentMetadata(attachment, result),
        contentPart: buildDocumentAttachmentTextPart(result),
      };
    },
  );

  return {
    attachments: results.map((result) => result.attachment),
    contentParts: results.map((result) => result.contentPart),
  };
}

function assertActiveMultimodalReadyForAttachmentMediaPaths({
  mediaPaths,
  multimodalReadiness,
  expectedModelId,
  mediaPathOccurrenceCount = mediaPaths.length,
}: {
  mediaPaths: readonly string[];
  multimodalReadiness?: MultimodalReadinessState;
  expectedModelId?: string | null;
  mediaPathOccurrenceCount?: number;
}): MultimodalReadinessState | undefined {
  return llmEngineService.assertActiveMultimodalReadyForMediaPaths({
    mediaPaths,
    multimodalReadiness,
    expectedModelId,
    mediaPathOccurrenceCount,
  });
}

function getDraftImageAttachmentMediaPaths(drafts: readonly AttachmentDraft[]): string[] {
  return Array.from(new Set(drafts
    .map((draft) => normalizeChatAttachmentLocalUri(draft.localUri))
    .filter((localUri): localUri is string => localUri !== null)
    .map(toAttachmentMediaPath)
    .filter((mediaPath): mediaPath is string => mediaPath !== null)));
}

function getSanitizedErrorDetails(error: unknown): { errorName: string } | { errorType: string } {
  return error instanceof Error
    ? { errorName: error.name || 'Error' }
    : { errorType: typeof error };
}

function isMatchingGeneration(threadId: string, messageId: string) {
  return (
    sharedGenerationState.current?.threadId === threadId &&
    sharedGenerationState.current?.messageId === messageId
  );
}

function isNativeCompletionSettlingAfterStop() {
  const generation = sharedGenerationState.current;
  return generation?.stopRequested === true && generation.nativeCompletionStarted;
}

export function resolveAssistantStreamPatchInterval({
  tokensCount,
  visibleCharCount,
  thoughtCharCount,
}: {
  tokensCount: number;
  visibleCharCount: number;
  thoughtCharCount: number;
}) {
  if (tokensCount <= 8 && visibleCharCount + thoughtCharCount < 240) {
    return INITIAL_STREAM_PATCH_INTERVAL_MS;
  }

  if (
    tokensCount >= LONG_STREAM_PATCH_TOKEN_THRESHOLD ||
    visibleCharCount + thoughtCharCount >= LONG_STREAM_PATCH_CHAR_THRESHOLD
  ) {
    return LONG_STREAM_PATCH_INTERVAL_MS;
  }

  return DEFAULT_STREAM_PATCH_INTERVAL_MS;
}

export function shouldFlushAssistantStreamPatchOnBoundary(content: string) {
  return STREAM_BOUNDARY_PATTERN.test(content.trimEnd());
}

export function resetSharedGenerationStateForTests() {
  sharedGenerationState.current = null;
}

function ignorePrivateStorageUnavailableDuringRuntimeStop(error: unknown, scope: string): boolean {
  if (error instanceof PrivateStorageUnavailableError) {
    console.warn(`[ChatSession] Skipped persisting ${scope} while private storage is blocked`, error);
    return true;
  }

  return false;
}

export async function stopActiveChatGenerationForPrivateStorageBlocked(): Promise<void> {
  const generation = sharedGenerationState.current;
  let deferredStateError: unknown = null;

  if (generation) {
    generation.stopRequested = true;

    try {
      generation.flushPendingAssistantPatch?.();
    } catch (error) {
      if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'pending assistant patch')) {
        deferredStateError = error;
      }
    }

    const chatState = useChatStore.getState();
    try {
      chatState.stopAssistantMessage(generation.threadId, generation.messageId);
    } catch (error) {
      if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'assistant stop state')) {
        throw error;
      }
    }

    try {
      chatState.finalizeThreadStatus(generation.threadId, 'stopped');
    } catch (error) {
      if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'thread stop state')) {
        throw error;
      }
    }
  }

  try {
    if (generation?.nativeCompletionStarted) {
      await llmEngineService.interruptActiveCompletion();
    } else {
      await llmEngineService.stopCompletion();
    }
  } finally {
    if (backgroundTaskService.isTaskActive('inference')) {
      await backgroundTaskService.stopBackgroundTask('inference');
    }
  }

  if (deferredStateError) {
    throw deferredStateError;
  }
}

function assertPrivateStorageWritableForChatMutation() {
  if (isPrivateStorageWritable()) {
    return;
  }

  throw new AppError('storage_private_unavailable', 'Private storage is unavailable.', {
    details: {
      privateStorageHealth: getPrivateStorageHealthSnapshot(),
    },
  });
}

function isFileSystemDirectory(info: { isDirectory?: boolean }): boolean {
  return info.isDirectory === true;
}

function resolvePersistedAssistantErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown chat generation error';
  return sanitizeMultimodalFailureReason(message) ?? message;
}

function resolveUserFacingGenerationError(error: unknown, message: string): AppError {
  const appError = toAppError(error);
  return new AppError(appError.code, message);
}

function findLatestUserMessageIdBeforeAssistant(thread: ChatThread, assistantMessageId: string): string | null {
  const assistantIndex = thread.messages.findIndex((message) => message.id === assistantMessageId);
  const startIndex = assistantIndex >= 0 ? assistantIndex - 1 : thread.messages.length - 1;

  for (let index = startIndex; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message.role === 'user' && (message.kind ?? 'message') === 'message') {
      return message.id;
    }
  }

  return null;
}

async function doesChatAttachmentFileExist(localUri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(localUri);
    return info.exists === true && !isFileSystemDirectory(info);
  } catch {
    return false;
  }
}

function isVisionReady(readiness?: MultimodalReadinessState, expectedModelId?: string | null): boolean {
  return readiness?.status === 'ready'
    && readiness.support.includes('vision')
    && (!expectedModelId || readiness.modelId === expectedModelId);
}

function isAudioReady(readiness?: MultimodalReadinessState, expectedModelId?: string | null): boolean {
  return readiness?.status === 'ready'
    && readiness.support.includes('audio')
    && (!expectedModelId || readiness.modelId === expectedModelId);
}

function messageHasAttachments(message: ChatMessage | undefined): boolean {
  return (message?.attachments?.length ?? 0) > 0;
}

function isGenericChatAttachment(
  attachment: NonNullable<ChatMessage['attachments']>[number],
): attachment is ChatAttachment {
  return 'kind' in attachment;
}

function isInferenceAudioAttachment(
  attachment: NonNullable<ChatMessage['attachments']>[number],
): attachment is Extract<ChatAttachment, { kind: 'audio' }> {
  return isGenericChatAttachment(attachment)
    && attachment.kind === 'audio'
    && attachment.state === 'ready';
}

function getAudioAttachmentMediaPath(
  attachment: NonNullable<ChatMessage['attachments']>[number],
): string | null {
  if (!isInferenceAudioAttachment(attachment)) {
    return null;
  }

  const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
  return localUri ? toAttachmentMediaPath(localUri) : null;
}

function getAudioContentPartsFromAttachments(
  attachments: ChatMessage['attachments'] | undefined,
): LlmInputAudioContentPart[] {
  return (attachments ?? []).flatMap((attachment) => {
    if (!isInferenceAudioAttachment(attachment)) {
      return [];
    }

    const mediaPath = getAudioAttachmentMediaPath(attachment);
    if (!mediaPath) {
      return [];
    }

    return [{
      type: 'input_audio',
      input_audio: {
        format: attachment.audio.format,
        url: mediaPath,
      },
    }];
  });
}

function resolveLlmContentPartsForResolvedAttachments(
  message: LlmChatMessage,
  _originalAttachments: NonNullable<ChatMessage['attachments']>,
  resolvedAttachments: NonNullable<ChatMessage['attachments']>,
): LlmContentPart[] | undefined {
  const retainedContentParts = message.contentParts?.filter((part) => {
    return part.type !== 'input_audio';
  }) ?? [];
  const resolvedAudioContentParts = getAudioContentPartsFromAttachments(resolvedAttachments);
  const contentParts = [
    ...retainedContentParts,
    ...resolvedAudioContentParts,
  ];

  return contentParts.length > 0 ? contentParts : undefined;
}

function omitInputAudioContentParts(message: Pick<ChatMessage, 'contentParts'>): LlmContentPart[] | undefined {
  const retainedContentParts = message.contentParts?.filter((part) => part.type !== 'input_audio') ?? [];
  return retainedContentParts.length > 0 ? retainedContentParts : undefined;
}

function shouldRetainAttachmentForInference(
  attachment: NonNullable<ChatMessage['attachments']>[number],
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): boolean {
  if (!isGenericChatAttachment(attachment)) {
    return isVisionReady(readiness, expectedModelId);
  }

  switch (attachment.kind) {
    case 'audio':
      return isAudioReady(readiness, expectedModelId);
    case 'document':
      return true;
    case 'image':
      return isVisionReady(readiness, expectedModelId);
    case 'video':
    default:
      return false;
  }
}

function omitLlmInferenceAttachments(message: LlmChatMessage): LlmChatMessage {
  if (!message.attachments?.length && !message.mediaPaths?.length && !message.contentParts?.length) {
    return message;
  }

  const {
    attachments: _attachments,
    mediaPaths: _mediaPaths,
    ...messageWithoutAttachments
  } = message;
  const retainedContentParts = message.contentParts?.filter((part) => part.type === 'text') ?? [];
  return {
    ...messageWithoutAttachments,
    ...(retainedContentParts.length > 0 ? { contentParts: retainedContentParts } : null),
  };
}

function resolveLlmMessageSupportedInferenceContent(
  message: LlmChatMessage,
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): LlmChatMessage {
  const attachments = message.attachments;
  if (!attachments?.length) {
    if (!message.contentParts?.some((part) => part.type === 'input_audio')) {
      return message;
    }

    const {
      contentParts: _contentParts,
      ...messageWithoutContentParts
    } = message;
    const contentParts = omitInputAudioContentParts(message);
    return {
      ...messageWithoutContentParts,
      ...(contentParts && contentParts.length > 0 ? { contentParts } : null),
    };
  }

  const retainedAttachments = attachments.filter((attachment) => (
    shouldRetainAttachmentForInference(attachment, readiness, expectedModelId)
  ));
  const mediaPaths = getChatImageAttachmentMediaPaths(retainedAttachments);
  const contentParts = resolveLlmContentPartsForResolvedAttachments(message, attachments, retainedAttachments);
  const {
    attachments: _attachments,
    mediaPaths: _mediaPaths,
    contentParts: _contentParts,
    ...messageWithoutInferenceContent
  } = message;

  return {
    ...messageWithoutInferenceContent,
    ...(retainedAttachments.length > 0 ? { attachments: retainedAttachments } : null),
    ...(mediaPaths.length > 0 ? { mediaPaths } : null),
    ...(contentParts && contentParts.length > 0 ? { contentParts } : null),
  };
}

function normalizeLlmInferenceMediaPaths(paths: readonly string[] | undefined): string[] {
  if (!paths?.length) {
    return [];
  }

  return Array.from(new Set(paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)));
}

function getLlmInferenceMessageMediaPaths(message: LlmChatMessage): string[] {
  return normalizeLlmInferenceMediaPaths([
    ...(message.mediaPaths ?? []),
    ...(message.contentParts
      ?.filter((part) => part.type === 'image_url')
      .map((part) => part.image_url.url) ?? []),
    ...getChatImageAttachmentMediaPaths(message.attachments),
  ]);
}

function getInferenceImageAttachmentCount(attachments: ChatMessage['attachments'] | undefined): number {
  return getChatImageAttachmentMediaPaths(attachments).length;
}

function getLlmInferenceMessagesMediaPaths(messages: readonly LlmChatMessage[]): string[] {
  return normalizeLlmInferenceMediaPaths(messages.flatMap(getLlmInferenceMessageMediaPaths));
}

function estimateLlmInferenceMediaPromptTokens(messages: readonly LlmChatMessage[]): number {
  return getLlmInferenceMessagesMediaPaths(messages).length * ESTIMATED_MEDIA_PROMPT_TOKENS_PER_INPUT;
}

function resolveExactMediaPromptRecountMarginTokens(messages: readonly LlmChatMessage[]): number {
  const mediaPathCount = getLlmInferenceMessagesMediaPaths(messages).length;
  if (mediaPathCount === 0) {
    return 0;
  }

  return Math.max(
    EXACT_MEDIA_PROMPT_RECOUNT_MARGIN_TOKENS_PER_INPUT,
    mediaPathCount * EXACT_MEDIA_PROMPT_RECOUNT_MARGIN_TOKENS_PER_INPUT,
  );
}

function getLlmInferenceMessageContentPartSignatureEntries(message: LlmChatMessage): string[] {
  return message.contentParts?.map(getLlmContentPartSignatureEntry) ?? [];
}

function getLlmInferenceMessageContentPartMediaCount(message: LlmChatMessage): number {
  return message.contentParts?.filter((part) => part.type !== 'text').length ?? 0;
}

function getLlmInferenceMessageContentPartTextCount(message: LlmChatMessage): number {
  return message.contentParts?.filter((part) => part.type === 'text' && part.text.trim().length > 0).length ?? 0;
}

function buildLlmInferenceMessagesSignature(messages: readonly LlmChatMessage[]): string {
  let hash = 2166136261;

  for (const message of messages) {
    hash = updateLlmInferenceSignatureHash(hash, message.role);
    hash = updateLlmInferenceSignatureHash(hash, '\u0000');
    hash = updateLlmInferenceSignatureHash(hash, String(message.content.length));
    hash = updateLlmInferenceSignatureHash(hash, '\u0001');
    hash = updateLlmInferenceSignatureHash(hash, message.content);
    hash = updateLlmInferenceSignatureHash(hash, '\u0002');
    const mediaPaths = getLlmInferenceMessageMediaPaths(message);
    hash = updateLlmInferenceSignatureHash(hash, String(mediaPaths.length));
    hash = updateLlmInferenceSignatureHash(hash, '\u0003');
    for (const mediaPath of mediaPaths) {
      hash = updateLlmInferenceSignatureHash(hash, mediaPath);
      hash = updateLlmInferenceSignatureHash(hash, '\u0004');
    }
    const contentPartEntries = getLlmInferenceMessageContentPartSignatureEntries(message);
    hash = updateLlmInferenceSignatureHash(hash, String(contentPartEntries.length));
    hash = updateLlmInferenceSignatureHash(hash, '\u0005');
    for (const contentPartEntry of contentPartEntries) {
      hash = updateLlmInferenceSignatureHash(hash, contentPartEntry);
      hash = updateLlmInferenceSignatureHash(hash, '\u0006');
    }
  }

  return `${messages.length}:${hash.toString(36)}`;
}

function updateLlmInferenceSignatureHash(hash: number, value: string): number {
  let nextHash = hash >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    nextHash ^= value.charCodeAt(index);
    nextHash = Math.imul(nextHash, 16777619) >>> 0;
  }
  return nextHash;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

function throwMissingAttachments(
  messageId: string | undefined,
  attachments: readonly Pick<AttachmentDraft, 'id' | 'pathCategory'>[],
): never {
  const attachmentIds = attachments
    .map((attachment) => attachment.id)
    .filter((attachmentId): attachmentId is string => typeof attachmentId === 'string' && attachmentId.length > 0);
  const pathCategories = Array.from(new Set(attachments.map((attachment) => attachment.pathCategory)));
  throw new AppError(
    'chat_attachment_missing',
    'One or more selected attachments are no longer available. Remove the missing attachment and try again.',
    {
      details: {
        ...(messageId ? { messageId } : null),
        ...(attachmentIds.length === 1 ? { attachmentId: attachmentIds[0] } : null),
        attachmentIds,
        ...(pathCategories.length === 1 ? { pathCategory: pathCategories[0] } : null),
        pathCategories,
      },
    },
  );
}

async function assertDraftAttachmentFilesExist(drafts: readonly AttachmentDraft[]): Promise<void> {
  if (drafts.length === 0) {
    return;
  }

  const attachmentChecks = await mapWithConcurrency(
    drafts,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    async (draft) => {
      const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
      return {
        draft,
        localUri,
        exists: localUri ? await doesChatAttachmentFileExist(localUri) : false,
      };
    },
  );

  const missingDrafts = attachmentChecks
    .filter(({ localUri, exists }) => !localUri || !exists)
    .map(({ draft }) => ({
      id: draft.id,
      pathCategory: draft.pathCategory,
    }));

  if (missingDrafts.length > 0) {
    throwMissingAttachments(undefined, missingDrafts);
  }
}

async function assertMediaDraftAttachmentFilesExist(drafts: readonly ChatMediaAttachmentDraft[]): Promise<void> {
  if (drafts.length === 0) {
    return;
  }

  const fileDrafts = drafts.map((draft) => ({
    id: draft.id,
    pathCategory: draft.pathCategory,
    localUri: draft.localUri,
  }));
  const attachmentChecks = await mapWithConcurrency(
    fileDrafts,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    async (draft) => {
      const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
      return {
        draft,
        localUri,
        exists: localUri ? await doesChatAttachmentFileExist(localUri) : false,
      };
    },
  );

  const missingDrafts = attachmentChecks
    .filter(({ localUri, exists }) => !localUri || !exists)
    .map(({ draft }) => ({
      id: draft.id,
      pathCategory: draft.pathCategory,
    }));

  if (missingDrafts.length > 0) {
    throwMissingAttachments(undefined, missingDrafts);
  }
}

async function assertMessageAttachmentFilesExist(message: ChatMessage): Promise<void> {
  const attachments = message.attachments;
  if (!attachments?.length) {
    return;
  }

  const attachmentChecks = await mapWithConcurrency(
    attachments,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    async (attachment) => {
      const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
      return {
        attachment,
        localUri,
        exists: localUri ? await doesChatAttachmentFileExist(localUri) : false,
      };
    },
  );

  const missingAttachments = attachmentChecks
    .filter(({ localUri, exists }) => !localUri || !exists)
    .map(({ attachment }) => ({
      id: attachment.id,
      pathCategory: attachment.pathCategory,
    }));

  if (missingAttachments.length > 0) {
    throwMissingAttachments(message.id, missingAttachments);
  }
}

function withResolvedChatMessageInferenceContent(
  message: ChatMessage,
  attachments: NonNullable<ChatMessage['attachments']> | undefined,
): ChatMessage {
  const contentParts = omitInputAudioContentParts(message);
  const {
    attachments: _attachments,
    contentParts: _contentParts,
    ...messageWithoutInferenceContent
  } = message;

  return {
    ...messageWithoutInferenceContent,
    ...(attachments && attachments.length > 0 ? { attachments } : null),
    ...(contentParts && contentParts.length > 0 ? { contentParts } : null),
  };
}

function omitUnsupportedChatMessageInferenceAttachments(
  message: ChatMessage,
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): ChatMessage {
  const attachments = message.attachments;
  const hasInputAudioContentParts = message.contentParts?.some((part) => part.type === 'input_audio') === true;
  if (!attachments?.length) {
    return hasInputAudioContentParts
      ? withResolvedChatMessageInferenceContent(message, undefined)
      : message;
  }

  const retainedAttachments = attachments.filter((attachment) => (
    shouldRetainAttachmentForInference(attachment, readiness, expectedModelId)
  ));
  if (retainedAttachments.length === attachments.length && !hasInputAudioContentParts) {
    return message;
  }

  return withResolvedChatMessageInferenceContent(message, retainedAttachments);
}

function stripUnsupportedThreadInferenceAttachments(
  thread: ChatThread,
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): ChatThread {
  if (!thread.messages.some((message) => message.attachments?.length || message.contentParts?.some((part) => part.type === 'input_audio'))) {
    return thread;
  }

  return {
    ...thread,
    messages: thread.messages.map((message) => omitUnsupportedChatMessageInferenceAttachments(
      message,
      readiness,
      expectedModelId,
    )),
  };
}

async function resolveChatMessageAudioAttachmentsForInference(
  message: ChatMessage,
  isLatestUserMessage: boolean,
  latestUserMessageId?: string | null,
  resolveAttachmentExists: (localUri: string) => Promise<boolean> = doesChatAttachmentFileExist,
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): Promise<ChatMessage> {
  const attachments = message.attachments;
  const hasInputAudioContentParts = message.contentParts?.some((part) => part.type === 'input_audio') === true;
  if (!attachments?.length) {
    return hasInputAudioContentParts
      ? withResolvedChatMessageInferenceContent(message, undefined)
      : message;
  }

  const nextAttachments: NonNullable<ChatMessage['attachments']> = [];
  let didInspectAudioAttachments = false;
  for (const attachment of attachments) {
    if (!isGenericChatAttachment(attachment) || attachment.kind !== 'audio') {
      nextAttachments.push(attachment);
      continue;
    }

    didInspectAudioAttachments = true;
    const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
    const exists = localUri ? await resolveAttachmentExists(localUri) : false;
    if (!localUri || !exists) {
      if (isLatestUserMessage) {
        throwMissingAttachments(latestUserMessageId ?? undefined, [attachment]);
      }
      continue;
    }

    const resolvedAttachment = localUri !== attachment.localUri
      ? { ...attachment, localUri }
      : attachment;
    if (!shouldRetainAttachmentForInference(resolvedAttachment, readiness, expectedModelId)) {
      continue;
    }

    nextAttachments.push(resolvedAttachment);
  }

  return didInspectAudioAttachments || hasInputAudioContentParts
    ? withResolvedChatMessageInferenceContent(message, nextAttachments)
    : message;
}

async function assertUserMessageAttachmentsReadyForRegeneration(
  message: ChatMessage,
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): Promise<MultimodalReadinessState | undefined> {
  if (!messageHasAttachments(message)) {
    return readiness;
  }

  const unsupportedVideoCount = message.attachments?.filter((attachment) => (
    isGenericChatAttachment(attachment) && attachment.kind === 'video'
  )).length ?? 0;
  if (unsupportedVideoCount > 0) {
    throw new AppError(
      'chat_attachment_unsupported_type',
      'Video attachments cannot be regenerated because video input is disabled.',
      { details: { attachmentKind: 'video', attachmentCount: unsupportedVideoCount } },
    );
  }

  assertMultimodalReadyForInferenceAttachments([message], readiness, expectedModelId);
  assertAudioReadyForInferenceAttachments([message], readiness, expectedModelId);
  const attachments = message.attachments ?? [];
  const mediaPaths = getChatImageAttachmentMediaPaths(attachments);
  if (mediaPaths.length === 0) {
    await assertMessageAttachmentFilesExist(message);
    return readiness;
  }

  const latestReadiness = assertActiveMultimodalReadyForAttachmentMediaPaths({
    mediaPaths,
    multimodalReadiness: readiness,
    expectedModelId,
    mediaPathOccurrenceCount: mediaPaths.length,
  });
  await assertMessageAttachmentFilesExist(message);
  return latestReadiness;
}

async function resolveLlmMessageAttachmentsForInference(
  message: LlmChatMessage,
  isLatestUserMessage: boolean,
  latestUserMessageId?: string | null,
  resolveAttachmentExists: (localUri: string) => Promise<boolean> = doesChatAttachmentFileExist,
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): Promise<LlmChatMessage> {
  const attachments = message.attachments;
  if (!attachments?.length) {
    if (!message.contentParts?.some((part) => part.type === 'input_audio')) {
      return message;
    }

    const {
      contentParts: _contentParts,
      ...messageWithoutContentParts
    } = message;
    const contentParts = omitInputAudioContentParts(message);
    return {
      ...messageWithoutContentParts,
      ...(contentParts && contentParts.length > 0 ? { contentParts } : null),
    };
  }

  let didChangeAttachments = false;
  const attachmentChecks = await mapWithConcurrency(
    attachments,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    async (attachment) => {
      const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
      return {
        attachment,
        localUri,
        exists: localUri ? await resolveAttachmentExists(localUri) : false,
      };
    },
  );

  const nextAttachments: NonNullable<ChatMessage['attachments']> = [];
  for (const { attachment, localUri, exists } of attachmentChecks) {
    if (!localUri || !exists) {
      didChangeAttachments = true;
      if (isLatestUserMessage) {
        throwMissingAttachments(latestUserMessageId ?? undefined, [attachment]);
      }
      continue;
    }

    const resolvedAttachment = localUri !== attachment.localUri
      ? { ...attachment, localUri }
      : attachment;
    if (!shouldRetainAttachmentForInference(resolvedAttachment, readiness, expectedModelId)) {
      didChangeAttachments = true;
      continue;
    }

    if (resolvedAttachment !== attachment) {
      didChangeAttachments = true;
    }
    nextAttachments.push(resolvedAttachment);
  }

  if (!didChangeAttachments && nextAttachments.length === attachments.length) {
    return message;
  }

  const mediaPaths = getChatImageAttachmentMediaPaths(nextAttachments);

  return {
    ...message,
    attachments: nextAttachments.length > 0 ? nextAttachments : undefined,
    mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    contentParts: resolveLlmContentPartsForResolvedAttachments(message, attachments, nextAttachments),
  };
}

function getLatestUserLlmMessageIndex(messages: readonly LlmChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }

  return -1;
}

function hasLlmMessageInferenceContent(message: LlmChatMessage): boolean {
  return message.role === 'system'
    || message.content.trim().length > 0
    || getLlmInferenceMessageContentPartTextCount(message) > 0
    || (message.mediaPaths?.length ?? 0) > 0
    || getLlmInferenceMessageContentPartMediaCount(message) > 0
    || getChatImageAttachmentMediaPaths(message.attachments).length > 0;
}

function filterEmptyLlmInferenceMessages(messages: readonly LlmChatMessage[]): LlmChatMessage[] {
  return messages.filter(hasLlmMessageInferenceContent);
}

function normalizeLlmInferenceMessagePairs(messages: readonly LlmChatMessage[]): LlmChatMessage[] {
  const normalized: LlmChatMessage[] = [];
  let lastNonSystemRole: LlmChatMessage['role'] | null = null;

  messages.forEach((message) => {
    if (message.role === 'system') {
      normalized.push(message);
      return;
    }

    if (message.role === 'assistant' && lastNonSystemRole !== 'user') {
      return;
    }

    normalized.push(message);
    lastNonSystemRole = message.role;
  });

  return normalized;
}

function createChatAttachmentExistenceResolver(): (localUri: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();

  return (localUri: string) => {
    const existing = cache.get(localUri);
    if (existing) {
      return existing;
    }

    const result = doesChatAttachmentFileExist(localUri);
    cache.set(localUri, result);
    return result;
  };
}

async function resolveRetainedMessagesForInferenceAttachments(
  messages: readonly LlmChatMessage[],
  multimodalReadiness?: MultimodalReadinessState,
  latestUserMessageId?: string | null,
  resolveAttachmentExists: (localUri: string) => Promise<boolean> = doesChatAttachmentFileExist,
  expectedModelId?: string | null,
): Promise<LlmChatMessage[]> {
  const boundedMessages = constrainInferenceAttachmentsToRequestLimit(messages);
  if (!boundedMessages.some((message) => message.attachments?.length)) {
    assertAudioReadyForLlmMessages(boundedMessages, multimodalReadiness, expectedModelId);
    return normalizeLlmInferenceMessagePairs(filterEmptyLlmInferenceMessages(boundedMessages));
  }

  const latestUserMessageIndex = getLatestUserLlmMessageIndex(boundedMessages);
  const resolvedMessages = await mapWithConcurrency(
    boundedMessages,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    (message, index) => resolveLlmMessageAttachmentsForInference(
      message,
      index === latestUserMessageIndex,
      latestUserMessageId,
      resolveAttachmentExists,
      multimodalReadiness,
      expectedModelId,
    ),
  );

  assertMultimodalReadyForInferenceAttachments(resolvedMessages, multimodalReadiness, expectedModelId);
  assertAudioReadyForLlmMessages(resolvedMessages, multimodalReadiness, expectedModelId);
  return normalizeLlmInferenceMessagePairs(filterEmptyLlmInferenceMessages(resolvedMessages));
}

async function resolveLatestUserMessageAttachmentsForInference(
  message: ChatMessage | undefined,
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): Promise<void> {
  if (!message || !messageHasAttachments(message)) {
    return;
  }

  assertMultimodalReadyForInferenceAttachments([message], readiness, expectedModelId);
  assertAudioReadyForInferenceAttachments([message], readiness, expectedModelId);
  await assertMessageAttachmentFilesExist(message);
}

function assertMultimodalReadyForInferenceAttachments(
  messages: readonly Pick<ChatMessage, 'attachments'>[],
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): void {
  const attachmentCount = messages.reduce(
    (count, message) => count + getInferenceImageAttachmentCount(message.attachments),
    0,
  );

  if (attachmentCount === 0 || isVisionReady(readiness, expectedModelId)) {
    return;
  }

  throw new AppError('multimodal_not_ready', 'Vision chat is not ready for image attachments.', {
    details: {
      readinessStatus: readiness?.status ?? 'unknown',
      readinessModelId: readiness?.modelId,
      expectedModelId: expectedModelId ?? undefined,
      attachmentCount,
    },
  });
}

function getInferenceAudioAttachmentCount(attachments: ChatMessage['attachments'] | undefined): number {
  return attachments?.filter(isInferenceAudioAttachment).length ?? 0;
}

function getLlmInferenceAudioInputCount(message: Pick<LlmChatMessage, 'contentParts'>): number {
  return message.contentParts?.filter((part) => {
    if (part.type !== 'input_audio') {
      return false;
    }

    const url = part.input_audio.url?.trim() ?? '';
    const data = part.input_audio.data?.trim() ?? '';
    return url.length > 0 || data.length > 0;
  }).length ?? 0;
}

function assertAudioReadyForInferenceAttachments(
  messages: readonly Pick<ChatMessage, 'attachments'>[],
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): void {
  const attachmentCount = messages.reduce(
    (count, message) => count + getInferenceAudioAttachmentCount(message.attachments),
    0,
  );

  if (attachmentCount === 0 || isAudioReady(readiness, expectedModelId)) {
    return;
  }

  throw new AppError('multimodal_not_ready', 'Audio chat is not ready for audio attachments.', {
    details: {
      readinessStatus: readiness?.status ?? 'unknown',
      readinessModelId: readiness?.modelId,
      expectedModelId: expectedModelId ?? undefined,
      attachmentCount,
    },
  });
}

function assertAudioReadyForLlmMessages(
  messages: readonly Pick<LlmChatMessage, 'contentParts'>[],
  readiness?: MultimodalReadinessState,
  expectedModelId?: string | null,
): void {
  const audioInputCount = messages.reduce(
    (count, message) => count + getLlmInferenceAudioInputCount(message),
    0,
  );

  if (audioInputCount === 0 || isAudioReady(readiness, expectedModelId)) {
    return;
  }

  throw new AppError('multimodal_not_ready', 'Audio chat is not ready for audio attachments.', {
    details: {
      readinessStatus: readiness?.status ?? 'unknown',
      readinessModelId: readiness?.modelId,
      expectedModelId: expectedModelId ?? undefined,
      audioInputCount,
    },
  });
}

type InferenceAttachmentMessage = {
  attachments?: NonNullable<ChatMessage['attachments']>;
  mediaPaths?: string[];
};

function withConstrainedInferenceAttachments<T extends InferenceAttachmentMessage>(
  message: T,
  attachments: NonNullable<ChatMessage['attachments']> | undefined,
): T {
  const mediaPaths = getChatImageAttachmentMediaPaths(attachments);
  return {
    ...message,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    ...(message.mediaPaths ? { mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined } : null),
  };
}

function isInferenceImageAttachment(
  attachment: NonNullable<ChatMessage['attachments']>[number],
): boolean {
  return getChatImageAttachmentMediaPaths([attachment]).length > 0;
}

function constrainMessageAttachmentsToRemainingImageSlots(
  attachments: NonNullable<ChatMessage['attachments']>,
  remainingSlots: number,
): {
  attachments: NonNullable<ChatMessage['attachments']> | undefined;
  retainedImageCount: number;
  didConstrain: boolean;
} {
  if (remainingSlots <= 0) {
    const retained = attachments.filter((attachment) => !isInferenceImageAttachment(attachment));
    return {
      attachments: retained.length > 0 ? retained : undefined,
      retainedImageCount: 0,
      didConstrain: retained.length !== attachments.length,
    };
  }

  let retainedImageCount = 0;
  let didConstrain = false;
  const reversedRetained: NonNullable<ChatMessage['attachments']> = [];
  for (let index = attachments.length - 1; index >= 0; index -= 1) {
    const attachment = attachments[index];
    if (!isInferenceImageAttachment(attachment)) {
      reversedRetained.push(attachment);
      continue;
    }

    if (retainedImageCount < remainingSlots) {
      retainedImageCount += 1;
      reversedRetained.push(attachment);
    } else {
      didConstrain = true;
    }
  }

  const retained = reversedRetained.reverse();
  return {
    attachments: retained.length > 0 ? retained : undefined,
    retainedImageCount,
    didConstrain,
  };
}

function constrainInferenceAttachmentsToRequestLimit<T extends InferenceAttachmentMessage>(messages: readonly T[]): T[] {
  let retainedAttachmentCount = 0;
  let didConstrain = false;
  const nextMessages = [...messages];

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    const attachments = message.attachments;
    if (!attachments?.length) {
      continue;
    }

    const remainingSlots = MAX_CHAT_IMAGE_ATTACHMENTS - retainedAttachmentCount;
    const constrained = constrainMessageAttachmentsToRemainingImageSlots(attachments, remainingSlots);
    if (constrained.didConstrain) {
      didConstrain = true;
      nextMessages[index] = withConstrainedInferenceAttachments(message, constrained.attachments);
    }

    retainedAttachmentCount += constrained.retainedImageCount;
  }

  return didConstrain ? nextMessages : messages as T[];
}

async function resolveThreadForInferenceAttachments({
  thread,
  latestUserMessageId,
  multimodalReadiness,
  expectedModelId,
}: {
  thread: ChatThread;
  latestUserMessageId: string | null;
  multimodalReadiness?: MultimodalReadinessState;
  expectedModelId?: string | null;
}): Promise<ChatThread> {
  const latestUserMessage = latestUserMessageId
    ? thread.messages.find((message) => message.id === latestUserMessageId)
    : undefined;
  await resolveLatestUserMessageAttachmentsForInference(latestUserMessage, multimodalReadiness, expectedModelId);
  const readinessFilteredThread = stripUnsupportedThreadInferenceAttachments(
    thread,
    multimodalReadiness,
    expectedModelId,
  );
  const resolveAttachmentExists = createChatAttachmentExistenceResolver();
  const resolvedMessages = await mapWithConcurrency(
    readinessFilteredThread.messages,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    (message) => resolveChatMessageAudioAttachmentsForInference(
      message,
      Boolean(latestUserMessageId && message.id === latestUserMessageId),
      latestUserMessageId,
      resolveAttachmentExists,
      multimodalReadiness,
      expectedModelId,
    ),
  );

  return {
    ...readinessFilteredThread,
    messages: resolvedMessages,
  };
}

export function resolvePresetSnapshot(presetId: string | null): PresetSnapshot {
  if (!presetId) {
    return { ...DEFAULT_PRESET_SNAPSHOT };
  }

  const preset = presetManager.getPreset(presetId);
  if (!preset) {
    return {
      id: presetId,
      name: 'Missing Preset',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };
  }

  return {
    id: preset.id,
    name: preset.name,
    systemPrompt: preset.systemPrompt,
  };
}

function resolveThreadReasoningRuntimeConfig(thread: Pick<ChatThread, 'modelId' | 'activeModelId' | 'paramsSnapshot'>) {
  const activeModelId = getThreadActiveModelId(thread);
  const model = registry.getModel(activeModelId);
  const modelName = model?.name ?? activeModelId;
  const capability = resolveModelReasoningCapability(model, activeModelId, modelName);
  const runtimeConfig = resolveReasoningRuntimeConfig({
    reasoningEffort: thread.paramsSnapshot.reasoningEffort,
    capability,
    maxTokens: thread.paramsSnapshot.maxTokens,
  });

  return {
    activeModelId,
    model,
    modelName,
    capability,
    runtimeConfig,
  };
}

function resolveVisibleAssistantContentFromCandidates(
  fallback: string,
  ...candidates: (string | undefined)[]
) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const visibleContent = getVisibleAssistantContent(candidate);
    if (visibleContent.length > 0) {
      return visibleContent;
    }
  }

  return fallback;
}

export function buildInferenceMessagesForThread(thread: ChatThread, options?: InferenceBudgetOptions) {
  const { runtimeConfig } = resolveThreadReasoningRuntimeConfig(thread);

  return getThreadInferenceWindow(thread, resolveThreadInferenceWindowOptions(thread, {
    ...options,
    responseReserveTokens: options?.responseReserveTokens ?? runtimeConfig.responseReserveTokens,
  })).messages;
}

export function getThreadTruncationState(thread: ChatThread, options?: InferenceBudgetOptions) {
  const { runtimeConfig } = resolveThreadReasoningRuntimeConfig(thread);
  const { truncatedMessageIds } = getThreadInferenceWindow(thread, resolveThreadInferenceWindowOptions(thread, {
    ...options,
    responseReserveTokens: options?.responseReserveTokens ?? runtimeConfig.responseReserveTokens,
  }));

  return createTruncationState(truncatedMessageIds);
}

export const useChatSession = () => {
  const activeThread = useChatStore((state) => state.getActiveThread());
  const createThread = useChatStore((state) => state.createThread);
  const appendMessage = useChatStore((state) => state.appendMessage);
  const createAssistantPlaceholder = useChatStore((state) => state.createAssistantPlaceholder);
  const switchThreadModel = useChatStore((state) => state.switchThreadModel);
  const deleteMessageBranch = useChatStore((state) => state.deleteMessageBranch);
  const deleteThreadState = useChatStore((state) => state.deleteThread);
  const stopAssistantMessage = useChatStore((state) => state.stopAssistantMessage);
  const finalizeAssistantMessage = useChatStore((state) => state.finalizeAssistantMessage);
  const patchAssistantMessage = useChatStore((state) => state.patchAssistantMessage);
  const replaceBranchFromUserMessage = useChatStore((state) => state.replaceBranchFromUserMessage);
  const replaceLastAssistantMessage = useChatStore((state) => state.replaceLastAssistantMessage);
  const renameThreadState = useChatStore((state) => state.renameThread);
  const finalizeThreadStatus = useChatStore((state) => state.finalizeThreadStatus);
  const setActiveThread = useChatStore((state) => state.setActiveThread);
  const updateThreadParamsSnapshot = useChatStore((state) => state.updateThreadParamsSnapshot);

  const activeContextTokenBudget = (() => {
    if (!activeThread) {
      return undefined;
    }

    const engineState = llmEngineService.getState();
    if (engineState.status !== EngineStatus.READY) {
      return undefined;
    }

    return engineState.activeModelId === getThreadActiveModelId(activeThread)
      ? llmEngineService.getContextSize()
      : undefined;
  })();

  const truncationState = useTruncationTracking(activeThread, activeContextTokenBudget);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState ?? 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const previousAppState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (nextAppState === 'background' || nextAppState === 'inactive') {
        try {
          sharedGenerationState.current?.flushPendingAssistantPatch?.();
        } catch (error) {
          if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'background assistant patch')) {
            console.warn('[ChatSession] Failed to flush background assistant patch', error);
          }
        }
        try {
          flushPendingChatPersistenceWrites('background');
        } catch (error) {
          if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'background chat persistence')) {
            console.warn('[ChatSession] Failed to flush background chat persistence', error);
          }
        }
      }

      const returnedToForeground =
        (previousAppState === 'background' || previousAppState === 'inactive') &&
        nextAppState === 'active';

      if (!returnedToForeground) {
        return;
      }

      const state = useChatStore.getState();
      const activeThread = state.getActiveThread();

      // Recovery path: if the app returns with persisted "generating" state but
      // no live completion in flight, treat it as an interrupted session.
      if (activeThread?.status === 'generating' && !sharedGenerationState.current) {
        if (backgroundTaskService.isTaskActive('inference')) {
          return;
        }

        if (llmEngineService.hasActiveCompletion()) {
          return;
        }

        state.finalizeThreadStatus(activeThread.id, 'stopped');
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const runAssistantCompletion = useCallback(async (
    threadId: string,
    assistantMessageId: string,
    completionOptions: { multimodalReadiness?: MultimodalReadinessState } = {},
  ) => {
    const storedThread = useChatStore.getState().getThread(threadId);
    if (!storedThread) {
      throw new Error('Thread not found');
    }

    const latestUserMessageId = findLatestUserMessageIdBeforeAssistant(storedThread, assistantMessageId);
    let thread = storedThread;

    const modelId = getThreadActiveModelId(storedThread);

    performanceMonitor.mark('chat.send.start', { modelId });
    const generationSpan = performanceMonitor.startSpan('chat.generation', { modelId });

    const generationState: ActiveGenerationState = {
      threadId,
      messageId: assistantMessageId,
      stopRequested: false,
      nativeCompletionStarted: false,
    };
    sharedGenerationState.current = generationState;

    let currentText = '';
    let currentRawText = '';
    let currentThoughtText = '';
    let tokensCount = 0;
    let hasMarkedFirstToken = false;
    const startTime = Date.now();
    let flushTimeout: ReturnType<typeof setTimeout> | null = null;
    let scheduledFlushDelayMs: number | null = null;
    let unsubscribeExpiration: (() => void) | null = null;
    let sentBackgroundOutcomeNotification: 'interrupted' | 'error' | null = null;
    let hasFlushedFirstAssistantPatch = false;
    let lastFlushedVisibleContent = '';

    let needsVisibleRefresh = false;

    const refreshVisibleAssistantContent = () => {
      if (!needsVisibleRefresh) {
        return;
      }

      if (currentRawText.length === 0) {
        needsVisibleRefresh = false;
        return;
      }

      currentText = getVisibleAssistantContent(currentRawText, { isStreaming: true });
      needsVisibleRefresh = false;
    };

    const recordCompletionStats = (outcome: 'success' | 'stopped' | 'error') => {
      const elapsedSec = (Date.now() - startTime) / 1000;
      const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;

      const existingTokensPerSec = performanceMonitor.snapshot().counters['chat.tokensPerSec'] ?? 0;
      performanceMonitor.incrementCounter('chat.tokensPerSec', tokensPerSec - existingTokensPerSec);

      performanceMonitor.mark('chat.generation.outcome', {
        outcome,
        modelId,
        tokensCount,
        tokensPerSec,
      });

      generationSpan.end({ outcome, tokensCount, tokensPerSec });
    };

    const maxContextSize =
      typeof llmEngineService.getContextSize === 'function'
        ? llmEngineService.getContextSize()
        : DEFAULT_CONTEXT_SIZE;

    const canMutateAssistantMessage = (options?: { allowStopped?: boolean }) => (
      isMatchingGeneration(threadId, assistantMessageId)
      && (options?.allowStopped === true || !generationState.stopRequested)
    );

    const hasBufferedAssistantContent = () => (
      currentRawText.length > 0 ||
      currentText.length > 0 ||
      currentThoughtText.length > 0
    );

    const flushAssistantPatch = (options?: { allowStopped?: boolean; includeStreamingState?: boolean }) => {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
        scheduledFlushDelayMs = null;
      }

      if (!canMutateAssistantMessage(options)) {
        return;
      }

      refreshVisibleAssistantContent();

      const elapsedSec = (Date.now() - startTime) / 1000;
      const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;

      const updates: Partial<ChatMessage> = {
        content: currentText,
        thoughtContent: currentThoughtText || undefined,
        tokensPerSec,
      };

      if (options?.includeStreamingState !== false) {
        updates.state = 'streaming';
      }

      patchAssistantMessage(threadId, assistantMessageId, updates);
      if (hasBufferedAssistantContent()) {
        hasFlushedFirstAssistantPatch = true;
        lastFlushedVisibleContent = currentText || currentRawText;
      }
    };

    const scheduleAssistantPatch = (options?: { sentenceBoundary?: boolean }) => {
      if (!hasFlushedFirstAssistantPatch && hasBufferedAssistantContent()) {
        flushAssistantPatch();
        return;
      }

      if (options?.sentenceBoundary && hasBufferedAssistantContent()) {
        flushAssistantPatch();
        return;
      }

      const delayMs = resolveAssistantStreamPatchInterval({
        tokensCount,
        visibleCharCount: Math.max(currentText.length, currentRawText.length),
        thoughtCharCount: currentThoughtText.length,
      });

      if (flushTimeout) {
        if (scheduledFlushDelayMs != null && delayMs > scheduledFlushDelayMs) {
          clearTimeout(flushTimeout);
          flushTimeout = null;
          scheduledFlushDelayMs = null;
        } else {
          return;
        }
      }

      if (flushTimeout) {
        return;
      }

      scheduledFlushDelayMs = delayMs;
      flushTimeout = setTimeout(() => {
        flushTimeout = null;
        scheduledFlushDelayMs = null;
        flushAssistantPatch();
      }, delayMs);
    };

    generationState.flushPendingAssistantPatch = () => {
      flushAssistantPatch(generationState.stopRequested
        ? { allowStopped: true, includeStreamingState: false }
        : undefined);
    };

    const sendOutcomeNotificationOnce = (outcome: 'interrupted' | 'error') => {
      if (AppState.currentState === 'active') {
        return;
      }

      if (sentBackgroundOutcomeNotification === 'error') {
        return;
      }

      if (sentBackgroundOutcomeNotification === outcome) {
        return;
      }

      sentBackgroundOutcomeNotification = outcome;

      if (outcome === 'interrupted') {
        void notificationService.sendInterruptedNotification({ threadId });
        return;
      }

      void notificationService.sendInferenceErrorNotification({ threadId });
    };

    try {
      const {
        activeModelId,
        model,
        modelName,
        runtimeConfig: reasoningRuntimeConfig,
      } = resolveThreadReasoningRuntimeConfig(storedThread);
      const effectiveMultimodalReadiness = completionOptions.multimodalReadiness
        ?? model?.multimodalReadiness;

      await backgroundTaskService.startBackgroundInference(modelName);

      unsubscribeExpiration = backgroundTaskService.subscribeToExpiration(() => {
        if (!isMatchingGeneration(threadId, assistantMessageId)) {
          return;
        }

        try {
          flushAssistantPatch();
          stopAssistantMessage(threadId, assistantMessageId);
          finalizeThreadStatus(threadId, 'stopped');
          generationState.stopRequested = true;
          sendOutcomeNotificationOnce('interrupted');
        } finally {
          void (async () => {
            if (generationState.nativeCompletionStarted) {
              await llmEngineService.interruptActiveCompletion();
              return;
            }

            if (typeof llmEngineService.cancelActiveContextOperations === 'function') {
              const drainResult = await llmEngineService.cancelActiveContextOperations();
              if (drainResult === 'timed_out') {
                console.warn('[ChatSession] Timed out waiting for expired prompt preparation to stop');
              }
            }
            await llmEngineService.stopCompletion();
          })().catch((error) => {
            console.warn('[ChatSession] Failed to stop expired completion', error);
          });
        }
      });

      const windowOptions = resolveThreadInferenceWindowOptions(thread, {
        maxContextTokens: maxContextSize,
        responseReserveTokens: reasoningRuntimeConfig.responseReserveTokens,
      });

      thread = await resolveThreadForInferenceAttachments({
        thread: storedThread,
        latestUserMessageId,
        multimodalReadiness: effectiveMultimodalReadiness,
        expectedModelId: activeModelId,
      });

      const MESSAGE_TOO_LONG_ERROR_MESSAGE =
        'This message is too long for the current context window. Shorten it or increase the context size in Model Controls.';

      let forcedDisableThinking = false;
      let messages: LlmChatMessage[] = [];
      let promptTokens = 0;
      let promptSafetyMarginTokens = 0;
      const resolveAttachmentExistsForTokenCount = createChatAttachmentExistenceResolver();
      const exactPromptTokenCache = new Map<string, Promise<number>>();
      let selectedTokenCountParams = {
        enable_thinking: reasoningRuntimeConfig.enableThinking,
        reasoning_format: reasoningRuntimeConfig.reasoningFormat,
      };
      let didUseHeuristicPromptTokens = false;
      let didUseEstimatedMediaPromptTokens = false;

      const throwIfGenerationStopped = () => {
        if (generationState.stopRequested) {
          throw new Error('Generation was stopped before native completion started.');
        }
      };
      const buildPromptTokenCacheKey = (
        messagesToCount: LlmChatMessage[],
        params: { enable_thinking: boolean; reasoning_format: 'none' | 'auto' | 'deepseek' },
      ) => [
        params.enable_thinking ? 'thinking' : 'plain',
        params.reasoning_format,
        buildLlmInferenceMessagesSignature(messagesToCount),
      ].join('\u0001');
      const countExactPromptTokens = async (
        messagesToCount: LlmChatMessage[],
        params: { enable_thinking: boolean; reasoning_format: 'none' | 'auto' | 'deepseek' },
        options: { bypassCache?: boolean } = {},
      ) => {
        throwIfGenerationStopped();
        const sanitizedMessagesToCount = messagesToCount.map((message) => (
          resolveLlmMessageSupportedInferenceContent(message, effectiveMultimodalReadiness, activeModelId)
        ));
        const cacheKey = buildPromptTokenCacheKey(sanitizedMessagesToCount, params);
        let cachedCount = options.bypassCache ? undefined : exactPromptTokenCache.get(cacheKey);
        if (!cachedCount) {
          cachedCount = llmEngineService.countPromptTokens({
            messages: sanitizedMessagesToCount,
            params,
            multimodalReadiness: effectiveMultimodalReadiness,
            expectedModelId: activeModelId,
          }).catch((error) => {
            exactPromptTokenCache.delete(cacheKey);
            throw error;
          });
          exactPromptTokenCache.set(cacheKey, cachedCount);
        }

        const tokens = await cachedCount;
        throwIfGenerationStopped();
        return tokens;
      };

      const countResolvedPromptTokens = async (
        resolvedWindowMessages: LlmChatMessage[],
        params: { enable_thinking: boolean; reasoning_format: 'none' | 'auto' | 'deepseek' },
        options: { bypassCache?: boolean } = {},
      ) => {
        throwIfGenerationStopped();

        const mediaPaths = getLlmInferenceMessagesMediaPaths(resolvedWindowMessages);
        if (mediaPaths.length > 0) {
          const textOnlyMessages = resolvedWindowMessages.map(omitLlmInferenceAttachments);
          let textOnlyPromptTokens: number;
          try {
            textOnlyPromptTokens = await countExactPromptTokens(textOnlyMessages, params);
          } catch {
            return countExactPromptTokens(resolvedWindowMessages, params, options);
          }

          didUseEstimatedMediaPromptTokens = true;
          throwIfGenerationStopped();
          return textOnlyPromptTokens + estimateLlmInferenceMediaPromptTokens(resolvedWindowMessages);
        }

        return countExactPromptTokens(resolvedWindowMessages, params, options);
      };

      const countPromptTokens = async (
        windowMessages: LlmChatMessage[],
        params: { enable_thinking: boolean; reasoning_format: 'none' | 'auto' | 'deepseek' },
      ) => {
        throwIfGenerationStopped();
        const resolvedWindowMessages = await resolveRetainedMessagesForInferenceAttachments(
          windowMessages,
          effectiveMultimodalReadiness,
          latestUserMessageId,
          resolveAttachmentExistsForTokenCount,
          activeModelId,
        );
        throwIfGenerationStopped();

        return countResolvedPromptTokens(resolvedWindowMessages, params);
      };

      try {
        const tokenCountParams = {
          enable_thinking: reasoningRuntimeConfig.enableThinking,
          reasoning_format: reasoningRuntimeConfig.reasoningFormat,
        };
        selectedTokenCountParams = tokenCountParams;

        const result = await buildInferenceWindowWithAccurateTokenCounts(
          thread,
          windowOptions,
          async (windowMessages) => countPromptTokens(windowMessages, tokenCountParams),
          { throwIfCancelled: throwIfGenerationStopped },
        );
        messages = result.messages;
        promptTokens = result.promptTokens;
        promptSafetyMarginTokens = result.promptSafetyMarginTokens;
      } catch (error) {
        if (generationState.stopRequested) {
          throw error;
        }

        const appError = toAppError(error);

        if (appError.code === 'message_too_long' && reasoningRuntimeConfig.enableThinking) {
          forcedDisableThinking = true;

          const noThinkingWindowOptions = resolveThreadInferenceWindowOptions(thread, {
            maxContextTokens: maxContextSize,
            responseReserveTokens: Math.max(1, Math.round(thread.paramsSnapshot.maxTokens)),
          });
          const tokenCountParams = {
            enable_thinking: false,
            reasoning_format: 'none' as const,
          };
          selectedTokenCountParams = tokenCountParams;

          const result = await buildInferenceWindowWithAccurateTokenCounts(
            thread,
            noThinkingWindowOptions,
            async (windowMessages) => countPromptTokens(windowMessages, tokenCountParams),
            { throwIfCancelled: throwIfGenerationStopped },
          );
          messages = result.messages;
          promptTokens = result.promptTokens;
          promptSafetyMarginTokens = result.promptSafetyMarginTokens;
        } else if (appError.code === 'message_too_long') {
          throw appError;
        } else {
          console.warn('[ChatSession] Failed to count prompt tokens accurately, falling back to heuristics', {
            context: 'prompt_token_count_fallback',
            ...getSanitizedErrorDetails(error),
          });
          didUseHeuristicPromptTokens = true;
          messages = await resolveRetainedMessagesForInferenceAttachments(
            getThreadInferenceWindow(thread, windowOptions).messages,
            effectiveMultimodalReadiness,
            latestUserMessageId,
            resolveAttachmentExistsForTokenCount,
            activeModelId,
          );
          promptTokens = estimateLlmMessagesTokens(messages);
          promptSafetyMarginTokens = Math.max(
            0,
            Math.round(windowOptions.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
          );
        }
      }

      throwIfGenerationStopped();
      const tokenCountResolvedMessages = await resolveRetainedMessagesForInferenceAttachments(
        messages,
        effectiveMultimodalReadiness,
        latestUserMessageId,
        resolveAttachmentExistsForTokenCount,
        activeModelId,
      );
      throwIfGenerationStopped();
      const finalMessages = await resolveRetainedMessagesForInferenceAttachments(
        messages,
        effectiveMultimodalReadiness,
        latestUserMessageId,
        doesChatAttachmentFileExist,
        activeModelId,
      );
      throwIfGenerationStopped();
      const finalMessagesSignature = buildLlmInferenceMessagesSignature(finalMessages);
      const tokenCountResolvedMessagesSignature = buildLlmInferenceMessagesSignature(tokenCountResolvedMessages);
      const finalPromptTokenCacheKey = buildPromptTokenCacheKey(finalMessages, selectedTokenCountParams);
      const shouldRecountFinalPrompt = finalMessagesSignature !== tokenCountResolvedMessagesSignature;
      if (shouldRecountFinalPrompt) {
        if (didUseHeuristicPromptTokens) {
          promptTokens = estimateLlmMessagesTokens(finalMessages);
        } else {
          throwIfGenerationStopped();
          promptTokens = await countResolvedPromptTokens(finalMessages, selectedTokenCountParams, {
            bypassCache: finalMessagesSignature !== tokenCountResolvedMessagesSignature,
          });
          throwIfGenerationStopped();
        }
      }
      messages = finalMessages;

      const nonSystemMessages = messages.filter((message) => message.role !== 'system');
      const lastNonSystemRole = nonSystemMessages.length > 0
        ? nonSystemMessages[nonSystemMessages.length - 1]?.role
        : null;
      if (lastNonSystemRole !== 'user') {
        throw new AppError('message_too_long', MESSAGE_TOO_LONG_ERROR_MESSAGE);
      }

      let availablePredictTokens = maxContextSize - promptTokens - promptSafetyMarginTokens;
      if (
        !didUseHeuristicPromptTokens
        && didUseEstimatedMediaPromptTokens
        && getLlmInferenceMessagesMediaPaths(messages).length > 0
        && availablePredictTokens <= resolveExactMediaPromptRecountMarginTokens(messages)
        && !exactPromptTokenCache.has(finalPromptTokenCacheKey)
      ) {
        throwIfGenerationStopped();
        promptTokens = await countExactPromptTokens(messages, selectedTokenCountParams);
        throwIfGenerationStopped();
        availablePredictTokens = maxContextSize - promptTokens - promptSafetyMarginTokens;
      }

      if (availablePredictTokens <= 0) {
        throw new AppError('message_too_long', MESSAGE_TOO_LONG_ERROR_MESSAGE, {
          details: {
            maxContextSize,
            promptTokens,
            promptSafetyMarginTokens,
          },
        });
      }

      const maxPredictTokens = Math.max(
        1,
        maxContextSize - promptTokens - promptSafetyMarginTokens,
      );
      const visiblePredictTokens = Math.max(1, Math.round(thread.paramsSnapshot.maxTokens));
      const guaranteedVisibleTokens = Math.min(visiblePredictTokens, maxPredictTokens);
      const effectiveThinkingBudgetTokens = reasoningRuntimeConfig.enableThinking
        ? Math.max(0, Math.min(reasoningRuntimeConfig.thinkingBudgetTokens, maxPredictTokens - guaranteedVisibleTokens))
        : 0;
      const enableThinkingForRequest = !forcedDisableThinking && reasoningRuntimeConfig.enableThinking && effectiveThinkingBudgetTokens > 0;
      const reasoningFormatForRequest = enableThinkingForRequest
        ? reasoningRuntimeConfig.reasoningFormat
        : 'none';

      if (generationState.stopRequested) {
        if (isMatchingGeneration(threadId, assistantMessageId)) {
          flushAssistantPatch();
          stopAssistantMessage(threadId, assistantMessageId);
          finalizeThreadStatus(threadId, 'stopped');
          recordCompletionStats('stopped');

          sendOutcomeNotificationOnce('interrupted');
        }
        return;
      }

      if (llmEngineService.hasActiveCompletion() || isNativeCompletionSettlingAfterStop()) {
        throw new Error('Wait for the current response to finish stopping before starting another response.');
      }

      generationState.nativeCompletionStarted = true;
      const completion = await llmEngineService.chatCompletion({
        messages,
        multimodalReadiness: effectiveMultimodalReadiness,
        params: {
          temperature: thread.paramsSnapshot.temperature,
          top_p: thread.paramsSnapshot.topP,
          top_k: thread.paramsSnapshot.topK,
          min_p: thread.paramsSnapshot.minP,
          penalty_repeat: thread.paramsSnapshot.repetitionPenalty,
          n_predict: Math.max(
            1,
            guaranteedVisibleTokens + (enableThinkingForRequest ? effectiveThinkingBudgetTokens : 0),
          ),
          seed: thread.paramsSnapshot.seed ?? undefined,
          enable_thinking: enableThinkingForRequest,
          thinking_budget_tokens: enableThinkingForRequest
            ? effectiveThinkingBudgetTokens
            : undefined,
          reasoning_format: reasoningFormatForRequest,
        },
        onToken: (token) => {
          if (!canMutateAssistantMessage()) {
            return;
          }

          if (!hasMarkedFirstToken) {
            hasMarkedFirstToken = true;
            performanceMonitor.mark('chat.firstToken', { modelId });
          }

          if (typeof token === 'string') {
            if (currentRawText.length === 0 && currentText.length > 0) {
              currentRawText = currentText;
            }
            currentRawText += token;
            needsVisibleRefresh = true;
          } else {
            const hasReasoningUpdate = token.reasoningContent !== undefined;

            if (token.content !== undefined) {
              currentText = getVisibleAssistantContent(token.content);
              needsVisibleRefresh = false;
              if (typeof token.accumulatedText === 'string' && token.accumulatedText.length >= currentRawText.length) {
                currentRawText = token.accumulatedText;
              } else {
                currentRawText = token.content;
              }
            } else if (hasReasoningUpdate) {
              // When the engine is still producing reasoning (no parsed `content` yet), never derive
              // the visible assistant message from raw accumulated text. Some templates use non-<think>
              // markers (e.g. [THINK] or <|channel>thought) which would otherwise leak into the main bubble.
              if (typeof token.accumulatedText === 'string' && token.accumulatedText.length >= currentRawText.length) {
                currentRawText = token.accumulatedText;
              }
              needsVisibleRefresh = false;
            } else if (typeof token.accumulatedText === 'string' && token.accumulatedText.length >= currentRawText.length) {
              currentRawText = token.accumulatedText;
              needsVisibleRefresh = true;
            } else {
              if (currentRawText.length === 0 && currentText.length > 0) {
                currentRawText = currentText;
              }
              currentRawText += token.token;
              needsVisibleRefresh = true;
            }

            if (token.reasoningContent !== undefined) {
              const nextReasoning = token.reasoningContent;

              // `reasoningContent` may be streamed either as an accumulated buffer or as deltas.
              // Prefer treating it as accumulated when it prefixes the existing buffer.
              currentThoughtText = nextReasoning.startsWith(currentThoughtText)
                ? nextReasoning
                : (currentThoughtText + nextReasoning);
            }
          }

          tokensCount += 1;
          const boundaryCandidate = needsVisibleRefresh
            ? currentRawText
            : (currentText || currentRawText);
          scheduleAssistantPatch({
            sentenceBoundary:
              boundaryCandidate !== lastFlushedVisibleContent &&
              shouldFlushAssistantStreamPatchOnBoundary(boundaryCandidate),
          });
        },
      });

      if (generationState.stopRequested) {
        if (isMatchingGeneration(threadId, assistantMessageId)) {
          flushAssistantPatch({ allowStopped: true, includeStreamingState: false });
          stopAssistantMessage(threadId, assistantMessageId);
          finalizeThreadStatus(threadId, 'stopped');
          recordCompletionStats('stopped');

          sendOutcomeNotificationOnce('interrupted');
        }
        return;
      }

      flushAssistantPatch();
      const finalThoughtContent = completion.reasoning_content || currentThoughtText || undefined;
      const completionTelemetry = typeof llmEngineService.getLastCompletionTelemetry === 'function'
        ? llmEngineService.getLastCompletionTelemetry()
        : null;
      if (completionTelemetry) {
        patchAssistantMessage(threadId, assistantMessageId, {
          inferenceMetrics: completionTelemetry,
        });
      }
      finalizeAssistantMessage(
        threadId,
        assistantMessageId,
        resolveVisibleAssistantContentFromCandidates(
          '',
          completion.content,
          currentText,
          completion.text,
          currentRawText,
        ),
        finalThoughtContent,
      );
      finalizeThreadStatus(threadId, 'idle');
      recordCompletionStats('success');

      if (AppState.currentState !== 'active') {
        void notificationService.sendCompletionNotification('inference', { threadId });
      }
    } catch (error) {
      if (generationState.stopRequested) {
        if (isMatchingGeneration(threadId, assistantMessageId)) {
          flushAssistantPatch({ allowStopped: true, includeStreamingState: false });
          stopAssistantMessage(threadId, assistantMessageId);
          finalizeThreadStatus(threadId, 'stopped');
          recordCompletionStats('stopped');

          sendOutcomeNotificationOnce('interrupted');
        }
        return;
      }

      const message = resolvePersistedAssistantErrorMessage(error);
      const userFacingError = resolveUserFacingGenerationError(error, message);

      flushAssistantPatch();
      patchAssistantMessage(threadId, assistantMessageId, {
        content: currentText,
        thoughtContent: currentThoughtText || undefined,
        state: 'error',
        errorCode: 'generation_failed',
        errorMessage: message,
      });
      finalizeThreadStatus(threadId, 'error');
      recordCompletionStats('error');

      sendOutcomeNotificationOnce('error');
      throw userFacingError;
    } finally {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        scheduledFlushDelayMs = null;
      }

      unsubscribeExpiration?.();
      unsubscribeExpiration = null;

      const wasCurrentGeneration = isMatchingGeneration(threadId, assistantMessageId);
      if (wasCurrentGeneration) {
        sharedGenerationState.current = null;
      }

      if (wasCurrentGeneration && backgroundTaskService.isTaskActive('inference')) {
        await backgroundTaskService.stopBackgroundTask('inference');
      }
    }
  }, [finalizeAssistantMessage, finalizeThreadStatus, patchAssistantMessage, stopAssistantMessage]);

  const syncThreadParametersCallback = useCallback(
    (thread: ChatThread, nextParams?: GenerationParameters) => syncThreadParameters(
      thread,
      updateThreadParamsSnapshot,
      nextParams,
    ),
    [updateThreadParamsSnapshot],
  );

  const ensureThreadCanGenerate = useCallback((thread: ChatThread, actionLabel: string) => {
    if (thread.status === 'generating') {
      throw new Error('A response is already being generated for this thread.');
    }

    const engineState = llmEngineService.getState();
    if (engineState.status !== EngineStatus.READY) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    const threadModelId = getThreadActiveModelId(thread);
    if (engineState.activeModelId !== threadModelId) {
      throw new Error(`Load ${threadModelId} before ${actionLabel}.`);
    }

    if (
      llmEngineService.hasActiveCompletion()
      || llmEngineService.hasActiveChatBlockingContextOperation()
      || isNativeCompletionSettlingAfterStop()
    ) {
      throw new Error(`Wait for the current response to finish stopping before ${actionLabel}.`);
    }
  }, []);

  const ensureThreadUsesModelForSend = useCallback((thread: ChatThread, nextModelId: string) => {
    const currentModelId = getThreadActiveModelId(thread);
    if (nextModelId === currentModelId) {
      return;
    }

    switchThreadModel(thread.id, nextModelId);
    updateThreadParamsSnapshot(thread.id, getGenerationParametersForModel(nextModelId));
  }, [switchThreadModel, updateThreadParamsSnapshot]);

  const appendUserMessage = useCallback(async (text: string, options: AppendUserMessageOptions = {}) => {
    assertPrivateStorageWritableForChatMutation();
    const settings = getSettings();
    const activeModelId = settings.activeModelId;
    const activeModelParams = getGenerationParametersForModel(activeModelId);
    const attachmentDrafts = resolveReadyAttachmentDrafts({
      drafts: options.attachmentDrafts ?? [],
      readiness: options.multimodalReadiness,
      expectedModelId: activeModelId,
    });
    const documentAttachmentDrafts = resolveReadyDocumentAttachmentDrafts(options.documentAttachmentDrafts ?? []);
    const mediaAttachmentDrafts = resolveReadyMediaAttachmentDrafts({
      drafts: options.mediaAttachmentDrafts ?? [],
      readiness: options.multimodalReadiness,
      expectedModelId: activeModelId,
    });

    if (!activeModelId) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    const engineState = llmEngineService.getState();
    if (engineState.status !== EngineStatus.READY) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    if (engineState.activeModelId !== activeModelId) {
      throw new Error('Model is not loaded or engine is not ready. Please select and load a model in the Models tab.');
    }

    if (activeThread?.status === 'generating') {
      throw new Error('A response is already being generated for this thread.');
    }

    if (
      llmEngineService.hasActiveCompletion()
      || llmEngineService.hasActiveChatBlockingContextOperation()
      || isNativeCompletionSettlingAfterStop()
    ) {
      throw new Error('Wait for the current response to finish stopping before sending another message.');
    }

    await assertDraftAttachmentFilesExist(attachmentDrafts);
    await assertMediaDraftAttachmentFilesExist(mediaAttachmentDrafts);
    const processedDocumentAttachments = await processDocumentAttachmentDraftsForInference(documentAttachmentDrafts);
    const documentContentParts = processedDocumentAttachments.contentParts;
    const imageAttachmentMediaPaths = getDraftImageAttachmentMediaPaths(attachmentDrafts);
    const effectiveMultimodalReadiness = imageAttachmentMediaPaths.length > 0
      ? assertActiveMultimodalReadyForAttachmentMediaPaths({
          mediaPaths: imageAttachmentMediaPaths,
          multimodalReadiness: options.multimodalReadiness,
          expectedModelId: activeModelId,
          mediaPathOccurrenceCount: imageAttachmentMediaPaths.length,
        })
      : options.multimodalReadiness;

    const threadId = activeThread?.id
      ?? createThread({
        modelId: activeModelId,
        presetId: settings.activePresetId,
        presetSnapshot: resolvePresetSnapshot(settings.activePresetId),
        paramsSnapshot: activeModelParams,
      });

    setActiveThread(threadId);

    const existingThread = activeThread;
    if (existingThread) {
      ensureThreadUsesModelForSend(existingThread, activeModelId);
      const nextThread = useChatStore.getState().getThread(threadId);
      if (nextThread) {
        syncThreadParametersCallback(nextThread, activeModelParams);
      }
    }

    const threadAfterPossibleSwitch = useChatStore.getState().getThread(threadId);
    const threadModelId = threadAfterPossibleSwitch
      ? getThreadActiveModelId(threadAfterPossibleSwitch)
      : activeModelId;

    const userMessageId = createChatId('message');
    const normalizedText = text.trim();
    const userMessageContent = normalizedText.length > 0 || documentContentParts.length === 0
      ? normalizedText
      : DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER;
    const messageAttachments = [
      ...materializeAttachmentDraftsForMessage({
        threadId,
        messageId: userMessageId,
        drafts: attachmentDrafts,
      }),
      ...processedDocumentAttachments.attachments.map((attachment) => ({
        ...attachment,
        threadId,
        messageId: userMessageId,
      })),
      ...materializeMediaDraftsForMessage({
        threadId,
        messageId: userMessageId,
        drafts: mediaAttachmentDrafts,
      }),
    ];
    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: userMessageContent,
      createdAt: Date.now(),
      state: 'complete',
      kind: 'message',
      modelId: threadModelId,
      ...(documentContentParts.length > 0 ? { contentParts: documentContentParts } : null),
      ...(messageAttachments.length > 0
        ? { attachments: messageAttachments }
        : null),
    };

    appendMessage(threadId, userMessage);
    options.onUserMessageAppended?.(userMessage);

    const assistantMessageId = createAssistantPlaceholder(threadId, threadModelId);

    await runAssistantCompletion(threadId, assistantMessageId, {
      multimodalReadiness: effectiveMultimodalReadiness,
    });
  }, [activeThread, appendMessage, createAssistantPlaceholder, createThread, ensureThreadUsesModelForSend, runAssistantCompletion, setActiveThread, syncThreadParametersCallback]);

  const stopGeneration = useCallback(async () => {
    const generation = sharedGenerationState.current;
    if (!generation) {
      return;
    }

    generation.flushPendingAssistantPatch?.();
    generation.stopRequested = true;
    stopAssistantMessage(generation.threadId, generation.messageId);
    finalizeThreadStatus(generation.threadId, 'stopped');

    try {
      if (generation.nativeCompletionStarted) {
        await llmEngineService.interruptActiveCompletion();
      } else {
        if (typeof llmEngineService.cancelActiveContextOperations === 'function') {
          const drainResult = await llmEngineService.cancelActiveContextOperations();
          if (drainResult === 'timed_out') {
            console.warn('[ChatSession] Timed out waiting for prompt preparation to stop');
          }
        }
        await llmEngineService.stopCompletion();
      }
    } finally {
      if (sharedGenerationState.current === generation && backgroundTaskService.isTaskActive('inference')) {
        await backgroundTaskService.stopBackgroundTask('inference');
      }
    }
  }, [finalizeThreadStatus, stopAssistantMessage]);

  const regenerateFromUserMessage = useCallback(async (
    messageId: string,
    nextContent: string,
    options: RegenerateUserMessageOptions = {},
  ) => {
    if (!activeThread) {
      return false;
    }

    const targetMessage = activeThread.messages.find((message) => message.id === messageId);
    if (!targetMessage || targetMessage.role !== 'user') {
      throw new Error('The selected message could not be regenerated.');
    }

    const normalizedContent = nextContent.trim();
    if (!normalizedContent && !messageHasAttachments(targetMessage)) {
      throw new Error('Message cannot be empty.');
    }

    ensureThreadCanGenerate(activeThread, 'regenerating this response');
    assertPrivateStorageWritableForChatMutation();
    const { activeModelId, model } = resolveThreadReasoningRuntimeConfig(activeThread);
    const effectiveMultimodalReadiness = await assertUserMessageAttachmentsReadyForRegeneration(
      targetMessage,
      options.multimodalReadiness ?? model?.multimodalReadiness,
      activeModelId,
    );
    const syncedThread = syncThreadParametersCallback(activeThread);

    const assistantMessageId = replaceBranchFromUserMessage(
      syncedThread.id,
      messageId,
      normalizedContent,
    );
    if (!assistantMessageId) {
      throw new Error('The selected message could not be regenerated.');
    }

    await runAssistantCompletion(syncedThread.id, assistantMessageId, {
      multimodalReadiness: effectiveMultimodalReadiness,
    });

    return true;
  }, [activeThread, ensureThreadCanGenerate, replaceBranchFromUserMessage, runAssistantCompletion, syncThreadParametersCallback]);

  const regenerateLastResponse = useCallback(async () => {
    if (!activeThread) {
      return false;
    }

    const lastUserMessageIndex = (() => {
      for (let index = activeThread.messages.length - 1; index >= 0; index -= 1) {
        const message = activeThread.messages[index];
        if (!message) {
          continue;
        }
        if (message.role === 'user' && (message.content.trim().length > 0 || messageHasAttachments(message))) {
          return index;
        }
      }

      return -1;
    })();
    const lastUserMessage = lastUserMessageIndex >= 0
      ? activeThread.messages[lastUserMessageIndex]
      : undefined;
    if (!lastUserMessage) {
      return false;
    }

    // If the thread currently ends with a model-switch marker, regenerating the last
    // assistant in place would leave that marker trailing after the new assistant
    // response (`user -> assistant -> model_switch`). Rebuild the tail from the last
    // user message instead so the regenerated branch stays chronologically coherent.
    if (activeThread.messages.at(-1)?.kind === 'model_switch') {
      return regenerateFromUserMessage(lastUserMessage.id, lastUserMessage.content);
    }

    ensureThreadCanGenerate(activeThread, 'regenerating this response');
    assertPrivateStorageWritableForChatMutation();
    const { activeModelId, model } = resolveThreadReasoningRuntimeConfig(activeThread);
    const effectiveMultimodalReadiness = await assertUserMessageAttachmentsReadyForRegeneration(
      lastUserMessage,
      model?.multimodalReadiness,
      activeModelId,
    );
    const syncedThread = syncThreadParametersCallback(activeThread);

    const lastAssistantMessageIndex = (() => {
      for (let index = syncedThread.messages.length - 1; index >= 0; index -= 1) {
        if (syncedThread.messages[index]?.role === 'assistant') {
          return index;
        }
      }

      return -1;
    })();
    const canReplaceCurrentTurnAssistant =
      lastAssistantMessageIndex > lastUserMessageIndex &&
      lastAssistantMessageIndex === syncedThread.messages.length - 1;

    if (!canReplaceCurrentTurnAssistant) {
      return regenerateFromUserMessage(lastUserMessage.id, lastUserMessage.content);
    }

    const assistantMessageId = replaceLastAssistantMessage(syncedThread.id);
    if (!assistantMessageId) {
      return regenerateFromUserMessage(lastUserMessage.id, lastUserMessage.content);
    }

    await runAssistantCompletion(syncedThread.id, assistantMessageId, {
      multimodalReadiness: effectiveMultimodalReadiness,
    });

    return true;
  }, [
    activeThread,
    ensureThreadCanGenerate,
    regenerateFromUserMessage,
    replaceLastAssistantMessage,
    runAssistantCompletion,
    syncThreadParametersCallback,
  ]);

  const createSummaryPlaceholder = useCallback(() => {
    return false;
  }, []);

  const startNewChat = useCallback(() => {
    if (activeThread?.status === 'generating') {
      throw new Error('Stop the current response before starting a new chat.');
    }

    setActiveThread(null);
  }, [activeThread, setActiveThread]);

  const openThread = useCallback((threadId: string) => {
    if (activeThread?.status === 'generating' && activeThread.id !== threadId) {
      throw new Error('Stop the current response before switching conversations.');
    }

    const thread = useChatStore.getState().getThread(threadId);
    if (!thread) {
      throw new Error('The selected conversation is no longer available.');
    }

    assertPrivateStorageWritableForChatMutation();

    syncThreadParametersCallback(thread);
    setActiveThread(threadId);
  }, [activeThread, setActiveThread, syncThreadParametersCallback]);

  const deleteThread = useCallback((threadId: string) => {
    const thread = useChatStore.getState().getThread(threadId);
    if (thread?.status === 'generating') {
      throw new Error('Stop the current response before deleting this conversation.');
    }

    assertPrivateStorageWritableForChatMutation();

    deleteThreadState(threadId);
  }, [deleteThreadState]);

  const renameThread = useCallback((threadId: string, title: string) => {
    assertPrivateStorageWritableForChatMutation();

    const renamed = renameThreadState(threadId, title);
    if (!renamed) {
      throw new Error('The selected conversation is no longer available.');
    }
  }, [renameThreadState]);

  const deleteMessage = useCallback((messageId: string) => {
    if (!activeThread) {
      return false;
    }

    if (activeThread.status === 'generating') {
      throw new Error('Stop the current response before editing this conversation.');
    }

    assertPrivateStorageWritableForChatMutation();

    const deleted = deleteMessageBranch(activeThread.id, messageId);
    return deleted;
  }, [activeThread, deleteMessageBranch]);

  return {
    activeThread,
    messages: activeThread?.messages ?? [],
    isGenerating: activeThread?.status === 'generating',
    shouldOfferSummary: truncationState.shouldOfferSummary,
    truncatedMessageCount: truncationState.truncatedMessageIds.length,
    appendUserMessage,
    deleteMessage,
    deleteThread,
    renameThread,
    openThread,
    stopGeneration,
    regenerateFromUserMessage,
    regenerateLastResponse,
    createSummaryPlaceholder,
    startNewChat,
  };
};
