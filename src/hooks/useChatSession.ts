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
  DEFAULT_PRESET_SNAPSHOT,
  DEFAULT_SYSTEM_PROMPT,
  PresetSnapshot,
  createChatId,
  getThreadActiveModelId,
} from '../types/chat';
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
import { materializeAttachmentDraftsForMessage } from '../services/ChatAttachmentStorageService';
import { sanitizeMultimodalFailureReason } from '../utils/multimodalFailureReason';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  getChatImageAttachmentMediaPaths,
  getSendableDraftImageAttachments,
  hasFailedDraftImageAttachments,
  normalizeChatAttachmentLocalUri,
  validateChatImageAttachmentLimit,
} from '../utils/chatImageAttachments';

export { SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES } from '../utils/inferenceWindow';
const DEFAULT_CONTEXT_SIZE = 4096;
export const INITIAL_STREAM_PATCH_INTERVAL_MS = 80;
export const DEFAULT_STREAM_PATCH_INTERVAL_MS = 140;
export const LONG_STREAM_PATCH_INTERVAL_MS = 320;
export const LONG_STREAM_PATCH_TOKEN_THRESHOLD = 64;
export const LONG_STREAM_PATCH_CHAR_THRESHOLD = 1200;
const STREAM_BOUNDARY_PATTERN = /[.!?。！？](?:["')\]}]|[\s])*$/;
const ATTACHMENT_FILE_CHECK_CONCURRENCY = 8;

interface ActiveGenerationState {
  threadId: string;
  messageId: string;
  stopRequested: boolean;
  nativeCompletionStarted: boolean;
  flushPendingAssistantPatch?: () => void;
}

export type AppendUserMessageOptions = {
  attachmentDrafts?: readonly AttachmentDraft[];
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
}: {
  drafts: readonly AttachmentDraft[];
  readiness?: MultimodalReadinessState;
}): AttachmentDraft[] {
  if (drafts.length === 0) {
    return [];
  }

  if (hasFailedDraftImageAttachments(drafts)) {
    throw new AppError('chat_attachment_copy_failed', 'One or more image attachments failed to copy.');
  }

  const limit = validateChatImageAttachmentLimit(0, drafts.length);
  if (!limit.ok) {
    throw new AppError('chat_attachment_limit_exceeded', 'Too many image attachments.');
  }

  const sendableDrafts = getSendableDraftImageAttachments(drafts);
  if (
    sendableDrafts.length !== drafts.length
    || sendableDrafts.some((draft) => draft.copyStatus !== 'copied')
  ) {
    throw new AppError('chat_attachment_not_ready', 'Image attachments are not ready to send.');
  }

  if (readiness?.status !== 'ready' || !readiness.support.includes('vision')) {
    throw new AppError('multimodal_not_ready', 'Vision chat is not ready for image attachments.', {
      details: {
        readinessStatus: readiness?.status ?? 'unknown',
        attachmentCount: drafts.length,
      },
    });
  }

  return sendableDrafts;
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

function isVisionReady(readiness?: MultimodalReadinessState): boolean {
  return readiness?.status === 'ready' && readiness.support.includes('vision');
}

function messageHasAttachments(message: ChatMessage | undefined): boolean {
  return (message?.attachments?.length ?? 0) > 0;
}

function omitInferenceAttachments(message: ChatMessage): ChatMessage {
  if (!message.attachments?.length) {
    return message;
  }

  return {
    ...message,
    attachments: undefined,
  };
}

function omitLlmInferenceAttachments(message: LlmChatMessage): LlmChatMessage {
  if (!message.attachments?.length && !message.mediaPaths?.length) {
    return message;
  }

  const { attachments: _attachments, mediaPaths: _mediaPaths, ...messageWithoutAttachments } = message;
  return messageWithoutAttachments;
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
    ...getChatImageAttachmentMediaPaths(message.attachments),
  ]);
}

function getLlmInferenceMessagesMediaPaths(messages: readonly LlmChatMessage[]): string[] {
  return normalizeLlmInferenceMediaPaths(messages.flatMap(getLlmInferenceMessageMediaPaths));
}

function buildLlmInferenceMessagesSignature(messages: readonly LlmChatMessage[]): string {
  return JSON.stringify(messages.map((message) => ({
    role: message.role,
    content: message.content,
    mediaPaths: getLlmInferenceMessageMediaPaths(message),
  })));
}

function stripThreadInferenceAttachments(thread: ChatThread): ChatThread {
  if (!thread.messages.some((message) => message.attachments?.length)) {
    return thread;
  }

  return {
    ...thread,
    messages: thread.messages.map(omitInferenceAttachments),
  };
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

function throwMissingAttachment(
  messageId: string | undefined,
  attachment: Pick<AttachmentDraft, 'id' | 'pathCategory'>,
): never {
  throw new AppError(
    'chat_attachment_missing',
    'One or more selected image attachments are no longer available. Remove the image and try again.',
    {
      details: {
        ...(messageId ? { messageId } : null),
        attachmentId: attachment.id,
        pathCategory: attachment.pathCategory,
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

  for (const { draft, localUri, exists } of attachmentChecks) {
    if (!localUri || !exists) {
      throwMissingAttachment(undefined, {
        id: draft.id,
        pathCategory: draft.pathCategory,
      });
    }
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

  for (const { attachment, localUri, exists } of attachmentChecks) {
    if (!localUri || !exists) {
      throwMissingAttachment(message.id, attachment);
    }
  }
}

async function assertUserMessageAttachmentsReadyForRegeneration(
  message: ChatMessage,
  readiness?: MultimodalReadinessState,
): Promise<void> {
  if (!messageHasAttachments(message)) {
    return;
  }

  assertMultimodalReadyForInferenceAttachments([message], readiness);
  await assertMessageAttachmentFilesExist(message);
}

async function resolveLlmMessageAttachmentsForInference(
  message: LlmChatMessage,
  isLatestUserMessage: boolean,
  latestUserMessageId?: string | null,
  resolveAttachmentExists: (localUri: string) => Promise<boolean> = doesChatAttachmentFileExist,
): Promise<LlmChatMessage> {
  const attachments = message.attachments;
  if (!attachments?.length) {
    return message;
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
        throwMissingAttachment(latestUserMessageId ?? undefined, attachment);
      }
      continue;
    }

    if (localUri !== attachment.localUri) {
      didChangeAttachments = true;
      nextAttachments.push({ ...attachment, localUri });
    } else {
      nextAttachments.push(attachment);
    }
  }

  if (!didChangeAttachments && nextAttachments.length === attachments.length) {
    return message;
  }

  const mediaPaths = getChatImageAttachmentMediaPaths(nextAttachments);

  return {
    ...message,
    attachments: nextAttachments.length > 0 ? nextAttachments : undefined,
    mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
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
    || (message.mediaPaths?.length ?? 0) > 0
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
): Promise<LlmChatMessage[]> {
  const boundedMessages = constrainInferenceAttachmentsToRequestLimit(messages);
  if (!boundedMessages.some((message) => message.attachments?.length)) {
    return normalizeLlmInferenceMessagePairs(filterEmptyLlmInferenceMessages(boundedMessages));
  }

  if (!isVisionReady(multimodalReadiness)) {
    return normalizeLlmInferenceMessagePairs(filterEmptyLlmInferenceMessages(boundedMessages.map(omitLlmInferenceAttachments)));
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
    ),
  );

  assertMultimodalReadyForInferenceAttachments(resolvedMessages, multimodalReadiness);
  return normalizeLlmInferenceMessagePairs(filterEmptyLlmInferenceMessages(resolvedMessages));
}

async function resolveLatestUserMessageAttachmentsForInference(
  message: ChatMessage | undefined,
  readiness?: MultimodalReadinessState,
): Promise<void> {
  if (!message || !messageHasAttachments(message)) {
    return;
  }

  assertMultimodalReadyForInferenceAttachments([message], readiness);
  await assertMessageAttachmentFilesExist(message);
}

function assertMultimodalReadyForInferenceAttachments(
  messages: readonly { attachments?: readonly unknown[] }[],
  readiness?: MultimodalReadinessState,
): void {
  const attachmentCount = messages.reduce(
    (count, message) => count + (message.attachments?.length ?? 0),
    0,
  );

  if (attachmentCount === 0 || isVisionReady(readiness)) {
    return;
  }

  throw new AppError('multimodal_not_ready', 'Vision chat is not ready for image attachments.', {
    details: {
      readinessStatus: readiness?.status ?? 'unknown',
      attachmentCount,
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
    if (remainingSlots <= 0) {
      didConstrain = true;
      nextMessages[index] = withConstrainedInferenceAttachments(message, undefined);
      continue;
    }

    if (attachments.length > remainingSlots) {
      didConstrain = true;
      nextMessages[index] = withConstrainedInferenceAttachments(
        message,
        attachments.slice(attachments.length - remainingSlots),
      );
      retainedAttachmentCount = MAX_CHAT_IMAGE_ATTACHMENTS;
      continue;
    }

    retainedAttachmentCount += attachments.length;
  }

  return didConstrain ? nextMessages : messages as T[];
}

async function resolveThreadForInferenceAttachments({
  thread,
  latestUserMessageId,
  multimodalReadiness,
}: {
  thread: ChatThread;
  latestUserMessageId: string | null;
  multimodalReadiness?: MultimodalReadinessState;
}): Promise<ChatThread> {
  const latestUserMessage = latestUserMessageId
    ? thread.messages.find((message) => message.id === latestUserMessageId)
    : undefined;
  if (!isVisionReady(multimodalReadiness)) {
    await resolveLatestUserMessageAttachmentsForInference(latestUserMessage, multimodalReadiness);
    return stripThreadInferenceAttachments(thread);
  }

  await resolveLatestUserMessageAttachmentsForInference(latestUserMessage, multimodalReadiness);
  return thread;
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
      });

      const MESSAGE_TOO_LONG_ERROR_MESSAGE =
        'This message is too long for the current context window. Shorten it or increase the context size in Model Controls.';

      let forcedDisableThinking = false;
      let messages: LlmChatMessage[] = [];
      let promptTokens = 0;
      let promptSafetyMarginTokens = 0;
      const resolveAttachmentExistsForTokenCount = createChatAttachmentExistenceResolver();
      const mediaTokenDeltaCache = new Map<string, Promise<number>>();
      const exactPromptTokenCache = new Map<string, Promise<number>>();
      let selectedTokenCountParams = {
        enable_thinking: reasoningRuntimeConfig.enableThinking,
        reasoning_format: reasoningRuntimeConfig.reasoningFormat,
      };
      let didUseHeuristicPromptTokens = false;
      let didUseMediaDeltaPromptTokens = false;

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
        const cacheKey = buildPromptTokenCacheKey(messagesToCount, params);
        let cachedCount = options.bypassCache ? undefined : exactPromptTokenCache.get(cacheKey);
        if (!cachedCount) {
          cachedCount = llmEngineService.countPromptTokens({
            messages: messagesToCount,
            params,
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
        );
        throwIfGenerationStopped();

        const countResolvedMessages = async (messagesToCount: LlmChatMessage[]) => {
          return countExactPromptTokens(messagesToCount, params);
        };

        const mediaPaths = getLlmInferenceMessagesMediaPaths(resolvedWindowMessages);
        if (mediaPaths.length > 0) {
          const textOnlyMessages = resolvedWindowMessages.map(omitLlmInferenceAttachments);
          let textOnlyPromptTokens: number;
          try {
            textOnlyPromptTokens = await countResolvedMessages(textOnlyMessages);
          } catch {
            return countResolvedMessages(resolvedWindowMessages);
          }

          const mediaTokenCacheKey = [
            params.enable_thinking ? 'thinking' : 'plain',
            params.reasoning_format,
            mediaPaths.join('\u0000'),
          ].join('\u0001');
          let mediaTokenDelta = mediaTokenDeltaCache.get(mediaTokenCacheKey);

          if (!mediaTokenDelta) {
            mediaTokenDelta = (async () => {
              const mediaPromptTokens = await countResolvedMessages(resolvedWindowMessages);
              return Math.max(0, mediaPromptTokens - textOnlyPromptTokens);
            })();
            mediaTokenDeltaCache.set(mediaTokenCacheKey, mediaTokenDelta);
          }

          didUseMediaDeltaPromptTokens = true;
          const resolvedMediaTokenDelta = await mediaTokenDelta;
          throwIfGenerationStopped();
          return textOnlyPromptTokens + resolvedMediaTokenDelta;
        }

        return countResolvedMessages(resolvedWindowMessages);
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
      );
      throwIfGenerationStopped();
      const finalMessages = await resolveRetainedMessagesForInferenceAttachments(
        messages,
        effectiveMultimodalReadiness,
        latestUserMessageId,
      );
      throwIfGenerationStopped();
      const finalMessagesSignature = buildLlmInferenceMessagesSignature(finalMessages);
      const tokenCountResolvedMessagesSignature = buildLlmInferenceMessagesSignature(tokenCountResolvedMessages);
      const finalPromptTokenCacheKey = buildPromptTokenCacheKey(finalMessages, selectedTokenCountParams);
      const shouldRecountFinalPrompt = finalMessagesSignature !== tokenCountResolvedMessagesSignature
        || (
          didUseMediaDeltaPromptTokens
          && getLlmInferenceMessagesMediaPaths(finalMessages).length > 0
          && !exactPromptTokenCache.has(finalPromptTokenCacheKey)
        );
      if (shouldRecountFinalPrompt) {
        if (didUseHeuristicPromptTokens) {
          promptTokens = estimateLlmMessagesTokens(finalMessages);
        } else {
          throwIfGenerationStopped();
          promptTokens = await countExactPromptTokens(finalMessages, selectedTokenCountParams, {
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

      const availablePredictTokens = maxContextSize - promptTokens - promptSafetyMarginTokens;
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
    const attachmentDrafts = resolveReadyAttachmentDrafts({
      drafts: options.attachmentDrafts ?? [],
      readiness: options.multimodalReadiness,
    });

    const settings = getSettings();
    const activeModelId = settings.activeModelId;
    const activeModelParams = getGenerationParametersForModel(activeModelId);

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
    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: text,
      createdAt: Date.now(),
      state: 'complete',
      kind: 'message',
      modelId: threadModelId,
      ...(attachmentDrafts.length > 0
        ? {
            attachments: materializeAttachmentDraftsForMessage({
              threadId,
              messageId: userMessageId,
              drafts: attachmentDrafts,
            }),
          }
        : null),
    };

    appendMessage(threadId, userMessage);
    options.onUserMessageAppended?.(userMessage);

    const assistantMessageId = createAssistantPlaceholder(threadId, threadModelId);

    await runAssistantCompletion(threadId, assistantMessageId, {
      multimodalReadiness: options.multimodalReadiness,
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
    const { model } = resolveThreadReasoningRuntimeConfig(activeThread);
    await assertUserMessageAttachmentsReadyForRegeneration(
      targetMessage,
      options.multimodalReadiness ?? model?.multimodalReadiness,
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
      multimodalReadiness: options.multimodalReadiness,
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
    const { model } = resolveThreadReasoningRuntimeConfig(activeThread);
    await assertUserMessageAttachmentsReadyForRegeneration(
      lastUserMessage,
      model?.multimodalReadiness,
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

    await runAssistantCompletion(syncedThread.id, assistantMessageId);

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
