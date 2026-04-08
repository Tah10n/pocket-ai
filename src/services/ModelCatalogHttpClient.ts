import { REQUEST_AUTH_POLICY, type RequestAuthPolicy } from '../types/huggingFace';

export type ModelCatalogErrorCode = 'rate_limited' | 'timeout' | 'network' | 'unknown';

type ModelCatalogErrorOptions = {
  retryAfterMs?: number;
};

export class ModelCatalogError extends Error {
  public readonly code: ModelCatalogErrorCode;
  public readonly retryAfterMs?: number;

  constructor(code: ModelCatalogErrorCode, message: string, options?: ModelCatalogErrorOptions) {
    super(message);
    this.code = code;
    this.retryAfterMs = options?.retryAfterMs;
    this.name = 'ModelCatalogError';
  }
}

export function getModelCatalogErrorMessage(error: unknown): string {
  if (error instanceof ModelCatalogError) {
    if (error.code === 'rate_limited') {
      const retryAfterMs = error.retryAfterMs;
      if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        if (retryAfterSeconds < 60) {
          return `Hugging Face rate limit reached. Try again in ~${retryAfterSeconds}s.`;
        }

        const retryAfterMinutes = Math.ceil(retryAfterSeconds / 60);
        return `Hugging Face rate limit reached. Try again in ~${retryAfterMinutes}m.`;
      }

      return 'Hugging Face rate limit reached. Please wait a moment and try again.';
    }

    if (error.code === 'timeout') {
      return 'Hugging Face request timed out. Please check your connection and try again.';
    }

    if (error.code === 'network') {
      return 'Network error while loading models. Check your connection and try again.';
    }
  }

  return 'Could not load models right now. Please try again.';
}

const HF_REQUEST_TIMEOUT_MS = 20_000;

export function resolveRequestAuthToken(policy: RequestAuthPolicy, authToken: string | null): string | null {
  if (policy === REQUEST_AUTH_POLICY.ANONYMOUS) {
    return null;
  }

  if (!authToken) {
    if (policy === REQUEST_AUTH_POLICY.REQUIRED_AUTH) {
      throw new ModelCatalogError('unknown', 'Hugging Face token is required for this request');
    }

    return null;
  }

  return authToken;
}

export function buildHeaders(policy: RequestAuthPolicy, authToken: string | null): HeadersInit | undefined {
  const resolvedToken = resolveRequestAuthToken(policy, authToken);
  if (!resolvedToken) {
    return undefined;
  }

  return {
    Authorization: `Bearer ${resolvedToken}`,
  };
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = HF_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = typeof AbortController !== 'undefined'
    ? new AbortController()
    : null;
  const signal = controller?.signal ?? init.signal;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const externalSignal = init.signal;
  const abortListener = () => controller?.abort();

  if (externalSignal && controller) {
    if (externalSignal.aborted) {
      controller.abort();
    } else if (typeof externalSignal.addEventListener === 'function') {
      externalSignal.addEventListener('abort', abortListener);
    }
  }

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller?.abort();
      reject(new ModelCatalogError('timeout', `HF request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const fetchPromise = fetch(url, signal ? { ...init, signal } : init);
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (externalSignal && controller && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', abortListener);
    }
  }
}

export function resolveRetryAfterMs(response: Response): number | null {
  if (!response.headers || typeof response.headers.get !== 'function') {
    return null;
  }

  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const rateLimitResetHeader = response.headers.get('ratelimit-reset')
    ?? response.headers.get('x-ratelimit-reset')
    ?? response.headers.get('x-ratelimit-reset-requests');
  return parseRateLimitResetMs(rateLimitResetHeader);
}

export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return dateMs - Date.now();
  }

  return null;
}

export function parseRateLimitResetMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const numericValue = Number(trimmed);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }

  // Heuristic: treat large values as epoch timestamps.
  if (numericValue > 1e12) {
    return numericValue - Date.now();
  }

  if (numericValue > 1e9) {
    return numericValue * 1000 - Date.now();
  }

  // Otherwise assume seconds until reset.
  return numericValue * 1000;
}

export function parseNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const linkValue of splitLinkHeader(linkHeader, ',')) {
    const segments = splitLinkHeader(linkValue, ';');
    if (segments.length === 0) {
      continue;
    }

    const target = parseLinkTarget(segments[0]);
    if (!target) {
      continue;
    }

    const hasNextRelation = segments.slice(1).some((segment) => {
      const parameter = parseLinkParameter(segment);
      if (!parameter || parameter.name !== 'rel') {
        return false;
      }

      return parameter.value
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .includes('next');
    });

    if (hasNextRelation) {
      return target;
    }
  }

  return null;
}

export function splitLinkHeader(headerValue: string, delimiter: ',' | ';'): string[] {
  const parts: string[] = [];
  let currentPart = '';
  let inQuotes = false;
  let inAngleBrackets = false;
  let escapeNextCharacter = false;

  for (const character of headerValue) {
    if (escapeNextCharacter) {
      currentPart += character;
      escapeNextCharacter = false;
      continue;
    }

    if (character === '\\' && inQuotes) {
      escapeNextCharacter = true;
      currentPart += character;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      currentPart += character;
      continue;
    }

    if (character === '<' && !inQuotes) {
      inAngleBrackets = true;
      currentPart += character;
      continue;
    }

    if (character === '>' && !inQuotes) {
      inAngleBrackets = false;
      currentPart += character;
      continue;
    }

    if (character === delimiter && !inQuotes && !inAngleBrackets) {
      const trimmedPart = currentPart.trim();
      if (trimmedPart) {
        parts.push(trimmedPart);
      }

      currentPart = '';
      continue;
    }

    currentPart += character;
  }

  const trailingPart = currentPart.trim();
  if (trailingPart) {
    parts.push(trailingPart);
  }

  return parts;
}

function parseLinkTarget(linkSegment: string): string | null {
  const trimmedSegment = linkSegment.trim();
  const start = trimmedSegment.indexOf('<');
  const end = trimmedSegment.indexOf('>', start + 1);
  if (start === -1 || end === -1 || end <= start + 1) {
    return null;
  }

  return trimmedSegment.slice(start + 1, end);
}

function parseLinkParameter(segment: string): { name: string; value: string } | null {
  const trimmedSegment = segment.trim();
  if (!trimmedSegment) {
    return null;
  }

  const separatorIndex = trimmedSegment.indexOf('=');
  const rawName = separatorIndex === -1
    ? trimmedSegment
    : trimmedSegment.slice(0, separatorIndex);
  const name = rawName.trim().toLowerCase();
  if (!name) {
    return null;
  }

  let value = separatorIndex === -1
    ? ''
    : trimmedSegment.slice(separatorIndex + 1).trim();

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/\\(.)/g, '$1');
  }

  return { name, value };
}

