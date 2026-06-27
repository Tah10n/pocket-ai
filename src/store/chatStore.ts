import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { getAppStorage, mmkvStorage } from '../store/storage';
import {
  ChatMessage,
  ChatMessageRole,
  ChatMessageState,
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
import {
  chatAttachmentStorageService,
  collectChatAttachmentLocalUrisFromUnknownThreadRecord,
  collectReferencedChatAttachmentLocalUrisFromThreads,
} from '../services/ChatAttachmentStorageService';
import {
  CHAT_PERSISTENCE_SCHEMA_VERSION,
  type ChatPersistenceIndex,
  type ChatPersistencePendingIndexCommit,
  type ChatPersistenceWriteReason,
  LEGACY_CHAT_STORE_STORAGE_KEY,
  clearPersistedChatRecords,
  createChatPersistenceWriteScheduler,
  getChatPersistenceIndexRevision,
  getChatThreadStorageKey,
  getThreadIdFromChatThreadStorageKey,
  listChatThreadStorageKeys,
  readChatPersistenceIndex,
  readChatPendingIndexCommit,
  readChatThreadRecord,
  recoverStaleStreamingThread,
  removeChatPendingIndexCommit,
  removeChatThreadRecord,
  resolveNextChatPersistenceRevision,
  sanitizeChatThreadForPersistence,
  writeChatPersistenceIndex,
  writeChatPendingIndexCommit,
  writeChatThreadRecord,
} from './chatPersistence';

const FALLBACK_TOP_K = 40;
const FALLBACK_MIN_P = 0.05;
const FALLBACK_REPETITION_PENALTY = 1;
const CHAT_STORE_STORAGE_KEY = LEGACY_CHAT_STORE_STORAGE_KEY;
const UNREFERENCED_ATTACHMENT_CLEANUP_MAX_DELETES = 16;
const UNREFERENCED_ATTACHMENT_CLEANUP_RETRY_DELAY_MS = 1_000;
const HYDRATION_ATTACHMENT_RECONCILIATION_MAX_DELETES = 16;
const HYDRATION_ATTACHMENT_RECONCILIATION_MAX_CANDIDATES = 16;
const HYDRATION_ATTACHMENT_RECONCILIATION_RETRY_DELAY_MS = 1_000;
const HYDRATION_ATTACHMENT_RECONCILIATION_ZERO_PROGRESS_RETRY_LIMIT = 2;

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
  Pick<ChatMessage, 'content' | 'thoughtContent' | 'tokensPerSec' | 'state' | 'errorCode' | 'errorMessage'>
>;

interface ChatStoreState {
  threads: Record<string, ChatThread>;
  activeThreadId: string | null;
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
  stopAssistantMessage: (threadId: string, messageId: string) => void;
  finalizeAssistantMessage: (threadId: string, messageId: string, content: string, thoughtContent?: string) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => boolean;
  deleteMessageBranch: (threadId: string, messageId: string) => boolean;
  patchAssistantMessage: (
    threadId: string,
    messageId: string,
    updates: AssistantMessagePatch,
  ) => void;
  replaceLastAssistantMessage: (threadId: string) => string | null;
  replaceBranchFromUserMessage: (
    threadId: string,
    messageId: string,
    nextUserContent: string,
  ) => string | null;
  finalizeThreadStatus: (threadId: string, status: ChatThreadStatus) => void;
  setThreadSummary: (threadId: string, summary: ChatSummary | undefined) => void;
  getThread: (threadId: string | null) => ChatThread | null;
  getActiveThread: () => ChatThread | null;
  getConversationIndex: () => ConversationIndexItem[];
}

function updateThreadMetadata(thread: ChatThread): ChatThread {
  const derivedTitle = deriveThreadTitle(thread.messages);
  const title =
    thread.titleSource === 'manual'
      ? normalizeConversationTitle(thread.title) || derivedTitle
      : derivedTitle;

  return {
    ...thread,
    title,
    updatedAt: Date.now(),
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

function clearPersistedChatStoreIfEmpty(threads: Record<string, ChatThread>) {
  if (Object.keys(threads).length === 0) {
    clearPersistedChatRecords(getAppStorage());
  }
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

function scheduleQueuedUnreferencedAttachmentCleanupRetry(): void {
  if (unreferencedAttachmentCleanupRetryTimeout !== null) {
    return;
  }

  unreferencedAttachmentCleanupRetryTimeout = setTimeout(() => {
    unreferencedAttachmentCleanupRetryTimeout = null;
    runQueuedUnreferencedAttachmentCleanup();
  }, UNREFERENCED_ATTACHMENT_CLEANUP_RETRY_DELAY_MS);
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

      if (batchCandidates.length > 0) {
        try {
          await chatAttachmentStorageService.deleteUnreferencedAttachmentFiles({
            candidateLocalUris: batchCandidates,
            referencedLocalUris,
            maxDeletes: UNREFERENCED_ATTACHMENT_CLEANUP_MAX_DELETES,
          });
        } catch (error) {
          retryRequestAfterFailure = {
            candidateLocalUris: new Set([...batchCandidates, ...remainingCandidates]),
            referencedLocalUris: request.referencedLocalUris,
          };
          throw error;
        }
      }

      if (remainingCandidates.length > 0) {
        queueUnreferencedAttachmentCleanup({
          candidateLocalUris: new Set(remainingCandidates),
          referencedLocalUris: request.referencedLocalUris,
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
      if (retryRequestAfterFailure?.candidateLocalUris.size) {
        queueUnreferencedAttachmentCleanup(retryRequestAfterFailure);
        scheduleQueuedUnreferencedAttachmentCleanupRetry();
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

function writeChatThreadRecordForMutation(
  storage: ReturnType<typeof getAppStorage>,
  thread: ChatThread,
  options?: { commitRevision?: number },
) {
  writeChatThreadRecord(storage, thread, resolveThreadRecordPersistedAtForWrite(storage), {
    commitRevision: options?.commitRevision,
  });
}

function writeChatPersistenceSnapshotTransaction(
  storage: ReturnType<typeof getAppStorage>,
  snapshot: ChatStoreSnapshot,
  reason: ChatPersistenceWriteReason,
  options?: {
    changedThreadIds?: string[];
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
      writeChatThreadRecordForMutation(storage, thread, { commitRevision: revision });
    }
  });
  removedThreadIds.forEach((threadId) => {
    removeChatThreadRecord(storage, threadId);
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
      removeChatThreadRecord(storage, threadId);
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
        removeChatThreadRecord(storage, threadId);
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
    removeChatThreadRecord(storage, threadId);
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
      writeChatThreadRecord(storage, record.thread, now, { commitRevision: pending.revision });
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
        const record = readHydratableChatThreadRecord(storage, threadId, now);
        const isNewerThanClear = record.persistedAt != null && record.persistedAt > clearedAt;

        if (!isNewerThanClear) {
          collectPersistedThreadAttachmentCleanupCandidates(storage, threadId)
            .forEach((localUri) => attachmentCleanupCandidates.add(localUri));
          removeChatThreadRecord(storage, threadId);
          return;
        }

        if (!record.ok) {
          collectPersistedThreadAttachmentCleanupCandidates(storage, threadId)
            .forEach((localUri) => attachmentCleanupCandidates.add(localUri));
          corruptThreadIds.add(threadId);
          return;
        }

        threads[record.thread.id] = record.thread;
        corruptThreadIds.delete(record.thread.id);
        record.droppedAttachmentLocalUris.forEach((localUri) => attachmentCleanupCandidates.add(localUri));

        if (record.recovered) {
          writeChatThreadRecord(storage, record.thread, Math.max(now, clearedAt + 1));
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
    return null;
  }

  const threads: Record<string, ChatThread> = {};
  const corruptThreadIds = new Set(index?.corruptThreadIds ?? []);
  const attachmentCleanupCandidates = new Set<string>();

  threadIds.forEach((threadId) => {
    const record = readHydratableChatThreadRecord(storage, threadId, now);

    if (!record.ok) {
      collectPersistedThreadAttachmentCleanupCandidates(storage, threadId)
        .forEach((localUri) => attachmentCleanupCandidates.add(localUri));
      corruptThreadIds.add(threadId);
      return;
    }

    const { thread } = record;
    threads[thread.id] = thread;
    corruptThreadIds.delete(thread.id);
    record.droppedAttachmentLocalUris.forEach((localUri) => attachmentCleanupCandidates.add(localUri));

    if (record.recovered) {
      writeChatThreadRecord(storage, thread, now);
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
): void {
  const rollbackErrors: unknown[] = [];
  const attemptRollbackStep = (operation: () => void) => {
    try {
      operation();
    } catch (error) {
      rollbackErrors.push(error);
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

    attemptRollbackStep(() => removeChatPendingIndexCommit(storage));

    affectedThreadIds.forEach((threadId) => {
      const previousThread = previous.threads[threadId];
      attemptRollbackStep(() => {
        if (previousThread) {
          writeChatThreadRecordForMutation(storage, previousThread);
        } else {
          removeChatThreadRecord(storage, threadId);
        }
      });
      chatPersistenceScheduler.cancelThreadWrite(threadId);
    });

    attemptRollbackStep(() => {
      if (previousPersistenceIndex.ok) {
        writeChatPersistenceIndex(storage, previousPersistenceIndex.value);
      } else {
        writeChatPersistenceIndexForSnapshot(storage, previous);
      }
    });
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
    clearPersistedChatRecords(storage);
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
    });
    // Streaming patches only mutate the latest assistant text/state. Avoid
    // traversing attachment references on every token; thread removal is the
    // only streaming-path case that can orphan already persisted attachments.
    scheduleChatAttachmentCleanupForStreamingPatch(previous, next, removedThreadIds);
    return;
  }

  writeChatPersistenceSnapshotTransaction(storage, next, reason, {
    changedThreadIds,
    removedThreadIds,
  });

  [...changedThreadIds, ...removedThreadIds].forEach((threadId) => {
    chatPersistenceScheduler.cancelThreadWrite(threadId);
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
        try {
          persistChatStoreMutation(previous, next, chatPersistenceContext?.reason ?? 'thread_mutation');
        } catch (error) {
          rollbackFailedChatPersistenceMutation(previous, next, previousPersistenceIndex);
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

        let nextThreadsSnapshot: Record<string, ChatThread> | null = null;

        setWhenPrivateStorageWritable((state) => {
          const nextThreads = { ...state.threads };
          expiredThreadIds.forEach((threadId) => {
            delete nextThreads[threadId];
          });
          nextThreadsSnapshot = nextThreads;

          const nextActiveThreadId =
            state.activeThreadId && nextThreads[state.activeThreadId]
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        });

        if (nextThreadsSnapshot) {
          clearPersistedChatStoreIfEmpty(nextThreadsSnapshot);
        }

        return expiredThreadIds.length;
        },

        clearAllThreads: () => {
        const threadCount = Object.keys(get().threads).length;
        if (threadCount === 0) {
          assertPrivateStorageWritable();
          clearPersistedChatRecords(getAppStorage());
          return 0;
        }

        setWhenPrivateStorageWritable({
          threads: {},
          activeThreadId: null,
        });
        clearPersistedChatRecords(getAppStorage());

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
        return messageId;
      },

      stopAssistantMessage: (threadId, messageId) => {
        get().patchAssistantMessage(threadId, messageId, {
          state: 'stopped',
        });
      },

      finalizeAssistantMessage: (threadId, messageId, content, thoughtContent) => {
        get().patchAssistantMessage(threadId, messageId, {
          content,
          thoughtContent,
          state: 'complete',
          errorCode: undefined,
          errorMessage: undefined,
        });
      },

      deleteThread: (threadId) => {
        let nextThreadsSnapshot: Record<string, ChatThread> | null = null;

        setWhenPrivateStorageWritable((state) => {
          if (!state.threads[threadId]) {
            return state;
          }

          const nextThreads = { ...state.threads };
          delete nextThreads[threadId];
          nextThreadsSnapshot = nextThreads;

          const nextActiveThreadId =
            state.activeThreadId !== threadId
              ? state.activeThreadId
              : findMostRecentThreadId(nextThreads);

          return {
            threads: nextThreads,
            activeThreadId: nextActiveThreadId,
          };
        });

        if (nextThreadsSnapshot) {
          clearPersistedChatStoreIfEmpty(nextThreadsSnapshot);
        }
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
          };
        });

        return true;
      },

      patchAssistantMessage: (threadId, messageId, updates) =>
        withChatPersistenceContext({
          reason: updates.state === 'streaming'
            ? 'streaming_patch'
            : updates.state
              ? 'terminal_state'
              : 'thread_mutation',
        }, () => setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const messages = existingThread.messages;
          if (messages.length === 0) {
            return state;
          }

          const lastIndex = messages.length - 1;
          const targetIndex =
            messages[lastIndex]?.id === messageId
              ? lastIndex
              : messages.findIndex((message) => message.id === messageId);

          if (targetIndex < 0) {
            return state;
          }

          if (!canPatchAssistantMessage(messages, targetIndex)) {
            return state;
          }

          const nextMessages = messages.slice();
          nextMessages[targetIndex] = { ...messages[targetIndex], ...updates };

          const nextStatus =
            updates.state === 'streaming'
              ? 'generating'
              : updates.state === 'stopped'
                ? 'stopped'
                : updates.state === 'error'
                  ? 'error'
                  : existingThread.status === 'generating'
                    ? 'idle'
                    : existingThread.status;

          const shouldUpdateMetadata = Boolean(updates.state && updates.state !== 'streaming');
          const nextThreadBase: ChatThread = {
            ...existingThread,
            messages: nextMessages,
            status: nextStatus,
            lastGeneratedAt:
              updates.state && updates.state !== 'streaming'
                ? Date.now()
                : existingThread.lastGeneratedAt,
          };
          const nextThread = shouldUpdateMetadata
            ? updateThreadMetadata(nextThreadBase)
            : nextThreadBase;

          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...nextThread,
              },
            },
          };
        })),

      replaceLastAssistantMessage: (threadId) => {
        const thread = get().threads[threadId];
        if (!thread) {
          return null;
        }

        const target = [...thread.messages].reverse().find((message) => message.role === 'assistant');
        if (!target) {
          return null;
        }

        const nextMessageId = createChatId('message');

        setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const modelId = getThreadActiveModelId(existingThread);

          const nextMessages = existingThread.messages.map((message): ChatMessage =>
            message.id === target.id
              ? {
                  id: nextMessageId,
                  role: 'assistant' as ChatMessageRole,
                  content: '',
                  thoughtContent: undefined,
                  createdAt: Date.now(),
                  state: 'streaming' as ChatMessageState,
                  regeneratesMessageId: target.id,
                  kind: 'message',
                  modelId,
                }
              : message,
          );

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                messages: nextMessages,
                status: 'generating',
              }),
            },
          };
        });

        return nextMessageId;
      },

      replaceBranchFromUserMessage: (threadId, messageId, nextUserContent) => {
        const thread = get().threads[threadId];
        if (!thread) {
          return null;
        }

        const targetMessage = thread.messages.find((message) => message.id === messageId);
        if (!targetMessage || targetMessage.role !== 'user') {
          return null;
        }

        const normalizedNextUserContent = nextUserContent.trim();
        const targetHasAttachments = (targetMessage.attachments?.length ?? 0) > 0;
        if (!normalizedNextUserContent && !targetHasAttachments) {
          return null;
        }

        const targetIndex = thread.messages.findIndex((message) => message.id === messageId);
        if (targetIndex < 0) {
          return null;
        }

        const nextAssistantMessageId = createChatId('message');

        setWhenPrivateStorageWritable((state) => {
          const existingThread = state.threads[threadId];
          if (!existingThread) {
            return state;
          }

          const modelId = getThreadActiveModelId(existingThread);

          const existingTargetMessage = existingThread.messages[targetIndex];
          if (!existingTargetMessage || existingTargetMessage.role !== 'user') {
            return state;
          }

          if (!normalizedNextUserContent && (existingTargetMessage.attachments?.length ?? 0) === 0) {
            return state;
          }

          const baseMessages = existingThread.messages.slice(0, targetIndex);
          const branchActiveModelId = deriveThreadActiveModelIdFromMessages({
            modelId: existingThread.modelId,
            messages: baseMessages,
          });
          const insertedSwitchMessage = baseMessages.length > 0 && branchActiveModelId !== modelId
            ? createModelSwitchMessage({
                fromModelId: branchActiveModelId,
                toModelId: modelId,
                createdAt: existingTargetMessage.createdAt,
              })
            : null;

          const nextMessages: ChatMessage[] = [
            ...baseMessages,
            ...(insertedSwitchMessage ? [insertedSwitchMessage] : []),
            {
              ...existingTargetMessage,
              content: normalizedNextUserContent,
              state: 'complete',
              tokensPerSec: undefined,
              errorCode: undefined,
              errorMessage: undefined,
              regeneratesMessageId: undefined,
              kind: 'message',
              modelId,
            },
            {
              id: nextAssistantMessageId,
              role: 'assistant',
              content: '',
              thoughtContent: undefined,
              createdAt: Date.now(),
              state: 'streaming',
              kind: 'message',
              modelId,
            },
          ];

          return {
            threads: {
              ...state.threads,
              [threadId]: updateThreadMetadata({
                ...existingThread,
                activeModelId: modelId,
                messages: nextMessages,
                summary: undefined,
                status: 'generating',
              }),
            },
          };
        });

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
          };
        }),

      getThread: (threadId) => (threadId ? get().threads[threadId] ?? null : null),
      getActiveThread: () => {
        const { activeThreadId, threads } = get();
        return activeThreadId ? threads[activeThreadId] ?? null : null;
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
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }

        if (state.activeThreadId && !state.threads[state.activeThreadId]) {
          state.activeThreadId = findMostRecentThreadId(state.threads);
        }

        scheduleChatAttachmentDirectoryReconciliation();
      },
    },
  ),
);

function flushChatThreadPersistence(threadId: string, reason: ChatPersistenceWriteReason): void {
  const state = useChatStore.getState();
  const storage = getAppStorage();
  const thread = state.threads[threadId];

  if (!thread) {
    writeChatPersistenceSnapshotTransaction(storage, state, reason, {
      removedThreadIds: [threadId],
    });
    return;
  }

  writeChatPersistenceSnapshotTransaction(storage, state, reason, {
    changedThreadIds: [threadId],
  });
}

const chatPersistenceScheduler = createChatPersistenceWriteScheduler({
  flushThread: flushChatThreadPersistence,
});

export function flushPendingChatPersistenceWrites(reason: ChatPersistenceWriteReason = 'background'): void {
  chatPersistenceScheduler.flushAllPendingWrites(reason);
}

export function resetChatStoreForPrivateStorageReset(): void {
  chatPersistenceScheduler.cancelAllPendingWrites();
  useChatStore.setState({
    threads: {},
    activeThreadId: null,
  });
  clearPersistedChatRecords(getAppStorage());
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
