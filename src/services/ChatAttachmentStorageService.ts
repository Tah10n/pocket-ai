import * as FileSystem from 'expo-file-system/legacy';
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import type { DocumentPickerAsset } from 'expo-document-picker';
import type { ImagePickerAsset } from 'expo-image-picker';
import {
  CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
  type AttachmentDraft,
  type ChatImageAttachment,
} from '@/types/multimodal';
import type { ChatAttachment, ChatDocumentAttachmentDraft, ChatMediaAttachmentDraft } from '@/types/attachments';
import type { ChatThread } from '@/types/chat';
import {
  MAX_CHAT_AUDIO_ATTACHMENT_BYTES,
  MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES,
  isSupportedChatDocumentDraftFormat,
  resolveChatAttachmentExtension,
  resolveChatAudioFormatFromMimeType,
  resolveChatAudioFormatFromPath,
  resolveChatProcessableDocumentMimeType,
} from '@/utils/chatAttachments';
import {
  CHAT_IMAGE_ATTACHMENT_THUMBNAIL_MAX_SIDE_PIXELS,
  getChatAttachmentsDir,
  isSupportedChatImageDraftFormat,
  normalizeChatAttachmentLocalUri,
  resolveSupportedChatImageExtensionFromMimeType,
  resolveSupportedChatImageExtensionFromPath,
  type SupportedChatImageExtension,
  validateChatImageAttachmentBounds,
} from '@/utils/chatImageAttachments';

export { getChatAttachmentsDir } from '@/utils/chatImageAttachments';

export type ChatAttachmentDirectoryReconciliationResult = {
  deletedCount: number;
  attemptedDeleteCount: number;
  candidateCount: number;
  hasMoreCandidates: boolean;
};

type ChatAttachmentStorageServiceOptions = {
  now?: () => number;
  random?: () => number;
};

const RECENT_DRAFT_FUTURE_GRACE_MS = 5 * 60 * 1000;
const CHAT_IMAGE_ATTACHMENT_THUMBNAIL_JPEG_QUALITY = 0.72;

type CopyableImageAsset = Pick<
  ImagePickerAsset,
  'uri' | 'fileName' | 'fileSize' | 'mimeType' | 'width' | 'height' | 'type'
>;

type CopyableDocumentAsset = Pick<
  DocumentPickerAsset,
  'uri' | 'name' | 'size' | 'mimeType'
>;

export type MaterializeAttachmentDraftsOptions = {
  threadId: string;
  messageId: string;
  drafts: readonly AttachmentDraft[];
  now?: () => number;
};

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function resolveSupportedExtension(asset: CopyableImageAsset): SupportedChatImageExtension | null {
  if (asset.mimeType) {
    return resolveSupportedChatImageExtensionFromMimeType(asset.mimeType);
  }

  return resolveSupportedChatImageExtensionFromPath(asset.fileName)
    ?? resolveSupportedChatImageExtensionFromPath(asset.uri);
}

const TEXT_DOCUMENT_MIME_TYPE_EXTENSION = new Map([
  ['application/json', 'json'],
  ['application/pdf', 'pdf'],
  ['text/csv', 'csv'],
  ['text/markdown', 'md'],
  ['text/plain', 'txt'],
  ['text/tab-separated-values', 'tsv'],
]);

const AUDIO_MIME_TYPE_EXTENSION = new Map([
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/x-wav', 'wav'],
]);

function resolveDocumentCopyFormat(asset: CopyableDocumentAsset): { extension: string; mimeType: string } | null {
  const mimeType = resolveChatProcessableDocumentMimeType({
    mimeType: asset.mimeType,
    fileName: asset.name,
    localUri: asset.uri,
  });
  if (!mimeType) {
    return null;
  }

  return {
    mimeType,
    extension: TEXT_DOCUMENT_MIME_TYPE_EXTENSION.get(mimeType)
      ?? resolveChatAttachmentExtension(asset.name)
      ?? 'txt',
  };
}

function resolveDocumentMaxBytes(mimeType: string): number {
  return mimeType === 'application/pdf'
    ? MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES
    : MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES;
}

function resolveAudioCopyFormat(asset: CopyableDocumentAsset): { extension: string; mimeType: string; format: 'wav' | 'mp3' } | null {
  const format = resolveChatAudioFormatFromMimeType(asset.mimeType)
    ?? resolveChatAudioFormatFromPath(asset.name)
    ?? resolveChatAudioFormatFromPath(asset.uri);
  if (!format) {
    return null;
  }

  const normalizedMimeType = asset.mimeType?.trim().toLowerCase();
  return {
    format,
    mimeType: normalizedMimeType && AUDIO_MIME_TYPE_EXTENSION.has(normalizedMimeType)
      ? normalizedMimeType
      : format === 'mp3'
        ? 'audio/mpeg'
        : 'audio/wav',
    extension: normalizedMimeType
      ? AUDIO_MIME_TYPE_EXTENSION.get(normalizedMimeType) ?? format
      : resolveChatAttachmentExtension(asset.name) ?? format,
  };
}

export class ChatImageAttachmentTooLargeError extends Error {
  constructor() {
    super('Selected image exceeds chat attachment size limits.');
    this.name = 'ChatImageAttachmentTooLargeError';
    Object.setPrototypeOf(this, ChatImageAttachmentTooLargeError.prototype);
  }
}

export function isChatImageAttachmentTooLargeError(error: unknown): error is ChatImageAttachmentTooLargeError {
  return error instanceof ChatImageAttachmentTooLargeError;
}

export class ChatDocumentAttachmentTooLargeError extends Error {
  constructor() {
    super('Selected document exceeds chat attachment size limits.');
    this.name = 'ChatDocumentAttachmentTooLargeError';
    Object.setPrototypeOf(this, ChatDocumentAttachmentTooLargeError.prototype);
  }
}

export function isChatDocumentAttachmentTooLargeError(error: unknown): error is ChatDocumentAttachmentTooLargeError {
  return error instanceof ChatDocumentAttachmentTooLargeError;
}

export class ChatDocumentAttachmentUnsupportedTypeError extends Error {
  constructor() {
    super('Selected document format is unsupported.');
    this.name = 'ChatDocumentAttachmentUnsupportedTypeError';
    Object.setPrototypeOf(this, ChatDocumentAttachmentUnsupportedTypeError.prototype);
  }
}

export function isChatDocumentAttachmentUnsupportedTypeError(
  error: unknown,
): error is ChatDocumentAttachmentUnsupportedTypeError {
  return error instanceof ChatDocumentAttachmentUnsupportedTypeError;
}

export class ChatMediaAttachmentTooLargeError extends Error {
  constructor(kind: 'audio') {
    super(`Selected ${kind} exceeds chat attachment size limits.`);
    this.name = 'ChatMediaAttachmentTooLargeError';
    Object.setPrototypeOf(this, ChatMediaAttachmentTooLargeError.prototype);
  }
}

export function isChatMediaAttachmentTooLargeError(error: unknown): error is ChatMediaAttachmentTooLargeError {
  return error instanceof ChatMediaAttachmentTooLargeError;
}

export class ChatMediaAttachmentUnsupportedTypeError extends Error {
  constructor(kind: 'audio') {
    super(`Selected ${kind} format is unsupported.`);
    this.name = 'ChatMediaAttachmentUnsupportedTypeError';
    Object.setPrototypeOf(this, ChatMediaAttachmentUnsupportedTypeError.prototype);
  }
}

export function isChatMediaAttachmentUnsupportedTypeError(
  error: unknown,
): error is ChatMediaAttachmentUnsupportedTypeError {
  return error instanceof ChatMediaAttachmentUnsupportedTypeError;
}

function createDraftId(now: number, random: number): string {
  const normalizedRandom = Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0));
  const randomSegment = normalizedRandom.toString(36).slice(2, 8).padEnd(6, '0');
  return `draft-${Math.max(0, Math.round(now))}-${randomSegment}`;
}

function getDraftTimestampFromFileName(fileName: string): number | null {
  const match = /^draft-(\d+)-[A-Za-z0-9]+(?:-thumb)?(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?$/u.exec(fileName.trim());
  if (!match) {
    return null;
  }

  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function shouldPreserveRecentDraftFileName(
  fileName: string,
  preserveDraftsCreatedAtOrAfter: number | undefined,
  now: number,
  futureGraceMs = RECENT_DRAFT_FUTURE_GRACE_MS,
): boolean {
  if (
    preserveDraftsCreatedAtOrAfter === undefined
    || !Number.isFinite(preserveDraftsCreatedAtOrAfter)
    || !Number.isFinite(now)
  ) {
    return false;
  }

  const cutoff = Math.max(0, Math.round(preserveDraftsCreatedAtOrAfter));
  const preserveThrough = Math.max(cutoff, Math.round(now) + Math.max(0, Math.round(futureGraceMs)));
  const draftTimestamp = getDraftTimestampFromFileName(fileName);
  return draftTimestamp !== null
    && draftTimestamp >= cutoff
    && draftTimestamp <= preserveThrough;
}

function createEmptyDirectoryReconciliationResult(): ChatAttachmentDirectoryReconciliationResult {
  return {
    deletedCount: 0,
    attemptedDeleteCount: 0,
    candidateCount: 0,
    hasMoreCandidates: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function resolveDraftFileName(draft: AttachmentDraft): string | null {
  const fileName = readNonEmptyString(draft.fileName);
  if (fileName) {
    return fileName;
  }

  const uriLastSegment = readNonEmptyString(draft.localUri)
    ?.split(/[/?#]/u)
    .filter(Boolean)
    .at(-1);
  return readNonEmptyString(uriLastSegment);
}

function resolveDraftThumbnailFileName(draft: AttachmentDraft): string | null {
  const fileName = readNonEmptyString(draft.thumbnailFileName);
  if (fileName) {
    return fileName;
  }

  const uriLastSegment = readNonEmptyString(draft.thumbnailUri)
    ?.split(/[/?#]/u)
    .filter(Boolean)
    .at(-1);
  return readNonEmptyString(uriLastSegment);
}

export function materializeAttachmentDraftsForMessage({
  threadId,
  messageId,
  drafts,
  now = Date.now,
}: MaterializeAttachmentDraftsOptions): ChatImageAttachment[] {
  const createdAt = now();

  return drafts.map((draft, index) => {
    const id = readNonEmptyString(draft.id);
    const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
    const fileName = resolveDraftFileName(draft);
    const size = normalizePositiveInteger(draft.size);

    if (
      draft.copyStatus !== 'copied'
      || !id
      || !localUri
      || draft.pathCategory !== CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY
      || !fileName
      || !size
      || !isSupportedChatImageDraftFormat({ ...draft, fileName })
      || !validateChatImageAttachmentBounds(draft).ok
    ) {
      throw new Error(`Image attachment draft at index ${index} is not ready to send.`);
    }

    const thumbnailUri = normalizeChatAttachmentLocalUri(draft.thumbnailUri);
    const thumbnailFileName = thumbnailUri ? resolveDraftThumbnailFileName(draft) : null;

    return {
      id,
      threadId,
      messageId,
      localUri,
      ...(thumbnailUri ? { thumbnailUri } : null),
      pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
      ...(draft.mediaType ? { mediaType: draft.mediaType } : null),
      fileName,
      ...(thumbnailUri && thumbnailFileName ? { thumbnailFileName } : null),
      size,
      ...(normalizePositiveInteger(draft.width) ? { width: normalizePositiveInteger(draft.width) } : null),
      ...(normalizePositiveInteger(draft.height) ? { height: normalizePositiveInteger(draft.height) } : null),
      source: 'photo_library',
      createdAt,
    };
  });
}

export function collectReferencedChatAttachmentLocalUrisFromThreads(
  threads: Record<string, ChatThread> | readonly ChatThread[],
): Set<string> {
  const values: readonly ChatThread[] = Array.isArray(threads) ? threads : Object.values(threads);
  const localUris = new Set<string>();

  values.forEach((thread) => {
    thread.messages.forEach((message) => {
      message.attachments?.forEach((attachment) => {
        const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
        if (localUri) {
          localUris.add(localUri);
        }

        const thumbnailUri = normalizeChatAttachmentLocalUri(
          'thumbnailUri' in attachment ? attachment.thumbnailUri : undefined,
        );
        if (thumbnailUri) {
          localUris.add(thumbnailUri);
        }

        if ('image' in attachment) {
          const genericThumbnailUri = normalizeChatAttachmentLocalUri(attachment.image?.thumbnailUri);
          if (genericThumbnailUri) {
            localUris.add(genericThumbnailUri);
          }
        }
      });
    });
  });

  return localUris;
}

export function collectChatAttachmentLocalUrisFromUnknownThreadRecord(value: unknown): Set<string> {
  const record = isRecord(value) && isRecord(value.thread) ? value.thread : value;
  const localUris = new Set<string>();

  if (!isRecord(record) || !Array.isArray(record.messages)) {
    return localUris;
  }

  record.messages.forEach((message) => {
    if (!isRecord(message) || !Array.isArray(message.attachments)) {
      return;
    }

    message.attachments.forEach((attachment) => {
      if (!isRecord(attachment)) {
        return;
      }

      const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
      if (localUri) {
        localUris.add(localUri);
      }

      const thumbnailUri = normalizeChatAttachmentLocalUri(
        'thumbnailUri' in attachment ? attachment.thumbnailUri : undefined,
      );
      if (thumbnailUri) {
        localUris.add(thumbnailUri);
      }

      const image = isRecord(attachment.image) ? attachment.image : null;
      const genericThumbnailUri = normalizeChatAttachmentLocalUri(image?.thumbnailUri);
      if (genericThumbnailUri) {
        localUris.add(genericThumbnailUri);
      }
    });
  });

  return localUris;
}

function getSanitizedErrorDetails(error: unknown): { errorName: string } | { errorType: string } {
  return error instanceof Error
    ? { errorName: error.name || 'Error' }
    : { errorType: typeof error };
}

function createUnknownCopiedFileSizeError(): Error {
  return new Error('Copied chat attachment file size is unknown.');
}

function createPrivateStorageResetAttachmentCleanupError(reason: string): Error {
  return new Error(`Chat attachment cleanup failed during private storage reset (${reason}).`);
}

function resolvePrivateStorageResetChildUri(directory: string, fileName: string): string | null {
  if (
    fileName.length === 0
    || fileName === '.'
    || fileName === '..'
    || fileName.includes('/')
    || fileName.includes('\\')
  ) {
    return null;
  }

  return `${directory}${encodeURIComponent(fileName)}`;
}

function collectNormalizedChatAttachmentLocalUris(localUris: Iterable<string>): Set<string> {
  const normalized = new Set<string>();

  for (const localUri of localUris) {
    const normalizedLocalUri = normalizeChatAttachmentLocalUri(localUri);
    if (normalizedLocalUri) {
      normalized.add(normalizedLocalUri);
    }
  }

  return normalized;
}

function hasReferencedChatAttachmentDescendant(referenced: ReadonlySet<string>, localUri: string): boolean {
  const directoryPrefix = localUri.endsWith('/') ? localUri : `${localUri}/`;
  for (const referencedUri of referenced) {
    if (referencedUri.startsWith(directoryPrefix)) {
      return true;
    }
  }

  return false;
}

function assertChatImageAttachmentBounds(
  image: Pick<AttachmentDraft, 'size' | 'width' | 'height'>,
  options?: Parameters<typeof validateChatImageAttachmentBounds>[1],
): void {
  const bounds = validateChatImageAttachmentBounds(image, options);
  if (!bounds.ok) {
    throw new ChatImageAttachmentTooLargeError();
  }
}

function resolveThumbnailResize(
  image: Pick<AttachmentDraft, 'width' | 'height'>,
): { width?: number; height?: number } {
  const width = normalizePositiveInteger(image.width);
  const height = normalizePositiveInteger(image.height);
  const maxSide = CHAT_IMAGE_ATTACHMENT_THUMBNAIL_MAX_SIDE_PIXELS;

  if (width && height) {
    return width >= height
      ? { width: Math.min(width, maxSide) }
      : { height: Math.min(height, maxSide) };
  }

  if (width) {
    return { width: Math.min(width, maxSide) };
  }

  if (height) {
    return { height: Math.min(height, maxSide) };
  }

  return { width: maxSide, height: maxSide };
}

function assertThumbnailResultBounds(
  thumbnail: Awaited<ReturnType<typeof manipulateAsync>>,
): void {
  const width = normalizePositiveInteger(thumbnail.width);
  const height = normalizePositiveInteger(thumbnail.height);
  const maxSide = CHAT_IMAGE_ATTACHMENT_THUMBNAIL_MAX_SIDE_PIXELS;

  if (!width || !height || width > maxSide || height > maxSide) {
    throw new ChatImageAttachmentTooLargeError();
  }
}

function getThumbnailSaveFormat(extension: SupportedChatImageExtension): SaveFormat {
  return extension === 'png' ? SaveFormat.PNG : SaveFormat.JPEG;
}

export function buildFailedAttachmentDraft(
  asset: Pick<CopyableImageAsset, 'uri' | 'mimeType' | 'width' | 'height' | 'fileSize'>,
  reason: string,
): AttachmentDraft {
  return {
    pickerUri: asset.uri,
    previewUri: asset.uri,
    ...(asset.mimeType ? { mediaType: asset.mimeType } : null),
    ...(normalizePositiveInteger(asset.fileSize) ? { size: normalizePositiveInteger(asset.fileSize) } : null),
    ...(normalizePositiveInteger(asset.width) ? { width: normalizePositiveInteger(asset.width) } : null),
    ...(normalizePositiveInteger(asset.height) ? { height: normalizePositiveInteger(asset.height) } : null),
    copyStatus: 'failed',
    errorReason: reason,
  };
}

export function buildFailedDocumentAttachmentDraft(
  asset: Pick<CopyableDocumentAsset, 'uri' | 'name' | 'mimeType' | 'size'>,
  reason: NonNullable<ChatDocumentAttachmentDraft['errorReason']>,
): ChatDocumentAttachmentDraft {
  return {
    pickerUri: asset.uri,
    displayName: readNonEmptyString(asset.name) ?? undefined,
    fileName: readNonEmptyString(asset.name) ?? undefined,
    ...(asset.mimeType ? { mimeType: asset.mimeType } : null),
    ...(normalizePositiveInteger(asset.size) ? { sizeBytes: normalizePositiveInteger(asset.size) } : null),
    copyStatus: 'failed',
    errorReason: reason,
  };
}

export function buildFailedMediaAttachmentDraft(
  kind: 'audio',
  asset: Pick<CopyableDocumentAsset, 'uri' | 'name' | 'mimeType' | 'size'>,
  reason: NonNullable<ChatMediaAttachmentDraft['errorReason']>,
): ChatMediaAttachmentDraft {
  const displayName = readNonEmptyString(asset.name);
  const sizeBytes = normalizePositiveInteger(asset.size);

  return {
    kind,
    pickerUri: asset.uri,
    ...(displayName ? { displayName, fileName: displayName } : null),
    ...(asset.mimeType ? { mimeType: asset.mimeType } : null),
    ...(sizeBytes ? { sizeBytes } : null),
    copyStatus: 'failed',
    errorReason: reason,
  };
}

export function materializeDocumentDraftsForProcessing({
  threadId,
  messageId,
  drafts,
  now = Date.now,
}: {
  threadId: string;
  messageId: string;
  drafts: readonly ChatDocumentAttachmentDraft[];
  now?: () => number;
}): Extract<ChatAttachment, { kind: 'document' }>[] {
  const createdAt = now();

  return drafts.map((draft, index) => {
    const id = readNonEmptyString(draft.id);
    const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
    const fileName = readNonEmptyString(draft.fileName);
    const sizeBytes = normalizePositiveInteger(draft.sizeBytes);
    const mimeType = resolveChatProcessableDocumentMimeType({
      mimeType: draft.mimeType,
      fileName: draft.fileName,
      localUri: draft.localUri,
    });

    if (
      draft.copyStatus !== 'copied'
      || !id
      || !localUri
      || draft.pathCategory !== CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY
      || !fileName
      || !sizeBytes
      || !mimeType
      || !isSupportedChatDocumentDraftFormat(draft)
    ) {
      throw new Error(`Document attachment draft at index ${index} is not ready to send.`);
    }

    return {
      id,
      kind: 'document',
      state: 'processing',
      threadId,
      messageId,
      localUri,
      pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
      fileName,
      mimeType,
      sizeBytes,
      source: 'document_picker',
      createdAt: draft.createdAt ?? createdAt,
      document: {
        processorId: 'pending',
        processorVersion: 1,
      },
    };
  });
}

export function materializeMediaDraftsForMessage({
  threadId,
  messageId,
  drafts,
  now = Date.now,
}: {
  threadId: string;
  messageId: string;
  drafts: readonly ChatMediaAttachmentDraft[];
  now?: () => number;
}): ChatAttachment[] {
  const createdAt = now();
  const attachments: ChatAttachment[] = [];

  drafts.forEach((draft, index) => {
    const id = readNonEmptyString(draft.id);
    const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
    const fileName = readNonEmptyString(draft.fileName);
    const sizeBytes = normalizePositiveInteger(draft.sizeBytes);
    const mimeType = readNonEmptyString(draft.mimeType);
    if (
      draft.copyStatus !== 'copied'
      || !id
      || !localUri
      || draft.pathCategory !== CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY
      || !fileName
      || !sizeBytes
      || !mimeType
    ) {
      throw new Error(`Media attachment draft at index ${index} is not ready to send.`);
    }

    if (draft.kind === 'audio') {
      const format = draft.audio?.format
        ?? resolveChatAudioFormatFromMimeType(mimeType)
        ?? resolveChatAudioFormatFromPath(fileName);
      if (!format) {
        throw new Error(`Audio attachment draft at index ${index} is not ready to send.`);
      }

      attachments.push({
        id,
        kind: 'audio',
        state: 'ready',
        threadId,
        messageId,
        localUri,
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        fileName,
        mimeType,
        sizeBytes,
        source: 'document_picker',
        createdAt: draft.createdAt ?? createdAt,
        audio: {
          format,
          ...(normalizePositiveInteger(draft.audio?.durationMs) ? { durationMs: normalizePositiveInteger(draft.audio?.durationMs) } : null),
        },
      });
      return;
    }

    throw new Error(`Media attachment draft at index ${index} is not ready to send.`);
  });

  return attachments;
}

export class ChatAttachmentStorageService {
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: ChatAttachmentStorageServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  private async ensureBaseDirectory(): Promise<string> {
    const directory = getChatAttachmentsDir();
    if (!directory) {
      throw new Error('Document storage is unavailable for chat attachments.');
    }

    const info = await FileSystem.getInfoAsync(directory);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    }

    return directory;
  }

  private async deleteLocalUriQuietly(localUri: string, context: string): Promise<void> {
    try {
      await FileSystem.deleteAsync(localUri, { idempotent: true });
    } catch (cleanupError) {
      console.warn('[ChatAttachmentStorage] Failed to delete chat attachment file', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context,
        ...getSanitizedErrorDetails(cleanupError),
      });
    }
  }

  private async createThumbnailForCopiedImage({
    localUri,
    thumbnailUri,
    extension,
    width,
    height,
  }: {
    localUri: string;
    thumbnailUri: string;
    extension: SupportedChatImageExtension;
    width?: number;
    height?: number;
  }): Promise<void> {
    let generatedThumbnailUri: string | null = null;
    try {
      const thumbnail = await manipulateAsync(
        localUri,
        [{ resize: resolveThumbnailResize({ width, height }) }],
        {
          compress: CHAT_IMAGE_ATTACHMENT_THUMBNAIL_JPEG_QUALITY,
          format: getThumbnailSaveFormat(extension),
        },
      );
      generatedThumbnailUri = thumbnail.uri;
      assertThumbnailResultBounds(thumbnail);
      await FileSystem.moveAsync({ from: generatedThumbnailUri, to: thumbnailUri });
      generatedThumbnailUri = null;
    } finally {
      if (generatedThumbnailUri && generatedThumbnailUri !== thumbnailUri) {
        await this.deleteLocalUriQuietly(generatedThumbnailUri, 'thumbnail_temp_cleanup');
      }
    }
  }

  public async copyImageAssetToDraft(asset: CopyableImageAsset): Promise<AttachmentDraft> {
    const sourceUri = asset.uri.trim();
    if (!sourceUri) {
      throw new Error('Selected image URI is empty.');
    }

    if (asset.type && asset.type !== 'image') {
      throw new Error('Selected media is not a still image.');
    }

    const extension = resolveSupportedExtension(asset);
    if (!extension) {
      throw new Error('Selected image format is unsupported.');
    }

    assertChatImageAttachmentBounds({
      ...(normalizePositiveInteger(asset.fileSize) ? { size: normalizePositiveInteger(asset.fileSize) } : null),
      ...(normalizePositiveInteger(asset.width) ? { width: normalizePositiveInteger(asset.width) } : null),
      ...(normalizePositiveInteger(asset.height) ? { height: normalizePositiveInteger(asset.height) } : null),
    });

    const directory = await this.ensureBaseDirectory();
    const draftId = createDraftId(this.now(), this.random());
    const fileName = `${draftId}.${extension}`;
    const thumbnailFileName = `${draftId}-thumb.${extension}`;
    const localUri = `${directory}${fileName}`;
    const thumbnailUri = `${directory}${thumbnailFileName}`;

    try {
      await FileSystem.copyAsync({ from: sourceUri, to: localUri });
    } catch (error) {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
      } catch (cleanupError) {
        console.warn('[ChatAttachmentStorage] Failed to delete partial copied chat attachment', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'partial_copy_cleanup',
          ...getSanitizedErrorDetails(cleanupError),
        });
      }

      throw error;
    }

    let copiedInfo: Awaited<ReturnType<typeof FileSystem.getInfoAsync>>;
    try {
      copiedInfo = await FileSystem.getInfoAsync(localUri);
    } catch (error) {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
      } catch (cleanupError) {
        console.warn('[ChatAttachmentStorage] Failed to delete unknown-size copied chat attachment', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'unknown_size_copy_cleanup',
          ...getSanitizedErrorDetails(cleanupError),
        });
      }

      console.warn('[ChatAttachmentStorage] Failed to inspect copied chat attachment', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'copied_file_size_inspection',
        ...getSanitizedErrorDetails(error),
      });
      throw createUnknownCopiedFileSizeError();
    }
    const copiedSize = copiedInfo.exists ? normalizePositiveInteger(copiedInfo.size) : undefined;
    if (!copiedSize) {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
      } catch (cleanupError) {
        console.warn('[ChatAttachmentStorage] Failed to delete unknown-size copied chat attachment', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'unknown_size_copy_cleanup',
          ...getSanitizedErrorDetails(cleanupError),
        });
      }

      throw createUnknownCopiedFileSizeError();
    }

    const fallbackSize = normalizePositiveInteger(asset.fileSize);

    try {
      assertChatImageAttachmentBounds({ ...(copiedSize ? { size: copiedSize } : null) }, {
        requireDimensions: false,
      });
    } catch (error) {
      if (isChatImageAttachmentTooLargeError(error)) {
        try {
          await FileSystem.deleteAsync(localUri, { idempotent: true });
        } catch (cleanupError) {
          console.warn('[ChatAttachmentStorage] Failed to delete oversized copied chat attachment', {
            pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
            context: 'oversized_copy_cleanup',
            ...getSanitizedErrorDetails(cleanupError),
          });
        }
      }

      throw error;
    }

    let thumbnailCreated = false;
    try {
      await this.createThumbnailForCopiedImage({
        localUri,
        thumbnailUri,
        extension,
        ...(normalizePositiveInteger(asset.width) ? { width: normalizePositiveInteger(asset.width) } : null),
        ...(normalizePositiveInteger(asset.height) ? { height: normalizePositiveInteger(asset.height) } : null),
      });
      thumbnailCreated = true;
    } catch (error) {
      console.warn('[ChatAttachmentStorage] Failed to create chat attachment thumbnail', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'thumbnail_generation_failed',
        ...getSanitizedErrorDetails(error),
      });
      await this.deleteLocalUriQuietly(thumbnailUri, 'thumbnail_generation_output_cleanup');
    }

    return {
      id: draftId,
      pickerUri: sourceUri,
      previewUri: thumbnailCreated ? thumbnailUri : localUri,
      localUri,
      pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
      ...(thumbnailCreated ? { thumbnailUri } : null),
      ...(asset.mimeType ? { mediaType: asset.mimeType } : null),
      fileName,
      ...(thumbnailCreated ? { thumbnailFileName } : null),
      ...(copiedSize ?? fallbackSize ? { size: copiedSize ?? fallbackSize } : null),
      ...(normalizePositiveInteger(asset.width) ? { width: normalizePositiveInteger(asset.width) } : null),
      ...(normalizePositiveInteger(asset.height) ? { height: normalizePositiveInteger(asset.height) } : null),
      copyStatus: 'copied',
    };
  }

  public async discardDraft(draft: AttachmentDraft): Promise<void> {
    const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
    const thumbnailUri = normalizeChatAttachmentLocalUri(draft.thumbnailUri);
    if (draft.copyStatus !== 'copied' || (!localUri && !thumbnailUri)) {
      return;
    }

    await Promise.all(Array.from(new Set([localUri, thumbnailUri].filter((uri): uri is string => Boolean(uri))))
      .map((uri) => FileSystem.deleteAsync(uri, { idempotent: true })));
  }

  public async copyDocumentAssetToDraft(asset: CopyableDocumentAsset): Promise<ChatDocumentAttachmentDraft> {
    const sourceUri = asset.uri.trim();
    if (!sourceUri) {
      throw new Error('Selected document URI is empty.');
    }

    const copyFormat = resolveDocumentCopyFormat(asset);
    if (!copyFormat) {
      throw new ChatDocumentAttachmentUnsupportedTypeError();
    }

    const assetSize = normalizePositiveInteger(asset.size);
    const maxBytes = resolveDocumentMaxBytes(copyFormat.mimeType);
    if (assetSize && assetSize > maxBytes) {
      throw new ChatDocumentAttachmentTooLargeError();
    }

    const directory = await this.ensureBaseDirectory();
    const draftId = createDraftId(this.now(), this.random());
    const fileName = `${draftId}.${copyFormat.extension}`;
    const localUri = `${directory}${fileName}`;

    try {
      await FileSystem.copyAsync({ from: sourceUri, to: localUri });
    } catch (error) {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
      } catch (cleanupError) {
        console.warn('[ChatAttachmentStorage] Failed to delete partial copied document attachment', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'partial_document_copy_cleanup',
          ...getSanitizedErrorDetails(cleanupError),
        });
      }

      throw error;
    }

    let copiedInfo: Awaited<ReturnType<typeof FileSystem.getInfoAsync>>;
    try {
      copiedInfo = await FileSystem.getInfoAsync(localUri);
    } catch (error) {
      await this.deleteLocalUriQuietly(localUri, 'unknown_size_document_copy_cleanup');
      console.warn('[ChatAttachmentStorage] Failed to inspect copied document attachment', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'copied_document_file_size_inspection',
        ...getSanitizedErrorDetails(error),
      });
      throw new Error('Copied chat document file size is unknown.');
    }

    const copiedSize = copiedInfo.exists ? normalizePositiveInteger(copiedInfo.size) : undefined;
    if (!copiedSize) {
      await this.deleteLocalUriQuietly(localUri, 'unknown_size_document_copy_cleanup');
      throw new Error('Copied chat document file size is unknown.');
    }

    if (copiedSize > maxBytes) {
      await this.deleteLocalUriQuietly(localUri, 'oversized_document_copy_cleanup');
      throw new ChatDocumentAttachmentTooLargeError();
    }

    return {
      id: draftId,
      pickerUri: sourceUri,
      localUri,
      pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
      fileName,
      displayName: readNonEmptyString(asset.name) ?? fileName,
      mimeType: copyFormat.mimeType,
      sizeBytes: copiedSize,
      source: 'document_picker',
      createdAt: this.now(),
      copyStatus: 'copied',
    };
  }

  public async copyAudioAssetToDraft(asset: CopyableDocumentAsset): Promise<ChatMediaAttachmentDraft> {
    const sourceUri = asset.uri.trim();
    if (!sourceUri) {
      throw new Error('Selected audio URI is empty.');
    }

    const copyFormat = resolveAudioCopyFormat(asset);
    if (!copyFormat) {
      throw new ChatMediaAttachmentUnsupportedTypeError('audio');
    }

    const assetSize = normalizePositiveInteger(asset.size);
    if (assetSize && assetSize > MAX_CHAT_AUDIO_ATTACHMENT_BYTES) {
      throw new ChatMediaAttachmentTooLargeError('audio');
    }

    const directory = await this.ensureBaseDirectory();
    const draftId = createDraftId(this.now(), this.random());
    const fileName = `${draftId}.${copyFormat.extension}`;
    const localUri = `${directory}${fileName}`;

    try {
      await FileSystem.copyAsync({ from: sourceUri, to: localUri });
    } catch (error) {
      await this.deleteLocalUriQuietly(localUri, 'partial_audio_copy_cleanup');
      throw error;
    }

    let copiedInfo: Awaited<ReturnType<typeof FileSystem.getInfoAsync>>;
    try {
      copiedInfo = await FileSystem.getInfoAsync(localUri);
    } catch (error) {
      await this.deleteLocalUriQuietly(localUri, 'unknown_size_audio_copy_cleanup');
      console.warn('[ChatAttachmentStorage] Failed to inspect copied audio attachment', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'copied_audio_file_size_inspection',
        ...getSanitizedErrorDetails(error),
      });
      throw new Error('Copied chat audio file size is unknown.');
    }

    const copiedSize = copiedInfo.exists ? normalizePositiveInteger(copiedInfo.size) : undefined;
    if (!copiedSize) {
      await this.deleteLocalUriQuietly(localUri, 'unknown_size_audio_copy_cleanup');
      throw new Error('Copied chat audio file size is unknown.');
    }

    if (copiedSize > MAX_CHAT_AUDIO_ATTACHMENT_BYTES) {
      await this.deleteLocalUriQuietly(localUri, 'oversized_audio_copy_cleanup');
      throw new ChatMediaAttachmentTooLargeError('audio');
    }

    return {
      id: draftId,
      kind: 'audio',
      pickerUri: sourceUri,
      localUri,
      pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
      fileName,
      displayName: readNonEmptyString(asset.name) ?? fileName,
      mimeType: copyFormat.mimeType,
      sizeBytes: copiedSize,
      source: 'document_picker',
      createdAt: this.now(),
      copyStatus: 'copied',
      audio: {
        format: copyFormat.format,
      },
    };
  }

  public async discardDrafts(drafts: readonly AttachmentDraft[]): Promise<void> {
    await Promise.all(drafts.map((draft) => this.discardDraft(draft)));
  }

  public async discardDocumentDraft(draft: ChatDocumentAttachmentDraft): Promise<void> {
    const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
    if (draft.copyStatus !== 'copied' || !localUri) {
      return;
    }

    await FileSystem.deleteAsync(localUri, { idempotent: true });
  }

  public async discardDocumentDrafts(drafts: readonly ChatDocumentAttachmentDraft[]): Promise<void> {
    await Promise.all(drafts.map((draft) => this.discardDocumentDraft(draft)));
  }

  public async discardMediaDraft(draft: ChatMediaAttachmentDraft): Promise<void> {
    const localUri = normalizeChatAttachmentLocalUri(draft.localUri);

    if (draft.copyStatus !== 'copied' || !localUri) {
      return;
    }

    await FileSystem.deleteAsync(localUri, { idempotent: true });
  }

  public async discardMediaDrafts(drafts: readonly ChatMediaAttachmentDraft[]): Promise<void> {
    await Promise.all(drafts.map((draft) => this.discardMediaDraft(draft)));
  }

  public async deleteAllAttachmentFilesForPrivateStorageReset(): Promise<void> {
    const directory = getChatAttachmentsDir();
    if (!directory) {
      return;
    }

    try {
      const directoryInfo = await FileSystem.getInfoAsync(directory);
      if (!directoryInfo.exists) {
        return;
      }
    } catch (error) {
      console.warn('[ChatAttachmentStorage] Failed to inspect chat attachment storage before private reset', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'private_storage_reset_inspection',
        ...getSanitizedErrorDetails(error),
      });
      throw createPrivateStorageResetAttachmentCleanupError('inspection_failed');
    }

    let fileNames: string[];
    try {
      fileNames = await FileSystem.readDirectoryAsync(directory);
    } catch (error) {
      console.warn('[ChatAttachmentStorage] Failed to delete chat attachment storage after private reset', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'private_storage_reset_enumeration',
        ...getSanitizedErrorDetails(error),
      });
      throw createPrivateStorageResetAttachmentCleanupError('enumeration_failed');
    }

    const candidates: string[] = [];
    let rejectedChildNameCount = 0;

    for (const fileName of fileNames) {
      const localUri = resolvePrivateStorageResetChildUri(directory, fileName);
      if (localUri) {
        candidates.push(localUri);
      } else {
        rejectedChildNameCount += 1;
      }
    }

    const uniqueCandidates = Array.from(new Set(candidates));

    let failedDeleteCount = 0;
    let firstDeleteErrorDetails: ReturnType<typeof getSanitizedErrorDetails> | null = null;
    for (const localUri of uniqueCandidates) {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
      } catch (error) {
        failedDeleteCount += 1;
        firstDeleteErrorDetails ??= getSanitizedErrorDetails(error);
      }
    }

    if (failedDeleteCount > 0) {
      console.warn('[ChatAttachmentStorage] Failed to delete chat attachment during private reset', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'private_storage_reset_child_delete',
        failedCount: failedDeleteCount,
        ...(firstDeleteErrorDetails ?? {}),
      });
    }

    if (rejectedChildNameCount > 0) {
      console.warn('[ChatAttachmentStorage] Refusing unsafe chat attachment child during private reset', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'private_storage_reset_child_name_rejected',
        rejectedCount: rejectedChildNameCount,
      });
    }

    if (failedDeleteCount > 0) {
      throw createPrivateStorageResetAttachmentCleanupError('child_delete_failed');
    }

    if (rejectedChildNameCount > 0) {
      throw createPrivateStorageResetAttachmentCleanupError('child_name_rejected');
    }
  }

  public async deleteUnreferencedAttachmentFiles({
    candidateLocalUris,
    referencedLocalUris = new Set<string>(),
    maxDeletes,
  }: {
    candidateLocalUris: Iterable<string>;
    referencedLocalUris?: Iterable<string>;
    maxDeletes?: number;
  }): Promise<number> {
    const referenced = collectNormalizedChatAttachmentLocalUris(referencedLocalUris);
    const deleteLimit = normalizePositiveInteger(maxDeletes);
    const candidates = Array.from(new Set(candidateLocalUris))
      .flatMap((candidateLocalUri) => {
        const localUri = normalizeChatAttachmentLocalUri(candidateLocalUri);
        return localUri && !referenced.has(localUri) ? [localUri] : [];
      });
    const boundedCandidates = deleteLimit === undefined
      ? candidates
      : candidates.slice(0, deleteLimit);

    if (boundedCandidates.length === 0) {
      return 0;
    }

    let deletedCount = 0;
    for (const localUri of boundedCandidates) {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
        deletedCount += 1;
      } catch (error) {
        console.warn('[ChatAttachmentStorage] Failed to delete unreferenced chat attachment', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'unreferenced_cleanup',
          ...getSanitizedErrorDetails(error),
        });
      }
    }

    return deletedCount;
  }

  public async reconcileAttachmentDirectory(
    referencedLocalUris: Iterable<string> = [],
    options: {
      preserveDraftsCreatedAtOrAfter?: number;
      maxCandidates?: number;
      maxDeletes?: number;
    } = {},
  ): Promise<ChatAttachmentDirectoryReconciliationResult> {
    const directory = getChatAttachmentsDir();
    if (!directory) {
      return createEmptyDirectoryReconciliationResult();
    }

    let fileNames: string[];
    try {
      fileNames = await FileSystem.readDirectoryAsync(directory);
    } catch (error) {
      console.warn('[ChatAttachmentStorage] Failed to enumerate chat attachment storage', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'attachment_directory_reconciliation',
        ...getSanitizedErrorDetails(error),
      });
      return createEmptyDirectoryReconciliationResult();
    }

    const referenced = collectNormalizedChatAttachmentLocalUris(referencedLocalUris);
    const candidateLimit = normalizePositiveInteger(options.maxCandidates);
    const candidateScanLimit = candidateLimit === undefined ? undefined : candidateLimit + 1;
    const candidateLocalUris: string[] = [];
    const seenCandidateLocalUris = new Set<string>();
    let candidateCount = 0;
    const preserveDraftsThroughNow = this.now();

    for (const fileName of fileNames) {
      if (shouldPreserveRecentDraftFileName(
        fileName,
        options.preserveDraftsCreatedAtOrAfter,
        preserveDraftsThroughNow,
      )) {
        continue;
      }

      const localUri = normalizeChatAttachmentLocalUri(`${directory}${fileName}`);
      if (!localUri || referenced.has(localUri) || hasReferencedChatAttachmentDescendant(referenced, localUri)) {
        continue;
      }

      let candidateInfo: FileSystem.FileInfo;
      try {
        candidateInfo = await FileSystem.getInfoAsync(localUri);
      } catch (error) {
        console.warn('[ChatAttachmentStorage] Failed to inspect chat attachment cleanup candidate', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'attachment_directory_reconciliation_candidate',
          ...getSanitizedErrorDetails(error),
        });
        continue;
      }
      if (candidateInfo.exists && (candidateInfo as { isDirectory?: boolean }).isDirectory === true) {
        continue;
      }
      if (seenCandidateLocalUris.has(localUri)) {
        continue;
      }

      seenCandidateLocalUris.add(localUri);
      candidateCount += 1;
      if (candidateLimit === undefined || candidateLocalUris.length < candidateLimit) {
        candidateLocalUris.push(localUri);
      }
      if (candidateScanLimit !== undefined && candidateCount >= candidateScanLimit) {
        break;
      }
    }

    const deleteLimit = normalizePositiveInteger(options.maxDeletes);
    const deleteLocalUris = deleteLimit === undefined
      ? candidateLocalUris
      : candidateLocalUris.slice(0, deleteLimit);
    let deletedCount = 0;
    let attemptedDeleteCount = 0;

    for (const localUri of deleteLocalUris) {
      attemptedDeleteCount += 1;
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
        deletedCount += 1;
      } catch (error) {
        console.warn('[ChatAttachmentStorage] Failed to delete unreferenced chat attachment', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'unreferenced_cleanup',
          ...getSanitizedErrorDetails(error),
        });
      }
    }

    return {
      deletedCount,
      attemptedDeleteCount,
      candidateCount,
      hasMoreCandidates:
        (candidateLimit !== undefined && candidateCount > candidateLocalUris.length)
        || deleteLocalUris.length < candidateLocalUris.length,
    };
  }

  public async deleteUnreferencedAttachmentFilesForThreads({
    previousThreads,
    nextThreads,
  }: {
    previousThreads: Record<string, ChatThread>;
    nextThreads: Record<string, ChatThread>;
  }): Promise<number> {
    return this.deleteUnreferencedAttachmentFiles({
      candidateLocalUris: collectReferencedChatAttachmentLocalUrisFromThreads(previousThreads),
      referencedLocalUris: collectReferencedChatAttachmentLocalUrisFromThreads(nextThreads),
    });
  }
}

export const chatAttachmentStorageService = new ChatAttachmentStorageService();
