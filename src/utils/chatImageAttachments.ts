import * as FileSystem from 'expo-file-system/legacy';
import type { AttachmentDraft, ChatImageAttachment } from '../types/multimodal';

export const MAX_CHAT_IMAGE_ATTACHMENTS = 4;
export const CHAT_ATTACHMENTS_DIR_NAME = 'chat-attachments/';
export const MAX_CHAT_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS = 4096;
export const MAX_CHAT_IMAGE_ATTACHMENT_TOTAL_PIXELS = 16_777_216;

export type SupportedChatImageExtension = 'jpg' | 'png';

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
]);

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const SAFE_CHAT_ATTACHMENT_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

function normalizeKnownPositiveMeasurement(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function resolveBaseDirectory(base: string | null | undefined, suffix: string): string | null {
  if (!base) {
    return null;
  }

  return `${base.replace(/\/?$/, '/')}${suffix}`;
}

export function getChatAttachmentsDir(): string | null {
  return resolveBaseDirectory(FileSystem.documentDirectory ?? null, CHAT_ATTACHMENTS_DIR_NAME);
}

function isSafeChatAttachmentRelativePath(relativePath: string): boolean {
  if (
    relativePath.length === 0
    || relativePath.startsWith('/')
    || relativePath.includes('\\')
    || relativePath.includes('?')
    || relativePath.includes('#')
    || relativePath.includes('%')
  ) {
    return false;
  }

  const segments = relativePath.split('/');
  if (segments.length === 0) {
    return false;
  }

  return segments.every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && SAFE_CHAT_ATTACHMENT_PATH_SEGMENT_PATTERN.test(segment)
  ));
}

export function normalizeChatAttachmentLocalUri(value: unknown): string | null {
  const localUri = typeof value === 'string' ? value.trim() : '';
  const directory = getChatAttachmentsDir();

  if (!directory || localUri.length === 0 || !localUri.startsWith(directory)) {
    return null;
  }

  const relativePath = localUri.slice(directory.length);
  if (!isSafeChatAttachmentRelativePath(relativePath)) {
    return null;
  }

  return localUri;
}

export function isChatAttachmentLocalUri(value: unknown): boolean {
  return normalizeChatAttachmentLocalUri(value) !== null;
}

export function isSupportedChatImageMimeType(mediaType: string | null | undefined): boolean {
  if (!mediaType) {
    return false;
  }

  return SUPPORTED_IMAGE_MIME_TYPES.has(mediaType.trim().toLowerCase());
}

export function resolveSupportedChatImageExtensionFromMimeType(
  mediaType: string | null | undefined,
): SupportedChatImageExtension | null {
  const normalized = mediaType?.trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return 'jpg';
  }

  if (normalized === 'image/png') {
    return 'png';
  }

  return null;
}

export function normalizeSupportedChatImageExtension(
  extension: string | null | undefined,
): SupportedChatImageExtension | null {
  const normalized = extension?.trim().toLowerCase().replace(/^\./u, '');
  if (!normalized || !SUPPORTED_IMAGE_EXTENSIONS.has(normalized)) {
    return null;
  }

  return normalized === 'png' ? 'png' : 'jpg';
}

export function resolveSupportedChatImageExtensionFromPath(
  value: string | null | undefined,
): SupportedChatImageExtension | null {
  if (!value) {
    return null;
  }

  const pathWithoutQuery = value.split(/[?#]/u)[0];
  const candidate = pathWithoutQuery
    .split(/[\\/]/u)
    .filter(Boolean)
    .at(-1)
    ?.split('.')
    .at(-1);

  return normalizeSupportedChatImageExtension(candidate);
}

export function isSupportedChatImageDraftFormat(
  draft: Pick<AttachmentDraft, 'mediaType' | 'fileName' | 'localUri' | 'previewUri' | 'pickerUri'>,
): boolean {
  if (draft.mediaType) {
    return isSupportedChatImageMimeType(draft.mediaType);
  }

  const authoritativePaths = [draft.fileName, draft.localUri]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (authoritativePaths.length > 0) {
    return authoritativePaths.some((value) => Boolean(resolveSupportedChatImageExtensionFromPath(value)));
  }

  return Boolean(
    resolveSupportedChatImageExtensionFromPath(draft.previewUri)
    ?? resolveSupportedChatImageExtensionFromPath(draft.pickerUri),
  );
}

export function getRemainingChatImageAttachmentSlots(currentCount: number): number {
  return Math.max(0, MAX_CHAT_IMAGE_ATTACHMENTS - normalizeNonNegativeInteger(currentCount));
}

export function canAttachChatImages(currentCount: number, incomingCount = 1): boolean {
  return normalizeNonNegativeInteger(incomingCount) <= getRemainingChatImageAttachmentSlots(currentCount);
}

export function validateChatImageAttachmentLimit(
  currentCount: number,
  incomingCount = 1,
): { ok: true; allowedRemaining: number } | { ok: false; reason: 'limit_exceeded'; allowedRemaining: number } {
  const allowedRemaining = getRemainingChatImageAttachmentSlots(currentCount);
  if (normalizeNonNegativeInteger(incomingCount) <= allowedRemaining) {
    return { ok: true, allowedRemaining };
  }

  return { ok: false, reason: 'limit_exceeded', allowedRemaining };
}

export function validateChatImageAttachmentBounds(
  image: Pick<AttachmentDraft, 'size' | 'width' | 'height'>,
  _options: { requireDimensions?: boolean } = {},
): { ok: true } | { ok: false; reason: 'too_large' } {
  const size = normalizeKnownPositiveMeasurement(image.size);
  if (size > MAX_CHAT_IMAGE_ATTACHMENT_BYTES) {
    return { ok: false, reason: 'too_large' };
  }

  const width = normalizeKnownPositiveMeasurement(image.width);
  const height = normalizeKnownPositiveMeasurement(image.height);

  if (width > MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS || height > MAX_CHAT_IMAGE_ATTACHMENT_SIDE_PIXELS) {
    return { ok: false, reason: 'too_large' };
  }

  if (width > 0 && height > 0 && width * height > MAX_CHAT_IMAGE_ATTACHMENT_TOTAL_PIXELS) {
    return { ok: false, reason: 'too_large' };
  }

  return { ok: true };
}

export function hasFailedDraftImageAttachments(drafts: readonly AttachmentDraft[]): boolean {
  return drafts.some((draft) => draft.copyStatus === 'failed');
}

export function getSendableDraftImageAttachments(drafts: readonly AttachmentDraft[]): AttachmentDraft[] {
  return drafts.filter((draft) => (
    draft.copyStatus !== 'failed'
    && draft.copyStatus !== 'discarded'
    && normalizeChatAttachmentLocalUri(draft.localUri) !== null
    && isSupportedChatImageDraftFormat(draft)
    && validateChatImageAttachmentBounds(draft).ok
  ));
}

export function toAttachmentMediaPath(localUri: string): string | null {
  const normalized = localUri.trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized.startsWith('file://') ? normalized.slice('file://'.length) : normalized;
}

export function getChatImageAttachmentMediaPaths(
  attachments: readonly Pick<ChatImageAttachment, 'localUri'>[] | undefined,
): string[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  return attachments.flatMap((attachment) => {
    const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
    const mediaPath = localUri ? toAttachmentMediaPath(localUri) : null;
    return mediaPath ? [mediaPath] : [];
  });
}

export function summarizeChatImageAttachments(
  attachments: readonly Pick<ChatImageAttachment, 'size'>[] | undefined,
): { count: number; totalBytes?: number } {
  if (!attachments || attachments.length === 0) {
    return { count: 0 };
  }

  const totalBytes = attachments.reduce((sum, attachment) => {
    const size = attachment.size;
    return typeof size === 'number' && Number.isFinite(size) && size > 0
      ? sum + Math.round(size)
      : sum;
  }, 0);

  return {
    count: attachments.length,
    ...(totalBytes > 0 ? { totalBytes } : null),
  };
}
