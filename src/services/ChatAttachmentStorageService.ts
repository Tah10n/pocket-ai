import * as FileSystem from 'expo-file-system/legacy';
import type { ImagePickerAsset } from 'expo-image-picker';
import {
  CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
  type AttachmentDraft,
  type ChatImageAttachment,
} from '@/types/multimodal';
import type { ChatThread } from '@/types/chat';
import {
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

type CopyableImageAsset = Pick<
  ImagePickerAsset,
  'uri' | 'fileName' | 'fileSize' | 'mimeType' | 'width' | 'height' | 'type'
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

function createDraftId(now: number, random: number): string {
  const normalizedRandom = Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0));
  const randomSegment = normalizedRandom.toString(36).slice(2, 8).padEnd(6, '0');
  return `draft-${Math.max(0, Math.round(now))}-${randomSegment}`;
}

function getDraftTimestampFromFileName(fileName: string): number | null {
  const match = /^draft-(\d+)-[A-Za-z0-9]+\.(?:jpe?g|png)$/iu.exec(fileName.trim());
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

    return {
      id,
      threadId,
      messageId,
      localUri,
      pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
      ...(draft.mediaType ? { mediaType: draft.mediaType } : null),
      fileName,
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

function assertChatImageAttachmentBounds(
  image: Pick<AttachmentDraft, 'size' | 'width' | 'height'>,
  options?: Parameters<typeof validateChatImageAttachmentBounds>[1],
): void {
  const bounds = validateChatImageAttachmentBounds(image, options);
  if (!bounds.ok) {
    throw new ChatImageAttachmentTooLargeError();
  }
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
    const localUri = `${directory}${fileName}`;

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

    return {
      id: draftId,
      pickerUri: sourceUri,
      previewUri: localUri,
      localUri,
      pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
      ...(asset.mimeType ? { mediaType: asset.mimeType } : null),
      fileName,
      ...(copiedSize ?? fallbackSize ? { size: copiedSize ?? fallbackSize } : null),
      ...(normalizePositiveInteger(asset.width) ? { width: normalizePositiveInteger(asset.width) } : null),
      ...(normalizePositiveInteger(asset.height) ? { height: normalizePositiveInteger(asset.height) } : null),
      copyStatus: 'copied',
    };
  }

  public async discardDraft(draft: AttachmentDraft): Promise<void> {
    const localUri = normalizeChatAttachmentLocalUri(draft.localUri);
    if (draft.copyStatus !== 'copied' || !localUri) {
      return;
    }

    await FileSystem.deleteAsync(localUri, { idempotent: true });
  }

  public async discardDrafts(drafts: readonly AttachmentDraft[]): Promise<void> {
    await Promise.all(drafts.map((draft) => this.discardDraft(draft)));
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
    const rejectedChildNames: string[] = [];

    for (const fileName of fileNames) {
      const localUri = resolvePrivateStorageResetChildUri(directory, fileName);
      if (localUri) {
        candidates.push(localUri);
      } else {
        rejectedChildNames.push(fileName);
      }
    }

    const uniqueCandidates = Array.from(new Set(candidates));

    const results = await Promise.all(uniqueCandidates.map(async (localUri) => {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
        return true;
      } catch (error) {
        console.warn('[ChatAttachmentStorage] Failed to delete chat attachment during private reset', {
          pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
          context: 'private_storage_reset_child_delete',
          ...getSanitizedErrorDetails(error),
        });
        return false;
      }
    }));

    if (rejectedChildNames.length > 0) {
      console.warn('[ChatAttachmentStorage] Refusing unsafe chat attachment child during private reset', {
        pathCategory: CHAT_IMAGE_ATTACHMENT_PATH_CATEGORY,
        context: 'private_storage_reset_child_name_rejected',
        rejectedCount: rejectedChildNames.length,
      });
    }

    if (results.some((result) => !result)) {
      throw createPrivateStorageResetAttachmentCleanupError('child_delete_failed');
    }

    if (rejectedChildNames.length > 0) {
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
      if (!localUri || referenced.has(localUri)) {
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
