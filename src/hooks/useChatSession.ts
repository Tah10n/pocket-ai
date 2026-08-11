import { AppState, AppStateStatus } from 'react-native';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { AppError, getPrivacySafeErrorLogDetails, toAppError } from '../services/AppError';
import { EngineStatus } from '../types/models';
import { backgroundTaskService } from '../services/BackgroundTaskService';
import { notificationService } from '../services/NotificationService';
import { registry } from '../services/LocalStorageRegistry';
import {
  __resetChatGenerationServiceForTests,
  beginChatGenerationWork,
  hasActiveChatGenerationWork,
  isChatGenerationCancelledError,
  registerActiveChatGenerationStop,
  registerChatGenerationFallbackStop,
  stopAllGenerationWork,
  type ChatGenerationWorkHandle,
} from '../services/ChatGenerationService';
import { activateThreadForNavigation } from '../services/ChatThreadActivationService';
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
  flushChatStreamingProgressForAndroidQa,
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
  resolveBalancedResponseReserveTokens,
  resolveThreadInferenceWindowOptions,
  type InferenceBudgetOptions,
} from '../utils/inferenceWindow';
import {
  createIncrementalAssistantPresentationParser,
  doesAssistantContentEndAtSentenceBoundary,
  getAssistantPresentation,
  getVisibleAssistantContent,
} from '../utils/chatPresentation';
import { resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../utils/modelReasoningCapabilities';
import { syncThreadParameters } from '../utils/chatThreadParameters';
import { PrivateStorageUnavailableError, getPrivateStorageHealthSnapshot, isPrivateStorageWritable } from '../services/storage';
import { useTruncationTracking } from './useTruncationTracking';
import { markInteractiveWorkStarted } from '../utils/idleTask';
import {
  chatAttachmentStorageService,
  materializeAttachmentDraftsForMessage,
  materializeDocumentDraftsForProcessing,
  materializeMediaDraftsForMessage,
} from '../services/ChatAttachmentStorageService';
import {
  chatAttachmentProcessorRegistry,
  withProcessedDocumentAttachmentMetadata,
  type ChatDocumentSessionContextSource,
  type ChatDocumentTextProcessorResult,
  type PocketAnydocAssetLease,
} from '../services/ChatAttachmentProcessorRegistry';
import {
  DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES,
  documentSessionContextCache,
} from '../services/DocumentSessionContextCache';
import {
  rebuildDocumentContextSelection,
  selectDocumentContext,
  type DocumentContextInput,
  type DocumentContextSelection,
} from '../services/DocumentContextService';
import {
  POCKET_ANYDOC_MAX_SELECTION_CHARS,
  POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
  getCapabilities as getPocketAnydocCapabilities,
} from '../../modules/pocket-anydoc';
import { sanitizeMultimodalFailureReason } from '../utils/multimodalFailureReason';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  MAX_CHAT_IMAGE_ATTACHMENT_BYTES,
  getChatImageAttachmentMediaPaths,
  getSendableDraftImageAttachments,
  normalizeChatAttachmentLocalUri,
  resolveSupportedChatImageExtensionFromMimeType,
  toAttachmentMediaPath,
  validateChatImageAttachmentLimit,
  validateChatImageAttachmentBounds,
} from '../utils/chatImageAttachments';
import {
  getSendableDraftDocumentAttachments,
  getSendableDraftMediaAttachments,
  validateChatDocumentAttachmentLimit,
  validateChatMediaAttachmentLimit,
} from '../utils/chatAttachments';
import { buildLlmInferenceMessagesSignature } from '../utils/llmInferenceMessageSignature';
import {
  activateAndroidQaDocumentPreparationGate,
  activateAndroidQaGenerationAfterFirstDurableOutput,
  beginAndroidQaGeneration,
  buildAndroidQaPreparedGenerationEvidence,
  isAndroidQaGenerationEvidenceEnabled,
  isAndroidQaGenerationGateArmed,
  isAndroidQaGenerationHeld,
  recordAndroidQaPreparedGenerationEvidence,
  releaseAndroidQaGenerationGate,
  shouldHoldAndroidQaGenerationBeforeFirstOutput,
  waitForAndroidQaGenerationGateRelease,
} from '../services/AndroidQaGenerationEvidence';

export { SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES } from '../utils/inferenceWindow';
const DEFAULT_CONTEXT_SIZE = 4096;
export const INITIAL_STREAM_PATCH_INTERVAL_MS = 80;
export const DEFAULT_STREAM_PATCH_INTERVAL_MS = 140;
export const LONG_STREAM_PATCH_INTERVAL_MS = 320;
export const LONG_STREAM_PATCH_TOKEN_THRESHOLD = 64;
export const LONG_STREAM_PATCH_CHAR_THRESHOLD = 1200;
const ATTACHMENT_FILE_CHECK_CONCURRENCY = 8;
const DOCUMENT_PROCESSING_CONCURRENCY = 1;
const ESTIMATED_MEDIA_PROMPT_TOKENS_PER_INPUT = 576;
const EXACT_MEDIA_PROMPT_RECOUNT_MARGIN_TOKENS_PER_INPUT = 1024;

type ProcessedDocumentAttachmentDraftsForInference = {
  attachments: Extract<ChatAttachment, { kind: 'document' }>[];
  contentParts: LlmTextContentPart[];
  failures: DocumentAttachmentProcessingFailure[];
  /** Full processor results retained so exact-token/media recounts can reselect from every chunk. */
  candidates: ProcessedDocumentAttachmentCandidate[];
  /** The concrete post-selection chunks represented by attachments/contentParts. */
  selectedCandidates: ProcessedDocumentAttachmentCandidate[];
  allFailedError?: AppError;
};

type ProcessedDocumentAttachmentCandidate = {
  draft: ChatDocumentAttachmentDraft;
  attachment: Extract<ChatAttachment, { kind: 'document' }>;
  result: ChatDocumentTextProcessorResult;
};

type MaterializedDocumentImageDraft = {
  documentAttachmentId: string;
  assetId: number;
  draft: AttachmentDraft;
};

type RegenerationDocumentAttachmentInputs = {
  documentAttachments: Extract<ChatAttachment, { kind: 'document' }>[];
  documentDrafts: ChatDocumentAttachmentDraft[];
  retainedImageAttachments: NonNullable<ChatMessage['attachments']>;
  retainedOtherAttachments: NonNullable<ChatMessage['attachments']>;
};

export type DocumentAttachmentProcessingFailure = {
  draft: ChatDocumentAttachmentDraft;
  errorCode: AppError['code'];
};

type AttachmentFileResolution = {
  normalizedUri: string | null;
  exists: boolean;
};

type AttachmentCancellationGate = {
  getCancellationError: () => unknown;
  isCancellationRequested: () => boolean;
};

type AttachmentFileResolver = (
  (localUri: string) => Promise<AttachmentFileResolution>
) & {
  cancellationGate?: AttachmentCancellationGate;
};

type PreparedAttachmentResolution = {
  readonly readinessIdentity: string;
  readonly uniqueFilesystemLookupCount: number;
  readonly finalFilesystemLookupCount: number;
  readonly cancellationGate: AttachmentCancellationGate;
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
  inferenceRevision: number;
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

type PromptPreparationEngineSnapshot = {
  readonly modelId: string;
  readonly contextIdentity: string;
};

function assertThreadModelExecutionInvariant(
  threadId: string,
  expectedModelId?: string,
): ChatThread {
  const chatState = useChatStore.getState();
  const thread = chatState.getThread(threadId);
  if (!thread || chatState.activeThreadId !== threadId) {
    performanceMonitor.incrementCounter('chat.modelMismatchBlocked');
    throw new AppError(
      'chat_model_mismatch',
      'The active conversation changed before generation started.',
      {
        details: {
          expectedThreadModelId: expectedModelId ?? null,
          engineModelId: llmEngineService.getState().activeModelId ?? null,
        },
      },
    );
  }

  const threadModelId = getThreadActiveModelId(thread);
  if (threadModelId.length === 0) {
    performanceMonitor.incrementCounter('chat.modelMismatchBlocked');
    throw new AppError(
      'chat_model_not_loaded',
      'This conversation does not have a valid model.',
      {
        details: {
          expectedThreadModelId: null,
          engineModelId: llmEngineService.getState().activeModelId ?? null,
        },
      },
    );
  }

  if (expectedModelId !== undefined && threadModelId !== expectedModelId) {
    performanceMonitor.incrementCounter('chat.modelMismatchBlocked');
    throw new AppError(
      'chat_model_mismatch',
      'The conversation model changed before generation started.',
      {
        details: {
          expectedThreadModelId: expectedModelId,
          engineModelId: llmEngineService.getState().activeModelId ?? null,
        },
      },
    );
  }

  const engineState = llmEngineService.getState();
  if (engineState.status !== EngineStatus.READY || !engineState.activeModelId) {
    performanceMonitor.incrementCounter('chat.modelMismatchBlocked');
    throw new AppError(
      'chat_model_not_loaded',
      'The conversation model is not loaded.',
      {
        details: {
          expectedThreadModelId: threadModelId,
          engineModelId: engineState.activeModelId ?? null,
        },
      },
    );
  }

  if (engineState.activeModelId !== threadModelId) {
    performanceMonitor.incrementCounter('chat.modelMismatchBlocked');
    throw new AppError(
      'chat_model_mismatch',
      'The loaded model does not match the conversation model.',
      {
        details: {
          expectedThreadModelId: threadModelId,
          engineModelId: engineState.activeModelId,
        },
      },
    );
  }

  return thread;
}

function capturePromptPreparationEngineSnapshot(expectedModelId: string): PromptPreparationEngineSnapshot {
  const engineState = llmEngineService.getState();
  if (engineState.status !== EngineStatus.READY || engineState.activeModelId !== expectedModelId) {
    throw new AppError(
      engineState.activeModelId ? 'chat_model_mismatch' : 'chat_model_not_loaded',
      'The model context changed before prompt preparation started. Try again.',
      {
        details: {
          expectedThreadModelId: expectedModelId,
          engineModelId: engineState.activeModelId ?? null,
        },
      },
    );
  }

  return {
    modelId: expectedModelId,
    contextIdentity: llmEngineService.getPromptContextIdentity(),
  };
}

function assertPromptPreparationEngineSnapshotCurrent(snapshot: PromptPreparationEngineSnapshot): void {
  const engineState = llmEngineService.getState();
  if (
    engineState.status !== EngineStatus.READY
    || engineState.activeModelId !== snapshot.modelId
    || llmEngineService.getPromptContextIdentity() !== snapshot.contextIdentity
  ) {
    throw new AppError(
      'engine_not_ready',
      'The model context changed while preparing the prompt. Try again.',
    );
  }
}

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
  onDocumentAttachmentFailures?: (failures: readonly DocumentAttachmentProcessingFailure[]) => void;
  onPreparationCancelled?: () => void;
};

export type RegenerateUserMessageOptions = {
  multimodalReadiness?: MultimodalReadinessState;
};

const sharedGenerationState: { current: ActiveGenerationState | null } = {
  current: null,
};
const nativeCompletionSettlementListeners = new Set<() => void>();

function createPreparedAttachmentResolution(
  readiness: MultimodalReadinessState | undefined,
  expectedModelId: string | null,
): PreparedAttachmentResolution {
  const fileResolutionByInputUri = new Map<string, Promise<AttachmentFileResolution>>();
  const fileExistenceByNormalizedUri = new Map<string, Promise<boolean>>();
  const finalFileExistenceByNormalizedUri = new Map<string, Promise<boolean>>();
  let cancellationCheck: () => void = () => undefined;
  let cancellationError: unknown = null;
  let readinessIdentity = buildPromptMultimodalReadinessIdentity(readiness, expectedModelId);
  let uniqueFilesystemLookupCount = 0;
  let finalFilesystemLookupCount = 0;

  const cancellationGate: AttachmentCancellationGate = {
    getCancellationError: () => (
      cancellationError ?? new Error('Attachment preparation was cancelled.')
    ),
    isCancellationRequested: () => {
      if (cancellationError) {
        return true;
      }
      try {
        cancellationCheck();
        return false;
      } catch (error) {
        cancellationError = error;
        return true;
      }
    },
  };

  const resolveFile: AttachmentFileResolver = (localUri) => {
    if (cancellationGate.isCancellationRequested()) {
      return Promise.reject(cancellationGate.getCancellationError());
    }
    const existing = fileResolutionByInputUri.get(localUri);
    if (existing) {
      return existing;
    }
    const resolution = resolvePreparedAttachmentFile(localUri);
    fileResolutionByInputUri.set(localUri, resolution);
    return resolution;
  };
  resolveFile.cancellationGate = cancellationGate;

  const resolveFileForFinalValidation: AttachmentFileResolver = (localUri) => {
    if (cancellationGate.isCancellationRequested()) {
      return Promise.reject(cancellationGate.getCancellationError());
    }
    const normalizedUri = normalizeChatAttachmentLocalUri(localUri);
    if (!normalizedUri) {
      return Promise.resolve({ normalizedUri: null, exists: false });
    }

    let lookup = finalFileExistenceByNormalizedUri.get(normalizedUri);
    if (!lookup) {
      finalFilesystemLookupCount += 1;
      lookup = (async () => {
        const exists = await doesChatAttachmentFileExist(normalizedUri);
        cancellationGate.isCancellationRequested();
        return exists;
      })();
      finalFileExistenceByNormalizedUri.set(normalizedUri, lookup);
    }

    return lookup.then((exists) => ({ normalizedUri, exists }));
  };
  resolveFileForFinalValidation.cancellationGate = cancellationGate;

  return {
    cancellationGate,
    get readinessIdentity() {
      return readinessIdentity;
    },
    get uniqueFilesystemLookupCount() {
      return uniqueFilesystemLookupCount;
    },
    get finalFilesystemLookupCount() {
      return finalFilesystemLookupCount;
    },
    resolveFile,
    resolveFileForFinalValidation,
    setCancellationCheck: (check) => {
      cancellationCheck = check;
      cancellationError = null;
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
        cancellationGate.isCancellationRequested();
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

function toDocumentContextInputs(
  candidates: readonly ProcessedDocumentAttachmentCandidate[],
): DocumentContextInput[] {
  return candidates.map(({ attachment, result }) => ({
    attachmentId: attachment.id,
    displayName: attachment.displayName ?? attachment.fileName,
    canonicalFormat: result.canonicalFormat,
    chunks: result.chunks,
    sourceCharCount: result.sourceCharCount,
    truncated: result.truncated,
    warnings: result.warnings,
  }));
}

function applyDocumentContextSelection(
  candidates: readonly ProcessedDocumentAttachmentCandidate[],
  selectedContext: DocumentContextSelection,
  failures: readonly DocumentAttachmentProcessingFailure[],
): ProcessedDocumentAttachmentDraftsForInference {
  const selectedDocumentById = new Map(
    selectedContext.documents.map((document) => [document.attachmentId, document]),
  );
  const selectedResults = candidates.flatMap(({ draft, attachment, result }) => {
    const selection = selectedDocumentById.get(attachment.id);
    if (!selection) {
      return [];
    }
    const selectedChunkIndexes = new Set(selection.selectedChunkIndexes);
    const selectedChunks = result.chunks.filter((chunk) => selectedChunkIndexes.has(chunk.index));
    const selectedText = selectedChunks.map((chunk) => chunk.text).join('\n\n');
    const normalizedResult: ChatDocumentTextProcessorResult = {
      ...result,
      text: selectedText,
      chunks: selectedChunks,
      extractedCharCount: selection.selectedCharCount,
      selectedChunkCount: selection.selectedChunkIndexes.length,
      truncated: selection.truncated,
      warnings: selection.warnings,
    };
    return [{
      draft,
      attachment: withProcessedDocumentAttachmentMetadata(attachment, normalizedResult),
      result: normalizedResult,
    }];
  });
  const selectedAttachmentIds = new Set(selectedResults.map(({ attachment }) => attachment.id));
  const finalFailures = failures.filter(
    (failure) => failure.errorCode !== 'chat_attachment_too_large_for_context',
  );
  candidates.forEach(({ draft, attachment }) => {
    if (
      !selectedAttachmentIds.has(attachment.id)
      && !finalFailures.some((failure) => (
        failure.draft === draft || (draft.id && failure.draft.id === draft.id)
      ))
    ) {
      finalFailures.push({
        draft,
        errorCode: 'chat_attachment_too_large_for_context',
      });
    }
  });

  const allFailedError = candidates.length > 0 && selectedResults.length === 0
    ? new AppError(
        'chat_attachment_too_large_for_context',
        'No complete document context chunk fits the available document budget.',
      )
    : undefined;
  return {
    attachments: selectedResults.map((entry) => entry.attachment),
    contentParts: selectedContext.contentParts,
    failures: finalFailures,
    candidates: [...candidates],
    selectedCandidates: selectedResults,
    ...(allFailedError ? { allFailedError } : null),
  };
}

async function processDocumentAttachmentDraftsForInference(
  question: string,
  drafts: readonly ChatDocumentAttachmentDraft[],
  signal?: AbortSignal,
  cancellationGate?: AttachmentCancellationGate,
  retainNativeAssetLeases = false,
  onNativeAssetLeaseCreated?: (lease: PocketAnydocAssetLease) => void,
  retainSessionContextSources = false,
  onSessionContextSourceCreated?: (source: ChatDocumentSessionContextSource) => void,
  recoverSessionCachePressure?: () => Promise<boolean>,
): Promise<ProcessedDocumentAttachmentDraftsForInference> {
  if (drafts.length === 0) {
    return {
      attachments: [],
      contentParts: [],
      failures: [],
      candidates: [],
      selectedCandidates: [],
    };
  }

  if (retainSessionContextSources) {
    await documentSessionContextCache.reserveForIncomingDocuments(drafts.length);
    if (cancellationGate?.isCancellationRequested()) {
      throw cancellationGate.getCancellationError();
    }
  }

  const processingAttachments = materializeDocumentDraftsForProcessing({
    threadId: 'pending',
    messageId: 'pending',
    drafts,
  });
  const results = await mapWithConcurrency(
    processingAttachments,
    DOCUMENT_PROCESSING_CONCURRENCY,
    async (attachment: Extract<ChatAttachment, { kind: 'document' }>, index) => {
      let cachePressureAttempts = 0;
      while (true) {
        try {
          const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(attachment, {
            query: question,
            signal,
            maxChars: POCKET_ANYDOC_MAX_SELECTION_CHARS,
            maxChunks: POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
            retainNativeAssetLease: retainNativeAssetLeases,
            onNativeAssetLeaseCreated,
            retainSessionContextSource: retainSessionContextSources,
            onSessionContextSourceCreated,
          });
          return { status: 'fulfilled' as const, draft: drafts[index], attachment, result };
        } catch (error) {
          if (cancellationGate?.isCancellationRequested()) {
            throw cancellationGate.getCancellationError();
          }
          const appError = toAppError(error, 'chat_attachment_native_failed');
          if (appError.code === 'chat_attachment_processing_cancelled') {
            throw cancellationGate?.getCancellationError() ?? appError;
          }
          const cacheLimit = appError.details?.limit;
          const isNativeSessionCachePressure = retainSessionContextSources
            && appError.code === 'chat_attachment_document_resource_limit'
            && (cacheLimit === 'max_cache_entries' || cacheLimit === 'max_cache_bytes');
          if (isNativeSessionCachePressure && cachePressureAttempts < DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES) {
            const recovered = await documentSessionContextCache.evictLeastRecentlyUsed()
              || await recoverSessionCachePressure?.()
              || false;
            if (recovered) {
              cachePressureAttempts += 1;
              continue;
            }
          }
          return {
            status: 'rejected' as const,
            draft: drafts[index],
            error: appError,
          };
        }
      }
    },
    cancellationGate,
  );

  const fulfilled = results.filter((entry): entry is Extract<typeof entry, { status: 'fulfilled' }> => (
    entry.status === 'fulfilled'
  ));
  const rejected = results.filter((entry): entry is Extract<typeof entry, { status: 'rejected' }> => (
    entry.status === 'rejected'
  ));
  if (fulfilled.length === 0 && rejected.length > 0) {
    return {
      attachments: [],
      contentParts: [],
      failures: rejected.map(({ draft, error }) => ({ draft, errorCode: error.code })),
      candidates: [],
      selectedCandidates: [],
      allFailedError: rejected[0].error,
    };
  }

  const candidates: ProcessedDocumentAttachmentCandidate[] = fulfilled.map(({ draft, attachment, result }) => ({
    draft,
    attachment,
    result,
  }));
  const selectedContext = await selectDocumentContext({
    question,
    documents: toDocumentContextInputs(candidates),
    maxChars: POCKET_ANYDOC_MAX_SELECTION_CHARS,
    maxChunks: POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
  });
  return applyDocumentContextSelection(
    candidates,
    selectedContext,
    rejected.map(({ draft, error }) => ({ draft, errorCode: error.code })),
  );
}

function toSessionDocumentDraft(
  attachment: Extract<ChatAttachment, { kind: 'document' }>,
): ChatDocumentAttachmentDraft {
  return {
    id: attachment.id,
    pickerUri: attachment.localUri,
    localUri: attachment.localUri,
    pathCategory: attachment.pathCategory,
    fileName: attachment.fileName,
    displayName: attachment.displayName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    source: 'document_picker',
    createdAt: attachment.createdAt,
    copyStatus: 'copied',
  };
}

async function selectSessionDocumentContextForInference(
  threadId: string,
  question: string,
  signal?: AbortSignal,
  cancellationGate?: AttachmentCancellationGate,
  attachmentIds?: ReadonlySet<string>,
): Promise<ProcessedDocumentAttachmentDraftsForInference> {
  const selected = await documentSessionContextCache.selectThreadDocuments(
    threadId,
    {
      query: question,
      maxChars: POCKET_ANYDOC_MAX_SELECTION_CHARS,
      maxChunks: POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
      signal,
    },
    attachmentIds,
  );
  if (cancellationGate?.isCancellationRequested()) {
    throw cancellationGate.getCancellationError();
  }
  if (selected.length === 0) {
    return {
      attachments: [],
      contentParts: [],
      failures: [],
      candidates: [],
      selectedCandidates: [],
    };
  }
  const candidates: ProcessedDocumentAttachmentCandidate[] = selected.map(({ attachment, result }) => ({
    attachment,
    draft: toSessionDocumentDraft(attachment),
    result,
  }));
  const selectedContext = await selectDocumentContext({
    question,
    documents: toDocumentContextInputs(candidates),
    maxChars: POCKET_ANYDOC_MAX_SELECTION_CHARS,
    maxChunks: POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
  });
  return applyDocumentContextSelection(candidates, selectedContext, []);
}

async function combineDocumentContextForInference(
  question: string,
  groups: readonly ProcessedDocumentAttachmentDraftsForInference[],
): Promise<ProcessedDocumentAttachmentDraftsForInference> {
  const seenAttachmentIds = new Set<string>();
  const candidates = groups.flatMap((group) => group.candidates.filter(({ attachment }) => {
    if (seenAttachmentIds.has(attachment.id)) {
      return false;
    }
    seenAttachmentIds.add(attachment.id);
    return true;
  }));
  if (candidates.length === 0) {
    const allFailedError = groups.find((group) => group.allFailedError)?.allFailedError;
    return {
      attachments: [],
      contentParts: [],
      failures: groups.flatMap((group) => group.failures),
      candidates: [],
      selectedCandidates: [],
      ...(allFailedError ? { allFailedError } : null),
    };
  }
  const selectedContext = await selectDocumentContext({
    question,
    documents: toDocumentContextInputs(candidates),
    maxChars: POCKET_ANYDOC_MAX_SELECTION_CHARS,
    maxChunks: POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
  });
  return applyDocumentContextSelection(
    candidates,
    selectedContext,
    groups.flatMap((group) => group.failures),
  );
}

function projectDocumentContextSelection(
  processed: ProcessedDocumentAttachmentDraftsForInference,
  attachmentIds: ReadonlySet<string>,
  failureDrafts?: ReadonlySet<ChatDocumentAttachmentDraft>,
): ProcessedDocumentAttachmentDraftsForInference {
  const candidates = processed.candidates.filter(({ attachment }) => attachmentIds.has(attachment.id));
  const selectedCandidates = processed.selectedCandidates.filter(
    ({ attachment }) => attachmentIds.has(attachment.id),
  );
  const selection = rebuildDocumentContextSelection({
    documents: toDocumentContextInputs(candidates),
    selectedDocuments: selectedCandidates.map(({ attachment, result }) => ({
      attachmentId: attachment.id,
      selectedChunkIndexes: result.chunks.map((chunk) => chunk.index),
    })),
  });
  return applyDocumentContextSelection(
    candidates,
    selection,
    processed.failures.filter((failure) => (
      (failure.draft.id !== undefined && attachmentIds.has(failure.draft.id))
      || failureDrafts?.has(failure.draft) === true
    )),
  );
}

function throwIfDocumentAssetMaterializationCancelled(
  signal: AbortSignal | undefined,
  cancellationGate: AttachmentCancellationGate | undefined,
): void {
  if (cancellationGate?.isCancellationRequested()) {
    throw cancellationGate.getCancellationError();
  }
  if (signal?.aborted) {
    throw new AppError(
      'chat_attachment_processing_cancelled',
      'Document asset materialization was cancelled.',
    );
  }
}

function collectSelectedDocumentAssetKeys(
  processed: ProcessedDocumentAttachmentDraftsForInference,
): Set<string> {
  const keys = new Set<string>();
  processed.selectedCandidates.forEach(({ attachment, result }) => {
    result.chunks.forEach((chunk) => {
      chunk.assetIds?.forEach((assetId) => keys.add(`${attachment.id}:${assetId}`));
    });
  });
  return keys;
}

function finalizeSelectedDocumentAssetWarnings(
  processed: ProcessedDocumentAttachmentDraftsForInference,
  materialized: readonly MaterializedDocumentImageDraft[],
): ProcessedDocumentAttachmentDraftsForInference {
  const deliveredKeys = new Set(
    materialized.map((entry) => `${entry.documentAttachmentId}:${entry.assetId}`),
  );
  const selectedAssetIdsByAttachment = new Map<string, Set<number>>();
  processed.selectedCandidates.forEach(({ attachment, result }) => {
    const selectedAssetIds = new Set<number>();
    result.chunks.forEach((chunk) => {
      chunk.assetIds?.forEach((assetId) => selectedAssetIds.add(assetId));
    });
    selectedAssetIdsByAttachment.set(attachment.id, selectedAssetIds);
  });

  const updateResult = (
    attachmentId: string,
    result: ChatDocumentTextProcessorResult,
  ): ChatDocumentTextProcessorResult => {
    const selectedAssetIds = selectedAssetIdsByAttachment.get(attachmentId) ?? new Set<number>();
    const nativeWarnings = result.warnings ?? [];
    const deliveredEverySelectedAsset = [...selectedAssetIds].every(
      (assetId) => deliveredKeys.has(`${attachmentId}:${assetId}`),
    );
    // Asset descriptors outside the final selected chunks are already covered by context
    // truncation and must not create a false partial-vision warning. Preserve native semantic
    // warnings (for example unsupported_assets), but derive assets_skipped only from selected IDs.
    const warnings = nativeWarnings.filter((warning) => warning !== 'assets_skipped');
    if (selectedAssetIds.size > 0 && !deliveredEverySelectedAsset) {
      warnings.push('assets_skipped');
    }
    return {
      ...result,
      warnings: [...new Set(warnings)],
    };
  };

  const candidates = processed.candidates.map((candidate) => ({
      ...candidate,
      result: updateResult(candidate.attachment.id, candidate.result),
    }));
  const selectedCandidates = processed.selectedCandidates.map((candidate) => ({
      ...candidate,
      result: updateResult(candidate.attachment.id, candidate.result),
    }));
  const selectedContext = rebuildDocumentContextSelection({
    documents: toDocumentContextInputs(candidates),
    selectedDocuments: selectedCandidates.map(({ attachment, result }) => ({
      attachmentId: attachment.id,
      selectedChunkIndexes: result.chunks.map((chunk) => chunk.index),
    })),
  });
  return applyDocumentContextSelection(candidates, selectedContext, processed.failures);
}

async function materializeSelectedDocumentImageDrafts({
  processed,
  maxAssets,
  signal,
  cancellationGate,
  onDraftMaterialized,
}: {
  processed: ProcessedDocumentAttachmentDraftsForInference;
  maxAssets: number;
  signal?: AbortSignal;
  cancellationGate?: AttachmentCancellationGate;
  onDraftMaterialized: (entry: MaterializedDocumentImageDraft) => void;
}): Promise<MaterializedDocumentImageDraft[]> {
  if (maxAssets <= 0) {
    return [];
  }
  const queues = processed.selectedCandidates.flatMap(({ attachment, result }) => {
    const lease = result.nativeAssetLease;
    if (!lease) {
      return [];
    }
    const descriptorById = new Map(lease.assets.map((asset) => [asset.id, asset]));
    const seenAssetIds = new Set<number>();
    const linkedAssets = result.chunks.flatMap((chunk) => chunk.assetIds ?? [])
      .flatMap((assetId) => {
        if (seenAssetIds.has(assetId)) {
          return [];
        }
        seenAssetIds.add(assetId);
        const descriptor = descriptorById.get(assetId);
        if (
          !descriptor
          || !resolveSupportedChatImageExtensionFromMimeType(descriptor.mediaType)
          || !validateChatImageAttachmentBounds({
            size: descriptor.byteLength,
            width: descriptor.width,
            height: descriptor.height,
          }).ok
        ) {
          return [];
        }
        return [{ attachmentId: attachment.id, assetId, descriptor, lease }];
      });
    return linkedAssets.length > 0 ? [linkedAssets] : [];
  });
  const orderedCandidates = [] as (typeof queues)[number][number][];
  for (let queueIndex = 0; orderedCandidates.length < maxAssets; queueIndex += 1) {
    let found = false;
    queues.forEach((queue) => {
      const candidate = queue[queueIndex];
      if (candidate && orderedCandidates.length < maxAssets) {
        orderedCandidates.push(candidate);
        found = true;
      }
    });
    if (!found) {
      break;
    }
  }

  const materializedDrafts: MaterializedDocumentImageDraft[] = [];
  let remainingByteBudget = maxAssets * MAX_CHAT_IMAGE_ATTACHMENT_BYTES;
  for (const candidate of orderedCandidates) {
    if (candidate.descriptor.byteLength > remainingByteBudget) {
      continue;
    }
    throwIfDocumentAssetMaterializationCancelled(signal, cancellationGate);
    try {
      const materialized = await candidate.lease.materializeAsset(candidate.assetId, signal);
      throwIfDocumentAssetMaterializationCancelled(signal, cancellationGate);
      const copiedDraft = await chatAttachmentStorageService.copyImageAssetToDraft({
        uri: materialized.localUri,
        type: 'image',
        mimeType: materialized.mediaType,
        fileSize: materialized.byteLength,
        width: materialized.width,
        height: materialized.height,
      });
      const draft: AttachmentDraft = {
        ...copiedDraft,
        source: 'derived_processor',
        derivedFromAttachmentId: candidate.attachmentId,
        derivedFromAssetId: candidate.assetId,
      };
      try {
        // `generationWork.waitFor` intentionally detaches from slow work on stop. If copying
        // completes after that detach, clean the newly owned file locally before any ownership
        // callback can mutate state that the outer finally block has already drained.
        throwIfDocumentAssetMaterializationCancelled(signal, cancellationGate);
      } catch (error) {
        try {
          await chatAttachmentStorageService.discardDraft(draft);
        } catch (discardError) {
          console.warn('[ChatSession] Failed to discard a cancelled document image draft', {
            ...getPrivacySafeErrorLogDetails(discardError),
          });
        }
        throw error;
      }
      const entry = {
        documentAttachmentId: candidate.attachmentId,
        assetId: candidate.assetId,
        draft,
      };
      onDraftMaterialized(entry);
      materializedDrafts.push(entry);
      remainingByteBudget -= materialized.byteLength;
    } catch (error) {
      throwIfDocumentAssetMaterializationCancelled(signal, cancellationGate);
      console.warn('[ChatSession] Skipped a document image asset', {
        ...getPrivacySafeErrorLogDetails(error),
      });
    }
  }
  return materializedDrafts;
}

async function discardUnselectedDocumentImageDrafts(
  entries: readonly MaterializedDocumentImageDraft[],
  selectedAssetKeys: ReadonlySet<string>,
): Promise<MaterializedDocumentImageDraft[]> {
  const retained: MaterializedDocumentImageDraft[] = [];
  const discarded: MaterializedDocumentImageDraft[] = [];
  entries.forEach((entry) => {
    if (selectedAssetKeys.has(`${entry.documentAttachmentId}:${entry.assetId}`)) {
      retained.push(entry);
    } else {
      discarded.push(entry);
    }
  });
  if (discarded.length > 0) {
    await chatAttachmentStorageService.discardDrafts(discarded.map((entry) => entry.draft));
  }
  return retained;
}

async function releasePocketAnydocAssetLeases(
  leases: Iterable<PocketAnydocAssetLease>,
): Promise<void> {
  await documentSessionContextCache.releaseResources(
    Array.from(leases, (resource) => ({ resource })),
  );
}

async function releaseDocumentSessionContextSources(
  sources: Iterable<ChatDocumentSessionContextSource>,
): Promise<void> {
  await documentSessionContextCache.releaseResources(
    Array.from(sources, (resource) => ({ resource })),
  );
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
      details: getPrivacySafeErrorLogDetails(result.error),
    },
  );
}

async function settleActiveChatGenerationForStop(
  generation: ActiveGenerationState,
): Promise<void> {
  generation.stopRequested = true;
  notifyNativeCompletionSettlementChanged();
  releaseAndroidQaGenerationGate(generation.messageId);

  const settlementResult = generation.commitTerminalState
    ? generation.commitTerminalState()
    : useChatStore.getState().finalizeAssistantTurn(
        generation.threadId,
        generation.messageId,
        { outcome: 'stopped' },
      );
  if (settlementResult.status === 'persistence_failed') {
    throw createAssistantTurnPersistenceError(settlementResult);
  }

  if (
    sharedGenerationState.current === generation
    && !generation.nativeCompletionStarted
  ) {
    sharedGenerationState.current = null;
    notifyNativeCompletionSettlementChanged();
  }
}

registerChatGenerationFallbackStop({
  isActive: () => sharedGenerationState.current !== null,
  hasNativeCompletion: () => sharedGenerationState.current?.nativeCompletionStarted === true,
  stop: async () => {
    const generation = sharedGenerationState.current;
    if (generation) {
      await settleActiveChatGenerationForStop(generation);
    }
  },
});

function isMatchingGeneration(threadId: string, messageId: string) {
  return (
    sharedGenerationState.current?.threadId === threadId &&
    sharedGenerationState.current?.messageId === messageId
  );
}

function isNativeCompletionSettlingAfterStop() {
  const generation = sharedGenerationState.current;
  return generation?.stopRequested === true && generation.nativeCompletionStarted === true;
}

function subscribeNativeCompletionSettlement(listener: () => void): () => void {
  nativeCompletionSettlementListeners.add(listener);
  return () => nativeCompletionSettlementListeners.delete(listener);
}

function notifyNativeCompletionSettlementChanged(): void {
  nativeCompletionSettlementListeners.forEach((listener) => listener());
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
  __resetChatGenerationServiceForTests();
}

export function resetActiveChatGenerationRuntimeForPrivateStorageReset(): void {
  sharedGenerationState.current = null;
  notifyNativeCompletionSettlementChanged();
}

function ignorePrivateStorageUnavailableDuringRuntimeStop(error: unknown, scope: string): boolean {
  if (error instanceof PrivateStorageUnavailableError) {
    console.warn(`[ChatSession] Skipped persisting ${scope} while private storage is blocked`, {
      ...getPrivacySafeErrorLogDetails(error),
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
    notifyNativeCompletionSettlementChanged();
    releaseAndroidQaGenerationGate(generation.messageId);

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
          ...getPrivacySafeErrorLogDetails(settlementResult.error),
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
    notifyNativeCompletionSettlementChanged();
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

function collectThreadDocumentAttachmentIds(thread: ChatThread | null | undefined): Set<string> {
  const attachmentIds = new Set<string>();
  thread?.messages.forEach((message) => {
    message.attachments?.forEach((attachment) => {
      if (isGenericChatAttachment(attachment) && attachment.kind === 'document') {
        attachmentIds.add(attachment.id);
      }
    });
  });
  return attachmentIds;
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

function omitPersistedDocumentInferenceMaterial(
  message: ChatMessage,
  replacedAttachmentIds: ReadonlySet<string>,
): ChatMessage {
  if (
    message.role !== 'user'
    || !message.contentParts?.some((part) => part.type === 'text')
    || replacedAttachmentIds.size === 0
  ) {
    const retainedAttachments = message.attachments?.filter((attachment) => (
      !attachment.derivedFromAttachmentId
      || replacedAttachmentIds.has(attachment.derivedFromAttachmentId) === false
      || (isGenericChatAttachment(attachment) && attachment.kind !== 'image')
    ));
    if (retainedAttachments?.length === message.attachments?.length) {
      return message;
    }
    return {
      ...message,
      ...(retainedAttachments?.length ? { attachments: retainedAttachments } : { attachments: undefined }),
    };
  }
  const documentAttachments = (message.attachments ?? []).filter(
    (attachment): attachment is Extract<ChatAttachment, { kind: 'document' }> => (
      isGenericChatAttachment(attachment) && attachment.kind === 'document'
    ),
  );
  let documentPartIndex = 0;
  const { contentParts: _contentParts, ...messageWithoutContentParts } = message;
  const retainedContentParts = message.contentParts.filter((part) => {
    if (part.type !== 'text') {
      return true;
    }
    const documentAttachment = documentAttachments[documentPartIndex];
    documentPartIndex += 1;
    return !documentAttachment || !replacedAttachmentIds.has(documentAttachment.id);
  });
  const retainedAttachments = message.attachments?.filter((attachment) => (
    !attachment.derivedFromAttachmentId
    || replacedAttachmentIds.has(attachment.derivedFromAttachmentId) === false
    || (isGenericChatAttachment(attachment) && attachment.kind !== 'image')
  ));
  return {
    ...messageWithoutContentParts,
    ...(retainedContentParts.length > 0 ? { contentParts: retainedContentParts } : null),
    ...(retainedAttachments?.length ? { attachments: retainedAttachments } : { attachments: undefined }),
  };
}

function applyTransientSessionDocumentContext(
  thread: ChatThread,
  latestUserMessageId: string | null,
  contentParts: readonly LlmTextContentPart[],
  replacedAttachmentIds: ReadonlySet<string>,
  transientImageAttachments: NonNullable<ChatMessage['attachments']> = [],
): ChatThread {
  return {
    ...thread,
    messages: thread.messages.map((message) => {
      const messageWithoutPersistedDocuments = omitPersistedDocumentInferenceMaterial(
        message,
        replacedAttachmentIds,
      );
      if (message.id !== latestUserMessageId) {
        return messageWithoutPersistedDocuments;
      }
      const retainedContentParts = messageWithoutPersistedDocuments.contentParts ?? [];
      return {
        ...messageWithoutPersistedDocuments,
        contentParts: [...contentParts, ...retainedContentParts],
        ...(transientImageAttachments.length > 0
          ? {
              attachments: [
                ...(messageWithoutPersistedDocuments.attachments ?? []),
                ...transientImageAttachments,
              ],
            }
          : null),
      };
    }),
  };
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
  cancellationGate?: AttachmentCancellationGate,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      if (cancellationGate?.isCancellationRequested()) {
        return;
      }
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));

  if (cancellationGate?.isCancellationRequested()) {
    // The owning generationWork waiter delivers the cancellation to the active
    // pipeline. Returning only completed items lets already-started workers
    // settle without producing a second, detached rejection.
    return results.filter((result): result is R => result !== undefined);
  }

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
    resolveAttachmentFile.cancellationGate,
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
    resolveAttachmentFile.cancellationGate,
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
    resolveAttachmentFile.cancellationGate,
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
    resolveAttachmentFile.cancellationGate,
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
    resolveAttachmentFile.cancellationGate,
  );

  assertMultimodalReadyForInferenceAttachments(resolvedMessages, multimodalReadiness, expectedModelId);
  assertAudioReadyForLlmMessages(resolvedMessages, multimodalReadiness, expectedModelId);
  return normalizeLlmInferenceMessagePairs(filterEmptyLlmInferenceMessages(resolvedMessages));
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

function getRegenerationDocumentAttachmentInputs(
  message: ChatMessage,
): RegenerationDocumentAttachmentInputs {
  const attachments = message.attachments ?? [];
  const documentAttachments = attachments.filter((attachment): attachment is Extract<ChatAttachment, { kind: 'document' }> => (
    isGenericChatAttachment(attachment) && attachment.kind === 'document'
  ));
  const documentAttachmentIds = new Set(documentAttachments.map((attachment) => attachment.id));
  const retainedAttachments = attachments.filter((attachment) => (
    !documentAttachmentIds.has(attachment.id)
    && !(
      attachment.source === 'derived_processor'
      && attachment.derivedFromAttachmentId !== undefined
      && documentAttachmentIds.has(attachment.derivedFromAttachmentId)
    )
  ));

  return {
    documentAttachments,
    documentDrafts: documentAttachments.map((attachment) => ({
      id: attachment.id,
      pickerUri: attachment.localUri,
      localUri: attachment.localUri,
      pathCategory: attachment.pathCategory,
      fileName: attachment.fileName,
      displayName: attachment.displayName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      source: 'document_picker',
      createdAt: attachment.createdAt,
      copyStatus: 'copied',
    })),
    retainedImageAttachments: retainedAttachments.filter(isInferenceImageAttachment),
    retainedOtherAttachments: retainedAttachments.filter((attachment) => !isInferenceImageAttachment(attachment)),
  };
}

async function refineDocumentContextWithExactPromptBudget({
  question,
  processed,
  baseThread,
  provisionalUserMessage,
  multimodalReadiness,
  expectedModelId,
  attachmentResolution,
  generationWork,
  replacePersistedDocumentAttachmentIds,
}: {
  question: string;
  processed: ProcessedDocumentAttachmentDraftsForInference;
  baseThread: ChatThread;
  provisionalUserMessage: ChatMessage;
  multimodalReadiness?: MultimodalReadinessState;
  expectedModelId: string;
  attachmentResolution: PreparedAttachmentResolution;
  generationWork: ChatGenerationWorkHandle;
  replacePersistedDocumentAttachmentIds?: ReadonlySet<string>;
}): Promise<ProcessedDocumentAttachmentDraftsForInference> {
  if (processed.candidates.length === 0) {
    return processed;
  }

  const { runtimeConfig } = resolveThreadReasoningRuntimeConfig(baseThread);
  const maxContextTokens = typeof llmEngineService.getContextSize === 'function'
    ? llmEngineService.getContextSize()
    : DEFAULT_CONTEXT_SIZE;
  const windowOptions = resolveThreadInferenceWindowOptions(baseThread, {
    maxContextTokens,
    responseReserveTokens: runtimeConfig.responseReserveTokens,
  });
  const tokenCountParams = {
    enable_thinking: runtimeConfig.enableThinking,
    reasoning_format: runtimeConfig.reasoningFormat,
  };
  const countResolvedMessages = async (messages: readonly LlmChatMessage[]): Promise<number> => {
    generationWork.assertCurrent();
    const resolvedMessages = await generationWork.waitFor(
      resolveRetainedMessagesForInferenceAttachments(
        messages,
        multimodalReadiness,
        provisionalUserMessage.id,
        attachmentResolution.resolveFile,
        expectedModelId,
      ),
    );
    generationWork.assertCurrent();
    return generationWork.waitFor(llmEngineService.countPromptTokens({
      messages: resolvedMessages,
      params: tokenCountParams,
      multimodalReadiness,
      expectedModelId,
    }));
  };

  // Freeze the exact-token history window without document text first. Chunk backoff then
  // preserves that system/question/history budget instead of replacing removed document chunks
  // with older turns on every recount.
  const baseUserMessage: ChatMessage = {
    ...provisionalUserMessage,
    contentParts: undefined,
  };
  const documentContextBaseThread = replacePersistedDocumentAttachmentIds
    ? {
        ...baseThread,
        messages: baseThread.messages.map((message) => omitPersistedDocumentInferenceMaterial(
          message,
          replacePersistedDocumentAttachmentIds,
        )),
      }
    : baseThread;
  const baseWindow = await buildInferenceWindowWithAccurateTokenCounts(
    {
      ...documentContextBaseThread,
      messages: [...documentContextBaseThread.messages, baseUserMessage],
    },
    windowOptions,
    (messages) => countResolvedMessages(messages),
    { throwIfCancelled: generationWork.assertCurrent },
  );
  const latestUserIndex = getLatestUserLlmMessageIndex(baseWindow.messages);
  if (latestUserIndex < 0) {
    throw new AppError('message_too_long', 'The document question cannot fit in the current context window.');
  }
  const totalPromptBudget = Math.max(
    0,
    maxContextTokens - baseWindow.promptSafetyMarginTokens,
  );
  const reservedResponseTokens = resolveBalancedResponseReserveTokens(
    runtimeConfig.responseReserveTokens,
    totalPromptBudget,
  );
  const maxPromptTokens = Math.max(1, totalPromptBudget - reservedResponseTokens);
  const selectedContext = await selectDocumentContext({
    question,
    documents: toDocumentContextInputs(processed.candidates),
    maxChars: POCKET_ANYDOC_MAX_SELECTION_CHARS,
    maxChunks: POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
    maxPromptTokens,
    countPromptTokens: async (contentParts) => {
      const candidateMessages = baseWindow.messages.map((message, index) => (
        index === latestUserIndex
          ? { ...message, contentParts: [...contentParts] }
          : message
      ));
      return countResolvedMessages(candidateMessages);
    },
  });
  return applyDocumentContextSelection(
    processed.candidates,
    selectedContext,
    processed.failures,
  );
}

function throwIfRegeneratedDocumentWasDropped(
  processed: ProcessedDocumentAttachmentDraftsForInference,
): void {
  const failure = processed.failures[0];
  if (!failure) {
    return;
  }

  throw new AppError(
    failure.errorCode,
    'A retained document could not be reprocessed for the edited question.',
  );
}

async function prepareRegeneratedDocumentInferenceContent({
  question,
  documentDrafts,
  retainedAttachments,
  baseThread,
  targetMessage,
  multimodalReadiness,
  expectedModelId,
  attachmentResolution,
  generationWork,
  signal,
  nativeAssetLeases,
  onDraftMaterialized,
}: {
  question: string;
  documentDrafts: readonly ChatDocumentAttachmentDraft[];
  retainedAttachments: NonNullable<ChatMessage['attachments']>;
  baseThread: ChatThread;
  targetMessage: ChatMessage;
  multimodalReadiness?: MultimodalReadinessState;
  expectedModelId: string;
  attachmentResolution: PreparedAttachmentResolution;
  generationWork: ChatGenerationWorkHandle;
  signal: AbortSignal;
  nativeAssetLeases: Set<PocketAnydocAssetLease>;
  onDraftMaterialized: (entry: MaterializedDocumentImageDraft) => void;
}): Promise<{
  processed: ProcessedDocumentAttachmentDraftsForInference;
  materializedImages: MaterializedDocumentImageDraft[];
  multimodalReadiness?: MultimodalReadinessState;
}> {
  const retainedImageMediaPaths = getChatImageAttachmentMediaPaths(retainedAttachments);
  const remainingDocumentImageSlots = Math.max(
    0,
    MAX_CHAT_IMAGE_ATTACHMENTS - retainedImageMediaPaths.length,
  );
  let effectiveMultimodalReadiness = multimodalReadiness;
  let retainNativeDocumentAssetLeases = false;
  if (
    remainingDocumentImageSlots > 0
    && isVisionReady(effectiveMultimodalReadiness, expectedModelId)
  ) {
    const capabilities = await generationWork.waitFor(getPocketAnydocCapabilities());
    generationWork.assertCurrent();
    retainNativeDocumentAssetLeases = capabilities.available && capabilities.supportsAssets;
  }

  let processed = await generationWork.waitFor(
    processDocumentAttachmentDraftsForInference(
      question,
      documentDrafts,
      signal,
      attachmentResolution.cancellationGate,
      retainNativeDocumentAssetLeases,
      (lease) => nativeAssetLeases.add(lease),
    ),
  );
  if (processed.allFailedError) {
    throw processed.allFailedError;
  }
  throwIfRegeneratedDocumentWasDropped(processed);

  const provisionalDocumentAttachments = processed.attachments.map((attachment) => ({
    ...attachment,
    threadId: baseThread.id,
    messageId: targetMessage.id,
  }));
  const provisionalUserMessage: ChatMessage = {
    ...targetMessage,
    content: question || DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER,
    modelId: expectedModelId,
    attachments: [...retainedAttachments, ...provisionalDocumentAttachments],
    contentParts: processed.contentParts,
  };
  processed = await generationWork.waitFor(
    refineDocumentContextWithExactPromptBudget({
      question,
      processed,
      baseThread,
      provisionalUserMessage,
      multimodalReadiness: effectiveMultimodalReadiness,
      expectedModelId,
      attachmentResolution,
      generationWork,
    }),
  );
  if (processed.allFailedError) {
    throw processed.allFailedError;
  }
  throwIfRegeneratedDocumentWasDropped(processed);

  let materializedImages: MaterializedDocumentImageDraft[] = [];
  if (retainNativeDocumentAssetLeases && nativeAssetLeases.size > 0) {
    materializedImages = await materializeSelectedDocumentImageDrafts({
      processed,
      maxAssets: remainingDocumentImageSlots,
      signal,
      cancellationGate: attachmentResolution.cancellationGate,
      onDraftMaterialized,
    });
    generationWork.assertCurrent();
    const textSelectedDocuments = processed;
    let budgetedImages = [...materializedImages];
    while (true) {
      const imageDrafts = budgetedImages.map((entry) => entry.draft);
      const imageMediaPaths = getDraftImageAttachmentMediaPaths(imageDrafts);
      if (imageMediaPaths.length > 0) {
        effectiveMultimodalReadiness = assertActiveMultimodalReadyForAttachmentMediaPaths({
          mediaPaths: imageMediaPaths,
          multimodalReadiness: effectiveMultimodalReadiness,
          expectedModelId,
          mediaPathOccurrenceCount: retainedImageMediaPaths.length + imageMediaPaths.length,
        });
        attachmentResolution.updateReadinessIdentity(
          effectiveMultimodalReadiness,
          expectedModelId,
        );
      }
      const provisionalImageAttachments = materializeAttachmentDraftsForMessage({
        threadId: baseThread.id,
        messageId: targetMessage.id,
        drafts: imageDrafts,
      });
      try {
        const mediaBudgetSelection = await generationWork.waitFor(
          refineDocumentContextWithExactPromptBudget({
            question,
            processed: finalizeSelectedDocumentAssetWarnings(
              textSelectedDocuments,
              budgetedImages,
            ),
            baseThread,
            provisionalUserMessage: {
              ...provisionalUserMessage,
              attachments: [
                ...retainedAttachments,
                ...provisionalDocumentAttachments,
                ...provisionalImageAttachments,
              ],
            },
            multimodalReadiness: effectiveMultimodalReadiness,
            expectedModelId,
            attachmentResolution,
            generationWork,
          }),
        );
        generationWork.assertCurrent();
        const retainedDocumentIds = new Set(
          mediaBudgetSelection.selectedCandidates.map(({ attachment }) => attachment.id),
        );
        const droppedDocumentForMedia = textSelectedDocuments.selectedCandidates.some(
          ({ attachment }) => !retainedDocumentIds.has(attachment.id),
        );
        if (droppedDocumentForMedia && budgetedImages.length > 0) {
          const removed = budgetedImages.at(-1)!;
          await chatAttachmentStorageService.discardDraft(removed.draft);
          budgetedImages = budgetedImages.slice(0, -1);
          processed = textSelectedDocuments;
          continue;
        }
        processed = mediaBudgetSelection;
        break;
      } catch (error) {
        throwIfDocumentAssetMaterializationCancelled(
          signal,
          attachmentResolution.cancellationGate,
        );
        const appError = toAppError(error);
        if (
          budgetedImages.length === 0
          || (
            appError.code !== 'message_too_long'
            && appError.code !== 'chat_attachment_too_large_for_context'
          )
        ) {
          throw error;
        }
        const removed = budgetedImages.at(-1)!;
        await chatAttachmentStorageService.discardDraft(removed.draft);
        budgetedImages = budgetedImages.slice(0, -1);
        processed = textSelectedDocuments;
      }
    }
    materializedImages = await discardUnselectedDocumentImageDrafts(
      budgetedImages,
      collectSelectedDocumentAssetKeys(processed),
    );
  }

  throwIfRegeneratedDocumentWasDropped(processed);

  return {
    processed: finalizeSelectedDocumentAssetWarnings(processed, materializedImages),
    materializedImages,
    multimodalReadiness: effectiveMultimodalReadiness,
  };
}

function resolveSuccessfulAssistantContent({
  completionContent,
  completionText,
  preferRawSnapshot,
  streamedContent,
  rawSnapshot,
}: {
  completionContent: string | null | undefined;
  completionText: string | undefined;
  preferRawSnapshot: boolean;
  streamedContent: string;
  rawSnapshot: string | undefined;
}): string {
  if (completionContent !== undefined) {
    return completionContent ?? '';
  }
  if (completionText !== undefined) {
    return getVisibleAssistantContent(completionText);
  }
  if (preferRawSnapshot && rawSnapshot !== undefined) {
    return getVisibleAssistantContent(rawSnapshot);
  }

  return streamedContent;
}

function resolveSuccessfulAssistantThought({
  completionContent,
  completionReasoningContent,
  completionText,
  streamedThoughtContent,
}: {
  completionContent: string | null | undefined;
  completionReasoningContent: string | null | undefined;
  completionText: string | undefined;
  streamedThoughtContent: string;
}): string {
  if (completionReasoningContent !== undefined) {
    return completionReasoningContent ?? '';
  }
  if (completionContent === undefined && completionText !== undefined) {
    return getAssistantPresentation(completionText).thoughtContent;
  }

  return streamedThoughtContent;
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
  const isStoppingGeneration = useSyncExternalStore(
    subscribeNativeCompletionSettlement,
    isNativeCompletionSettlingAfterStop,
    isNativeCompletionSettlingAfterStop,
  );
  const [isPreparingDocuments, setIsPreparingDocuments] = useState(false);
  const isMountedRef = useRef(true);
  const documentPreparationAbortControllersRef = useRef(new Set<AbortController>());
  const activeThread = useChatStore((state) => state.getActiveThread());
  const messageListRevision = useChatStore((state) => state.streamingRevision);
  const inferenceRevision = useChatStore((state) => state.inferenceRevision);
  const createThread = useChatStore((state) => state.createThread);
  const appendMessage = useChatStore((state) => state.appendMessage);
  const createAssistantPlaceholder = useChatStore((state) => state.createAssistantPlaceholder);
  const deleteMessageBranch = useChatStore((state) => state.deleteMessageBranch);
  const deleteThreadState = useChatStore((state) => state.deleteThread);
  const finalizeAssistantTurn = useChatStore((state) => state.finalizeAssistantTurn);
  const patchAssistantMessage = useChatStore((state) => state.patchAssistantMessage);
  const replaceBranchFromUserMessage = useChatStore((state) => state.replaceBranchFromUserMessage);
  const replaceLastAssistantMessage = useChatStore((state) => state.replaceLastAssistantMessage);
  const renameThreadState = useChatStore((state) => state.renameThread);
  const beginNewThread = useChatStore((state) => state.beginNewThread);
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

  const truncationState = useTruncationTracking(
    activeThread,
    activeContextTokenBudget,
    inferenceRevision,
  );
  const appStateRef = useRef<AppStateStatus>(AppState.currentState ?? 'active');
  useEffect(() => {
    isMountedRef.current = true;
    const documentPreparationAbortControllers = documentPreparationAbortControllersRef.current;
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const previousAppState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (nextAppState === 'background' || nextAppState === 'inactive') {
        try {
          sharedGenerationState.current?.flushPendingAssistantPatch?.();
        } catch (error) {
          if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'background assistant patch')) {
            console.warn(
              '[ChatSession] Failed to flush background assistant patch',
              getPrivacySafeErrorLogDetails(error),
            );
          }
        }
        try {
          flushPendingChatPersistenceWrites('background');
        } catch (error) {
          if (!ignorePrivateStorageUnavailableDuringRuntimeStop(error, 'background chat persistence')) {
            console.warn(
              '[ChatSession] Failed to flush background chat persistence',
              getPrivacySafeErrorLogDetails(error),
            );
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
            notifyNativeCompletionSettlementChanged();
            console.warn('[ChatSession] Foreground recovery is waiting for private storage', {
              ...getPrivacySafeErrorLogDetails(result.error),
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
            notifyNativeCompletionSettlementChanged();
            console.warn('[ChatSession] Foreground orphan recovery is waiting for private storage', {
              ...getPrivacySafeErrorLogDetails(result.error),
            });
          }
        }
      }
    });

    return () => {
      isMountedRef.current = false;
      documentPreparationAbortControllers.forEach((controller) => controller.abort());
      documentPreparationAbortControllers.clear();
      subscription.remove();
    };
  }, []);

  const runAssistantCompletion = useCallback(async (
    threadId: string,
    assistantMessageId: string,
    completionOptions: {
      expectedModelId?: string;
      multimodalReadiness?: MultimodalReadinessState;
      attachmentResolution?: PreparedAttachmentResolution;
      generationWork?: ChatGenerationWorkHandle;
      transientDocumentContentParts?: readonly LlmTextContentPart[];
      transientDocumentAttachmentIds?: readonly string[];
      transientDocumentImageAttachments?: NonNullable<ChatMessage['attachments']>;
      onTerminalSettlement?: (result: AssistantTurnCommitResult) => void;
    } = {},
  ) => {
    const storedThread = assertThreadModelExecutionInvariant(
      threadId,
      completionOptions.expectedModelId,
    );
    if (!storedThread) {
      throw new Error('Thread not found');
    }
    const inferenceRevisionAtPromptStart = useChatStore.getState().inferenceRevision;

    const latestUserMessageId = findLatestUserMessageIdBeforeAssistant(storedThread, assistantMessageId);
    let thread = storedThread;

    const modelId = completionOptions.expectedModelId ?? getThreadActiveModelId(storedThread);

    performanceMonitor.mark('chat.send.start', { modelId });
    const generationSpan = performanceMonitor.startSpan('chat.generation', { modelId });

    const generationState: ActiveGenerationState = {
      threadId,
      messageId: assistantMessageId,
      stopRequested: false,
      nativeCompletionStarted: false,
    };
    sharedGenerationState.current = generationState;
    notifyNativeCompletionSettlementChanged();
    let unregisterGenerationStop: () => void = () => undefined;
    const isAndroidQaEvidenceEnabled = isAndroidQaGenerationEvidenceEnabled();
    if (isAndroidQaEvidenceEnabled) {
      beginAndroidQaGeneration(assistantMessageId);
    }

    const throwIfGenerationStopped = () => {
      completionOptions.generationWork?.assertCurrent();
      if (generationState.stopRequested) {
        throw new Error('Generation was stopped before native completion started.');
      }
      assertThreadModelExecutionInvariant(threadId, modelId);
      if (useChatStore.getState().inferenceRevision !== inferenceRevisionAtPromptStart) {
        throw new AppError(
          'action_failed',
          'The conversation changed while preparing the prompt. Try again.',
        );
      }
    };
    const promptPreparationSpan = performanceMonitor.isEnabled()
      ? performanceMonitor.startSpan('chat.prompt.total')
      : null;
    const waitForGenerationWork = <T>(promise: Promise<T>): Promise<T> => (
      completionOptions.generationWork?.waitFor(promise) ?? promise
    );
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
    let latestRawAssistantSnapshot: string | undefined;
    let latestRawAssistantSnapshotRevision = 0;
    let latestPresentationUpdateRevision = 0;
    let streamingCallbackRevision = 0;
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

      performanceMonitor.setGauge('chat.tokensPerSec', tokensPerSec);

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

    const canMutateAssistantMessage = (options?: { allowStopped?: boolean }) => {
      const chatState = useChatStore.getState();
      const currentThread = chatState.getThread(threadId);
      return (
        isMatchingGeneration(threadId, assistantMessageId)
        && chatState.activeThreadId === threadId
        && currentThread != null
        && getThreadActiveModelId(currentThread) === modelId
        && (options?.allowStopped === true || !generationState.stopRequested)
      );
    };

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
        const isFirstDurableAssistantPatch = !hasFlushedFirstAssistantPatch;
        hasFlushedFirstAssistantPatch = true;
        lastFlushedVisibleRevision = presentationParser.getVisibleContentRevision();
        if (
          isFirstDurableAssistantPatch
          && isAndroidQaEvidenceEnabled
          && isAndroidQaGenerationGateArmed('after-first-durable-output')
        ) {
          if (!flushChatStreamingProgressForAndroidQa(threadId, assistantMessageId)) {
            throw new Error('Unable to verify the first durable Android QA generation patch.');
          }
          activateAndroidQaGenerationAfterFirstDurableOutput(assistantMessageId);
        }
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
        completionOptions.onTerminalSettlement?.(terminalSettlement.result);
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
      completionOptions.onTerminalSettlement?.(terminalSettlement.result);
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

    let releasePromptPreparation: (() => void) | null = null;
    unregisterGenerationStop = registerActiveChatGenerationStop({
      hasNativeCompletion: () => generationState.nativeCompletionStarted,
      stop: () => settleActiveChatGenerationForStop(generationState),
    });
    try {
      releasePromptPreparation = llmEngineService.beginPromptPreparation();
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

      await waitForGenerationWork(backgroundTaskService.startBackgroundInference(modelName));

      unsubscribeExpiration = backgroundTaskService.subscribeToExpiration(() => {
        if (!isMatchingGeneration(threadId, assistantMessageId)) {
          return;
        }

        try {
          generationState.stopRequested = true;
          notifyNativeCompletionSettlementChanged();
          releaseAndroidQaGenerationGate(assistantMessageId);
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
            console.warn(
              '[ChatSession] Failed to stop expired completion',
              getPrivacySafeErrorLogDetails(error),
            );
          });
        }
      });

      // Capability filtering is metadata-only and safe across the full thread.
      // Filesystem validation begins only after the conservative window is selected.
      thread = stripUnsupportedThreadInferenceAttachments(
        storedThread,
        effectiveMultimodalReadiness,
        activeModelId,
      );
      if (
        completionOptions.transientDocumentAttachmentIds?.length
        && (
          completionOptions.transientDocumentContentParts
          || completionOptions.transientDocumentImageAttachments?.length
        )
      ) {
        thread = applyTransientSessionDocumentContext(
          thread,
          latestUserMessageId,
          completionOptions.transientDocumentContentParts ?? [],
          new Set(completionOptions.transientDocumentAttachmentIds),
          completionOptions.transientDocumentImageAttachments ?? [],
        );
      }
      const windowOptions = resolveThreadInferenceWindowOptions(thread, {
        maxContextTokens: maxContextSize,
        responseReserveTokens: reasoningRuntimeConfig.responseReserveTokens,
      });

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

        const attachmentPreparationSpan = performanceMonitor.isEnabled()
          ? performanceMonitor.startSpan('chat.prompt.attachments')
          : null;
        const filesystemLookupsAtStart = attachmentResolution.uniqueFilesystemLookupCount;
        let preparation!: Promise<LlmChatMessage[]>;
        preparation = resolveRetainedMessagesForInferenceAttachments(
          windowMessages,
          effectiveMultimodalReadiness,
          latestUserMessageId,
          attachmentResolution.resolveFile,
          activeModelId,
        ).then(
          (resolvedMessages) => {
            attachmentPreparationSpan?.end({
              outcome: 'success',
              uniqueFilesystemLookups:
                attachmentResolution.uniqueFilesystemLookupCount - filesystemLookupsAtStart,
            });
            return resolvedMessages;
          },
          (error) => {
            attachmentPreparationSpan?.end({
              outcome: 'error',
              uniqueFilesystemLookups:
                attachmentResolution.uniqueFilesystemLookupCount - filesystemLookupsAtStart,
            });
            if (preparedMessagesBySignature.get(preparationKey) === preparation) {
              preparedMessagesBySignature.delete(preparationKey);
            }
            throw error;
          },
        );
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
        const resolvedWindowMessages = await waitForGenerationWork(
          resolvePreparedMessages(windowMessages),
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

        // A prompt-semantic mutation can arrive while native tokenization is
        // pending. It must abort this preparation instead of being mistaken
        // for a tokenizer failure and continuing through the heuristic path.
        throwIfGenerationStopped();

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
            ...getPrivacySafeErrorLogDetails(error),
          });
          didUseHeuristicPromptTokens = true;
          messages = await waitForGenerationWork(
            resolvePreparedMessages(getThreadInferenceWindow(thread, windowOptions).messages),
          );
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
            inferenceRevision: inferenceRevisionAtPromptStart,
            messageSignature,
            tokenCountSource,
            attachmentResolution,
          };
        };

        const preparedMessages = await waitForGenerationWork(resolvePreparedMessages(messages));
        throwIfGenerationStopped();
        preparedRequest = await waitForGenerationWork(
          buildPreparedRequest(preparedMessages, promptTokens),
        );

        const latestPreparedUserMessageIndex = getLatestUserLlmMessageIndex(preparedRequest.messages);
        const latestPreparedUserMessage = preparedRequest.messages[latestPreparedUserMessageIndex];
        if (latestPreparedUserMessage?.attachments?.length) {
          const revalidatedLatestUserMessage = await waitForGenerationWork(
            resolveLlmMessageAttachmentsForInference(
              latestPreparedUserMessage,
              true,
              latestUserMessageId,
              attachmentResolution.resolveFileForFinalValidation,
              effectiveMultimodalReadiness,
              activeModelId,
            ),
          );
          throwIfGenerationStopped();

          if (revalidatedLatestUserMessage !== latestPreparedUserMessage) {
            const revalidatedMessages = [...preparedRequest.messages];
            revalidatedMessages[latestPreparedUserMessageIndex] = revalidatedLatestUserMessage;
            const revalidatedPromptTokens = didUseHeuristicPromptTokens
              ? estimateLlmMessagesTokens(revalidatedMessages)
              : await waitForGenerationWork(
                  countResolvedPromptTokens(revalidatedMessages, selectedTokenCountParams),
                );
            throwIfGenerationStopped();
            preparedRequest = await waitForGenerationWork(
              buildPreparedRequest(revalidatedMessages, revalidatedPromptTokens),
            );
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
      if (useChatStore.getState().inferenceRevision !== preparedRequest.inferenceRevision) {
        throw new AppError(
          'action_failed',
          'The conversation changed while preparing the prompt. Try again.',
        );
      }

      if (llmEngineService.hasActiveCompletion() || isNativeCompletionSettlingAfterStop()) {
        throw new Error('Wait for the current response to finish stopping before starting another response.');
      }

      assertThreadModelExecutionInvariant(threadId, modelId);
      if (isAndroidQaEvidenceEnabled) {
        recordAndroidQaPreparedGenerationEvidence(buildAndroidQaPreparedGenerationEvidence({
          userMessageId: latestUserMessageId,
          assistantMessageId,
          preparedMessages: messages,
        }));
      }
      generationState.nativeCompletionStarted = true;
      notifyNativeCompletionSettlementChanged();
      const completion = await llmEngineService.chatCompletion({
        messages,
        expectedModelId: modelId,
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
          if (isAndroidQaEvidenceEnabled && (
            shouldHoldAndroidQaGenerationBeforeFirstOutput(assistantMessageId)
            || isAndroidQaGenerationHeld(assistantMessageId)
          )) {
            return;
          }
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
          streamingCallbackRevision += 1;
          const callbackRevision = streamingCallbackRevision;

          if (typeof token === 'string') {
            appendPresentationDelta(token);
            if (token.length > 0) {
              latestPresentationUpdateRevision = callbackRevision;
            }
          } else {
            const hasReasoningUpdate = token.reasoningContent !== undefined;
            if (typeof token.accumulatedText === 'string') {
              latestRawAssistantSnapshot = token.accumulatedText;
              latestRawAssistantSnapshotRevision = callbackRevision;
            }

            if (token.content !== undefined) {
              if (token.contentMode === 'cumulative') {
                applyCumulativePresentationSnapshot(token.content, 'native-content');
              } else {
                presentationParser.applySnapshot(token.content);
                presentationSnapshotSource = 'native-content';
              }
              latestPresentationUpdateRevision = callbackRevision;
            } else if (!hasReasoningUpdate) {
              if (typeof token.accumulatedText === 'string') {
                applyCumulativePresentationSnapshot(token.accumulatedText, 'raw');
                latestPresentationUpdateRevision = callbackRevision;
              } else {
                appendPresentationDelta(token.token);
                if (token.token.length > 0) {
                  latestPresentationUpdateRevision = callbackRevision;
                }
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
      if (isAndroidQaEvidenceEnabled) {
        await waitForAndroidQaGenerationGateRelease(assistantMessageId);
      }
      generationState.nativeCompletionStarted = false;
      notifyNativeCompletionSettlementChanged();

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
      const finalThoughtContent = resolveSuccessfulAssistantThought({
        completionContent: completion.content,
        completionReasoningContent: completion.reasoning_content,
        completionText: completion.text,
        streamedThoughtContent: currentPresentation.thoughtContent,
      });
      const completionTelemetry = typeof llmEngineService.getLastCompletionTelemetry === 'function'
        ? llmEngineService.getLastCompletionTelemetry()
        : null;
      const successResult = finalizeBufferedAssistantTurn({
        outcome: 'success',
        content: resolveSuccessfulAssistantContent({
          completionContent: completion.content,
          completionText: completion.text,
          preferRawSnapshot:
            latestRawAssistantSnapshotRevision > latestPresentationUpdateRevision,
          streamedContent: currentPresentation.finalContent,
          rawSnapshot: latestRawAssistantSnapshot,
        }),
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
      notifyNativeCompletionSettlementChanged();
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
      const appError = toAppError(error);
      const assistantErrorCode = appError.code === 'chat_model_mismatch'
        || appError.code === 'chat_model_not_loaded'
        ? appError.code
        : 'generation_failed';

      const errorResult = finalizeBufferedAssistantTurn({
          outcome: 'error',
          errorCode: assistantErrorCode,
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
      if (isAndroidQaEvidenceEnabled) {
        releaseAndroidQaGenerationGate(assistantMessageId);
      }
      releasePromptPreparation?.();
      releasePromptPreparation = null;
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
        notifyNativeCompletionSettlementChanged();
      }

      unregisterGenerationStop();
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
    // A terminal context recovery detaches the engine into ERROR and can never
    // clear on its own, so its restart-required error must surface before the
    // model-not-loaded invariant and the transient stop-wait checks below.
    llmEngineService.assertContextRecoveryNotRequired();

    if (thread.status === 'generating') {
      throw new Error('A response is already being generated for this thread.');
    }

    if (hasActiveChatGenerationWork()) {
      throw new AppError(
        'engine_busy',
        `Wait for the current chat work to finish stopping before ${actionLabel}.`,
      );
    }

    const threadModelId = getThreadActiveModelId(thread);
    assertThreadModelExecutionInvariant(thread.id, threadModelId);

    if (
      llmEngineService.hasActiveCompletion()
      || llmEngineService.hasActiveChatBlockingContextOperation()
      || isNativeCompletionSettlingAfterStop()
    ) {
      throw new Error(`Wait for the current response to finish stopping before ${actionLabel}.`);
    }
  }, []);

  const appendUserMessage = useCallback(async (text: string, options: AppendUserMessageOptions = {}) => {
    markInteractiveWorkStarted();
    assertPrivateStorageWritableForChatMutation();
    const settings = getSettings();
    const interactiveStateAtStart = useChatStore.getState();
    const interactiveRevisionAtStart = interactiveStateAtStart.inferenceRevision;
    const activeThreadIdAtStart = interactiveStateAtStart.activeThreadId;
    const existingThreadAtStart = activeThreadIdAtStart
      ? interactiveStateAtStart.getThread(activeThreadIdAtStart)
      : undefined;
    const targetModelId = existingThreadAtStart
      ? getThreadActiveModelId(existingThreadAtStart)
      : settings.activeModelId?.trim() ?? '';
    const newThreadModelParams = getGenerationParametersForModel(targetModelId);

    if (existingThreadAtStart) {
      ensureThreadCanGenerate(existingThreadAtStart, 'sending another message');
    } else {
      // Terminal recovery keeps the engine detached in ERROR, so its
      // restart-required error must win over the generic model-not-loaded one.
      llmEngineService.assertContextRecoveryNotRequired();
      if (hasActiveChatGenerationWork()) {
        throw new AppError(
          'engine_busy',
          'Wait for the current chat work to finish stopping before sending another message.',
        );
      }
      const engineState = llmEngineService.getState();
      if (!targetModelId || engineState.status !== EngineStatus.READY || !engineState.activeModelId) {
        throw new AppError('chat_model_not_loaded', 'Load a model before starting a conversation.');
      }
      if (engineState.activeModelId !== targetModelId) {
        performanceMonitor.incrementCounter('chat.modelMismatchBlocked');
        throw new AppError(
          'chat_model_mismatch',
          'The loaded model does not match the model selected for this conversation.',
          {
            details: {
              expectedThreadModelId: targetModelId,
              engineModelId: engineState.activeModelId,
            },
          },
        );
      }
    }

    const attachmentDrafts = resolveReadyAttachmentDrafts({
      drafts: options.attachmentDrafts ?? [],
      readiness: options.multimodalReadiness,
      expectedModelId: targetModelId,
    });
    const documentAttachmentDrafts = resolveReadyDocumentAttachmentDrafts(options.documentAttachmentDrafts ?? []);
    const mediaAttachmentDrafts = resolveReadyMediaAttachmentDrafts({
      drafts: options.mediaAttachmentDrafts ?? [],
      readiness: options.multimodalReadiness,
      expectedModelId: targetModelId,
    });

    if (
      llmEngineService.hasActiveCompletion()
      || llmEngineService.hasActiveChatBlockingContextOperation()
      || isNativeCompletionSettlingAfterStop()
    ) {
      llmEngineService.assertContextRecoveryNotRequired();
      throw new Error('Wait for the current response to finish stopping before sending another message.');
    }

    const attachmentResolution = createPreparedAttachmentResolution(
      options.multimodalReadiness,
      targetModelId,
    );
    const promptPreparationEngineSnapshot = capturePromptPreparationEngineSnapshot(targetModelId);
    const generationWork = beginChatGenerationWork('append_user_message');
    const documentPreparationQaOperationId = createChatId('message');
    beginAndroidQaGeneration(documentPreparationQaOperationId);
    const documentAbortController = new AbortController();
    documentPreparationAbortControllersRef.current.add(documentAbortController);
    const unsubscribeDocumentCancellation = generationWork.onCancel(() => {
      documentAbortController.abort();
    });
    const pocketAnydocAssetLeases = new Set<PocketAnydocAssetLease>();
    const ownedSessionContextSources = new Set<ChatDocumentSessionContextSource>();
    let ownedMaterializedDocumentImageDrafts: MaterializedDocumentImageDraft[] = [];
    attachmentResolution.setCancellationCheck(generationWork.assertCurrent);
    let releaseInteractivePromptPreparation: (() => void) | null = null;
    let didAppendUserMessage = false;
    try {
      releaseInteractivePromptPreparation = llmEngineService.beginPromptPreparation();
      await generationWork.waitFor(
        assertDraftAttachmentFilesExist(attachmentDrafts, attachmentResolution.resolveFile),
      );
      await generationWork.waitFor(
        assertMediaDraftAttachmentFilesExist(mediaAttachmentDrafts, attachmentResolution.resolveFile),
      );
      const imageAttachmentMediaPaths = getDraftImageAttachmentMediaPaths(attachmentDrafts);
      let effectiveMultimodalReadiness = imageAttachmentMediaPaths.length > 0
        ? assertActiveMultimodalReadyForAttachmentMediaPaths({
            mediaPaths: imageAttachmentMediaPaths,
            multimodalReadiness: options.multimodalReadiness,
            expectedModelId: targetModelId,
            mediaPathOccurrenceCount: imageAttachmentMediaPaths.length,
          })
        : options.multimodalReadiness;
      attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, targetModelId);
      const remainingDocumentImageSlots = Math.max(
        0,
        MAX_CHAT_IMAGE_ATTACHMENTS - imageAttachmentMediaPaths.length,
      );
      const cachedDocumentAttachmentIds = collectThreadDocumentAttachmentIds(existingThreadAtStart);
      const canMaterializeDocumentAssets = remainingDocumentImageSlots > 0
        && isVisionReady(effectiveMultimodalReadiness, targetModelId);
      let retainNativeDocumentAssetLeases = false;
      if (
        documentAttachmentDrafts.length > 0
        && canMaterializeDocumentAssets
      ) {
        const capabilities = await generationWork.waitFor(getPocketAnydocCapabilities());
        generationWork.assertCurrent();
        retainNativeDocumentAssetLeases = capabilities.available && capabilities.supportsAssets;
      }
      if (documentAttachmentDrafts.length > 0) {
        setIsPreparingDocuments(true);
        if (activateAndroidQaDocumentPreparationGate(documentPreparationQaOperationId)) {
          await generationWork.waitFor(
            waitForAndroidQaGenerationGateRelease(documentPreparationQaOperationId),
          );
          generationWork.assertCurrent();
        }
      }
      const newlyProcessedDocumentAttachments = documentAttachmentDrafts.length > 0
        ? await generationWork.waitFor(
            processDocumentAttachmentDraftsForInference(
              text,
              documentAttachmentDrafts,
              documentAbortController.signal,
              attachmentResolution.cancellationGate,
              retainNativeDocumentAssetLeases,
              (lease) => pocketAnydocAssetLeases.add(lease),
              true,
              (source) => ownedSessionContextSources.add(source),
              async () => {
                const source = [...ownedSessionContextSources].find((candidate) => (
                  candidate.kind === 'native' && !candidate.isReleased()
                ));
                if (!source) {
                  return false;
                }
                ownedSessionContextSources.delete(source);
                pocketAnydocAssetLeases.delete(source as unknown as PocketAnydocAssetLease);
                await releaseDocumentSessionContextSources([source]);
                return source.isReleased();
              },
            ),
          )
        : await processDocumentAttachmentDraftsForInference(text, []);
      const newDocumentAttachmentIds = new Set([
        ...documentAttachmentDrafts.flatMap((draft) => draft.id ? [draft.id] : []),
        ...newlyProcessedDocumentAttachments.candidates.map(({ attachment }) => attachment.id),
      ]);
      const newDocumentFailureDrafts = new Set(documentAttachmentDrafts);
      newDocumentAttachmentIds.forEach((attachmentId) => cachedDocumentAttachmentIds.delete(attachmentId));
      const selectedSessionDocumentAttachments = existingThreadAtStart && cachedDocumentAttachmentIds.size > 0
        ? await generationWork.waitFor(
            selectSessionDocumentContextForInference(
              existingThreadAtStart.id,
              text,
              documentAbortController.signal,
              attachmentResolution.cancellationGate,
              cachedDocumentAttachmentIds,
            ),
          )
        : await processDocumentAttachmentDraftsForInference(text, []);
      let processedDocumentAttachments = await generationWork.waitFor(
        combineDocumentContextForInference(
          text,
          [newlyProcessedDocumentAttachments, selectedSessionDocumentAttachments],
        ),
      );
      const usesTransientSessionDocumentContext = selectedSessionDocumentAttachments.candidates.length > 0;
      const transientSessionDocumentAttachmentIds = new Set(
        processedDocumentAttachments.candidates.map(({ attachment }) => attachment.id),
      );
      if (processedDocumentAttachments.allFailedError) {
        const newDocumentFailures = projectDocumentContextSelection(
          processedDocumentAttachments,
          newDocumentAttachmentIds,
          newDocumentFailureDrafts,
        ).failures;
        if (newDocumentFailures.length > 0) {
          options.onDocumentAttachmentFailures?.(newDocumentFailures);
        }
        throw processedDocumentAttachments.allFailedError;
      }

      if (canMaterializeDocumentAssets) {
        processedDocumentAttachments.candidates.forEach(({ result }) => {
          if (result.nativeAssetLease) {
            pocketAnydocAssetLeases.add(result.nativeAssetLease);
          }
        });
      }
      generationWork.assertCurrent();
      const currentState = useChatStore.getState();
      if (
        currentState.inferenceRevision !== interactiveRevisionAtStart
        || currentState.activeThreadId !== activeThreadIdAtStart
        || (
          existingThreadAtStart != null
          && (
            currentState.getThread(existingThreadAtStart.id) !== existingThreadAtStart
            || getThreadActiveModelId(existingThreadAtStart) !== targetModelId
          )
        )
      ) {
        throw new AppError(
          'action_failed',
          'The conversation changed while preparing the prompt. Try again.',
        );
      }
      assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);

      const userMessageId = createChatId('message');
      const userMessageCreatedAt = Date.now();
      const normalizedText = text.trim();
      const provisionalThreadId = existingThreadAtStart?.id ?? 'pending';
      const provisionalPersistedDocumentSelection = projectDocumentContextSelection(
        processedDocumentAttachments,
        newDocumentAttachmentIds,
        newDocumentFailureDrafts,
      );
      const provisionalDocumentContentParts = provisionalPersistedDocumentSelection.contentParts;
      const provisionalUserMessageContent = normalizedText.length > 0
        || provisionalDocumentContentParts.length === 0
        || documentAttachmentDrafts.length === 0
        ? normalizedText
        : DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER;
      const provisionalMessageAttachments = [
        ...materializeAttachmentDraftsForMessage({
          threadId: provisionalThreadId,
          messageId: userMessageId,
          drafts: attachmentDrafts,
        }),
        ...(documentAttachmentDrafts.length > 0
          ? provisionalPersistedDocumentSelection.attachments.map((attachment) => ({
              ...attachment,
              threadId: provisionalThreadId,
              messageId: userMessageId,
            }))
          : []),
        ...materializeMediaDraftsForMessage({
          threadId: provisionalThreadId,
          messageId: userMessageId,
          drafts: mediaAttachmentDrafts,
        }),
      ];
      const newThreadPresetSnapshot = resolvePresetSnapshot(settings.activePresetId);
      const provisionalBaseThread: ChatThread = existingThreadAtStart ?? {
        id: provisionalThreadId,
        title: 'New Conversation',
        titleSource: 'derived',
        modelId: targetModelId,
        activeModelId: targetModelId,
        presetId: settings.activePresetId,
        presetSnapshot: newThreadPresetSnapshot,
        paramsSnapshot: newThreadModelParams,
        messages: [],
        createdAt: userMessageCreatedAt,
        updatedAt: userMessageCreatedAt,
        status: 'idle',
      };
      const provisionalUserMessage: ChatMessage = {
        id: userMessageId,
        role: 'user',
        content: provisionalUserMessageContent,
        createdAt: userMessageCreatedAt,
        state: 'complete',
        kind: 'message',
        modelId: targetModelId,
        ...(provisionalDocumentContentParts.length > 0
          ? { contentParts: provisionalDocumentContentParts }
          : null),
        ...(provisionalMessageAttachments.length > 0
          ? { attachments: provisionalMessageAttachments }
          : null),
      };
      processedDocumentAttachments = await generationWork.waitFor(
        refineDocumentContextWithExactPromptBudget({
          question: text,
          processed: processedDocumentAttachments,
          baseThread: provisionalBaseThread,
          provisionalUserMessage,
          multimodalReadiness: effectiveMultimodalReadiness,
          expectedModelId: targetModelId,
          attachmentResolution,
          generationWork,
          ...(usesTransientSessionDocumentContext
            ? { replacePersistedDocumentAttachmentIds: transientSessionDocumentAttachmentIds }
            : null),
        }),
      );
      generationWork.assertCurrent();
      const stateAfterDocumentTokenization = useChatStore.getState();
      if (
        stateAfterDocumentTokenization.inferenceRevision !== interactiveRevisionAtStart
        || stateAfterDocumentTokenization.activeThreadId !== activeThreadIdAtStart
        || (
          existingThreadAtStart != null
          && (
            stateAfterDocumentTokenization.getThread(existingThreadAtStart.id) !== existingThreadAtStart
            || getThreadActiveModelId(existingThreadAtStart) !== targetModelId
          )
        )
      ) {
        throw new AppError(
          'action_failed',
          'The conversation changed while selecting document context. Try again.',
        );
      }
      assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);

      if (canMaterializeDocumentAssets && pocketAnydocAssetLeases.size > 0) {
        const initiallyMaterializedDocumentImages = await materializeSelectedDocumentImageDrafts({
          processed: processedDocumentAttachments,
          maxAssets: remainingDocumentImageSlots,
          signal: documentAbortController.signal,
          cancellationGate: attachmentResolution.cancellationGate,
          onDraftMaterialized: (entry) => {
            ownedMaterializedDocumentImageDrafts.push(entry);
          },
        });
        generationWork.assertCurrent();
        const textSelectedDocumentAttachments = processedDocumentAttachments;
        let budgetedDocumentImages = [...initiallyMaterializedDocumentImages];
        while (true) {
          const materializedImageDrafts = budgetedDocumentImages.map((entry) => entry.draft);
          const materializedImageMediaPaths = getDraftImageAttachmentMediaPaths(materializedImageDrafts);
          if (materializedImageMediaPaths.length > 0) {
            effectiveMultimodalReadiness = assertActiveMultimodalReadyForAttachmentMediaPaths({
              mediaPaths: materializedImageMediaPaths,
              multimodalReadiness: effectiveMultimodalReadiness,
              expectedModelId: targetModelId,
              mediaPathOccurrenceCount: imageAttachmentMediaPaths.length + materializedImageMediaPaths.length,
            });
            attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, targetModelId);
          }
          const provisionalDocumentImageAttachments = materializeAttachmentDraftsForMessage({
            threadId: provisionalThreadId,
            messageId: userMessageId,
            drafts: materializedImageDrafts,
          });
          try {
            const mediaBudgetSelection = await generationWork.waitFor(
              refineDocumentContextWithExactPromptBudget({
                question: text,
                processed: finalizeSelectedDocumentAssetWarnings(
                  textSelectedDocumentAttachments,
                  budgetedDocumentImages,
                ),
                baseThread: provisionalBaseThread,
                provisionalUserMessage: {
                  ...provisionalUserMessage,
                  attachments: [
                    ...provisionalMessageAttachments,
                    ...provisionalDocumentImageAttachments,
                  ],
                },
                multimodalReadiness: effectiveMultimodalReadiness,
                expectedModelId: targetModelId,
                attachmentResolution,
                generationWork,
                ...(usesTransientSessionDocumentContext
                  ? { replacePersistedDocumentAttachmentIds: transientSessionDocumentAttachmentIds }
                  : null),
              }),
            );
            generationWork.assertCurrent();
            const retainedDocumentIds = new Set(
              mediaBudgetSelection.selectedCandidates.map(({ attachment }) => attachment.id),
            );
            const droppedDocumentForMedia = textSelectedDocumentAttachments.selectedCandidates.some(
              ({ attachment }) => !retainedDocumentIds.has(attachment.id),
            );
            if (droppedDocumentForMedia && budgetedDocumentImages.length > 0) {
              const removed = budgetedDocumentImages.at(-1)!;
              await chatAttachmentStorageService.discardDraft(removed.draft);
              ownedMaterializedDocumentImageDrafts = ownedMaterializedDocumentImageDrafts.filter(
                (entry) => entry !== removed,
              );
              budgetedDocumentImages = budgetedDocumentImages.slice(0, -1);
              processedDocumentAttachments = textSelectedDocumentAttachments;
              continue;
            }
            processedDocumentAttachments = mediaBudgetSelection;
            break;
          } catch (error) {
            throwIfDocumentAssetMaterializationCancelled(
              documentAbortController.signal,
              attachmentResolution.cancellationGate,
            );
            const appError = toAppError(error);
            if (
              budgetedDocumentImages.length === 0
              || (
                appError.code !== 'message_too_long'
                && appError.code !== 'chat_attachment_too_large_for_context'
              )
            ) {
              throw error;
            }
            const removed = budgetedDocumentImages.at(-1)!;
            await chatAttachmentStorageService.discardDraft(removed.draft);
            ownedMaterializedDocumentImageDrafts = ownedMaterializedDocumentImageDrafts.filter(
              (entry) => entry !== removed,
            );
            budgetedDocumentImages = budgetedDocumentImages.slice(0, -1);
            processedDocumentAttachments = textSelectedDocumentAttachments;
          }
        }
        const retainedMaterializedDocumentImages = await discardUnselectedDocumentImageDrafts(
          budgetedDocumentImages,
          collectSelectedDocumentAssetKeys(processedDocumentAttachments),
        );
        ownedMaterializedDocumentImageDrafts = retainedMaterializedDocumentImages;
      }
      processedDocumentAttachments = finalizeSelectedDocumentAssetWarnings(
        processedDocumentAttachments,
        ownedMaterializedDocumentImageDrafts,
      );
      generationWork.assertCurrent();
      const stateAfterDocumentAssets = useChatStore.getState();
      if (
        stateAfterDocumentAssets.inferenceRevision !== interactiveRevisionAtStart
        || stateAfterDocumentAssets.activeThreadId !== activeThreadIdAtStart
        || (
          existingThreadAtStart != null
          && (
            stateAfterDocumentAssets.getThread(existingThreadAtStart.id) !== existingThreadAtStart
            || getThreadActiveModelId(existingThreadAtStart) !== targetModelId
          )
        )
      ) {
        throw new AppError(
          'action_failed',
          'The conversation changed while materializing document images. Try again.',
        );
      }
      assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);
      processedDocumentAttachments.candidates.forEach(({ result }) => {
        const nativeAssetLease = result.nativeAssetLease;
        if (
          result.sessionContextSource
          && nativeAssetLease
          && (nativeAssetLease as unknown) === result.sessionContextSource
        ) {
          pocketAnydocAssetLeases.delete(nativeAssetLease);
        }
      });
      await releasePocketAnydocAssetLeases(pocketAnydocAssetLeases);
      pocketAnydocAssetLeases.clear();

      const persistedDocumentSelection = projectDocumentContextSelection(
        processedDocumentAttachments,
        newDocumentAttachmentIds,
        newDocumentFailureDrafts,
      );
      if (processedDocumentAttachments.allFailedError) {
        if (persistedDocumentSelection.failures.length > 0) {
          options.onDocumentAttachmentFailures?.(persistedDocumentSelection.failures);
        }
        throw processedDocumentAttachments.allFailedError;
      }

      const documentContentParts = processedDocumentAttachments.contentParts;
      const persistedDocumentContentParts = persistedDocumentSelection.contentParts;
      const persistedMaterializedDocumentImages = ownedMaterializedDocumentImageDrafts.filter(
        (entry) => newDocumentAttachmentIds.has(entry.documentAttachmentId),
      );
      const transientMaterializedDocumentImages = ownedMaterializedDocumentImageDrafts.filter(
        (entry) => !newDocumentAttachmentIds.has(entry.documentAttachmentId),
      );

      const threadId = existingThreadAtStart?.id
        ?? createThread({
          modelId: targetModelId,
          presetId: settings.activePresetId,
          presetSnapshot: newThreadPresetSnapshot,
          paramsSnapshot: newThreadModelParams,
        });

      if (!setActiveThread(threadId)) {
        throw new AppError(
          'action_failed',
          'The conversation changed before it could become active. Try again.',
        );
      }

      if (persistedDocumentSelection.failures.length > 0) {
        options.onDocumentAttachmentFailures?.(persistedDocumentSelection.failures);
      }

      const threadForSend = assertThreadModelExecutionInvariant(threadId, targetModelId);
      const threadModelId = getThreadActiveModelId(threadForSend);

      const userMessageContent = normalizedText.length > 0
        || persistedDocumentContentParts.length === 0
        || documentAttachmentDrafts.length === 0
        ? normalizedText
        : DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER;
      const messageAttachments = [
        ...materializeAttachmentDraftsForMessage({
          threadId,
          messageId: userMessageId,
          drafts: attachmentDrafts,
        }),
        ...materializeAttachmentDraftsForMessage({
          threadId,
          messageId: userMessageId,
          drafts: persistedMaterializedDocumentImages.map((entry) => entry.draft),
        }),
        ...(documentAttachmentDrafts.length > 0
          ? persistedDocumentSelection.attachments.map((attachment) => ({
              ...attachment,
              threadId,
              messageId: userMessageId,
            }))
          : []),
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
        createdAt: userMessageCreatedAt,
        state: 'complete',
        kind: 'message',
        modelId: threadModelId,
        ...(persistedDocumentContentParts.length > 0
          ? { contentParts: persistedDocumentContentParts }
          : null),
        ...(messageAttachments.length > 0
          ? { attachments: messageAttachments }
          : null),
      };

      appendMessage(threadId, userMessage);
      didAppendUserMessage = true;
      ownedMaterializedDocumentImageDrafts = transientMaterializedDocumentImages;
      if (documentAttachmentDrafts.length > 0) {
        const persistedDocumentById = new Map(messageAttachments.flatMap((attachment) => (
          isGenericChatAttachment(attachment) && attachment.kind === 'document'
            ? [[attachment.id, attachment] as const]
            : []
        )));
        for (const { attachment, result } of persistedDocumentSelection.selectedCandidates) {
          const source = result.sessionContextSource;
          const persistedAttachment = persistedDocumentById.get(attachment.id);
          if (!source || !persistedAttachment) {
            continue;
          }
          await documentSessionContextCache.put(threadId, persistedAttachment, result);
          ownedSessionContextSources.delete(source);
        }
      }
      options.onUserMessageAppended?.(userMessage);

      const assistantMessageId = createAssistantPlaceholder(threadId, threadModelId);
      const transientDocumentImageAttachments = materializeAttachmentDraftsForMessage({
        threadId,
        messageId: userMessageId,
        drafts: transientMaterializedDocumentImages.map((entry) => entry.draft),
      });

      await runAssistantCompletion(threadId, assistantMessageId, {
        expectedModelId: threadModelId,
        multimodalReadiness: effectiveMultimodalReadiness,
        attachmentResolution,
        generationWork,
        ...(usesTransientSessionDocumentContext
          ? {
              transientDocumentContentParts: documentContentParts,
              transientDocumentAttachmentIds: [...transientSessionDocumentAttachmentIds],
              transientDocumentImageAttachments,
            }
          : null),
      });
    } catch (error) {
      if (isChatGenerationCancelledError(error)) {
        if (!didAppendUserMessage) {
          options.onPreparationCancelled?.();
        }
        return;
      }
      throw error;
    } finally {
      releaseAndroidQaGenerationGate(documentPreparationQaOperationId);
      unsubscribeDocumentCancellation();
      documentPreparationAbortControllersRef.current.delete(documentAbortController);
      if (ownedMaterializedDocumentImageDrafts.length > 0) {
        try {
          await chatAttachmentStorageService.discardDrafts(
            ownedMaterializedDocumentImageDrafts.map((entry) => entry.draft),
          );
        } catch (error) {
          console.warn('[ChatSession] Failed to discard unpersisted document image drafts', {
            ...getPrivacySafeErrorLogDetails(error),
          });
        }
        ownedMaterializedDocumentImageDrafts = [];
      }
      await releasePocketAnydocAssetLeases(pocketAnydocAssetLeases);
      pocketAnydocAssetLeases.clear();
      await releaseDocumentSessionContextSources(ownedSessionContextSources);
      ownedSessionContextSources.clear();
      if (isMountedRef.current) {
        setIsPreparingDocuments(false);
      }
      releaseInteractivePromptPreparation?.();
      generationWork.finish();
    }
  }, [
    appendMessage,
    createAssistantPlaceholder,
    createThread,
    ensureThreadCanGenerate,
    runAssistantCompletion,
    setActiveThread,
  ]);

  const stopGeneration = useCallback(async () => {
    markInteractiveWorkStarted();
    await stopAllGenerationWork({ blockNewWork: false });
  }, []);

  const regenerateFromUserMessage = useCallback(async (
    messageId: string,
    nextContent: string,
    options: RegenerateUserMessageOptions = {},
  ) => {
    markInteractiveWorkStarted();
    if (!activeThread) {
      return false;
    }

    const targetMessageIndex = activeThread.messages.findIndex((message) => message.id === messageId);
    const targetMessage = targetMessageIndex >= 0
      ? activeThread.messages[targetMessageIndex]
      : undefined;
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
    const regenerationDocumentInputs = getRegenerationDocumentAttachmentInputs(targetMessage);
    const retainedAttachmentsForReadiness = [
      ...regenerationDocumentInputs.retainedImageAttachments,
      ...regenerationDocumentInputs.documentAttachments,
      ...regenerationDocumentInputs.retainedOtherAttachments,
    ];
    const attachmentResolution = createPreparedAttachmentResolution(
      requestedMultimodalReadiness,
      activeModelId,
    );
    const promptPreparationEngineSnapshot = capturePromptPreparationEngineSnapshot(activeModelId);
    const generationWork = beginChatGenerationWork('regenerate_user_message');
    const documentPreparationQaOperationId = createChatId('message');
    beginAndroidQaGeneration(documentPreparationQaOperationId);
    const documentAbortController = new AbortController();
    documentPreparationAbortControllersRef.current.add(documentAbortController);
    const unsubscribeDocumentCancellation = generationWork.onCancel(() => {
      documentAbortController.abort();
    });
    const pocketAnydocAssetLeases = new Set<PocketAnydocAssetLease>();
    let ownedMaterializedDocumentImageDrafts: MaterializedDocumentImageDraft[] = [];
    let transientRegenerationDocumentImages: MaterializedDocumentImageDraft[] = [];
    let branchCacheReconciliation: Promise<void> | null = null;
    const handleBranchTerminalSettlement = (result: AssistantTurnCommitResult) => {
      if (!isAssistantTurnSettled(result)) {
        return;
      }
      const reconciliation = documentSessionContextCache.retainThreadAttachments(
        activeThread.id,
        collectThreadDocumentAttachmentIds(useChatStore.getState().getThread(activeThread.id)),
      );
      branchCacheReconciliation = reconciliation;
      void reconciliation.catch((error) => {
        console.warn('[ChatSession] Failed to reconcile regenerated document sessions', {
          ...getPrivacySafeErrorLogDetails(error),
        });
      });
    };
    attachmentResolution.setCancellationCheck(generationWork.assertCurrent);
    let releaseInteractivePromptPreparation: (() => void) | null = null;
    try {
      releaseInteractivePromptPreparation = llmEngineService.beginPromptPreparation();
      let effectiveMultimodalReadiness = await generationWork.waitFor(
        assertUserMessageAttachmentsReadyForRegeneration(
          {
            ...targetMessage,
            attachments: retainedAttachmentsForReadiness.length > 0
              ? retainedAttachmentsForReadiness
              : undefined,
          },
          requestedMultimodalReadiness,
          activeModelId,
          attachmentResolution.resolveFile,
        ),
      );
      generationWork.assertCurrent();
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
      assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);

      let replacementAttachments = targetMessage.attachments;
      let replacementContentParts = targetMessage.contentParts;
      let replacementContent = normalizedContent;
      let regeneratedDocumentSelection: ProcessedDocumentAttachmentDraftsForInference | null = null;
      const regenerationBaseThread: ChatThread = {
        ...activeThread,
        messages: activeThread.messages.slice(0, targetMessageIndex),
      };
      if (regenerationDocumentInputs.documentDrafts.length > 0) {
        setIsPreparingDocuments(true);
        if (activateAndroidQaDocumentPreparationGate(documentPreparationQaOperationId)) {
          await generationWork.waitFor(
            waitForAndroidQaGenerationGateRelease(documentPreparationQaOperationId),
          );
          generationWork.assertCurrent();
        }
        const retainedAttachments = [
          ...regenerationDocumentInputs.retainedImageAttachments,
          ...regenerationDocumentInputs.retainedOtherAttachments,
        ];
        const preparedDocuments = await prepareRegeneratedDocumentInferenceContent({
          question: normalizedContent,
          documentDrafts: regenerationDocumentInputs.documentDrafts,
          retainedAttachments,
          baseThread: regenerationBaseThread,
          targetMessage,
          multimodalReadiness: effectiveMultimodalReadiness,
          expectedModelId: activeModelId,
          attachmentResolution,
          generationWork,
          signal: documentAbortController.signal,
          nativeAssetLeases: pocketAnydocAssetLeases,
          onDraftMaterialized: (entry) => {
            ownedMaterializedDocumentImageDrafts.push(entry);
          },
        });
        generationWork.assertCurrent();
        effectiveMultimodalReadiness = preparedDocuments.multimodalReadiness;
        regeneratedDocumentSelection = preparedDocuments.processed;
        ownedMaterializedDocumentImageDrafts = preparedDocuments.materializedImages;
        const regeneratedDocumentImages = materializeAttachmentDraftsForMessage({
          threadId: activeThread.id,
          messageId: targetMessage.id,
          drafts: preparedDocuments.materializedImages.map((entry) => entry.draft),
        });
        const regeneratedDocuments = preparedDocuments.processed.attachments.map((attachment) => ({
          ...attachment,
          threadId: activeThread.id,
          messageId: targetMessage.id,
        }));
        replacementAttachments = [
          ...regenerationDocumentInputs.retainedImageAttachments,
          ...regeneratedDocumentImages,
          ...regeneratedDocuments,
          ...regenerationDocumentInputs.retainedOtherAttachments,
        ];
        replacementContentParts = preparedDocuments.processed.contentParts;
        replacementContent = normalizedContent || DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER;
        await releasePocketAnydocAssetLeases(pocketAnydocAssetLeases);
        pocketAnydocAssetLeases.clear();

        const stateAfterDocumentPreparation = useChatStore.getState();
        const threadAfterDocumentPreparation = stateAfterDocumentPreparation.threads[activeThread.id];
        if (
          stateAfterDocumentPreparation.activeThreadId !== activeThread.id
          || threadAfterDocumentPreparation !== activeThread
          || getThreadActiveModelId(threadAfterDocumentPreparation) !== activeModelId
        ) {
          throw new Error('The conversation changed while reprocessing documents. Try again.');
        }
        assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);
      }
      const cachedRegenerationAttachmentIds = collectThreadDocumentAttachmentIds(regenerationBaseThread);
      regeneratedDocumentSelection?.candidates.forEach(({ attachment }) => {
        cachedRegenerationAttachmentIds.delete(attachment.id);
      });
      const cachedRegenerationDocuments = cachedRegenerationAttachmentIds.size > 0
        ? await generationWork.waitFor(
            selectSessionDocumentContextForInference(
              activeThread.id,
              normalizedContent,
              documentAbortController.signal,
              attachmentResolution.cancellationGate,
              cachedRegenerationAttachmentIds,
            ),
          )
        : await processDocumentAttachmentDraftsForInference(normalizedContent, []);
      const usesTransientSessionDocumentContext = cachedRegenerationDocuments.candidates.length > 0;
      let transientRegenerationDocuments = cachedRegenerationDocuments;
      let transientRegenerationAttachmentIds = new Set(
        cachedRegenerationDocuments.candidates.map(({ attachment }) => attachment.id),
      );
      if (usesTransientSessionDocumentContext) {
        transientRegenerationDocuments = regeneratedDocumentSelection
          ? await generationWork.waitFor(combineDocumentContextForInference(
              normalizedContent,
              [regeneratedDocumentSelection, cachedRegenerationDocuments],
            ))
          : cachedRegenerationDocuments;
        transientRegenerationAttachmentIds = new Set(
          transientRegenerationDocuments.candidates.map(({ attachment }) => attachment.id),
        );
        transientRegenerationDocuments = await generationWork.waitFor(
          refineDocumentContextWithExactPromptBudget({
            question: normalizedContent,
            processed: transientRegenerationDocuments,
            baseThread: regenerationBaseThread,
            provisionalUserMessage: {
              ...targetMessage,
              content: replacementContent,
              modelId: activeModelId,
              attachments: replacementAttachments,
              contentParts: replacementContentParts,
            },
            multimodalReadiness: effectiveMultimodalReadiness,
            expectedModelId: activeModelId,
            attachmentResolution,
            generationWork,
            replacePersistedDocumentAttachmentIds: transientRegenerationAttachmentIds,
          }),
        );
        generationWork.assertCurrent();
        if (regeneratedDocumentSelection) {
          const regeneratedAttachmentIds = new Set(
            regeneratedDocumentSelection.candidates.map(({ attachment }) => attachment.id),
          );
          regeneratedDocumentSelection = projectDocumentContextSelection(
            transientRegenerationDocuments,
            regeneratedAttachmentIds,
          );
          throwIfRegeneratedDocumentWasDropped(regeneratedDocumentSelection);
          ownedMaterializedDocumentImageDrafts = await discardUnselectedDocumentImageDrafts(
            ownedMaterializedDocumentImageDrafts,
            collectSelectedDocumentAssetKeys(regeneratedDocumentSelection),
          );
          const regeneratedDocumentImages = materializeAttachmentDraftsForMessage({
            threadId: activeThread.id,
            messageId: targetMessage.id,
            drafts: ownedMaterializedDocumentImageDrafts.map((entry) => entry.draft),
          });
          const regeneratedDocuments = regeneratedDocumentSelection.attachments.map((attachment) => ({
            ...attachment,
            threadId: activeThread.id,
            messageId: targetMessage.id,
          }));
          replacementAttachments = [
            ...regenerationDocumentInputs.retainedImageAttachments,
            ...regeneratedDocumentImages,
            ...regeneratedDocuments,
            ...regenerationDocumentInputs.retainedOtherAttachments,
          ];
          replacementContentParts = regeneratedDocumentSelection.contentParts;
        }
        const retainedReplacementImagePaths = getChatImageAttachmentMediaPaths(
          replacementAttachments ?? [],
        );
        const remainingDocumentImageSlots = Math.max(
          0,
          MAX_CHAT_IMAGE_ATTACHMENTS - retainedReplacementImagePaths.length,
        );
        const cachedSelectedDocuments = projectDocumentContextSelection(
          transientRegenerationDocuments,
          cachedRegenerationAttachmentIds,
        );
        if (
          remainingDocumentImageSlots > 0
          && isVisionReady(effectiveMultimodalReadiness, activeModelId)
          && cachedSelectedDocuments.selectedCandidates.some(({ result }) => result.nativeAssetLease)
        ) {
          transientRegenerationDocumentImages = await materializeSelectedDocumentImageDrafts({
            processed: cachedSelectedDocuments,
            maxAssets: remainingDocumentImageSlots,
            signal: documentAbortController.signal,
            cancellationGate: attachmentResolution.cancellationGate,
            onDraftMaterialized: (entry) => {
              ownedMaterializedDocumentImageDrafts.push(entry);
            },
          });
          const materializedImagePaths = getDraftImageAttachmentMediaPaths(
            transientRegenerationDocumentImages.map((entry) => entry.draft),
          );
          if (materializedImagePaths.length > 0) {
            effectiveMultimodalReadiness = assertActiveMultimodalReadyForAttachmentMediaPaths({
              mediaPaths: materializedImagePaths,
              multimodalReadiness: effectiveMultimodalReadiness,
              expectedModelId: activeModelId,
              mediaPathOccurrenceCount: retainedReplacementImagePaths.length + materializedImagePaths.length,
            });
            attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, activeModelId);
          }
          transientRegenerationDocuments = finalizeSelectedDocumentAssetWarnings(
            transientRegenerationDocuments,
            ownedMaterializedDocumentImageDrafts,
          );
        }
      }
      const stateBeforeBranchReplacement = useChatStore.getState();
      if (
        stateBeforeBranchReplacement.activeThreadId !== activeThread.id
        || stateBeforeBranchReplacement.threads[activeThread.id] !== activeThread
        || getThreadActiveModelId(activeThread) !== activeModelId
      ) {
        throw new Error('The conversation changed while selecting regeneration context. Try again.');
      }
      assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);
      const branchParamsSnapshot = getGenerationParametersForModel(activeModelId);

      const assistantMessageId = replaceBranchFromUserMessage(
        activeThread.id,
        messageId,
        replacementContent,
        branchParamsSnapshot,
        regenerationDocumentInputs.documentDrafts.length > 0
          ? {
              attachments: replacementAttachments?.length ? replacementAttachments : undefined,
              contentParts: replacementContentParts?.length ? replacementContentParts : undefined,
            }
          : undefined,
      );
      if (!assistantMessageId) {
        throw new Error('The selected message could not be regenerated.');
      }
      ownedMaterializedDocumentImageDrafts = transientRegenerationDocumentImages;
      const transientDocumentImageAttachments = materializeAttachmentDraftsForMessage({
        threadId: activeThread.id,
        messageId: targetMessage.id,
        drafts: transientRegenerationDocumentImages.map((entry) => entry.draft),
      });

      await runAssistantCompletion(activeThread.id, assistantMessageId, {
        expectedModelId: activeModelId,
        multimodalReadiness: effectiveMultimodalReadiness,
        attachmentResolution,
        generationWork,
        ...(usesTransientSessionDocumentContext
          ? {
              transientDocumentContentParts: transientRegenerationDocuments.contentParts,
              transientDocumentAttachmentIds: [...transientRegenerationAttachmentIds],
              transientDocumentImageAttachments,
            }
          : null),
        onTerminalSettlement: handleBranchTerminalSettlement,
      });

      return true;
    } catch (error) {
      if (isChatGenerationCancelledError(error)) {
        return false;
      }
      throw error;
    } finally {
      if (branchCacheReconciliation) {
        await branchCacheReconciliation;
      }
      releaseAndroidQaGenerationGate(documentPreparationQaOperationId);
      unsubscribeDocumentCancellation();
      documentPreparationAbortControllersRef.current.delete(documentAbortController);
      if (ownedMaterializedDocumentImageDrafts.length > 0) {
        try {
          await chatAttachmentStorageService.discardDrafts(
            ownedMaterializedDocumentImageDrafts.map((entry) => entry.draft),
          );
        } catch (error) {
          console.warn('[ChatSession] Failed to discard regenerated document image drafts', {
            ...getPrivacySafeErrorLogDetails(error),
          });
        }
      }
      await releasePocketAnydocAssetLeases(pocketAnydocAssetLeases);
      pocketAnydocAssetLeases.clear();
      if (isMountedRef.current && regenerationDocumentInputs.documentDrafts.length > 0) {
        setIsPreparingDocuments(false);
      }
      releaseInteractivePromptPreparation?.();
      generationWork.finish();
    }
  }, [activeThread, ensureThreadCanGenerate, replaceBranchFromUserMessage, runAssistantCompletion]);

  const regenerateLastResponse = useCallback(async () => {
    markInteractiveWorkStarted();
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
    const promptPreparationEngineSnapshot = capturePromptPreparationEngineSnapshot(activeModelId);
    const generationWork = beginChatGenerationWork('regenerate_last_response');
    const documentAbortController = new AbortController();
    documentPreparationAbortControllersRef.current.add(documentAbortController);
    const unsubscribeDocumentCancellation = generationWork.onCancel(() => {
      documentAbortController.abort();
    });
    let ownedMaterializedDocumentImageDrafts: MaterializedDocumentImageDraft[] = [];
    attachmentResolution.setCancellationCheck(generationWork.assertCurrent);
    let releaseInteractivePromptPreparation: (() => void) | null = null;
    try {
      releaseInteractivePromptPreparation = llmEngineService.beginPromptPreparation();
      let effectiveMultimodalReadiness = await generationWork.waitFor(
        assertUserMessageAttachmentsReadyForRegeneration(
          lastUserMessage,
          model?.multimodalReadiness,
          activeModelId,
          attachmentResolution.resolveFile,
        ),
      );
      generationWork.assertCurrent();
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
      assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);
      const sessionRegenerationThread: ChatThread = {
        ...activeThread,
        messages: activeThread.messages.slice(0, lastUserMessageIndex + 1),
      };
      const sessionRegenerationAttachmentIds = collectThreadDocumentAttachmentIds(
        sessionRegenerationThread,
      );
      let transientRegenerationDocuments = sessionRegenerationAttachmentIds.size > 0
        ? await generationWork.waitFor(
            selectSessionDocumentContextForInference(
              activeThread.id,
              lastUserMessage.content,
              documentAbortController.signal,
              attachmentResolution.cancellationGate,
              sessionRegenerationAttachmentIds,
            ),
          )
        : await processDocumentAttachmentDraftsForInference(lastUserMessage.content, []);
      const usesTransientSessionDocumentContext = transientRegenerationDocuments.candidates.length > 0;
      const transientRegenerationAttachmentIds = new Set(
        transientRegenerationDocuments.candidates.map(({ attachment }) => attachment.id),
      );
      if (usesTransientSessionDocumentContext) {
        setIsPreparingDocuments(true);
        const regenerationBaseThread: ChatThread = {
          ...activeThread,
          messages: activeThread.messages.slice(0, lastUserMessageIndex),
        };
        transientRegenerationDocuments = await generationWork.waitFor(
          refineDocumentContextWithExactPromptBudget({
            question: lastUserMessage.content,
            processed: transientRegenerationDocuments,
            baseThread: regenerationBaseThread,
            provisionalUserMessage: omitPersistedDocumentInferenceMaterial(
              lastUserMessage,
              transientRegenerationAttachmentIds,
            ),
            multimodalReadiness: effectiveMultimodalReadiness,
            expectedModelId: activeModelId,
            attachmentResolution,
            generationWork,
            replacePersistedDocumentAttachmentIds: transientRegenerationAttachmentIds,
          }),
        );
        generationWork.assertCurrent();
        const retainedLastUserMessage = omitPersistedDocumentInferenceMaterial(
          lastUserMessage,
          transientRegenerationAttachmentIds,
        );
        const retainedImagePaths = getChatImageAttachmentMediaPaths(
          retainedLastUserMessage.attachments ?? [],
        );
        const remainingDocumentImageSlots = Math.max(
          0,
          MAX_CHAT_IMAGE_ATTACHMENTS - retainedImagePaths.length,
        );
        if (
          remainingDocumentImageSlots > 0
          && isVisionReady(effectiveMultimodalReadiness, activeModelId)
          && transientRegenerationDocuments.selectedCandidates.some(({ result }) => result.nativeAssetLease)
        ) {
          ownedMaterializedDocumentImageDrafts = await materializeSelectedDocumentImageDrafts({
            processed: transientRegenerationDocuments,
            maxAssets: remainingDocumentImageSlots,
            signal: documentAbortController.signal,
            cancellationGate: attachmentResolution.cancellationGate,
            onDraftMaterialized: (entry) => {
              ownedMaterializedDocumentImageDrafts.push(entry);
            },
          });
          const materializedImagePaths = getDraftImageAttachmentMediaPaths(
            ownedMaterializedDocumentImageDrafts.map((entry) => entry.draft),
          );
          if (materializedImagePaths.length > 0) {
            effectiveMultimodalReadiness = assertActiveMultimodalReadyForAttachmentMediaPaths({
              mediaPaths: materializedImagePaths,
              multimodalReadiness: effectiveMultimodalReadiness,
              expectedModelId: activeModelId,
              mediaPathOccurrenceCount: retainedImagePaths.length + materializedImagePaths.length,
            });
            attachmentResolution.updateReadinessIdentity(effectiveMultimodalReadiness, activeModelId);
          }
          transientRegenerationDocuments = finalizeSelectedDocumentAssetWarnings(
            transientRegenerationDocuments,
            ownedMaterializedDocumentImageDrafts,
          );
        }
      }
      const transientDocumentImageAttachments = materializeAttachmentDraftsForMessage({
        threadId: activeThread.id,
        messageId: lastUserMessage.id,
        drafts: ownedMaterializedDocumentImageDrafts.map((entry) => entry.draft),
      });
      const stateAfterSessionSelection = useChatStore.getState();
      if (
        stateAfterSessionSelection.activeThreadId !== activeThread.id
        || stateAfterSessionSelection.threads[activeThread.id] !== activeThread
        || getThreadActiveModelId(activeThread) !== activeModelId
      ) {
        throw new Error('The conversation changed while selecting regeneration context. Try again.');
      }
      assertPromptPreparationEngineSnapshotCurrent(promptPreparationEngineSnapshot);
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
          expectedModelId: activeModelId,
          multimodalReadiness: effectiveMultimodalReadiness,
          attachmentResolution,
          generationWork,
          ...(usesTransientSessionDocumentContext
            ? {
                transientDocumentContentParts: transientRegenerationDocuments.contentParts,
                transientDocumentAttachmentIds: [...transientRegenerationAttachmentIds],
                transientDocumentImageAttachments,
              }
            : null),
        });

        return true;
      };

      if (!canReplaceCurrentTurnAssistant) {
        return await regenerateFromLastUserWithPreparedAttachments();
      }

      const syncedThread = syncThreadParametersCallback(activeThread);
      const assistantMessageId = replaceLastAssistantMessage(syncedThread.id);
      if (!assistantMessageId) {
        return await regenerateFromLastUserWithPreparedAttachments();
      }

      await runAssistantCompletion(syncedThread.id, assistantMessageId, {
        expectedModelId: activeModelId,
        multimodalReadiness: effectiveMultimodalReadiness,
        attachmentResolution,
        generationWork,
        ...(usesTransientSessionDocumentContext
          ? {
              transientDocumentContentParts: transientRegenerationDocuments.contentParts,
              transientDocumentAttachmentIds: [...transientRegenerationAttachmentIds],
              transientDocumentImageAttachments,
            }
          : null),
      });

      return true;
    } catch (error) {
      if (isChatGenerationCancelledError(error)) {
        return false;
      }
      throw error;
    } finally {
      unsubscribeDocumentCancellation();
      documentPreparationAbortControllersRef.current.delete(documentAbortController);
      if (ownedMaterializedDocumentImageDrafts.length > 0) {
        try {
          await chatAttachmentStorageService.discardDrafts(
            ownedMaterializedDocumentImageDrafts.map((entry) => entry.draft),
          );
        } catch (error) {
          console.warn('[ChatSession] Failed to discard transient regeneration document images', {
            ...getPrivacySafeErrorLogDetails(error),
          });
        }
      }
      if (isMountedRef.current) {
        setIsPreparingDocuments(false);
      }
      releaseInteractivePromptPreparation?.();
      generationWork.finish();
    }
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
    if (activeThread?.status === 'generating' || hasActiveChatGenerationWork()) {
      throw new AppError(
        'engine_busy',
        'Wait for the current chat work to finish before starting a new chat.',
      );
    }

    if (!beginNewThread()) {
      throw new Error('The new conversation could not be opened.');
    }
  }, [activeThread, beginNewThread]);

  const openThread = useCallback((threadId: string) => {
    const result = activateThreadForNavigation(threadId);
    switch (result.status) {
      case 'opened':
      case 'already_active':
        return;
      case 'missing':
        throw new AppError(
          'action_failed',
          'The selected conversation is no longer available.',
        );
      case 'generation_busy':
        throw new AppError(
          'engine_busy',
          'Stop the current response before switching conversations.',
        );
      case 'stale':
        throw new AppError(
          'action_failed',
          'The conversation changed before it could be opened. Try again.',
        );
      case 'persistence_failed':
        throw toAppError(result.error);
    }
  }, []);

  const deleteThread = useCallback((threadId: string) => {
    const thread = useChatStore.getState().getThread(threadId);
    if (thread?.status === 'generating') {
      throw new AppError(
        'engine_busy',
        'Stop the current response before deleting this conversation.',
      );
    }
    if (hasActiveChatGenerationWork()) {
      throw new AppError(
        'engine_busy',
        'Wait for the current chat work to finish before deleting this conversation.',
      );
    }

    assertPrivateStorageWritableForChatMutation();

    deleteThreadState(threadId);
    if (thread && !useChatStore.getState().getThread(threadId)) {
      void documentSessionContextCache.clearThread(threadId);
      void notificationService.dismissInferenceNotificationForThread(threadId);
    }
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

    if (activeThread.status === 'generating' || hasActiveChatGenerationWork()) {
      throw new AppError(
        'engine_busy',
        'Wait for the current chat work to finish before editing this conversation.',
      );
    }

    assertPrivateStorageWritableForChatMutation();

    const deleted = deleteMessageBranch(activeThread.id, messageId);
    if (deleted) {
      void documentSessionContextCache.retainThreadAttachments(
        activeThread.id,
        collectThreadDocumentAttachmentIds(useChatStore.getState().getThread(activeThread.id)),
      );
    }
    return deleted;
  }, [activeThread, deleteMessageBranch]);

  return {
    activeThread,
    messages: activeThread?.messages ?? [],
    messageListRevision,
    isGenerating: activeThread?.status === 'generating',
    isStoppingGeneration,
    isPreparingDocuments,
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
