import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { getAppStorage, mmkvStorage } from '../store/storage';
import {
  ChatMessage,
  ChatSummary,
  ChatThread,
  ChatThreadStatus,
  ConversationIndexItem,
  GenerationParamsSnapshot,
  PresetSnapshot,
  createChatId,
  deriveThreadActiveModelIdFromMessages,
  deriveThreadTitle,
  normalizeConversationTitle,
  sanitizeHydratedThread,
  buildConversationIndex,
  getThreadActiveModelId,
} from '../types/chat';
import { normalizeReasoningEffort } from '../types/reasoning';
import { createInstrumentedStateStorage } from './persistStateStorage';
import { assertPrivateStorageWritable } from '../services/storage';
import { performanceMonitor } from '../services/PerformanceMonitor';
import {
  chatAttachmentStorageService,
  collectChatAttachmentLocalUrisFromUnknownThreadRecord,
  collectReferencedChatAttachmentLocalUrisFromThreads,
} from '../services/ChatAttachmentStorageService';
import {
  CHAT_PERSISTENCE_SCHEMA_VERSION,
  CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
  type ChatPersistenceIndex,
  type ChatPersistencePendingIndexCommit,
  type ChatPersistenceWriteReason,
  type ChatStreamingProgressRecord,
  LEGACY_CHAT_STORE_STORAGE_KEY,
  clearPersistedChatRecords,
  createChatPersistenceWriteScheduler,
  getChatPersistenceIndexRevision,
  getChatStreamingProgressStorageKey,
  getChatThreadStorageKey,
  getThreadIdFromChatStreamingProgressArtifactStorageKey,
  getThreadIdFromChatThreadStorageKey,
  isChatStreamingProgressOperationWithinBounds,
  listChatStreamingProgressStorageKeys,
  listChatThreadStorageKeys,
  readChatPersistenceIndex,
  readChatPendingIndexCommit,
  readChatStreamingProgressRecord,
  readChatThreadRecord,
  recoverChatThreadFromStreamingProgress,
  recoverStaleStreamingThread,
  removeChatPendingIndexCommit,
  removeChatStreamingProgressRecord,
  removeChatThreadRecord,
  resolveNextChatPersistenceRevision,
  sanitizeChatMessageForPersistence,
  sanitizeChatThreadForPersistence,
  writeChatPersistenceIndex,
  writeChatPendingIndexCommit,
  writeChatStreamingProgressRecord,
  writeChatThreadRecord,
} from './chatPersistence';
import {
  buildChatBranchReplacementPlan,
  createChatBranchReplacementProgress,
  materializeChatBranchReplacementThread,
  validateChatBranchReplacementPlan,
  type ChatBranchBaseIdentity,
  type ChatBranchReplacementProgress,
  type ChatBranchReplacementPlan,
} from './chatBranchReplacement';

const FALLBACK_TOP_K = 40;
const FALLBACK_MIN_P = 0.05;
const FALLBACK_REPETITION_PENALTY = 1;
const CHAT_STORE_STORAGE_KEY = LEGACY_CHAT_STORE_STORAGE_KEY;
const UNREFERENCED_ATTACHMENT_CLEANUP_MAX_DELETES = 16;
const UNREFERENCED_ATTACHMENT_CLEANUP_RETRY_DELAY_MS = 1_000;
const UNREFERENCED_ATTACHMENT_CLEANUP_FAILURE_RETRY_LIMIT = 2;
const HYDRATION_ATTACHMENT_RECONCILIATION_MAX_DELETES = 16;
const HYDRATION_ATTACHMENT_RECONCILIATION_MAX_CANDIDATES = 16;
const HYDRATION_ATTACHMENT_RECONCILIATION_RETRY_DELAY_MS = 1_000;
const HYDRATION_ATTACHMENT_RECONCILIATION_ZERO_PROGRESS_RETRY_LIMIT = 2;
type DurableThreadPersistenceIdentity = {
  sourceThread: ChatThread;
  persistedAt: number;
  commitRevision?: number;
};
const latestDurableThreadIdentityById = new Map<string, DurableThreadPersistenceIdentity>();
const latestStreamingProgressPersistedAtById = new Map<string, number>();

const chatStoreStateStorage = createInstrumentedStateStorage(createChatStoreStateStorage(), {
  scope: 'chatStore',
  dedupe: true,
});

type ChatStorePersistedState = Partial<Pick<ChatStoreState, 'threads' | 'activeThreadId'>>;
type ChatStoreSnapshot = Pick<ChatStoreState, 'threads' | 'activeThreadId'>;

type HydrationAttachmentDirectoryReconciliationRequest = {
  preserveDraftsCreatedAtOrAfter: number;
  zeroProgressRetryCount: number;
};

type UnreferencedAttachmentCleanupRequest = {
  candidateLocalUris: Set<string>;
  referencedLocalUris: Set<string>;
  failureRetryCount: number;
};

interface ChatStoreHydrationResult {
  threads: Record<string, ChatThread>;
  activeThreadId: string | null;
  clearedAt?: number;
  corruptThreadIds?: string[];
  legacyBlockedByClear?: boolean;
}

interface CreateThreadInput {
  modelId: string;
  presetId: string | null;
  presetSnapshot: PresetSnapshot;
  paramsSnapshot: GenerationParamsSnapshot;
  title?: string;
}

type AssistantMessagePatch = Partial<
  Pick<ChatMessage, 'content' | 'thoughtContent' | 'tokensPerSec' | 'inferenceMetrics' | 'state' | 'errorCode' | 'errorMessage'>
>;

type AssistantTurnTerminalFields = Partial<
  Pick<ChatMessage, 'content' | 'tokensPerSec' | 'inferenceMetrics'>
> & {
  thoughtContent?: string | null;
};

export type AssistantTurnFinalization =
  | (AssistantTurnTerminalFields & { outcome: 'success' })
  | (AssistantTurnTerminalFields & { outcome: 'stopped' })
  | (AssistantTurnTerminalFields & {
      outcome: 'error';
      errorCode: string;
      errorMessage: string;
    });

export type AssistantTurnCommitResult =
  | { status: 'committed' }
  | { status: 'restored_without_write' }
  | { status: 'stale' }
  | {
      status: 'persistence_failed';
      error: unknown;
      recovery: {
        threadId: string;
        messageId: string;
        finalization: AssistantTurnFinalization;
      };
    };

interface ChatStoreState {
  threads: Record<string, ChatThread>;
  activeThreadId: string | null;
  streamingRevision: number;
  inferenceRevision: number;
  createThread: (input: CreateThreadInput) => string;
  mergeImportedThreads: (threads: ChatThread[]) => number;
  pruneExpiredThreads: (retentionDays: number | null, now?: number) => number;
  clearAllThreads: () => number;
  setActiveThread: (threadId: string | null) => void;
  updateThreadPresetSnapshot: (threadId: string, presetId: string | null, presetSnapshot: PresetSnapshot) => void;
  updateThreadParamsSnapshot: (threadId: string, paramsSnapshot: GenerationParamsSnapshot) => void;
  switchThreadModel: (threadId: string, nextModelId: string, at?: number) => string | null;
  appendMessage: (threadId: string, message: ChatMessage) => void;
  createAssistantPlaceholder: (threadId: string, modelId?: string) => string;
  finalizeAssistantTurn: (
    threadId: string,
    messageId: string,
    finalization: AssistantTurnFinalization,
  ) => AssistantTurnCommitResult;
  stopAssistantMessage: (threadId: string, messageId: string) => AssistantTurnCommitResult;
  finalizeAssistantMessage: (
    threadId: string,
    messageId: string,
    content: string,
    thoughtContent?: string | null,
  ) => AssistantTurnCommitResult;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => boolean;
  deleteMessageBranch: (threadId: string, messageId: string) => boolean;
  patchAssistantMessage: (
    threadId: string,
    messageId: string,
    updates: AssistantMessagePatch,
  ) => AssistantTurnCommitResult | undefined;
  replaceLastAssistantMessage: (threadId: string) => string | null;
  replaceBranchFromUserMessage: (
    threadId: string,
    messageId: string,
    nextUserContent: string,
    paramsSnapshot?: GenerationParamsSnapshot,
  ) => string | null;
  finalizeThreadStatus: (threadId: string, status: ChatThreadStatus) => void;
  setThreadSummary: (threadId: string, summary: ChatSummary | undefined) => void;
  getThread: (threadId: string | null) => ChatThread | null;
  getActiveThread: () => ChatThread | null;
  getConversationIndex: () => ConversationIndexItem[];
}

function updateThreadMetadata(thread: ChatThread, updatedAt = Date.now()): ChatThread {
  const derivedTitle = deriveThreadTitle(thread.messages);
  const title =
    thread.titleSource === 'manual'
      ? normalizeConversationTitle(thread.title) || derivedTitle
      : derivedTitle;

  return {
    ...thread,
    title,
    updatedAt,
  };
}

function createModelSwitchMessage({
  fromModelId,
  toModelId,
  createdAt,
}: {
  fromModelId: string;
  toModelId: string;
  createdAt: number;
}): ChatMessage {
  return {
    id: createChatId('message'),
    role: 'system',
    kind: 'model_switch',
    content: '',
    modelId: toModelId,
    switchFromModelId: fromModelId,
    switchToModelId: toModelId,
    createdAt,
    state: 'complete',
  };
}

let unreferencedAttachmentCleanupInFlight = false;
let queuedUnreferencedAttachmentCleanupRequest: UnreferencedAttachmentCleanupRequest | null = null;
let unreferencedAttachmentCleanupRetryTimeout: ReturnType<typeof setTimeout> | null = null;

function mergeUnreferencedAttachmentCleanupRequest(
  current: UnreferencedAttachmentCleanupRequest | null,
  next: UnreferencedAttachmentCleanupRequest,
): UnreferencedAttachmentCleanupRequest {
  if (!current) {
    return next;
  }

  return {
    candidateLocalUris: new Set([...current.candidateLocalUris, ...next.candidateLocalUris]),
    referencedLocalUris: new Set([...current.referencedLocalUris, ...next.referencedLocalUris]),
    failureRetryCount: Math.max(current.failureRetryCount, next.failureRetryCount),
  };
}

function queueUnreferencedAttachmentCleanup(
  request: UnreferencedAttachmentCleanupRequest,
): void {
  queuedUnreferencedAttachmentCleanupRequest = mergeUnreferencedAttachmentCleanupRequest(
    queuedUnreferencedAttachmentCleanupRequest,
    request,
  );
}

function takeQueuedUnreferencedAttachmentCleanupRequest(): UnreferencedAttachmentCleanupRequest | null {
  const request = queuedUnreferencedAttachmentCleanupRequest;
  queuedUnreferencedAttachmentCleanupRequest = null;
  return request;
}

function getUnreferencedAttachmentCleanupRetryDelay(failureRetryCount: number): number {
  return UNREFERENCED_ATTACHMENT_CLEANUP_RETRY_DELAY_MS
    * (2 ** Math.max(0, failureRetryCount - 1));
}

function scheduleQueuedUnreferencedAttachmentCleanupRetry(failureRetryCount: number): void {
  if (unreferencedAttachmentCleanupRetryTimeout !== null) {
    return;
  }

  unreferencedAttachmentCleanupRetryTimeout = setTimeout(() => {
    unreferencedAttachmentCleanupRetryTimeout = null;
    runQueuedUnreferencedAttachmentCleanup();
  }, getUnreferencedAttachmentCleanupRetryDelay(failureRetryCount));
}

function runQueuedUnreferencedAttachmentCleanup(): void {
  if (unreferencedAttachmentCleanupInFlight || unreferencedAttachmentCleanupRetryTimeout !== null) {
    return;
  }

  const request = takeQueuedUnreferencedAttachmentCleanupRequest();
  if (!request || request.candidateLocalUris.size === 0) {
    return;
  }

  unreferencedAttachmentCleanupInFlight = true;
  let retryRequestAfterFailure: UnreferencedAttachmentCleanupRequest | null = null;

  void Promise.resolve()
    .then(async () => {
      const candidates = Array.from(request.candidateLocalUris);
      const batchCandidates = candidates.slice(0, UNREFERENCED_ATTACHMENT_CLEANUP_MAX_DELETES);
      const remainingCandidates = candidates.slice(UNREFERENCED_ATTACHMENT_CLEANUP_MAX_DELETES);
      const latestReferencedLocalUris = collectReferencedChatAttachmentLocalUrisFromThreads(
        useChatStore.getState().threads,
      );
      const referencedLocalUris = new Set(request.referencedLocalUris);
      // Queued cleanup requests can overlap: an attachment may be referenced in
      // an older queued request and become a delete candidate in a later one.
      // Only the latest store state should protect current candidates from
      // deletion; stale queued references must not keep newly orphaned files.
      batchCandidates.forEach((localUri) => referencedLocalUris.delete(localUri));
      latestReferencedLocalUris.forEach((localUri) => referencedLocalUris.add(localUri));
      const deletableBatchCandidates = batchCandidates.filter(
        (localUri) => !referencedLocalUris.has(localUri),
      );

      if (batchCandidates.length > 0) {
        try {
          const deletedCount = await chatAttachmentStorageService.deleteUnreferencedAttachmentFiles({
            candidateLocalUris: batchCandidates,
            referencedLocalUris,
            maxDeletes: UNREFERENCED_ATTACHMENT_CLEANUP_MAX_DELETES,
          });
          if (deletedCount !== deletableBatchCandidates.length) {
            retryRequestAfterFailure = {
              candidateLocalUris: new Set([
                ...deletableBatchCandidates,
                ...remainingCandidates,
              ]),
              referencedLocalUris: request.referencedLocalUris,
              failureRetryCount: request.failureRetryCount + 1,
            };
            throw new Error('Incomplete unreferenced attachment cleanup');
          }
        } catch (error) {
          retryRequestAfterFailure ??= {
            candidateLocalUris: new Set([...batchCandidates, ...remainingCandidates]),
            referencedLocalUris: request.referencedLocalUris,
            failureRetryCount: request.failureRetryCount + 1,
          };
          throw error;
        }
      }

      if (remainingCandidates.length > 0) {
        queueUnreferencedAttachmentCleanup({
          candidateLocalUris: new Set(remainingCandidates),
          referencedLocalUris: request.referencedLocalUris,
          failureRetryCount: 0,
        });
      }
    })
    .catch((error) => {
      console.warn('[chatStore] Failed to clean up chat attachments', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    })
    .finally(() => {
      unreferencedAttachmentCleanupInFlight = false;
      if (
        retryRequestAfterFailure?.candidateLocalUris.size
        && retryRequestAfterFailure.failureRetryCount
          <= UNREFERENCED_ATTACHMENT_CLEANUP_FAILURE_RETRY_LIMIT
      ) {
        queueUnreferencedAttachmentCleanup(retryRequestAfterFailure);
        scheduleQueuedUnreferencedAttachmentCleanupRetry(retryRequestAfterFailure.failureRetryCount);
        return;
      }

      if (queuedUnreferencedAttachmentCleanupRequest) {
        runQueuedUnreferencedAttachmentCleanup();
      }
    });
}

function scheduleUnreferencedChatAttachmentCleanup({
  candidateLocalUris,
  referencedLocalUris,
}: {
  candidateLocalUris: Iterable<string>;
  referencedLocalUris: Iterable<string>;
}): void {
  const candidates = Array.from(new Set(candidateLocalUris));
  if (candidates.length === 0) {
    return;
  }

  queueUnreferencedAttachmentCleanup({
    candidateLocalUris: new Set(candidates),
    referencedLocalUris: new Set(referencedLocalUris),
    failureRetryCount: 0,
  });
  runQueuedUnreferencedAttachmentCleanup();
}

function scheduleChatAttachmentCleanupForSnapshots(
  previous: ChatStoreSnapshot,
  next: ChatStoreSnapshot,
): void {
  scheduleUnreferencedChatAttachmentCleanup({
    candidateLocalUris: collectReferencedChatAttachmentLocalUrisFromThreads(previous.threads),
    referencedLocalUris: collectReferencedChatAttachmentLocalUrisFromThreads(next.threads),
  });
}

function collectReferencedChatAttachmentLocalUrisFromThread(thread: ChatThread | undefined): Set<string> {
  return thread ? collectReferencedChatAttachmentLocalUrisFromThreads([thread]) : new Set();
}

function addSetValues<T>(target: Set<T>, source: Iterable<T>): void {
  for (const value of source) {
    target.add(value);
  }
}

function collectAttachmentCleanupCandidatesForThreadChanges(
  previous: ChatStoreSnapshot,
  next: ChatStoreSnapshot,
  {
    changedThreadIds,
    removedThreadIds,
  }: {
    changedThreadIds: readonly string[];
    removedThreadIds: readonly string[];
  },
): Set<string> {
  const candidates = new Set<string>();

  removedThreadIds.forEach((threadId) => {
    addSetValues(candidates, collectReferencedChatAttachmentLocalUrisFromThread(previous.threads[threadId]));
  });

  changedThreadIds.forEach((threadId) => {
    const previousReferences = collectReferencedChatAttachmentLocalUrisFromThread(previous.threads[threadId]);
    const nextReferences = collectReferencedChatAttachmentLocalUrisFromThread(next.threads[threadId]);

    if (previousReferences.size > 0) {
      previousReferences.forEach((localUri) => {
        if (!nextReferences.has(localUri)) {
          candidates.add(localUri);
        }
      });
    }

    const thread = next.threads[threadId];
    if (!thread || nextReferences.size === 0) {
      return;
    }

    const persistedReferences = collectReferencedChatAttachmentLocalUrisFromThread(
      sanitizeChatThreadForPersistence(thread),
    );
    nextReferences.forEach((localUri) => {
      if (!persistedReferences.has(localUri)) {
        candidates.add(localUri);
      }
    });
  });

  return candidates;
}

function collectReferencedChatAttachmentLocalUrisForPersistedSnapshot(
  threads: Record<string, ChatThread>,
  changedThreadIds: readonly string[],
): Set<string> {
  const changedThreadIdSet = new Set(changedThreadIds);
  return collectReferencedChatAttachmentLocalUrisFromThreads(
    Object.values(threads).map((thread) => (
      changedThreadIdSet.has(thread.id) ? sanitizeChatThreadForPersistence(thread) : thread
    )),
  );
}

function collectProtectedChatAttachmentLocalUrisForThreadChanges(
  threads: Record<string, ChatThread>,
  changedThreadIds: readonly string[],
): Set<string> {
  const protectedReferences = collectReferencedChatAttachmentLocalUrisForPersistedSnapshot(
    threads,
    changedThreadIds,
  );
  addSetValues(protectedReferences, collectReferencedChatAttachmentLocalUrisFromThreads(threads));
  return protectedReferences;
}

function scheduleChatAttachmentCleanupForThreadChanges(
  previous: ChatStoreSnapshot,
  next: ChatStoreSnapshot,
  changes: {
    changedThreadIds: readonly string[];
    removedThreadIds: readonly string[];
  },
): void {
  const candidateLocalUris = collectAttachmentCleanupCandidatesForThreadChanges(previous, next, changes);
  if (candidateLocalUris.size === 0) {
    return;
  }

  scheduleUnreferencedChatAttachmentCleanup({
    candidateLocalUris,
    referencedLocalUris: collectProtectedChatAttachmentLocalUrisForThreadChanges(
      next.threads,
      changes.changedThreadIds,
    ),
  });
}

function scheduleChatAttachmentCleanupForStreamingPatch(
  previous: ChatStoreSnapshot,
  next: ChatStoreSnapshot,
  removedThreadIds: string[],
): void {
  if (removedThreadIds.length > 0) {
    scheduleChatAttachmentCleanupForSnapshots(previous, next);
  }
}

let hydrationAttachmentDirectoryReconciliationInFlight = false;
let hydrationAttachmentDirectoryReconciliationRetryPending = false;
let queuedHydrationAttachmentDirectoryReconciliationRequest:
  | HydrationAttachmentDirectoryReconciliationRequest
  | null = null;

function mergeHydrationAttachmentDirectoryReconciliationRequest(
  current: HydrationAttachmentDirectoryReconciliationRequest | null,
  next: HydrationAttachmentDirectoryReconciliationRequest,
): HydrationAttachmentDirectoryReconciliationRequest {
  if (!current) {
    return next;
  }

  return {
    preserveDraftsCreatedAtOrAfter: Math.min(
      current.preserveDraftsCreatedAtOrAfter,
      next.preserveDraftsCreatedAtOrAfter,
    ),
    zeroProgressRetryCount: Math.max(current.zeroProgressRetryCount, next.zeroProgressRetryCount),
  };
}

function getHydrationAttachmentDirectoryReconciliationRetryDelay(
  zeroProgressRetryCount: number,
): number {
  return HYDRATION_ATTACHMENT_RECONCILIATION_RETRY_DELAY_MS * Math.max(1, zeroProgressRetryCount);
}

function queueHydrationAttachmentDirectoryReconciliation(
  request: HydrationAttachmentDirectoryReconciliationRequest,
): void {
  queuedHydrationAttachmentDirectoryReconciliationRequest = mergeHydrationAttachmentDirectoryReconciliationRequest(
    queuedHydrationAttachmentDirectoryReconciliationRequest,
    request,
  );
}

function takeQueuedHydrationAttachmentDirectoryReconciliationRequest():
  | HydrationAttachmentDirectoryReconciliationRequest
  | null {
  const request = queuedHydrationAttachmentDirectoryReconciliationRequest;
  queuedHydrationAttachmentDirectoryReconciliationRequest = null;
  return request;
}

function runHydrationAttachmentDirectoryReconciliation(
  request: HydrationAttachmentDirectoryReconciliationRequest,
): void {
  if (hydrationAttachmentDirectoryReconciliationInFlight) {
    queueHydrationAttachmentDirectoryReconciliation(request);
    return;
  }

  hydrationAttachmentDirectoryReconciliationInFlight = true;

  void Promise.resolve()
    .then(async () => {
      const referencedLocalUris = collectReferencedChatAttachmentLocalUrisFromThreads(
        useChatStore.getState().threads,
      );
      const result = await chatAttachmentStorageService.reconcileAttachmentDirectory(
        referencedLocalUris,
        {
          preserveDraftsCreatedAtOrAfter: request.preserveDraftsCreatedAtOrAfter,
          maxCandidates: HYDRATION_ATTACHMENT_RECONCILIATION_MAX_CANDIDATES,
          maxDeletes: HYDRATION_ATTACHMENT_RECONCILIATION_MAX_DELETES,
        },
      );

      const hasDeleteFailures = result.attemptedDeleteCount > result.deletedCount;
      if (!result.hasMoreCandidates && !hasDeleteFailures) {
        return;
      }

      if (result.deletedCount > 0) {
        scheduleHydrationAttachmentDirectoryReconciliationRetry({
          preserveDraftsCreatedAtOrAfter: request.preserveDraftsCreatedAtOrAfter,
          zeroProgressRetryCount: 0,
        });
        return;
      }

      if (
        result.attemptedDeleteCount > 0
        && request.zeroProgressRetryCount < HYDRATION_ATTACHMENT_RECONCILIATION_ZERO_PROGRESS_RETRY_LIMIT
      ) {
        scheduleHydrationAttachmentDirectoryReconciliationRetry({
          preserveDraftsCreatedAtOrAfter: request.preserveDraftsCreatedAtOrAfter,
          zeroProgressRetryCount: request.zeroProgressRetryCount + 1,
        });
      }
    })
    .catch((error) => {
      console.warn('[chatStore] Failed to reconcile chat attachment directory', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    })
    .finally(() => {
      hydrationAttachmentDirectoryReconciliationInFlight = false;
      if (!hydrationAttachmentDirectoryReconciliationRetryPending) {
        const queuedRequest = takeQueuedHydrationAttachmentDirectoryReconciliationRequest();
        if (queuedRequest) {
          runHydrationAttachmentDirectoryReconciliation(queuedRequest);
        }
      }
    });
}

function scheduleHydrationAttachmentDirectoryReconciliationRetry(
  request: HydrationAttachmentDirectoryReconciliationRequest,
): void {
  queueHydrationAttachmentDirectoryReconciliation(request);
  if (hydrationAttachmentDirectoryReconciliationRetryPending) {
    return;
  }

  hydrationAttachmentDirectoryReconciliationRetryPending = true;
  setTimeout(() => {
    hydrationAttachmentDirectoryReconciliationRetryPending = false;
    if (hydrationAttachmentDirectoryReconciliationInFlight) {
      return;
    }

    const queuedRequest = takeQueuedHydrationAttachmentDirectoryReconciliationRequest();
    if (queuedRequest) {
      runHydrationAttachmentDirectoryReconciliation(queuedRequest);
    }
  }, getHydrationAttachmentDirectoryReconciliationRetryDelay(request.zeroProgressRetryCount));
}

function scheduleChatAttachmentDirectoryReconciliation(
  preserveDraftsCreatedAtOrAfter = Date.now(),
): void {
  const request: HydrationAttachmentDirectoryReconciliationRequest = {
    preserveDraftsCreatedAtOrAfter,
    zeroProgressRetryCount: 0,
  };

  if (
    hydrationAttachmentDirectoryReconciliationInFlight
    || hydrationAttachmentDirectoryReconciliationRetryPending
  ) {
    queueHydrationAttachmentDirectoryReconciliation(request);
    return;
  }

  runHydrationAttachmentDirectoryReconciliation(request);
}

function collectPersistedThreadAttachmentCleanupCandidates(
  storage: ReturnType<typeof getAppStorage>,
  threadId: string,
): Set<string> {
  const rawRecord = storage.getString(getChatThreadStorageKey(threadId));
  if (!rawRecord) {
    return new Set();
  }

  try {
    return collectChatAttachmentLocalUrisFromUnknownThreadRecord(JSON.parse(rawRecord));
  } catch {
    return new Set();
  }
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function getExpiredThreadIds(
  threads: Record<string, ChatThread>,
  retentionDays: number | null,
  now = Date.now(),
  activeThreadId: string | null = null,
) {
  if (retentionDays == null) {
    return [];
  }

  const cutoffTimestamp = now - retentionDays * MILLISECONDS_PER_DAY;

  return Object.values(threads)
    .filter((thread) => thread.id !== activeThreadId && thread.updatedAt < cutoffTimestamp)
    .map((thread) => thread.id);
}

export function findMostRecentThreadId(threads: Record<string, ChatThread>): string | null {
  let bestId: string | null = null;
  let bestUpdatedAt = -Infinity;

  for (const thread of Object.values(threads)) {
    if (!bestId || thread.updatedAt > bestUpdatedAt) {
      bestId = thread.id;
      bestUpdatedAt = thread.updatedAt;
    }
  }

  return bestId;
}

function createChatStoreStateStorage(): StateStorage {
  return {
    ...mmkvStorage,
    getItem: (name) => {
      const value = mmkvStorage.getItem(name);
      if (name !== CHAT_STORE_STORAGE_KEY) {
        return value;
      }

      if (typeof value === 'string') {
        if (canParsePersistedJson(value)) {
          return value;
        }
      } else if (value != null) {
        return value;
      }

      try {
        return hasV2ChatPersistence()
          ? createChatStoreHydrationSentinel()
          : null;
      } catch {
        return null;
      }
    },
  };
}

function hasV2ChatPersistence() {
  const storage = getAppStorage();
  if (readChatPersistenceIndex(storage).ok) {
    return true;
  }

  if (readChatPendingIndexCommit(storage).ok) {
    return true;
  }

  return listChatThreadStorageKeys(storage).length > 0;
}

function canParsePersistedJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed);
  } catch {
    return false;
  }
}

function createChatStoreHydrationSentinel(): string {
  return JSON.stringify({
    state: { activeThreadId: null },
    version: CHAT_PERSISTENCE_SCHEMA_VERSION,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isChatThreadStatus(value: unknown): value is ChatThreadStatus {
  return value === 'idle' || value === 'generating' || value === 'stopped' || value === 'error';
}

function isHydratableChatThread(value: unknown): value is ChatThread {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.modelId === 'string' &&
    (typeof value.presetId === 'string' || value.presetId === null) &&
    isRecord(value.paramsSnapshot) &&
    Array.isArray(value.messages) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    isChatThreadStatus(value.status)
  );
}

function sanitizePersistedChatThread(
  value: unknown,
  now = Date.now(),
): { thread: ChatThread; recovered: boolean } | null {
  if (!isHydratableChatThread(value)) {
    return null;
  }

  try {
    const recoveredThread = recoverStaleStreamingThread(value, now);
    return {
      thread: sanitizeHydratedThread(recoveredThread),
      recovered: recoveredThread !== value,
    };
  } catch {
    return null;
  }
}

function resolveActiveThreadId(
  threads: Record<string, ChatThread>,
  activeThreadId: string | null | undefined,
  options?: { fallbackOnExplicitNull?: boolean },
) {
  if (activeThreadId === null && !options?.fallbackOnExplicitNull) {
    return null;
  }

  return activeThreadId && threads[activeThreadId]
    ? activeThreadId
    : findMostRecentThreadId(threads);
}

function createChatPersistenceIndexForSnapshot(
  snapshot: ChatStoreSnapshot,
  options?: {
    updatedAt?: number;
    revision?: number;
    migratedFromLegacyAt?: number;
    corruptThreadIds?: string[];
  },
): ChatPersistenceIndex {
  const threadIds = Object.keys(snapshot.threads);
  return {
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    activeThreadId: resolveActiveThreadId(snapshot.threads, snapshot.activeThreadId),
    threadIds,
    updatedAt: options?.updatedAt ?? Date.now(),
    revision: options?.revision,
    migratedFromLegacyAt: options?.migratedFromLegacyAt,
    corruptThreadIds: options?.corruptThreadIds?.length ? options.corruptThreadIds : undefined,
  };
}

function writeChatPersistenceIndexForSnapshot(
  storage: ReturnType<typeof getAppStorage>,
  snapshot: ChatStoreSnapshot,
  options?: {
    updatedAt?: number;
    revision?: number;
    migratedFromLegacyAt?: number;
    corruptThreadIds?: string[];
  },
) {
  const index = createChatPersistenceIndexForSnapshot(snapshot, options);
  writeChatPersistenceIndex(storage, index);
  return index;
}

function resolveThreadRecordPersistedAtForWrite(
  storage: ReturnType<typeof getAppStorage>,
  now = Date.now(),
) {
  const indexResult = readChatPersistenceIndex(storage);
  if (!indexResult.ok) {
    return now;
  }

  const { clearedAt, threadIds } = indexResult.value;
  if (clearedAt == null || threadIds.length > 0) {
    return now;
  }

  return Math.max(now, clearedAt + 1);
}

function cacheDurableThreadPersistenceIdentity(
  sourceThread: ChatThread,
  persistedAt: number,
  commitRevision?: number,
): DurableThreadPersistenceIdentity {
  const identity: DurableThreadPersistenceIdentity = {
    sourceThread,
    persistedAt,
    commitRevision,
  };
  latestDurableThreadIdentityById.set(sourceThread.id, identity);
  return identity;
}

function removeChatThreadRecordAndInvalidateIdentity(
  storage: ReturnType<typeof getAppStorage>,
  threadId: string,
): void {
  removeChatThreadRecord(storage, threadId);
  latestDurableThreadIdentityById.delete(threadId);
}

function clearPersistedChatRecordsAndInvalidateRuntimeCaches(
  storage: ReturnType<typeof getAppStorage>,
): void {
  // Clearing chat persistence is a multi-record transaction. Invalidate the
  // process-local identities before its first write so a partial clear cannot
  // leave an old exact source reference trusted by the branch hot path.
  // Successful rollback writes repopulate only the identities they actually
  // restore; failed rollback writes therefore remain fail-closed.
  latestDurableThreadIdentityById.clear();
  latestStreamingProgressPersistedAtById.clear();
  clearPersistedChatRecords(storage);
}

function writeChatThreadRecordForMutation(
  storage: ReturnType<typeof getAppStorage>,
  thread: ChatThread,
  options?: { commitRevision?: number; persistedAt?: number },
) {
  const persistedAt = options?.persistedAt ?? Math.max(
    resolveThreadRecordPersistedAtForWrite(storage),
    (latestDurableThreadIdentityById.get(thread.id)?.persistedAt ?? 0) + 1,
    (latestStreamingProgressPersistedAtById.get(thread.id) ?? 0) + 1,
  );
  writeChatThreadRecord(storage, thread, persistedAt, {
    commitRevision: options?.commitRevision,
  });
  cacheDurableThreadPersistenceIdentity(thread, persistedAt, options?.commitRevision);
}

function writeChatPersistenceSnapshotTransaction(
  storage: ReturnType<typeof getAppStorage>,
  snapshot: ChatStoreSnapshot,
  reason: ChatPersistenceWriteReason,
  options?: {
    changedThreadIds?: string[];
    changedThreadPersistedAt?: ReadonlyMap<string, number>;
    removedThreadIds?: string[];
    migratedFromLegacyAt?: number;
    corruptThreadIds?: string[];
  },
) {
  const updatedAt = Date.now();
  const revision = resolveNextChatPersistenceRevision(storage);
  const index = createChatPersistenceIndexForSnapshot(snapshot, {
    updatedAt,
    revision,
    migratedFromLegacyAt: options?.migratedFromLegacyAt,
    corruptThreadIds: options?.corruptThreadIds,
  });
  const changedThreadIds = options?.changedThreadIds?.filter((threadId) => snapshot.threads[threadId]) ?? [];
  const removedThreadIds = options?.removedThreadIds ?? [];

  writeChatPendingIndexCommit(storage, {
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    revision,
    activeThreadId: index.activeThreadId,
    threadIds: index.threadIds,
    updatedAt,
    reason,
    changedThreadIds: changedThreadIds.length ? changedThreadIds : undefined,
    requiresChangedThreadCommitRevision: changedThreadIds.length ? true : undefined,
    removedThreadIds: removedThreadIds.length ? removedThreadIds : undefined,
    corruptThreadIds: index.corruptThreadIds,
    migratedFromLegacyAt: index.migratedFromLegacyAt,
  });

  changedThreadIds.forEach((threadId) => {
    const thread = snapshot.threads[threadId];
    if (thread) {
      writeChatThreadRecordForMutation(storage, thread, {
        commitRevision: revision,
        persistedAt: options?.changedThreadPersistedAt?.get(threadId),
      });
    }
  });
  removedThreadIds.forEach((threadId) => {
    removeChatThreadRecordAndInvalidateIdentity(storage, threadId);
  });

  writeChatPersistenceIndex(storage, index);
  removeChatPendingIndexCommit(storage);
}

function readHydratableChatThreadRecord(
  storage: ReturnType<typeof getAppStorage>,
  threadId: string,
  now: number,
):
  | {
      ok: true;
      thread: ChatThread;
      recovered: boolean;
      persistedAt: number;
      commitRevision?: number;
      droppedAttachmentLocalUris: Set<string>;
    }
  | { ok: false; persistedAt?: number } {
  const recordResult = readChatThreadRecord(storage, threadId);
  if (!recordResult.ok) {
    return { ok: false };
  }

  const sanitized = sanitizePersistedChatThread(recordResult.value.thread, now);
  if (!sanitized) {
    return { ok: false, persistedAt: recordResult.value.persistedAt };
  }

  const rawAttachmentLocalUris = collectReferencedChatAttachmentLocalUrisFromThreads([recordResult.value.thread]);
  const sanitizedAttachmentLocalUris = collectReferencedChatAttachmentLocalUrisFromThreads([sanitized.thread]);
  const droppedAttachmentLocalUris = new Set(
    Array.from(rawAttachmentLocalUris).filter((localUri) => !sanitizedAttachmentLocalUris.has(localUri)),
  );

  return {
    ok: true,
    thread: sanitized.thread,
    recovered: sanitized.recovered,
    persistedAt: recordResult.value.persistedAt,
    commitRevision: recordResult.value.commitRevision,
    droppedAttachmentLocalUris,
  };
}

function discardStreamingProgressDuringHydration(
  storage: ReturnType<typeof getAppStorage>,
  threadId: string,
): void {
  try {
    removeChatStreamingProgressRecord(storage, threadId);
    latestStreamingProgressPersistedAtById.delete(threadId);
  } catch (error) {
    console.warn('[ChatPersistence] Failed to discard unusable streaming progress', {
      errorName: getErrorName(error),
    });
  }
}

function applyStreamingProgressDuringHydration(
  storage: ReturnType<typeof getAppStorage>,
  record: Extract<ReturnType<typeof readHydratableChatThreadRecord>, { ok: true }>,
  now: number,
): Extract<ReturnType<typeof readHydratableChatThreadRecord>, { ok: true }> {
  const progressResult = readChatStreamingProgressRecord(storage, record.thread.id);
  if (!progressResult.ok) {
    if (progressResult.reason !== 'missing') {
      discardStreamingProgressDuringHydration(storage, record.thread.id);
    }
    return record;
  }

  const progress = progressResult.value;
  latestStreamingProgressPersistedAtById.set(record.thread.id, progress.persistedAt);
  const recovery = recoverChatThreadFromStreamingProgress(
    record.thread,
    record.persistedAt,
    progress,
    now,
    record.commitRevision,
  );
  if (recovery.outcome !== 'recovered') {
    discardStreamingProgressDuringHydration(storage, record.thread.id);
    return record;
  }

  const recoveredPersistedAt = Math.max(now, progress.persistedAt + 1);
  try {
    writeChatThreadRecordForMutation(storage, recovery.thread, {
      persistedAt: recoveredPersistedAt,
      commitRevision: record.commitRevision,
    });
    discardStreamingProgressDuringHydration(storage, record.thread.id);
    const recoveredAttachmentLocalUris = collectReferencedChatAttachmentLocalUrisFromThreads([
      recovery.thread,
    ]);
    const droppedAttachmentLocalUris = new Set(record.droppedAttachmentLocalUris);
    collectReferencedChatAttachmentLocalUrisFromThreads([record.thread])
      .forEach((localUri) => {
        if (!recoveredAttachmentLocalUris.has(localUri)) {
          droppedAttachmentLocalUris.add(localUri);
        }
      });

    return {
      ...record,
      thread: recovery.thread,
      recovered: false,
      persistedAt: recoveredPersistedAt,
      droppedAttachmentLocalUris,
    };
  } catch (error) {
    console.warn('[ChatPersistence] Failed to durably commit recovered streaming progress', {
      errorName: getErrorName(error),
    });
    return record;
  }
}

function discardOrphanedStreamingProgressRecords(
  storage: ReturnType<typeof getAppStorage>,
  survivingThreadIds: ReadonlySet<string>,
): void {
  const artifactThreadIds = new Set<string>();
  const authoritativeHeadThreadIds = new Set<string>();
  listChatStreamingProgressStorageKeys(storage).forEach((key) => {
    const threadId = getThreadIdFromChatStreamingProgressArtifactStorageKey(key);
    if (threadId) {
      artifactThreadIds.add(threadId);
      if (key === getChatStreamingProgressStorageKey(threadId)) {
        authoritativeHeadThreadIds.add(threadId);
      }
      return;
    }
    try {
      storage.remove(key);
    } catch (error) {
      console.warn('[ChatPersistence] Failed to discard orphaned streaming progress', {
        errorName: getErrorName(error),
      });
    }
  });
  artifactThreadIds.forEach((threadId) => {
    if (survivingThreadIds.has(threadId) && authoritativeHeadThreadIds.has(threadId)) {
      return;
    }
    try {
      removeChatStreamingProgressRecord(storage, threadId);
      latestStreamingProgressPersistedAtById.delete(threadId);
    } catch (error) {
      console.warn('[ChatPersistence] Failed to discard orphaned streaming progress', {
        errorName: getErrorName(error),
      });
    }
  });
  latestDurableThreadIdentityById.forEach((_identity, threadId) => {
    if (!survivingThreadIds.has(threadId)) {
      latestDurableThreadIdentityById.delete(threadId);
    }
  });
  latestStreamingProgressPersistedAtById.forEach((_persistedAt, threadId) => {
    if (!survivingThreadIds.has(threadId)) {
      latestStreamingProgressPersistedAtById.delete(threadId);
    }
  });
}

function sameStringList(left: string[], right: string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function isPendingIndexCommitAlreadyApplied(
  index: ChatPersistenceIndex | null,
  pending: ChatPersistencePendingIndexCommit,
) {
  if (!index) {
    return false;
  }

  if (getChatPersistenceIndexRevision(index) > pending.revision) {
    return true;
  }

  return (
    getChatPersistenceIndexRevision(index) === pending.revision &&
    index.activeThreadId === pending.activeThreadId &&
    sameStringList(index.threadIds, pending.threadIds)
  );
}

function discardUnappliedPendingIndexCommit(
  storage: ReturnType<typeof getAppStorage>,
  pending: ChatPersistencePendingIndexCommit,
  index: ChatPersistenceIndex | null,
): void {
  const indexedThreadIds = new Set(index?.threadIds ?? []);
  pending.changedThreadIds?.forEach((threadId) => {
    if (!indexedThreadIds.has(threadId)) {
      removeChatThreadRecordAndInvalidateIdentity(storage, threadId);
    }
  });

  removeChatPendingIndexCommit(storage);
}

function recoverPendingChatIndexCommit(storage: ReturnType<typeof getAppStorage>, now: number): void {
  const pendingResult = readChatPendingIndexCommit(storage);
  if (!pendingResult.ok) {
    if (pendingResult.reason !== 'missing') {
      removeChatPendingIndexCommit(storage);
    }
    return;
  }

  const pending = pendingResult.value;
  const indexResult = readChatPersistenceIndex(storage);
  const index = indexResult.ok ? indexResult.value : null;
  if (isPendingIndexCommitAlreadyApplied(index, pending)) {
    if (getChatPersistenceIndexRevision(index) === pending.revision) {
      pending.removedThreadIds?.forEach((threadId) => {
        removeChatThreadRecordAndInvalidateIdentity(storage, threadId);
      });
    }
    removeChatPendingIndexCommit(storage);
    return;
  }

  const threads: Record<string, ChatThread> = {};
  const corruptThreadIds = new Set(pending.corruptThreadIds ?? []);
  const changedThreadIds = new Set(pending.changedThreadIds ?? []);
  const removedThreadIds = new Set(pending.removedThreadIds ?? []);
  const attachmentCleanupCandidates = new Set<string>();
  const requiresChangedThreadCommitRevision = pending.requiresChangedThreadCommitRevision === true;
  const recordCache = new Map<string, ReturnType<typeof readHydratableChatThreadRecord>>();
  const readCachedRecord = (threadId: string) => {
    const cachedRecord = recordCache.get(threadId);
    if (cachedRecord) {
      return cachedRecord;
    }

    const record = readHydratableChatThreadRecord(storage, threadId, now);
    recordCache.set(threadId, record);
    return record;
  };

  const hasUnappliedChangedRecord = (pending.changedThreadIds ?? []).some((threadId) => {
    if (removedThreadIds.has(threadId)) {
      return false;
    }

    const record = readCachedRecord(threadId);
    if (!record.ok) {
      return true;
    }

    if (record.commitRevision === undefined) {
      return requiresChangedThreadCommitRevision || record.persistedAt < pending.updatedAt;
    }

    return record.commitRevision !== pending.revision;
  });
  if (hasUnappliedChangedRecord) {
    discardUnappliedPendingIndexCommit(storage, pending, index);
    return;
  }

  removedThreadIds.forEach((threadId) => {
    removeChatThreadRecordAndInvalidateIdentity(storage, threadId);
  });

  pending.threadIds.forEach((threadId) => {
    if (removedThreadIds.has(threadId)) {
      return;
    }

    const record = readCachedRecord(threadId);
    if (!record.ok) {
      collectPersistedThreadAttachmentCleanupCandidates(storage, threadId)
        .forEach((localUri) => attachmentCleanupCandidates.add(localUri));
      corruptThreadIds.add(threadId);
      return;
    }

    threads[record.thread.id] = record.thread;
    corruptThreadIds.delete(record.thread.id);
    record.droppedAttachmentLocalUris.forEach((localUri) => attachmentCleanupCandidates.add(localUri));

    if (record.recovered || (changedThreadIds.has(threadId) && record.commitRevision !== pending.revision)) {
      writeChatThreadRecordForMutation(storage, record.thread, {
        persistedAt: now,
        commitRevision: pending.revision,
      });
    } else {
      cacheDurableThreadPersistenceIdentity(
        record.thread,
        record.persistedAt,
        record.commitRevision,
      );
    }
  });

  const activeThreadId = resolveActiveThreadId(threads, pending.activeThreadId);
  writeChatPersistenceIndexForSnapshot(storage, { threads, activeThreadId }, {
    updatedAt: Math.max(now, pending.updatedAt),
    revision: pending.revision,
    migratedFromLegacyAt: pending.migratedFromLegacyAt,
    corruptThreadIds: Array.from(corruptThreadIds),
  });
  removeChatPendingIndexCommit(storage);
  scheduleUnreferencedChatAttachmentCleanup({
    candidateLocalUris: attachmentCleanupCandidates,
    referencedLocalUris: collectReferencedChatAttachmentLocalUrisFromThreads(threads),
  });
}

function readV2PersistedChatState(now = Date.now()): ChatStoreHydrationResult | null {
  const storage = getAppStorage();
  recoverPendingChatIndexCommit(storage, now);
  const indexResult = readChatPersistenceIndex(storage);
  const index = indexResult.ok ? indexResult.value : null;
  const isClearTombstone = index?.clearedAt != null && index.threadIds.length === 0;
  const indexedThreadIds = index?.threadIds ?? [];
  const discoveredThreadIds = listChatThreadStorageKeys(storage)
    .map((key) => getThreadIdFromChatThreadStorageKey(key))
    .filter((threadId): threadId is string => threadId != null);
  const threadIds = Array.from(new Set([...indexedThreadIds, ...discoveredThreadIds]));

  if (isClearTombstone) {
    const clearedAt = index.clearedAt;
    if (clearedAt == null) {
      return null;
    }

    const threads: Record<string, ChatThread> = {};
    const corruptThreadIds = new Set(index.corruptThreadIds ?? []);
    const attachmentCleanupCandidates = new Set<string>();

    try {
      storage.remove(LEGACY_CHAT_STORE_STORAGE_KEY);
      discoveredThreadIds.forEach((threadId) => {
        let record = readHydratableChatThreadRecord(storage, threadId, now);
        const isNewerThanClear = record.persistedAt != null && record.persistedAt > clearedAt;

        if (!isNewerThanClear) {
          collectPersistedThreadAttachmentCleanupCandidates(storage, threadId)
            .forEach((localUri) => attachmentCleanupCandidates.add(localUri));
          removeChatThreadRecordAndInvalidateIdentity(storage, threadId);
          return;
        }

        if (!record.ok) {
          collectPersistedThreadAttachmentCleanupCandidates(storage, threadId)
            .forEach((localUri) => attachmentCleanupCandidates.add(localUri));
          corruptThreadIds.add(threadId);
          return;
        }

        record = applyStreamingProgressDuringHydration(storage, record, now);

        threads[record.thread.id] = record.thread;
        corruptThreadIds.delete(record.thread.id);
        record.droppedAttachmentLocalUris.forEach((localUri) => attachmentCleanupCandidates.add(localUri));

        if (record.recovered) {
          writeChatThreadRecordForMutation(storage, record.thread, {
            persistedAt: Math.max(now, clearedAt + 1),
          });
        } else {
          cacheDurableThreadPersistenceIdentity(
            record.thread,
            record.persistedAt,
            record.commitRevision,
          );
        }
      });
    } catch (error) {
      console.warn('[ChatPersistence] Failed to clean up stale records after clear tombstone', error);
    }

    const activeThreadId = resolveActiveThreadId(threads, index.activeThreadId, {
      fallbackOnExplicitNull: true,
    });

    const corruptThreadIdList = Array.from(corruptThreadIds);
    if (Object.keys(threads).length > 0 || corruptThreadIdList.length > 0) {
      writeChatPersistenceIndexForSnapshot(storage, { threads, activeThreadId }, {
        revision: getChatPersistenceIndexRevision(index),
        corruptThreadIds: corruptThreadIdList,
      });
    }
    scheduleUnreferencedChatAttachmentCleanup({
      candidateLocalUris: attachmentCleanupCandidates,
      referencedLocalUris: collectReferencedChatAttachmentLocalUrisFromThreads(threads),
    });
    discardOrphanedStreamingProgressRecords(storage, new Set(Object.keys(threads)));

    return {
      threads,
      activeThreadId,
      clearedAt: Object.keys(threads).length === 0 && corruptThreadIdList.length === 0
        ? clearedAt
        : undefined,
      corruptThreadIds: corruptThreadIdList,
      legacyBlockedByClear: true,
    };
  }

  if (!index && threadIds.length === 0) {
    discardOrphanedStreamingProgressRecords(storage, new Set());
    return null;
  }

  const threads: Record<string, ChatThread> = {};
  const corruptThreadIds = new Set(index?.corruptThreadIds ?? []);
  const attachmentCleanupCandidates = new Set<string>();

  threadIds.forEach((threadId) => {
    let record = readHydratableChatThreadRecord(storage, threadId, now);

    if (!record.ok) {
      collectPersistedThreadAttachmentCleanupCandidates(storage, threadId)
        .forEach((localUri) => attachmentCleanupCandidates.add(localUri));
      corruptThreadIds.add(threadId);
      return;
    }

    record = applyStreamingProgressDuringHydration(storage, record, now);

    const { thread } = record;
    threads[thread.id] = thread;
    corruptThreadIds.delete(thread.id);
    record.droppedAttachmentLocalUris.forEach((localUri) => attachmentCleanupCandidates.add(localUri));

    if (record.recovered) {
      writeChatThreadRecordForMutation(storage, thread, { persistedAt: now });
    } else {
      cacheDurableThreadPersistenceIdentity(thread, record.persistedAt, record.commitRevision);
    }
  });

  const activeThreadId = resolveActiveThreadId(
    threads,
    index ? index.activeThreadId : undefined,
    {
      fallbackOnExplicitNull: index != null && index.threadIds.length === 0,
    },
  );
  const corruptThreadIdList = Array.from(corruptThreadIds);
  writeChatPersistenceIndexForSnapshot(storage, { threads, activeThreadId }, {
    revision: getChatPersistenceIndexRevision(index),
    corruptThreadIds: corruptThreadIdList,
  });
  scheduleUnreferencedChatAttachmentCleanup({
    candidateLocalUris: attachmentCleanupCandidates,
    referencedLocalUris: collectReferencedChatAttachmentLocalUrisFromThreads(threads),
  });
  discardOrphanedStreamingProgressRecords(storage, new Set(Object.keys(threads)));

  return { threads, activeThreadId, corruptThreadIds: corruptThreadIdList };
}

function migrateLegacyPersistedChatState(
  persistedState: unknown,
  now = Date.now(),
  existingV2State: ChatStoreHydrationResult | null = null,
): ChatStoreHydrationResult | null {
  if (!hasLegacyThreadPayload(persistedState)) {
    return null;
  }

  const storage = getAppStorage();
  const threads: Record<string, ChatThread> = existingV2State
    ? { ...existingV2State.threads }
    : {};
  const corruptThreadIds = new Set(existingV2State?.corruptThreadIds ?? []);
  const changedThreadIds: string[] = [];

  Object.entries(persistedState.threads).forEach(([threadId, rawThread]) => {
    const sanitized = sanitizePersistedChatThread(rawThread, now);
    if (!sanitized) {
      corruptThreadIds.add(threadId);
      return;
    }

    const { thread } = sanitized;
    if (threads[thread.id]) {
      return;
    }

    threads[thread.id] = thread;
    corruptThreadIds.delete(thread.id);
    changedThreadIds.push(thread.id);
  });

  const preferredActiveThreadId = typeof persistedState.activeThreadId === 'string'
    ? threads[persistedState.activeThreadId]
      ? persistedState.activeThreadId
      : existingV2State?.activeThreadId && threads[existingV2State.activeThreadId]
        ? existingV2State.activeThreadId
        : undefined
    : persistedState.activeThreadId === null
      ? null
      : existingV2State?.activeThreadId && threads[existingV2State.activeThreadId]
        ? existingV2State.activeThreadId
        : undefined;
  const activeThreadId = resolveActiveThreadId(
    threads,
    preferredActiveThreadId,
  );
  writeChatPersistenceSnapshotTransaction(storage, { threads, activeThreadId }, 'migration', {
    changedThreadIds,
    migratedFromLegacyAt: now,
    corruptThreadIds: Array.from(corruptThreadIds),
  });
  storage.set(CHAT_STORE_STORAGE_KEY, JSON.stringify({
    state: { activeThreadId },
    version: CHAT_PERSISTENCE_SCHEMA_VERSION,
  }));

  return { threads, activeThreadId };
}

function hasLegacyThreadPayload(
  value: unknown,
): value is { threads: Record<string, unknown>; activeThreadId?: unknown } {
  return isRecord(value) && isRecord(value.threads) && Object.keys(value.threads).length > 0;
}

function hydratePersistedChatState(persistedState: unknown): ChatStoreHydrationResult {
  const v2State = readV2PersistedChatState();

  if (v2State?.legacyBlockedByClear) {
    return v2State;
  }

  if (hasLegacyThreadPayload(persistedState)) {
    const legacyState = migrateLegacyPersistedChatState(persistedState, Date.now(), v2State);
    if (legacyState) {
      return legacyState;
    }
  }

  if (v2State) {
    return v2State;
  }

  const activeThreadId =
    isRecord(persistedState) && typeof persistedState.activeThreadId === 'string'
      ? persistedState.activeThreadId
      : null;

  return { threads: {}, activeThreadId: activeThreadId ?? null };
}

let chatPersistenceContext: { reason: ChatPersistenceWriteReason } | null = null;

function withChatPersistenceContext<T>(
  context: { reason: ChatPersistenceWriteReason },
  callback: () => T,
): T {
  const previousContext = chatPersistenceContext;
  chatPersistenceContext = context;
  try {
    return callback();
  } finally {
    chatPersistenceContext = previousContext;
  }
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function rollbackFailedChatPersistenceMutation(
  previous: ChatStoreSnapshot,
  next: ChatStoreSnapshot,
  previousPersistenceIndex: ReturnType<typeof readChatPersistenceIndex>,
  previousDurableThreadIdentities: ReadonlyMap<
    string,
    DurableThreadPersistenceIdentity
  >,
): void {
  const rollbackErrors: unknown[] = [];
  const attemptRollbackStep = (operation: () => void): boolean => {
    try {
      operation();
      return true;
    } catch (error) {
      rollbackErrors.push(error);
      return false;
    }
  };

  try {
    const storage = getAppStorage();
    const previousThreadIds = Object.keys(previous.threads);
    const nextThreadIds = Object.keys(next.threads);
    const affectedThreadIds = new Set(
      [...previousThreadIds, ...nextThreadIds]
        .filter((threadId) => previous.threads[threadId] !== next.threads[threadId]),
    );

    affectedThreadIds.forEach((threadId) => {
      const previousThread = previous.threads[threadId];
      const candidateRuntime = previousThread
        ? transientAssistantRuntimes.get(previousThread.id)
        : null;
      const runtime = candidateRuntime
        && candidateRuntime.sourceThread === previousThread
        && candidateRuntime.durableMessages === previousThread?.messages
        ? candidateRuntime
        : null;
      const branchBaseIdentity = runtime?.mode.kind === 'replace_branch'
        ? runtime.mode.baseThreadIdentity
        : null;
      const previousPersistedThread = runtime?.durableThread ?? previousThread;
      const previousDurableIdentity = previousDurableThreadIdentities.get(threadId)
        ?? (branchBaseIdentity && previousPersistedThread
          ? {
              sourceThread: previousPersistedThread,
              persistedAt: branchBaseIdentity.durablePersistedAt,
              commitRevision: branchBaseIdentity.commitRevision,
            }
          : undefined);
      const didRestorePersistedThread = attemptRollbackStep(() => {
        if (previousPersistedThread) {
          writeChatThreadRecordForMutation(storage, previousPersistedThread, previousDurableIdentity
            ? {
                persistedAt: previousDurableIdentity.persistedAt,
                commitRevision: previousDurableIdentity.commitRevision,
              }
            : undefined);
        } else {
          removeChatThreadRecordAndInvalidateIdentity(storage, threadId);
        }
      });
      if (didRestorePersistedThread && previousThread && runtime) {
        runtime.persistenceRetryRequired = false;
        attemptRollbackStep(() => {
          const progress = createStreamingProgressRecord(previousThread, runtime);
          if (progress) {
            const writeResult = writeChatStreamingProgressRecord(storage, progress);
            if (writeResult.status === 'written' || writeResult.status === 'unchanged') {
              runtime.lastProgressPersistedAt = progress.persistedAt;
              latestStreamingProgressPersistedAtById.set(threadId, progress.persistedAt);
            }
          }
        });
        chatPersistenceScheduler.scheduleStreamingThreadWrite(threadId);
      } else {
        if (runtime) {
          // The store snapshot is restored, but storage may contain the failed
          // terminal candidate. Keep only this existing runtime retryable; the
          // durable identity cache remains source-mismatched so new branches
          // cannot trust phantom rollback metadata.
          runtime.persistenceRetryRequired = true;
        }
        chatPersistenceScheduler.cancelThreadWrite(threadId);
      }

      if (!didRestorePersistedThread) {
        // Keep any newer cache entry untrusted via its source-thread mismatch.
        // A later branch start must use the instrumented fallback and validate
        // storage instead of accepting phantom rollback metadata.
        return;
      }
    });

    attemptRollbackStep(() => {
      if (previousPersistenceIndex.ok) {
        writeChatPersistenceIndex(storage, previousPersistenceIndex.value);
      } else {
        writeChatPersistenceIndexForSnapshot(storage, previous);
      }
    });
    if (rollbackErrors.length === 0) {
      attemptRollbackStep(() => removeChatPendingIndexCommit(storage));
    }
  } catch (error) {
    rollbackErrors.push(error);
  }

  if (rollbackErrors.length > 0) {
    console.warn('[ChatPersistence] Failed to fully roll back failed chat persistence mutation', {
      errorCount: rollbackErrors.length,
      firstErrorName: getErrorName(rollbackErrors[0]),
    });
  }
}

function removeStreamingProgressAfterDurableCommit(
  storage: ReturnType<typeof getAppStorage>,
  threadId: string,
): void {
  try {
    removeChatStreamingProgressRecord(storage, threadId);
    latestStreamingProgressPersistedAtById.delete(threadId);
  } catch (error) {
    console.warn('[ChatPersistence] Failed to remove superseded streaming progress', {
      errorName: getErrorName(error),
    });
  }
}

function prepareStreamingProgressBeforeDurableThreadMutation(
  storage: ReturnType<typeof getAppStorage>,
  thread: ChatThread,
): number | undefined {
  const runtime = getTransientAssistantRuntime(thread);
  if (!runtime) {
    return undefined;
  }

  const progress = createStreamingProgressRecord(thread, runtime);
  if (!progress) {
    removeStreamingProgressAfterDurableCommit(storage, thread.id);
    return undefined;
  }

  const writeResult = writeChatStreamingProgressRecord(storage, progress);
  if (writeResult.status === 'written' || writeResult.status === 'unchanged') {
    runtime.lastProgressPersistedAt = progress.persistedAt;
    latestStreamingProgressPersistedAtById.set(thread.id, progress.persistedAt);
    return progress.persistedAt - 1;
  }

  const currentResult = readChatStreamingProgressRecord(storage, thread.id);
  if (currentResult.ok && currentResult.value.messageId === runtime.currentMessage.id) {
    runtime.lastProgressPersistedAt = currentResult.value.persistedAt;
    latestStreamingProgressPersistedAtById.set(thread.id, currentResult.value.persistedAt);
    return currentResult.value.persistedAt - 1;
  }

  throw new Error('Unable to establish streaming progress ordering before durable mutation');
}

function persistChatStoreMutation(
  previous: ChatStoreSnapshot,
  next: ChatStoreSnapshot,
  reason: ChatPersistenceWriteReason,
) {
  const storage = getAppStorage();
  const previousThreadIds = Object.keys(previous.threads);
  const nextThreadIds = Object.keys(next.threads);
  const removedThreadIds = previousThreadIds.filter((threadId) => !next.threads[threadId]);
  const changedThreadIds = nextThreadIds.filter((threadId) => previous.threads[threadId] !== next.threads[threadId]);
  const activeThreadChanged = previous.activeThreadId !== next.activeThreadId;

  if (
    removedThreadIds.length === 0 &&
    changedThreadIds.length === 0 &&
    !activeThreadChanged
  ) {
    return;
  }

  if (nextThreadIds.length === 0) {
    chatPersistenceScheduler.cancelAllPendingWrites();
    clearPersistedChatRecordsAndInvalidateRuntimeCaches(storage);
    scheduleChatAttachmentCleanupForSnapshots(previous, next);
    return;
  }

  if (reason === 'streaming_patch') {
    changedThreadIds.forEach((threadId) => {
      chatPersistenceScheduler.scheduleStreamingThreadWrite(threadId);
    });

    if (removedThreadIds.length > 0 || activeThreadChanged) {
      writeChatPersistenceSnapshotTransaction(storage, next, reason, {
        removedThreadIds,
      });
    }

    removedThreadIds.forEach((threadId) => {
      chatPersistenceScheduler.cancelThreadWrite(threadId);
      removeStreamingProgressAfterDurableCommit(storage, threadId);
      latestDurableThreadIdentityById.delete(threadId);
    });
    // Streaming patches only mutate the latest assistant text/state. Avoid
    // traversing attachment references on every token; thread removal is the
    // only streaming-path case that can orphan already persisted attachments.
    scheduleChatAttachmentCleanupForStreamingPatch(previous, next, removedThreadIds);
    return;
  }

  const changedThreadPersistedAt = new Map<string, number>();
  if (reason !== 'terminal_state') {
    changedThreadIds.forEach((threadId) => {
      const thread = next.threads[threadId];
      if (!thread) {
        return;
      }

      const persistedAt = prepareStreamingProgressBeforeDurableThreadMutation(storage, thread);
      if (persistedAt != null) {
        changedThreadPersistedAt.set(threadId, persistedAt);
      }
    });
  }

  writeChatPersistenceSnapshotTransaction(storage, next, reason, {
    changedThreadIds,
    changedThreadPersistedAt: changedThreadPersistedAt.size > 0
      ? changedThreadPersistedAt
      : undefined,
    removedThreadIds,
  });

  if (reason === 'terminal_state' && performanceMonitor.isEnabled()) {
    performanceMonitor.incrementCounter('chat.persist.terminal');
    performanceMonitor.incrementCounter('chat.turn.persistenceTransactions');
  }

  changedThreadIds.forEach((threadId) => {
    chatPersistenceScheduler.cancelThreadWrite(threadId);
    if (reason === 'terminal_state') {
      removeStreamingProgressAfterDurableCommit(storage, threadId);
      return;
    }

    if (!changedThreadPersistedAt.has(threadId)) {
      removeStreamingProgressAfterDurableCommit(storage, threadId);
    }
  });
  removedThreadIds.forEach((threadId) => {
    chatPersistenceScheduler.cancelThreadWrite(threadId);
    removeStreamingProgressAfterDurableCommit(storage, threadId);
    latestDurableThreadIdentityById.delete(threadId);
  });
  scheduleChatAttachmentCleanupForThreadChanges(previous, next, {
    changedThreadIds,
    removedThreadIds,
  });
}

function canPatchAssistantMessage(
  messages: ChatMessage[],
  targetIndex: number,
) {
  const targetMessage = messages[targetIndex];
  if (!targetMessage || targetMessage.role !== 'assistant') {
    return false;
  }

  if (targetIndex !== messages.length - 1) {
    return false;
  }

  if (targetMessage.state !== 'streaming') {
    return false;
  }

  return true;
}

type TransientAssistantRuntimeMode =
  | {
      kind: 'append';
      durablePlaceholder: ChatMessage;
    }
  | {
      kind: 'replace';
      targetMessageId: string;
      originalMessage: ChatMessage;
    }
  | {
      kind: 'replace_branch';
      targetUserMessageId: string;
      targetIndex: number;
      originalTargetMessage: ChatMessage;
      baseThreadIdentity: ChatBranchBaseIdentity;
      replacementPlan: ChatBranchReplacementPlan;
    };

interface TransientAssistantRuntime {
  mode: TransientAssistantRuntimeMode;
  messageIndex: number;
  durableThread: ChatThread;
  durableMessages: ChatMessage[];
  currentMessage: ChatMessage;
  presentationMessages: ChatMessage[];
  presentationThread: ChatThread;
  sourceThread: ChatThread;
  progressRevision: number;
  lastProgressPersistedAt: number;
  persistenceRetryRequired?: boolean;
  branchReplacementProgress?: ChatBranchReplacementProgress;
}

const transientAssistantRuntimes = new Map<string, TransientAssistantRuntime>();

function isBranchBaseIdentityCurrent(
  thread: ChatThread,
  identity: ChatBranchBaseIdentity,
  targetIndex?: number,
): boolean {
  const durableIdentity = latestDurableThreadIdentityById.get(thread.id);
  const target = targetIndex == null
    ? thread.messages.find((message) => message.id === identity.targetUserMessageId)
    : thread.messages[targetIndex];
  return (
    target?.role === 'user'
    && target.kind !== 'model_switch'
    && target.createdAt === identity.targetUserCreatedAt
    && durableIdentity?.sourceThread === thread
    && durableIdentity.persistedAt === identity.durablePersistedAt
    && durableIdentity.commitRevision === identity.commitRevision
  );
}

function isTransientAssistantRuntimeValid(
  runtime: TransientAssistantRuntime,
  thread: ChatThread,
  messageId = runtime.currentMessage.id,
): boolean {
  if (
    thread.messages !== runtime.durableMessages
    || runtime.currentMessage.id !== messageId
  ) {
    return false;
  }

  if (runtime.mode.kind === 'replace_branch') {
    return (
      runtime.sourceThread === thread
      && runtime.messageIndex === runtime.presentationMessages.length - 1
      && runtime.presentationMessages[runtime.messageIndex] === runtime.currentMessage
      && thread.messages[runtime.mode.targetIndex] === runtime.mode.originalTargetMessage
      && runtime.mode.originalTargetMessage.id === runtime.mode.targetUserMessageId
      && (
        runtime.persistenceRetryRequired === true
        || isBranchBaseIdentityCurrent(
          thread,
          runtime.mode.baseThreadIdentity,
          runtime.mode.targetIndex,
        )
      )
    );
  }

  if (runtime.messageIndex !== thread.messages.length - 1) {
    return false;
  }

  const durableMessage = thread.messages[runtime.messageIndex];
  if (runtime.mode.kind === 'append') {
    return (
      durableMessage === runtime.mode.durablePlaceholder
      && durableMessage.id === messageId
      && durableMessage.role === 'assistant'
      && durableMessage.state === 'streaming'
    );
  }

  return (
    durableMessage === runtime.mode.originalMessage
    && durableMessage.id === runtime.mode.targetMessageId
    && durableMessage.role === 'assistant'
    && durableMessage.state !== 'streaming'
  );
}

function createTransientPresentationThread(
  thread: ChatThread,
  presentationMessages: ChatMessage[],
): ChatThread {
  return {
    ...thread,
    messages: presentationMessages,
    status: 'generating',
  };
}

function createTransientAssistantRuntime(
  thread: ChatThread,
  messageId: string,
  durableThread = thread,
): TransientAssistantRuntime | null {
  ensureCachedDurableThreadPersistenceIdentity(durableThread);
  const lastIndex = thread.messages.length - 1;
  if (lastIndex < 0 || !canPatchAssistantMessage(thread.messages, lastIndex)) {
    return null;
  }

  const durablePlaceholder = thread.messages[lastIndex];
  if (durablePlaceholder.id !== messageId) {
    return null;
  }

  const presentationMessages = thread.messages.slice();
  const runtime: TransientAssistantRuntime = {
    mode: {
      kind: 'append',
      durablePlaceholder,
    },
    messageIndex: lastIndex,
    durableThread,
    durableMessages: thread.messages,
    currentMessage: durablePlaceholder,
    presentationMessages,
    presentationThread: createTransientPresentationThread(thread, presentationMessages),
    sourceThread: thread,
    progressRevision: 0,
    lastProgressPersistedAt: latestStreamingProgressPersistedAtById.get(thread.id) ?? 0,
  };
  transientAssistantRuntimes.set(thread.id, runtime);
  return runtime;
}

function createTransientReplacementRuntime(
  thread: ChatThread,
  targetIndex: number,
  replacement: ChatMessage,
): TransientAssistantRuntime | null {
  ensureCachedDurableThreadPersistenceIdentity(thread);
  const originalMessage = thread.messages[targetIndex];
  if (
    targetIndex !== thread.messages.length - 1
    || !originalMessage
    || originalMessage.role !== 'assistant'
    || originalMessage.kind === 'model_switch'
    || originalMessage.state === 'streaming'
  ) {
    return null;
  }

  const presentationMessages = thread.messages.slice();
  presentationMessages[targetIndex] = replacement;
  const runtime: TransientAssistantRuntime = {
    mode: {
      kind: 'replace',
      targetMessageId: originalMessage.id,
      originalMessage,
    },
    messageIndex: targetIndex,
    durableThread: thread,
    durableMessages: thread.messages,
    currentMessage: replacement,
    presentationMessages,
    presentationThread: createTransientPresentationThread(thread, presentationMessages),
    sourceThread: thread,
    progressRevision: 0,
    lastProgressPersistedAt: latestStreamingProgressPersistedAtById.get(thread.id) ?? 0,
  };
  transientAssistantRuntimes.set(thread.id, runtime);
  return runtime;
}

function resolveChatBranchBaseIdentity(
  thread: ChatThread,
  target: ChatMessage,
): ChatBranchBaseIdentity | null {
  const cachedIdentity = latestDurableThreadIdentityById.get(thread.id);
  if (cachedIdentity?.sourceThread === thread) {
    incrementChatBranchIdentityCounter('chat.branch.identity.cacheHit');
    return {
      durablePersistedAt: cachedIdentity.persistedAt,
      commitRevision: cachedIdentity.commitRevision,
      targetUserMessageId: target.id,
      targetUserCreatedAt: target.createdAt,
    };
  }

  incrementChatBranchIdentityCounter('chat.branch.identity.fallbackRead');
  const recordResult = readChatThreadRecord(getAppStorage(), thread.id);
  if (!recordResult.ok) {
    incrementChatBranchIdentityCounter('chat.branch.identity.fallbackRejected');
    return null;
  }

  const persistedTarget = recordResult.value.thread.messages.find(
    (message) => message.id === target.id,
  );
  if (
    !persistedTarget
    || persistedTarget.role !== 'user'
    || persistedTarget.kind === 'model_switch'
    || persistedTarget.createdAt !== target.createdAt
    || !isPersistedThreadSemanticallyCurrent(thread, recordResult.value.thread)
  ) {
    incrementChatBranchIdentityCounter('chat.branch.identity.fallbackRejected');
    return null;
  }

  const identity = cacheDurableThreadPersistenceIdentity(
    thread,
    recordResult.value.persistedAt,
    recordResult.value.commitRevision,
  );

  return {
    durablePersistedAt: identity.persistedAt,
    commitRevision: identity.commitRevision,
    targetUserMessageId: target.id,
    targetUserCreatedAt: target.createdAt,
  };
}

function isPersistedThreadSemanticallyCurrent(
  sourceThread: ChatThread,
  persistedThread: ChatThread,
): boolean {
  try {
    return JSON.stringify(sanitizeChatThreadForPersistence(sourceThread))
      === JSON.stringify(sanitizeChatThreadForPersistence(persistedThread));
  } catch {
    return false;
  }
}

function ensureCachedDurableThreadPersistenceIdentity(thread: ChatThread): void {
  if (latestDurableThreadIdentityById.get(thread.id)?.sourceThread === thread) {
    return;
  }

  const recordResult = readChatThreadRecord(getAppStorage(), thread.id);
  if (
    !recordResult.ok
    || !isPersistedThreadSemanticallyCurrent(thread, recordResult.value.thread)
  ) {
    return;
  }

  cacheDurableThreadPersistenceIdentity(
    thread,
    recordResult.value.persistedAt,
    recordResult.value.commitRevision,
  );
}

function createTransientBranchReplacementRuntime(
  thread: ChatThread,
  plan: ChatBranchReplacementPlan,
  baseThreadIdentity: ChatBranchBaseIdentity,
  assistantMessage: ChatMessage,
): TransientAssistantRuntime | null {
  const validated = validateChatBranchReplacementPlan(thread, plan);
  if (
    !validated
    || !isBranchBaseIdentityCurrent(thread, baseThreadIdentity, validated.targetIndex)
  ) {
    return null;
  }

  const branchReplacementProgress = createChatBranchReplacementProgress(
    baseThreadIdentity,
    {
      ...plan,
      replacementUserMessage: sanitizeChatMessageForPersistence(
        plan.replacementUserMessage,
        thread.id,
      ),
      insertedModelSwitchMessage: plan.insertedModelSwitchMessage
        ? sanitizeChatMessageForPersistence(plan.insertedModelSwitchMessage, thread.id)
        : undefined,
    },
  );
  if (!isChatStreamingProgressOperationWithinBounds({
    threadId: thread.id,
    messageId: assistantMessage.id,
    modelId: assistantMessage.modelId ?? getThreadActiveModelId(thread),
    createdAt: assistantMessage.createdAt,
    branchReplacement: branchReplacementProgress,
  })) {
    return null;
  }

  const materializedPresentationThread = materializeChatBranchReplacementThread({
    thread,
    plan,
    assistantMessage,
    status: 'generating',
    updatedAt: Math.max(thread.updatedAt, assistantMessage.createdAt),
  });
  if (!materializedPresentationThread) {
    return null;
  }
  const presentationMessages = materializedPresentationThread.messages;

  const runtime: TransientAssistantRuntime = {
    mode: {
      kind: 'replace_branch',
      targetUserMessageId: plan.targetUserMessageId,
      targetIndex: validated.targetIndex,
      originalTargetMessage: validated.target,
      baseThreadIdentity,
      replacementPlan: plan,
    },
    messageIndex: presentationMessages.length - 1,
    durableThread: thread,
    durableMessages: thread.messages,
    currentMessage: assistantMessage,
    presentationMessages,
    presentationThread: materializedPresentationThread,
    sourceThread: thread,
    progressRevision: 0,
    lastProgressPersistedAt: latestStreamingProgressPersistedAtById.get(thread.id) ?? 0,
    branchReplacementProgress,
  };
  transientAssistantRuntimes.set(thread.id, runtime);
  return runtime;
}

function getTransientAssistantRuntime(
  thread: ChatThread,
  messageId?: string,
): TransientAssistantRuntime | null {
  const runtime = transientAssistantRuntimes.get(thread.id);
  if (!runtime || !isTransientAssistantRuntimeValid(runtime, thread, messageId)) {
    return null;
  }

  if (runtime.sourceThread !== thread) {
    runtime.sourceThread = thread;
    runtime.presentationThread = createTransientPresentationThread(
      thread,
      runtime.presentationMessages,
    );
  }

  return runtime;
}

function refreshTransientPresentationThread(
  thread: ChatThread,
  runtime: TransientAssistantRuntime,
): void {
  runtime.presentationThread = runtime.mode.kind === 'replace_branch'
    ? {
        ...runtime.presentationThread,
        messages: runtime.presentationMessages,
        status: 'generating',
      }
    : createTransientPresentationThread(thread, runtime.presentationMessages);
  runtime.sourceThread = thread;
}

function ensureTransientAssistantRuntime(
  thread: ChatThread,
  messageId: string,
): TransientAssistantRuntime | null {
  return getTransientAssistantRuntime(thread, messageId)
    ?? createTransientAssistantRuntime(thread, messageId);
}

function getPresentedChatThread(thread: ChatThread): ChatThread {
  return getTransientAssistantRuntime(thread)?.presentationThread ?? thread;
}

function createStreamingProgressRecord(
  thread: ChatThread,
  runtime: TransientAssistantRuntime,
): ChatStreamingProgressRecord | null {
  const message = runtime.currentMessage;
  if (message.content.trim().length === 0 && (message.thoughtContent?.trim().length ?? 0) === 0) {
    return null;
  }

  const persistedAt = Math.max(
    Date.now(),
    message.createdAt,
    (latestDurableThreadIdentityById.get(thread.id)?.persistedAt ?? 0) + 1,
    runtime.lastProgressPersistedAt + 1,
  );
  let branchReplacement = runtime.branchReplacementProgress;
  if (runtime.mode.kind === 'replace_branch' && !branchReplacement) {
    branchReplacement = createChatBranchReplacementProgress(
      runtime.mode.baseThreadIdentity,
      {
        ...runtime.mode.replacementPlan,
        replacementUserMessage: sanitizeChatMessageForPersistence(
          runtime.mode.replacementPlan.replacementUserMessage,
          thread.id,
        ),
        insertedModelSwitchMessage: runtime.mode.replacementPlan.insertedModelSwitchMessage
          ? sanitizeChatMessageForPersistence(
              runtime.mode.replacementPlan.insertedModelSwitchMessage,
              thread.id,
            )
          : undefined,
      },
    );
    runtime.branchReplacementProgress = branchReplacement;
  }
  return {
    schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
    threadId: thread.id,
    messageId: message.id,
    modelId: message.modelId ?? getThreadActiveModelId(thread),
    createdAt: message.createdAt,
    content: message.content,
    thoughtContent: message.thoughtContent,
    tokensPerSec: message.tokensPerSec,
    state: 'streaming',
    persistedAt,
    revision: runtime.progressRevision,
    regeneratesMessageId: message.regeneratesMessageId,
    branchReplacement,
  };
}

function reconcileTransientAssistantRuntimes(threads: Record<string, ChatThread>): void {
  transientAssistantRuntimes.forEach((runtime, threadId) => {
    const thread = threads[threadId];
    if (!thread || !isTransientAssistantRuntimeValid(runtime, thread)) {
      transientAssistantRuntimes.delete(threadId);
    }
  });
}

function incrementChatStreamCounter(name: 'chat.stream.patch' | 'chat.stream.patch.skipped'): void {
  if (performanceMonitor.isEnabled()) {
    performanceMonitor.incrementCounter(name);
  }
}

function incrementChatTurnCounter(name: 'chat.turn.finalize' | 'chat.turn.storeMutations'): void {
  if (performanceMonitor.isEnabled()) {
    performanceMonitor.incrementCounter(name);
  }
}

function incrementChatBranchIdentityCounter(
  name:
    | 'chat.branch.identity.cacheHit'
    | 'chat.branch.identity.fallbackRead'
    | 'chat.branch.identity.fallbackRejected',
): void {
  if (performanceMonitor.isEnabled()) {
    performanceMonitor.incrementCounter(name);
  }
}

export const useChatStore = create<ChatStoreState>()(
  persist(
    (set, get) => {
      const setWhenPrivateStorageWritable: typeof set = (partial, replace) => {
        assertPrivateStorageWritable();
        const previousPersistenceIndex = readChatPersistenceIndex(getAppStorage());
        const previous = {
          threads: get().threads,
          activeThreadId: get().activeThreadId,
        };
        const result = (set as any)(partial, replace);
        const next = {
          threads: get().threads,
          activeThreadId: get().activeThreadId,
        };
        const previousDurableThreadIdentities = new Map<
          string,
          DurableThreadPersistenceIdentity
        >();
        Object.keys(previous.threads).forEach((threadId) => {
          const previousThread = previous.threads[threadId];
          const candidateRuntime = transientAssistantRuntimes.get(threadId);
          const runtime = candidateRuntime
            && candidateRuntime.sourceThread === previousThread
            && candidateRuntime.durableMessages === previousThread?.messages
            ? candidateRuntime
            : null;
          const expectedDurableSource = runtime?.durableThread ?? previousThread;
          const durableIdentity = latestDurableThreadIdentityById.get(threadId);
          if (
            previousThread === next.threads[threadId]
            || durableIdentity?.sourceThread !== expectedDurableSource
          ) {
            return;
          }

          previousDurableThreadIdentities.set(threadId, durableIdentity);
        });
        const persistenceReason = chatPersistenceContext?.reason ?? 'thread_mutation';
        try {
          persistChatStoreMutation(previous, next, persistenceReason);
          if (persistenceReason !== 'streaming_patch') {
            Object.keys(next.threads).forEach((threadId) => {
              if (previous.threads[threadId] === next.threads[threadId]) {
                return;
              }

              const nextThread = next.threads[threadId];
              const runtime = nextThread ? getTransientAssistantRuntime(nextThread) : null;
              if (runtime) {
                runtime.durableThread = nextThread;
              }
            });
          }
          reconcileTransientAssistantRuntimes(next.threads);
        } catch (error) {
          rollbackFailedChatPersistenceMutation(
            previous,
            next,
            previousPersistenceIndex,
            previousDurableThreadIdentities,
          );
          (set as any)({
            threads: previous.threads,
            activeThreadId: previous.activeThreadId,
          }, false);
          throw error;
        }
        return result;
      };

      return {
        threads: {},
        activeThreadId: null,
        streamingRevision: 0,
        inferenceRevision: 0,

        createThread: ({ modelId, presetId, presetSnapshot, paramsSnapshot, title }) => {
        const id = createChatId('thread');
        const now = Date.now();
        const thread: ChatThread = {
          id,
          title: title ?? 'New Conversation',
          titleSource: title ? 'manual' : 'derived',
          modelId,
          activeModelId: modelId,
          presetId,
          presetSnapshot: {
            id: presetSnapshot.id,
            name: presetSnapshot.name,
            systemPrompt: presetSnapshot.systemPrompt,
          },
          paramsSnapshot: {
            temperature: paramsSnapshot.temperature,
            topP: paramsSnapshot.topP,
            topK: paramsSnapshot.topK ?? FALLBACK_TOP_K,
            minP: paramsSnapshot.minP ?? FALLBACK_MIN_P,
            repetitionPenalty: paramsSnapshot.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
            maxTokens: paramsSnapshot.maxTokens,
            reasoningEffort: normalizeReasoningEffort(
              paramsSnapshot.reasoningEffort,
              (paramsSnapshot as { reasoningEnabled?: unknown }).reasoningEnabled,
            ),
            seed: paramsSnapshot.seed ?? null,
          },
          messages: [],
          createdAt: now,
          updatedAt: now,
          status: 'idle',
        };

        setWhenPrivateStorageWritable((state) => ({
          threads: {
            ...state.threads,
            [id]: thread,
          },
          activeThreadId: id,
          inferenceRevision: state.inferenceRevision + 1,
        }));

        return id;
        },

        mergeImportedThreads: (threads) => {
        if (threads.length === 0) {
          return 0;
        }

        let importedCount = 0;

        setWhenPrivateStorageWritable((state) => {
          const nextThreads = { ...state.threads };

          threads.forEach((thread) => {
            if (nextThreads[thread.id]) {
              return;
            }

            nextThreads[thread.id] = sanitizeHydratedThread(thread);
            importedCount += 1;
          });

          if (importedCount === 0) {
            return state;
          }

          const nextActiveThreadId =
            state.activeThreadId && nextThreads[state.activeThreadId]
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
            inferenceRevision: state.inferenceRevision + 1,
          };
        });

        return importedCount;
        },

        pruneExpiredThreads: (retentionDays, now = Date.now()) => {
        const state = get();
        const expiredThreadIds = getExpiredThreadIds(state.threads, retentionDays, now, state.activeThreadId);
        if (expiredThreadIds.length === 0) {
          return 0;
        }

        setWhenPrivateStorageWritable((state) => {
          const nextThreads = { ...state.threads };
          expiredThreadIds.forEach((threadId) => {
            delete nextThreads[threadId];
          });

          const nextActiveThreadId =
            state.activeThreadId && nextThreads[state.activeThreadId]
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
            inferenceRevision: state.inferenceRevision + 1,
          };
        });

        return expiredThreadIds.length;
        },

        clearAllThreads: () => {
        const threadCount = Object.keys(get().threads).length;
        if (threadCount === 0) {
          assertPrivateStorageWritable();
          chatPersistenceScheduler.cancelAllPendingWrites();
          transientAssistantRuntimes.clear();
          clearPersistedChatRecordsAndInvalidateRuntimeCaches(getAppStorage());
          return 0;
        }

        setWhenPrivateStorageWritable((state) => ({
          threads: {},
          activeThreadId: null,
          inferenceRevision: state.inferenceRevision + 1,
        }));

        return threadCount;
        },

        setActiveThread: (threadId) => setWhenPrivateStorageWritable({ activeThreadId: threadId }),

        updateThreadPresetSnapshot: (threadId, presetId, presetSnapshot) =>
          setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                presetId,
                presetSnapshot: {
                  id: presetSnapshot.id,
                  name: presetSnapshot.name,
                  systemPrompt: presetSnapshot.systemPrompt,
                },
              }),
            },
            inferenceRevision: state.inferenceRevision + 1,
          };
          }),

        updateThreadParamsSnapshot: (threadId, paramsSnapshot) =>
          setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                paramsSnapshot: {
                  temperature: paramsSnapshot.temperature,
                  topP: paramsSnapshot.topP,
                  topK: paramsSnapshot.topK ?? FALLBACK_TOP_K,
                  minP: paramsSnapshot.minP ?? FALLBACK_MIN_P,
                  repetitionPenalty: paramsSnapshot.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
                  maxTokens: paramsSnapshot.maxTokens,
                  reasoningEffort: normalizeReasoningEffort(
                    paramsSnapshot.reasoningEffort,
                    (paramsSnapshot as { reasoningEnabled?: unknown }).reasoningEnabled,
                  ),
                  seed: paramsSnapshot.seed ?? null,
                },
              }),
            },
            inferenceRevision: state.inferenceRevision + 1,
          };
          }),

        switchThreadModel: (threadId, nextModelId, at) => {
        let createdMessageId: string | null = null;

        setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const prevModelId = getThreadActiveModelId(existingThread);
          if (nextModelId === prevModelId) {
            return state;
          }

          const requestedCreatedAt = at ?? Date.now();
          const lastMessageCreatedAt = existingThread.messages[existingThread.messages.length - 1]?.createdAt;
          const createdAt = typeof lastMessageCreatedAt === 'number'
            ? Math.max(requestedCreatedAt, lastMessageCreatedAt)
            : requestedCreatedAt;
          const updatedAt = Math.max(Date.now(), existingThread.updatedAt, createdAt);
          const switchMessage = createModelSwitchMessage({
            fromModelId: prevModelId,
            toModelId: nextModelId,
            createdAt,
          });
          createdMessageId = switchMessage.id;

          const nextThread: ChatThread = {
            ...existingThread,
            activeModelId: nextModelId,
            messages: [...existingThread.messages, switchMessage],
            updatedAt,
          };

          return {
            threads: {
              ...state.threads,
              [threadId]: nextThread,
            },
            inferenceRevision: state.inferenceRevision + 1,
          };
        });

        return createdMessageId;
        },

        appendMessage: (threadId, message) =>
          setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const kind = message.kind ?? 'message';
          const fallbackModelId = kind === 'model_switch'
            ? message.switchToModelId ?? getThreadActiveModelId(existingThread)
            : getThreadActiveModelId(existingThread);
          const normalizedMessage: ChatMessage = {
            ...message,
            kind,
            modelId: message.modelId ?? fallbackModelId,
          };

          const nextThread = updateThreadMetadata({
            ...existingThread,
            messages: [...existingThread.messages, normalizedMessage],
            status: normalizedMessage.role === 'assistant' && normalizedMessage.state === 'streaming'
              ? 'generating'
              : existingThread.status,
          });

          return {
            threads: {
              ...state.threads,
              [threadId]: nextThread,
            },
            ...(
              normalizedMessage.role === 'assistant'
              && normalizedMessage.state === 'streaming'
                ? null
                : { inferenceRevision: state.inferenceRevision + 1 }
            ),
          };
          }),

      createAssistantPlaceholder: (threadId, modelId) => {
        const messageId = createChatId('message');
        const thread = get().threads[threadId];
        const resolvedModelId = modelId ?? (thread ? getThreadActiveModelId(thread) : undefined);
        withChatPersistenceContext({ reason: 'streaming_patch' }, () => {
          get().appendMessage(threadId, {
            id: messageId,
            role: 'assistant',
            content: '',
            thoughtContent: undefined,
            createdAt: Date.now(),
            state: 'streaming',
            kind: 'message',
            modelId: resolvedModelId,
          });
        });
        const nextThread = get().threads[threadId];
        if (nextThread) {
          createTransientAssistantRuntime(nextThread, messageId, thread ?? nextThread);
        }
        return messageId;
      },

      finalizeAssistantTurn: (threadId, messageId, finalization) => {
        const existingThread = get().threads[threadId];
        const existingRuntime = existingThread
          ? getTransientAssistantRuntime(existingThread, messageId)
          : null;
        const currentMessage = existingThread?.messages.at(-1);
        if (
          !existingThread
          || (
            !existingRuntime
            && (
              currentMessage?.id !== messageId
              || currentMessage.role !== 'assistant'
              || currentMessage.state !== 'streaming'
            )
          )
        ) {
          return { status: 'stale' };
        }
        try {
          assertPrivateStorageWritable();
          if (!ensureTransientAssistantRuntime(existingThread, messageId)) {
            return { status: 'stale' };
          }

          let didFinalize = false;
          let didDiscardEmptyBranchWithoutDurableMutation = false;
          withChatPersistenceContext({ reason: 'terminal_state' }, () => {
            setWhenPrivateStorageWritable((state) => {
              const durableThread = state.threads[threadId];
              const runtime = durableThread
                ? getTransientAssistantRuntime(durableThread, messageId)
                : null;
              if (!durableThread || !runtime) {
                return state;
              }

              const completedAt = Math.max(
                Date.now(),
                durableThread.updatedAt,
                runtime.currentMessage.createdAt,
              );
              const currentMessage = runtime.currentMessage;
              const terminalThoughtContent = finalization.thoughtContent === undefined
                ? currentMessage.thoughtContent
                : finalization.thoughtContent || undefined;
              const terminalFields = {
                content: finalization.content ?? currentMessage.content,
                thoughtContent: terminalThoughtContent,
                tokensPerSec: finalization.tokensPerSec ?? currentMessage.tokensPerSec,
                inferenceMetrics: finalization.inferenceMetrics ?? currentMessage.inferenceMetrics,
              };
              const hasRecoverableOutput = terminalFields.content.trim().length > 0
                || (terminalFields.thoughtContent?.trim().length ?? 0) > 0;
              const shouldRestoreReplacement = (
                (runtime.mode.kind === 'replace' || runtime.mode.kind === 'replace_branch')
                && !hasRecoverableOutput
                && finalization.outcome !== 'success'
              );
              if (
                runtime.mode.kind === 'replace_branch'
                && shouldRestoreReplacement
                && runtime.lastProgressPersistedAt
                  <= runtime.mode.baseThreadIdentity.durablePersistedAt
              ) {
                transientAssistantRuntimes.delete(threadId);
                didFinalize = true;
                didDiscardEmptyBranchWithoutDurableMutation = true;
                return {
                  streamingRevision: state.streamingRevision + 1,
                  inferenceRevision: state.inferenceRevision + 1,
                };
              }
              const terminalMessage: ChatMessage = finalization.outcome === 'error'
                ? {
                    ...currentMessage,
                    ...terminalFields,
                    state: 'error',
                    errorCode: finalization.errorCode,
                    errorMessage: finalization.errorMessage,
                  }
                : {
                    ...currentMessage,
                    ...terminalFields,
                    state: finalization.outcome === 'success' ? 'complete' : 'stopped',
                    errorCode: undefined,
                    errorMessage: undefined,
                  };
              const nextStatus: ChatThreadStatus = shouldRestoreReplacement
                ? durableThread.status
                : finalization.outcome === 'success'
                  ? 'idle'
                  : finalization.outcome;
              let nextThread: ChatThread | null;
              if (runtime.mode.kind === 'replace_branch' && !shouldRestoreReplacement) {
                if (
                  (
                    runtime.persistenceRetryRequired !== true
                    && !isBranchBaseIdentityCurrent(
                      durableThread,
                      runtime.mode.baseThreadIdentity,
                    )
                  )
                  || !validateChatBranchReplacementPlan(
                    durableThread,
                    runtime.mode.replacementPlan,
                  )
                ) {
                  return state;
                }

                nextThread = materializeChatBranchReplacementThread({
                  thread: durableThread,
                  plan: runtime.mode.replacementPlan,
                  assistantMessage: terminalMessage,
                  status: nextStatus,
                  updatedAt: completedAt,
                  lastGeneratedAt: completedAt,
                });
              } else {
                const nextMessages = durableThread.messages.slice();
                if (!shouldRestoreReplacement) {
                  nextMessages[runtime.messageIndex] = terminalMessage;
                }
                nextThread = updateThreadMetadata({
                  ...durableThread,
                  messages: nextMessages,
                  status: nextStatus,
                  lastGeneratedAt: completedAt,
                }, completedAt);
              }
              if (!nextThread) {
                return state;
              }

              didFinalize = true;
              return {
                threads: {
                  ...state.threads,
                  [threadId]: nextThread,
                },
                inferenceRevision: state.inferenceRevision + 1,
              };
            });
          });

          if (didDiscardEmptyBranchWithoutDurableMutation) {
            chatPersistenceScheduler.cancelThreadWrite(threadId);
            removeStreamingProgressAfterDurableCommit(getAppStorage(), threadId);
          }
          if (didFinalize) {
            incrementChatTurnCounter('chat.turn.finalize');
            incrementChatTurnCounter('chat.turn.storeMutations');
          }
          if (!didFinalize) {
            return { status: 'stale' };
          }
          return {
            status: didDiscardEmptyBranchWithoutDurableMutation
              ? 'restored_without_write'
              : 'committed',
          };
        } catch (error) {
          return {
            status: 'persistence_failed',
            error,
            recovery: {
              threadId,
              messageId,
              finalization,
            },
          };
        }
      },

      stopAssistantMessage: (threadId, messageId) => {
        return get().finalizeAssistantTurn(threadId, messageId, { outcome: 'stopped' });
      },

      finalizeAssistantMessage: (threadId, messageId, content, thoughtContent) => {
        return get().finalizeAssistantTurn(threadId, messageId, {
          outcome: 'success',
          content,
          thoughtContent,
        });
      },

      deleteThread: (threadId) => {
        setWhenPrivateStorageWritable((state) => {
          if (!state.threads[threadId]) {
            return state;
          }

          const nextThreads = { ...state.threads };
          delete nextThreads[threadId];

          const nextActiveThreadId =
            state.activeThreadId !== threadId
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
            inferenceRevision: state.inferenceRevision + 1,
          };
        });
      },

      renameThread: (threadId, title) => {
        const normalizedTitle = normalizeConversationTitle(title);
        const existingThread = get().threads[threadId];
        if (!existingThread) {
          return false;
        }

        setWhenPrivateStorageWritable((state) => {
          const thread = state.threads[threadId];
          if (!thread) {
            return state;
          }

          const nextThread = updateThreadMetadata({
            ...thread,
            title: normalizedTitle || deriveThreadTitle(thread.messages),
            titleSource: normalizedTitle ? 'manual' : 'derived',
          });

          return {
            threads: {
              ...state.threads,
              [threadId]: nextThread,
            },
          };
        });

        return true;
      },

      deleteMessageBranch: (threadId, messageId) => {
        const thread = get().threads[threadId];
        if (!thread) {
          return false;
        }

        const targetIndex = thread.messages.findIndex((message) => message.id === messageId);
        if (targetIndex < 0) {
          return false;
        }

        setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const nextMessages = existingThread.messages.slice(0, targetIndex);
          const nextActiveModelId = deriveThreadActiveModelIdFromMessages({
            modelId: existingThread.modelId,
            messages: nextMessages,
          });

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                activeModelId: nextActiveModelId,
                messages: nextMessages,
                summary: undefined,
                status: 'idle',
              }),
            },
            inferenceRevision: state.inferenceRevision + 1,
          };
        });

        return true;
      },

      patchAssistantMessage: (threadId, messageId, updates) => {
        const isTerminalPatch = updates.state !== undefined && updates.state !== 'streaming';
        if (isTerminalPatch) {
          if (updates.state === 'error') {
            return get().finalizeAssistantTurn(threadId, messageId, {
              outcome: 'error',
              content: updates.content,
              thoughtContent: updates.thoughtContent,
              tokensPerSec: updates.tokensPerSec,
              inferenceMetrics: updates.inferenceMetrics,
              errorCode: updates.errorCode ?? 'generation_failed',
              errorMessage: updates.errorMessage ?? 'Generation failed',
            });
          }

          return get().finalizeAssistantTurn(threadId, messageId, {
            outcome: updates.state === 'complete' ? 'success' : 'stopped',
            content: updates.content,
            thoughtContent: updates.thoughtContent,
            tokensPerSec: updates.tokensPerSec,
            inferenceMetrics: updates.inferenceMetrics,
          });
        }

        assertPrivateStorageWritable();
        const existingThread = get().threads[threadId];
        if (!existingThread) {
          incrementChatStreamCounter('chat.stream.patch.skipped');
          return;
        }

        const runtime = ensureTransientAssistantRuntime(existingThread, messageId);
        if (!runtime) {
          incrementChatStreamCounter('chat.stream.patch.skipped');
          return;
        }

        const nextMessage: ChatMessage = {
          ...runtime.currentMessage,
          ...updates,
          state: 'streaming',
        };
        runtime.currentMessage = nextMessage;
        runtime.progressRevision += 1;
        runtime.presentationMessages[runtime.messageIndex] = nextMessage;
        refreshTransientPresentationThread(existingThread, runtime);

        chatPersistenceScheduler.scheduleStreamingThreadWrite(threadId);
        set((state) => ({
          streamingRevision: state.streamingRevision + 1,
        }));
        incrementChatStreamCounter('chat.stream.patch');
      },

      replaceLastAssistantMessage: (threadId) => {
        const thread = get().threads[threadId];
        if (!thread) {
          return null;
        }

        const targetIndex = thread.messages.length - 1;
        const target = thread.messages[targetIndex];
        if (
          !target
          || target.role !== 'assistant'
          || target.kind === 'model_switch'
          || target.state === 'streaming'
          || getTransientAssistantRuntime(thread) !== null
        ) {
          return null;
        }

        assertPrivateStorageWritable();
        const nextMessageId = createChatId('message');
        const replacement: ChatMessage = {
          id: nextMessageId,
          role: 'assistant',
          content: '',
          thoughtContent: undefined,
          createdAt: Math.max(Date.now(), target.createdAt),
          state: 'streaming',
          regeneratesMessageId: target.id,
          kind: 'message',
          modelId: getThreadActiveModelId(thread),
        };
        if (!createTransientReplacementRuntime(thread, targetIndex, replacement)) {
          return null;
        }
        set((state) => ({
          streamingRevision: state.streamingRevision + 1,
          inferenceRevision: state.inferenceRevision + 1,
        }));

        return nextMessageId;
      },

      replaceBranchFromUserMessage: (threadId, messageId, nextUserContent, paramsSnapshot) => {
        const thread = get().threads[threadId];
        if (!thread || getTransientAssistantRuntime(thread) !== null) {
          return null;
        }

        const targetMessage = thread.messages.find((message) => message.id === messageId);
        if (
          !targetMessage
          || targetMessage.role !== 'user'
          || targetMessage.kind === 'model_switch'
        ) {
          return null;
        }

        assertPrivateStorageWritable();
        const baseThreadIdentity = resolveChatBranchBaseIdentity(thread, targetMessage);
        if (!baseThreadIdentity) {
          return null;
        }

        const replacementPlan = buildChatBranchReplacementPlan({
          thread,
          targetUserMessageId: messageId,
          nextUserContent,
          paramsSnapshot,
          createMessageId: () => createChatId('message'),
        });
        if (!replacementPlan) {
          return null;
        }

        const nextAssistantMessageId = createChatId('message');
        const assistantMessage: ChatMessage = {
          id: nextAssistantMessageId,
          role: 'assistant',
          content: '',
          thoughtContent: undefined,
          createdAt: Math.max(Date.now(), thread.updatedAt, targetMessage.createdAt),
          state: 'streaming',
          kind: 'message',
          modelId: replacementPlan.activeModelId,
        };
        if (!createTransientBranchReplacementRuntime(
          thread,
          replacementPlan,
          baseThreadIdentity,
          assistantMessage,
        )) {
          return null;
        }
        set((state) => ({
          streamingRevision: state.streamingRevision + 1,
          inferenceRevision: state.inferenceRevision + 1,
        }));

        return nextAssistantMessageId;
      },

      finalizeThreadStatus: (threadId, status) =>
        setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...existingThread,
                status,
                updatedAt: Date.now(),
                lastGeneratedAt: Date.now(),
              },
            },
          };
        }),

      setThreadSummary: (threadId, summary) =>
        setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...updateThreadMetadata({
                  ...existingThread,
                  summary,
                }),
              },
            },
            inferenceRevision: state.inferenceRevision + 1,
          };
        }),

      getThread: (threadId) => {
        const thread = threadId ? get().threads[threadId] : undefined;
        return thread ? getPresentedChatThread(thread) : null;
      },
      getActiveThread: () => {
        const { activeThreadId, threads } = get();
        const thread = activeThreadId ? threads[activeThreadId] : undefined;
        return thread ? getPresentedChatThread(thread) : null;
      },
      getConversationIndex: () =>
        buildConversationIndex(get().threads),
      };
    },
    {
      name: CHAT_STORE_STORAGE_KEY,
      version: CHAT_PERSISTENCE_SCHEMA_VERSION,
      skipHydration: true,
      storage: createJSONStorage(() => chatStoreStateStorage),
      partialize: (state) => ({
        activeThreadId: state.activeThreadId,
      }),
      migrate: (persistedState, version) => {
        void version;
        return (persistedState ?? {}) as ChatStorePersistedState;
      },
      merge: (persistedState, currentState) => {
        const hydratedState = hydratePersistedChatState(persistedState);

        return {
          ...currentState,
          threads: hydratedState.threads,
          activeThreadId: hydratedState.activeThreadId,
          inferenceRevision: currentState.inferenceRevision + 1,
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }

        if (state.activeThreadId && !state.threads[state.activeThreadId]) {
          state.activeThreadId = findMostRecentThreadId(state.threads);
        }

        reconcileTransientAssistantRuntimes(state.threads);
        scheduleChatAttachmentDirectoryReconciliation();
      },
    },
  ),
);

function flushChatThreadPersistence(threadId: string, reason: ChatPersistenceWriteReason): void {
  const state = useChatStore.getState();
  const storage = getAppStorage();
  const thread = state.threads[threadId];
  void reason;

  if (!thread) {
    removeChatStreamingProgressRecord(storage, threadId);
    latestStreamingProgressPersistedAtById.delete(threadId);
    return;
  }

  const runtime = getTransientAssistantRuntime(thread);
  if (!runtime) {
    removeChatStreamingProgressRecord(storage, threadId);
    latestStreamingProgressPersistedAtById.delete(threadId);
    return;
  }

  const progress = createStreamingProgressRecord(thread, runtime);
  if (!progress) {
    removeChatStreamingProgressRecord(storage, threadId);
    latestStreamingProgressPersistedAtById.delete(threadId);
    return;
  }

  const writeResult = writeChatStreamingProgressRecord(storage, progress);
  if (writeResult.status === 'written' || writeResult.status === 'unchanged') {
    runtime.lastProgressPersistedAt = progress.persistedAt;
    latestStreamingProgressPersistedAtById.set(threadId, progress.persistedAt);
  }
}

const chatPersistenceScheduler = createChatPersistenceWriteScheduler({
  flushThread: flushChatThreadPersistence,
});

export function flushPendingChatPersistenceWrites(reason: ChatPersistenceWriteReason = 'background'): void {
  chatPersistenceScheduler.flushAllPendingWrites(reason);
}

export function resetChatStoreForPrivateStorageReset(): void {
  const nextInferenceRevision = useChatStore.getState().inferenceRevision + 1;
  chatPersistenceScheduler.cancelAllPendingWrites();
  transientAssistantRuntimes.clear();
  clearPersistedChatRecordsAndInvalidateRuntimeCaches(getAppStorage());
  useChatStore.setState({
    threads: {},
    activeThreadId: null,
    streamingRevision: 0,
    inferenceRevision: nextInferenceRevision,
  });
  void useChatStore.persist.clearStorage();
}
export type { ThreadInferenceWindow, ThreadInferenceWindowOptions } from '../utils/inferenceWindow';
export {
  DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS,
  buildThreadMessagesForInference,
  estimateLlmMessageTokens,
  estimateLlmMessagesTokens,
  getThreadInferenceWindow,
} from '../utils/inferenceWindow';
