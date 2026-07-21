import {
  getThreadActiveModelId,
  type ChatMessage,
  type ChatThread,
  type GenerationParamsSnapshot,
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
import {
  createChatBranchReplacementPlanFromProgress,
  isChatBranchReplacementUserMessageWithinProgressBounds,
  materializeChatBranchReplacementThread,
  MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENTS,
  MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PARTS,
  MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH,
  type ChatBranchReplacementProgress,
} from './chatBranchReplacement';

export const LEGACY_CHAT_STORE_STORAGE_KEY = 'chat-store';
export const CHAT_PERSISTENCE_SCHEMA_VERSION = 2;
export const CHAT_PERSISTENCE_INDEX_KEY = 'chat-store:v2:index';
export const CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY = 'chat-store:v2:index:pending';
export const CHAT_THREAD_STORAGE_KEY_PREFIX = 'chat-store:v2:thread:';
export const CHAT_STREAM_PROGRESS_SCHEMA_VERSION = 1;
export const CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION = 2;
export const CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX = 'chat-store:progress:';
export const CHAT_STREAM_OPERATION_STORAGE_KEY_PREFIX = 'chat-store:operation:';
export const CHAT_STREAM_PROGRESS_CHECKPOINT_STORAGE_KEY_PREFIX = 'chat-store:progress-checkpoint:';
export const CHAT_STREAM_PROGRESS_CHUNK_STORAGE_KEY_PREFIX = 'chat-store:progress-chunk:';
export const DEFAULT_STREAMING_PERSISTENCE_DEBOUNCE_MS = 750;
export const MAX_CHAT_PROGRESS_RECORD_BYTES = 7 * 1024 * 1024;
export const MAX_CHAT_PROGRESS_OPERATION_BYTES = 512 * 1024;
export const MAX_CHAT_PROGRESS_MANIFEST_BYTES = 64 * 1024;
export const MAX_CHAT_PROGRESS_CHUNK_BYTES = 64 * 1024;
export const MAX_CHAT_PROGRESS_CHUNKS = 128;
export const MAX_CHAT_PROGRESS_AGGREGATE_BYTES = 16 * 1024 * 1024;
export const MAX_ASSISTANT_PROGRESS_CONTENT_CHARS = 768 * 1024;
export const MAX_ASSISTANT_PROGRESS_THOUGHT_CHARS = 768 * 1024;
// Maximum encoded values for one valid thread across every fixed physical slot.
// Storage accounting also includes key bytes and therefore uses its own exact measurement.
export const MAX_CHAT_PROGRESS_TOTAL_VALUE_BYTES = (
  (2 * MAX_CHAT_PROGRESS_OPERATION_BYTES)
  + (2 * MAX_CHAT_PROGRESS_RECORD_BYTES)
  + (MAX_CHAT_PROGRESS_CHUNKS * MAX_CHAT_PROGRESS_CHUNK_BYTES)
  + MAX_CHAT_PROGRESS_MANIFEST_BYTES
);
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
  branchReplacement?: ChatBranchReplacementProgress;
}

type ChatStreamingProgressSlot = 0 | 1;

interface ChatStreamingOperationRecord {
  schemaVersion: typeof CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION;
  threadId: string;
  messageId: string;
  modelId: string;
  createdAt: number;
  regeneratesMessageId?: string;
  branchReplacement?: ChatBranchReplacementProgress;
}

type ChatStreamingOperationInput = Pick<
  ChatStreamingProgressRecord,
  | 'threadId'
  | 'messageId'
  | 'modelId'
  | 'createdAt'
  | 'regeneratesMessageId'
  | 'branchReplacement'
>;

interface ChatStreamingProgressCheckpointRecord {
  schemaVersion: typeof CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION;
  threadId: string;
  messageId: string;
  createdAt: number;
  revision: number;
  persistedAt: number;
  content: string;
  thoughtContent?: string;
  tokensPerSec?: number;
}

type ChatStreamingProgressTextUpdate =
  | { kind: 'append' | 'replace'; value: string }
  | { kind: 'clear' };

interface ChatStreamingProgressChunkRecord {
  schemaVersion: typeof CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION;
  threadId: string;
  messageId: string;
  createdAt: number;
  slot: number;
  revision: number;
  persistedAt: number;
  content?: ChatStreamingProgressTextUpdate;
  thoughtContent?: ChatStreamingProgressTextUpdate;
  tokensPerSec?: number | null;
}

interface ChatStreamingProgressChunkReference {
  slot: number;
  revision: number;
  persistedAt: number;
}

interface ChatStreamingProgressManifest {
  schemaVersion: typeof CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION;
  threadId: string;
  messageId: string;
  createdAt: number;
  operationSlot: ChatStreamingProgressSlot;
  checkpointSlot: ChatStreamingProgressSlot;
  checkpointRevision: number;
  checkpointPersistedAt: number;
  chunks: ChatStreamingProgressChunkReference[];
  revision: number;
  persistedAt: number;
}

interface ChatStreamingProgressWriterState {
  progress: ChatStreamingProgressRecord;
  manifest: ChatStreamingProgressManifest;
  operationSlot: ChatStreamingProgressSlot;
  checkpointSlot: ChatStreamingProgressSlot;
  activeChunkSlots: Set<number>;
  operationBytes: number;
  checkpointBytes: number;
  manifestBytes: number;
  referencedBytes: number;
}

export type ChatStreamingProgressWriteResult =
  | { status: 'written'; kind: 'checkpoint' | 'delta' }
  | { status: 'unchanged' }
  | { status: 'stale' }
  | {
      status: 'rejected';
      reason:
        | 'content_too_large'
        | 'thought_too_large'
        | 'operation_too_large'
        | 'record_too_large';
    };

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
    const decoded = decodeURIComponent(encoded);
    return encodeURIComponent(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

export function isChatPersistenceStorageKey(key: string): boolean {
  return key === LEGACY_CHAT_STORE_STORAGE_KEY
    || key === CHAT_PERSISTENCE_INDEX_KEY
    || key === CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY
    || key.startsWith(CHAT_THREAD_STORAGE_KEY_PREFIX)
    || key.startsWith(CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX)
    || key.startsWith(CHAT_STREAM_OPERATION_STORAGE_KEY_PREFIX)
    || key.startsWith(CHAT_STREAM_PROGRESS_CHECKPOINT_STORAGE_KEY_PREFIX)
    || key.startsWith(CHAT_STREAM_PROGRESS_CHUNK_STORAGE_KEY_PREFIX);
}

export function getChatStreamingProgressStorageKey(threadId: string): string {
  return `${CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}`;
}

export function getChatStreamingOperationStorageKey(
  threadId: string,
  slot: ChatStreamingProgressSlot,
): string {
  return `${CHAT_STREAM_OPERATION_STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}:${slot}`;
}

export function getChatStreamingProgressCheckpointStorageKey(
  threadId: string,
  slot: ChatStreamingProgressSlot,
): string {
  return `${CHAT_STREAM_PROGRESS_CHECKPOINT_STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}:${slot}`;
}

export function getChatStreamingProgressChunkStorageKey(threadId: string, slot: number): string {
  return `${CHAT_STREAM_PROGRESS_CHUNK_STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}:${slot}`;
}

export function getThreadIdFromChatStreamingProgressStorageKey(key: string): string | null {
  if (!key.startsWith(CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX)) {
    return null;
  }

  const encoded = key.slice(CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX.length);
  try {
    const decoded = decodeURIComponent(encoded);
    return encodeURIComponent(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

function getThreadIdFromSlottedChatProgressStorageKey(
  key: string,
  prefix: string,
  maximumSlot: number,
): string | null {
  if (!key.startsWith(prefix)) {
    return null;
  }

  const suffix = key.slice(prefix.length);
  const separatorIndex = suffix.lastIndexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  const encoded = suffix.slice(0, separatorIndex);
  const rawSlot = suffix.slice(separatorIndex + 1);
  if (!/^\d+$/u.test(rawSlot)) {
    return null;
  }
  const slot = Number(rawSlot);
  if (
    !Number.isSafeInteger(slot)
    || slot < 0
    || slot > maximumSlot
    || String(slot) !== rawSlot
  ) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(encoded);
    return encodeURIComponent(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

export function getThreadIdFromChatStreamingProgressArtifactStorageKey(key: string): string | null {
  return getThreadIdFromChatStreamingProgressStorageKey(key)
    ?? getThreadIdFromSlottedChatProgressStorageKey(
      key,
      CHAT_STREAM_OPERATION_STORAGE_KEY_PREFIX,
      1,
    )
    ?? getThreadIdFromSlottedChatProgressStorageKey(
      key,
      CHAT_STREAM_PROGRESS_CHECKPOINT_STORAGE_KEY_PREFIX,
      1,
    )
    ?? getThreadIdFromSlottedChatProgressStorageKey(
      key,
      CHAT_STREAM_PROGRESS_CHUNK_STORAGE_KEY_PREFIX,
      MAX_CHAT_PROGRESS_CHUNKS - 1,
    );
}

type ChatPersistenceRecordKind =
  | 'index'
  | 'pending'
  | 'thread'
  | 'progress'
  | 'progress_manifest'
  | 'progress_operation'
  | 'progress_checkpoint'
  | 'progress_chunk';

function parseJsonObject(
  raw: string | null | undefined,
  options: { maxBytes?: number; recordKind?: ChatPersistenceRecordKind } = {},
): ChatPersistenceReadResult<Record<string, unknown>> {
  if (raw == null) {
    return { ok: false, reason: 'missing' };
  }

  if (options.maxBytes != null && getUtf8ByteLength(raw, options.maxBytes) > options.maxBytes) {
    return { ok: false, reason: 'invalid_shape' };
  }

  try {
    incrementChatPersistenceCounter('chat.persist.parse', 1, {
      recordKind: options.recordKind ?? 'unknown',
    });
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
    | 'chat.persist.parse'
    | 'chat.persist.storage'
    | 'chat.persist.bytes'
    | 'chat.persist.assistantChars'
    | 'chat.persist.progress.operation'
    | 'chat.persist.progress.checkpoint'
    | 'chat.persist.progress.delta'
    | 'chat.persist.progress.manifest',
  by = 1,
  meta?: Record<string, unknown>,
): void {
  if (performanceMonitor.isEnabled()) {
    performanceMonitor.incrementCounter(name, by, meta);
  }
}

function getUtf8ByteLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
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
    if (bytes > stopAfter) {
      return bytes;
    }
  }
  return bytes;
}

function serializeChatRecord(
  value: unknown,
  recordKind: ChatPersistenceRecordKind,
): { serialized: string; bytes: number } {
  const serialized = JSON.stringify(value);
  const bytes = getUtf8ByteLength(serialized);
  incrementChatPersistenceCounter('chat.persist.stringify', 1, { recordKind });
  return { serialized, bytes };
}

function writeSerializedChatRecord(
  storage: AppStorageFacade,
  key: string,
  serialized: string,
  bytes: number,
  recordKind: ChatPersistenceRecordKind,
): void {
  incrementChatPersistenceCounter('chat.persist.storage', 1, { recordKind });
  incrementChatPersistenceCounter('chat.persist.bytes', bytes, { recordKind });
  if (recordKind === 'progress_operation') {
    incrementChatPersistenceCounter('chat.persist.progress.operation');
  } else if (recordKind === 'progress_checkpoint') {
    incrementChatPersistenceCounter('chat.persist.progress.checkpoint');
  } else if (recordKind === 'progress_chunk') {
    incrementChatPersistenceCounter('chat.persist.progress.delta');
  } else if (recordKind === 'progress_manifest') {
    incrementChatPersistenceCounter('chat.persist.progress.manifest');
  }
  storage.set(key, serialized);
}

function serializeAndWriteChatRecord(
  storage: AppStorageFacade,
  key: string,
  value: unknown,
  recordKind: ChatPersistenceRecordKind,
): void {
  const { serialized, bytes } = serializeChatRecord(value, recordKind);
  writeSerializedChatRecord(storage, key, serialized, bytes, recordKind);
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

export function sanitizeChatMessageForPersistence(message: ChatMessage, threadId: string): ChatMessage {
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasSameJsonShape(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function parseBranchParamsSnapshot(value: unknown): GenerationParamsSnapshot | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const allowedKeys = new Set([
    'temperature',
    'topP',
    'topK',
    'minP',
    'repetitionPenalty',
    'maxTokens',
    'reasoningEffort',
    'seed',
  ]);
  const validReasoningEffort = value.reasoningEffort === undefined
    || value.reasoningEffort === 'off'
    || value.reasoningEffort === 'auto'
    || value.reasoningEffort === 'low'
    || value.reasoningEffort === 'medium'
    || value.reasoningEffort === 'high';
  if (
    !hasOnlyKeys(value, allowedKeys)
    || !isFiniteNumberInRange(value.temperature, 0, 2)
    || !isFiniteNumberInRange(value.topP, 0, 1)
    || (value.topK !== undefined && !isSafeIntegerInRange(value.topK, 0, 200))
    || (value.minP !== undefined && !isFiniteNumberInRange(value.minP, 0, 1))
    || (
      value.repetitionPenalty !== undefined
      && !isFiniteNumberInRange(value.repetitionPenalty, 0, 2)
    )
    || !isSafeIntegerInRange(value.maxTokens, 1, 8192)
    || !(
      value.seed === null
      || isSafeIntegerInRange(value.seed, 0, 2_147_483_647)
    )
    || !validReasoningEffort
  ) {
    return null;
  }

  return {
    temperature: value.temperature as number,
    topP: value.topP as number,
    topK: typeof value.topK === 'number' ? value.topK : undefined,
    minP: typeof value.minP === 'number' ? value.minP : undefined,
    repetitionPenalty: typeof value.repetitionPenalty === 'number'
      ? value.repetitionPenalty
      : undefined,
    maxTokens: value.maxTokens as number,
    reasoningEffort: typeof value.reasoningEffort === 'string'
      ? value.reasoningEffort as GenerationParamsSnapshot['reasoningEffort']
      : undefined,
    seed: value.seed as number | null,
  };
}

function parseBranchReplacementUserMessage({
  value,
  threadId,
  targetUserMessageId,
  targetUserCreatedAt,
  modelId,
}: {
  value: unknown;
  threadId: string;
  targetUserMessageId: string;
  targetUserCreatedAt: number;
  modelId: string;
}): ChatMessage | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const allowedKeys = new Set([
    'id',
    'role',
    'kind',
    'content',
    'createdAt',
    'state',
    'modelId',
    'attachments',
    'contentParts',
  ]);
  if (
    !hasOnlyKeys(value, allowedKeys)
    || value.id !== targetUserMessageId
    || value.role !== 'user'
    || value.kind !== 'message'
    || typeof value.content !== 'string'
    || value.content.length > MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH
    || value.createdAt !== targetUserCreatedAt
    || value.state !== 'complete'
    || value.modelId !== modelId
    || (value.attachments != null && !Array.isArray(value.attachments))
    || (value.contentParts != null && !Array.isArray(value.contentParts))
    || (
      Array.isArray(value.attachments)
      && value.attachments.length > MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENTS
    )
    || (
      Array.isArray(value.contentParts)
      && value.contentParts.length > MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PARTS
    )
  ) {
    return null;
  }

  const candidate: ChatMessage = {
    id: targetUserMessageId,
    role: 'user',
    kind: 'message',
    content: value.content,
    createdAt: targetUserCreatedAt,
    state: 'complete',
    modelId,
    attachments: value.attachments as ChatMessage['attachments'],
    contentParts: value.contentParts as ChatMessage['contentParts'],
  };
  const sanitized = sanitizeChatMessageForPersistence(candidate, threadId);
  if (
    !isChatBranchReplacementUserMessageWithinProgressBounds(sanitized)
    || sanitized.content !== sanitized.content.trim()
    || (
      sanitized.content.length === 0
      && (sanitized.attachments?.length ?? 0) === 0
    )
    || !hasSameJsonShape(sanitized.attachments, value.attachments)
    || !hasSameJsonShape(sanitized.contentParts, value.contentParts)
  ) {
    return null;
  }

  return sanitized;
}

function parseBranchInsertedModelSwitchMessage({
  value,
  targetUserCreatedAt,
  modelId,
}: {
  value: unknown;
  targetUserCreatedAt: number;
  modelId: string;
}): ChatMessage | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const allowedKeys = new Set([
    'id',
    'role',
    'kind',
    'content',
    'createdAt',
    'state',
    'modelId',
    'switchFromModelId',
    'switchToModelId',
  ]);
  const id = readRequiredString(value.id);
  const switchFromModelId = readRequiredString(value.switchFromModelId);
  if (
    !hasOnlyKeys(value, allowedKeys)
    || !id
    || value.role !== 'system'
    || value.kind !== 'model_switch'
    || value.content !== ''
    || value.createdAt !== targetUserCreatedAt
    || value.state !== 'complete'
    || value.modelId !== modelId
    || !switchFromModelId
    || switchFromModelId === modelId
    || value.switchToModelId !== modelId
  ) {
    return null;
  }

  return {
    id,
    role: 'system',
    kind: 'model_switch',
    content: '',
    createdAt: targetUserCreatedAt,
    state: 'complete',
    modelId,
    switchFromModelId,
    switchToModelId: modelId,
  };
}

function parseChatBranchReplacementProgress({
  value,
  threadId,
  modelId,
}: {
  value: unknown;
  threadId: string;
  modelId: string;
}): ChatBranchReplacementProgress | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const allowedKeys = new Set([
    'targetUserMessageId',
    'targetUserCreatedAt',
    'baseDurablePersistedAt',
    'baseCommitRevision',
    'replacementUserMessage',
    'insertedModelSwitchMessage',
    'paramsSnapshot',
  ]);
  const targetUserMessageId = readRequiredString(value.targetUserMessageId);
  if (
    !hasOnlyKeys(value, allowedKeys)
    || !targetUserMessageId
    || !isNonNegativeSafeInteger(value.targetUserCreatedAt)
    || !isNonNegativeSafeInteger(value.baseDurablePersistedAt)
    || (
      value.baseCommitRevision !== undefined
      && !isNonNegativeSafeInteger(value.baseCommitRevision)
    )
  ) {
    return null;
  }

  const replacementUserMessage = parseBranchReplacementUserMessage({
    value: value.replacementUserMessage,
    threadId,
    targetUserMessageId,
    targetUserCreatedAt: value.targetUserCreatedAt,
    modelId,
  });
  const insertedModelSwitchMessage = value.insertedModelSwitchMessage === undefined
    ? undefined
    : parseBranchInsertedModelSwitchMessage({
        value: value.insertedModelSwitchMessage,
        targetUserCreatedAt: value.targetUserCreatedAt,
        modelId,
      });
  const paramsSnapshot = parseBranchParamsSnapshot(value.paramsSnapshot);
  if (
    !replacementUserMessage
    || !paramsSnapshot
    || (value.insertedModelSwitchMessage !== undefined && !insertedModelSwitchMessage)
    || insertedModelSwitchMessage?.id === targetUserMessageId
  ) {
    return null;
  }

  return {
    targetUserMessageId,
    targetUserCreatedAt: value.targetUserCreatedAt,
    baseDurablePersistedAt: value.baseDurablePersistedAt,
    baseCommitRevision: parseOptionalRevision(value.baseCommitRevision),
    replacementUserMessage,
    insertedModelSwitchMessage: insertedModelSwitchMessage ?? undefined,
    paramsSnapshot,
  };
}

export function parseChatStreamingProgressRecord(
  raw: string | null | undefined,
  expectedThreadId?: string,
): ChatPersistenceReadResult<ChatStreamingProgressRecord> {
  const parsed = parseJsonObject(raw, {
    maxBytes: MAX_CHAT_PROGRESS_RECORD_BYTES,
    recordKind: 'progress',
  });
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
  const hasBranchReplacement = Object.prototype.hasOwnProperty.call(value, 'branchReplacement');
  const branchReplacement = !hasBranchReplacement || !threadId || !modelId
    ? undefined
    : parseChatBranchReplacementProgress({
        value: value.branchReplacement,
        threadId,
        modelId,
      });
  if (
    value.schemaVersion !== CHAT_STREAM_PROGRESS_SCHEMA_VERSION
    || !threadId
    || !messageId
    || !modelId
    || (expectedThreadId != null && threadId !== expectedThreadId)
    || !isNonNegativeSafeInteger(value.createdAt)
    || typeof value.content !== 'string'
    || (
      typeof value.content === 'string'
      && value.content.length > MAX_ASSISTANT_PROGRESS_CONTENT_CHARS
    )
    || (value.thoughtContent != null && typeof value.thoughtContent !== 'string')
    || (
      typeof value.thoughtContent === 'string'
      && value.thoughtContent.length > MAX_ASSISTANT_PROGRESS_THOUGHT_CHARS
    )
    || (value.tokensPerSec != null && !isNonNegativeFiniteNumber(value.tokensPerSec))
    || value.state !== 'streaming'
    || !isNonNegativeSafeInteger(value.persistedAt)
    || !isNonNegativeSafeInteger(value.revision)
    || (value.regeneratesMessageId != null && !regeneratesMessageId)
    || (hasBranchReplacement && !branchReplacement)
    || (branchReplacement != null && regeneratesMessageId != null)
    || branchReplacement?.insertedModelSwitchMessage?.id === messageId
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
      branchReplacement: branchReplacement ?? undefined,
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

type BoundedJsonObjectReadResult =
  | { ok: true; value: Record<string, unknown>; bytes: number }
  | { ok: false; reason: 'missing' | 'invalid_json' | 'invalid_shape' };

function readBoundedJsonObject(
  storage: AppStorageFacade,
  key: string,
  maxBytes: number,
  recordKind: ChatPersistenceRecordKind,
): BoundedJsonObjectReadResult {
  const raw = storage.getString(key) ?? null;
  if (raw == null) {
    return { ok: false, reason: 'missing' };
  }

  const bytes = getUtf8ByteLength(raw, maxBytes);
  if (bytes > maxBytes) {
    return { ok: false, reason: 'invalid_shape' };
  }

  const parsed = parseJsonObject(raw, { maxBytes, recordKind });
  return parsed.ok ? { ...parsed, bytes } : parsed;
}

function isProgressSlot(value: unknown): value is ChatStreamingProgressSlot {
  return value === 0 || value === 1;
}

function isProgressPositionAfter(
  revision: number,
  persistedAt: number,
  previousRevision: number,
  previousPersistedAt: number,
): boolean {
  return revision > previousRevision
    || (revision === previousRevision && persistedAt > previousPersistedAt);
}

function parseChatStreamingOperationValue(
  value: Record<string, unknown>,
  expectedThreadId: string,
): ChatStreamingOperationRecord | null {
  const allowedKeys = new Set([
    'schemaVersion',
    'threadId',
    'messageId',
    'modelId',
    'createdAt',
    'regeneratesMessageId',
    'branchReplacement',
  ]);
  const threadId = readRequiredString(value.threadId);
  const messageId = readRequiredString(value.messageId);
  const modelId = readRequiredString(value.modelId);
  const regeneratesMessageId = value.regeneratesMessageId == null
    ? undefined
    : readRequiredString(value.regeneratesMessageId);
  const hasBranchReplacement = Object.prototype.hasOwnProperty.call(value, 'branchReplacement');
  const branchReplacement = !hasBranchReplacement || !threadId || !modelId
    ? undefined
    : parseChatBranchReplacementProgress({
        value: value.branchReplacement,
        threadId,
        modelId,
      });

  if (
    !hasOnlyKeys(value, allowedKeys)
    || value.schemaVersion !== CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION
    || threadId !== expectedThreadId
    || !messageId
    || !modelId
    || !isNonNegativeSafeInteger(value.createdAt)
    || (value.regeneratesMessageId != null && !regeneratesMessageId)
    || (hasBranchReplacement && !branchReplacement)
    || (branchReplacement != null && regeneratesMessageId != null)
    || branchReplacement?.insertedModelSwitchMessage?.id === messageId
  ) {
    return null;
  }

  return {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId,
    messageId,
    modelId,
    createdAt: value.createdAt,
    regeneratesMessageId: regeneratesMessageId ?? undefined,
    branchReplacement: branchReplacement ?? undefined,
  };
}

function parseChatStreamingCheckpointValue(
  value: Record<string, unknown>,
  expected: Pick<ChatStreamingProgressManifest, 'threadId' | 'messageId' | 'createdAt'>,
): ChatStreamingProgressCheckpointRecord | null {
  const allowedKeys = new Set([
    'schemaVersion',
    'threadId',
    'messageId',
    'createdAt',
    'revision',
    'persistedAt',
    'content',
    'thoughtContent',
    'tokensPerSec',
  ]);
  if (
    !hasOnlyKeys(value, allowedKeys)
    || value.schemaVersion !== CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION
    || value.threadId !== expected.threadId
    || value.messageId !== expected.messageId
    || value.createdAt !== expected.createdAt
    || !isNonNegativeSafeInteger(value.revision)
    || !isNonNegativeSafeInteger(value.persistedAt)
    || typeof value.content !== 'string'
    || value.content.length > MAX_ASSISTANT_PROGRESS_CONTENT_CHARS
    || (value.thoughtContent != null && typeof value.thoughtContent !== 'string')
    || (
      typeof value.thoughtContent === 'string'
      && value.thoughtContent.length > MAX_ASSISTANT_PROGRESS_THOUGHT_CHARS
    )
    || (value.tokensPerSec != null && !isNonNegativeFiniteNumber(value.tokensPerSec))
  ) {
    return null;
  }

  return {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: expected.threadId,
    messageId: expected.messageId,
    createdAt: expected.createdAt,
    revision: value.revision,
    persistedAt: value.persistedAt,
    content: value.content,
    thoughtContent: typeof value.thoughtContent === 'string' ? value.thoughtContent : undefined,
    tokensPerSec: isNonNegativeFiniteNumber(value.tokensPerSec) ? value.tokensPerSec : undefined,
  };
}

function parseChatStreamingTextUpdate(value: unknown): ChatStreamingProgressTextUpdate | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (value.kind === 'clear') {
    return hasOnlyKeys(value, new Set(['kind'])) ? { kind: 'clear' } : null;
  }

  if (
    (value.kind !== 'append' && value.kind !== 'replace')
    || !hasOnlyKeys(value, new Set(['kind', 'value']))
    || typeof value.value !== 'string'
  ) {
    return null;
  }

  return { kind: value.kind, value: value.value };
}

function parseChatStreamingChunkValue(
  value: Record<string, unknown>,
  expected: Pick<ChatStreamingProgressManifest, 'threadId' | 'messageId' | 'createdAt'>,
  reference: ChatStreamingProgressChunkReference,
): ChatStreamingProgressChunkRecord | null {
  const allowedKeys = new Set([
    'schemaVersion',
    'threadId',
    'messageId',
    'createdAt',
    'slot',
    'revision',
    'persistedAt',
    'content',
    'thoughtContent',
    'tokensPerSec',
  ]);
  const content = value.content === undefined
    ? undefined
    : parseChatStreamingTextUpdate(value.content);
  const thoughtContent = value.thoughtContent === undefined
    ? undefined
    : parseChatStreamingTextUpdate(value.thoughtContent);
  if (
    !hasOnlyKeys(value, allowedKeys)
    || value.schemaVersion !== CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION
    || value.threadId !== expected.threadId
    || value.messageId !== expected.messageId
    || value.createdAt !== expected.createdAt
    || value.slot !== reference.slot
    || value.revision !== reference.revision
    || value.persistedAt !== reference.persistedAt
    || (value.content !== undefined && !content)
    || (value.thoughtContent !== undefined && !thoughtContent)
    || !(
      value.tokensPerSec === undefined
      || value.tokensPerSec === null
      || isNonNegativeFiniteNumber(value.tokensPerSec)
    )
  ) {
    return null;
  }

  return {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: expected.threadId,
    messageId: expected.messageId,
    createdAt: expected.createdAt,
    slot: reference.slot,
    revision: reference.revision,
    persistedAt: reference.persistedAt,
    content: content ?? undefined,
    thoughtContent: thoughtContent ?? undefined,
    tokensPerSec: value.tokensPerSec as number | null | undefined,
  };
}

function parseChatStreamingManifestValue(
  value: Record<string, unknown>,
  expectedThreadId: string,
): ChatStreamingProgressManifest | null {
  const allowedKeys = new Set([
    'schemaVersion',
    'threadId',
    'messageId',
    'createdAt',
    'operationSlot',
    'checkpointSlot',
    'checkpointRevision',
    'checkpointPersistedAt',
    'chunks',
    'revision',
    'persistedAt',
  ]);
  if (
    !hasOnlyKeys(value, allowedKeys)
    || value.schemaVersion !== CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION
    || value.threadId !== expectedThreadId
    || !readRequiredString(value.messageId)
    || !isNonNegativeSafeInteger(value.createdAt)
    || !isProgressSlot(value.operationSlot)
    || !isProgressSlot(value.checkpointSlot)
    || !isNonNegativeSafeInteger(value.checkpointRevision)
    || !isNonNegativeSafeInteger(value.checkpointPersistedAt)
    || !Array.isArray(value.chunks)
    || value.chunks.length > MAX_CHAT_PROGRESS_CHUNKS
    || !isNonNegativeSafeInteger(value.revision)
    || !isNonNegativeSafeInteger(value.persistedAt)
  ) {
    return null;
  }

  const chunks: ChatStreamingProgressChunkReference[] = [];
  const slots = new Set<number>();
  let previousRevision = value.checkpointRevision;
  let previousPersistedAt = value.checkpointPersistedAt;
  for (const candidate of value.chunks) {
    if (!isObjectRecord(candidate)) {
      return null;
    }
    const allowedChunkKeys = new Set(['slot', 'revision', 'persistedAt']);
    if (
      !hasOnlyKeys(candidate, allowedChunkKeys)
      || !isSafeIntegerInRange(candidate.slot, 0, MAX_CHAT_PROGRESS_CHUNKS - 1)
      || !isNonNegativeSafeInteger(candidate.revision)
      || !isNonNegativeSafeInteger(candidate.persistedAt)
      || slots.has(candidate.slot)
      || !isProgressPositionAfter(
        candidate.revision,
        candidate.persistedAt,
        previousRevision,
        previousPersistedAt,
      )
    ) {
      return null;
    }

    chunks.push({
      slot: candidate.slot,
      revision: candidate.revision,
      persistedAt: candidate.persistedAt,
    });
    slots.add(candidate.slot);
    previousRevision = candidate.revision;
    previousPersistedAt = candidate.persistedAt;
  }

  if (value.revision !== previousRevision || value.persistedAt !== previousPersistedAt) {
    return null;
  }

  return {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: expectedThreadId,
    messageId: value.messageId as string,
    createdAt: value.createdAt,
    operationSlot: value.operationSlot,
    checkpointSlot: value.checkpointSlot,
    checkpointRevision: value.checkpointRevision,
    checkpointPersistedAt: value.checkpointPersistedAt,
    chunks,
    revision: value.revision,
    persistedAt: value.persistedAt,
  };
}

function applyRequiredProgressTextUpdate(
  current: string,
  update: ChatStreamingProgressTextUpdate | undefined,
  maxChars: number,
): string | null {
  if (!update) {
    return current;
  }
  if (update.kind === 'clear') {
    return '';
  }
  if (update.kind === 'replace') {
    return update.value.length <= maxChars ? update.value : null;
  }
  if (current.length + update.value.length > maxChars) {
    return null;
  }
  return current + update.value;
}

function applyOptionalProgressTextUpdate(
  current: string | undefined,
  update: ChatStreamingProgressTextUpdate | undefined,
  maxChars: number,
): { ok: true; value: string | undefined } | { ok: false } {
  if (!update) {
    return { ok: true, value: current };
  }
  if (update.kind === 'clear') {
    return { ok: true, value: undefined };
  }
  if (update.kind === 'replace') {
    return update.value.length <= maxChars
      ? { ok: true, value: update.value }
      : { ok: false };
  }
  if ((current?.length ?? 0) + update.value.length > maxChars) {
    return { ok: false };
  }
  return { ok: true, value: `${current ?? ''}${update.value}` };
}

type ChatStreamingProgressStateReadResult =
  | {
      ok: true;
      progress: ChatStreamingProgressRecord;
      writerState?: ChatStreamingProgressWriterState;
    }
  | { ok: false; reason: 'missing' | 'invalid_json' | 'invalid_shape' };

function readChatStreamingProgressState(
  storage: AppStorageFacade,
  threadId: string,
): ChatStreamingProgressStateReadResult {
  const manifestKey = getChatStreamingProgressStorageKey(threadId);
  const rawManifest = storage.getString(manifestKey) ?? null;
  if (rawManifest == null) {
    return { ok: false, reason: 'missing' };
  }

  const rawManifestBytes = getUtf8ByteLength(rawManifest, MAX_CHAT_PROGRESS_RECORD_BYTES);
  if (rawManifestBytes > MAX_CHAT_PROGRESS_RECORD_BYTES) {
    return { ok: false, reason: 'invalid_shape' };
  }
  const parsedEnvelope = parseJsonObject(rawManifest, {
    maxBytes: MAX_CHAT_PROGRESS_RECORD_BYTES,
    recordKind: 'progress_manifest',
  });
  if (!parsedEnvelope.ok) {
    return parsedEnvelope;
  }

  if (parsedEnvelope.value.schemaVersion === CHAT_STREAM_PROGRESS_SCHEMA_VERSION) {
    const legacy = parseChatStreamingProgressRecord(rawManifest, threadId);
    return legacy.ok ? { ok: true, progress: legacy.value } : legacy;
  }
  if (rawManifestBytes > MAX_CHAT_PROGRESS_MANIFEST_BYTES) {
    return { ok: false, reason: 'invalid_shape' };
  }

  const manifest = parseChatStreamingManifestValue(parsedEnvelope.value, threadId);
  if (!manifest) {
    return { ok: false, reason: 'invalid_shape' };
  }

  const operationRead = readBoundedJsonObject(
    storage,
    getChatStreamingOperationStorageKey(threadId, manifest.operationSlot),
    MAX_CHAT_PROGRESS_OPERATION_BYTES,
    'progress_operation',
  );
  if (!operationRead.ok) {
    return { ok: false, reason: operationRead.reason === 'missing' ? 'invalid_shape' : operationRead.reason };
  }
  const operation = parseChatStreamingOperationValue(operationRead.value, threadId);
  if (
    !operation
    || operation.messageId !== manifest.messageId
    || operation.createdAt !== manifest.createdAt
  ) {
    return { ok: false, reason: 'invalid_shape' };
  }

  const checkpointRead = readBoundedJsonObject(
    storage,
    getChatStreamingProgressCheckpointStorageKey(threadId, manifest.checkpointSlot),
    MAX_CHAT_PROGRESS_RECORD_BYTES,
    'progress_checkpoint',
  );
  if (!checkpointRead.ok) {
    return { ok: false, reason: checkpointRead.reason === 'missing' ? 'invalid_shape' : checkpointRead.reason };
  }
  const checkpoint = parseChatStreamingCheckpointValue(checkpointRead.value, manifest);
  if (
    !checkpoint
    || checkpoint.revision !== manifest.checkpointRevision
    || checkpoint.persistedAt !== manifest.checkpointPersistedAt
  ) {
    return { ok: false, reason: 'invalid_shape' };
  }

  let referencedBytes = rawManifestBytes + operationRead.bytes + checkpointRead.bytes;
  if (referencedBytes > MAX_CHAT_PROGRESS_AGGREGATE_BYTES) {
    return { ok: false, reason: 'invalid_shape' };
  }

  let content = checkpoint.content;
  let thoughtContent = checkpoint.thoughtContent;
  let tokensPerSec = checkpoint.tokensPerSec;
  for (const reference of manifest.chunks) {
    const chunkRead = readBoundedJsonObject(
      storage,
      getChatStreamingProgressChunkStorageKey(threadId, reference.slot),
      MAX_CHAT_PROGRESS_CHUNK_BYTES,
      'progress_chunk',
    );
    if (!chunkRead.ok) {
      return { ok: false, reason: chunkRead.reason === 'missing' ? 'invalid_shape' : chunkRead.reason };
    }
    referencedBytes += chunkRead.bytes;
    if (referencedBytes > MAX_CHAT_PROGRESS_AGGREGATE_BYTES) {
      return { ok: false, reason: 'invalid_shape' };
    }

    const chunk = parseChatStreamingChunkValue(chunkRead.value, manifest, reference);
    if (!chunk) {
      return { ok: false, reason: 'invalid_shape' };
    }
    const nextContent = applyRequiredProgressTextUpdate(
      content,
      chunk.content,
      MAX_ASSISTANT_PROGRESS_CONTENT_CHARS,
    );
    const nextThoughtContent = applyOptionalProgressTextUpdate(
      thoughtContent,
      chunk.thoughtContent,
      MAX_ASSISTANT_PROGRESS_THOUGHT_CHARS,
    );
    if (nextContent == null || !nextThoughtContent.ok) {
      return { ok: false, reason: 'invalid_shape' };
    }
    content = nextContent;
    thoughtContent = nextThoughtContent.value;
    if (chunk.tokensPerSec !== undefined) {
      tokensPerSec = chunk.tokensPerSec ?? undefined;
    }
  }

  const progress: ChatStreamingProgressRecord = {
    schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
    threadId,
    messageId: manifest.messageId,
    modelId: operation.modelId,
    createdAt: manifest.createdAt,
    content,
    thoughtContent,
    tokensPerSec,
    state: 'streaming',
    persistedAt: manifest.persistedAt,
    revision: manifest.revision,
    regeneratesMessageId: operation.regeneratesMessageId,
    branchReplacement: operation.branchReplacement,
  };
  return {
    ok: true,
    progress,
    writerState: {
      progress,
      manifest,
      operationSlot: manifest.operationSlot,
      checkpointSlot: manifest.checkpointSlot,
      activeChunkSlots: new Set(manifest.chunks.map((chunk) => chunk.slot)),
      operationBytes: operationRead.bytes,
      checkpointBytes: checkpointRead.bytes,
      manifestBytes: rawManifestBytes,
      referencedBytes,
    },
  };
}

export function readChatStreamingProgressRecord(
  storage: AppStorageFacade,
  threadId: string,
): ChatPersistenceReadResult<ChatStreamingProgressRecord> {
  const result = readChatStreamingProgressState(storage, threadId);
  return result.ok
    ? { ok: true, value: result.progress }
    : result;
}

const chatStreamingProgressWriterStates = new WeakMap<
  object,
  Map<string, ChatStreamingProgressWriterState>
>();

function getChatStreamingProgressWriterStateMap(
  storage: AppStorageFacade,
): Map<string, ChatStreamingProgressWriterState> {
  const storageIdentity = storage as object;
  const current = chatStreamingProgressWriterStates.get(storageIdentity);
  if (current) {
    return current;
  }

  const created = new Map<string, ChatStreamingProgressWriterState>();
  chatStreamingProgressWriterStates.set(storageIdentity, created);
  return created;
}

function hasSameProgressOperationIdentity(
  left: ChatStreamingProgressRecord,
  right: ChatStreamingProgressRecord,
): boolean {
  return left.threadId === right.threadId
    && left.messageId === right.messageId
    && left.modelId === right.modelId
    && left.createdAt === right.createdAt
    && left.regeneratesMessageId === right.regeneratesMessageId
    && (
      left.branchReplacement === right.branchReplacement
      || hasSameJsonShape(left.branchReplacement, right.branchReplacement)
    );
}

function hasSameProgressSnapshot(
  left: ChatStreamingProgressRecord,
  right: ChatStreamingProgressRecord,
): boolean {
  return hasSameProgressOperationIdentity(left, right)
    && left.content === right.content
    && left.thoughtContent === right.thoughtContent
    && left.tokensPerSec === right.tokensPerSec
    && left.revision === right.revision
    && left.persistedAt === right.persistedAt;
}

function createProgressTextUpdate(
  previous: string,
  next: string,
): ChatStreamingProgressTextUpdate | undefined {
  if (previous === next) {
    return undefined;
  }
  if (next.length === 0) {
    return { kind: 'clear' };
  }
  if (next.startsWith(previous)) {
    return { kind: 'append', value: next.slice(previous.length) };
  }
  return { kind: 'replace', value: next };
}

function createOptionalProgressTextUpdate(
  previous: string | undefined,
  next: string | undefined,
): ChatStreamingProgressTextUpdate | undefined {
  if (previous === next) {
    return undefined;
  }
  if (next === undefined) {
    return { kind: 'clear' };
  }
  if (previous !== undefined && next.startsWith(previous)) {
    return { kind: 'append', value: next.slice(previous.length) };
  }
  return { kind: 'replace', value: next };
}

function getProgressTextUpdateCharacterCount(
  update: ChatStreamingProgressTextUpdate | undefined,
): number {
  return update?.kind === 'append' || update?.kind === 'replace'
    ? update.value.length
    : 0;
}

function rejectOversizedProgress(
  progress: ChatStreamingProgressRecord,
): ChatStreamingProgressWriteResult | null {
  if (progress.content.length > MAX_ASSISTANT_PROGRESS_CONTENT_CHARS) {
    return { status: 'rejected', reason: 'content_too_large' };
  }
  if ((progress.thoughtContent?.length ?? 0) > MAX_ASSISTANT_PROGRESS_THOUGHT_CHARS) {
    return { status: 'rejected', reason: 'thought_too_large' };
  }
  return null;
}

function createProgressOperationRecord(
  progress: ChatStreamingOperationInput,
): ChatStreamingOperationRecord {
  return {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: progress.threadId,
    messageId: progress.messageId,
    modelId: progress.modelId,
    createdAt: progress.createdAt,
    ...(progress.regeneratesMessageId
      ? { regeneratesMessageId: progress.regeneratesMessageId }
      : null),
    ...(progress.branchReplacement
      ? { branchReplacement: progress.branchReplacement }
      : null),
  };
}

export function getChatStreamingProgressOperationByteLength(
  progress: ChatStreamingOperationInput,
): number {
  try {
    return getUtf8ByteLength(JSON.stringify(createProgressOperationRecord(progress)));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isChatStreamingProgressOperationWithinBounds(
  progress: ChatStreamingOperationInput,
): boolean {
  return getChatStreamingProgressOperationByteLength(progress)
    <= MAX_CHAT_PROGRESS_OPERATION_BYTES;
}

function createProgressCheckpointRecord(
  progress: ChatStreamingProgressRecord,
): ChatStreamingProgressCheckpointRecord {
  return {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: progress.threadId,
    messageId: progress.messageId,
    createdAt: progress.createdAt,
    revision: progress.revision,
    persistedAt: progress.persistedAt,
    content: progress.content,
    thoughtContent: progress.thoughtContent,
    tokensPerSec: progress.tokensPerSec,
  };
}

function writeInitialProgressCheckpoint(
  storage: AppStorageFacade,
  progress: ChatStreamingProgressRecord,
  previousState: ChatStreamingProgressWriterState | undefined,
  writerStates: Map<string, ChatStreamingProgressWriterState>,
): ChatStreamingProgressWriteResult {
  const operationSlot: ChatStreamingProgressSlot = previousState?.operationSlot === 0 ? 1 : 0;
  const checkpointSlot: ChatStreamingProgressSlot = previousState?.checkpointSlot === 0 ? 1 : 0;
  const operation = createProgressOperationRecord(progress);
  const checkpoint = createProgressCheckpointRecord(progress);
  const operationSerialization = serializeChatRecord(operation, 'progress_operation');
  if (operationSerialization.bytes > MAX_CHAT_PROGRESS_OPERATION_BYTES) {
    return { status: 'rejected', reason: 'operation_too_large' };
  }
  const checkpointSerialization = serializeChatRecord(checkpoint, 'progress_checkpoint');
  if (checkpointSerialization.bytes > MAX_CHAT_PROGRESS_RECORD_BYTES) {
    return { status: 'rejected', reason: 'record_too_large' };
  }

  const manifest: ChatStreamingProgressManifest = {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: progress.threadId,
    messageId: progress.messageId,
    createdAt: progress.createdAt,
    operationSlot,
    checkpointSlot,
    checkpointRevision: progress.revision,
    checkpointPersistedAt: progress.persistedAt,
    chunks: [],
    revision: progress.revision,
    persistedAt: progress.persistedAt,
  };
  const manifestSerialization = serializeChatRecord(manifest, 'progress_manifest');
  if (
    manifestSerialization.bytes > MAX_CHAT_PROGRESS_MANIFEST_BYTES
    || operationSerialization.bytes
      + checkpointSerialization.bytes
      + manifestSerialization.bytes > MAX_CHAT_PROGRESS_AGGREGATE_BYTES
  ) {
    return { status: 'rejected', reason: 'record_too_large' };
  }

  writeSerializedChatRecord(
    storage,
    getChatStreamingOperationStorageKey(progress.threadId, operationSlot),
    operationSerialization.serialized,
    operationSerialization.bytes,
    'progress_operation',
  );
  writeSerializedChatRecord(
    storage,
    getChatStreamingProgressCheckpointStorageKey(progress.threadId, checkpointSlot),
    checkpointSerialization.serialized,
    checkpointSerialization.bytes,
    'progress_checkpoint',
  );
  writeSerializedChatRecord(
    storage,
    getChatStreamingProgressStorageKey(progress.threadId),
    manifestSerialization.serialized,
    manifestSerialization.bytes,
    'progress_manifest',
  );

  writerStates.set(progress.threadId, {
    progress,
    manifest,
    operationSlot,
    checkpointSlot,
    activeChunkSlots: new Set(),
    operationBytes: operationSerialization.bytes,
    checkpointBytes: checkpointSerialization.bytes,
    manifestBytes: manifestSerialization.bytes,
    referencedBytes:
      operationSerialization.bytes + checkpointSerialization.bytes + manifestSerialization.bytes,
  });
  incrementChatPersistenceCounter('chat.persist.streaming');
  incrementChatPersistenceCounter(
    'chat.persist.assistantChars',
    progress.content.length + (progress.thoughtContent?.length ?? 0),
    { recordKind: 'progress_checkpoint' },
  );
  return { status: 'written', kind: 'checkpoint' };
}

function writeCompactedProgressCheckpoint(
  storage: AppStorageFacade,
  progress: ChatStreamingProgressRecord,
  currentState: ChatStreamingProgressWriterState,
  writerStates: Map<string, ChatStreamingProgressWriterState>,
): ChatStreamingProgressWriteResult {
  const checkpointSlot: ChatStreamingProgressSlot = currentState.checkpointSlot === 0 ? 1 : 0;
  const checkpoint = createProgressCheckpointRecord(progress);
  const checkpointSerialization = serializeChatRecord(checkpoint, 'progress_checkpoint');
  if (checkpointSerialization.bytes > MAX_CHAT_PROGRESS_RECORD_BYTES) {
    return { status: 'rejected', reason: 'record_too_large' };
  }

  const manifest: ChatStreamingProgressManifest = {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: progress.threadId,
    messageId: progress.messageId,
    createdAt: progress.createdAt,
    operationSlot: currentState.operationSlot,
    checkpointSlot,
    checkpointRevision: progress.revision,
    checkpointPersistedAt: progress.persistedAt,
    chunks: [],
    revision: progress.revision,
    persistedAt: progress.persistedAt,
  };
  const manifestSerialization = serializeChatRecord(manifest, 'progress_manifest');
  if (
    manifestSerialization.bytes > MAX_CHAT_PROGRESS_MANIFEST_BYTES
    || currentState.operationBytes
      + checkpointSerialization.bytes
      + manifestSerialization.bytes > MAX_CHAT_PROGRESS_AGGREGATE_BYTES
  ) {
    return { status: 'rejected', reason: 'record_too_large' };
  }

  writeSerializedChatRecord(
    storage,
    getChatStreamingProgressCheckpointStorageKey(progress.threadId, checkpointSlot),
    checkpointSerialization.serialized,
    checkpointSerialization.bytes,
    'progress_checkpoint',
  );
  writeSerializedChatRecord(
    storage,
    getChatStreamingProgressStorageKey(progress.threadId),
    manifestSerialization.serialized,
    manifestSerialization.bytes,
    'progress_manifest',
  );

  writerStates.set(progress.threadId, {
    progress,
    manifest,
    operationSlot: currentState.operationSlot,
    checkpointSlot,
    activeChunkSlots: new Set(),
    operationBytes: currentState.operationBytes,
    checkpointBytes: checkpointSerialization.bytes,
    manifestBytes: manifestSerialization.bytes,
    referencedBytes:
      currentState.operationBytes + checkpointSerialization.bytes + manifestSerialization.bytes,
  });
  incrementChatPersistenceCounter('chat.persist.streaming');
  incrementChatPersistenceCounter(
    'chat.persist.assistantChars',
    progress.content.length + (progress.thoughtContent?.length ?? 0),
    { recordKind: 'progress_checkpoint' },
  );
  return { status: 'written', kind: 'checkpoint' };
}

function writeProgressDelta(
  storage: AppStorageFacade,
  progress: ChatStreamingProgressRecord,
  currentState: ChatStreamingProgressWriterState,
  writerStates: Map<string, ChatStreamingProgressWriterState>,
): ChatStreamingProgressWriteResult {
  let slot = 0;
  while (slot < MAX_CHAT_PROGRESS_CHUNKS && currentState.activeChunkSlots.has(slot)) {
    slot += 1;
  }
  if (slot >= MAX_CHAT_PROGRESS_CHUNKS) {
    return writeCompactedProgressCheckpoint(storage, progress, currentState, writerStates);
  }

  const content = createProgressTextUpdate(currentState.progress.content, progress.content);
  const thoughtContent = createOptionalProgressTextUpdate(
    currentState.progress.thoughtContent,
    progress.thoughtContent,
  );
  const tokensPerSec = currentState.progress.tokensPerSec === progress.tokensPerSec
    ? undefined
    : progress.tokensPerSec ?? null;
  const chunk: ChatStreamingProgressChunkRecord = {
    schemaVersion: CHAT_STREAM_PROGRESS_STORAGE_SCHEMA_VERSION,
    threadId: progress.threadId,
    messageId: progress.messageId,
    createdAt: progress.createdAt,
    slot,
    revision: progress.revision,
    persistedAt: progress.persistedAt,
    content,
    thoughtContent,
    tokensPerSec,
  };
  const chunkSerialization = serializeChatRecord(chunk, 'progress_chunk');
  if (chunkSerialization.bytes > MAX_CHAT_PROGRESS_CHUNK_BYTES) {
    return writeCompactedProgressCheckpoint(storage, progress, currentState, writerStates);
  }

  const reference: ChatStreamingProgressChunkReference = {
    slot,
    revision: progress.revision,
    persistedAt: progress.persistedAt,
  };
  const manifest: ChatStreamingProgressManifest = {
    ...currentState.manifest,
    chunks: [...currentState.manifest.chunks, reference],
    revision: progress.revision,
    persistedAt: progress.persistedAt,
  };
  const manifestSerialization = serializeChatRecord(manifest, 'progress_manifest');
  const projectedReferencedBytes = currentState.referencedBytes
    - currentState.manifestBytes
    + chunkSerialization.bytes
    + manifestSerialization.bytes;
  if (
    manifestSerialization.bytes > MAX_CHAT_PROGRESS_MANIFEST_BYTES
    || projectedReferencedBytes > MAX_CHAT_PROGRESS_AGGREGATE_BYTES
  ) {
    return writeCompactedProgressCheckpoint(storage, progress, currentState, writerStates);
  }

  writeSerializedChatRecord(
    storage,
    getChatStreamingProgressChunkStorageKey(progress.threadId, slot),
    chunkSerialization.serialized,
    chunkSerialization.bytes,
    'progress_chunk',
  );
  writeSerializedChatRecord(
    storage,
    getChatStreamingProgressStorageKey(progress.threadId),
    manifestSerialization.serialized,
    manifestSerialization.bytes,
    'progress_manifest',
  );

  const activeChunkSlots = new Set(currentState.activeChunkSlots);
  activeChunkSlots.add(slot);
  writerStates.set(progress.threadId, {
    progress,
    manifest,
    operationSlot: currentState.operationSlot,
    checkpointSlot: currentState.checkpointSlot,
    activeChunkSlots,
    operationBytes: currentState.operationBytes,
    checkpointBytes: currentState.checkpointBytes,
    manifestBytes: manifestSerialization.bytes,
    referencedBytes: projectedReferencedBytes,
  });
  incrementChatPersistenceCounter('chat.persist.streaming');
  incrementChatPersistenceCounter(
    'chat.persist.assistantChars',
    getProgressTextUpdateCharacterCount(content)
      + getProgressTextUpdateCharacterCount(thoughtContent),
    { recordKind: 'progress_chunk' },
  );
  return { status: 'written', kind: 'delta' };
}

export function writeChatStreamingProgressRecord(
  storage: AppStorageFacade,
  progress: ChatStreamingProgressRecord,
): ChatStreamingProgressWriteResult {
  const oversized = rejectOversizedProgress(progress);
  if (oversized) {
    return oversized;
  }

  const writerStates = getChatStreamingProgressWriterStateMap(storage);
  let currentState = writerStates.get(progress.threadId);
  let currentProgress = currentState?.progress;
  if (!currentProgress) {
    const currentResult = readChatStreamingProgressState(storage, progress.threadId);
    if (currentResult.ok) {
      currentProgress = currentResult.progress;
      currentState = currentResult.writerState;
      if (currentState) {
        writerStates.set(progress.threadId, currentState);
      }
    }
  }

  if (currentProgress) {
    const sameMessage = currentProgress.messageId === progress.messageId;
    if (sameMessage) {
      if (!hasSameProgressOperationIdentity(currentProgress, progress)) {
        return { status: 'stale' };
      }
      if (
        currentProgress.revision > progress.revision
        || (
          currentProgress.revision === progress.revision
          && currentProgress.persistedAt > progress.persistedAt
        )
      ) {
        return { status: 'stale' };
      }
      if (
        currentProgress.revision === progress.revision
        && currentProgress.persistedAt === progress.persistedAt
      ) {
        return hasSameProgressSnapshot(currentProgress, progress)
          ? { status: 'unchanged' }
          : { status: 'stale' };
      }
    } else if (
      currentProgress.createdAt > progress.createdAt
      || (
        currentProgress.createdAt === progress.createdAt
        && currentProgress.persistedAt >= progress.persistedAt
      )
    ) {
      return { status: 'stale' };
    }
  }

  if (!currentState || currentState.progress.messageId !== progress.messageId) {
    return writeInitialProgressCheckpoint(storage, progress, currentState, writerStates);
  }

  return writeProgressDelta(storage, progress, currentState, writerStates);
}

export function removeChatStreamingProgressRecord(storage: AppStorageFacade, threadId: string): void {
  storage.remove(getChatStreamingProgressStorageKey(threadId));
  getChatStreamingProgressWriterStateMap(storage).delete(threadId);

  const artifactKeys = [
    getChatStreamingOperationStorageKey(threadId, 0),
    getChatStreamingOperationStorageKey(threadId, 1),
    getChatStreamingProgressCheckpointStorageKey(threadId, 0),
    getChatStreamingProgressCheckpointStorageKey(threadId, 1),
    ...Array.from(
      { length: MAX_CHAT_PROGRESS_CHUNKS },
      (_unused, slot) => getChatStreamingProgressChunkStorageKey(threadId, slot),
    ),
  ];
  let firstError: unknown;
  artifactKeys.forEach((key) => {
    try {
      storage.remove(key);
    } catch (error) {
      firstError ??= error;
    }
  });
  if (firstError) {
    throw firstError;
  }
}

export function listChatStreamingProgressStorageKeys(
  storage: Pick<AppStorageFacade, 'getAllKeys'>,
): string[] {
  return storage.getAllKeys().filter((key) => (
    key.startsWith(CHAT_STREAM_PROGRESS_STORAGE_KEY_PREFIX)
    || key.startsWith(CHAT_STREAM_OPERATION_STORAGE_KEY_PREFIX)
    || key.startsWith(CHAT_STREAM_PROGRESS_CHECKPOINT_STORAGE_KEY_PREFIX)
    || key.startsWith(CHAT_STREAM_PROGRESS_CHUNK_STORAGE_KEY_PREFIX)
  ));
}

export function clearChatStreamingProgressRecords(storage: AppStorageFacade): void {
  const keys = listChatStreamingProgressStorageKeys(storage);
  const threadIds = new Set<string>();
  const malformedKeys: string[] = [];
  keys.forEach((key) => {
    const threadId = getThreadIdFromChatStreamingProgressArtifactStorageKey(key);
    if (threadId) {
      threadIds.add(threadId);
    } else {
      malformedKeys.push(key);
    }
  });

  let firstError: unknown;
  threadIds.forEach((threadId) => {
    try {
      removeChatStreamingProgressRecord(storage, threadId);
    } catch (error) {
      firstError ??= error;
    }
  });
  malformedKeys.forEach((key) => {
    try {
      storage.remove(key);
    } catch (error) {
      firstError ??= error;
    }
  });
  if (firstError) {
    throw firstError;
  }
  chatStreamingProgressWriterStates.delete(storage as object);
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

  const progressThreadIds = new Set(
    listChatStreamingProgressStorageKeys(storage)
      .map(getThreadIdFromChatStreamingProgressArtifactStorageKey)
      .filter((threadId): threadId is string => threadId != null),
  );
  return Array.from(progressThreadIds).reduce((timestamp, threadId) => {
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
  storage.getAllKeys()
    .filter((key) => key.startsWith(CHAT_THREAD_STORAGE_KEY_PREFIX))
    .forEach((key) => storage.remove(key));
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
  durableCommitRevision?: number,
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

  if (progress.regeneratesMessageId === progress.messageId) {
    return { outcome: 'mismatched' };
  }

  if (progress.branchReplacement) {
    const branch = progress.branchReplacement;
    if (
      branch.baseDurablePersistedAt !== durablePersistedAt
      || branch.baseCommitRevision !== durableCommitRevision
    ) {
      return { outcome: 'stale' };
    }

    const targetIndex = thread.messages.findIndex(
      (message) => message.id === branch.targetUserMessageId,
    );
    const target = targetIndex >= 0 ? thread.messages[targetIndex] : undefined;
    if (
      !target
      || target.role !== 'user'
      || target.kind === 'model_switch'
      || target.createdAt !== branch.targetUserCreatedAt
      || progress.createdAt < target.createdAt
      || thread.messages.some((message) => message.id === progress.messageId)
      || (
        branch.insertedModelSwitchMessage != null
        && thread.messages.some((message) => message.id === branch.insertedModelSwitchMessage?.id)
      )
    ) {
      return { outcome: 'mismatched' };
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
    };
    const completedAt = Math.max(thread.updatedAt, progress.persistedAt, now);
    const recoveredThread = materializeChatBranchReplacementThread({
      thread,
      plan: createChatBranchReplacementPlanFromProgress(branch, progress.modelId),
      assistantMessage: recoveredMessage,
      status: 'stopped',
      updatedAt: completedAt,
      lastGeneratedAt: completedAt,
    });
    return recoveredThread
      ? { outcome: 'recovered', thread: recoveredThread }
      : { outcome: 'mismatched' };
  }

  const matchingIndex = thread.messages.findIndex((message) => message.id === progress.messageId);
  const matchingMessage = matchingIndex >= 0 ? thread.messages[matchingIndex] : undefined;
  let replacementTargetIndex = -1;
  if (matchingMessage) {
    if (
      matchingIndex !== thread.messages.length - 1
      || matchingMessage.role !== 'assistant'
      || (matchingMessage.state !== 'streaming' && matchingMessage.state !== 'stopped')
      || matchingMessage.createdAt !== progress.createdAt
      || (matchingMessage.modelId != null && matchingMessage.modelId !== progress.modelId)
      || matchingMessage.regeneratesMessageId !== progress.regeneratesMessageId
    ) {
      return { outcome: 'mismatched' };
    }
  } else if (progress.regeneratesMessageId) {
    replacementTargetIndex = thread.messages.findIndex(
      (message) => message.id === progress.regeneratesMessageId,
    );
    const replacementTarget = replacementTargetIndex >= 0
      ? thread.messages[replacementTargetIndex]
      : undefined;
    if (
      !replacementTarget
      || replacementTargetIndex !== thread.messages.length - 1
      || replacementTarget.role !== 'assistant'
      || replacementTarget.kind === 'model_switch'
      || replacementTarget.state === 'streaming'
    ) {
      return { outcome: 'mismatched' };
    }
    if (progress.createdAt < replacementTarget.createdAt) {
      return { outcome: 'stale' };
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
    : replacementTargetIndex >= 0
      ? thread.messages.map((message, index) => (
          index === replacementTargetIndex ? recoveredMessage : message
        ))
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
