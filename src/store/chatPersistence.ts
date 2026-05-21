import type { ChatMessage, ChatThread } from '../types/chat';
import type { AppStorageFacade } from './storage';

export const LEGACY_CHAT_STORE_STORAGE_KEY = 'chat-store';
export const CHAT_PERSISTENCE_SCHEMA_VERSION = 2;
export const CHAT_PERSISTENCE_INDEX_KEY = 'chat-store:v2:index';
export const CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY = 'chat-store:v2:index:pending';
export const CHAT_THREAD_STORAGE_KEY_PREFIX = 'chat-store:v2:thread:';
export const DEFAULT_STREAMING_PERSISTENCE_DEBOUNCE_MS = 750;

export type ChatPersistenceWriteReason =
  | 'streaming_patch'
  | 'terminal_state'
  | 'thread_mutation'
  | 'retention_cleanup'
  | 'migration'
  | 'active_thread'
  | 'background';

export interface ChatPersistenceIndex {
  schemaVersion: typeof CHAT_PERSISTENCE_SCHEMA_VERSION;
  activeThreadId: string | null;
  threadIds: string[];
  updatedAt: number;
  revision?: number;
  clearedAt?: number;
  migratedFromLegacyAt?: number;
  corruptThreadIds?: string[];
}

export interface ChatThreadRecord {
  schemaVersion: typeof CHAT_PERSISTENCE_SCHEMA_VERSION;
  thread: ChatThread;
  persistedAt: number;
  commitRevision?: number;
}

export interface ChatPersistencePendingIndexCommit {
  schemaVersion: typeof CHAT_PERSISTENCE_SCHEMA_VERSION;
  revision: number;
  activeThreadId: string | null;
  threadIds: string[];
  updatedAt: number;
  reason: ChatPersistenceWriteReason;
  changedThreadIds?: string[];
  requiresChangedThreadCommitRevision?: boolean;
  removedThreadIds?: string[];
  corruptThreadIds?: string[];
  migratedFromLegacyAt?: number;
}

export type ChatPersistenceReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'invalid_json' | 'invalid_shape' };

export function getChatThreadStorageKey(threadId: string): string {
  return `${CHAT_THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}`;
}

export function getThreadIdFromChatThreadStorageKey(key: string): string | null {
  if (!key.startsWith(CHAT_THREAD_STORAGE_KEY_PREFIX)) {
    return null;
  }

  const encoded = key.slice(CHAT_THREAD_STORAGE_KEY_PREFIX.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string | null | undefined): ChatPersistenceReadResult<Record<string, unknown>> {
  if (raw == null) {
    return { ok: false, reason: 'missing' };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'invalid_shape' };
    }

    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseOptionalRevision(value: unknown): number | undefined {
  return isNonNegativeSafeInteger(value) ? value : undefined;
}

function isChatPersistenceWriteReason(value: unknown): value is ChatPersistenceWriteReason {
  return (
    value === 'streaming_patch' ||
    value === 'terminal_state' ||
    value === 'thread_mutation' ||
    value === 'retention_cleanup' ||
    value === 'migration' ||
    value === 'active_thread' ||
    value === 'background'
  );
}

export function parseChatPersistenceIndex(raw: string | null | undefined): ChatPersistenceReadResult<ChatPersistenceIndex> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) {
    return parsed;
  }

  const value = parsed.value;
  if (
    value.schemaVersion !== CHAT_PERSISTENCE_SCHEMA_VERSION ||
    !(typeof value.activeThreadId === 'string' || value.activeThreadId === null) ||
    !isStringArray(value.threadIds) ||
    typeof value.updatedAt !== 'number' ||
    (value.revision != null && !isNonNegativeSafeInteger(value.revision))
  ) {
    return { ok: false, reason: 'invalid_shape' };
  }

  return {
    ok: true,
    value: {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: value.activeThreadId,
      threadIds: value.threadIds,
      updatedAt: value.updatedAt,
      revision: parseOptionalRevision(value.revision),
      clearedAt: typeof value.clearedAt === 'number' ? value.clearedAt : undefined,
      migratedFromLegacyAt: typeof value.migratedFromLegacyAt === 'number' ? value.migratedFromLegacyAt : undefined,
      corruptThreadIds: isStringArray(value.corruptThreadIds) ? value.corruptThreadIds : undefined,
    },
  };
}

export function parseChatThreadRecord(
  raw: string | null | undefined,
  expectedThreadId?: string,
): ChatPersistenceReadResult<ChatThreadRecord> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) {
    return parsed;
  }

  const value = parsed.value;
  const thread = value.thread as Partial<ChatThread> | undefined;
  if (
    value.schemaVersion !== CHAT_PERSISTENCE_SCHEMA_VERSION ||
    !thread ||
    typeof thread !== 'object' ||
    typeof thread.id !== 'string' ||
    (expectedThreadId != null && thread.id !== expectedThreadId) ||
    typeof value.persistedAt !== 'number' ||
    (value.commitRevision != null && !isNonNegativeSafeInteger(value.commitRevision))
  ) {
    return { ok: false, reason: 'invalid_shape' };
  }

  return {
    ok: true,
    value: {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread: thread as ChatThread,
      persistedAt: value.persistedAt,
      commitRevision: parseOptionalRevision(value.commitRevision),
    },
  };
}

export function parseChatPendingIndexCommit(
  raw: string | null | undefined,
): ChatPersistenceReadResult<ChatPersistencePendingIndexCommit> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) {
    return parsed;
  }

  const value = parsed.value;
  if (
    value.schemaVersion !== CHAT_PERSISTENCE_SCHEMA_VERSION ||
    !isNonNegativeSafeInteger(value.revision) ||
    !(typeof value.activeThreadId === 'string' || value.activeThreadId === null) ||
    !isStringArray(value.threadIds) ||
    typeof value.updatedAt !== 'number' ||
    !isChatPersistenceWriteReason(value.reason) ||
    (value.changedThreadIds != null && !isStringArray(value.changedThreadIds)) ||
    (
      value.requiresChangedThreadCommitRevision != null
      && typeof value.requiresChangedThreadCommitRevision !== 'boolean'
    ) ||
    (value.removedThreadIds != null && !isStringArray(value.removedThreadIds)) ||
    (value.corruptThreadIds != null && !isStringArray(value.corruptThreadIds))
  ) {
    return { ok: false, reason: 'invalid_shape' };
  }

  return {
    ok: true,
    value: {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: value.revision,
      activeThreadId: value.activeThreadId,
      threadIds: value.threadIds,
      updatedAt: value.updatedAt,
      reason: value.reason,
      changedThreadIds: isStringArray(value.changedThreadIds) ? value.changedThreadIds : undefined,
      requiresChangedThreadCommitRevision: value.requiresChangedThreadCommitRevision === true ? true : undefined,
      removedThreadIds: isStringArray(value.removedThreadIds) ? value.removedThreadIds : undefined,
      corruptThreadIds: isStringArray(value.corruptThreadIds) ? value.corruptThreadIds : undefined,
      migratedFromLegacyAt: typeof value.migratedFromLegacyAt === 'number' ? value.migratedFromLegacyAt : undefined,
    },
  };
}

export function writeChatPersistenceIndex(storage: AppStorageFacade, index: ChatPersistenceIndex): void {
  storage.set(CHAT_PERSISTENCE_INDEX_KEY, JSON.stringify(index));
}

export function writeChatPendingIndexCommit(
  storage: AppStorageFacade,
  commit: ChatPersistencePendingIndexCommit,
): void {
  storage.set(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY, JSON.stringify(commit));
}

export function removeChatPendingIndexCommit(storage: AppStorageFacade): void {
  storage.remove(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY);
}

export function writeChatThreadRecord(
  storage: AppStorageFacade,
  thread: ChatThread,
  persistedAt = Date.now(),
  options?: { commitRevision?: number },
): void {
  const record: ChatThreadRecord = {
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    thread: sanitizeChatThreadForPersistence(thread),
    persistedAt,
    commitRevision: options?.commitRevision,
  };
  storage.set(getChatThreadStorageKey(thread.id), JSON.stringify(record));
}

export function removeChatThreadRecord(storage: AppStorageFacade, threadId: string): void {
  storage.remove(getChatThreadStorageKey(threadId));
}

function resolveClearTombstoneTimestamp(storage: AppStorageFacade, now = Date.now()): number {
  const indexResult = readChatPersistenceIndex(storage);
  const baseTimestamp = indexResult.ok && indexResult.value.clearedAt != null
    ? Math.max(now, indexResult.value.clearedAt)
    : now;

  return listChatThreadStorageKeys(storage).reduce((timestamp, key) => {
    const threadId = getThreadIdFromChatThreadStorageKey(key);
    if (!threadId) {
      return timestamp;
    }

    const recordResult = readChatThreadRecord(storage, threadId);
    if (!recordResult.ok) {
      return timestamp;
    }

    return Math.max(timestamp, recordResult.value.persistedAt + 1);
  }, baseTimestamp);
}

export function clearPersistedChatRecords(storage: AppStorageFacade): void {
  const clearedAt = resolveClearTombstoneTimestamp(storage);
  const revision = resolveNextChatPersistenceRevision(storage);
  removeChatPendingIndexCommit(storage);
  writeChatPersistenceIndex(storage, {
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    activeThreadId: null,
    threadIds: [],
    updatedAt: clearedAt,
    revision,
    clearedAt,
  });
  storage.remove(LEGACY_CHAT_STORE_STORAGE_KEY);
  listChatThreadStorageKeys(storage).forEach((key) => storage.remove(key));
  removeChatPendingIndexCommit(storage);
}

export function readChatPersistenceIndex(storage: AppStorageFacade): ChatPersistenceReadResult<ChatPersistenceIndex> {
  return parseChatPersistenceIndex(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? null);
}

export function readChatPendingIndexCommit(
  storage: AppStorageFacade,
): ChatPersistenceReadResult<ChatPersistencePendingIndexCommit> {
  return parseChatPendingIndexCommit(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY) ?? null);
}

export function getChatPersistenceIndexRevision(index: ChatPersistenceIndex | null | undefined): number {
  return index?.revision ?? 0;
}

export function resolveNextChatPersistenceRevision(storage: AppStorageFacade): number {
  const indexResult = readChatPersistenceIndex(storage);
  return getChatPersistenceIndexRevision(indexResult.ok ? indexResult.value : null) + 1;
}

export function readChatThreadRecord(
  storage: AppStorageFacade,
  threadId: string,
): ChatPersistenceReadResult<ChatThreadRecord> {
  return parseChatThreadRecord(storage.getString(getChatThreadStorageKey(threadId)) ?? null, threadId);
}

export function listChatThreadStorageKeys(storage: Pick<AppStorageFacade, 'getAllKeys'>): string[] {
  return storage.getAllKeys().filter((key) => getThreadIdFromChatThreadStorageKey(key) != null);
}

function hasPersistableAssistantContent(message: ChatMessage): boolean {
  return (
    message.content.trim().length > 0 ||
    (message.thoughtContent?.trim().length ?? 0) > 0 ||
    Boolean(message.errorCode || message.errorMessage)
  );
}

function isEmptyAssistantProgressPlaceholder(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || (message.kind ?? 'message') !== 'message') {
    return false;
  }

  if (message.state !== 'streaming' && message.state !== 'stopped') {
    return false;
  }

  return !hasPersistableAssistantContent(message);
}

export function sanitizeChatThreadForPersistence(thread: ChatThread): ChatThread {
  let removedEmptyProgressPlaceholder = false;
  const messages = thread.messages.filter((message) => {
    if (!isEmptyAssistantProgressPlaceholder(message)) {
      return true;
    }

    removedEmptyProgressPlaceholder = true;
    return false;
  });

  if (!removedEmptyProgressPlaceholder) {
    return thread;
  }

  const hasPersistedStreamingMessage = messages.some((message) => message.state === 'streaming');
  const status =
    (thread.status === 'generating' || thread.status === 'stopped') && !hasPersistedStreamingMessage
      ? 'idle'
      : thread.status;

  return {
    ...thread,
    messages,
    status,
  };
}

export function recoverStaleStreamingThread(thread: ChatThread, now = Date.now()): ChatThread {
  const sanitizedThread = sanitizeChatThreadForPersistence(thread);
  let changed = sanitizedThread !== thread || sanitizedThread.status === 'generating';
  const messages = sanitizedThread.messages.map((message) => {
    if (message.state !== 'streaming') {
      return message;
    }

    changed = true;
    return {
      ...message,
      state: 'stopped' as const,
    };
  });

  if (!changed) {
    return thread;
  }

  return {
    ...sanitizedThread,
    messages,
    status: sanitizedThread.status === 'generating' ? 'stopped' : sanitizedThread.status,
    updatedAt: Math.max(sanitizedThread.updatedAt, now),
  };
}

export interface ChatPersistenceWriteScheduler {
  scheduleStreamingThreadWrite: (threadId: string) => void;
  flushThreadWrite: (threadId: string, reason: ChatPersistenceWriteReason) => void;
  flushAllPendingWrites: (reason: ChatPersistenceWriteReason) => void;
  cancelThreadWrite: (threadId: string) => void;
  cancelAllPendingWrites: () => void;
}

export function createChatPersistenceWriteScheduler({
  flushThread,
  debounceMs = DEFAULT_STREAMING_PERSISTENCE_DEBOUNCE_MS,
}: {
  flushThread: (threadId: string, reason: ChatPersistenceWriteReason) => void;
  debounceMs?: number;
}): ChatPersistenceWriteScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout> | null>();

  const clearThreadTimer = (threadId: string) => {
    if (!timers.has(threadId)) {
      return;
    }

    const timer = timers.get(threadId);
    if (timer) {
      clearTimeout(timer);
    }
    timers.delete(threadId);
  };

  const flushThreadWrite = (threadId: string, reason: ChatPersistenceWriteReason) => {
    flushThread(threadId, reason);
    clearThreadTimer(threadId);
  };

  return {
    scheduleStreamingThreadWrite: (threadId) => {
      if (timers.get(threadId) != null) {
        return;
      }

      timers.set(
        threadId,
        setTimeout(() => {
          try {
            flushThread(threadId, 'streaming_patch');
            timers.delete(threadId);
          } catch (error) {
            timers.set(threadId, null);
            console.warn(
              '[ChatPersistence] Failed to flush scheduled streaming thread write',
              { threadId, reason: 'streaming_patch' },
              error,
            );
          }
        }, debounceMs),
      );
    },
    flushThreadWrite,
    flushAllPendingWrites: (reason) => {
      const pendingThreadIds = Array.from(timers.keys());
      let firstError: unknown;
      let hasError = false;

      pendingThreadIds.forEach((threadId) => {
        try {
          flushThreadWrite(threadId, reason);
        } catch (error) {
          if (!hasError) {
            firstError = error;
            hasError = true;
          }
        }
      });

      if (hasError) {
        throw firstError;
      }
    },
    cancelThreadWrite: clearThreadTimer,
    cancelAllPendingWrites: () => {
      Array.from(timers.keys()).forEach(clearThreadTimer);
    },
  };
}
