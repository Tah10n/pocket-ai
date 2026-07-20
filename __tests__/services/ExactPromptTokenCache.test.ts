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

    const unconsumed = cache.getOrCreate('cancelled-only', count);
    await expect(unconsumed.promise).resolves.toBe(43);
    unconsumed.release('discard');
    expect(cache.has('cancelled-only')).toBe(false);
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
  });

  it('enforces LRU entry and approximate-byte bounds', async () => {
    const cache = new BoundedExactPromptTokenCache({ maxEntries: 2, maxApproxBytes: 4096 });

    await cache.getOrCreate('a', async () => 1).promise;
    await cache.getOrCreate('b', async () => 2).promise;
    expect(cache.getOrCreate('a', async () => 10).hit).toBe(true);
    await cache.getOrCreate('c', async () => 3).promise;

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.snapshot().entryCount).toBe(2);
    expect(cache.snapshot().approxBytes).toBeLessThanOrEqual(4096);

    const byteBounded = new BoundedExactPromptTokenCache({ maxEntries: 4, maxApproxBytes: 120 });
    const oversizedCount = jest.fn(async () => 9);
    const oversizedKey = 'x'.repeat(100);
    await byteBounded.getOrCreate(oversizedKey, oversizedCount).promise;
    await byteBounded.getOrCreate(oversizedKey, oversizedCount).promise;

    expect(oversizedCount).toHaveBeenCalledTimes(2);
    expect(byteBounded.snapshot()).toEqual({ entryCount: 0, approxBytes: 0 });
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

    expect(cache.getOrCreate(baseKey, nativeCount).hit).toBe(false);
    await cache.getOrCreate(baseKey, nativeCount).promise;
    expect(cache.getOrCreate(baseKey, nativeCount).hit).toBe(true);

    for (const input of variantInputs) {
      const lookup = cache.getOrCreate(buildExactPromptTokenCacheKey(input), nativeCount);
      expect(lookup.hit).toBe(false);
      await lookup.promise;
    }

    expect(nativeCount).toHaveBeenCalledTimes(variantInputs.length + 1);
  });
});
