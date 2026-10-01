import * as FileSystem from 'expo-file-system/legacy';
import { chatAttachmentProcessorRegistry, type ChatDocumentSessionContextSource } from './ChatAttachmentProcessorRegistry';
import { documentSessionContextCache } from './DocumentSessionContextCache';
import { assertOwnedRetrievalDocument, getOwnedRetrievalDocuments, retrievalDocumentOwnershipIdentity } from './DocumentRetrievalOwnership';
import type { DocumentRetrievalEntry } from './DocumentRetrievalService';
import { DOCUMENT_RETRIEVAL_LIMITS as LIMITS, DocumentRetrievalError } from '../types/documentRetrieval';
import { resolveChatDocumentMaxBytes, resolveChatProcessableDocumentMimeType } from '../utils/chatAttachments';

export interface LoadRetrievalDocumentsOptions {
  query: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  maxFileBytes: number;
  maxChars: number;
  maxChunks: number;
}

/** Re-open only explicitly owned files after restart; opaque handles never come from disk. */
export async function loadOwnedRetrievalDocuments(
  threadId: string, documentIds: readonly string[] | undefined, options: LoadRetrievalDocumentsOptions,
): Promise<{ entries: DocumentRetrievalEntry[]; truncated: boolean; release: () => Promise<void> }> {
  const available = getOwnedRetrievalDocuments(threadId);
  const requested = documentIds ? new Set(documentIds) : undefined;
  if (requested && [...requested].some(id => !available.some(document => document.id === id))) {
    throw new DocumentRetrievalError('ownership_changed');
  }
  const selected = available.filter(document => !requested || requested.has(document.id)).slice(0, LIMITS.documents);
  const maxFileBytesFor = (attachment: typeof selected[number]) => Math.min(options.maxFileBytes,
    resolveChatDocumentMaxBytes(resolveChatProcessableDocumentMimeType(attachment)));
  const sources = new Set<ChatDocumentSessionContextSource>();
  const check = () => {
    options.assertCurrent();
    if (options.signal?.aborted) throw new DocumentRetrievalError('cancelled');
    selected.forEach(document => assertOwnedRetrievalDocument(threadId, document));
  };
  const release = () => documentSessionContextCache.releaseResources([...sources].map(resource => ({ resource })));
  try {
    check();
    for (const attachment of selected) {
      const info = await FileSystem.getInfoAsync(attachment.localUri);
      check();
      if (!info.exists || info.isDirectory || info.size > maxFileBytesFor(attachment)) throw new DocumentRetrievalError('ownership_changed');
    }
    const cached = await documentSessionContextCache.selectThreadDocuments(threadId, options, new Set(selected.map(document => document.id)));
    check();
    const hits = new Map(cached.filter(hit => selected.some(document => retrievalDocumentOwnershipIdentity(document) === retrievalDocumentOwnershipIdentity(hit.attachment)))
      .map(hit => [hit.attachment.id, hit]));
    await documentSessionContextCache.reserveForIncomingDocuments(selected.length - hits.size, { threadId, attachmentIds: new Set(hits.keys()) });
    check();
    const entries: DocumentRetrievalEntry[] = [];
    for (const attachment of selected) {
      check();
      const hit = hits.get(attachment.id);
      const result = hit?.result ?? await chatAttachmentProcessorRegistry.processDocumentTextAttachment(attachment, {
        ...options, maxFileBytes: maxFileBytesFor(attachment), retainSessionContextSource: true,
        onSessionContextSourceCreated: source => { sources.add(source); },
      });
      if (!hit && result.sessionContextSource) sources.add(result.sessionContextSource);
      check();
      if (result.attachmentId !== attachment.id
        || (attachment.document.contentSha256 && result.contentSha256 !== attachment.document.contentSha256)
        || (attachment.document.contentHash && result.contentHash !== attachment.document.contentHash)) {
        throw new DocumentRetrievalError('ownership_changed');
      }
      entries.push({ attachment, result });
    }
    return { entries, truncated: available.filter(document => !requested || requested.has(document.id)).length > selected.length, release };
  } catch (error) {
    await release();
    throw error;
  }
}
