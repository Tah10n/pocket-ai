const REDACTED_TOKEN = '[redacted]';
const REDACTED_PATH = '[path]';
const REDACTED_FILE_URI = '[file-uri]';
const REDACTED_URI = '[uri]';
const MAX_RECURSION_DEPTH = 8;

const DROP_KEYS = new Set([
  'downloadurl',
  'downloaduri',
  'fileuri',
  'filepath',
  'localuri',
  'localpath',
  'nativepath',
  'pickeruri',
  'previewuri',
  'thumbnailuri',
]);

const TOKEN_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'bearer',
  'credential',
  'credentials',
  'secret',
  'signature',
  'token',
]);

const TOKEN_QUERY_PARAM_PATTERN = /([?&;](?:[^=&#;]*?(?:token|secret|signature|credential|authorization|apikey|api_key|access_key|x-amz-signature|x-amz-credential|x-amz-security-token)[^=&#;]*)=)([^&#;\s]+)/giu;
const BEARER_PATTERN = /\bBearer\s+[^\s'"),;]+/giu;
const FILE_URI_PATTERN = /\bfile:\/\/[^\s'"),;]+/giu;
const PICKER_URI_PATTERN = /\b(?:content|ph):\/\/[^\s'"),;]+/giu;
const WINDOWS_EXTENDED_PATH_PATTERN = /\\\\\?\\(?:UNC\\[^\\/\s'"),;]+\\[^\\/\s'"),;]+(?:\\[^\s\r\n'"),;]+)*|[A-Za-z]:[\\/][^\s\r\n'"),;]+)/giu;
const WINDOWS_UNC_PATH_PATTERN = /\\\\(?!\?\\)[^\\/\s'"),;]+\\[^\\/\s'"),;]+(?:\\[^\s\r\n'"),;]+)*/gu;
const WINDOWS_EXTENDED_PATH_WITH_SPACES_PATTERN = /\\{2}[?]\\(?:UNC\\[^\\/\r\n'"),;|]+\\[^\\/\r\n'"),;|]+(?:\\[^\r\n'"),;|]+)*|[A-Za-z]:[\\/][^\r\n'"),;|]+)/giu;
const WINDOWS_UNC_PATH_WITH_SPACES_PATTERN = /\\\\(?![?]\\)[^\\/\r\n'"),;|]+\\[^\\/\r\n'"),;|]+(?:\\[^\r\n'"),;|]+)*/gu;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\r\n'"),;]+/gu;
const PRIVATE_UNIX_PATH_PATTERN = /(^|[^\w:])\/(?:private|var\/mobile|var\/folders|data(?:\/user)?|storage(?:\/emulated)?|sdcard|mnt|workspace|Users|home|tmp|test-dir|test-cache)(?:\/[^\r\n'"),;|]*)?/giu;
const MODEL_STORAGE_PATH_PATTERN = /(^|[^\w:])\/[^\r\n'"),;|]*\/models\/[^\r\n'"),;|]+/giu;

type SanitizerOptions = {
  includeStack?: boolean;
};

type SanitizeState = {
  seen: WeakSet<object>;
  depth: number;
  parentKey?: string;
};

export type SanitizedErrorReport = {
  name?: string;
  code?: unknown;
  message: string;
  stack?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
};

function sanitizeErrorForReportWithState(error: {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
  cause?: unknown;
  details?: Record<string, unknown>;
}, options: SanitizerOptions, state: SanitizeState): SanitizedErrorReport {
  const cause = error.cause === undefined ? undefined : sanitizeErrorReportValue(error.cause, {
    seen: state.seen,
    depth: state.depth + 1,
    parentKey: 'cause',
  });
  const details = error.details
    ? sanitizeObjectEntries(error.details, {
      seen: state.seen,
      depth: state.depth + 1,
      parentKey: 'details',
    })
    : undefined;

  return {
    name: typeof error.name === 'string' ? sanitizeErrorReportString(error.name) : undefined,
    code: error.code,
    message: sanitizeErrorReportString(typeof error.message === 'string' ? error.message : 'Unknown error'),
    stack: options.includeStack && typeof error.stack === 'string'
      ? sanitizeErrorReportString(error.stack)
      : undefined,
    cause,
    details,
  };
}

function normalizeKey(key: string | undefined): string {
  return (key ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableHash(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function isPublicSafeModelId(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}$/.test(trimmed)
    && !/(?:^|\/)(?:private|users|home|tmp|models?|specs?)(?:\/|$)/i.test(trimmed)
    && !/[\\:?&#]/.test(trimmed);
}

function isSafePublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  return /^https:\/\/[^\s'"<>]+$/i.test(trimmed);
}

function sanitizeModelIdentifier(value: string): string {
  const trimmed = value.trim();
  return isPublicSafeModelId(trimmed) ? trimmed : `hash:${stableHash(trimmed)}`;
}

function isTokenKey(key: string | undefined): boolean {
  const normalizedKey = normalizeKey(key);
  return TOKEN_KEYS.has(normalizedKey)
    || normalizedKey.endsWith('token')
    || normalizedKey.endsWith('secret')
    || normalizedKey.endsWith('signature')
    || normalizedKey.endsWith('credential')
    || normalizedKey.endsWith('apikey');
}

function shouldDropKey(key: string | undefined, value: unknown): boolean {
  const normalizedKey = normalizeKey(key);
  return DROP_KEYS.has(normalizedKey)
    || normalizedKey.endsWith('downloadurl')
    || (normalizedKey.endsWith('uri') && !isSafePublicHttpsUrl(value))
    || normalizedKey.endsWith('localpath')
    || normalizedKey.endsWith('nativepath');
}

function isModelIdentifierKey(key: string | undefined): boolean {
  const normalizedKey = normalizeKey(key);
  return normalizedKey === 'modelid' || normalizedKey === 'ownermodelid';
}

export function sanitizeErrorReportString(value: string, key?: string): string {
  const withRedactedTokens = value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_TOKEN}`)
    .replace(TOKEN_QUERY_PARAM_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_TOKEN}`);

  if (isModelIdentifierKey(key)) {
    return sanitizeModelIdentifier(withRedactedTokens);
  }

  return withRedactedTokens
    .replace(FILE_URI_PATTERN, REDACTED_FILE_URI)
    .replace(PICKER_URI_PATTERN, REDACTED_URI)
    .replace(WINDOWS_EXTENDED_PATH_WITH_SPACES_PATTERN, REDACTED_PATH)
    .replace(WINDOWS_UNC_PATH_WITH_SPACES_PATTERN, REDACTED_PATH)
    .replace(WINDOWS_EXTENDED_PATH_PATTERN, REDACTED_PATH)
    .replace(WINDOWS_UNC_PATH_PATTERN, REDACTED_PATH)
    .replace(WINDOWS_PATH_PATTERN, REDACTED_PATH)
    .replace(PRIVATE_UNIX_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_PATH}`)
    .replace(MODEL_STORAGE_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_PATH}`);
}

function sanitizeObjectEntries(
  value: Record<string, unknown>,
  state: SanitizeState,
): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (shouldDropKey(key, nestedValue)) {
      continue;
    }

    if (isTokenKey(key)) {
      sanitized[key] = REDACTED_TOKEN;
      continue;
    }

    const nextValue = sanitizeErrorReportValue(nestedValue, {
      seen: state.seen,
      depth: state.depth + 1,
      parentKey: key,
    });

    if (nextValue !== undefined) {
      sanitized[key] = nextValue;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeErrorReportValue(
  value: unknown,
  state: SanitizeState = { seen: new WeakSet<object>(), depth: 0 },
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeErrorReportString(value, state.parentKey);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (state.depth >= MAX_RECURSION_DEPTH) {
    return '[MaxDepth]';
  }

  if (state.seen.has(value)) {
    return '[Circular]';
  }

  state.seen.add(value);

  if (value instanceof Error) {
    const errorReport = sanitizeErrorForReportWithState(value, { includeStack: true }, state);
    return Object.fromEntries(Object.entries(errorReport).filter(([, nestedValue]) => nestedValue !== undefined));
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorReportValue(item, {
      seen: state.seen,
      depth: state.depth + 1,
      parentKey: state.parentKey,
    }));
  }

  if (!isPlainObject(value)) {
    return sanitizeErrorReportString(String(value), state.parentKey);
  }

  return sanitizeObjectEntries(value, state);
}

export function sanitizeErrorReportContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }

  const sanitized = sanitizeErrorReportValue(context);
  return isPlainObject(sanitized) && Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeErrorForReport(error: {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
  cause?: unknown;
  details?: Record<string, unknown>;
}, options: SanitizerOptions = {}): SanitizedErrorReport {
  return sanitizeErrorForReportWithState(error, options, { seen: new WeakSet<object>(), depth: 0 });
}
