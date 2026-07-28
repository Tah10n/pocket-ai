import type { TFunction } from 'i18next';
import { sanitizeErrorForReport, sanitizeErrorReportContext } from './ErrorReportSanitizer';

export type AppErrorCode =
  | 'action_failed'
  | 'engine_not_ready'
  | 'engine_busy'
  | 'engine_unloading'
  | 'model_not_found'
  | 'model_load_blocked'
  | 'model_load_failed'
  | 'model_incompatible'
  | 'model_memory_insufficient'
  | 'model_memory_warning'
  | 'download_disk_space_low'
  | 'download_size_unknown'
  | 'download_metadata_unavailable'
  | 'download_http_error'
  | 'download_verification_failed'
  | 'download_file_missing'
  | 'storage_private_unavailable'
  | 'message_empty'
  | 'message_too_long'
  | 'multimodal_not_ready'
  | 'chat_attachment_copy_failed'
  | 'chat_attachment_limit_exceeded'
  | 'chat_attachment_missing'
  | 'chat_attachment_not_ready'
  | 'chat_attachment_unsupported_type'
  | 'chat_attachment_corrupt'
  | 'chat_attachment_parse_failed'
  | 'chat_attachment_too_large_for_context'
  | 'chat_attachment_document_encrypted'
  | 'chat_attachment_document_no_extractable_text';

const ERROR_MESSAGE_KEYS: Partial<Record<AppErrorCode, string>> = {
  engine_not_ready: 'common.errors.engineNotReady',
  engine_busy: 'common.errors.engineBusy',
  engine_unloading: 'common.errors.engineUnloading',
  model_not_found: 'common.errors.modelNotFound',
  model_load_blocked: 'models.loadMemoryBlockedMessage',
  model_load_failed: 'common.errors.modelLoadFailed',
  model_incompatible: 'common.errors.modelIncompatible',
  model_memory_insufficient: 'common.errors.modelMemoryInsufficient',
  model_memory_warning: 'common.errors.modelMemoryWarning',
  download_disk_space_low: 'common.errors.downloadDiskSpaceLow',
  download_size_unknown: 'common.errors.downloadSizeUnknown',
  download_metadata_unavailable: 'common.errors.downloadMetadataUnavailable',
  download_http_error: 'common.errors.downloadHttpError',
  download_verification_failed: 'common.errors.downloadVerificationFailed',
  download_file_missing: 'common.errors.downloadFileMissing',
  storage_private_unavailable: 'common.errors.storagePrivateUnavailable',
  message_empty: 'common.errors.messageEmpty',
  message_too_long: 'common.errors.messageTooLong',
  multimodal_not_ready: 'common.errors.multimodalNotReady',
  chat_attachment_copy_failed: 'common.errors.chatAttachmentCopyFailed',
  chat_attachment_limit_exceeded: 'common.errors.chatAttachmentLimitExceeded',
  chat_attachment_missing: 'common.errors.chatAttachmentMissing',
  chat_attachment_not_ready: 'common.errors.chatAttachmentNotReady',
};

const ERROR_PATTERNS: { pattern: RegExp; code: AppErrorCode }[] = [
  { pattern: /DISK_SPACE_LOW/i, code: 'download_disk_space_low' },
  { pattern: /MODEL_SIZE_UNKNOWN/i, code: 'download_size_unknown' },
  { pattern: /MODEL_METADATA_UNAVAILABLE/i, code: 'download_metadata_unavailable' },
  { pattern: /HTTP status/i, code: 'download_http_error' },
  { pattern: /Size mismatch|checksum/i, code: 'download_verification_failed' },
  { pattern: /File does not exist after download|Model file not found/i, code: 'download_file_missing' },
  { pattern: /Private storage is unavailable/i, code: 'storage_private_unavailable' },
  { pattern: /Engine not ready|Model is not loaded/i, code: 'engine_not_ready' },
  { pattern: /already being generated|Stop the current response/i, code: 'engine_busy' },
  { pattern: /unloading/i, code: 'engine_unloading' },
  { pattern: /not found or not downloaded/i, code: 'model_not_found' },
  { pattern: /out of memory|not enough memory|std::bad_alloc|ENOMEM/i, code: 'model_memory_insufficient' },
  { pattern: /Message cannot be empty/i, code: 'message_empty' },
  { pattern: /message is too long|too long to fit|context window/i, code: 'message_too_long' },
];

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly details?: Record<string, unknown>;
  public override readonly cause?: unknown;

  constructor(
    code: AppErrorCode,
    message?: string,
    options?: {
      cause?: unknown;
      details?: Record<string, unknown>;
    },
  ) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.details = options?.details;
    this.cause = options?.cause;
  }
}

const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'DirectorySizeTraversalLimitError',
  'Error',
  'EvalError',
  'NetworkError',
  'PrivateStorageUnavailableError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
]);

const SAFE_APP_ERROR_CODES: ReadonlySet<string> = new Set<AppErrorCode>([
  'action_failed',
  'engine_not_ready',
  'engine_busy',
  'engine_unloading',
  'model_not_found',
  'model_load_blocked',
  'model_load_failed',
  'model_incompatible',
  'model_memory_insufficient',
  'model_memory_warning',
  'download_disk_space_low',
  'download_size_unknown',
  'download_metadata_unavailable',
  'download_http_error',
  'download_verification_failed',
  'download_file_missing',
  'storage_private_unavailable',
  'message_empty',
  'message_too_long',
  'multimodal_not_ready',
  'chat_attachment_copy_failed',
  'chat_attachment_limit_exceeded',
  'chat_attachment_missing',
  'chat_attachment_not_ready',
  'chat_attachment_unsupported_type',
  'chat_attachment_corrupt',
  'chat_attachment_parse_failed',
  'chat_attachment_too_large_for_context',
  'chat_attachment_document_encrypted',
  'chat_attachment_document_no_extractable_text',
]);

const SAFE_PRIVACY_REPORT_CATEGORIES = new Set([
  'storage_metrics_load_failed',
]);

function getSafeErrorName(error: Error): string {
  return SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Error';
}

function getSafePrivacyReportCategory(category: string): string {
  return SAFE_PRIVACY_REPORT_CATEGORIES.has(category) ? category : 'operation_failed';
}

export function getSafeAppErrorCode(
  code: unknown,
  fallbackCode: AppErrorCode = 'action_failed',
): AppErrorCode {
  if (typeof code === 'string' && SAFE_APP_ERROR_CODES.has(code)) {
    return code as AppErrorCode;
  }

  return SAFE_APP_ERROR_CODES.has(fallbackCode) ? fallbackCode : 'action_failed';
}

export function getPrivacySafeErrorLogDetails(error: unknown): Record<string, string> {
  if (error instanceof AppError) {
    return {
      errorCode: getSafeAppErrorCode(error.code),
      errorName: 'AppError',
    };
  }

  if (error instanceof Error) {
    return {
      errorName: getSafeErrorName(error),
    };
  }

  return { errorType: typeof error };
}

function inferErrorCode(message: string): AppErrorCode | null {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    return null;
  }

  const match = ERROR_PATTERNS.find(({ pattern }) => pattern.test(normalizedMessage));
  return match?.code ?? null;
}

export function toAppError(error: unknown, fallbackCode: AppErrorCode = 'action_failed'): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(inferErrorCode(error.message) ?? fallbackCode, error.message, {
      cause: error,
    });
  }

  if (typeof error === 'string') {
    return new AppError(inferErrorCode(error) ?? fallbackCode, error);
  }

  return new AppError(fallbackCode);
}

export function reportError(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>,
): AppError {
  const appError = toAppError(error);
  const safeCode = getSafeAppErrorCode(appError.code);
  const sanitizedReport = sanitizeErrorForReport(appError, { includeStack: true });
  const sanitizedError = new AppError(safeCode, sanitizedReport.message, {
    cause: sanitizedReport.cause,
    details: sanitizedReport.details,
  });
  sanitizedError.name = 'AppError';
  if (sanitizedReport.stack) {
    sanitizedError.stack = sanitizedReport.stack;
  }
  const reporter = (globalThis as { Sentry?: { captureException?: (...args: unknown[]) => void } }).Sentry;
  const isDev = typeof __DEV__ === 'boolean' ? __DEV__ : process.env.NODE_ENV !== 'production';
  const extra = sanitizeErrorReportContext({
    ...appError.details,
    ...context,
  }) ?? {};

  if (!isDev && reporter?.captureException) {
    reporter.captureException(sanitizedError, {
      tags: { scope, code: safeCode },
      extra,
    });
    return sanitizedError;
  }

  console.error(`[${scope}]`, sanitizedError, Object.keys(extra).length > 0 ? extra : undefined);
  return sanitizedError;
}

export function reportPrivacySafeError(
  scope: string,
  error: unknown,
  category: string,
  fallbackCode: AppErrorCode = 'action_failed',
): AppError {
  const safeFallbackCode = getSafeAppErrorCode(fallbackCode);
  return reportError(
    scope,
    new AppError(safeFallbackCode, safeFallbackCode, {
      details: {
        category: getSafePrivacyReportCategory(category),
        ...getPrivacySafeErrorLogDetails(error),
      },
    }),
  );
}

export function getErrorMessage(
  error: unknown,
  t: TFunction,
  fallbackKey = 'common.actionFailed',
): string {
  const appError = toAppError(error);
  const translationKey = ERROR_MESSAGE_KEYS[appError.code];

  if (translationKey) {
    return t(translationKey);
  }

  if (appError.message && appError.message !== appError.code) {
    return appError.message;
  }

  return t(fallbackKey);
}

export function getReportedErrorMessage(
  scope: string,
  error: unknown,
  t: TFunction,
  fallbackKey = 'common.actionFailed',
): string {
  return getErrorMessage(reportError(scope, error), t, fallbackKey);
}
