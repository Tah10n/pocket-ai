import { useChatStore } from '../store/chatStore';
import { loadOwnedRetrievalDocuments } from './DocumentRetrievalDocuments';
import { retrieveDocumentCandidates } from './DocumentRetrievalService';
import { getOwnedRetrievalDocuments, retrievalDocumentOwnershipIdentity } from './DocumentRetrievalOwnership';
import { LOCAL_TOOL_LIMITS, utf8Bytes } from './LocalToolLimits';
import { DocumentRetrievalError, sanitizeDocumentRetrievalSettings, type DocumentRetrievalIssue } from '../types/documentRetrieval';

export interface DocumentToolSearchContext {
  threadId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  runOwner?: symbol;
  assertSelectionCurrent?: () => void;
  assertRestorationSelectionCurrent?: () => void;
}

export class DocumentToolSearchError extends Error {
  constructor(readonly category: 'document_unavailable' | 'cancelled') {
    super(category === 'cancelled' ? 'Tool operation was cancelled.' : 'Attached document is unavailable.');
    this.name = 'DocumentToolSearchError';
  }
}

export async function searchAttachedDocuments(
  query: string, documentIds: readonly string[] | undefined, context: DocumentToolSearchContext,
): Promise<{ untrusted: true; matches: object[]; truncated: boolean; retrievalMode?: string; fallbackReason?: DocumentRetrievalIssue }> {
  const initial = getOwnedRetrievalDocuments(context.threadId);
  const selected = initial.filter(document => !documentIds || documentIds.includes(document.id)).slice(0, LOCAL_TOOL_LIMITS.documentCount);
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener('abort', abort);
  const assertCurrent = () => {
    (context.assertSelectionCurrent ?? context.assertCurrent)();
    if (context.signal.aborted || controller.signal.aborted) throw new DocumentToolSearchError('cancelled');
    const live = getOwnedRetrievalDocuments(context.threadId);
    if (selected.some(document => !live.some(item => retrievalDocumentOwnershipIdentity(item) === retrievalDocumentOwnershipIdentity(document)))) {
      throw new DocumentToolSearchError('document_unavailable');
    }
  };
  const unsubscribe = useChatStore.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
  const assertRestorationSelectionCurrent = () => {
    (context.assertRestorationSelectionCurrent ?? context.assertSelectionCurrent ?? context.assertCurrent)();
    const live = getOwnedRetrievalDocuments(context.threadId);
    if (selected.some(document => !live.some(item => retrievalDocumentOwnershipIdentity(item) === retrievalDocumentOwnershipIdentity(document)))) {
      throw new DocumentToolSearchError('document_unavailable');
    }
  };
  let loaded: Awaited<ReturnType<typeof loadOwnedRetrievalDocuments>> | undefined;
  try {
    assertCurrent();
    const settings = sanitizeDocumentRetrievalSettings(useChatStore.getState().getThread(context.threadId)?.documentRetrieval);
    loaded = await loadOwnedRetrievalDocuments(context.threadId, documentIds, {
      query, maxChars: LOCAL_TOOL_LIMITS.documentExcerptCharacters * LOCAL_TOOL_LIMITS.documentChunks,
      maxChunks: LOCAL_TOOL_LIMITS.documentChunks, maxFileBytes: LOCAL_TOOL_LIMITS.documentFileBytes,
      signal: controller.signal, assertCurrent,
    });
    const retrieval = await retrieveDocumentCandidates(query, loaded.entries, settings, {
      threadId: context.threadId, signal: controller.signal, assertCurrent, assertSelectionCurrent: assertRestorationSelectionCurrent,
      runOwner: context.runOwner, prepareMissing: false,
    });
    assertCurrent();
    const queryTerms = new Set(query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const matches: object[] = [];
    let truncated = loaded.truncated;
    const metadata = settings.mode === 'hybrid' || settings.rerank
      ? { retrievalMode: retrieval.actualMode, ...(retrieval.fallbackReason ? { fallbackReason: retrieval.fallbackReason } : {}) } : {};
    for (const candidate of retrieval.candidates) {
      const chunk = candidate.chunk;
      if (retrieval.actualMode === 'lexical') {
        const terms = chunk.text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        if (!terms.some(term => queryTerms.has(term))) continue;
      }
      if (matches.length >= LOCAL_TOOL_LIMITS.documentChunks) { truncated = true; break; }
      const text = Array.from(chunk.text).slice(0, LOCAL_TOOL_LIMITS.documentExcerptCharacters).join('');
      const match = { documentId: candidate.attachmentId, chunkIndex: chunk.index, text,
        ...(chunk.pageNumber === undefined ? {} : { pageNumber: chunk.pageNumber }),
        ...(chunk.slideNumber === undefined ? {} : { slideNumber: chunk.slideNumber }),
        ...(chunk.sheetName === undefined ? {} : { sheetName: chunk.sheetName }),
        ...(chunk.sourceStart === undefined ? {} : { sourceStart: chunk.sourceStart }),
        ...(chunk.sourceEnd === undefined ? {} : { sourceEnd: chunk.sourceEnd }),
      };
      if (utf8Bytes(JSON.stringify({ untrusted: true, matches: [...matches, match], truncated: true, ...metadata })) > LOCAL_TOOL_LIMITS.resultBytes - 64) {
        truncated = true; break;
      }
      matches.push(match);
      truncated ||= text.length < chunk.text.length || Boolean(loaded.entries.find(entry => entry.attachment.id === candidate.attachmentId)?.result.truncated);
    }
    assertCurrent();
    return { untrusted: true, matches, truncated, ...metadata };
  } catch (error) {
    if (error instanceof DocumentRetrievalError && error.code === 'ownership_changed') throw new DocumentToolSearchError('document_unavailable');
    if (controller.signal.aborted || (error instanceof DocumentRetrievalError && error.code === 'cancelled')) throw new DocumentToolSearchError('cancelled');
    throw error;
  } finally {
    unsubscribe();
    context.signal.removeEventListener('abort', abort);
    await loaded?.release();
  }
}
