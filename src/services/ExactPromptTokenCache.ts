import type { MultimodalReadinessState } from '../types/multimodal';

export const DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_APPROX_BYTES = 64 * 1024;

const PROMISE_ENTRY_APPROX_BYTES = 96;

export type ExactPromptTokenCacheKeyInput = {
  contextIdentity: string;
  modelId: string;
  multimodalReadinessIdentity: string;
  messageSignature: string;
  enableThinking: boolean;
  reasoningFormat: 'none' | 'auto' | 'deepseek';
  addGenerationPrompt?: boolean;
  allowMediaFallback?: boolean;
};

export type ExactPromptTokenCacheLookup = {
  hit: boolean;
  promise: Promise<number>;
  release: (outcome: 'success' | 'discard') => void;
};

type ExactPromptTokenCacheEntry = {
  activeConsumers: number;
  approxBytes: number;
  hasSuccessfulConsumer: boolean;
  promise: Promise<number>;
};

function encodeCacheKeyPart(value: string): string {
  return `${value.length}:${value}`;
}

export function buildExactPromptTokenCacheKey(input: ExactPromptTokenCacheKeyInput): string {
  return [
    'v1',
    input.contextIdentity,
    input.modelId,
    input.multimodalReadinessIdentity,
    input.messageSignature,
    input.enableThinking ? 'thinking:on' : 'thinking:off',
    `reasoning:${input.reasoningFormat}`,
    input.addGenerationPrompt === undefined
      ? 'generation-prompt:default'
      : `generation-prompt:${input.addGenerationPrompt ? 'on' : 'off'}`,
    input.allowMediaFallback === true ? 'media-fallback:on' : 'media-fallback:off',
  ].map(encodeCacheKeyPart).join('|');
}

export function buildPromptMultimodalReadinessIdentity(
  readiness: MultimodalReadinessState | undefined,
  expectedModelId: string | null,
): string {
  return [
    expectedModelId,
    readiness?.modelId ?? null,
    readiness?.status ?? null,
    readiness?.projectorId ?? null,
    readiness?.support.join(',') ?? null,
  ].join('\u0001');
}

export class BoundedExactPromptTokenCache {
  private readonly entries = new Map<string, ExactPromptTokenCacheEntry>();
  private totalApproxBytes = 0;

  public constructor(private readonly limits: {
    maxEntries: number;
    maxApproxBytes: number;
  } = {
    maxEntries: DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_ENTRIES,
    maxApproxBytes: DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_APPROX_BYTES,
  }) {
    if (!Number.isInteger(limits.maxEntries) || limits.maxEntries <= 0) {
      throw new Error('Exact prompt token cache maxEntries must be a positive integer.');
    }
    if (!Number.isFinite(limits.maxApproxBytes) || limits.maxApproxBytes <= 0) {
      throw new Error('Exact prompt token cache maxApproxBytes must be positive.');
    }
  }

  public getOrCreate(key: string, create: () => Promise<number>): ExactPromptTokenCacheLookup {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      existing.activeConsumers += 1;
      return this.createLookup(key, existing, true);
    }

    let promise: Promise<number>;
    try {
      promise = create();
    } catch (error) {
      promise = Promise.reject(error);
    }
    const approxBytes = PROMISE_ENTRY_APPROX_BYTES + (key.length * 2);
    if (approxBytes <= this.limits.maxApproxBytes) {
      const entry = {
        activeConsumers: 1,
        approxBytes,
        hasSuccessfulConsumer: false,
        promise,
      };
      this.entries.set(key, entry);
      this.totalApproxBytes += approxBytes;
      this.evictToLimits();

      void promise.catch(() => {
        this.delete(key, promise);
      });
    }

    const retainedEntry = this.entries.get(key);
    if (retainedEntry?.promise === promise) {
      return this.createLookup(key, retainedEntry, false);
    }

    return {
      hit: false,
      promise,
      release: () => undefined,
    };
  }

  public has(key: string): boolean {
    return this.entries.has(key);
  }

  public delete(key: string, expectedPromise?: Promise<number>): boolean {
    const entry = this.entries.get(key);
    if (!entry || (expectedPromise && entry.promise !== expectedPromise)) {
      return false;
    }

    this.deleteEntry(key, entry);
    return true;
  }

  public clear(): void {
    this.entries.clear();
    this.totalApproxBytes = 0;
  }

  public snapshot(): { entryCount: number; approxBytes: number } {
    return {
      entryCount: this.entries.size,
      approxBytes: this.totalApproxBytes,
    };
  }

  private evictToLimits(): void {
    while (
      this.entries.size > this.limits.maxEntries
      || this.totalApproxBytes > this.limits.maxApproxBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }

      const oldestEntry = this.entries.get(oldestKey);
      if (!oldestEntry) {
        break;
      }
      this.deleteEntry(oldestKey, oldestEntry);
    }
  }

  private createLookup(
    key: string,
    entry: ExactPromptTokenCacheEntry,
    hit: boolean,
  ): ExactPromptTokenCacheLookup {
    let released = false;

    return {
      hit,
      promise: entry.promise,
      release: (outcome) => {
        if (released) {
          return;
        }
        released = true;

        const currentEntry = this.entries.get(key);
        if (currentEntry !== entry) {
          return;
        }

        currentEntry.activeConsumers = Math.max(0, currentEntry.activeConsumers - 1);
        if (outcome === 'success') {
          currentEntry.hasSuccessfulConsumer = true;
          return;
        }

        if (currentEntry.activeConsumers === 0 && !currentEntry.hasSuccessfulConsumer) {
          this.deleteEntry(key, currentEntry);
        }
      },
    };
  }

  private deleteEntry(key: string, entry: ExactPromptTokenCacheEntry): void {
    if (!this.entries.delete(key)) {
      return;
    }

    this.totalApproxBytes = Math.max(0, this.totalApproxBytes - entry.approxBytes);
  }
}

export const exactPromptTokenCache = new BoundedExactPromptTokenCache();
