import { runAndroidQaRetrievalCorpusOperation, type AndroidQaRetrievalCounters } from '../../src/services/AndroidQaRetrievalOperation';
import type { RetrievalRuntimeOptions } from '../../src/services/DocumentRetrievalRuntime';

const counts = (): AndroidQaRetrievalCounters => ({ documentEmbeddings: 0, queryEmbeddings: 0, rerankCalls: 0,
  nativeStarted: 0, nativeSettled: 0, restored: 0, nativeIndices: [] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const nativeEvent = (guard: RetrievalRuntimeOptions, phase: 'started' | 'settled') =>
  guard.onNativeOperation?.({ operation: 'embedding', kind: 'query', phase, inputCount: 1 });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('retains the actual source lease after a deadline and blocks continuation until native settlement', async () => {
  const native = deferred(); const count = counts(); const release = jest.fn(async () => undefined);
  const quarantine = jest.fn(); const selection = jest.fn(); const nextPhase = jest.fn();
  let running!: RetrievalRuntimeOptions;
  const operation = runAndroidQaRetrievalCorpusOperation({ release }, count, selection, 10, async guard => {
    running = guard; nativeEvent(guard, 'started');
    try { await native.promise; guard.assertCurrent(); nextPhase(); }
    finally { nativeEvent(guard, 'settled'); }
  }, { quarantine, timeoutError: () => new Error('deadline') });
  const rejected = expect(operation).rejects.toThrow('deadline');
  await jest.advanceTimersByTimeAsync(10); await rejected;
  expect(running.signal?.aborted).toBe(true);
  expect(() => running.assertSelectionCurrent?.()).not.toThrow();
  expect(() => running.assertCurrent()).toThrow('cancelled');
  expect(quarantine).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  expect(count).toMatchObject({ nativeStarted: 1, nativeSettled: 0 });
  native.resolve(); await jest.advanceTimersByTimeAsync(0);
  expect(count.nativeSettled).toBe(1); expect(nextPhase).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it('keeps handles when the service rejects before an opaque native callback actually drains', async () => {
  const count = counts(); const release = jest.fn(async () => undefined); const quarantine = jest.fn();
  let running!: RetrievalRuntimeOptions;
  await expect(runAndroidQaRetrievalCorpusOperation({ release }, count, () => undefined, 100, async guard => {
    running = guard; nativeEvent(guard, 'started'); throw new Error('uncertain native drain');
  }, { quarantine, timeoutError: () => new Error('deadline') })).rejects.toThrow('uncertain native drain');
  expect(quarantine).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
  nativeEvent(running, 'settled'); await jest.advanceTimersByTimeAsync(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it('awaits an ordinary Stop drain before releasing the source and keeps stable restoration selection', async () => {
  const native = deferred(); const controller = new AbortController(); const count = counts();
  const release = jest.fn(async () => undefined); const quarantine = jest.fn(); const selection = jest.fn();
  const operation = runAndroidQaRetrievalCorpusOperation({ release }, count, selection, 100, async guard => {
    nativeEvent(guard, 'started');
    try { await native.promise; guard.assertSelectionCurrent?.(); guard.assertCurrent(); }
    finally { nativeEvent(guard, 'settled'); }
  }, { signal: controller.signal, quarantine, timeoutError: () => new Error('deadline') });
  const rejected = expect(operation).rejects.toThrow('cancelled');
  await jest.advanceTimersByTimeAsync(0); controller.abort();
  expect(release).not.toHaveBeenCalled();
  native.resolve(); await rejected;
  expect(count).toMatchObject({ nativeStarted: 1, nativeSettled: 1 });
  expect(selection).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(1);
  expect(quarantine).not.toHaveBeenCalled();
});
