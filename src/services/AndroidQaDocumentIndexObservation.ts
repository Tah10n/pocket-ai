import { isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';

export type AndroidQaDocumentIndexNativeEvent = {
  operation: 'embedding' | 'rerank'; phase: 'started' | 'settled'; kind?: 'query' | 'document';
};
export type AndroidQaDocumentIndexCounters = {
  documentEmbeddings: number; queryEmbeddings: number; rerankCalls: number;
  nativeStarted: number; nativeSettled: number; restored: number;
};
let observer: ((event: AndroidQaDocumentIndexNativeEvent | 'restored') => void) | undefined;
export const isAndroidQaDocumentIndexObservationActive = () => !!observer && isAndroidQaDocumentModelBootstrapEnabled();

/** Explicit isolated QA records counts only, never text, vectors, paths or scores. */
export function recordAndroidQaDocumentIndexNativeOperation(event: AndroidQaDocumentIndexNativeEvent | 'restored'): void {
  if (isAndroidQaDocumentIndexObservationActive()) observer?.(event);
}
export function observeAndroidQaDocumentIndexNativeOperations(
  onStarted?: (event: AndroidQaDocumentIndexNativeEvent) => void,
): { counters: AndroidQaDocumentIndexCounters; release: () => void } {
  if (observer) throw new Error('Document publication QA observation is already owned.');
  const counters = { documentEmbeddings: 0, queryEmbeddings: 0, rerankCalls: 0, nativeStarted: 0, nativeSettled: 0, restored: 0 };
  const owned = (event: AndroidQaDocumentIndexNativeEvent | 'restored') => {
    if (event === 'restored') { counters.restored++; return; }
    if (event.phase === 'started') {
      counters.nativeStarted++;
      if (event.operation === 'rerank') counters.rerankCalls++;
      else if (event.kind === 'document') counters.documentEmbeddings++; else counters.queryEmbeddings++;
      onStarted?.(event);
    } else counters.nativeSettled++;
  };
  observer = owned;
  return { counters, release: () => { if (observer === owned) observer = undefined; } };
}
