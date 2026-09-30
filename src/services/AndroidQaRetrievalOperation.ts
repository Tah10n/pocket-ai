import { DocumentRetrievalError } from '../types/documentRetrieval';
import type { RetrievalRuntimeOptions } from './DocumentRetrievalRuntime';
import type { useChatStore } from '../store/chatStore';

export interface AndroidQaRetrievalCounters {
  documentEmbeddings: number; queryEmbeddings: number; rerankCalls: number;
  nativeStarted: number; nativeSettled: number; restored: number; nativeIndices: number[];
}

/**
 * The QA tool model is loaded without adapters. Commit that same profile through
 * the ordinary atomic selection contract so cold auto-load sees no prior-base LoRA.
 */
export function commitAndroidQaRetrievalToolModelSelection(
  store: Pick<ReturnType<typeof useChatStore.getState>, 'getThread' | 'commitThreadModelSelection'>,
  threadId: string, expectedCurrentModelId: string, nextModelId: string,
): boolean {
  const thread = store.getThread(threadId);
  return !!thread && store.commitThreadModelSelection({
    threadId, expectedCurrentModelId, nextModelId, loraSnapshot: [], paramsSnapshot: thread.paramsSnapshot,
  }).status === 'applied';
}

/**
 * Passive prompt counting may start after A is restored. Admit the next QA action
 * only after actual ownership clears; a deadline never proves native settlement.
 */
export async function waitForAndroidQaRetrievalIdle(options: {
  isIdle: () => boolean; assertCurrent: () => void; timeoutMs: number; timeoutError: () => Error;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    options.assertCurrent();
    if (options.isIdle()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw options.timeoutError();
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
}

/** A QA deadline cancels future work; actual native settlement owns the source lease. */
export async function runAndroidQaRetrievalCorpusOperation<T>(
  loaded: { release: () => Promise<void> }, count: AndroidQaRetrievalCounters, assertSelectionCurrent: () => void,
  timeoutMs: number, operation: (guard: RetrievalRuntimeOptions) => Promise<T>,
  hooks: { quarantine: () => void; timeoutError: () => Error; signal?: AbortSignal;
    observe?: RetrievalRuntimeOptions['onNativeOperation'] },
): Promise<T> {
  const controller = new AbortController(); const abort = () => controller.abort();
  hooks.signal?.addEventListener('abort', abort); if (hooks.signal?.aborted) controller.abort();
  let finished = false; let notifyNativeDrain: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const actual = Promise.resolve().then(() => operation({ signal: controller.signal, assertSelectionCurrent,
    assertCurrent: () => { assertSelectionCurrent(); if (controller.signal.aborted) throw new DocumentRetrievalError('cancelled'); },
    onRestored: () => { count.restored++; },
    onNativeOperation: event => {
      if (event.phase === 'started') {
        count.nativeStarted++;
        if (event.operation === 'embedding') {
          if (event.kind === 'document') count.documentEmbeddings++; else count.queryEmbeddings++;
        } else count.rerankCalls++;
      } else {
        count.nativeSettled++;
        if (event.indices) count.nativeIndices = [...event.indices].slice(0, 8);
      }
      hooks.observe?.(event);
      if (count.nativeStarted === count.nativeSettled) notifyNativeDrain?.();
    },
  })).finally(() => { finished = true; });
  const release = async () => {
    if (count.nativeStarted !== count.nativeSettled) await new Promise<void>(resolve => { notifyNativeDrain = resolve; });
    await loaded.release();
  };
  try {
    return await Promise.race([actual, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(hooks.timeoutError()); }, timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort(); hooks.signal?.removeEventListener('abort', abort);
    if (finished && count.nativeStarted === count.nativeSettled) await release();
    else {
      // Retain opaque handles until the callback actually settles. An unknown drain
      // requires the host to force-stop this exact isolated QA process.
      hooks.quarantine();
      void actual.then(release, release).catch(() => undefined);
    }
  }
}
