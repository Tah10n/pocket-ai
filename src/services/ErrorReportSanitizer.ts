const REDACTED_TOKEN = '[redacted]';
const REDACTED_PATH = '[path]';
const REDACTED_FILE_URI = '[file-uri]';
const REDACTED_URI = '[uri]';
const REDACTED_PAYLOAD = '[redacted-payload]';
const MAX_RECURSION_DEPTH = 8;

const DROP_KEYS = new Set([
  'base64',
  'bytes',
  'datauri',
  'downloadurl',
  'downloaduri',
  'fileuri',
  'filepath',
  'imagedata',
  'localuri',
  'localpath',
  'nativepath',
  'pickeruri',
  'prompt',
  'prompts',
  'previewuri',
  'systemprompt',
  'thumbnailuri',
  'userprompt',
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

const CHAT_PAYLOAD_CONTAINER_KEYS = new Set([
  'chatmessages',
  'completionmessages',
  'formattedmessages',
  'messages',
  'promptmessages',
  'requestmessages',
]);

const MODEL_CONTEXT_HASHED_KEYS = new Set([
  'author',
  'id',
  'modelid',
  'name',
  'projectorid',
  'selectedprojectorid',
]);

const MODEL_CONTEXT_SAFE_KEYS = new Set([
  'accessstate',
  'artifactkind',
  'chatmodalities',
  'downloadprogress',
  'fitsinram',
  'isgated',
  'isprivate',
  'lifecyclestatus',
  'memoryfitconfidence',
  'memoryfitdecision',
  'metadatatrust',
  'pathcategory',
  'size',
  'sizebytes',
  'visionconfidence',
  'visionsource',
]);

const MODEL_CONTEXT_SAFE_GGUF_KEYS = new Set([
  'architecture',
  'contextlengthtokens',
  'nembdheadk',
  'nembdheadv',
  'nheadkv',
  'nlayers',
  'sizelabel',
  'slidingwindowtokens',
  'totalbytes',
]);

const CHAT_MESSAGE_ROLES = new Set(['assistant', 'system', 'tool', 'user']);

const TOKEN_QUERY_PARAM_PATTERN = /([?&;](?:[^=&#;]*?(?:token|secret|signature|credential|authorization|apikey|api_key|access_key|x-amz-signature|x-amz-credential|x-amz-security-token)[^=&#;]*)=)([^&#;\s]+)/giu;
const BEARER_PATTERN = /\bBearer\s+[^\s'"),;]+/giu;
const LABELED_TOKEN_ASSIGNMENT_PATTERN = /\b((?:access[_-]?(?:token|key)|auth[_-]?token|api[_-]?key|apikey|authorization|bearer|secret|signature|credential|credentials|x-amz-(?:signature|credential|security-token)))\b(\s*[:=]\s*)(['"]?)(?:(?:Bearer|Basic|Token)\s+)?([^'"\s,;&|)]+)\3/giu;
const FILE_URI_PATTERN = /\bfile:\/\/[^\s'"),;]+/giu;
const PICKER_URI_PATTERN = /\b(?:content|ph|assets-library|gallery):\/\/[^\s'"),;]+/giu;
const DATA_IMAGE_URI_PATTERN = /\bdata:image\/[a-z0-9.+-]+(?:;[a-z0-9.+_-]+=[a-z0-9.+_-]+)*;base64,[a-z0-9+/=_-]+/giu;
const LABELED_SENSITIVE_PAYLOAD_PATTERN = /\b(base64|imageData|dataUri|bytes)\b(\s*[:=]\s*)(['"]?)(?:data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+_-]+=[a-z0-9.+_-]+)*;base64,)?[a-z0-9+/=_-]{40,}\3/giu;
const QUOTED_PROMPT_KEY_PATTERN = /(['"])((?:system|user)?prompt|prompts)\1(\s*:\s*)(['"])(?:\\[\s\S]|(?!\4)[^\\])*?\4/giu;
const QUOTED_PROMPT_KEY_UNTERMINATED_PATTERN = /(['"])((?:system|user)?prompt|prompts)\1(\s*:\s*)(['"])(?:\\[\s\S]|(?!\4)(?!\r?\n\s+(?:at|at async)\s+)(?!\r?\nCaused by:)(?!\r?\n[A-Za-z]*Error:)[\s\S])*?(?=(?:\r?\n\s+(?:at|at async)\s+|\r?\nCaused by:|\r?\n[A-Za-z]*Error:)|$)/giu;
const LABELED_PROMPT_PATTERN = /\b((?:system|user)?prompt|prompts)\b(\s*[:=]\s*)(?:['"]?)[\s\S]*?(?=(?:\r?\n\s+(?:at|at async)\s+|\r?\nCaused by:|\r?\n[A-Za-z]*Error:)|$)/giu;
const PROMPT_LIKE_QUOTED_PAYLOAD_PATTERN = /\b((?:(?:system|user)\s*)?prompt|prompts|user\s+input|raw\s+message|message\s+content)\b(?!['"]\s*:)([^'"\r\n]{0,80})(['"])(?:\\[\s\S]|(?!\3)[^\\])*?\3/giu;
const PROMPT_LIKE_UNTERMINATED_QUOTED_PAYLOAD_PATTERN = /\b((?:(?:system|user)\s*)?prompt|prompts|user\s+input|raw\s+message|message\s+content)\b(?!['"]\s*:)([^'"\r\n]{0,80})(['"])(?:\\[\s\S]|(?!\3)(?!\r?\n\s+(?:at|at async)\s+)(?!\r?\nCaused by:)(?!\r?\n[A-Za-z]*Error:)[\s\S])*?(?=(?:\r?\n\s+(?:at|at async)\s+|\r?\nCaused by:|\r?\n[A-Za-z]*Error:)|$)/giu;
const QUOTED_CHAT_TEXT_KEY_PATTERN = /(['"])(content|text)\1(\s*:\s*)(['"])(?:\\[\s\S]|(?!\4)[^\\])*?\4/giu;
const QUOTED_CHAT_TEXT_KEY_UNTERMINATED_PATTERN = /(['"])(content|text)\1(\s*:\s*)(['"])(?:\\[\s\S]|(?!\4)(?!\r?\n\s+(?:at|at async)\s+)(?!\r?\nCaused by:)(?!\r?\n[A-Za-z]*Error:)[\s\S])*?(?=(?:\r?\n\s+(?:at|at async)\s+|\r?\nCaused by:|\r?\n[A-Za-z]*Error:)|$)/giu;
const LIKELY_BASE64_IMAGE_PATTERN = /(^|[^A-Za-z0-9+/=_-])((?:iVBORw0KGgo|\/9j\/|R0lGOD(?:lh|dh)|UklGR)[A-Za-z0-9+/=_-]{24,})/gu;
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

function isChatPayloadContainerKey(key: string | undefined): boolean {
  const normalizedKey = normalizeKey(key);
  return CHAT_PAYLOAD_CONTAINER_KEYS.has(normalizedKey);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isChatMessageObject(value: Record<string, unknown>): boolean {
  return typeof value.role === 'string'
    && CHAT_MESSAGE_ROLES.has(value.role.trim().toLowerCase());
}

function isMultimodalTextPartObject(value: Record<string, unknown>): boolean {
  return typeof value.type === 'string'
    && value.type.trim().toLowerCase() === 'text'
    && Object.prototype.hasOwnProperty.call(value, 'text');
}

function shouldRedactChatTextField(
  container: Record<string, unknown>,
  key: string | undefined,
  state: SanitizeState,
): boolean {
  const normalizedKey = normalizeKey(key);
  return (
    normalizedKey === 'content'
    && (isChatMessageObject(container) || isChatPayloadContainerKey(state.parentKey))
  ) || (
    normalizedKey === 'text'
    && isMultimodalTextPartObject(container)
  );
}

function stableHash(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
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
  return `hash:${stableHash(trimmed)}`;
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

function isInputAudioPayloadKey(key: string | undefined, parentKey: string | undefined): boolean {
  return normalizeKey(parentKey) === 'inputaudio' && normalizeKey(key) === 'data';
}

function shouldDropKey(key: string | undefined, value: unknown, state: SanitizeState): boolean {
  const normalizedKey = normalizeKey(key);
  return DROP_KEYS.has(normalizedKey)
    || isChatPayloadContainerKey(key)
    || isInputAudioPayloadKey(key, state.parentKey)
    || normalizedKey.includes('base64')
    || normalizedKey === 'imagebytes'
    || normalizedKey.endsWith('prompt')
    || normalizedKey.endsWith('prompts')
    || normalizedKey.endsWith('prompttext')
    || normalizedKey.endsWith('promptcontent')
    || normalizedKey.endsWith('downloadurl')
    || (normalizedKey.endsWith('uri') && !isSafePublicHttpsUrl(value))
    || normalizedKey.endsWith('localpath')
    || normalizedKey.endsWith('nativepath');
}

export function sanitizeErrorReportObjectKey(key: string): string {
  const sanitizedKey = sanitizeErrorReportString(key).trim();
  return sanitizedKey.length > 0 ? sanitizedKey : REDACTED_TOKEN;
}

function getUniqueSanitizedObjectKey(key: string, sanitized: Record<string, unknown>): string {
  const sanitizedKey = sanitizeErrorReportObjectKey(key);
  if (!Object.prototype.hasOwnProperty.call(sanitized, sanitizedKey)) {
    return sanitizedKey;
  }

  let suffix = 2;
  let candidate = `${sanitizedKey}#${suffix}`;
  while (Object.prototype.hasOwnProperty.call(sanitized, candidate)) {
    suffix += 1;
    candidate = `${sanitizedKey}#${suffix}`;
  }

  return candidate;
}

function isModelIdentifierKey(key: string | undefined): boolean {
  const normalizedKey = normalizeKey(key);
  return normalizedKey.endsWith('modelid') || normalizedKey.endsWith('projectorid');
}

function trySanitizeJsonPayloadString(value: string, key?: string): string | null {
  const leadingWhitespace = value.match(/^\s*/u)?.[0] ?? '';
  const trailingWhitespace = value.match(/\s*$/u)?.[0] ?? '';
  const trimmed = value.trim();

  if (!/^[\[{]/u.test(trimmed)) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const sanitized = sanitizeErrorReportValue(parsed, {
      seen: new WeakSet<object>(),
      depth: 0,
      parentKey: key,
    });
    return `${leadingWhitespace}${JSON.stringify(sanitized)}${trailingWhitespace}`;
  } catch {
    return null;
  }
}

export function sanitizeErrorReportString(value: string, key?: string): string {
  const withRedactedTokens = value
    .replace(DATA_IMAGE_URI_PATTERN, REDACTED_PAYLOAD)
    .replace(LABELED_SENSITIVE_PAYLOAD_PATTERN, (_match, label: string, separator: string) => `${label}${separator}${REDACTED_PAYLOAD}`)
    .replace(LIKELY_BASE64_IMAGE_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_PAYLOAD}`)
    .replace(QUOTED_PROMPT_KEY_PATTERN, (_match, keyQuote: string, label: string, separator: string, valueQuote: string) => `${keyQuote}${label}${keyQuote}${separator}${valueQuote}${REDACTED_TOKEN}${valueQuote}`)
    .replace(QUOTED_PROMPT_KEY_UNTERMINATED_PATTERN, (_match, keyQuote: string, label: string, separator: string, valueQuote: string) => `${keyQuote}${label}${keyQuote}${separator}${valueQuote}${REDACTED_TOKEN}`)
    .replace(LABELED_PROMPT_PATTERN, (_match, label: string, separator: string) => `${label}${separator}${REDACTED_TOKEN}`)
    .replace(PROMPT_LIKE_QUOTED_PAYLOAD_PATTERN, (_match, label: string, between: string, quote: string) => `${label}${between}${quote}${REDACTED_TOKEN}${quote}`)
    .replace(PROMPT_LIKE_UNTERMINATED_QUOTED_PAYLOAD_PATTERN, (_match, label: string, between: string, quote: string) => `${label}${between}${quote}${REDACTED_TOKEN}`)
    .replace(LABELED_TOKEN_ASSIGNMENT_PATTERN, (_match, label: string, separator: string, quote: string) => `${label}${separator}${quote}${REDACTED_TOKEN}${quote}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_TOKEN}`)
    .replace(TOKEN_QUERY_PARAM_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_TOKEN}`);

  if (isModelIdentifierKey(key)) {
    return sanitizeModelIdentifier(withRedactedTokens);
  }

  const withSanitizedJsonPayload = trySanitizeJsonPayloadString(withRedactedTokens, key) ?? withRedactedTokens;

  const withRedactedChatText = withSanitizedJsonPayload
    .replace(QUOTED_CHAT_TEXT_KEY_PATTERN, (_match, keyQuote: string, label: string, separator: string, valueQuote: string) => `${keyQuote}${label}${keyQuote}${separator}${valueQuote}${REDACTED_TOKEN}${valueQuote}`)
    .replace(QUOTED_CHAT_TEXT_KEY_UNTERMINATED_PATTERN, (_match, keyQuote: string, label: string, separator: string, valueQuote: string) => `${keyQuote}${label}${keyQuote}${separator}${valueQuote}${REDACTED_TOKEN}`);

  return withRedactedChatText
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
    if (shouldDropKey(key, nestedValue, state)) {
      continue;
    }

    const sanitizedKey = getUniqueSanitizedObjectKey(key, sanitized);

    if (isTokenKey(key)) {
      sanitized[sanitizedKey] = REDACTED_TOKEN;
      continue;
    }

    if (shouldRedactChatTextField(value, key, state)) {
      sanitized[sanitizedKey] = REDACTED_TOKEN;
      continue;
    }

    const nextValue = sanitizeErrorReportValue(nestedValue, {
      seen: state.seen,
      depth: state.depth + 1,
      parentKey: key,
    });

    if (nextValue !== undefined) {
      sanitized[sanitizedKey] = nextValue;
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

function isSafeModelContextPrimitive(value: unknown): boolean {
  return value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint';
}

function isSafeModelContextValue(value: unknown): boolean {
  return isSafeModelContextPrimitive(value)
    || (Array.isArray(value) && value.every(isSafeModelContextPrimitive));
}

function getModelContextHashKey(key: string, sanitized: Record<string, unknown>): string {
  const sanitizedKey = sanitizeErrorReportObjectKey(key);
  const hashKey = sanitizedKey.toLowerCase().endsWith('hash') ? sanitizedKey : `${sanitizedKey}Hash`;
  if (!Object.prototype.hasOwnProperty.call(sanitized, hashKey)) {
    return hashKey;
  }

  let suffix = 2;
  let candidate = `${hashKey}#${suffix}`;
  while (Object.prototype.hasOwnProperty.call(sanitized, candidate)) {
    suffix += 1;
    candidate = `${hashKey}#${suffix}`;
  }

  return candidate;
}

function sanitizeModelGgufContext(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const safeGguf: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (!MODEL_CONTEXT_SAFE_GGUF_KEYS.has(normalizeKey(key)) || !isSafeModelContextValue(nestedValue)) {
      continue;
    }

    safeGguf[key] = nestedValue;
  }

  return sanitizeErrorReportContext(safeGguf);
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

export function sanitizeModelErrorReportContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }

  const safeModelContext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    const normalizedKey = normalizeKey(key);

    if (MODEL_CONTEXT_HASHED_KEYS.has(normalizedKey) && typeof value === 'string' && value.trim().length > 0) {
      safeModelContext[getModelContextHashKey(key, safeModelContext)] = sanitizeModelIdentifier(value);
      continue;
    }

    if (normalizedKey === 'gguf') {
      const gguf = sanitizeModelGgufContext(value);
      if (gguf) {
        safeModelContext.gguf = gguf;
      }
      continue;
    }

    if (MODEL_CONTEXT_SAFE_KEYS.has(normalizedKey) && isSafeModelContextValue(value)) {
      safeModelContext[key] = value;
    }
  }

  return sanitizeErrorReportContext(safeModelContext);
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
