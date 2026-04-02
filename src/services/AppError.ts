import type { TFunction } from 'i18next';

export type AppErrorCode =
  | 'action_failed'
  | 'engine_not_ready'
  | 'engine_busy'
  | 'engine_unloading'
  | 'model_not_found'
  | 'model_load_failed'
  | 'download_disk_space_low'
  | 'download_size_unknown'
  | 'download_metadata_unavailable'
  | 'download_http_error'
  | 'download_verification_failed'
  | 'download_file_missing'
  | 'message_empty';

const ERROR_MESSAGE_KEYS: Partial<Record<AppErrorCode, string>> = {
  engine_not_ready: 'common.errors.engineNotReady',
  engine_busy: 'common.errors.engineBusy',
  engine_unloading: 'common.errors.engineUnloading',
  model_not_found: 'common.errors.modelNotFound',
  model_load_failed: 'common.errors.modelLoadFailed',
  download_disk_space_low: 'common.errors.downloadDiskSpaceLow',
  download_size_unknown: 'common.errors.downloadSizeUnknown',
  download_metadata_unavailable: 'common.errors.downloadMetadataUnavailable',
  download_http_error: 'common.errors.downloadHttpError',
  download_verification_failed: 'common.errors.downloadVerificationFailed',
  download_file_missing: 'common.errors.downloadFileMissing',
  message_empty: 'common.errors.messageEmpty',
};

const ERROR_PATTERNS: { pattern: RegExp; code: AppErrorCode }[] = [
  { pattern: /DISK_SPACE_LOW/i, code: 'download_disk_space_low' },
  { pattern: /MODEL_SIZE_UNKNOWN/i, code: 'download_size_unknown' },
  { pattern: /MODEL_METADATA_UNAVAILABLE/i, code: 'download_metadata_unavailable' },
  { pattern: /HTTP status/i, code: 'download_http_error' },
  { pattern: /Size mismatch|checksum/i, code: 'download_verification_failed' },
  { pattern: /File does not exist after download|Model file not found/i, code: 'download_file_missing' },
  { pattern: /Engine not ready|Model is not loaded/i, code: 'engine_not_ready' },
  { pattern: /already being generated|Stop the current response/i, code: 'engine_busy' },
  { pattern: /unloading/i, code: 'engine_unloading' },
  { pattern: /not found or not downloaded/i, code: 'model_not_found' },
  { pattern: /Message cannot be empty/i, code: 'message_empty' },
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
  const reporter = (globalThis as { Sentry?: { captureException?: (...args: unknown[]) => void } }).Sentry;
  const isDev = typeof __DEV__ === 'boolean' ? __DEV__ : process.env.NODE_ENV !== 'production';

  if (!isDev && reporter?.captureException) {
    reporter.captureException(appError, {
      tags: { scope, code: appError.code },
      extra: {
        ...appError.details,
        ...context,
      },
    });
    return appError;
  }

  console.error(`[${scope}]`, appError, context);
  return appError;
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
