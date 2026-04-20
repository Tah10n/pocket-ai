import type { MemoryFitResult } from '../memory/types';
import type { ModelThinkingCapabilitySnapshot } from '../types/models';

export function getErrorMessageText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return '';
}

export function isConversationAlternationError(error: unknown): boolean {
  const message = getErrorMessageText(error);
  return /Conversation roles must alternate user\/assistant/i.test(message);
}

export function isProbableMemoryFailure(error: unknown): boolean {
  const message = getErrorMessageText(error).toLowerCase();
  if (message.length === 0) {
    return false;
  }

  return (
    message.includes('out of memory')
    || message.includes('oom')
    || message.includes('not enough memory')
    || message.includes('insufficient memory')
    || message.includes('bad alloc')
    || message.includes('cannot allocate memory')
    || message.includes('malloc')
    || message.includes('std::bad_alloc')
    || message.includes('failed to allocate')
  );
}

export function shouldHardBlockSafeLoad({
  memoryFit,
  availableBudgetBytes,
  lowMemorySignal,
}: {
  memoryFit: MemoryFitResult | null | undefined;
  availableBudgetBytes: number | null;
  lowMemorySignal: boolean;
}): boolean {
  if (!memoryFit) {
    return false;
  }

  if (!Number.isFinite(memoryFit.requiredBytes) || memoryFit.requiredBytes <= 0) {
    return false;
  }

  if (!Number.isFinite(memoryFit.budget.totalMemoryBytes) || memoryFit.budget.totalMemoryBytes <= 0) {
    return false;
  }

  if (memoryFit.decision !== 'likely_oom') {
    return false;
  }

  if (memoryFit.confidence === 'high') {
    return true;
  }

  if (lowMemorySignal) {
    return true;
  }

  if (!Number.isFinite(availableBudgetBytes) || availableBudgetBytes === null || availableBudgetBytes <= 0) {
    return false;
  }

  return memoryFit.requiredBytes >= availableBudgetBytes;
}

export function canAutoUseSafeLoadProfile({
  memoryFit,
  availableBudgetBytes,
  lowMemorySignal,
}: {
  memoryFit: MemoryFitResult | null | undefined;
  availableBudgetBytes: number | null;
  lowMemorySignal: boolean;
}): boolean {
  if (!memoryFit) {
    return false;
  }

  if (lowMemorySignal) {
    return false;
  }

  if (!Number.isFinite(memoryFit.requiredBytes) || memoryFit.requiredBytes <= 0) {
    return false;
  }

  if (!Number.isFinite(availableBudgetBytes) || availableBudgetBytes === null || availableBudgetBytes <= 0) {
    return false;
  }

  return memoryFit.requiredBytes <= availableBudgetBytes;
}

export function getModelInfoString(modelInfo: unknown, key: string): string | null {
  if (!modelInfo || typeof modelInfo !== 'object') {
    return null;
  }

  const value = (modelInfo as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : null;
}

function toFinitePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

export function readNumericMetadata(metadata: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!metadata) {
    return null;
  }

  for (const key of keys) {
    const value = toFinitePositiveNumber(metadata[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

export function areThinkingCapabilitySnapshotsEqual(
  left: ModelThinkingCapabilitySnapshot | undefined,
  right: ModelThinkingCapabilitySnapshot,
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.supportsThinking === right.supportsThinking
    && left.canDisableThinking === right.canDisableThinking
    && left.thinkingStartTag === right.thinkingStartTag
    && left.thinkingEndTag === right.thinkingEndTag
  );
}
