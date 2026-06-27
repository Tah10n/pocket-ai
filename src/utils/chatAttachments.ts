import type {
  ChatAttachment,
  ChatAttachmentKind,
  ChatAttachmentNativeCapability,
  ChatAttachmentProcessingState,
  ChatAttachmentRuntimeInput,
  ChatAttachmentSource,
  ChatDocumentAttachmentDraft,
  ChatMediaAttachmentDraft,
} from '../types/attachments';
import {
  CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
  type ChatImageAttachment,
} from '../types/multimodal';
import {
  isSupportedChatImageDraftFormat,
  normalizeChatAttachmentLocalUri,
  validateChatImageAttachmentBounds,
} from './chatImageAttachments';

export const MAX_CHAT_ATTACHMENTS_BY_KIND: Record<ChatAttachmentKind, number> = {
  image: 4,
  audio: 1,
  document: 4,
  video: 1,
};

export const MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_AUDIO_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CHAT_ATTACHMENT_KINDS = new Set<ChatAttachmentKind>(['image', 'audio', 'document', 'video']);
const CHAT_ATTACHMENT_PROCESSING_STATES = new Set<ChatAttachmentProcessingState>([
  'staged',
  'processing',
  'ready',
  'failed',
]);

const SUPPORTED_AUDIO_ATTACHMENT_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
]);

const SUPPORTED_DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
]);

const SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
]);

const SUPPORTED_PROCESSABLE_DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  ...SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES,
  'application/pdf',
]);

const SUPPORTED_VIDEO_ATTACHMENT_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

const IMAGE_ATTACHMENT_MIME_PREFIX = 'image/';

const AUDIO_EXTENSION_TO_FORMAT = new Map([
  ['mp3', 'mp3' as const],
  ['wav', 'wav' as const],
  ['wave', 'wav' as const],
]);

const DOCUMENT_ATTACHMENT_EXTENSIONS = new Set([
  'csv',
  'json',
  'md',
  'markdown',
  'pdf',
  'tsv',
  'txt',
]);

const TEXT_DOCUMENT_EXTENSION_TO_MIME_TYPE = new Map([
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['tsv', 'text/tab-separated-values'],
  ['txt', 'text/plain'],
]);

const PROCESSABLE_DOCUMENT_EXTENSION_TO_MIME_TYPE = new Map([
  ...TEXT_DOCUMENT_EXTENSION_TO_MIME_TYPE,
  ['pdf', 'application/pdf'],
]);

const VIDEO_ATTACHMENT_EXTENSIONS = new Set([
  'mov',
  'mp4',
  'webm',
]);

const CHAT_ATTACHMENT_SOURCES = new Set<ChatAttachmentSource>([
  'photo_library',
  'document_picker',
  'derived_processor',
]);

const EXTENSION_TO_MIME_TYPE = new Map([
  ['csv', 'text/csv'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['json', 'application/json'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['tsv', 'text/tab-separated-values'],
  ['txt', 'text/plain'],
  ['wav', 'audio/wav'],
  ['wave', 'audio/wav'],
  ['webm', 'video/webm'],
]);

function normalizeToken(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeChatAttachmentSource(value: unknown): ChatAttachmentSource | undefined {
  const normalized = typeof value === 'string' ? normalizeToken(value) : '';
  return CHAT_ATTACHMENT_SOURCES.has(normalized as ChatAttachmentSource)
    ? normalized as ChatAttachmentSource
    : undefined;
}

function inferMimeTypeFromFileName(fileName: string): string | undefined {
  const extension = resolveChatAttachmentExtension(fileName);
  return extension ? EXTENSION_TO_MIME_TYPE.get(extension) : undefined;
}

function normalizeChatAttachmentMimeType(value: unknown, fileName: string, kind: ChatAttachmentKind): string | undefined {
  const normalized = typeof value === 'string' ? normalizeToken(value) : '';
  if (normalized.length > 0 && resolveChatAttachmentKindFromMimeType(normalized) === kind) {
    return normalized;
  }

  const inferred = inferMimeTypeFromFileName(fileName);
  return inferred && resolveChatAttachmentKindFromMimeType(inferred) === kind ? inferred : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .flatMap((entry) => {
      const text = readNonEmptyString(entry);
      return text ? [text] : [];
    });

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeChatAttachmentKind(value: unknown): ChatAttachmentKind | null {
  const normalized = typeof value === 'string' ? normalizeToken(value) : '';
  return CHAT_ATTACHMENT_KINDS.has(normalized as ChatAttachmentKind)
    ? normalized as ChatAttachmentKind
    : null;
}

export function normalizeChatAttachmentProcessingState(value: unknown): ChatAttachmentProcessingState | null {
  const normalized = typeof value === 'string' ? normalizeToken(value) : '';
  return CHAT_ATTACHMENT_PROCESSING_STATES.has(normalized as ChatAttachmentProcessingState)
    ? normalized as ChatAttachmentProcessingState
    : null;
}

export function resolveChatAttachmentExtension(value: string | null | undefined): string | null {
  const normalized = value?.split(/[?#]/u)[0]
    .split(/[\\/]/u)
    .filter(Boolean)
    .at(-1)
    ?.split('.')
    .at(-1);
  const extension = normalizeToken(normalized);
  return extension.length > 0 ? extension : null;
}

export function resolveChatAudioFormatFromMimeType(mediaType: string | null | undefined): 'wav' | 'mp3' | null {
  const normalized = normalizeToken(mediaType);
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') {
    return 'mp3';
  }

  if (normalized === 'audio/wav' || normalized === 'audio/wave' || normalized === 'audio/x-wav') {
    return 'wav';
  }

  return null;
}

export function resolveChatAudioFormatFromPath(value: string | null | undefined): 'wav' | 'mp3' | null {
  const extension = resolveChatAttachmentExtension(value);
  return extension ? AUDIO_EXTENSION_TO_FORMAT.get(extension) ?? null : null;
}

export function resolveChatAttachmentKindFromMimeType(mediaType: string | null | undefined): ChatAttachmentKind | null {
  const normalized = normalizeToken(mediaType);
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.startsWith(IMAGE_ATTACHMENT_MIME_PREFIX)) {
    return 'image';
  }

  if (SUPPORTED_AUDIO_ATTACHMENT_MIME_TYPES.has(normalized)) {
    return 'audio';
  }

  if (SUPPORTED_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalized)) {
    return 'document';
  }

  if (SUPPORTED_VIDEO_ATTACHMENT_MIME_TYPES.has(normalized)) {
    return 'video';
  }

  return null;
}

export function resolveChatAttachmentKindFromFileName(fileName: string | null | undefined): ChatAttachmentKind | null {
  const extension = resolveChatAttachmentExtension(fileName);
  if (!extension) {
    return null;
  }

  if (extension === 'jpg' || extension === 'jpeg' || extension === 'png') {
    return 'image';
  }

  if (AUDIO_EXTENSION_TO_FORMAT.has(extension)) {
    return 'audio';
  }

  if (DOCUMENT_ATTACHMENT_EXTENSIONS.has(extension)) {
    return 'document';
  }

  if (VIDEO_ATTACHMENT_EXTENSIONS.has(extension)) {
    return 'video';
  }

  return null;
}

export function resolveChatAttachmentKind(input: {
  mediaType?: string | null;
  fileName?: string | null;
  localUri?: string | null;
}): ChatAttachmentKind | null {
  return resolveChatAttachmentKindFromMimeType(input.mediaType)
    ?? resolveChatAttachmentKindFromFileName(input.fileName)
    ?? resolveChatAttachmentKindFromFileName(input.localUri);
}

export function isSupportedChatAttachmentMimeType(mediaType: string | null | undefined): boolean {
  return resolveChatAttachmentKindFromMimeType(mediaType) !== null;
}

export function resolveChatTextDocumentMimeType(input: {
  mediaType?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  localUri?: string | null;
}): string | null {
  const normalizedMimeType = normalizeToken(input.mimeType ?? input.mediaType);
  if (SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    return normalizedMimeType;
  }

  const extension = resolveChatAttachmentExtension(input.fileName)
    ?? resolveChatAttachmentExtension(input.localUri);
  return extension ? TEXT_DOCUMENT_EXTENSION_TO_MIME_TYPE.get(extension) ?? null : null;
}

export function isSupportedChatTextDocumentMimeType(mediaType: string | null | undefined): boolean {
  return SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalizeToken(mediaType));
}

export function resolveChatProcessableDocumentMimeType(input: {
  mediaType?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  localUri?: string | null;
}): string | null {
  const normalizedMimeType = normalizeToken(input.mimeType ?? input.mediaType);
  if (SUPPORTED_PROCESSABLE_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    return normalizedMimeType;
  }

  const extension = resolveChatAttachmentExtension(input.fileName)
    ?? resolveChatAttachmentExtension(input.localUri);
  return extension ? PROCESSABLE_DOCUMENT_EXTENSION_TO_MIME_TYPE.get(extension) ?? null : null;
}

export function isSupportedChatProcessableDocumentMimeType(mediaType: string | null | undefined): boolean {
  return SUPPORTED_PROCESSABLE_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalizeToken(mediaType));
}

export function isSupportedChatDocumentDraftFormat(
  draft: Pick<ChatDocumentAttachmentDraft, 'mimeType' | 'fileName' | 'localUri' | 'pickerUri'>,
): boolean {
  return resolveChatProcessableDocumentMimeType({
    mimeType: draft.mimeType,
    fileName: draft.fileName,
    localUri: draft.localUri,
  }) !== null
    || resolveChatProcessableDocumentMimeType({
      fileName: draft.pickerUri,
      localUri: draft.pickerUri,
    }) !== null;
}

export function isSupportedChatAudioDraftFormat(
  draft: Pick<ChatMediaAttachmentDraft, 'kind' | 'mimeType' | 'fileName' | 'localUri' | 'pickerUri'>,
): boolean {
  if (draft.kind !== 'audio') {
    return false;
  }

  return Boolean(
    resolveChatAudioFormatFromMimeType(draft.mimeType)
    ?? resolveChatAudioFormatFromPath(draft.fileName)
    ?? resolveChatAudioFormatFromPath(draft.localUri)
    ?? resolveChatAudioFormatFromPath(draft.pickerUri),
  );
}

export function hasFailedDraftMediaAttachments(drafts: readonly ChatMediaAttachmentDraft[]): boolean {
  return drafts.some((draft) => draft.copyStatus === 'failed');
}

export function getSendableDraftMediaAttachments(
  drafts: readonly ChatMediaAttachmentDraft[],
): ChatMediaAttachmentDraft[] {
  return drafts.filter((draft) => {
    if (
      draft.copyStatus !== 'copied'
      || normalizeChatAttachmentLocalUri(draft.localUri) === null
      || draft.pathCategory !== CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY
      || readNonEmptyString(draft.fileName) === undefined
      || readPositiveInteger(draft.sizeBytes) === undefined
    ) {
      return false;
    }

    if (draft.kind === 'audio') {
      return isSupportedChatAudioDraftFormat(draft)
        && draft.audio?.format !== undefined;
    }

    return false;
  });
}

export function validateChatMediaAttachmentLimit(
  kind: Extract<ChatAttachmentKind, 'audio'>,
  currentCount: number,
  incomingCount = 1,
): { ok: true; allowedRemaining: number } | { ok: false; reason: 'limit_exceeded'; allowedRemaining: number } {
  return validateChatAttachmentLimit(kind, currentCount, incomingCount);
}

export function getRemainingChatAttachmentSlots(kind: ChatAttachmentKind, currentCount: number): number {
  return Math.max(0, MAX_CHAT_ATTACHMENTS_BY_KIND[kind] - normalizeNonNegativeInteger(currentCount));
}

export function validateChatAttachmentLimit(
  kind: ChatAttachmentKind,
  currentCount: number,
  incomingCount = 1,
): { ok: true; allowedRemaining: number } | { ok: false; reason: 'limit_exceeded'; allowedRemaining: number } {
  const allowedRemaining = getRemainingChatAttachmentSlots(kind, currentCount);
  if (normalizeNonNegativeInteger(incomingCount) <= allowedRemaining) {
    return { ok: true, allowedRemaining };
  }

  return { ok: false, reason: 'limit_exceeded', allowedRemaining };
}

export function validateChatDocumentAttachmentLimit(
  currentCount: number,
  incomingCount = 1,
): { ok: true; allowedRemaining: number } | { ok: false; reason: 'limit_exceeded'; allowedRemaining: number } {
  return validateChatAttachmentLimit('document', currentCount, incomingCount);
}

export function hasFailedDraftDocumentAttachments(drafts: readonly ChatDocumentAttachmentDraft[]): boolean {
  return drafts.some((draft) => draft.copyStatus === 'failed');
}

export function getSendableDraftDocumentAttachments(
  drafts: readonly ChatDocumentAttachmentDraft[],
): ChatDocumentAttachmentDraft[] {
  return drafts.filter((draft) => (
    draft.copyStatus === 'copied'
    && normalizeChatAttachmentLocalUri(draft.localUri) !== null
    && draft.pathCategory === CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY
    && readNonEmptyString(draft.fileName) !== undefined
    && readPositiveInteger(draft.sizeBytes) !== undefined
    && isSupportedChatDocumentDraftFormat(draft)
  ));
}

export function resolveChatAttachmentRuntimeInputs(kind: ChatAttachmentKind): ChatAttachmentRuntimeInput[] {
  switch (kind) {
    case 'image':
      return ['image'];
    case 'audio':
      return ['audio'];
    case 'document':
      return ['document_text'];
    case 'video':
      return [];
    default:
      return [];
  }
}

export function resolveRequiredNativeCapabilities(kind: ChatAttachmentKind): ChatAttachmentNativeCapability[] {
  switch (kind) {
    case 'image':
      return ['vision'];
    case 'audio':
      return ['audio'];
    case 'document':
    case 'video':
    default:
      return [];
  }
}

export function normalizePersistedChatAttachment(
  value: unknown,
  context: { threadId?: string; messageId?: string } = {},
): ChatAttachment | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = normalizeChatAttachmentKind(value.kind);
  const state = normalizeChatAttachmentProcessingState(value.state);
  const id = readNonEmptyString(value.id);
  const threadId = readNonEmptyString(context.threadId) ?? readNonEmptyString(value.threadId);
  const messageId = readNonEmptyString(context.messageId) ?? readNonEmptyString(value.messageId);
  const localUri = normalizeChatAttachmentLocalUri(value.localUri);
  const fileName = readNonEmptyString(value.fileName);
  const source = normalizeChatAttachmentSource(value.source);
  const sizeBytes = readPositiveInteger(value.sizeBytes);
  const createdAt = readNonNegativeSafeInteger(value.createdAt);
  if (
    !kind
    || !state
    || !id
    || !threadId
    || !messageId
    || !localUri
    || value.pathCategory !== CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY
    || !fileName
    || !source
    || sizeBytes === undefined
    || createdAt === undefined
  ) {
    return null;
  }

  const mimeType = normalizeChatAttachmentMimeType(value.mimeType, fileName, kind);
  if (!mimeType) {
    return null;
  }

  const base = {
    id,
    kind,
    state,
    threadId,
    messageId,
    localUri,
    pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
    fileName,
    mimeType,
    sizeBytes,
    source,
    createdAt,
    ...(readNonEmptyString(value.errorCode) ? { errorCode: readNonEmptyString(value.errorCode) } : null),
    ...(readNonEmptyString(value.errorMessage) ? { errorMessage: readNonEmptyString(value.errorMessage) } : null),
    ...(readNonEmptyString(value.derivedFromAttachmentId) ? { derivedFromAttachmentId: readNonEmptyString(value.derivedFromAttachmentId) } : null),
  };

  switch (kind) {
    case 'image': {
      const image = isRecord(value.image) ? value.image : {};
      const width = readPositiveInteger(image.width);
      const height = readPositiveInteger(image.height);
      const thumbnailUri = normalizeChatAttachmentLocalUri(image.thumbnailUri);
      const thumbnailFileName = readNonEmptyString(image.thumbnailFileName);
      if (!validateChatImageAttachmentBounds({ size: sizeBytes, width, height }).ok) {
        return null;
      }

      return {
        ...base,
        kind: 'image',
        image: {
          ...(width !== undefined ? { width } : null),
          ...(height !== undefined ? { height } : null),
          ...(thumbnailUri ? { thumbnailUri } : null),
          ...(thumbnailUri && thumbnailFileName ? { thumbnailFileName } : null),
        },
      };
    }
    case 'audio': {
      const audio = isRecord(value.audio) ? value.audio : {};
      const format = audio.format === 'wav' || audio.format === 'mp3'
        ? audio.format
        : resolveChatAudioFormatFromMimeType(mimeType) ?? resolveChatAudioFormatFromPath(fileName);
      if (!format) {
        return null;
      }

      const durationMs = readPositiveInteger(audio.durationMs);
      return {
        ...base,
        kind: 'audio',
        audio: {
          format,
          ...(durationMs !== undefined ? { durationMs } : null),
        },
      };
    }
    case 'document': {
      const document = isRecord(value.document) ? value.document : {};
      const processorId = readNonEmptyString(document.processorId);
      const processorVersion = readPositiveInteger(document.processorVersion);
      if (!processorId || processorVersion === undefined) {
        return null;
      }

      const pageCount = readPositiveInteger(document.pageCount);
      const extractedCharCount = readPositiveInteger(document.extractedCharCount);
      return {
        ...base,
        kind: 'document',
        document: {
          processorId,
          processorVersion,
          ...(readNonEmptyString(document.contentHash) ? { contentHash: readNonEmptyString(document.contentHash) } : null),
          ...(pageCount !== undefined ? { pageCount } : null),
          ...(extractedCharCount !== undefined ? { extractedCharCount } : null),
          ...(typeof document.isScanned === 'boolean' ? { isScanned: document.isScanned } : null),
        },
      };
    }
    case 'video': {
      const video = isRecord(value.video) ? value.video : {};
      const samplingVersion = readPositiveInteger(video.samplingVersion);
      if (samplingVersion === undefined) {
        return null;
      }

      const durationMs = readPositiveInteger(video.durationMs);
      const width = readPositiveInteger(video.width);
      const height = readPositiveInteger(video.height);
      return {
        ...base,
        kind: 'video',
        video: {
          ...(durationMs !== undefined ? { durationMs } : null),
          ...(width !== undefined ? { width } : null),
          ...(height !== undefined ? { height } : null),
          derivedAttachmentIds: normalizeStringList(video.derivedAttachmentIds) ?? [],
          samplingVersion,
        },
      };
    }
    default:
      return null;
  }
}

export function toGenericChatAttachmentFromLegacyImageAttachment(
  attachment: ChatImageAttachment,
): ChatAttachment | null {
  return normalizePersistedChatAttachment({
    id: attachment.id,
    kind: 'image',
    state: 'ready',
    threadId: attachment.threadId,
    messageId: attachment.messageId,
    localUri: attachment.localUri,
    pathCategory: attachment.pathCategory,
    fileName: attachment.fileName,
    mimeType: attachment.mediaType,
    sizeBytes: attachment.size,
    source: attachment.source,
    createdAt: attachment.createdAt,
    image: {
      width: attachment.width,
      height: attachment.height,
      thumbnailUri: attachment.thumbnailUri,
      thumbnailFileName: attachment.thumbnailFileName,
    },
  });
}

export function toLegacyChatImageAttachment(
  attachment: ChatAttachment,
): ChatImageAttachment | null {
  if (attachment.kind !== 'image' || attachment.source !== 'photo_library' || attachment.state !== 'ready') {
    return null;
  }

  if (!isSupportedChatImageDraftFormat({
    mediaType: attachment.mimeType,
    fileName: attachment.fileName,
    localUri: attachment.localUri,
    previewUri: attachment.localUri,
    pickerUri: attachment.localUri,
  })) {
    return null;
  }

  if (!validateChatImageAttachmentBounds({
    size: attachment.sizeBytes,
    width: attachment.image?.width,
    height: attachment.image?.height,
  }).ok) {
    return null;
  }

  return {
    id: attachment.id,
    threadId: attachment.threadId,
    messageId: attachment.messageId,
    localUri: attachment.localUri,
    ...(attachment.image?.thumbnailUri ? { thumbnailUri: attachment.image.thumbnailUri } : null),
    pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
    mediaType: attachment.mimeType,
    fileName: attachment.fileName,
    ...(attachment.image?.thumbnailFileName ? { thumbnailFileName: attachment.image.thumbnailFileName } : null),
    size: attachment.sizeBytes,
    ...(attachment.image?.width !== undefined ? { width: attachment.image.width } : null),
    ...(attachment.image?.height !== undefined ? { height: attachment.image.height } : null),
    source: 'photo_library',
    createdAt: attachment.createdAt,
  };
}
