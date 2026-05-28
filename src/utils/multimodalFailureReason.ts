const DEFAULT_MAX_FAILURE_REASON_LENGTH = 180;

const PATH_TERMINAL_EXTENSION = String.raw`(?:gguf|jpg|jpeg|png|webp|heic|heif|bin|dat)`;
const PATH_EXTENSION_LOOKAHEAD = String.raw`(?=$|[\s,;:!?)\]\}])`;
const PATH_LIKE_BODY = `[^\\r\\n"'\`<>\\(\\)\\[\\]{},;:!?]+`;
const URI_WITH_EXTENSION_PATTERN = new RegExp(
  `\\b(?:file|content|ph):\\/\\/[^\\r\\n"'\`<>]*?\\.${PATH_TERMINAL_EXTENSION}${PATH_EXTENSION_LOOKAHEAD}`,
  'gi',
);
const WINDOWS_PATH_WITH_EXTENSION_PATTERN = new RegExp(
  `\\b[A-Za-z]:\\\\[^\\r\\n"'\`<>]*?\\.${PATH_TERMINAL_EXTENSION}${PATH_EXTENSION_LOOKAHEAD}`,
  'gi',
);
const UNIX_PATH_WITH_EXTENSION_PATTERN = new RegExp(
  `(^|[^\\w:])\\/[^\\r\\n"'\`<>]*?\\.${PATH_TERMINAL_EXTENSION}${PATH_EXTENSION_LOOKAHEAD}`,
  'gi',
);
const URI_LIKE_PATTERN = new RegExp(`\\b(?:file|content|ph):\\/\\/(?=\\S)${PATH_LIKE_BODY}`, 'gi');
const WINDOWS_PATH_PATTERN = new RegExp(`\\b[A-Za-z]:\\\\(?=\\S)${PATH_LIKE_BODY}`, 'g');
const UNIX_PATH_PATTERN = new RegExp(`(^|[^\\w:])(\\/(?=\\S)${PATH_LIKE_BODY})`, 'g');
const TRAILING_RETRY_CONTEXT_PATTERN = /\s+after\s+(?:retry|retries)$/i;

function normalizeMaxLength(maxLength: number | undefined): number {
  return typeof maxLength === 'number' && Number.isFinite(maxLength) && maxLength > 3
    ? Math.round(maxLength)
    : DEFAULT_MAX_FAILURE_REASON_LENGTH;
}

export function redactPathLikeValues(value: string): string {
  return value
    .replace(URI_WITH_EXTENSION_PATTERN, '[path]')
    .replace(WINDOWS_PATH_WITH_EXTENSION_PATTERN, '[path]')
    .replace(UNIX_PATH_WITH_EXTENSION_PATTERN, (_match, prefix: string) => `${prefix}[path]`)
    .replace(URI_LIKE_PATTERN, redactGenericPathLikeMatch)
    .replace(WINDOWS_PATH_PATTERN, redactGenericPathLikeMatch)
    .replace(UNIX_PATH_PATTERN, (_match, prefix: string, path: string) => `${prefix}${redactGenericPathLikeMatch(path)}`);
}

function redactGenericPathLikeMatch(match: string): string {
  const trailingContext = match.match(TRAILING_RETRY_CONTEXT_PATTERN)?.[0] ?? '';
  return `[path]${trailingContext}`;
}

export function sanitizeMultimodalFailureReason(
  value: string | null | undefined,
  maxLength?: number,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const sanitized = redactPathLikeValues(value)
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) {
    return undefined;
  }

  const resolvedMaxLength = normalizeMaxLength(maxLength);
  return sanitized.length > resolvedMaxLength
    ? `${sanitized.slice(0, resolvedMaxLength - 3)}...`
    : sanitized;
}
