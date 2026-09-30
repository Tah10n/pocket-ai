import type { DocumentRetrievalIssue } from '../types/documentRetrieval';

export type DocumentRetrievalStatus = {
  preparation?: { phase: 'preparing' | 'cancelling' | 'ready' | 'cancelled' | 'error'; attachmentId?: string; processed: number; total: number; reason?: DocumentRetrievalIssue };
  lastSearch?: { actualMode: 'lexical' | 'hybrid' | 'lexical+rerank' | 'hybrid+rerank'; fallbackReason?: DocumentRetrievalIssue };
};
const EMPTY: DocumentRetrievalStatus = Object.freeze({});
const states = new Map<string, DocumentRetrievalStatus>();
const listeners = new Set<() => void>();

export function getDocumentRetrievalStatus(threadId: string): DocumentRetrievalStatus { return states.get(threadId) ?? EMPTY; }
export function subscribeDocumentRetrievalStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function updateDocumentRetrievalStatus(threadId: string, patch: DocumentRetrievalStatus): void {
  states.set(threadId, { ...getDocumentRetrievalStatus(threadId), ...patch });
  while (states.size > 8) states.delete(states.keys().next().value!);
  listeners.forEach(listener => listener());
}
export function clearDocumentRetrievalStatus(threadId?: string): void {
  if (threadId) states.delete(threadId); else states.clear();
  listeners.forEach(listener => listener());
}
