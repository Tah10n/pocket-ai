import * as FileSystem from 'expo-file-system/legacy';
import type { ChatAttachment } from '../types/attachments';
import type { LlmTextContentPart } from '../types/chat';
import { normalizeChatAttachmentLocalUri } from '../utils/chatImageAttachments';
import {
  MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES,
  isSupportedChatProcessableDocumentMimeType,
  resolveChatProcessableDocumentMimeType,
} from '../utils/chatAttachments';
import {
  PdfTextExtractionError,
  extractTextFromPdfBase64,
} from '../utils/pdfTextExtraction';
import { AppError, type AppErrorCode } from './AppError';

export const DOCUMENT_TEXT_PROCESSOR_ID = 'document-text';
export const DOCUMENT_TEXT_PROCESSOR_VERSION = 1;
export const DEFAULT_DOCUMENT_TEXT_MAX_CHARS = 40_000;
export const DEFAULT_DOCUMENT_TEXT_MAX_FILE_BYTES = MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES;

type ChatDocumentAttachment = Extract<ChatAttachment, { kind: 'document' }>;

export type ChatAttachmentProcessorResult = ChatDocumentTextProcessorResult;

export interface ProcessChatDocumentTextOptions {
  maxChars?: number;
  maxFileBytes?: number;
}

export interface ChatDocumentTextProcessorResult {
  attachmentId: string;
  runtimeInput: 'document_text';
  processorId: typeof DOCUMENT_TEXT_PROCESSOR_ID;
  processorVersion: typeof DOCUMENT_TEXT_PROCESSOR_VERSION;
  mimeType: string;
  text: string;
  truncated: boolean;
  extractedCharCount: number;
  sourceCharCount: number;
  contentHash: string;
  pageCount?: number;
  isScanned?: boolean;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function createAttachmentProcessingError(
  code: AppErrorCode,
  message: string,
  options: {
    attachment: Pick<ChatAttachment, 'id' | 'kind' | 'mimeType'>;
    cause?: unknown;
    details?: Record<string, unknown>;
  },
): AppError {
  return new AppError(code, message, {
    cause: options.cause,
    details: {
      attachmentKind: options.attachment.kind,
      attachmentId: options.attachment.id,
      mimeType: options.attachment.mimeType,
      processorId: DOCUMENT_TEXT_PROCESSOR_ID,
      processorVersion: DOCUMENT_TEXT_PROCESSOR_VERSION,
      ...options.details,
    },
  });
}

function resolveTextDocumentMimeType(attachment: ChatDocumentAttachment): string | null {
  const normalizedMimeType = attachment.mimeType.trim().toLowerCase();
  if (isSupportedChatProcessableDocumentMimeType(normalizedMimeType)) {
    return normalizedMimeType;
  }

  return resolveChatProcessableDocumentMimeType(attachment);
}

function assertProcessableDocumentAttachment(
  attachment: ChatAttachment,
): { attachment: ChatDocumentAttachment; localUri: string; mimeType: string } {
  if (attachment.kind !== 'document') {
    throw createAttachmentProcessingError(
      'chat_attachment_unsupported_type',
      'Only document attachments can be processed as document text.',
      { attachment },
    );
  }

  const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
  if (!localUri || attachment.state === 'failed') {
    throw createAttachmentProcessingError(
      'chat_attachment_not_ready',
      'Document attachment must be copied into app storage before processing.',
      {
        attachment,
        details: {
          pathCategory: 'non_chat_attachment',
          state: attachment.state,
        },
      },
    );
  }

  const mimeType = resolveTextDocumentMimeType(attachment);
  if (!mimeType) {
    throw createAttachmentProcessingError(
      'chat_attachment_unsupported_type',
      'Document attachment type is not supported by the local text processor.',
      { attachment },
    );
  }

  return { attachment, localUri, mimeType };
}

function assertTextLooksReadable(text: string, attachment: ChatDocumentAttachment): void {
  if (text.includes('\u0000')) {
    throw createAttachmentProcessingError(
      'chat_attachment_corrupt',
      'Document attachment could not be read as text.',
      {
        attachment,
        details: {
          reason: 'nul_byte',
        },
      },
    );
  }

  const disallowedControls = text.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/gu);
  const controlCount = disallowedControls?.length ?? 0;
  if (controlCount > 0 && controlCount / Math.max(1, text.length) > 0.01) {
    throw createAttachmentProcessingError(
      'chat_attachment_corrupt',
      'Document attachment could not be read as text.',
      {
        attachment,
        details: {
          reason: 'control_character_ratio',
        },
      },
    );
  }
}

function normalizeExtractedText(rawText: string, attachment: ChatDocumentAttachment): string {
  const normalized = rawText.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  assertTextLooksReadable(normalized, attachment);
  return normalized;
}

function normalizeJsonDocument(text: string, attachment: ChatDocumentAttachment): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (error) {
    throw createAttachmentProcessingError(
      'chat_attachment_parse_failed',
      'Document attachment JSON could not be parsed.',
      {
        attachment,
        cause: error,
        details: {
          reason: 'invalid_json',
        },
      },
    );
  }
}

function createPdfProcessingError(
  error: PdfTextExtractionError,
  attachment: ChatDocumentAttachment,
): AppError {
  switch (error.reason) {
    case 'encrypted':
      return createAttachmentProcessingError(
        'chat_attachment_document_encrypted',
        'Encrypted PDF documents cannot be processed locally.',
        {
          attachment,
          cause: error,
          details: {
            reason: error.reason,
          },
        },
      );
    case 'no_extractable_text':
      return createAttachmentProcessingError(
        'chat_attachment_document_no_extractable_text',
        'PDF has no extractable text. If it is scanned, use a vision-capable image workflow or another OCR source.',
        {
          attachment,
          cause: error,
          details: {
            reason: error.reason,
            isScanned: true,
          },
        },
      );
    case 'unsupported_filter':
      return createAttachmentProcessingError(
        'chat_attachment_parse_failed',
        'PDF uses unsupported compression or content filters.',
        {
          attachment,
          cause: error,
          details: {
            reason: error.reason,
          },
        },
      );
    case 'invalid_pdf':
    default:
      return createAttachmentProcessingError(
        'chat_attachment_corrupt',
        'PDF attachment could not be parsed.',
        {
          attachment,
          cause: error,
          details: {
            reason: error.reason,
          },
        },
      );
  }
}

function toBoundedDocumentText(
  text: string,
  options: { maxChars: number },
): { text: string; truncated: boolean; sourceCharCount: number; extractedCharCount: number } {
  const sourceCharCount = text.length;
  const boundedText = sourceCharCount > options.maxChars
    ? text.slice(0, options.maxChars)
    : text;

  return {
    text: boundedText,
    truncated: boundedText.length !== sourceCharCount,
    sourceCharCount,
    extractedCharCount: boundedText.length,
  };
}

function hashDocumentText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function formatDocumentTextPart(result: ChatDocumentTextProcessorResult): string {
  const header = [
    'Document attachment text',
    `MIME type: ${result.mimeType}`,
    result.pageCount ? `Pages: ${result.pageCount}` : null,
    result.truncated
      ? `Excerpt: first ${result.extractedCharCount} of ${result.sourceCharCount} characters`
      : `Characters: ${result.extractedCharCount}`,
  ].filter((entry): entry is string => Boolean(entry)).join('\n');

  return `${header}\n\n${result.text}`;
}

export function buildDocumentAttachmentTextPart(
  result: ChatDocumentTextProcessorResult,
): LlmTextContentPart {
  return {
    type: 'text',
    text: formatDocumentTextPart(result),
  };
}

export function withProcessedDocumentAttachmentMetadata(
  attachment: ChatDocumentAttachment,
  result: ChatDocumentTextProcessorResult,
): ChatDocumentAttachment {
  return {
    ...attachment,
    state: 'ready',
    document: {
      ...attachment.document,
      processorId: result.processorId,
      processorVersion: result.processorVersion,
      contentHash: result.contentHash,
      ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : null),
      extractedCharCount: result.extractedCharCount,
      isScanned: result.isScanned ?? false,
    },
  };
}

export class ChatAttachmentProcessorRegistry {
  public async processAttachment(
    attachment: ChatAttachment,
    options: ProcessChatDocumentTextOptions = {},
  ): Promise<ChatAttachmentProcessorResult> {
    if (attachment.kind === 'document') {
      return this.processDocumentTextAttachment(attachment, options);
    }

    throw createAttachmentProcessingError(
      'chat_attachment_unsupported_type',
      'Attachment type is not supported by the local processor registry.',
      { attachment },
    );
  }

  public async processDocumentTextAttachment(
    attachment: ChatDocumentAttachment,
    options: ProcessChatDocumentTextOptions = {},
  ): Promise<ChatDocumentTextProcessorResult> {
    const processable = assertProcessableDocumentAttachment(attachment);
    const maxChars = normalizePositiveInteger(options.maxChars, DEFAULT_DOCUMENT_TEXT_MAX_CHARS);
    const defaultMaxFileBytes = processable.mimeType === 'application/pdf'
      ? MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES
      : DEFAULT_DOCUMENT_TEXT_MAX_FILE_BYTES;
    const maxFileBytes = normalizePositiveInteger(options.maxFileBytes, defaultMaxFileBytes);

    let info: Awaited<ReturnType<typeof FileSystem.getInfoAsync>>;
    try {
      info = await FileSystem.getInfoAsync(processable.localUri);
    } catch (error) {
      throw createAttachmentProcessingError(
        'chat_attachment_missing',
        'Document attachment file is unavailable.',
        {
          attachment,
          cause: error,
          details: {
            reason: 'stat_failed',
          },
        },
      );
    }

    if (!info.exists || (info as { isDirectory?: boolean }).isDirectory === true) {
      throw createAttachmentProcessingError(
        'chat_attachment_missing',
        'Document attachment file is missing.',
        {
          attachment,
          details: {
            reason: 'missing',
          },
        },
      );
    }

    const sizeBytes = typeof info.size === 'number' && Number.isFinite(info.size) && info.size > 0
      ? info.size
      : attachment.sizeBytes;
    if (sizeBytes > maxFileBytes) {
      throw createAttachmentProcessingError(
        'chat_attachment_too_large_for_context',
        'Document attachment is too large for local text processing.',
        {
          attachment,
          details: {
            maxFileBytes,
            sizeBytes,
          },
        },
      );
    }

    let rawText: string;
    try {
      rawText = processable.mimeType === 'application/pdf'
        ? await FileSystem.readAsStringAsync(processable.localUri, {
            encoding: FileSystem.EncodingType.Base64,
          })
        : await FileSystem.readAsStringAsync(processable.localUri, {
            encoding: FileSystem.EncodingType.UTF8,
          });
    } catch (error) {
      throw createAttachmentProcessingError(
        'chat_attachment_corrupt',
        'Document attachment could not be read as text.',
        {
          attachment,
          cause: error,
          details: {
            reason: 'read_failed',
          },
        },
      );
    }

    let parsedText: string;
    let pageCount: number | undefined;
    let isScanned = false;
    if (processable.mimeType === 'application/pdf') {
      try {
        const pdfResult = extractTextFromPdfBase64(rawText);
        parsedText = pdfResult.text;
        pageCount = pdfResult.pageCount;
        isScanned = pdfResult.isScanned;
      } catch (error) {
        if (error instanceof PdfTextExtractionError) {
          throw createPdfProcessingError(error, attachment);
        }

        throw createAttachmentProcessingError(
          'chat_attachment_parse_failed',
          'PDF attachment could not be parsed.',
          {
            attachment,
            cause: error,
            details: {
              reason: 'pdf_parse_failed',
            },
          },
        );
      }
    } else {
      const normalizedText = normalizeExtractedText(rawText, attachment);
      parsedText = processable.mimeType === 'application/json'
        ? normalizeJsonDocument(normalizedText, attachment)
        : normalizedText;
    }
    const bounded = toBoundedDocumentText(parsedText, { maxChars });

    return {
      attachmentId: attachment.id,
      runtimeInput: 'document_text',
      processorId: DOCUMENT_TEXT_PROCESSOR_ID,
      processorVersion: DOCUMENT_TEXT_PROCESSOR_VERSION,
      mimeType: processable.mimeType,
      contentHash: hashDocumentText(parsedText),
      ...(pageCount !== undefined ? { pageCount } : null),
      isScanned,
      ...bounded,
    };
  }
}

export const chatAttachmentProcessorRegistry = new ChatAttachmentProcessorRegistry();
