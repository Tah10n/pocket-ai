import { AppState, AppStateStatus } from 'react-native';
import { useCallback, useEffect, useRef } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { llmEngineService } from '../services/LLMEngineService';
import {
  buildExactPromptTokenCacheKey,
  buildPromptMultimodalReadinessIdentity,
  exactPromptTokenCache,
} from '../services/ExactPromptTokenCache';
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
import {
  flushPendingChatPersistenceWrites,
  useChatStore,
  type AssistantTurnCommitResult,
  type AssistantTurnFinalization,
} from '../store/chatStore';
import {
  DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS,
  buildInferenceWindowWithAccurateTokenCounts,
  createTruncationState,
  estimateLlmMessagesTokens,
  getThreadInferenceWindow,
  resolveThreadInferenceWindowOptions,
  type InferenceBudgetOptions,
} from '../utils/inferenceWindow';
import {
  createIncrementalAssistantPresentationParser,
  doesAssistantContentEndAtSentenceBoundary,
  getVisibleAssistantContent,
} from '../utils/chatPresentation';
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
import { buildLlmInferenceMessagesSignature } from '../utils/llmInferenceMessageSignature';

export { SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES } from '../utils/inferenceWindow';
const DEFAULT_CONTEXT_SIZE = 4096;
export const INITIAL_STREAM_PATCH_INTERVAL_MS = 80;
export const DEFAULT_STREAM_PATCH_INTERVAL_MS = 140;
export const LONG_STREAM_PATCH_INTERVAL_MS = 320;
export const LONG_STREAM_PATCH_TOKEN_THRESHOLD = 64;
export const LONG_STREAM_PATCH_CHAR_THRESHOLD = 1200;
const ATTACHMENT_FILE_CHECK_CONCURRENCY = 8;
const ESTIMATED_MEDIA_PROMPT_TOKENS_PER_INPUT = 576;
const EXACT_MEDIA_PROMPT_RECOUNT_MARGIN_TOKENS_PER_INPUT = 1024;

type ProcessedDocumentAttachmentDraftsForInference = {
  attachments: Extract<ChatAttachment, { kind: 'document' }>[];
  contentParts: LlmTextContentPart[];
};

type AttachmentFileResolution = {
  normalizedUri: string | null;
  exists: boolean;
};

type AttachmentFileResolver = (localUri: string) => Promise<AttachmentFileResolution>;

type PreparedAttachmentResolution = {
  readonly readinessIdentity: string;
  readonly uniqueFilesystemLookupCount: number;
  readonly finalFilesystemLookupCount: number;
  resolveFile: AttachmentFileResolver;
  resolveFileForFinalValidation: AttachmentFileResolver;
  setCancellationCheck: (check: () => void) => void;
  updateReadinessIdentity: (
    readiness: MultimodalReadinessState | undefined,
    expectedModelId: string | null,
  ) => void;
};

type PreparedInferenceRequest = {
  messages: LlmChatMessage[];
  promptTokens: number;
  promptSafetyMarginTokens: number;
  modelId: string;
  contextIdentity: string;
  messageSignature: string;
  tokenCountSource: 'exact' | 'conservative' | 'cache';
  attachmentResolution: PreparedAttachmentResolution;
};

type PromptTokenFormattingParams = {
  enable_thinking: boolean;
  reasoning_format: 'none' | 'auto' | 'deepseek';
  add_generation_prompt?: boolean;
};

type TerminalCommitResult =
  | { status: 'committed' | 'restored_without_write' | 'stale' }
  | { status: 'persistence_failed'; error: unknown };

interface ActiveGenerationState {
  threadId: string;
  messageId: string;
  stopRequested: boolean;
  nativeCompletionStarted: boolean;
  flushPendingAssistantPatch?: () => void;
  commitTerminalState?: () => TerminalCommitResult;
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

function createPreparedAttachmentResolution(
  readiness: MultimodalReadinessState | undefined,
  expectedModelId: string | null,
): PreparedAttachmentResolution {
  const fileResolutionByInputUri = new Map<string, Promise<AttachmentFileResolution>>();
  const fileExistenceByNormalizedUri = new Map<string, Promise<boolean>>();
  const finalFileExistenceByNormalizedUri = new Map<string, Promise<boolean>>();
  let cancellationCheck: () => void = () => undefined;
  let readinessIdentity = buildPromptMultimodalReadinessIdentity(readiness, expectedModelId);
  let uniqueFilesystemLookupCount = 0;
  let finalFilesystemLookupCount = 0;

  return {
    get readinessIdentity() {
      return readinessIdentity;
    },
    get uniqueFilesystemLookupCount() {
      return uniqueFilesystemLookupCount;
    },
    get finalFilesystemLookupCount() {
      return finalFilesystemLookupCount;
    },
    resolveFile: (localUri) => {
      cancellationCheck();
      const existing = fileResolutionByInputUri.get(localUri);
      if (existing) {
        return existing;
      }
      const resolution = resolvePreparedAttachmentFile(localUri);
      fileResolutionByInputUri.set(localUri, resolution);
      return resolution;
    },
    resolveFileForFinalValidation: (localUri) => {
      cancellationCheck();
      const normalizedUri = normalizeChatAttachmentLocalUri(localUri);
      if (!normalizedUri) {
        return Promise.resolve({ normalizedUri: null, exists: false });
      }

      let lookup = finalFileExistenceByNormalizedUri.get(normalizedUri);
      if (!lookup) {
        finalFilesystemLookupCount += 1;
        lookup = (async () => {
          const exists = await doesChatAttachmentFileExist(normalizedUri);
          cancellationCheck();
          return exists;
        })();
        finalFileExistenceByNormalizedUri.set(normalizedUri, lookup);
      }

      return lookup.then((exists) => ({ normalizedUri, exists }));
    },
    setCancellationCheck: (check) => {
      cancellationCheck = check;
    },
    updateReadinessIdentity: (nextReadiness, nextExpectedModelId) => {
      readinessIdentity = buildPromptMultimodalReadinessIdentity(nextReadiness, nextExpectedModelId);
    },
  };

  function resolvePreparedAttachmentFile(localUri: string): Promise<AttachmentFileResolution> {
    const normalizedUri = normalizeChatAttachmentLocalUri(localUri);
    if (!normalizedUri) {
      return Promise.resolve({ normalizedUri: null, exists: false });
    }

    let lookup = fileExistenceByNormalizedUri.get(normalizedUri);
    if (!lookup) {
      uniqueFilesystemLookupCount += 1;
      lookup = (async () => {
        const exists = await doesChatAttachmentFileExist(normalizedUri);
        cancellationCheck();
        return exists;
      })();
      fileExistenceByNormalizedUri.set(normalizedUri, lookup);
    }

    return lookup.then((exists) => ({ normalizedUri, exists }));
  }
}

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

function isAssistantTurnSettled(result: TerminalCommitResult): boolean {
  return result.status === 'committed' || result.status === 'restored_without_write';
}

function createAssistantTurnPersistenceError(
  result: Extract<TerminalCommitResult, { status: 'persistence_failed' }>,
): AppError {
  return new AppError(
    'action_failed',
    'The response is waiting to be saved. Restore private storage, then tap Stop to retry.',
    {
      cause: result.error,
      details: getSanitizedErrorDetails(result.error),
    },
  );
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
  return doesAssistantContentEndAtSentenceBoundary(content);
}

export function resetSharedGenerationStateForTests() {
  resetActiveChatGenerationRuntimeForPrivateStorageReset();
}

export function resetActiveChatGenerationRuntimeForPrivateStorageReset(): void {
  sharedGenerationState.current = null;
}

function ignorePrivateStorageUnavailableDuringRuntimeStop(error: unknown, scope: string): boolean {
  if (error instanceof PrivateStorageUnavailableError) {
    console.warn(`[ChatSession] Skipped persisting ${scope} while private storage is blocked`, {
      ...getSanitizedErrorDetails(error),
    });
    return true;
  }

  return false;
}

export async function stopActiveChatGenerationForPrivateStorageBlocked(): Promise<void> {
  const generation = sharedGenerationState.current;
  let deferredStateError: unknown = null;
  let settlementResult: TerminalCommitResult | null = null;

  if (generation) {
    generation.stopRequested = true;

    const chatState = useChatStore.getState();
    try {
      settlementResult = generation.commitTerminalState
        ? generation.commitTerminalState()
        : chatState.finalizeAssistantTurn(
          generation.threadId,
          generation.messageId,
          { outcome: 'stopped' },
        );
      if (settlementResult.status === 'persistence_failed') {
        console.warn('[ChatSession] Terminal persistence remains pending while private storage is blocked', {
          ...getSanitizedErrorDetails(settlementResult.error),
        });
      }
    } catch (error) {
      if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'assistant turn stop')) {
        deferredStateError = error;
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

  if (
    generation
    && sharedGenerationState.current === generation
    && settlementResult
    && settlementResult.status !== 'persistence_failed'
    && !generation.nativeCompletionStarted
  ) {
    sharedGenerationState.current = null;
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

async function resolveAttachmentFileUncached(localUri: string): Promise<AttachmentFileResolution> {
  const normalizedUri = normalizeChatAttachmentLocalUri(localUri);
  return {
    normalizedUri,
    exists: normalizedUri ? await doesChatAttachmentFileExist(normalizedUri) : false,
  };
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

function getLlmInferenceMessageContentPartMediaCount(message: LlmChatMessage): number {
  return message.contentParts?.filter((part) => part.type !== 'text').length ?? 0;
}

function getLlmInferenceMessageContentPartTextCount(message: LlmChatMessage): number {
  return message.contentParts?.filter((part) => part.type === 'text' && part.text.trim().length > 0).length ?? 0;
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

async function assertDraftAttachmentFilesExist(
  drafts: readonly AttachmentDraft[],
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
): Promise<void> {
  if (drafts.length === 0) {
    return;
  }

  const attachmentChecks = await mapWithConcurrency(
    drafts,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    async (draft) => {
      const resolution = await resolveAttachmentFile(draft.localUri ?? '');
      return {
        draft,
        localUri: resolution.normalizedUri,
        exists: resolution.exists,
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

async function assertMediaDraftAttachmentFilesExist(
  drafts: readonly ChatMediaAttachmentDraft[],
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
): Promise<void> {
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
      const resolution = await resolveAttachmentFile(draft.localUri ?? '');
      return {
        draft,
        localUri: resolution.normalizedUri,
        exists: resolution.exists,
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

async function assertMessageAttachmentFilesExist(
  message: ChatMessage,
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
): Promise<void> {
  const attachments = message.attachments;
  if (!attachments?.length) {
    return;
  }

  const attachmentChecks = await mapWithConcurrency(
    attachments,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    async (attachment) => {
      const resolution = await resolveAttachmentFile(attachment.localUri);
      return {
        attachment,
        localUri: resolution.normalizedUri,
        exists: resolution.exists,
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
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
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
    const resolution = await resolveAttachmentFile(attachment.localUri);
    const localUri = resolution.normalizedUri;
    const exists = resolution.exists;
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
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
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
    await assertMessageAttachmentFilesExist(message, resolveAttachmentFile);
    return readiness;
  }

  const latestReadiness = assertActiveMultimodalReadyForAttachmentMediaPaths({
    mediaPaths,
    multimodalReadiness: readiness,
    expectedModelId,
    mediaPathOccurrenceCount: mediaPaths.length,
  });
  await assertMessageAttachmentFilesExist(message, resolveAttachmentFile);
  return latestReadiness;
}

async function resolveLlmMessageAttachmentsForInference(
  message: LlmChatMessage,
  isLatestUserMessage: boolean,
  latestUserMessageId?: string | null,
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
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
      const resolution = await resolveAttachmentFile(attachment.localUri);
      return {
        attachment,
        localUri: resolution.normalizedUri,
        exists: resolution.exists,
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

async function resolveRetainedMessagesForInferenceAttachments(
  messages: readonly LlmChatMessage[],
  multimodalReadiness?: MultimodalReadinessState,
  latestUserMessageId?: string | null,
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
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
      resolveAttachmentFile,
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
  resolveAttachmentFile: AttachmentFileResolver = resolveAttachmentFileUncached,
): Promise<void> {
  if (!message || !messageHasAttachments(message)) {
    return;
  }

  assertMultimodalReadyForInferenceAttachments([message], readiness, expectedModelId);
  assertAudioReadyForInferenceAttachments([message], readiness, expectedModelId);
  await assertMessageAttachmentFilesExist(message, resolveAttachmentFile);
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
  attachmentResolution,
}: {
  thread: ChatThread;
  latestUserMessageId: string | null;
  multimodalReadiness?: MultimodalReadinessState;
  expectedModelId?: string | null;
  attachmentResolution: PreparedAttachmentResolution;
}): Promise<ChatThread> {
  const latestUserMessage = latestUserMessageId
    ? thread.messages.find((message) => message.id === latestUserMessageId)
    : undefined;
  await resolveLatestUserMessageAttachmentsForInference(
    latestUserMessage,
    multimodalReadiness,
    expectedModelId,
    attachmentResolution.resolveFile,
  );
  const readinessFilteredThread = stripUnsupportedThreadInferenceAttachments(
    thread,
    multimodalReadiness,
    expectedModelId,
  );
  const resolvedMessages = await mapWithConcurrency(
    readinessFilteredThread.messages,
    ATTACHMENT_FILE_CHECK_CONCURRENCY,
    (message) => resolveChatMessageAudioAttachmentsForInference(
      message,
      Boolean(latestUserMessageId && message.id === latestUserMessageId),
      latestUserMessageId,
      attachmentResolution.resolveFile,
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
  const messageListRevision = useChatStore((state) => state.streamingRevision);
  const createThread = useChatStore((state) => state.createThread);
  const appendMessage = useChatStore((state) => state.appendMessage);
  const createAssistantPlaceholder = useChatStore((state) => state.createAssistantPlaceholder);
  const switchThreadModel = useChatStore((state) => state.switchThreadModel);
  const deleteMessageBranch = useChatStore((state) => state.deleteMessageBranch);
  const deleteThreadState = useChatStore((state) => state.deleteThread);
  const finalizeAssistantTurn = useChatStore((state) => state.finalizeAssistantTurn);
  const patchAssistantMessage = useChatStore((state) => state.patchAssistantMessage);
  const replaceBranchFromUserMessage = useChatStore((state) => state.replaceBranchFromUserMessage);
  const replaceLastAssistantMessage = useChatStore((state) => state.replaceLastAssistantMessage);
  const renameThreadState = useChatStore((state) => state.renameThread);
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

        const assistantMessage = activeThread.messages.at(-1);
        if (assistantMessage?.role === 'assistant' && assistantMessage.state === 'streaming') {
          const recoveryFinalization = { outcome: 'stopped' } as const;
          const retryRecoveryCommit = () => useChatStore.getState().finalizeAssistantTurn(
            activeThread.id,
            assistantMessage.id,
            recoveryFinalization,
          );
          const result = retryRecoveryCommit();
          if (result.status === 'persistence_failed') {
            sharedGenerationState.current = {
              threadId: activeThread.id,
              messageId: assistantMessage.id,
              stopRequested: true,
              nativeCompletionStarted: false,
              commitTerminalState: retryRecoveryCommit,
            };
            console.warn('[ChatSession] Foreground recovery is waiting for private storage', {
              ...getSanitizedErrorDetails(result.error),
            });
          }
        } else {
          const retryThreadStatusCommit = (): TerminalCommitResult => {
            try {
              useChatStore.getState().finalizeThreadStatus(activeThread.id, 'stopped');
              return { status: 'committed' };
            } catch (error) {
              return { status: 'persistence_failed', error };
            }
          };
          const result = retryThreadStatusCommit();
          if (result.status === 'persistence_failed') {
            sharedGenerationState.current = {
              threadId: activeThread.id,
              messageId: assistantMessage?.id ?? activeThread.id,
              stopRequested: true,
              nativeCompletionStarted: false,
              commitTerminalState: retryThreadStatusCommit,
            };
            console.warn('[ChatSession] Foreground orphan recovery is waiting for private storage', {
              ...getSanitizedErrorDetails(result.error),
            });
          }
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const runAssistantCompletion = useCallback(async (
    threadId: string,
    assistantMessageId: string,
    completionOptions: {
      multimodalReadiness?: MultimodalReadinessState;
      attachmentResolution?: PreparedAttachmentResolution;
    } = {},
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

    const throwIfGenerationStopped = () => {
      if (generationState.stopRequested) {
        throw new Error('Generation was stopped before native completion started.');
      }
    };
    const promptPreparationSpan = performanceMonitor.isEnabled()
      ? performanceMonitor.startSpan('chat.prompt.total')
      : null;
    const endPromptPreparationSpan = promptPreparationSpan
      ? (
          outcome: 'success' | 'cancelled' | 'error',
          preparedRequest?: PreparedInferenceRequest,
        ) => {
          promptPreparationSpan.end({
            outcome,
            tokenCountSource: preparedRequest?.tokenCountSource,
            attachmentLookups: preparedRequest
              ? preparedRequest.attachmentResolution.uniqueFilesystemLookupCount
                + preparedRequest.attachmentResolution.finalFilesystemLookupCount
              : undefined,
            finalAttachmentRechecks: preparedRequest?.attachmentResolution.finalFilesystemLookupCount,
          });
        }
      : null;

    const presentationParser = createIncrementalAssistantPresentationParser();
    let presentationSnapshotSource: 'raw' | 'native-content' | null = null;
    let tokensCount = 0;
    let hasMarkedFirstToken = false;
    const startTime = Date.now();
    let flushTimeout: ReturnType<typeof setTimeout> | null = null;
    let scheduledFlushDelayMs: number | null = null;
    let unsubscribeExpiration: (() => void) | null = null;
    let sentBackgroundOutcomeNotification: 'interrupted' | 'error' | null = null;
    let hasFlushedFirstAssistantPatch = false;
    let lastFlushedVisibleRevision = presentationParser.getVisibleContentRevision();
    let latestRawAssistantSnapshot = '';
    let hasRecordedCompletionStats = false;

    const applyCumulativePresentationSnapshot = (
      snapshot: string,
      source: Exclude<typeof presentationSnapshotSource, null>,
    ) => {
      if (presentationSnapshotSource !== null && presentationSnapshotSource !== source) {
        presentationParser.applySnapshot(snapshot);
      } else {
        presentationParser.applyCumulativeSnapshot(snapshot);
      }
      presentationSnapshotSource = source;
    };

    const appendPresentationDelta = (delta: string) => {
      presentationParser.appendDelta(delta);
      presentationSnapshotSource ??= 'raw';
    };

    const recordCompletionStats = (
      outcome: 'success' | 'stopped' | 'error' | 'persistence_failed' | 'stale',
    ) => {
      if (hasRecordedCompletionStats) {
        return;
      }
      hasRecordedCompletionStats = true;
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

    const hasBufferedAssistantContent = () => {
      const presentation = presentationParser.getPresentation();
      return presentation.finalContent.length > 0 || presentation.thoughtContent.length > 0;
    };

    const cancelScheduledAssistantPatch = () => {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
        scheduledFlushDelayMs = null;
      }
    };

    const flushAssistantPatch = (options?: { allowStopped?: boolean; includeStreamingState?: boolean }) => {
      cancelScheduledAssistantPatch();

      if (!canMutateAssistantMessage(options)) {
        return;
      }

      const elapsedSec = (Date.now() - startTime) / 1000;
      const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;
      const presentation = presentationParser.getPresentation();

      const updates: Partial<ChatMessage> = {
        content: presentation.finalContent,
        thoughtContent: presentation.thoughtContent || undefined,
        tokensPerSec,
      };

      if (options?.includeStreamingState !== false) {
        updates.state = 'streaming';
      }

      patchAssistantMessage(threadId, assistantMessageId, updates);
      if (presentation.finalContent.length > 0 || presentation.thoughtContent.length > 0) {
        hasFlushedFirstAssistantPatch = true;
        lastFlushedVisibleRevision = presentationParser.getVisibleContentRevision();
      }
    };

    const terminalSettlement: { result: AssistantTurnCommitResult | null } = { result: null };
    let pendingTerminalFinalization: AssistantTurnFinalization | null = null;
    const finalizeBufferedAssistantTurn = (
      finalization: AssistantTurnFinalization,
      options?: { allowStopped?: boolean },
    ): AssistantTurnCommitResult => {
      cancelScheduledAssistantPatch();
      if (terminalSettlement.result && terminalSettlement.result.status !== 'persistence_failed') {
        return terminalSettlement.result;
      }
      if (!canMutateAssistantMessage(options)) {
        terminalSettlement.result = { status: 'stale' };
        return terminalSettlement.result;
      }

      if (!pendingTerminalFinalization) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const tokensPerSec = elapsedSec > 0 ? tokensCount / elapsedSec : 0;
        const presentation = presentationParser.getPresentation();
        const bufferedThoughtContent = presentation.thoughtContent.length > 0
          ? presentation.thoughtContent
          : null;
        pendingTerminalFinalization = {
          ...finalization,
          content: finalization.content ?? presentation.finalContent,
          thoughtContent: finalization.thoughtContent === undefined
            ? bufferedThoughtContent
            : finalization.thoughtContent,
          tokensPerSec: finalization.tokensPerSec ?? tokensPerSec,
        };
      }

      terminalSettlement.result = finalizeAssistantTurn(
        threadId,
        assistantMessageId,
        pendingTerminalFinalization,
      );
      return terminalSettlement.result;
    };

    const resolveTerminalCommitError = (result: AssistantTurnCommitResult): AppError | null => {
      if (result.status === 'persistence_failed') {
        recordCompletionStats('persistence_failed');
        return createAssistantTurnPersistenceError(result);
      }
      if (result.status === 'stale') {
        recordCompletionStats('stale');
        return new AppError(
          'action_failed',
          'The response was not saved because the conversation changed. Try again.',
        );
      }

      return null;
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

      const presentation = presentationParser.getPresentation();
      const delayMs = resolveAssistantStreamPatchInterval({
        tokensCount,
        visibleCharCount: presentation.finalContent.length,
        thoughtCharCount: presentation.thoughtContent.length,
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
    generationState.commitTerminalState = () => finalizeBufferedAssistantTurn(
      { outcome: 'stopped' },
      { allowStopped: true },
    );

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
      const attachmentResolution = completionOptions.attachmentResolution
        ?? createPreparedAttachmentResolution(effectiveMultimodalReadiness, activeModelId);
      attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, activeModelId);
      attachmentResolution.setCancellationCheck(throwIfGenerationStopped);
      const promptContextIdentity = llmEngineService.getPromptContextIdentity();

      await backgroundTaskService.startBackgroundInference(modelName);

      unsubscribeExpiration = backgroundTaskService.subscribeToExpiration(() => {
        if (!isMatchingGeneration(threadId, assistantMessageId)) {
          return;
        }

        try {
          generationState.stopRequested = true;
          const result = finalizeBufferedAssistantTurn(
            { outcome: 'stopped' },
            { allowStopped: true },
          );
          if (isAssistantTurnSettled(result)) {
            recordCompletionStats('stopped');
            sendOutcomeNotificationOnce('interrupted');
          } else {
            resolveTerminalCommitError(result);
          }
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

      const attachmentPreparationSpan = performanceMonitor.isEnabled()
        ? performanceMonitor.startSpan('chat.prompt.attachments')
        : null;
      try {
        thread = await resolveThreadForInferenceAttachments({
          thread: storedThread,
          latestUserMessageId,
          multimodalReadiness: effectiveMultimodalReadiness,
          expectedModelId: activeModelId,
          attachmentResolution,
        });
      } finally {
        if (attachmentPreparationSpan) {
          attachmentPreparationSpan.end({
            uniqueFilesystemLookups: attachmentResolution.uniqueFilesystemLookupCount,
          });
        }
      }

      const MESSAGE_TOO_LONG_ERROR_MESSAGE =
        'This message is too long for the current context window. Shorten it or increase the context size in Model Controls.';

      let forcedDisableThinking = false;
      let messages: LlmChatMessage[] = [];
      let promptTokens = 0;
      let promptSafetyMarginTokens = 0;
      let selectedTokenCountParams: PromptTokenFormattingParams = {
        enable_thinking: reasoningRuntimeConfig.enableThinking,
        reasoning_format: reasoningRuntimeConfig.reasoningFormat,
      };
      let didUseHeuristicPromptTokens = false;
      let didUseEstimatedMediaPromptTokens = false;
      const preparedMessagesBySignature = new Map<string, Promise<LlmChatMessage[]>>();
      const tokenCountSourceByCacheKey = new Map<string, 'exact' | 'cache'>();

      const resolvePreparedMessages = (windowMessages: LlmChatMessage[]) => {
        throwIfGenerationStopped();
        const preparationKey = [
          attachmentResolution.readinessIdentity,
          latestUserMessageId,
          buildLlmInferenceMessagesSignature(windowMessages),
        ].join('\u0001');
        const existing = preparedMessagesBySignature.get(preparationKey);
        if (existing) {
          return existing;
        }

        const preparation = resolveRetainedMessagesForInferenceAttachments(
          windowMessages,
          effectiveMultimodalReadiness,
          latestUserMessageId,
          attachmentResolution.resolveFile,
          activeModelId,
        ).catch((error) => {
          if (preparedMessagesBySignature.get(preparationKey) === preparation) {
            preparedMessagesBySignature.delete(preparationKey);
          }
          throw error;
        });
        preparedMessagesBySignature.set(preparationKey, preparation);
        return preparation;
      };

      const buildPromptTokenCacheKey = (
        messagesToCount: LlmChatMessage[],
        params: PromptTokenFormattingParams,
      ) => buildExactPromptTokenCacheKey({
        contextIdentity: promptContextIdentity,
        modelId: activeModelId,
        multimodalReadinessIdentity: attachmentResolution.readinessIdentity,
        messageSignature: buildLlmInferenceMessagesSignature(messagesToCount),
        enableThinking: params.enable_thinking,
        reasoningFormat: params.reasoning_format,
        addGenerationPrompt: params.add_generation_prompt,
      });
      const resolvePromptTokenMessages = (messagesToCount: LlmChatMessage[]) => messagesToCount.map((message) => (
        resolveLlmMessageSupportedInferenceContent(message, effectiveMultimodalReadiness, activeModelId)
      ));
      const countExactPromptTokens = async (
        messagesToCount: LlmChatMessage[],
        params: PromptTokenFormattingParams,
      ) => {
        throwIfGenerationStopped();
        const sanitizedMessagesToCount = resolvePromptTokenMessages(messagesToCount);
        const cacheKey = buildPromptTokenCacheKey(sanitizedMessagesToCount, params);
        const lookup = exactPromptTokenCache.getOrCreate(cacheKey, () => {
          throwIfGenerationStopped();
          const tokenizeSpan = performanceMonitor.isEnabled()
            ? performanceMonitor.startSpan('chat.prompt.tokenize')
            : null;
          const tokenCountPromise = llmEngineService.countPromptTokens({
            messages: sanitizedMessagesToCount,
            params,
            multimodalReadiness: effectiveMultimodalReadiness,
            expectedModelId: activeModelId,
          });
          return tokenizeSpan
            ? tokenCountPromise.then((tokens) => {
                tokenizeSpan.end({ outcome: 'success' });
                return tokens;
              }).catch((error) => {
                tokenizeSpan.end({ outcome: 'error' });
                throw error;
              })
            : tokenCountPromise;
        });
        tokenCountSourceByCacheKey.set(cacheKey, lookup.hit ? 'cache' : 'exact');
        if (performanceMonitor.isEnabled()) {
          performanceMonitor.incrementCounter(
            lookup.hit ? 'chat.prompt.cache.hit' : 'chat.prompt.cache.miss',
          );
        }

        let cacheOutcome: 'success' | 'discard' = 'discard';
        try {
          const tokens = await lookup.promise;
          throwIfGenerationStopped();
          cacheOutcome = 'success';
          return tokens;
        } finally {
          lookup.release(cacheOutcome);
        }
      };

      const countResolvedPromptTokens = async (
        resolvedWindowMessages: LlmChatMessage[],
        params: PromptTokenFormattingParams,
      ) => {
        throwIfGenerationStopped();

        const mediaPaths = getLlmInferenceMessagesMediaPaths(resolvedWindowMessages);
        if (mediaPaths.length > 0) {
          const textOnlyMessages = resolvedWindowMessages.map(omitLlmInferenceAttachments);
          let textOnlyPromptTokens: number;
          try {
            textOnlyPromptTokens = await countExactPromptTokens(textOnlyMessages, params);
          } catch {
            return countExactPromptTokens(resolvedWindowMessages, params);
          }

          didUseEstimatedMediaPromptTokens = true;
          throwIfGenerationStopped();
          return textOnlyPromptTokens + estimateLlmInferenceMediaPromptTokens(resolvedWindowMessages);
        }

        return countExactPromptTokens(resolvedWindowMessages, params);
      };

      const countPromptTokens = async (
        windowMessages: LlmChatMessage[],
        params: PromptTokenFormattingParams,
      ) => {
        throwIfGenerationStopped();
        const resolvedWindowMessages = await resolvePreparedMessages(windowMessages);
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
          messages = await resolvePreparedMessages(getThreadInferenceWindow(thread, windowOptions).messages);
          promptTokens = estimateLlmMessagesTokens(messages);
          promptSafetyMarginTokens = Math.max(
            0,
            Math.round(windowOptions.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
          );
        }
      }

      throwIfGenerationStopped();
      const finalizationSpan = performanceMonitor.isEnabled()
        ? performanceMonitor.startSpan('chat.prompt.finalize')
        : null;
      let preparedRequest: PreparedInferenceRequest;
      try {
        const buildPreparedRequest = async (
          preparedMessages: LlmChatMessage[],
          resolvedPromptTokens: number,
        ): Promise<PreparedInferenceRequest> => {
          const messageSignature = buildLlmInferenceMessagesSignature(preparedMessages);
          const finalPromptTokenMessages = resolvePromptTokenMessages(preparedMessages);
          const finalPromptTokenCacheKey = buildPromptTokenCacheKey(
            finalPromptTokenMessages,
            selectedTokenCountParams,
          );

          const nonSystemMessages = preparedMessages.filter((message) => message.role !== 'system');
          const lastNonSystemRole = nonSystemMessages.length > 0
            ? nonSystemMessages[nonSystemMessages.length - 1]?.role
            : null;
          if (lastNonSystemRole !== 'user') {
            throw new AppError('message_too_long', MESSAGE_TOO_LONG_ERROR_MESSAGE);
          }

          let finalPromptTokens = resolvedPromptTokens;
          let tokenCountSource: PreparedInferenceRequest['tokenCountSource'] =
            didUseHeuristicPromptTokens || didUseEstimatedMediaPromptTokens
              ? 'conservative'
              : (tokenCountSourceByCacheKey.get(finalPromptTokenCacheKey) ?? 'exact');
          let availablePredictTokens = maxContextSize - finalPromptTokens - promptSafetyMarginTokens;
          if (
            !didUseHeuristicPromptTokens
            && didUseEstimatedMediaPromptTokens
            && getLlmInferenceMessagesMediaPaths(preparedMessages).length > 0
            && availablePredictTokens <= resolveExactMediaPromptRecountMarginTokens(preparedMessages)
          ) {
            throwIfGenerationStopped();
            finalPromptTokens = await countExactPromptTokens(preparedMessages, selectedTokenCountParams);
            throwIfGenerationStopped();
            tokenCountSource = tokenCountSourceByCacheKey.get(finalPromptTokenCacheKey) ?? 'exact';
            availablePredictTokens = maxContextSize - finalPromptTokens - promptSafetyMarginTokens;
          }

          if (availablePredictTokens <= 0) {
            throw new AppError('message_too_long', MESSAGE_TOO_LONG_ERROR_MESSAGE, {
              details: {
                maxContextSize,
                promptTokens: finalPromptTokens,
                promptSafetyMarginTokens,
              },
            });
          }

          return {
            messages: preparedMessages,
            promptTokens: finalPromptTokens,
            promptSafetyMarginTokens,
            modelId: activeModelId,
            contextIdentity: promptContextIdentity,
            messageSignature,
            tokenCountSource,
            attachmentResolution,
          };
        };

        const preparedMessages = await resolvePreparedMessages(messages);
        throwIfGenerationStopped();
        preparedRequest = await buildPreparedRequest(preparedMessages, promptTokens);

        const latestPreparedUserMessageIndex = getLatestUserLlmMessageIndex(preparedRequest.messages);
        const latestPreparedUserMessage = preparedRequest.messages[latestPreparedUserMessageIndex];
        if (latestPreparedUserMessage?.attachments?.length) {
          const revalidatedLatestUserMessage = await resolveLlmMessageAttachmentsForInference(
            latestPreparedUserMessage,
            true,
            latestUserMessageId,
            attachmentResolution.resolveFileForFinalValidation,
            effectiveMultimodalReadiness,
            activeModelId,
          );
          throwIfGenerationStopped();

          if (revalidatedLatestUserMessage !== latestPreparedUserMessage) {
            const revalidatedMessages = [...preparedRequest.messages];
            revalidatedMessages[latestPreparedUserMessageIndex] = revalidatedLatestUserMessage;
            const revalidatedPromptTokens = didUseHeuristicPromptTokens
              ? estimateLlmMessagesTokens(revalidatedMessages)
              : await countResolvedPromptTokens(revalidatedMessages, selectedTokenCountParams);
            throwIfGenerationStopped();
            preparedRequest = await buildPreparedRequest(revalidatedMessages, revalidatedPromptTokens);
          }
        }
      } finally {
        finalizationSpan?.end();
      }

      messages = preparedRequest.messages;
      promptTokens = preparedRequest.promptTokens;
      promptSafetyMarginTokens = preparedRequest.promptSafetyMarginTokens;
      const maxPredictTokens = Math.max(
        1,
        maxContextSize - preparedRequest.promptTokens - preparedRequest.promptSafetyMarginTokens,
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

      endPromptPreparationSpan?.('success', preparedRequest);

      if (generationState.stopRequested) {
        if (isMatchingGeneration(threadId, assistantMessageId)) {
          const result = terminalSettlement.result ?? finalizeBufferedAssistantTurn(
            { outcome: 'stopped' },
            { allowStopped: true },
          );
          if (isAssistantTurnSettled(result)) {
            recordCompletionStats('stopped');
            sendOutcomeNotificationOnce('interrupted');
          } else {
            resolveTerminalCommitError(result);
          }
        }
        return;
      }

      if (llmEngineService.getPromptContextIdentity() !== preparedRequest.contextIdentity) {
        throw new AppError(
          'engine_not_ready',
          'The model context changed while preparing the prompt. Try again.',
        );
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
          const isStreamingTraceEnabled = performanceMonitor.isEnabled();
          const processedCharactersBefore = isStreamingTraceEnabled
            ? presentationParser.getProcessedCharacterCount()
            : 0;
          if (isStreamingTraceEnabled) {
            performanceMonitor.incrementCounter('chat.stream.nativeCallback');
          }

          if (!canMutateAssistantMessage()) {
            return;
          }

          if (!hasMarkedFirstToken) {
            hasMarkedFirstToken = true;
            performanceMonitor.mark('chat.firstToken', { modelId });
          }

          if (typeof token === 'string') {
            appendPresentationDelta(token);
          } else {
            const hasReasoningUpdate = token.reasoningContent !== undefined;
            if (typeof token.accumulatedText === 'string') {
              latestRawAssistantSnapshot = token.accumulatedText;
            }

            if (token.content !== undefined) {
              if (token.contentMode === 'cumulative') {
                applyCumulativePresentationSnapshot(token.content, 'native-content');
              } else {
                presentationParser.applySnapshot(token.content);
                presentationSnapshotSource = 'native-content';
              }
            } else if (!hasReasoningUpdate) {
              if (typeof token.accumulatedText === 'string') {
                applyCumulativePresentationSnapshot(token.accumulatedText, 'raw');
              } else {
                appendPresentationDelta(token.token);
              }
            }
            // Reasoning-only native updates intentionally ignore raw accumulated text. Its
            // template-specific markers must never leak into the visible assistant bubble.

            if (token.reasoningContent !== undefined) {
              if (token.reasoningContentMode === 'delta') {
                presentationParser.appendExplicitReasoningDelta(token.reasoningContent);
              } else if (token.reasoningContentMode === 'cumulative') {
                presentationParser.applyCumulativeExplicitReasoningSnapshot(
                  token.reasoningContent,
                );
              } else {
                presentationParser.applyExplicitReasoningSnapshot(token.reasoningContent);
              }
            }
          }

          if (isStreamingTraceEnabled) {
            performanceMonitor.incrementCounter('chat.stream.presentation');
            const processedCharacterCount = presentationParser.getProcessedCharacterCount()
              - processedCharactersBefore;
            if (processedCharacterCount > 0) {
              performanceMonitor.incrementCounter(
                'chat.stream.presentationCharacters',
                processedCharacterCount,
              );
            }
          }
          tokensCount += 1;
          scheduleAssistantPatch({
            sentenceBoundary:
              presentationParser.getVisibleContentRevision() !== lastFlushedVisibleRevision &&
              presentationParser.doesVisibleContentEndAtSentenceBoundary(),
          });
        },
      });
      generationState.nativeCompletionStarted = false;

      if (generationState.stopRequested) {
        if (isMatchingGeneration(threadId, assistantMessageId)) {
          const result = terminalSettlement.result ?? finalizeBufferedAssistantTurn(
            { outcome: 'stopped' },
            { allowStopped: true },
          );
          if (isAssistantTurnSettled(result)) {
            recordCompletionStats('stopped');
            sendOutcomeNotificationOnce('interrupted');
          } else {
            resolveTerminalCommitError(result);
          }
        }
        return;
      }

      const currentPresentation = presentationParser.getPresentation();
      const finalThoughtContent = completion.reasoning_content !== undefined
        ? completion.reasoning_content
        : currentPresentation.thoughtContent;
      const completionTelemetry = typeof llmEngineService.getLastCompletionTelemetry === 'function'
        ? llmEngineService.getLastCompletionTelemetry()
        : null;
      const successResult = finalizeBufferedAssistantTurn({
        outcome: 'success',
        content: resolveVisibleAssistantContentFromCandidates(
          '',
          completion.content,
          currentPresentation.finalContent,
          completion.text,
          latestRawAssistantSnapshot,
        ),
        thoughtContent: finalThoughtContent.length > 0 ? finalThoughtContent : null,
        inferenceMetrics: completionTelemetry ?? undefined,
      });
      const successCommitError = resolveTerminalCommitError(successResult);
      if (successCommitError) {
        throw successCommitError;
      }
      recordCompletionStats('success');

      if (AppState.currentState !== 'active') {
        void notificationService.sendCompletionNotification('inference', { threadId });
      }
    } catch (error) {
      generationState.nativeCompletionStarted = false;
      endPromptPreparationSpan?.(generationState.stopRequested ? 'cancelled' : 'error');
      if (generationState.stopRequested) {
        if (isMatchingGeneration(threadId, assistantMessageId)) {
          const result = terminalSettlement.result ?? finalizeBufferedAssistantTurn(
            { outcome: 'stopped' },
            { allowStopped: true },
          );
          if (isAssistantTurnSettled(result)) {
            recordCompletionStats('stopped');
            sendOutcomeNotificationOnce('interrupted');
          } else {
            resolveTerminalCommitError(result);
          }
        }
        return;
      }

      if (terminalSettlement.result && !isAssistantTurnSettled(terminalSettlement.result)) {
        throw resolveTerminalCommitError(terminalSettlement.result) ?? error;
      }

      const message = resolvePersistedAssistantErrorMessage(error);
      const userFacingError = resolveUserFacingGenerationError(error, message);

      const errorResult = finalizeBufferedAssistantTurn({
          outcome: 'error',
          errorCode: 'generation_failed',
          errorMessage: message,
      });
      const errorCommitError = resolveTerminalCommitError(errorResult);
      if (errorCommitError) {
        throw errorCommitError;
      }
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
      const shouldRetainRecoveryController = terminalSettlement.result?.status === 'persistence_failed';
      if (wasCurrentGeneration && !shouldRetainRecoveryController) {
        sharedGenerationState.current = null;
      }

      if (wasCurrentGeneration && backgroundTaskService.isTaskActive('inference')) {
        await backgroundTaskService.stopBackgroundTask('inference');
      }
    }
  }, [finalizeAssistantTurn, patchAssistantMessage]);

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

    const attachmentResolution = createPreparedAttachmentResolution(
      options.multimodalReadiness,
      activeModelId,
    );
    await assertDraftAttachmentFilesExist(attachmentDrafts, attachmentResolution.resolveFile);
    await assertMediaDraftAttachmentFilesExist(mediaAttachmentDrafts, attachmentResolution.resolveFile);
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
    attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, activeModelId);

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
      attachmentResolution,
    });
  }, [activeThread, appendMessage, createAssistantPlaceholder, createThread, ensureThreadUsesModelForSend, runAssistantCompletion, setActiveThread, syncThreadParametersCallback]);

  const stopGeneration = useCallback(async () => {
    const generation = sharedGenerationState.current;
    if (!generation) {
      return;
    }

    generation.stopRequested = true;
    let firstStopError: unknown;
    let hasStopError = false;
    let settlementResult: TerminalCommitResult | null = null;
    const captureFirstStopError = (error: unknown) => {
      if (!hasStopError) {
        firstStopError = error;
        hasStopError = true;
      }
    };

    try {
      settlementResult = generation.commitTerminalState
        ? generation.commitTerminalState()
        : useChatStore.getState().finalizeAssistantTurn(
          generation.threadId,
          generation.messageId,
          { outcome: 'stopped' },
        );
      if (settlementResult.status === 'persistence_failed') {
        captureFirstStopError(createAssistantTurnPersistenceError(settlementResult));
      }
    } catch (error) {
      captureFirstStopError(error);
    }

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
    } catch (error) {
      captureFirstStopError(error);
    }

    try {
      if (sharedGenerationState.current === generation && backgroundTaskService.isTaskActive('inference')) {
        await backgroundTaskService.stopBackgroundTask('inference');
      }
    } catch (error) {
      captureFirstStopError(error);
    }

    if (
      sharedGenerationState.current === generation
      && settlementResult
      && settlementResult.status !== 'persistence_failed'
      && !generation.nativeCompletionStarted
    ) {
      sharedGenerationState.current = null;
    }

    if (hasStopError) {
      throw firstStopError;
    }
  }, []);

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
    const requestedMultimodalReadiness = options.multimodalReadiness ?? model?.multimodalReadiness;
    const attachmentResolution = createPreparedAttachmentResolution(
      requestedMultimodalReadiness,
      activeModelId,
    );
    const effectiveMultimodalReadiness = await assertUserMessageAttachmentsReadyForRegeneration(
      targetMessage,
      requestedMultimodalReadiness,
      activeModelId,
      attachmentResolution.resolveFile,
    );
    attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, activeModelId);
    const currentState = useChatStore.getState();
    const currentThread = currentState.threads[activeThread.id];
    if (
      currentState.activeThreadId !== activeThread.id
      || currentThread !== activeThread
      || getThreadActiveModelId(currentThread) !== activeModelId
    ) {
      throw new Error('The conversation changed while preparing regeneration. Try again.');
    }
    const branchParamsSnapshot = getGenerationParametersForModel(activeModelId);

    const assistantMessageId = replaceBranchFromUserMessage(
      activeThread.id,
      messageId,
      normalizedContent,
      branchParamsSnapshot,
    );
    if (!assistantMessageId) {
      throw new Error('The selected message could not be regenerated.');
    }

    await runAssistantCompletion(activeThread.id, assistantMessageId, {
      multimodalReadiness: effectiveMultimodalReadiness,
      attachmentResolution,
    });

    return true;
  }, [activeThread, ensureThreadCanGenerate, replaceBranchFromUserMessage, runAssistantCompletion]);

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
    const attachmentResolution = createPreparedAttachmentResolution(
      model?.multimodalReadiness,
      activeModelId,
    );
    const effectiveMultimodalReadiness = await assertUserMessageAttachmentsReadyForRegeneration(
      lastUserMessage,
      model?.multimodalReadiness,
      activeModelId,
      attachmentResolution.resolveFile,
    );
    attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, activeModelId);
    const currentState = useChatStore.getState();
    const currentThread = currentState.threads[activeThread.id];
    if (
      currentState.activeThreadId !== activeThread.id
      || currentThread !== activeThread
      || getThreadActiveModelId(currentThread) !== activeModelId
    ) {
      throw new Error('The conversation changed while preparing regeneration. Try again.');
    }
    const branchParamsSnapshot = getGenerationParametersForModel(activeModelId);

    const lastAssistantMessageIndex = (() => {
      for (let index = activeThread.messages.length - 1; index >= 0; index -= 1) {
        if (activeThread.messages[index]?.role === 'assistant') {
          return index;
        }
      }

      return -1;
    })();
    const canReplaceCurrentTurnAssistant =
      lastAssistantMessageIndex > lastUserMessageIndex &&
      lastAssistantMessageIndex === activeThread.messages.length - 1;

    const regenerateFromLastUserWithPreparedAttachments = async () => {
      const assistantMessageId = replaceBranchFromUserMessage(
        activeThread.id,
        lastUserMessage.id,
        lastUserMessage.content.trim(),
        branchParamsSnapshot,
      );
      if (!assistantMessageId) {
        throw new Error('The selected message could not be regenerated.');
      }

      await runAssistantCompletion(activeThread.id, assistantMessageId, {
        multimodalReadiness: effectiveMultimodalReadiness,
        attachmentResolution,
      });

      return true;
    };

    if (!canReplaceCurrentTurnAssistant) {
      return regenerateFromLastUserWithPreparedAttachments();
    }

    const syncedThread = syncThreadParametersCallback(activeThread);
    const assistantMessageId = replaceLastAssistantMessage(syncedThread.id);
    if (!assistantMessageId) {
      return regenerateFromLastUserWithPreparedAttachments();
    }

    await runAssistantCompletion(syncedThread.id, assistantMessageId, {
      multimodalReadiness: effectiveMultimodalReadiness,
      attachmentResolution,
    });

    return true;
  }, [
    activeThread,
    ensureThreadCanGenerate,
    regenerateFromUserMessage,
    replaceBranchFromUserMessage,
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
    messageListRevision,
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
