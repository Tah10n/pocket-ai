import type { LlamaContext, NativeCompletionResult, ParallelStatus, TokenData } from 'llama.rn';
import {
  startParallelCompletion, enableParallelContext, disableParallelContext,
  hasPendingParallelRequests, subscribeParallelStatus, queuedEmbedding, queuedRerank,
  getParallelContextStatus, type ParallelRequestIdentity,
} from '../../src/services/LlamaParallelRequests';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const result = (text: string): NativeCompletionResult => ({ text, content: text } as NativeCompletionResult);
const identity = (id: string, epoch = 1): ParallelRequestIdentity => ({
  id, ownerId: 'chat-a', modelId: 'model-a', fileIdentity: 'sha:a', contextEpoch: epoch,
  profileIdentity: 'cpu:lora-a:1', outputMode: 'text',
});
function fixture() {
  const pending: {
    admission: ReturnType<typeof deferred<Awaited<ReturnType<LlamaContext['parallel']['completion']>> >>;
    terminal: ReturnType<typeof deferred<NativeCompletionResult>>;
    token?: (id: number, data: TokenData) => void;
    stop: jest.Mock<Promise<void>, []>;
  }[] = [];
  let status: ParallelStatus = { n_parallel: 2, active_slots: 0, queued_requests: 0, requests: [] };
  const parallel = {
    enable: jest.fn(async () => true), configure: jest.fn(async () => true),
    disable: jest.fn(async () => true), getStatus: jest.fn(async () => status),
    subscribeToStatus: jest.fn<Promise<{ remove: () => void }>, [(value: ParallelStatus) => void]>(
      async () => ({ remove: jest.fn() })),
    completion: jest.fn((_params, token?: (id: number, data: TokenData) => void) => {
      const admission = deferred<Awaited<ReturnType<LlamaContext['parallel']['completion']>>>();
      const terminal = deferred<NativeCompletionResult>();
      void terminal.promise.catch(() => undefined);
      const stop = jest.fn(async () => undefined);
      pending.push({ admission, terminal, token, stop });
      return admission.promise;
    }),
    embedding: jest.fn(), rerank: jest.fn(),
  };
  const context = { parallel } as unknown as LlamaContext;
  const admit = (index: number, id = index + 1) => pending[index].admission.resolve({
    requestId: id, promise: pending[index].terminal.promise, stop: pending[index].stop,
  });
  return { context, parallel, pending, admit, setStatus: (next: ParallelStatus) => { status = next; } };
}
async function ready() {
  const value = fixture();
  await enableParallelContext(value.context, { n_parallel: 2, n_batch: 512 });
  return value;
}

describe('official queue ownership and admission', () => {
  it('rejects zero-output prefill and excluded state-file operations before admission', async () => {
    const f = await ready();
    for (const extra of [{ n_predict: 0 }, { load_state_path: '/state' }, { save_state_path: '/state' },
      { save_prompt_state_path: '/state' }, { load_state_size: 1 }, { save_state_size: 1 }]) {
      expect(() => startParallelCompletion({ context: f.context, identity: identity('unsupported'),
        params: { prompt: 'A', ...extra } })).toThrow('unsupported');
    }
    expect(f.parallel.completion).not.toHaveBeenCalled();
    expect(hasPendingParallelRequests(f.context)).toBe(false);
  });

  it('does not report a rejected configuration or shutdown as successful', async () => {
    const f = fixture();
    f.parallel.enable.mockResolvedValueOnce(false);
    await expect(enableParallelContext(f.context, { n_parallel: 1, n_batch: 512 })).rejects.toThrow('rejected');
    expect(() => startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' } })).toThrow('busy');
    await enableParallelContext(f.context, { n_parallel: 1, n_batch: 512 });
    f.parallel.configure.mockResolvedValueOnce(false);
    await expect(enableParallelContext(f.context, { n_parallel: 2, n_batch: 512 })).rejects.toThrow('rejected');
    f.parallel.disable.mockResolvedValueOnce(false);
    await expect(disableParallelContext(f.context)).rejects.toThrow('rejected');
    await disableParallelContext(f.context);
  });

  it.each(['completion', 'embedding', 'rerank'] as const)('retains %s when admission rejects after native enqueue', async kind => {
    jest.useFakeTimers();
    try {
      const f = await ready();
      const busyStatus: ParallelStatus = { n_parallel: 2, active_slots: 0, queued_requests: 1,
        requests: [{ request_id: 7, type: kind, state: 'queued', prompt_length: 1,
          tokens_generated: 0, prompt_ms: 0, generation_ms: 0, tokens_per_second: 0 }] };
      f.setStatus(busyStatus);
      let pending: Promise<unknown>;
      if (kind === 'completion') {
        const handle = startParallelCompletion({ context: f.context, identity: identity('lost-admission'), params: { prompt: 'A' } });
        f.pending[0].token?.(7, { token: 'early' });
        pending = handle.promise;
        f.pending[0].admission.reject(new Error('admission_delivery_failed'));
      } else {
        f.parallel[kind].mockRejectedValue(new Error('admission_delivery_failed'));
        pending = kind === 'embedding' ? queuedEmbedding(f.context, 'document', {})
          : queuedRerank(f.context, 'query', ['document'], {});
      }
      const rejected = expect(pending).rejects.toThrow('admission_delivery_failed');
      await tick();
      expect(hasPendingParallelRequests(f.context)).toBe(true);
      await expect(disableParallelContext(f.context)).rejects.toThrow('busy');
      f.setStatus({ n_parallel: 2, active_slots: 0, queued_requests: 0, requests: [] });
      await jest.advanceTimersByTimeAsync(100);
      await rejected;
      expect(hasPendingParallelRequests(f.context)).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  it('contains a throwing owner predicate and removes the late subscription', async () => {
    const f = await ready(); const remove = jest.fn(); const observer = jest.fn();
    const gate = deferred<{ remove: () => void }>();
    f.parallel.subscribeToStatus.mockReturnValue(gate.promise);
    const pending = subscribeParallelStatus(f.context, observer, () => { throw new Error('owner_unavailable'); });
    expect(() => f.parallel.subscribeToStatus.mock.calls[0][0]({ n_parallel: 2, active_slots: 0, queued_requests: 0, requests: [] })).not.toThrow();
    gate.resolve({ remove }); await pending;
    expect(remove).toHaveBeenCalledTimes(1); expect(observer).not.toHaveBeenCalled();
  });

  it('captures independent prepared schema/grammar, stops and parser snapshots before admission', async () => {
    const f = await ready();
    const schema = { prompt: 'same frozen history', json_schema: '{"type":"object"}',
      grammar: '', chat_parser: '', generation_prompt: '', stop: ['schema-stop'], now: 123 };
    const grammar = { prompt: 'same frozen history', grammar: 'root ::= "yes"',
      chat_parser: 'parser-b', generation_prompt: 'prefix-b', stop: ['grammar-stop'], now: 123 };
    const a = startParallelCompletion({ context: f.context, identity: { ...identity('a'), outputMode: 'json_schema' }, params: schema });
    const b = startParallelCompletion({ context: f.context, identity: { ...identity('b'), outputMode: 'gbnf' }, params: grammar });
    schema.stop.push('mutated'); grammar.grammar = 'mutated';
    expect(f.parallel.completion.mock.calls[0][0]).toMatchObject({ json_schema: '{"type":"object"}', grammar: '', stop: ['schema-stop'], now: 123 });
    expect(f.parallel.completion.mock.calls[1][0]).toMatchObject({ grammar: 'root ::= "yes"', chat_parser: 'parser-b', stop: ['grammar-stop'], now: 123 });
    f.admit(0); f.admit(1); f.pending[0].terminal.resolve(result('{}')); f.pending[1].terminal.resolve(result('yes'));
    await Promise.all([a.promise, b.promise]);
  });

  it('contains a throwing token observer, stops only its request, and waits for actual terminal', async () => {
    const f = await ready();
    const a = startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' }, onToken: () => { throw new Error('observer_failed'); } });
    const b = startParallelCompletion({ context: f.context, identity: identity('b'), params: { prompt: 'B' } });
    expect(() => f.pending[0].token?.(1, { token: 'a' })).not.toThrow();
    f.admit(0); f.admit(1); await tick();
    expect(f.pending[0].stop).toHaveBeenCalledTimes(1); expect(f.pending[1].stop).not.toHaveBeenCalled();
    expect(hasPendingParallelRequests(f.context)).toBe(true);
    f.pending[0].terminal.resolve(result('partial')); f.pending[1].terminal.resolve(result('B'));
    await expect(a.promise).rejects.toThrow('observer_failed'); await b.promise;
  });

  it('retains a still-pending stop acknowledgement even after native result and idle receipt', async () => {
    const f = await ready(); const ack = deferred<void>();
    const job = startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' } });
    f.pending[0].stop.mockReturnValue(ack.promise); f.admit(0); await tick();
    const stop = job.cancel(); f.pending[0].terminal.resolve(result('partial')); await tick();
    expect(hasPendingParallelRequests(f.context)).toBe(true);
    ack.resolve(); await stop; await job.promise;
    expect(hasPendingParallelRequests(f.context)).toBe(false);
  });

  it('binds early callbacks to their captured app identity and isolates out-of-order terminals', async () => {
    const f = await ready(); const a = jest.fn(); const b = jest.fn();
    const first = startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' }, onToken: a });
    const second = startParallelCompletion({ context: f.context, identity: identity('b'), params: { prompt: 'B' }, onToken: b });
    f.pending[1].token?.(12, { token: 'b', requestId: 12 });
    f.pending[0].token?.(11, { token: 'a', requestId: 11 });
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ token: 'a' }));
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ token: 'b' }));
    f.admit(1, 12); f.admit(0, 11);
    f.pending[1].terminal.resolve(result('second'));
    await expect(second.promise).resolves.toMatchObject({ content: 'second' });
    expect(hasPendingParallelRequests(f.context)).toBe(true);
    f.pending[0].terminal.resolve(result('first'));
    await expect(first.promise).resolves.toMatchObject({ content: 'first' });
    f.pending[0].terminal.resolve(result('duplicate'));
    f.pending[0].token?.(11, { token: 'late' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(hasPendingParallelRequests(f.context)).toBe(false);
  });

  it('retains Stop before ID through acknowledgement, terminal result and native release', async () => {
    jest.useFakeTimers();
    try {
      const f = await ready(); const tokens = jest.fn();
      const job = startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' }, onToken: tokens });
      await job.cancel(); expect(job.state).toBe('cancelling');
      expect(f.pending[0].stop).not.toHaveBeenCalled();
      f.admit(0); await tick(); expect(f.pending[0].stop).toHaveBeenCalledTimes(1);
      expect(hasPendingParallelRequests(f.context)).toBe(true);
      f.pending[0].token?.(1, { token: 'late' }); expect(tokens).not.toHaveBeenCalled();
      f.setStatus({ n_parallel: 2, active_slots: 1, queued_requests: 0, requests: [{ request_id: 1,
        type: 'completion', state: 'generating', prompt_length: 2, tokens_generated: 1,
        prompt_ms: 1, generation_ms: 1, tokens_per_second: 1 }] });
      f.pending[0].terminal.resolve(result('partial')); await tick();
      expect(hasPendingParallelRequests(f.context)).toBe(true);
      await expect(disableParallelContext(f.context)).rejects.toThrow('busy');
      f.setStatus({ n_parallel: 2, active_slots: 0, queued_requests: 0, requests: [] });
      await jest.advanceTimersByTimeAsync(100);
      await expect(job.promise).resolves.toMatchObject({ content: 'partial', interrupted: true });
      expect(job.state).toBe('cancelled');
      await disableParallelContext(f.context); expect(f.parallel.disable).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });

  it.each(['queued', 'running'] as const)('cancels only the %s request; the neighboring slot succeeds', async state => {
    const f = await ready();
    const a = startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' } });
    const b = startParallelCompletion({ context: f.context, identity: identity('b'), params: { prompt: 'B' } });
    f.admit(0); f.admit(1); await tick();
    if (state === 'running') f.pending[0].token?.(1, { token: 'a' });
    expect(a.state).toBe(state);
    await a.cancel(); await a.cancel();
    expect(f.pending[0].stop).toHaveBeenCalledTimes(1); expect(f.pending[1].stop).not.toHaveBeenCalled();
    f.pending[0].terminal.resolve(result('')); f.pending[1].terminal.resolve(result('B'));
    await a.promise; await expect(b.promise).resolves.toMatchObject({ content: 'B' });
    expect(b.state).toBe('completed');
  });

  it('rejects admission without leaking a reservation and deduplicates repeated app IDs', async () => {
    const f = await ready(); const states = jest.fn();
    const args = { context: f.context, identity: identity('a'), params: { prompt: 'A' }, onState: states };
    const job = startParallelCompletion(args);
    expect(startParallelCompletion(args)).toBe(job);
    expect(f.parallel.completion).toHaveBeenCalledTimes(1);
    f.pending[0].admission.reject(new Error('admission_failed'));
    await expect(job.promise).rejects.toThrow('admission_failed');
    expect(states).toHaveBeenCalledTimes(1); expect(job.state).toBe('error');
    expect(hasPendingParallelRequests(f.context)).toBe(false);
  });

  it('limits admitted work and does not reconfigure over pending admission', async () => {
    const f = await ready();
    const jobs = Array.from({ length: 6 }, (_, i) => startParallelCompletion({ context: f.context, identity: identity(`${i}`), params: { prompt: 'A' } }));
    expect(() => startParallelCompletion({ context: f.context, identity: identity('overflow'), params: { prompt: 'B' } })).toThrow('busy');
    await expect(enableParallelContext(f.context, { n_parallel: 1, n_batch: 512 })).rejects.toThrow('busy');
    f.pending.forEach((pending, index) => { f.admit(index); pending.terminal.resolve(result('done')); });
    await Promise.all(jobs.map(job => job.promise));
    await enableParallelContext(f.context, { n_parallel: 1, n_batch: 512 });
    expect(f.parallel.configure).toHaveBeenCalledWith({ n_parallel: 1, n_batch: 512 });
  });

  it('does not release ownership when acknowledgement resolves but terminal never arrives', async () => {
    const f = await ready();
    const job = startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' } });
    f.admit(0); await tick(); await job.cancel();
    await getParallelContextStatus(f.context); // idle snapshot alone is not a terminal result.
    expect(hasPendingParallelRequests(f.context)).toBe(true);
    await expect(disableParallelContext(f.context)).rejects.toThrow('busy');
    f.pending[0].terminal.resolve(result('')); await job.promise;
  });

  it('keeps reused native IDs isolated in different context epochs', async () => {
    const a = await ready(); const b = await ready(); const receive = jest.fn();
    const first = startParallelCompletion({ context: a.context, identity: identity('same', 1), params: { prompt: 'old' } });
    a.admit(0, 0); a.pending[0].terminal.resolve(result('old')); await first.promise;
    const second = startParallelCompletion({ context: b.context, identity: identity('same', 2), params: { prompt: 'new' }, onToken: receive });
    b.admit(0, 0); a.pending[0].token?.(0, { token: 'stale' }); b.pending[0].token?.(0, { token: 'current' });
    b.pending[0].terminal.resolve(result('new')); await second.promise;
    expect(receive).toHaveBeenCalledTimes(1); expect(receive).toHaveBeenCalledWith(expect.objectContaining({ token: 'current' }));
  });

  it('drains a failed slot without cancelling its neighbor', async () => {
    const f = await ready();
    const a = startParallelCompletion({ context: f.context, identity: identity('a'), params: { prompt: 'A' } });
    const b = startParallelCompletion({ context: f.context, identity: identity('b'), params: { prompt: 'B' } });
    f.admit(0); f.admit(1); f.pending[0].terminal.reject(new Error('sampler_failed')); f.pending[1].terminal.resolve(result('B'));
    await expect(a.promise).rejects.toThrow('sampler_failed'); await expect(b.promise).resolves.toMatchObject({ content: 'B' });
    expect(f.pending[1].stop).not.toHaveBeenCalled();
  });

  it('removes a subscription acquired after owner invalidation and ignores late status', async () => {
    const f = await ready(); let current = true; const onStatus = jest.fn(); const remove = jest.fn();
    const gate = deferred<{ remove: () => void }>(); f.parallel.subscribeToStatus.mockReturnValue(gate.promise);
    const pending = subscribeParallelStatus(f.context, onStatus, () => current);
    current = false; gate.resolve({ remove }); const unsubscribe = await pending;
    unsubscribe(); expect(remove).toHaveBeenCalledTimes(1);
    f.parallel.subscribeToStatus.mock.calls[0][0]({ n_parallel: 2, active_slots: 0, queued_requests: 0, requests: [] });
    expect(onStatus).not.toHaveBeenCalled();
  });

  it.each(['embedding', 'rerank'] as const)('retains queued %s through separate admission and failing terminal', async kind => {
    const f = await ready(); const terminal = deferred<never>(); const admission = deferred<{ requestId: number; promise: Promise<never> }>();
    f.parallel[kind].mockReturnValue(admission.promise);
    const pending = kind === 'embedding' ? queuedEmbedding(f.context, 'document', { embd_normalize: 2 })
      : queuedRerank(f.context, 'query', ['document'], { normalize: -1 });
    const check = expect(pending).rejects.toThrow('native_failed');
    expect(hasPendingParallelRequests(f.context)).toBe(true);
    admission.resolve({ requestId: 7, promise: terminal.promise }); await tick();
    expect(hasPendingParallelRequests(f.context)).toBe(true);
    terminal.reject(new Error('native_failed')); await check;
    expect(hasPendingParallelRequests(f.context)).toBe(false);
  });
});
