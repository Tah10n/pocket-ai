import type { MultimodalReadinessState } from '../types/multimodal';

export const DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_APPROX_BYTES = 64 * 1024;
export const DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_IN_FLIGHT_ENTRIES = 32;
export const DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_IN_FLIGHT_APPROX_BYTES = 64 * 1024;

const IN_FLIGHT_ENTRY_APPROX_BYTES = 96;
const SETTLED_ENTRY_APPROX_BYTES = 48;

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

export type ExactPromptTokenCacheLimits = {
  maxEntries: number;
  maxApproxBytes: number;
  maxInFlightEntries?: number;
  maxInFlightApproxBytes?: number;
};

type InFlightExactPromptTokenCacheEntry = {
  activeConsumers: number;
  approxBytes: number;
  attachedToCurrentEpoch: boolean;
  epoch: number;
  hasSuccessfulConsumer: boolean;
  key: string;
  promise: Promise<number>;
  state: 'pending' | 'fulfilled' | 'rejected';
  value?: number;
};

type SettledExactPromptTokenCacheEntry = {
  approxBytes: number;
  value: number;
};

function encodeCacheKeyPart(value: string): string {
  return `${value.length}:${value}`;
}

function getKeyApproxBytes(key: string, overheadBytes: number): number {
  return overheadBytes + (key.length * 2);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Exact prompt token cache ${label} must be a positive integer.`);
  }
}

function assertPositiveFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Exact prompt token cache ${label} must be positive.`);
  }
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
  private readonly settledEntries = new Map<string, SettledExactPromptTokenCacheEntry>();
  private readonly currentInFlightEntries = new Map<string, InFlightExactPromptTokenCacheEntry>();
  private readonly allInFlightEntries = new Set<InFlightExactPromptTokenCacheEntry>();
  private readonly limits: Required<ExactPromptTokenCacheLimits>;
  private contextEpoch = 0;
  private settledApproxBytes = 0;
  private inFlightApproxBytes = 0;

  public constructor(limits: ExactPromptTokenCacheLimits = {
    maxEntries: DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_ENTRIES,
    maxApproxBytes: DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_APPROX_BYTES,
  }) {
    this.limits = {
      ...limits,
      maxInFlightEntries:
        limits.maxInFlightEntries ?? DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_IN_FLIGHT_ENTRIES,
      maxInFlightApproxBytes:
        limits.maxInFlightApproxBytes
        ?? DEFAULT_EXACT_PROMPT_TOKEN_CACHE_MAX_IN_FLIGHT_APPROX_BYTES,
    };

    assertPositiveInteger(this.limits.maxEntries, 'maxEntries');
    assertPositiveFiniteNumber(this.limits.maxApproxBytes, 'maxApproxBytes');
    assertPositiveInteger(this.limits.maxInFlightEntries, 'maxInFlightEntries');
    assertPositiveFiniteNumber(
      this.limits.maxInFlightApproxBytes,
      'maxInFlightApproxBytes',
    );
  }

  public getOrCreate(key: string, create: () => Promise<number>): ExactPromptTokenCacheLookup {
    const activeEntry = this.currentInFlightEntries.get(key);
    if (activeEntry) {
      activeEntry.activeConsumers += 1;
      return this.createInFlightLookup(activeEntry, true);
    }

    const settledEntry = this.settledEntries.get(key);
    if (settledEntry) {
      this.settledEntries.delete(key);
      this.settledEntries.set(key, settledEntry);
      return {
        hit: true,
        promise: Promise.resolve(settledEntry.value),
        release: () => undefined,
      };
    }

    let promise: Promise<number>;
    try {
      promise = Promise.resolve(create());
    } catch (error) {
      promise = Promise.reject(error);
    }

    const approxBytes = getKeyApproxBytes(key, IN_FLIGHT_ENTRY_APPROX_BYTES);
    if (!this.canAdmitInFlight(approxBytes)) {
      return {
        hit: false,
        promise,
        release: () => undefined,
      };
    }

    const entry: InFlightExactPromptTokenCacheEntry = {
      activeConsumers: 1,
      approxBytes,
      attachedToCurrentEpoch: true,
      epoch: this.contextEpoch,
      hasSuccessfulConsumer: false,
      key,
      promise,
      state: 'pending',
    };
    this.currentInFlightEntries.set(key, entry);
    this.allInFlightEntries.add(entry);
    this.inFlightApproxBytes += approxBytes;

    void promise.then(
      (value) => this.handleInFlightFulfilled(entry, value),
      () => this.handleInFlightRejected(entry),
    );

    return this.createInFlightLookup(entry, false);
  }

  public has(key: string): boolean {
    return this.currentInFlightEntries.has(key) || this.settledEntries.has(key);
  }

  public delete(key: string, expectedPromise?: Promise<number>): boolean {
    const activeEntry = this.currentInFlightEntries.get(key);
    if (activeEntry && (!expectedPromise || activeEntry.promise === expectedPromise)) {
      this.removeInFlightEntry(activeEntry);
      return true;
    }

    if (expectedPromise) {
      return false;
    }

    return this.deleteSettledEntry(key);
  }

  /**
   * Starts a fresh cache epoch without mutating promises already observed by callers.
   * Detached work remains in admission accounting until it settles and its callers release it.
   */
  public invalidateContext(): void {
    this.contextEpoch += 1;
    this.clearSettledEntries();
    for (const entry of [...this.currentInFlightEntries.values()]) {
      entry.attachedToCurrentEpoch = false;
      if (entry.state !== 'pending') {
        this.removeInFlightEntry(entry);
      }
    }
    this.currentInFlightEntries.clear();
  }

  public clear(): void {
    this.invalidateContext();
  }

  public snapshot(): { entryCount: number; approxBytes: number } {
    let currentInFlightApproxBytes = 0;
    for (const entry of this.currentInFlightEntries.values()) {
      currentInFlightApproxBytes += entry.approxBytes;
    }

    return {
      entryCount: this.currentInFlightEntries.size + this.settledEntries.size,
      approxBytes: currentInFlightApproxBytes + this.settledApproxBytes,
    };
  }

  public getDebugSnapshot(): {
    currentInFlightEntryCount: number;
    detachedInFlightEntryCount: number;
    inFlightApproxBytes: number;
    settledEntryCount: number;
    settledApproxBytes: number;
  } {
    return {
      currentInFlightEntryCount: this.currentInFlightEntries.size,
      detachedInFlightEntryCount:
        this.allInFlightEntries.size - this.currentInFlightEntries.size,
      inFlightApproxBytes: this.inFlightApproxBytes,
      settledEntryCount: this.settledEntries.size,
      settledApproxBytes: this.settledApproxBytes,
    };
  }

  private canAdmitInFlight(approxBytes: number): boolean {
    return approxBytes <= this.limits.maxInFlightApproxBytes
      && this.allInFlightEntries.size < this.limits.maxInFlightEntries
      && this.inFlightApproxBytes + approxBytes <= this.limits.maxInFlightApproxBytes;
  }

  private createInFlightLookup(
    entry: InFlightExactPromptTokenCacheEntry,
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

        if (!this.allInFlightEntries.has(entry)) {
          return;
        }

        entry.activeConsumers = Math.max(0, entry.activeConsumers - 1);
        if (outcome === 'success') {
          entry.hasSuccessfulConsumer = true;
        }

        this.finalizeReleasedInFlightEntry(entry);
      },
    };
  }

  private handleInFlightFulfilled(
    entry: InFlightExactPromptTokenCacheEntry,
    value: number,
  ): void {
    if (!this.allInFlightEntries.has(entry)) {
      return;
    }

    entry.state = 'fulfilled';
    entry.value = value;
    if (!entry.attachedToCurrentEpoch || entry.epoch !== this.contextEpoch) {
      this.removeInFlightEntry(entry);
      return;
    }
    this.finalizeReleasedInFlightEntry(entry);
  }

  private handleInFlightRejected(entry: InFlightExactPromptTokenCacheEntry): void {
    if (!this.allInFlightEntries.has(entry)) {
      return;
    }

    entry.state = 'rejected';
    this.removeInFlightEntry(entry);
  }

  private finalizeReleasedInFlightEntry(entry: InFlightExactPromptTokenCacheEntry): void {
    if (!this.allInFlightEntries.has(entry) || entry.activeConsumers > 0) {
      return;
    }

    if (!entry.hasSuccessfulConsumer) {
      this.removeInFlightEntry(entry);
      return;
    }

    if (entry.state !== 'fulfilled' || entry.value === undefined) {
      return;
    }

    const shouldPromote = entry.attachedToCurrentEpoch
      && entry.epoch === this.contextEpoch
      && this.currentInFlightEntries.get(entry.key) === entry;
    const value = entry.value;
    const key = entry.key;
    this.removeInFlightEntry(entry);

    if (shouldPromote) {
      this.setSettledValue(key, value);
    }
  }

  private setSettledValue(key: string, value: number): void {
    const approxBytes = getKeyApproxBytes(key, SETTLED_ENTRY_APPROX_BYTES);
    if (approxBytes > this.limits.maxApproxBytes) {
      return;
    }

    this.deleteSettledEntry(key);
    this.settledEntries.set(key, { approxBytes, value });
    this.settledApproxBytes += approxBytes;
    this.evictSettledToLimits();
  }

  private evictSettledToLimits(): void {
    while (
      this.settledEntries.size > this.limits.maxEntries
      || this.settledApproxBytes > this.limits.maxApproxBytes
    ) {
      const oldestKey = this.settledEntries.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }
      this.deleteSettledEntry(oldestKey);
    }
  }

  private removeInFlightEntry(entry: InFlightExactPromptTokenCacheEntry): void {
    if (!this.allInFlightEntries.delete(entry)) {
      return;
    }

    if (this.currentInFlightEntries.get(entry.key) === entry) {
      this.currentInFlightEntries.delete(entry.key);
    }
    entry.attachedToCurrentEpoch = false;
    this.inFlightApproxBytes = Math.max(0, this.inFlightApproxBytes - entry.approxBytes);
  }

  private deleteSettledEntry(key: string): boolean {
    const entry = this.settledEntries.get(key);
    if (!entry || !this.settledEntries.delete(key)) {
      return false;
    }

    this.settledApproxBytes = Math.max(0, this.settledApproxBytes - entry.approxBytes);
    return true;
  }

  private clearSettledEntries(): void {
    this.settledEntries.clear();
    this.settledApproxBytes = 0;
  }
}

export const exactPromptTokenCache = new BoundedExactPromptTokenCache();
