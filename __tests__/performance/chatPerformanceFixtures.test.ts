import {
  buildPerformanceOutput,
  buildPerformanceThread,
  PERFORMANCE_FIXTURE_THREAD_ID,
} from '../fixtures/chatPerformanceFixtures';
import {
  captureReferenceSequence,
  countUnretainedItemReferences,
  createCountingAppStorage,
  getCounterDelta,
} from '../../testUtils';

describe('PR130 runtime performance fixtures', () => {
  it.each([20, 200, 1000] as const)(
    'builds exactly %i historical messages with deterministic identities',
    (historicalMessageCount) => {
      const first = buildPerformanceThread({ historicalMessageCount });
      const second = buildPerformanceThread({ historicalMessageCount });

      expect(first).toEqual(second);
      expect(first.id).toBe(PERFORMANCE_FIXTURE_THREAD_ID);
      expect(first.messages).toHaveLength(historicalMessageCount);
      expect(first.messages[0].id).toBe('message-history-0');
      expect(first.messages.at(-1)?.id).toBe(`message-history-${historicalMessageCount - 1}`);
    },
  );

  it.each(['image', 'audio', 'document', 'mixed'] as const)(
    'adds deterministic ready %s attachment history',
    (attachments) => {
      const thread = buildPerformanceThread({ historicalMessageCount: 20, attachments });
      const attachedMessages = thread.messages.filter((message) => message.attachments?.length);

      expect(attachedMessages).toHaveLength(10);
      expect(attachedMessages.every((message) => message.role === 'user')).toBe(true);
      expect(attachedMessages.every((message) => {
        const attachment = message.attachments?.[0];
        return Boolean(attachment && 'state' in attachment && attachment.state === 'ready');
      })).toBe(true);
    },
  );

  it('adds model-switch markers without changing the historical message count', () => {
    const thread = buildPerformanceThread({
      historicalMessageCount: 20,
      modelSwitchEvery: 5,
    });

    const modelSwitches = thread.messages.filter((message) => message.kind === 'model_switch');
    const historicalMessages = thread.messages.filter((message) => message.kind !== 'model_switch');

    expect(modelSwitches).toHaveLength(3);
    expect(historicalMessages).toHaveLength(20);
    expect(thread.messages).toHaveLength(23);
  });

  it.each(['delta', 'snapshot', 'mixed'] as const)(
    'builds reconstructable 8K-token-equivalent %s callbacks',
    (mode) => {
      const fixture = buildPerformanceOutput({
        kind: '8k-token-equivalent',
        callbackCount: 100,
        mode,
      });
      let reconstructed = '';

      for (const callback of fixture.callbacks) {
        if (callback.type === 'delta') {
          reconstructed += callback.value;
        } else {
          reconstructed = callback.value.accumulatedText ?? callback.value.content ?? reconstructed;
        }
      }

      expect(fixture.callbacks).toHaveLength(100);
      const tokenEquivalentUnits = fixture.tokenEquivalentUnits;
      expect(tokenEquivalentUnits).toBe(8_192);
      if (tokenEquivalentUnits === null) {
        throw new Error('8K-token-equivalent fixture did not expose its deterministic workload unit count');
      }
      expect(fixture.finalText.split(' ')).toHaveLength(tokenEquivalentUnits);
      expect(reconstructed).toBe(fixture.finalText);
    },
  );

  it('includes reasoning delimiters and Unicode in the reasoning output', () => {
    const fixture = buildPerformanceOutput({ kind: 'reasoning', callbackCount: 17 });

    expect(fixture.finalText).toContain('<think>');
    expect(fixture.finalText).toContain('</think>');
    expect(fixture.finalText).toContain('東京');
    expect(fixture.finalText).toContain('🧪');
    expect(fixture.callbacks.every((callback) => {
      const value = callback.type === 'delta'
        ? callback.value
        : callback.value.accumulatedText ?? callback.value.content ?? '';
      return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
    })).toBe(true);
  });

  it('provides deterministic reference, storage, byte, and counter probes', () => {
    const first = [{ id: 1 }, { id: 2 }];
    const references = captureReferenceSequence(first);
    const storageProbe = createCountingAppStorage();

    storageProbe.storage.set('chat-store:v2:thread:thread-a', 'é');
    storageProbe.storage.set('chat-store:v2:index', '{}');

    expect(references.array).toBe(first);
    expect(countUnretainedItemReferences(references.items, [{ id: 0 }, ...first])).toBe(0);
    expect(countUnretainedItemReferences(references.items, [first[0], { id: 2 }])).toBe(1);
    expect(storageProbe.snapshot()).toMatchObject({
      setCalls: 2,
      serializedBytes: 4,
      writesByKind: { thread: 1, index: 1 },
    });
    expect(getCounterDelta({ metric: 3 }, { metric: 8 }, 'metric')).toBe(5);
  });

  it('counts UTF-8 bytes deterministically when TextEncoder is unavailable', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: undefined,
    });

    try {
      const storageProbe = createCountingAppStorage();
      storageProbe.storage.set('unicode', 'é🧪');
      expect(storageProbe.snapshot().serializedBytes).toBe(6);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'TextEncoder', originalDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'TextEncoder');
      }
    }
  });
});
