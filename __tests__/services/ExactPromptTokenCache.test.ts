import {
  BoundedExactPromptTokenCache,
  buildExactPromptTokenCacheKey,
} from '../../src/services/ExactPromptTokenCache';
import type { LlmChatMessage } from '../../src/types/chat';
import { buildLlmInferenceMessagesSignature } from '../../src/utils/llmInferenceMessageSignature';

describe('BoundedExactPromptTokenCache', () => {
  it('shares one in-flight count and reuses the settled value for an identical key', async () => {
    const cache = new BoundedExactPromptTokenCache({ maxEntries: 4, maxApproxBytes: 4096 });
    let resolveCount: ((tokens: number) => void) | undefined;
    const count = jest.fn(() => new Promise<number>((resolve) => {
      resolveCount = resolve;
    }));

    const first = cache.getOrCreate('same-context-and-prompt', count);
    const concurrent = cache.getOrCreate('same-context-and-prompt', count);

    expect(first.hit).toBe(false);
    expect(concurrent.hit).toBe(true);
    expect(concurrent.promise).toBe(first.promise);
    expect(count).toHaveBeenCalledTimes(1);
    resolveCount?.(37);
    await expect(first.promise).resolves.toBe(37);
    await expect(concurrent.promise).resolves.toBe(37);
    first.release('success');
    concurrent.release('success');

    const settled = cache.getOrCreate('same-context-and-prompt', count);
    expect(settled.hit).toBe(true);
    await expect(settled.promise).resolves.toBe(37);
    settled.release('success');
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('never evicts active work when settled maxEntries pressure is one', async () => {
    const cache = new BoundedExactPromptTokenCache({ maxEntries: 1, maxApproxBytes: 4096 });
    let resolveA: ((tokens: number) => void) | undefined;
    const countA = jest.fn(() => new Promise<number>((resolve) => {
      resolveA = resolve;
    }));
    const countB = jest.fn(async () => 22);

    const firstA = cache.getOrCreate('a', countA);
    const firstB = cache.getOrCreate('b', countB);
    await expect(firstB.promise).resolves.toBe(22);
    firstB.release('success');

    const secondA = cache.getOrCreate('a', countA);
    expect(secondA.hit).toBe(true);
    expect(secondA.promise).toBe(firstA.promise);
    expect(countA).toHaveBeenCalledTimes(1);

    resolveA?.(11);
    await expect(firstA.promise).resolves.toBe(11);
    firstA.release('success');
    secondA.release('success');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.getDebugSnapshot()).toEqual(expect.objectContaining({
      currentInFlightEntryCount: 0,
      settledEntryCount: 1,
    }));
  });

  it('keeps a shared success when one waiter cancels and discards an unconsumed success', async () => {
    const cache = new BoundedExactPromptTokenCache({ maxEntries: 4, maxApproxBytes: 4096 });
    const count = jest.fn(async () => 43);
    const cancelledWaiter = cache.getOrCreate('shared', count);
    const successfulWaiter = cache.getOrCreate('shared', count);

    await expect(cancelledWaiter.promise).resolves.toBe(43);
    cancelledWaiter.release('discard');
    await expect(successfulWaiter.promise).resolves.toBe(43);
    successfulWaiter.release('success');

    const retained = cache.getOrCreate('shared', count);
    expect(retained.hit).toBe(true);
    await expect(retained.promise).resolves.toBe(43);
    retained.release('success');
    expect(count).toHaveBeenCalledTimes(1);

    let resolveCancelledOnly: ((tokens: number) => void) | undefined;
    const cancelledOnlyCount = jest.fn(() => new Promise<number>((resolve) => {
      resolveCancelledOnly = resolve;
    }));
    const unconsumed = cache.getOrCreate('cancelled-only', cancelledOnlyCount);
    unconsumed.release('discard');
    expect(cache.has('cancelled-only')).toBe(false);
    resolveCancelledOnly?.(47);
    await expect(unconsumed.promise).resolves.toBe(47);
    expect(cache.getDebugSnapshot().inFlightApproxBytes).toBe(0);
    const retryAfterDiscard = cache.getOrCreate('cancelled-only', count);
    expect(retryAfterDiscard.hit).toBe(false);
    await retryAfterDiscard.promise;
    retryAfterDiscard.release('success');
  });

  it('evicts rejected operations immediately so retries are not poisoned', async () => {
    const cache = new BoundedExactPromptTokenCache({ maxEntries: 4, maxApproxBytes: 4096 });
    const failure = new Error('native tokenize cancelled');
    const first = cache.getOrCreate('retryable', async () => {
      throw failure;
    });

    await expect(first.promise).rejects.toBe(failure);
    await Promise.resolve();
    expect(cache.snapshot()).toEqual({ entryCount: 0, approxBytes: 0 });

    const retry = cache.getOrCreate('retryable', async () => 41);
    expect(retry.hit).toBe(false);
    await expect(retry.promise).resolves.toBe(41);
    retry.release('success');
  });

  it('enforces LRU entry and approximate-byte bounds', async () => {
    const cache = new BoundedExactPromptTokenCache({ maxEntries: 2, maxApproxBytes: 4096 });

    const a = cache.getOrCreate('a', async () => 1);
    await a.promise;
    a.release('success');
    const b = cache.getOrCreate('b', async () => 2);
    await b.promise;
    b.release('success');
    const retainedA = cache.getOrCreate('a', async () => 10);
    expect(retainedA.hit).toBe(true);
    retainedA.release('success');
    const c = cache.getOrCreate('c', async () => 3);
    await c.promise;
    c.release('success');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.snapshot().entryCount).toBe(2);
    expect(cache.snapshot().approxBytes).toBeLessThanOrEqual(4096);

    const byteBounded = new BoundedExactPromptTokenCache({ maxEntries: 4, maxApproxBytes: 120 });
    const oversizedCount = jest.fn(async () => 9);
    const oversizedKey = 'x'.repeat(100);
    const firstOversized = byteBounded.getOrCreate(oversizedKey, oversizedCount);
    await expect(firstOversized.promise).resolves.toBe(9);
    firstOversized.release('success');
    const secondOversized = byteBounded.getOrCreate(oversizedKey, oversizedCount);
    await expect(secondOversized.promise).resolves.toBe(9);
    secondOversized.release('success');

    expect(oversizedCount).toHaveBeenCalledTimes(2);
    expect(byteBounded.snapshot()).toEqual({ entryCount: 0, approxBytes: 0 });
  });

  it('uses bounded admission without disturbing an admitted active request', async () => {
    const cache = new BoundedExactPromptTokenCache({
      maxEntries: 4,
      maxApproxBytes: 4096,
      maxInFlightEntries: 1,
      maxInFlightApproxBytes: 4096,
    });
    let resolveA: ((tokens: number) => void) | undefined;
    let resolveB: ((tokens: number) => void) | undefined;
    const countA = jest.fn(() => new Promise<number>((resolve) => {
      resolveA = resolve;
    }));
    const countB = jest.fn(() => new Promise<number>((resolve) => {
      resolveB = resolve;
    }));

    const firstA = cache.getOrCreate('a', countA);
    const uncachedB = cache.getOrCreate('b', countB);
    const secondA = cache.getOrCreate('a', countA);

    expect(uncachedB.hit).toBe(false);
    expect(secondA.hit).toBe(true);
    expect(secondA.promise).toBe(firstA.promise);
    expect(cache.getDebugSnapshot()).toEqual(expect.objectContaining({
      currentInFlightEntryCount: 1,
      inFlightApproxBytes: expect.any(Number),
    }));

    resolveB?.(2);
    await expect(uncachedB.promise).resolves.toBe(2);
    uncachedB.release('success');
    resolveA?.(1);
    await expect(firstA.promise).resolves.toBe(1);
    firstA.release('success');
    secondA.release('success');
    expect(countA).toHaveBeenCalledTimes(1);
    expect(countB).toHaveBeenCalledTimes(1);
  });

  it('runs an over-admission-size request uncached while keeping its promise usable', async () => {
    const cache = new BoundedExactPromptTokenCache({
      maxEntries: 4,
      maxApproxBytes: 4096,
      maxInFlightEntries: 4,
      maxInFlightApproxBytes: 120,
    });
    const count = jest.fn(async () => 19);
    const oversizedKey = 'x'.repeat(100);

    const lookup = cache.getOrCreate(oversizedKey, count);
    expect(lookup.hit).toBe(false);
    await expect(lookup.promise).resolves.toBe(19);
    lookup.release('success');
    expect(cache.snapshot()).toEqual({ entryCount: 0, approxBytes: 0 });
    expect(cache.getDebugSnapshot().inFlightApproxBytes).toBe(0);
  });

  it('invalidates settled values without mutating detached active consumers', async () => {
    const cache = new BoundedExactPromptTokenCache({
      maxEntries: 4,
      maxApproxBytes: 4096,
      maxInFlightEntries: 4,
      maxInFlightApproxBytes: 4096,
    });
    let resolveOld: ((tokens: number) => void) | undefined;
    let resolveFresh: ((tokens: number) => void) | undefined;
    const oldCount = jest.fn(() => new Promise<number>((resolve) => {
      resolveOld = resolve;
    }));
    const freshCount = jest.fn(() => new Promise<number>((resolve) => {
      resolveFresh = resolve;
    }));

    const oldFirst = cache.getOrCreate('same-key', oldCount);
    const oldConcurrent = cache.getOrCreate('same-key', oldCount);
    cache.invalidateContext();
    expect(cache.snapshot()).toEqual({ entryCount: 0, approxBytes: 0 });
    expect(cache.getDebugSnapshot().detachedInFlightEntryCount).toBe(1);

    const fresh = cache.getOrCreate('same-key', freshCount);
    expect(fresh.promise).not.toBe(oldFirst.promise);
    resolveFresh?.(22);
    await expect(fresh.promise).resolves.toBe(22);
    fresh.release('success');

    resolveOld?.(11);
    await expect(oldFirst.promise).resolves.toBe(11);
    await expect(oldConcurrent.promise).resolves.toBe(11);
    oldFirst.release('success');
    oldConcurrent.release('success');

    const retainedFresh = cache.getOrCreate('same-key', async () => 33);
    expect(retainedFresh.hit).toBe(true);
    await expect(retainedFresh.promise).resolves.toBe(22);
    retainedFresh.release('success');
    expect(oldCount).toHaveBeenCalledTimes(1);
    expect(freshCount).toHaveBeenCalledTimes(1);
    expect(cache.getDebugSnapshot().detachedInFlightEntryCount).toBe(0);
  });

  it('keeps detached pending work in in-flight admission accounting', async () => {
    const cache = new BoundedExactPromptTokenCache({
      maxEntries: 4,
      maxApproxBytes: 4096,
      maxInFlightEntries: 1,
      maxInFlightApproxBytes: 4096,
    });
    let resolveOld: ((tokens: number) => void) | undefined;
    const old = cache.getOrCreate('same-key', () => new Promise<number>((resolve) => {
      resolveOld = resolve;
    }));

    cache.invalidateContext();
    const freshUncached = cache.getOrCreate('same-key', async () => 22);

    expect(freshUncached.hit).toBe(false);
    expect(cache.getDebugSnapshot()).toEqual(expect.objectContaining({
      currentInFlightEntryCount: 0,
      detachedInFlightEntryCount: 1,
    }));
    await expect(freshUncached.promise).resolves.toBe(22);
    freshUncached.release('success');

    resolveOld?.(11);
    await expect(old.promise).resolves.toBe(11);
    old.release('success');
    expect(cache.getDebugSnapshot().inFlightApproxBytes).toBe(0);
  });

  it('misses for every native formatting identity that can change tokenization', async () => {
    const baseMessages: LlmChatMessage[] = [
      { role: 'system', content: 'Be concise.' },
      { role: 'system', content: 'Conversation summary: alpha' },
      { role: 'user', content: 'Hello' },
    ];
    const signature = (messages: LlmChatMessage[]) => buildLlmInferenceMessagesSignature(messages);
    const base = {
      contextIdentity: 'generation:1\u0001model:author/model-q4',
      modelId: 'author/model-q4',
      multimodalReadinessIdentity: 'author/model-q4\u0001ready\u0001projector-a\u0001vision',
      messageSignature: signature(baseMessages),
      enableThinking: false,
      reasoningFormat: 'none' as const,
      addGenerationPrompt: undefined,
    };
    const changedSystemPrompt = baseMessages.map((message, index) => (
      index === 0 ? { ...message, content: 'Answer in detail.' } : message
    ));
    const changedSummary = baseMessages.map((message, index) => (
      index === 1 ? { ...message, content: 'Conversation summary: beta' } : message
    ));
    const changedRole = baseMessages.map((message, index) => (
      index === 2 ? { ...message, role: 'assistant' as const } : message
    ));
    const changedAttachment: LlmChatMessage[] = baseMessages.map((message, index) => (
      index === 2 ? { ...message, mediaPaths: ['file:///chat-attachments/image-b.jpg'] } : message
    ));
    const changedContentPart: LlmChatMessage[] = baseMessages.map((message, index) => (
      index === 2
        ? {
            ...message,
            contentParts: [{
              type: 'input_audio' as const,
              input_audio: { format: 'mp3', url: 'file:///chat-attachments/audio-b.mp3' },
            }],
          }
        : message
    ));
    const variantInputs = [
      { ...base, contextIdentity: 'generation:2\u0001model:author/model-q4' },
      { ...base, contextIdentity: 'generation:3\u0001model:author/model-q4' },
      {
        ...base,
        contextIdentity: 'generation:4\u0001model:other/model-q4',
        modelId: 'other/model-q4',
      },
      { ...base, messageSignature: signature(changedSystemPrompt) },
      { ...base, messageSignature: signature(changedSummary) },
      { ...base, messageSignature: signature(changedRole) },
      { ...base, messageSignature: signature(changedAttachment) },
      { ...base, messageSignature: signature(changedContentPart) },
      { ...base, enableThinking: true, reasoningFormat: 'auto' as const },
      { ...base, enableThinking: true, reasoningFormat: 'deepseek' as const },
      { ...base, addGenerationPrompt: false },
      { ...base, allowMediaFallback: true },
      {
        ...base,
        multimodalReadinessIdentity: 'author/model-q4\u0001ready\u0001projector-b\u0001vision',
      },
    ];

    const cache = new BoundedExactPromptTokenCache({ maxEntries: 32, maxApproxBytes: 32 * 1024 });
    const nativeCount = jest.fn(async () => 17);
    const baseKey = buildExactPromptTokenCacheKey(base);
    expect(baseKey).not.toContain('Be concise.');
    expect(baseKey).not.toContain('Conversation summary: alpha');

    const baseLookup = cache.getOrCreate(baseKey, nativeCount);
    expect(baseLookup.hit).toBe(false);
    await baseLookup.promise;
    baseLookup.release('success');
    const cachedBaseLookup = cache.getOrCreate(baseKey, nativeCount);
    expect(cachedBaseLookup.hit).toBe(true);
    cachedBaseLookup.release('success');

    for (const input of variantInputs) {
      const lookup = cache.getOrCreate(buildExactPromptTokenCacheKey(input), nativeCount);
      expect(lookup.hit).toBe(false);
      await lookup.promise;
      lookup.release('success');
    }

    expect(nativeCount).toHaveBeenCalledTimes(variantInputs.length + 1);
  });
});
