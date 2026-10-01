import { claimVerifiedAndroidQaRetrievalOrphanCheckpoint, runAndroidQaRetrievalCorpusOperation, waitForAndroidQaRetrievalIdle, type AndroidQaRetrievalCounters } from '../../src/services/AndroidQaRetrievalOperation';
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

describe('verified indexed QA orphan cleanup ownership', () => {
  const checkpoint = () => Object.freeze({ version: 1, stage: 'indexed', threadId: 'owned-qa-thread',
    evidence: Object.freeze({ status: 'ready_for_cold_reopen' }) });

  it('claims the same verified checkpoint for failure cleanup only after its thread is absent', () => {
    const saved = checkpoint();
    const threads = new Map<string, { title: string }>();
    expect(claimVerifiedAndroidQaRetrievalOrphanCheckpoint(saved, id => threads.get(id))).toBe(saved);
    expect(saved.evidence.status).toBe('ready_for_cold_reopen');
    expect(threads.size).toBe(0);
  });

  it.each(['Android document retrieval QA', 'Unrelated user conversation'])(
    'preserves an existing %s thread and its checkpoint without claiming orphan cleanup', title => {
      const saved = checkpoint();
      const live = Object.freeze({ title });
      const threads = new Map<string, { title: string }>([[saved.threadId, live]]);
      expect(claimVerifiedAndroidQaRetrievalOrphanCheckpoint(saved, id => threads.get(id))).toBeUndefined();
      expect(threads.get(saved.threadId)).toBe(live);
      expect(saved.evidence.status).toBe('ready_for_cold_reopen');
    },
  );

  it('revokes orphan cleanup when a thread appears before the cleanup/removal barrier', () => {
    const saved = checkpoint();
    const threads = new Map<string, { title: string }>();
    expect(claimVerifiedAndroidQaRetrievalOrphanCheckpoint(saved, id => threads.get(id))).toBe(saved);
    const newOwner = { title: 'Unrelated user conversation' };
    threads.set(saved.threadId, newOwner);
    expect(claimVerifiedAndroidQaRetrievalOrphanCheckpoint(saved, id => threads.get(id))).toBeUndefined();
    expect(threads.get(saved.threadId)).toBe(newOwner);
    expect(saved.evidence.status).toBe('ready_for_cold_reopen');
  });

  it.each([
    { version: 2 }, { stage: 'deleted' }, { threadId: '' }, { threadId: ' ' },
    { threadId: 'x'.repeat(257) },
  ])('does not claim a non-indexed or malformed checkpoint: %j', change => {
    const saved = { ...checkpoint(), ...change };
    const getThread = jest.fn(() => undefined);
    expect(claimVerifiedAndroidQaRetrievalOrphanCheckpoint(saved, getThread)).toBeUndefined();
    expect(getThread).not.toHaveBeenCalled();
  });
});

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


it('waits for an actual passive native operation to settle before admitting adapter application', async () => {
  const native = deferred(); let ownsNative = true;
  const actual = native.promise.finally(() => { ownsNative = false; });
  const apply = jest.fn(); const current = jest.fn();
  const operation = waitForAndroidQaRetrievalIdle({ isIdle: () => !ownsNative, assertCurrent: current,
    timeoutMs: 100, timeoutError: () => new Error('deadline') }).then(apply);
  await jest.advanceTimersByTimeAsync(50);
  expect(apply).not.toHaveBeenCalled(); expect(ownsNative).toBe(true);
  native.resolve(); await actual; await jest.advanceTimersByTimeAsync(25); await operation;
  expect(apply).toHaveBeenCalledTimes(1); expect(current).toHaveBeenCalled();
});

it('never admits adapter application after a passive-operation deadline without actual settlement', async () => {
  const native = deferred(); let ownsNative = true;
  const actual = native.promise.finally(() => { ownsNative = false; }); const apply = jest.fn();
  const operation = waitForAndroidQaRetrievalIdle({ isIdle: () => !ownsNative, assertCurrent: () => undefined,
    timeoutMs: 50, timeoutError: () => new Error('deadline') }).then(apply);
  const rejected = expect(operation).rejects.toThrow('deadline');
  await jest.advanceTimersByTimeAsync(50); await rejected;
  expect(ownsNative).toBe(true); expect(apply).not.toHaveBeenCalled();
  native.resolve(); await actual; await jest.advanceTimersByTimeAsync(25);
  expect(apply).not.toHaveBeenCalled();
});

it('rejects stale selection during an idle wait without admitting adapter application', async () => {
  let current = true; const apply = jest.fn();
  const operation = waitForAndroidQaRetrievalIdle({ isIdle: () => false,
    assertCurrent: () => { if (!current) throw new Error('stale'); },
    timeoutMs: 100, timeoutError: () => new Error('deadline') }).then(apply);
  const rejected = expect(operation).rejects.toThrow('stale');
  current = false; await jest.advanceTimersByTimeAsync(25); await rejected;
  expect(apply).not.toHaveBeenCalled();
});
