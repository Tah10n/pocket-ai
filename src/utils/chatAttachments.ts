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
export const MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_OFFICE_DOCUMENT_ATTACHMENT_BYTES = 12 * 1024 * 1024;
// Outer defensive ceiling for a future/unknown native document format. Known formats below use
// the tighter mobile parser profile before picker copy and again before native preparation.
export const MAX_CHAT_ANYDOC_DOCUMENT_ATTACHMENT_BYTES = 16 * 1024 * 1024;
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

const DOCUMENT_ATTACHMENT_MIME_TYPE_ALIASES = new Map([
  ['text/comma-separated-values', 'text/csv'],
]);

const SUPPORTED_DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/epub+zip',
  'application/msword',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'text/comma-separated-values',
  'text/markdown',
  'text/plain',
  'text/rtf',
  'text/tab-separated-values',
]);

const SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
]);

const SUPPORTED_ANYDOC_DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  ...SUPPORTED_DOCUMENT_ATTACHMENT_MIME_TYPES,
].filter((mimeType) => !SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES.has(mimeType)));

const SUPPORTED_PROCESSABLE_DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  ...SUPPORTED_DOCUMENT_ATTACHMENT_MIME_TYPES,
]);
const CONTROLLED_GENERIC_DOCUMENT_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
]);

export const CHAT_DOCUMENT_PICKER_MIME_TYPES = [
  // Controlled generic provider types: routing still requires a supported extension and the
  // native parser remains authoritative for office/archive content detection.
  'application/octet-stream',
  'application/zip',
  ...SUPPORTED_DOCUMENT_ATTACHMENT_MIME_TYPES,
];

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
  'doc',
  'docm',
  'docx',
  'epub',
  'json',
  'md',
  'markdown',
  'odp',
  'ods',
  'odt',
  'pdf',
  'pot',
  'pps',
  'ppsm',
  'ppsx',
  'ppt',
  'pptm',
  'pptx',
  'rtf',
  'tsv',
  'txt',
  'xls',
  'xlsb',
  'xlsm',
  'xlsx',
]);

const TEXT_DOCUMENT_EXTENSION_TO_MIME_TYPE = new Map([
  ['json', 'application/json'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['tsv', 'text/tab-separated-values'],
  ['txt', 'text/plain'],
]);

const PROCESSABLE_DOCUMENT_EXTENSION_TO_MIME_TYPE = new Map([
  ...TEXT_DOCUMENT_EXTENSION_TO_MIME_TYPE,
  ['csv', 'text/csv'],
  ['doc', 'application/msword'],
  ['docm', 'application/vnd.ms-word.document.macroenabled.12'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['epub', 'application/epub+zip'],
  ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['odt', 'application/vnd.oasis.opendocument.text'],
  ['pdf', 'application/pdf'],
  ['pot', 'application/vnd.ms-powerpoint'],
  ['pps', 'application/vnd.ms-powerpoint'],
  ['ppsm', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12'],
  ['ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptm', 'application/vnd.ms-powerpoint.presentation.macroenabled.12'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['rtf', 'application/rtf'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsb', 'application/vnd.ms-excel.sheet.binary.macroenabled.12'],
  ['xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
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
  ['doc', 'application/msword'],
  ['docm', 'application/vnd.ms-word.document.macroenabled.12'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['epub', 'application/epub+zip'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['json', 'application/json'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'],
  ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['odt', 'application/vnd.oasis.opendocument.text'],
  ['pdf', 'application/pdf'],
  ['pot', 'application/vnd.ms-powerpoint'],
  ['pps', 'application/vnd.ms-powerpoint'],
  ['ppsm', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12'],
  ['ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptm', 'application/vnd.ms-powerpoint.presentation.macroenabled.12'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['png', 'image/png'],
  ['rtf', 'application/rtf'],
  ['tsv', 'text/tab-separated-values'],
  ['txt', 'text/plain'],
  ['wav', 'audio/wav'],
  ['wave', 'audio/wav'],
  ['webm', 'video/webm'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsb', 'application/vnd.ms-excel.sheet.binary.macroenabled.12'],
  ['xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

function normalizeToken(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function normalizeDocumentAttachmentMimeType(value: string | null | undefined): string {
  const normalized = normalizeToken(value);
  return DOCUMENT_ATTACHMENT_MIME_TYPE_ALIASES.get(normalized) ?? normalized;
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
  const normalized = normalizeDocumentAttachmentMimeType(mediaType);
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
  const processableMimeType = resolveChatProcessableDocumentMimeType(input);
  return processableMimeType && SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES.has(processableMimeType)
    ? processableMimeType
    : null;
}

export function isSupportedChatTextDocumentMimeType(mediaType: string | null | undefined): boolean {
  return SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalizeDocumentAttachmentMimeType(mediaType));
}

function readExactAnyDocCommit(value: unknown): string | undefined {
  const commit = readNonEmptyString(value);
  return commit && /^[a-f0-9]{40}$/u.test(commit) ? commit : undefined;
}

const PERSISTED_DOCUMENT_CANONICAL_FORMATS = new Set([
  'csv', 'doc', 'docm', 'docx', 'epub', 'json', 'markdown', 'odp', 'ods', 'odt',
  'pdf', 'pot', 'pps', 'ppsm', 'ppsx', 'ppt', 'pptm', 'pptx', 'rtf', 'tsv', 'txt',
  'xls', 'xlsb', 'xlsm', 'xlsx',
]);
const PERSISTED_DOCUMENT_WARNING_CODES = new Set([
  'assets_skipped', 'context_truncated', 'format_hint_mismatch', 'hidden_content_unverified',
  'hidden_rows_skipped', 'partial_content', 'unsupported_assets',
]);
const MAX_PERSISTED_DOCUMENT_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PERSISTED_DOCUMENT_SOURCE_CHARS = 1_000_000;
const MAX_PERSISTED_DOCUMENT_SELECTED_CHARS = 64_000;
const MAX_PERSISTED_DOCUMENT_CHUNKS = 2_048;
const MAX_PERSISTED_DOCUMENT_SELECTED_CHUNKS = 64;
const MAX_PERSISTED_DOCUMENT_STRUCTURAL_COUNT = 2_048;
const MAX_PERSISTED_DOCUMENT_ASSET_COUNT = 128;

function readBoundedPersistedDocumentString(
  value: unknown,
  maxChars: number,
  pattern?: RegExp,
): string | undefined {
  const normalized = readNonEmptyString(value);
  return normalized && normalized.length <= maxChars && (!pattern || pattern.test(normalized))
    ? normalized
    : undefined;
}

function readBoundedPositiveSafeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= maximum
    ? value
    : undefined;
}

function normalizePersistedDocumentWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const warnings = value.flatMap((entry): string[] => {
    const warning = readBoundedPersistedDocumentString(entry, 96);
    return warning && PERSISTED_DOCUMENT_WARNING_CODES.has(warning) ? [warning] : [];
  });
  const unique = [...new Set(warnings)].slice(0, 32);
  return unique.length > 0 ? unique : undefined;
}

export function isSupportedChatAnydocDocumentMimeType(mediaType: string | null | undefined): boolean {
  return SUPPORTED_ANYDOC_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalizeDocumentAttachmentMimeType(mediaType));
}

export function resolveChatDocumentMaxBytes(mediaType: string | null | undefined): number {
  const normalized = normalizeDocumentAttachmentMimeType(mediaType);
  if (normalized === 'application/pdf') {
    return MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES;
  }
  if (
    normalized === 'application/epub+zip'
    || normalized === 'application/rtf'
    || normalized === 'text/rtf'
  ) {
    return MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES;
  }
  if (normalized === 'text/csv' || SUPPORTED_TEXT_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalized)) {
    return MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES;
  }
  return SUPPORTED_ANYDOC_DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalized)
    ? MAX_CHAT_OFFICE_DOCUMENT_ATTACHMENT_BYTES
    : MAX_CHAT_ANYDOC_DOCUMENT_ATTACHMENT_BYTES;
}

export function resolveChatProcessableDocumentMimeType(input: {
  mediaType?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  localUri?: string | null;
}): string | null {
  const extension = resolveChatAttachmentExtension(input.fileName)
    ?? resolveChatAttachmentExtension(input.localUri);
  const normalizedMimeType = normalizeDocumentAttachmentMimeType(input.mimeType ?? input.mediaType);
  const extensionMimeType = extension
    ? PROCESSABLE_DOCUMENT_EXTENSION_TO_MIME_TYPE.get(extension) ?? null
    : null;

  if (CONTROLLED_GENERIC_DOCUMENT_MIME_TYPES.has(normalizedMimeType) || !normalizedMimeType) {
    return extensionMimeType;
  }
  if (isSupportedChatAnydocDocumentMimeType(normalizedMimeType)) {
    // Native strong-content detection is authoritative for renamed/mislabelled structured files.
    return normalizedMimeType;
  }
  if (isSupportedChatTextDocumentMimeType(normalizedMimeType)) {
    if (!extension) {
      return normalizedMimeType;
    }
    // Never direct-decode a filename that declares a structured/native extension. Direct text
    // aliases may still refine one another (for example text/plain + notes.md).
    return extensionMimeType;
  }
  return null;
}

export function isSupportedChatProcessableDocumentMimeType(mediaType: string | null | undefined): boolean {
  return SUPPORTED_PROCESSABLE_DOCUMENT_ATTACHMENT_MIME_TYPES.has(
    normalizeDocumentAttachmentMimeType(mediaType),
  );
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
    ...(readNonEmptyString(value.displayName) ? { displayName: readNonEmptyString(value.displayName) } : null),
    mimeType,
    sizeBytes,
    source,
    createdAt,
    ...(readNonEmptyString(value.errorCode) ? { errorCode: readNonEmptyString(value.errorCode) } : null),
    ...(readNonEmptyString(value.errorMessage) ? { errorMessage: readNonEmptyString(value.errorMessage) } : null),
    ...(readNonEmptyString(value.derivedFromAttachmentId) ? { derivedFromAttachmentId: readNonEmptyString(value.derivedFromAttachmentId) } : null),
    ...(readNonNegativeSafeInteger(value.derivedFromAssetId) !== undefined
      ? { derivedFromAssetId: readNonNegativeSafeInteger(value.derivedFromAssetId) }
      : null),
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
      const processorId = readBoundedPersistedDocumentString(
        document.processorId,
        64,
        /^[A-Za-z0-9._:-]+$/u,
      );
      const processorVersion = readBoundedPositiveSafeInteger(document.processorVersion, 1_000);
      if (!processorId || processorVersion === undefined) {
        return null;
      }

      const pageCount = readBoundedPositiveSafeInteger(
        document.pageCount,
        MAX_PERSISTED_DOCUMENT_STRUCTURAL_COUNT,
      );
      const slideCount = readBoundedPositiveSafeInteger(
        document.slideCount,
        MAX_PERSISTED_DOCUMENT_STRUCTURAL_COUNT,
      );
      const sheetCount = readBoundedPositiveSafeInteger(
        document.sheetCount,
        MAX_PERSISTED_DOCUMENT_STRUCTURAL_COUNT,
      );
      const rawAssetCount = readNonNegativeSafeInteger(document.assetCount);
      const assetCount = rawAssetCount !== undefined && rawAssetCount <= MAX_PERSISTED_DOCUMENT_ASSET_COUNT
        ? rawAssetCount
        : undefined;
      const sourceByteCount = readBoundedPositiveSafeInteger(
        document.sourceByteCount,
        MAX_PERSISTED_DOCUMENT_SOURCE_BYTES,
      );
      const sourceCharCount = readBoundedPositiveSafeInteger(
        document.sourceCharCount,
        MAX_PERSISTED_DOCUMENT_SOURCE_CHARS,
      );
      const rawSelectedCharCount = readBoundedPositiveSafeInteger(
        document.selectedCharCount,
        MAX_PERSISTED_DOCUMENT_SELECTED_CHARS,
      );
      const selectedCharCount = rawSelectedCharCount !== undefined
        && (sourceCharCount === undefined || rawSelectedCharCount <= sourceCharCount)
        ? rawSelectedCharCount
        : undefined;
      const rawExtractedCharCount = readBoundedPositiveSafeInteger(
        document.extractedCharCount,
        MAX_PERSISTED_DOCUMENT_SELECTED_CHARS,
      );
      const extractedCharCount = rawExtractedCharCount !== undefined
        && (sourceCharCount === undefined || rawExtractedCharCount <= sourceCharCount)
        ? rawExtractedCharCount
        : undefined;
      const chunkCount = readBoundedPositiveSafeInteger(
        document.chunkCount,
        MAX_PERSISTED_DOCUMENT_CHUNKS,
      );
      const rawSelectedChunkCount = readBoundedPositiveSafeInteger(
        document.selectedChunkCount,
        MAX_PERSISTED_DOCUMENT_SELECTED_CHUNKS,
      );
      const selectedChunkCount = rawSelectedChunkCount !== undefined
        && (chunkCount === undefined || rawSelectedChunkCount <= chunkCount)
        ? rawSelectedChunkCount
        : undefined;
      const warnings = normalizePersistedDocumentWarnings(document.warnings);
      const exactAnyDocCommit = readExactAnyDocCommit(
        document.exactAnyDocCommit ?? document.anydocCommit,
      );
      const rawContentHash = readBoundedPersistedDocumentString(document.contentHash, 128);
      const rawContentSha256 = readBoundedPersistedDocumentString(
        document.contentSha256,
        64,
        /^[a-f0-9]{64}$/u,
      );
      const usesStrictSha256Identity = processorId === 'pocket-anydoc' || processorVersion >= 3;
      const hasMatchingSha256Identity = rawContentSha256 !== undefined
        && rawContentHash === `sha256:${rawContentSha256}`;
      const contentHash = usesStrictSha256Identity
        ? (hasMatchingSha256Identity ? rawContentHash : undefined)
        : rawContentHash;
      const contentSha256 = usesStrictSha256Identity && hasMatchingSha256Identity
        ? rawContentSha256
        : undefined;
      const canonicalFormatValue = readBoundedPersistedDocumentString(document.canonicalFormat, 32);
      const canonicalFormat = canonicalFormatValue
        && PERSISTED_DOCUMENT_CANONICAL_FORMATS.has(canonicalFormatValue)
        ? canonicalFormatValue
        : undefined;
      const parserId = readBoundedPersistedDocumentString(
        document.parserId,
        64,
        /^[A-Za-z0-9._:-]+$/u,
      );
      const parserVersion = readBoundedPersistedDocumentString(
        document.parserVersion,
        64,
        /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u,
      );
      return {
        ...base,
        kind: 'document',
        document: {
          processorId,
          processorVersion,
          ...(contentHash ? { contentHash } : null),
          ...(contentSha256 ? { contentSha256 } : null),
          ...(canonicalFormat ? { canonicalFormat } : null),
          ...(parserId ? { parserId } : null),
          ...(parserVersion ? { parserVersion } : null),
          ...(exactAnyDocCommit ? { exactAnyDocCommit } : null),
          ...(sourceByteCount !== undefined ? { sourceByteCount } : null),
          ...(sourceCharCount !== undefined ? { sourceCharCount } : null),
          ...(selectedCharCount !== undefined ? { selectedCharCount } : null),
          ...(selectedChunkCount !== undefined ? { selectedChunkCount } : null),
          ...(chunkCount !== undefined ? { chunkCount } : null),
          ...(pageCount !== undefined ? { pageCount } : null),
          ...(slideCount !== undefined ? { slideCount } : null),
          ...(sheetCount !== undefined ? { sheetCount } : null),
          ...(assetCount !== undefined ? { assetCount } : null),
          ...(extractedCharCount !== undefined ? { extractedCharCount } : null),
          ...(typeof document.isScanned === 'boolean' ? { isScanned: document.isScanned } : null),
          ...(typeof document.truncated === 'boolean' ? { truncated: document.truncated } : null),
          ...(warnings ? { warnings } : null),
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
    derivedFromAttachmentId: attachment.derivedFromAttachmentId,
    derivedFromAssetId: attachment.derivedFromAssetId,
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
  if (
    attachment.kind !== 'image'
    || (attachment.source !== 'photo_library' && attachment.source !== 'derived_processor')
    || attachment.state !== 'ready'
  ) {
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
    source: attachment.source,
    ...(attachment.derivedFromAttachmentId
      ? { derivedFromAttachmentId: attachment.derivedFromAttachmentId }
      : null),
    ...(attachment.derivedFromAssetId !== undefined
      ? { derivedFromAssetId: attachment.derivedFromAssetId }
      : null),
    createdAt: attachment.createdAt,
  };
}
