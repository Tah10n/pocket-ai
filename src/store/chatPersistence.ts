import { ChatThread } from '../types/chat';
import type { AppStorageFacade } from './storage';

export const LEGACY_CHAT_STORE_STORAGE_KEY = 'chat-store';
export const CHAT_PERSISTENCE_SCHEMA_VERSION = 2;
export const CHAT_PERSISTENCE_INDEX_KEY = 'chat-store:v2:index';
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
  migratedFromLegacyAt?: number;
  corruptThreadIds?: string[];
}

export interface ChatThreadRecord {
  schemaVersion: typeof CHAT_PERSISTENCE_SCHEMA_VERSION;
  thread: ChatThread;
  persistedAt: number;
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
    typeof value.updatedAt !== 'number'
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
    typeof value.persistedAt !== 'number'
  ) {
    return { ok: false, reason: 'invalid_shape' };
  }

  return {
    ok: true,
    value: {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread: thread as ChatThread,
      persistedAt: value.persistedAt,
    },
  };
}

export function writeChatPersistenceIndex(storage: AppStorageFacade, index: ChatPersistenceIndex): void {
  storage.set(CHAT_PERSISTENCE_INDEX_KEY, JSON.stringify(index));
}

export function writeChatThreadRecord(storage: AppStorageFacade, thread: ChatThread, persistedAt = Date.now()): void {
  const record: ChatThreadRecord = {
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    thread,
    persistedAt,
  };
  storage.set(getChatThreadStorageKey(thread.id), JSON.stringify(record));
}

export function readChatPersistenceIndex(storage: AppStorageFacade): ChatPersistenceReadResult<ChatPersistenceIndex> {
  return parseChatPersistenceIndex(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? null);
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

export function recoverStaleStreamingThread(thread: ChatThread, now = Date.now()): ChatThread {
  let changed = thread.status === 'generating';
  const messages = thread.messages.map((message) => {
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
    ...thread,
    messages,
    status: thread.status === 'generating' ? 'stopped' : thread.status,
    updatedAt: Math.max(thread.updatedAt, now),
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
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearThreadTimer = (threadId: string) => {
    const timer = timers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(threadId);
    }
  };

  const flushThreadWrite = (threadId: string, reason: ChatPersistenceWriteReason) => {
    clearThreadTimer(threadId);
    flushThread(threadId, reason);
  };

  return {
    scheduleStreamingThreadWrite: (threadId) => {
      if (timers.has(threadId)) {
        return;
      }

      timers.set(
        threadId,
        setTimeout(() => {
          timers.delete(threadId);
          flushThread(threadId, 'streaming_patch');
        }, debounceMs),
      );
    },
    flushThreadWrite,
    flushAllPendingWrites: (reason) => {
      const pendingThreadIds = Array.from(timers.keys());
      pendingThreadIds.forEach((threadId) => flushThreadWrite(threadId, reason));
    },
    cancelThreadWrite: clearThreadTimer,
    cancelAllPendingWrites: () => {
      Array.from(timers.keys()).forEach(clearThreadTimer);
    },
  };
}
