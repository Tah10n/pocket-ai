import {
  getThreadActiveModelId,
  type ChatMessage,
  type ChatThread,
  type LlmContentPart,
} from '../types/chat';
import type { ChatAttachment } from '../types/attachments';
import type { InferenceCompletionTelemetry, MtpFallbackReason } from '../types/models';
import {
  CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
  type ChatImageAttachment,
} from '../types/multimodal';
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  isSupportedChatImageDraftFormat,
  normalizeChatAttachmentLocalUri,
  validateChatImageAttachmentBounds,
} from '../utils/chatImageAttachments';
import {
  normalizePersistedChatAttachment,
  MAX_CHAT_ATTACHMENTS_BY_KIND,
  toLegacyChatImageAttachment,
} from '../utils/chatAttachments';
import type { AppStorageFacade } from './storage';
import { performanceMonitor } from '../services/PerformanceMonitor';

export const LEGACY_CHAT_STORE_STORAGE_KEY = 'chat-store';
export const CHAT_PERSISTENCE_SCHEMA_VERSION = 2;
export const CHAT_PERSISTENCE_INDEX_KEY = 'chat-store:v2:index';
export const CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY = 'chat-store:v2:index:pending';
export const CHAT_THREAD_STORAGE_KEY_PREFIX = 'chat-store:v2:thread:';
export const CHAT_STREAM_PROGRESS_SCHEMA_VERSION = 1;
export const CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX = 'chat-store:progress:';
export const DEFAULT_STREAMING_PERSISTENCE_DEBOUNCE_MS = 750;
const LEGACY_MAX_CHAT_VIDEO_DERIVED_FRAME_ATTACHMENTS = 8;

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

export interface ChatStreamingProgressRecord {
  schemaVersion: typeof CHAT_STREAM_PROGRESS_SCHEMA_VERSION;
  threadId: string;
  messageId: string;
  modelId: string;
  createdAt: number;
  content: string;
  thoughtContent?: string;
  tokensPerSec?: number;
  state: 'streaming';
  persistedAt: number;
  revision: number;
  regeneratesMessageId?: string;
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

export function getChatStreamingProgressStorageKey(threadId: string): string {
  return `${CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}`;
}

export function getThreadIdFromChatStreamingProgressStorageKey(key: string): string | null {
  if (!key.startsWith(CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX)) {
    return null;
  }

  const encoded = key.slice(CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX.length);
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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function incrementChatPersistenceCounter(
  name:
    | 'chat.persist.streaming'
    | 'chat.persist.terminal'
    | 'chat.persist.sanitize'
    | 'chat.persist.stringify'
    | 'chat.persist.storage'
    | 'chat.persist.bytes',
  by = 1,
  meta?: Record<string, unknown>,
): void {
  if (performanceMonitor.isEnabled()) {
    performanceMonitor.incrementCounter(name, by, meta);
  }
}

function getUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function serializeAndWriteChatRecord(
  storage: AppStorageFacade,
  key: string,
  value: unknown,
  recordKind: 'index' | 'pending' | 'thread' | 'progress',
): void {
  const serialized = JSON.stringify(value);
  if (performanceMonitor.isEnabled()) {
    incrementChatPersistenceCounter('chat.persist.stringify', 1, { recordKind });
    incrementChatPersistenceCounter('chat.persist.storage', 1, { recordKind });
    incrementChatPersistenceCounter('chat.persist.bytes', getUtf8ByteLength(serialized), { recordKind });
  }
  storage.set(key, serialized);
}

function readRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return isPositiveFiniteNumber(value) ? Math.round(value) : undefined;
}

function readLastPathSegment(value: string): string | null {
  return readRequiredString(
    value
      .split(/[/?#]/u)
      .filter(Boolean)
      .at(-1),
  );
}

function sanitizePersistedChatImageAttachment(
  value: unknown,
  threadId: string,
  messageId: string,
): ChatImageAttachment | null {
  const genericAttachment = normalizePersistedChatAttachment(value, { threadId, messageId });
  if (genericAttachment) {
    return toLegacyChatImageAttachment(genericAttachment);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const attachment = value as Partial<ChatImageAttachment>;
  const id = readRequiredString(attachment.id);
  const localUri = normalizeChatAttachmentLocalUri(readRequiredString(attachment.localUri));
  const fileName = readRequiredString(attachment.fileName);
  const thumbnailUri = normalizeChatAttachmentLocalUri(attachment.thumbnailUri);
  const thumbnailUriFileName = thumbnailUri ? readLastPathSegment(thumbnailUri) : null;
  const requestedThumbnailFileName = readRequiredString(attachment.thumbnailFileName);
  const thumbnailFileName = thumbnailUri && thumbnailUriFileName
    ? requestedThumbnailFileName === thumbnailUriFileName
      ? requestedThumbnailFileName
      : thumbnailUriFileName
    : null;
  const thumbnailMetadata = thumbnailUri && thumbnailFileName && isSupportedChatImageDraftFormat({
    mediaType: undefined,
    fileName: thumbnailFileName,
    localUri: thumbnailUri,
    previewUri: thumbnailUri,
    pickerUri: thumbnailUri,
  })
    ? { thumbnailUri, thumbnailFileName }
    : null;
  const mediaType = typeof attachment.mediaType === 'string'
    ? attachment.mediaType.trim().toLowerCase()
    : undefined;
  const size = readOptionalPositiveInteger(attachment.size);
  const width = readOptionalPositiveInteger(attachment.width);
  const height = readOptionalPositiveInteger(attachment.height);

  if (
    !id ||
    !localUri ||
    !fileName ||
    attachment.pathCategory !== CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY ||
    attachment.source !== 'photo_library' ||
    !isNonNegativeSafeInteger(attachment.createdAt) ||
    !isSupportedChatImageDraftFormat({
      mediaType,
      fileName,
      localUri,
      previewUri: localUri,
      pickerUri: localUri,
    }) ||
    !validateChatImageAttachmentBounds({ size, width, height }).ok
  ) {
    return null;
  }

  return {
    id,
    threadId,
    messageId,
    localUri,
    ...thumbnailMetadata,
    pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
    ...(mediaType ? { mediaType } : null),
    fileName,
    ...(size ? { size } : null),
    ...(width ? { width } : null),
    ...(height ? { height } : null),
    source: 'photo_library',
    createdAt: attachment.createdAt,
  };
}

type PersistedChatAttachment = ChatImageAttachment | ChatAttachment;
type PersistedAttachmentKind = 'image' | 'audio' | 'document' | 'video';

function sanitizePersistedChatAttachmentValue(
  value: unknown,
  threadId: string,
  messageId: string,
): PersistedChatAttachment | null {
  const genericAttachment = normalizePersistedChatAttachment(value, { threadId, messageId });
  if (genericAttachment) {
    return toLegacyChatImageAttachment(genericAttachment) ?? genericAttachment;
  }

  return sanitizePersistedChatImageAttachment(value, threadId, messageId);
}

function resolvePersistedAttachmentKind(attachment: PersistedChatAttachment): PersistedAttachmentKind {
  return 'kind' in attachment ? attachment.kind : 'image';
}

function isGenericChatAttachment(attachment: PersistedChatAttachment): attachment is ChatAttachment {
  return 'kind' in attachment;
}

function isVideoAttachment(attachment: PersistedChatAttachment): attachment is Extract<ChatAttachment, { kind: 'video' }> {
  return isGenericChatAttachment(attachment) && attachment.kind === 'video';
}

function isDerivedProcessorImageAttachment(attachment: PersistedChatAttachment): attachment is Extract<ChatAttachment, { kind: 'image' }> {
  return isGenericChatAttachment(attachment)
    && attachment.kind === 'image'
    && attachment.source === 'derived_processor';
}

function isVideoDerivedImageAttachment(
  attachment: PersistedChatAttachment,
  retainedVideoFrameIdsByVideoId: ReadonlyMap<string, ReadonlySet<string>>,
): attachment is Extract<ChatAttachment, { kind: 'image' }> & { derivedFromAttachmentId: string } {
  if (
    !isDerivedProcessorImageAttachment(attachment)
    || !attachment.derivedFromAttachmentId
  ) {
    return false;
  }

  return retainedVideoFrameIdsByVideoId.get(attachment.derivedFromAttachmentId)?.has(attachment.id) === true;
}

function getRetainedVideoFrameIdsByVideoId(attachments: readonly PersistedChatAttachment[]): Map<string, Set<string>> {
  const retainedVideoFrameIdsByVideoId = new Map<string, Set<string>>();

  attachments.forEach((attachment) => {
    if (!isVideoAttachment(attachment) || retainedVideoFrameIdsByVideoId.size >= MAX_CHAT_ATTACHMENTS_BY_KIND.video) {
      return;
    }

    retainedVideoFrameIdsByVideoId.set(attachment.id, new Set(attachment.video.derivedAttachmentIds));
  });

  return retainedVideoFrameIdsByVideoId;
}

function withRetainedVideoFrameIds(
  attachment: PersistedChatAttachment,
  retainedFrameIdsByVideoId: ReadonlyMap<string, ReadonlySet<string>>,
): PersistedChatAttachment {
  if (!isVideoAttachment(attachment)) {
    return attachment;
  }

  const retainedFrameIds = retainedFrameIdsByVideoId.get(attachment.id);
  const derivedAttachmentIds = attachment.video.derivedAttachmentIds.filter((frameId) => (
    retainedFrameIds?.has(frameId) === true
  ));

  if (derivedAttachmentIds.length === attachment.video.derivedAttachmentIds.length) {
    return attachment;
  }

  return {
    ...attachment,
    video: {
      ...attachment.video,
      derivedAttachmentIds,
    },
  };
}

function sanitizePersistedChatMessageAttachments(message: ChatMessage, threadId: string): PersistedChatAttachment[] | undefined {
  if (message.role !== 'user' || !Array.isArray(message.attachments)) {
    return undefined;
  }

  const sanitizedAttachments = message.attachments.flatMap((attachment) => {
    const sanitized = sanitizePersistedChatAttachmentValue(attachment, threadId, message.id);
    return sanitized ? [sanitized] : [];
  });
  const retainedVideoFrameIdsByVideoId = getRetainedVideoFrameIdsByVideoId(sanitizedAttachments);
  const retainedDerivedFrameIdsByVideoId = new Map<string, Set<string>>();
  const counts: Record<PersistedAttachmentKind, number> = {
    image: 0,
    audio: 0,
    document: 0,
    video: 0,
  };
  const limits: Record<PersistedAttachmentKind, number> = {
    image: MAX_CHAT_IMAGE_ATTACHMENTS,
    audio: MAX_CHAT_ATTACHMENTS_BY_KIND.audio,
    document: MAX_CHAT_ATTACHMENTS_BY_KIND.document,
    video: MAX_CHAT_ATTACHMENTS_BY_KIND.video,
  };
  const attachments = sanitizedAttachments.flatMap((sanitized): PersistedChatAttachment[] => {
    const kind = resolvePersistedAttachmentKind(sanitized);
    if (isVideoDerivedImageAttachment(sanitized, retainedVideoFrameIdsByVideoId)) {
      const videoId = sanitized.derivedFromAttachmentId;
      const retainedFrameIds = retainedDerivedFrameIdsByVideoId.get(videoId) ?? new Set<string>();
      if (retainedFrameIds.size >= LEGACY_MAX_CHAT_VIDEO_DERIVED_FRAME_ATTACHMENTS) {
        return [];
      }

      retainedFrameIds.add(sanitized.id);
      retainedDerivedFrameIdsByVideoId.set(videoId, retainedFrameIds);
      return [sanitized];
    }

    if (isDerivedProcessorImageAttachment(sanitized)) {
      return [];
    }

    if (counts[kind] >= limits[kind]) {
      return [];
    }

    counts[kind] += 1;
    return [sanitized];
  });

  const retainedAttachments = attachments.map((attachment) => (
    withRetainedVideoFrameIds(attachment, retainedDerivedFrameIdsByVideoId)
  ));

  return retainedAttachments.length > 0 ? retainedAttachments : undefined;
}

function sanitizePersistedChatMessageContentParts(message: ChatMessage): LlmContentPart[] | undefined {
  if (message.role !== 'user' || !Array.isArray(message.contentParts)) {
    return undefined;
  }

  const contentParts = message.contentParts.flatMap((part): LlmContentPart[] => {
    if (!part || typeof part !== 'object' || part.type !== 'text') {
      return [];
    }

    const text = typeof part.text === 'string' ? part.text.trim() : '';
    if (text.length === 0 || text.length > 200_000) {
      return [];
    }

    return [{ type: 'text', text }];
  });

  return contentParts.length > 0 ? contentParts : undefined;
}

const MTP_FALLBACK_REASONS = new Set<MtpFallbackReason>([
  'configured_draft_artifact_missing',
  'draft_artifact_unavailable',
  'memory_budget',
  'initialization_failed',
  'completion_failed',
]);

function sanitizeInferenceCompletionTelemetry(value: unknown): InferenceCompletionTelemetry | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const mtp = record.mtp;
  if (!mtp || typeof mtp !== 'object') {
    return undefined;
  }

  const mtpRecord = mtp as Record<string, unknown>;
  if (
    typeof mtpRecord.requested !== 'boolean'
    || typeof mtpRecord.attempted !== 'boolean'
    || typeof mtpRecord.fallbackUsed !== 'boolean'
  ) {
    return undefined;
  }

  const toNonNegativeInteger = (entry: unknown): number | undefined => (
    typeof entry === 'number' && Number.isFinite(entry) && entry >= 0
      ? Math.round(entry)
      : undefined
  );
  const toOptionalNonNegativeNumber = (entry: unknown): number | undefined => (
    typeof entry === 'number' && Number.isFinite(entry) && entry >= 0
      ? entry
      : undefined
  );
  const tokensPredicted = toNonNegativeInteger(record.tokensPredicted);
  const tokensEvaluated = toNonNegativeInteger(record.tokensEvaluated);
  const draftTokens = toNonNegativeInteger(mtpRecord.draftTokens);
  const draftTokensAccepted = toNonNegativeInteger(mtpRecord.draftTokensAccepted);
  if (
    tokensPredicted === undefined
    || tokensEvaluated === undefined
    || draftTokens === undefined
    || draftTokensAccepted === undefined
  ) {
    return undefined;
  }

  const fallbackReason = typeof mtpRecord.fallbackReason === 'string'
    && MTP_FALLBACK_REASONS.has(mtpRecord.fallbackReason as MtpFallbackReason)
    ? mtpRecord.fallbackReason as MtpFallbackReason
    : undefined;
  const acceptanceRate = toOptionalNonNegativeNumber(mtpRecord.acceptanceRate);

  const sanitized: InferenceCompletionTelemetry = {
    tokensPredicted,
    tokensEvaluated,
    predictedPerSecond: toOptionalNonNegativeNumber(record.predictedPerSecond),
    promptPerSecond: toOptionalNonNegativeNumber(record.promptPerSecond),
    timeToFirstTokenMs: toOptionalNonNegativeNumber(record.timeToFirstTokenMs),
    mtp: {
      requested: mtpRecord.requested,
      attempted: mtpRecord.attempted,
      fallbackUsed: mtpRecord.fallbackUsed,
      draftTokens,
      draftTokensAccepted,
      acceptanceRate: acceptanceRate === undefined ? undefined : Math.min(1, acceptanceRate),
      fallbackReason,
    },
  };

  const allowedTopLevelKeys = new Set([
    'tokensPredicted',
    'tokensEvaluated',
    'predictedPerSecond',
    'promptPerSecond',
    'timeToFirstTokenMs',
    'mtp',
  ]);
  const allowedMtpKeys = new Set([
    'requested',
    'attempted',
    'fallbackUsed',
    'draftTokens',
    'draftTokensAccepted',
    'acceptanceRate',
    'fallbackReason',
  ]);
  const isAlreadySanitized = Object.keys(record).every((key) => allowedTopLevelKeys.has(key))
    && Object.keys(mtpRecord).every((key) => allowedMtpKeys.has(key))
    && record.tokensPredicted === sanitized.tokensPredicted
    && record.tokensEvaluated === sanitized.tokensEvaluated
    && record.predictedPerSecond === sanitized.predictedPerSecond
    && record.promptPerSecond === sanitized.promptPerSecond
    && record.timeToFirstTokenMs === sanitized.timeToFirstTokenMs
    && mtpRecord.requested === sanitized.mtp.requested
    && mtpRecord.attempted === sanitized.mtp.attempted
    && mtpRecord.fallbackUsed === sanitized.mtp.fallbackUsed
    && mtpRecord.draftTokens === sanitized.mtp.draftTokens
    && mtpRecord.draftTokensAccepted === sanitized.mtp.draftTokensAccepted
    && mtpRecord.acceptanceRate === sanitized.mtp.acceptanceRate
    && mtpRecord.fallbackReason === sanitized.mtp.fallbackReason;

  return isAlreadySanitized
    ? value as InferenceCompletionTelemetry
    : sanitized;
}

function sanitizeChatMessageForPersistence(message: ChatMessage, threadId: string): ChatMessage {
  const attachments = sanitizePersistedChatMessageAttachments(message, threadId);
  const contentParts = sanitizePersistedChatMessageContentParts(message);
  const inferenceMetrics = sanitizeInferenceCompletionTelemetry(message.inferenceMetrics);
  if (
    attachments === message.attachments
    && contentParts === message.contentParts
    && inferenceMetrics === message.inferenceMetrics
  ) {
    return message;
  }

  return {
    ...message,
    ...(attachments ? { attachments } : { attachments: undefined }),
    ...(contentParts ? { contentParts } : { contentParts: undefined }),
    ...(inferenceMetrics ? { inferenceMetrics } : { inferenceMetrics: undefined }),
  };
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

export function parseChatStreamingProgressRecord(
  raw: string | null | undefined,
  expectedThreadId?: string,
): ChatPersistenceReadResult<ChatStreamingProgressRecord> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) {
    return parsed;
  }

  const value = parsed.value;
  const threadId = readRequiredString(value.threadId);
  const messageId = readRequiredString(value.messageId);
  const modelId = readRequiredString(value.modelId);
  const regeneratesMessageId = value.regeneratesMessageId == null
    ? undefined
    : readRequiredString(value.regeneratesMessageId);
  if (
    value.schemaVersion !== CHAT_STREAM_PROGRESS_SCHEMA_VERSION
    || !threadId
    || !messageId
    || !modelId
    || (expectedThreadId != null && threadId !== expectedThreadId)
    || !isNonNegativeSafeInteger(value.createdAt)
    || typeof value.content !== 'string'
    || (value.thoughtContent != null && typeof value.thoughtContent !== 'string')
    || (value.tokensPerSec != null && !isNonNegativeFiniteNumber(value.tokensPerSec))
    || value.state !== 'streaming'
    || !isNonNegativeSafeInteger(value.persistedAt)
    || !isNonNegativeSafeInteger(value.revision)
    || (value.regeneratesMessageId != null && !regeneratesMessageId)
  ) {
    return { ok: false, reason: 'invalid_shape' };
  }

  return {
    ok: true,
    value: {
      schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
      threadId,
      messageId,
      modelId,
      createdAt: value.createdAt,
      content: value.content,
      thoughtContent: typeof value.thoughtContent === 'string' ? value.thoughtContent : undefined,
      tokensPerSec: isNonNegativeFiniteNumber(value.tokensPerSec) ? value.tokensPerSec : undefined,
      state: 'streaming',
      persistedAt: value.persistedAt,
      revision: value.revision,
      regeneratesMessageId: regeneratesMessageId ?? undefined,
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
  serializeAndWriteChatRecord(storage, CHAT_PERSISTENCE_INDEX_KEY, index, 'index');
}

export function writeChatPendingIndexCommit(
  storage: AppStorageFacade,
  commit: ChatPersistencePendingIndexCommit,
): void {
  serializeAndWriteChatRecord(storage, CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY, commit, 'pending');
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
  incrementChatPersistenceCounter('chat.persist.sanitize', 1, { recordKind: 'thread' });
  const record: ChatThreadRecord = {
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    thread: sanitizeChatThreadForPersistence(thread),
    persistedAt,
    commitRevision: options?.commitRevision,
  };
  serializeAndWriteChatRecord(storage, getChatThreadStorageKey(thread.id), record, 'thread');
}

export function removeChatThreadRecord(storage: AppStorageFacade, threadId: string): void {
  storage.remove(getChatThreadStorageKey(threadId));
}

export function readChatStreamingProgressRecord(
  storage: AppStorageFacade,
  threadId: string,
): ChatPersistenceReadResult<ChatStreamingProgressRecord> {
  return parseChatStreamingProgressRecord(
    storage.getString(getChatStreamingProgressStorageKey(threadId)) ?? null,
    threadId,
  );
}

export function writeChatStreamingProgressRecord(
  storage: AppStorageFacade,
  progress: ChatStreamingProgressRecord,
): boolean {
  const currentResult = readChatStreamingProgressRecord(storage, progress.threadId);
  if (currentResult.ok) {
    const current = currentResult.value;
    const sameMessage = current.messageId === progress.messageId;
    const isOlderRevision = sameMessage && current.revision > progress.revision;
    const isOlderTimestamp = sameMessage
      ? current.revision === progress.revision && current.persistedAt > progress.persistedAt
      : current.createdAt > progress.createdAt
        || (current.createdAt === progress.createdAt && current.persistedAt > progress.persistedAt);
    if (isOlderRevision || isOlderTimestamp) {
      return false;
    }
  }

  incrementChatPersistenceCounter('chat.persist.streaming', 1);
  serializeAndWriteChatRecord(
    storage,
    getChatStreamingProgressStorageKey(progress.threadId),
    progress,
    'progress',
  );
  return true;
}

export function removeChatStreamingProgressRecord(storage: AppStorageFacade, threadId: string): void {
  storage.remove(getChatStreamingProgressStorageKey(threadId));
}

export function listChatStreamingProgressStorageKeys(
  storage: Pick<AppStorageFacade, 'getAllKeys'>,
): string[] {
  return storage.getAllKeys().filter((key) => key.startsWith(CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX));
}

export function clearChatStreamingProgressRecords(storage: AppStorageFacade): void {
  listChatStreamingProgressStorageKeys(storage).forEach((key) => storage.remove(key));
}

function resolveClearTombstoneTimestamp(storage: AppStorageFacade, now = Date.now()): number {
  const indexResult = readChatPersistenceIndex(storage);
  const baseTimestamp = indexResult.ok && indexResult.value.clearedAt != null
    ? Math.max(now, indexResult.value.clearedAt)
    : now;

  const threadTimestamp = listChatThreadStorageKeys(storage).reduce((timestamp, key) => {
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

  return listChatStreamingProgressStorageKeys(storage).reduce((timestamp, key) => {
    const threadId = getThreadIdFromChatStreamingProgressStorageKey(key);
    if (!threadId) {
      return timestamp;
    }

    const progressResult = readChatStreamingProgressRecord(storage, threadId);
    return progressResult.ok
      ? Math.max(timestamp, progressResult.value.persistedAt + 1)
      : timestamp;
  }, threadTimestamp);
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
  clearChatStreamingProgressRecords(storage);
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
  let changedMessages = false;
  const messages = thread.messages.flatMap((message) => {
    if (isEmptyAssistantProgressPlaceholder(message)) {
      removedEmptyProgressPlaceholder = true;
      changedMessages = true;
      return [];
    }

    const sanitizedMessage = sanitizeChatMessageForPersistence(message, thread.id);
    if (sanitizedMessage !== message) {
      changedMessages = true;
    }

    return [sanitizedMessage];
  });

  if (!removedEmptyProgressPlaceholder && !changedMessages) {
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

export type ChatStreamingProgressRecoveryResult =
  | { outcome: 'recovered'; thread: ChatThread }
  | { outcome: 'stale' | 'mismatched' | 'empty' };

export function recoverChatThreadFromStreamingProgress(
  thread: ChatThread,
  durablePersistedAt: number,
  progress: ChatStreamingProgressRecord,
  now = Date.now(),
): ChatStreamingProgressRecoveryResult {
  if (progress.threadId !== thread.id || progress.modelId !== getThreadActiveModelId(thread)) {
    return { outcome: 'mismatched' };
  }

  if (progress.persistedAt <= durablePersistedAt) {
    return { outcome: 'stale' };
  }

  if (progress.content.trim().length === 0 && (progress.thoughtContent?.trim().length ?? 0) === 0) {
    return { outcome: 'empty' };
  }

  const matchingIndex = thread.messages.findIndex((message) => message.id === progress.messageId);
  const matchingMessage = matchingIndex >= 0 ? thread.messages[matchingIndex] : undefined;
  if (matchingMessage) {
    if (
      matchingIndex !== thread.messages.length - 1
      || matchingMessage.role !== 'assistant'
      || (matchingMessage.state !== 'streaming' && matchingMessage.state !== 'stopped')
      || matchingMessage.createdAt !== progress.createdAt
      || (matchingMessage.modelId != null && matchingMessage.modelId !== progress.modelId)
    ) {
      return { outcome: 'mismatched' };
    }
  } else {
    const lastMessage = thread.messages.at(-1);
    if (
      (lastMessage && progress.createdAt < lastMessage.createdAt)
      || (
        lastMessage?.role === 'assistant'
        && (lastMessage.state === 'complete' || lastMessage.state === 'error')
        && lastMessage.createdAt >= progress.createdAt
      )
    ) {
      return { outcome: 'stale' };
    }
  }

  const recoveredMessage: ChatMessage = {
    id: progress.messageId,
    role: 'assistant',
    kind: 'message',
    modelId: progress.modelId,
    content: progress.content,
    thoughtContent: progress.thoughtContent,
    tokensPerSec: progress.tokensPerSec,
    createdAt: progress.createdAt,
    state: 'stopped',
    regeneratesMessageId: progress.regeneratesMessageId,
  };
  const messages = matchingMessage
    ? thread.messages.map((message, index) => (index === matchingIndex ? recoveredMessage : message))
    : [...thread.messages, recoveredMessage];

  return {
    outcome: 'recovered',
    thread: {
      ...thread,
      messages,
      status: 'stopped',
      updatedAt: Math.max(thread.updatedAt, progress.persistedAt, now),
      lastGeneratedAt: Math.max(thread.lastGeneratedAt ?? 0, progress.persistedAt, now),
    },
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
