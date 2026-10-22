import type { CompletionParams, LlamaContext, ParallelStatus } from 'llama.rn';
import {
  normalizeCompletionResult, normalizeTokenData,
  type LlamaCompletionResult, type LlamaTokenData,
} from './LlamaRuntimeAdapter';

export type ParallelRequestState = 'admitting' | 'queued' | 'running' | 'cancelling'
  | 'completed' | 'cancelled' | 'error';
export interface ParallelRequestIdentity {
  readonly id: string;
  readonly ownerId: string;
  readonly modelId: string;
  readonly fileIdentity: string;
  readonly contextEpoch: number;
  readonly profileIdentity: string;
  readonly outputMode: string;
}
export interface ParallelCompletionHandle {
  readonly id: string;
  readonly identity: ParallelRequestIdentity;
  readonly state: ParallelRequestState;
  readonly nativeRequestId: number | undefined;
  /** Native result AND slot release, never a caller timeout or Stop acknowledgement. */
  readonly promise: Promise<LlamaCompletionResult>;
  cancel(): Promise<void>;
}
type ParallelConfiguration = { n_parallel: 1 | 2; n_batch: number };
type OwnedRequest = {
  nativeId?: number;
  running(): void;
  cancel?: () => Promise<void>;
  handle?: ParallelCompletionHandle;
  snapshot: string;
};
type ContextRequests = {
  requests: Map<string, OwnedRequest>;
  configuration?: ParallelConfiguration;
  changing: boolean;
  auxiliarySequence: number;
};
// Admission accounting only. Native llama.rn owns scheduling and slot assignment.
const contexts = new WeakMap<LlamaContext, ContextRequests>();
export const MAX_PARALLEL_REQUESTS = 6; // Two running plus four waiting, or one plus five.
function ledger(context: LlamaContext): ContextRequests {
  let value = contexts.get(context);
  if (!value) {
    value = { requests: new Map(), changing: false, auxiliarySequence: 0 };
    contexts.set(context, value);
  }
  return value;
}
function busy(): Error { return new Error('The native request queue is busy.'); }
function validId(id: number): boolean { return Number.isSafeInteger(id) && id >= 0; }
function assertStatus(status: ParallelStatus): void {
  if (!Number.isSafeInteger(status.active_slots) || status.active_slots < 0
    || !Number.isSafeInteger(status.queued_requests) || status.queued_requests < 0
    || !Array.isArray(status.requests)) throw new Error('Invalid native queue status.');
}
export function hasPendingParallelRequests(context: LlamaContext): boolean {
  const state = contexts.get(context);
  return Boolean(state && (state.changing || state.requests.size));
}
export async function getParallelContextStatus(context: LlamaContext): Promise<ParallelStatus> {
  const status = await context.parallel.getStatus();
  assertStatus(status);
  const state = ledger(context);
  for (const request of state.requests.values()) {
    const native = status.requests.find(item => item.request_id === request.nativeId);
    if (native?.state === 'processing_prompt' || native?.state === 'generating') request.running();
  }
  return status;
}
async function changeConfiguration(context: LlamaContext, config?: ParallelConfiguration): Promise<void> {
  const state = ledger(context);
  if (state.changing || state.requests.size) throw busy();
  if (config && state.configuration?.n_parallel === config.n_parallel
    && state.configuration.n_batch === config.n_batch) return;
  state.changing = true;
  try {
    // rc.3 getStatus rejects while disabled. The first enable is performed
    // under the engine's exclusive owner; later mutations also prove native idle.
    if (state.configuration) {
      const status = await getParallelContextStatus(context);
      if (status.active_slots !== 0 || status.queued_requests !== 0 || status.requests.length !== 0) throw busy();
    }
    if (config) {
      if ((config.n_parallel !== 1 && config.n_parallel !== 2)
        || !Number.isSafeInteger(config.n_batch) || config.n_batch < 1) throw new Error('Invalid native queue configuration.');
      const enabled = state.configuration
        ? await context.parallel.configure(config) : await context.parallel.enable(config);
      if (enabled === false) throw new Error('Native queue configuration was rejected.');
      state.configuration = { ...config };
    } else {
      if (!state.configuration) return;
      if (await context.parallel.disable() === false) throw new Error('Native queue shutdown was rejected.');
      state.configuration = undefined;
    }
  } finally { state.changing = false; }
}
export function enableParallelContext(context: LlamaContext, config: ParallelConfiguration): Promise<void> {
  return changeConfiguration(context, config);
}
export function disableParallelContext(context: LlamaContext): Promise<void> {
  return changeConfiguration(context);
}

/** Both terminal settlement and absence from the worker are needed before mutating context-wide state. */
async function waitForNativeRelease(context: LlamaContext, requestId: number): Promise<void> {
  for (;;) {
    try {
      const status = await getParallelContextStatus(context);
      if (validId(requestId)
        ? !status.requests.some(item => item.request_id === requestId)
        : status.active_slots === 0 && status.queued_requests === 0 && status.requests.length === 0) return;
    } catch {
      // Unknown native ownership remains retained. The engine's existing hard
      // watchdog quarantines it; a failed status read cannot authorize release.
    }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

export async function subscribeParallelStatus(
  context: LlamaContext, onStatus: (status: ParallelStatus) => void, isCurrent: () => boolean,
): Promise<() => void> {
  let removed = false;
  const current = () => {
    try { return isCurrent(); } catch { return false; }
  };
  const subscription = await context.parallel.subscribeToStatus(status => {
    if (removed || !current()) return;
    try {
      assertStatus(status);
      for (const request of ledger(context).requests.values()) {
        const native = status.requests.find(item => item.request_id === request.nativeId);
        if (native?.state === 'processing_prompt' || native?.state === 'generating') request.running();
      }
      onStatus(status);
    } catch { /* Never throw through a native status callback. */ }
  });
  const remove = () => {
    if (removed) return;
    removed = true;
    subscription.remove();
  };
  if (!current()) remove();
  return remove;
}

export function startParallelCompletion({ context, identity, params, onToken, onState }: {
  context: LlamaContext;
  identity: ParallelRequestIdentity;
  params: CompletionParams;
  onToken?: (data: LlamaTokenData) => void;
  onState?: (state: ParallelRequestState) => void;
}): ParallelCompletionHandle {
  const owner = ledger(context);
  // The formatter/tokenizer has already run under the engine reservation.
  if (params.messages || params.media_paths?.length || params.embedding) {
    throw new Error('The queued text path requires a prepared text prompt.');
  }
  if (params.n_predict === 0 || ['load_state_path', 'save_state_path', 'save_prompt_state_path',
    'load_state_size', 'save_state_size'].some(key => key in params)) {
    throw new Error('Prefill and state-file operations are unsupported in the queued text path.');
  }
  const frozenIdentity = Object.freeze({ ...identity });
  const preparedParams: CompletionParams = JSON.parse(JSON.stringify(params));
  const snapshot = JSON.stringify([frozenIdentity, preparedParams]); // Private, never logged.
  const existing = owner.requests.get(identity.id);
  if (existing) {
    if (existing.snapshot === snapshot && existing.handle) return existing.handle;
    throw new Error('Request identity is already owned.');
  }
  if (!owner.configuration || owner.changing || owner.requests.size >= MAX_PARALLEL_REQUESTS) throw busy();
  let state: ParallelRequestState = 'admitting';
  let cancelled = false;
  let terminal = false;
  let nativeSettled = false;
  let native: Awaited<ReturnType<LlamaContext['parallel']['completion']>> | undefined;
  let earlyId: number | undefined;
  let callbackError: unknown;
  let stopAck: Promise<void> | undefined;
  const transition = (next: ParallelRequestState) => {
    if (terminal || state === next) return;
    state = next;
    try { onState?.(next); } catch { /* Observers cannot abandon native ownership. */ }
  };
  const acknowledgeStop = (): Promise<void> => {
    if (!native || terminal) return Promise.resolve();
    stopAck ??= Promise.resolve().then(() => native!.stop());
    void stopAck.catch(() => undefined);
    return stopAck;
  };
  const request: OwnedRequest = {
    snapshot,
    running: () => { if (!cancelled) transition('running'); },
    cancel: () => {
      if (terminal) return Promise.resolve();
      cancelled = true;
      transition('cancelling');
      return acknowledgeStop();
    },
  };
  // Reserve before invoking native: callbacks may arrive before admission resolves.
  owner.requests.set(identity.id, request);
  const promise = (async () => {
    let result: LlamaCompletionResult | undefined;
    let failure: unknown;
    try {
      native = await context.parallel.completion(preparedParams, (id, data) => {
        if (terminal || nativeSettled || cancelled || callbackError) return;
        try {
          if (!validId(id) || (earlyId !== undefined && earlyId !== id)
            || (request.nativeId !== undefined && request.nativeId !== id)) {
            throw new Error('Native request identity mismatch.');
          }
          earlyId = id;
          request.running();
          onToken?.(normalizeTokenData(data));
        } catch (error) {
          callbackError = error;
          void request.cancel?.().catch(() => undefined);
        }
      });
      // Observe inner rejection before any await (including Stop/status).
      void native.promise.catch(() => undefined);
      request.nativeId = native.requestId;
      if (!validId(native.requestId) || (earlyId !== undefined && earlyId !== native.requestId)) {
        callbackError = new Error('Native request identity mismatch.');
        cancelled = true;
      }
      if (cancelled) void acknowledgeStop().catch(() => undefined);
      else if (state === 'admitting') transition('queued');
      try { result = normalizeCompletionResult(await native.promise); } catch (error) { failure = error; }
      nativeSettled = true;
      await waitForNativeRelease(context, native.requestId);
      // Acknowledgement is separate from terminal settlement; both are retained.
      try { await stopAck; } catch (error) { failure ??= error; }
      failure = callbackError ?? failure;
      if (failure !== undefined) throw failure;
      if (!result) throw new Error('Missing native completion result.');
      transition(cancelled ? 'cancelled' : 'completed');
      return cancelled ? { ...result, interrupted: true } : result;
    } catch (error) {
      if (!native) {
        // JSI can enqueue successfully and then fail while constructing/delivering
        // the admission handle. A rejected outer Promise alone proves no drain.
        // No public Stop handle exists here; retain ownership until the worker
        // releases the observed ID (or the whole queue when admission hid its ID).
        nativeSettled = true;
        request.nativeId = earlyId;
        await waitForNativeRelease(context, earlyId ?? -1);
      }
      transition(cancelled && !callbackError ? 'cancelled' : 'error');
      throw error;
    } finally {
      terminal = true;
      owner.requests.delete(identity.id);
    }
  })();
  // Callers may attach after admission callbacks. Avoid unhandled early rejection.
  void promise.catch(() => undefined);
  const handle: ParallelCompletionHandle = {
    id: identity.id, identity: frozenIdentity,
    get state() { return state; },
    get nativeRequestId() { return request.nativeId; },
    promise,
    cancel: request.cancel!,
  };
  request.handle = handle;
  return handle;
}

export async function cancelParallelCompletions(context: LlamaContext): Promise<void> {
  const results = await Promise.allSettled([...ledger(context).requests.values()].map(request => request.cancel?.()));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

async function runAuxiliaryRequest<T>(context: LlamaContext, kind: 'embedding' | 'rerank',
  admit: () => Promise<{ requestId: number; promise: Promise<T> }>): Promise<T> {
  const owner = ledger(context);
  if (owner.changing || !owner.configuration || owner.requests.size >= MAX_PARALLEL_REQUESTS) throw busy();
  const id = `${kind}:${++owner.auxiliarySequence}`;
  const request: OwnedRequest = { snapshot: kind, running: () => undefined };
  owner.requests.set(id, request);
  let admitted = false;
  try {
    const native = await admit();
    admitted = true;
    request.nativeId = native.requestId;
    void native.promise.catch(() => undefined);
    try { return await native.promise; }
    finally { await waitForNativeRelease(context, native.requestId); }
  } catch (error) {
    if (!admitted) await waitForNativeRelease(context, -1);
    throw error;
  } finally { owner.requests.delete(id); }
}
export function queuedEmbedding(context: LlamaContext, text: string,
  params: Parameters<LlamaContext['parallel']['embedding']>[1]) {
  return runAuxiliaryRequest(context, 'embedding', () => context.parallel.embedding(text, params));
}
export function queuedRerank(context: LlamaContext, query: string, documents: string[],
  params: Parameters<LlamaContext['parallel']['rerank']>[2]) {
  const snapshot = [...documents];
  return runAuxiliaryRequest(context, 'rerank', () => context.parallel.rerank(query, snapshot, params));
}
