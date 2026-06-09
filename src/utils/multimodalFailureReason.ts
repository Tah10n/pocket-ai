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
const QUOTED_PROMPT_PAYLOAD_PATTERN =
  /\b(?:(?:(?:user|input|raw|original)\s+)?prompt(?:\s+(?:text|payload|content|message))?|(?:user|raw|original)\s+(?:input|message|text))\s*(?::|=|-|is|was|with|for)?\s*(["'`])(?:\\.|(?!\1)[\s\S])*?\1/gi;

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

function appendUniqueCategory(categories: string[], category: string): void {
  if (!categories.includes(category)) {
    categories.push(category);
  }
}

function stripQuotedPromptPayloads(value: string): string {
  return value.replace(QUOTED_PROMPT_PAYLOAD_PATTERN, '[prompt_payload]');
}

function hasCompletionFailureSignal(value: string): boolean {
  return /\b(?:completion|generate|generation)\b/.test(value)
    || /\b(?:evaluat|process)[a-z]*\b.{0,80}(?:\[prompt_payload\]|\b(?:prompt|tokens?)\b)/.test(value)
    || /\b(?:prompt|tokens?)\b/.test(value);
}

export function sanitizeMultimodalFailureCategory(value: string | null | undefined): string | undefined {
  const sanitized = sanitizeMultimodalFailureReason(value, 512);
  if (!sanitized) {
    return undefined;
  }

  const categorySource = stripQuotedPromptPayloads(sanitized);
  const normalized = categorySource.toLowerCase();
  const categories: string[] = [];
  const hasMemoryFailure = /(?:memory|oom|alloc)/.test(normalized);

  if (/(?:native|runtime|llama(?:\.rn)?|cpp|jni)/i.test(categorySource)) {
    appendUniqueCategory(categories, 'runtime');
  } else {
    appendUniqueCategory(categories, 'multimodal');
  }

  if (hasMemoryFailure) {
    appendUniqueCategory(categories, 'memory_error');
  }

  if (/(?:init|initializ)/.test(normalized)) {
    appendUniqueCategory(categories, 'initialization_failed');
  } else if (hasCompletionFailureSignal(normalized)) {
    appendUniqueCategory(categories, 'completion_failed');
  } else if (/(?:support|unsupported|vision)/.test(normalized)) {
    appendUniqueCategory(categories, 'vision_support_unavailable');
  } else if (/(?:release|deinit|free)/.test(normalized)) {
    appendUniqueCategory(categories, 'release_failed');
  } else if (/(?:download|transfer)/.test(normalized)) {
    appendUniqueCategory(categories, 'projector_download_failed');
  } else if (/(?:missing|not found|unavailable|resolve|file|path|projector)/.test(normalized)) {
    appendUniqueCategory(categories, 'projector_unavailable');
  } else if (!hasMemoryFailure) {
    appendUniqueCategory(categories, 'failed');
  }

  if (normalized.includes('[path]') || normalized.includes('path_redacted')) {
    appendUniqueCategory(categories, 'path_redacted');
  }

  if (/\bretr(?:y|ies|ied)\b/.test(normalized)) {
    appendUniqueCategory(categories, 'retry');
  }

  return categories.join(':');
}
