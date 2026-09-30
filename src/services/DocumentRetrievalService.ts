import * as RNFS from 'react-native-fs';
import type { ChatAttachment } from '../types/attachments';
import {
  DocumentRetrievalError, sanitizeDocumentRetrievalSettings, DOCUMENT_RETRIEVAL_LIMITS as LIMITS,
  type DocumentRetrievalSettings, type DocumentIndexIdentity, type DocumentRetrievalIssue,
} from '../types/documentRetrieval';
import {
  resolveNativeDocumentSelectionQuery, rankDocumentContextCandidates, type DocumentContextChunk,
} from './DocumentContextService';
import type { ChatDocumentTextProcessorResult, ChatDocumentChunkPage } from './ChatAttachmentProcessorRegistry';
import { documentIndexStore, type PrivateDocumentIndex, type DocumentIndexRow } from './DocumentIndexStore';
import {
  embedDocumentRetrievalText, getDocumentRetrievalRuntimeIdentity, resolveRetrievalRuntimeBinding,
  runDocumentRetrievalRuntime, validateDocumentRerankPair, type RetrievalRuntimeOptions,
} from './DocumentRetrievalRuntime';
import {
  distributeDocumentCandidates, fuseDocumentCandidates, mapDocumentRerankResults,
  semanticDocumentCandidates, splitDocumentEmbeddingChunk, type DocumentRetrievalCandidate,
} from './DocumentRetrievalRanking';
import { fileUriToNativePath } from '../utils/safeFilePath';
import { normalizeSha256Digest } from '../utils/sha256';
import { isPrivateStorageWritable } from './storage';
import { assertOwnedRetrievalDocument, getOwnedRetrievalDocuments } from './DocumentRetrievalOwnership';
import { updateDocumentRetrievalStatus } from './DocumentRetrievalStatus';

export type DocumentRetrievalEntry = {
  attachment: Extract<ChatAttachment, { kind: 'document' }>;
  result: ChatDocumentTextProcessorResult;
};
export type ActualDocumentRetrievalMode = 'lexical' | 'hybrid' | 'lexical+rerank' | 'hybrid+rerank';
export interface DocumentRetrievalResult {
  candidates: DocumentRetrievalCandidate[];
  actualMode: ActualDocumentRetrievalMode;
  fallbackReason?: DocumentRetrievalIssue;
  /** Provisional new attachments are published only after their real chat ownership commits. */
  preparedIndexes: Map<string, PrivateDocumentIndex>;
}

/** A draft's vectors gain a durable scope only after the real message transaction commits. */
export async function publishPreparedDocumentIndexes(
  threadId: string, entries: readonly DocumentRetrievalEntry[], preparedIndexes: Map<string, PrivateDocumentIndex>,
  assertCurrent: () => void,
): Promise<void> {
  for (const [attachmentId, index] of preparedIndexes) {
    assertCurrent();
    const entry = entries.find(item => item.attachment.id === attachmentId);
    const attachment = getOwnedRetrievalDocuments(threadId).find(item => item.id === attachmentId);
    if (!entry || !attachment || normalizeSha256Digest(entry.result.contentSha256) !== index.identity.documentSha256) {
      throw new DocumentRetrievalError('ownership_changed');
    }
    const check = () => { assertCurrent(); assertOwnedRetrievalDocument(threadId, attachment); };
    check();
    const actualSha = normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(attachment.localUri), 'sha256'));
    check();
    if (actualSha !== index.identity.documentSha256) throw new DocumentRetrievalError('ownership_changed');
    await documentIndexStore.publish(threadId, attachmentId, index, check);
    preparedIndexes.delete(attachmentId);
  }
}
export interface DocumentRetrievalOptions extends RetrievalRuntimeOptions {
  threadId?: string;
  /** Tools cannot silently perform cold indexing inside their short operation deadline. */
  prepareMissing: boolean;
  /** An explicit prepare action indexes documents without inventing a search query. */
  preparationOnly?: boolean;
  /** Only the chat preparation transaction may authorize its not-yet-committed drafts. */
  assertProvisionalEntryCurrent?: (entry: DocumentRetrievalEntry) => void;
  onProgress?: (progress: { attachmentId: string; processed: number; totalStructuralChunks: number }) => void;
}

type IndexDocument = DocumentRetrievalEntry & {
  page: ChatDocumentChunkPage;
  identity: DocumentIndexIdentity;
  index: PrivateDocumentIndex | null;
};

function assertDocumentRetrievalCurrent(options: DocumentRetrievalOptions): void {
  options.assertCurrent();
  if (options.signal?.aborted) throw new DocumentRetrievalError('cancelled');
  if (!isPrivateStorageWritable()) throw new DocumentRetrievalError('ownership_changed');
}

/** One retrieval path for ordinary turns, follow-ups, branch replacement and local tools. */
export async function retrieveDocumentCandidates(
  query: string, entries: readonly DocumentRetrievalEntry[], requested: DocumentRetrievalSettings,
  options: DocumentRetrievalOptions,
): Promise<DocumentRetrievalResult> {
  const settings = sanitizeDocumentRetrievalSettings(requested);
  const check = () => {
    assertDocumentRetrievalCurrent(options);
    if (settings.mode === 'hybrid' || settings.rerank || options.preparationOnly) {
      for (const entry of entries) {
        if (options.threadId && entry.attachment.threadId === options.threadId) {
          assertOwnedRetrievalDocument(options.threadId, entry.attachment);
        } else if (options.assertProvisionalEntryCurrent) options.assertProvisionalEntryCurrent(entry);
        else throw new DocumentRetrievalError('ownership_changed');
      }
    }
  };
  check();
  const lexical = await rankDocumentContextCandidates(query, entries.map(entry => ({
    attachmentId: entry.attachment.id, displayName: entry.attachment.displayName ?? entry.attachment.fileName,
    canonicalFormat: entry.result.canonicalFormat, chunks: entry.result.chunks,
  })));
  check();
  const baseline: DocumentRetrievalResult = { candidates: lexical.slice(0, LIMITS.candidateCount), actualMode: 'lexical', preparedIndexes: new Map() };
  const report = (result: DocumentRetrievalResult): DocumentRetrievalResult => {
    if (options.threadId && !options.preparationOnly) updateDocumentRetrievalStatus(options.threadId, { lastSearch: { actualMode: result.actualMode, fallbackReason: result.fallbackReason } });
    return result;
  };
  // The original outline/start/middle/end overview remains authoritative, including empty queries.
  if (!entries.length || (!options.preparationOnly && ((!settings.rerank && settings.mode === 'lexical') || resolveNativeDocumentSelectionQuery(query) === ''))) return report(baseline);
  let restored = false;
  let nativeStarted = false;
  const runtimeOptions: RetrievalRuntimeOptions = { ...options,
    assertSelectionCurrent: () => {
      (options.assertSelectionCurrent ?? options.assertCurrent)();
      if (!isPrivateStorageWritable()) throw new DocumentRetrievalError('ownership_changed');
      for (const entry of entries) if (options.threadId && entry.attachment.threadId === options.threadId) {
        assertOwnedRetrievalDocument(options.threadId, entry.attachment);
      }
    },
    onRestored: receipt => { restored = true; options.onRestored?.(receipt); },
  };
  try {
    if (entries.length > LIMITS.documents) throw new DocumentRetrievalError('quota_exceeded');
    const embedding = settings.mode === 'hybrid' ? resolveRetrievalRuntimeBinding('embedding', runtimeOptions, options.prepareMissing) : undefined;
    const reranker = settings.rerank && !options.preparationOnly ? resolveRetrievalRuntimeBinding('reranker', runtimeOptions) : undefined;
    const documents: IndexDocument[] = [];
    for (const entry of entries) {
      const documentSha256 = normalizeSha256Digest(entry.result.contentSha256);
      if (!documentSha256) throw new DocumentRetrievalError('index_stale');
      const actualSha = normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(entry.attachment.localUri), 'sha256'));
      check();
      if (actualSha !== documentSha256) throw new DocumentRetrievalError('ownership_changed');
    }
    if (embedding) {
      const profile = embedding.profile;
      if (profile.pooling !== 'mean' || profile.dimensions === undefined) throw new DocumentRetrievalError('profile_unverified');
      for (const entry of entries) {
        check();
        const documentSha256 = normalizeSha256Digest(entry.result.contentSha256);
        if (!documentSha256 || !entry.result.sessionContextSource?.enumerateChunks) throw new DocumentRetrievalError('index_stale');
        const page = await entry.result.sessionContextSource.enumerateChunks({ signal: options.signal });
        check();
        if (!page.totalChunks || page.totalChunks > LIMITS.structuralChunks) throw new DocumentRetrievalError('quota_exceeded');
        const identity: DocumentIndexIdentity = {
          documentSha256, extractionIdentity: page.sourceIdentity,
          chunkingVersion: 'document-chunks-v1', preprocessingVersion: 'tokenizer-prose-subchunks-v1',
          modelSha256: profile.modelSha256, modelRevision: profile.modelRevision, modelBytes: profile.modelBytes,
          tokenizerIdentity: JSON.stringify([profile.ggufTokenizer, profile.specialTokens, profile.contextTokens, profile.maxInputTokens]),
          pooling: profile.pooling, normalization: 2, queryPrefix: profile.queryPrefix,
          documentPrefix: profile.documentPrefix, dimensions: profile.dimensions,
          vectorFormat: 'float32', runtimeIdentity: getDocumentRetrievalRuntimeIdentity(profile),
        };
        const hasCommittedOwner = options.threadId && entry.attachment.threadId === options.threadId;
        const index = hasCommittedOwner
          ? await documentIndexStore.read(options.threadId!, entry.attachment.id, identity, check) : null;
        check();
        if (!index && !options.prepareMissing) throw new DocumentRetrievalError('index_not_ready');
        documents.push({ ...entry, page, identity, index });
      }
    }
    let candidates = baseline.candidates;
    const preparedIndexes = new Map<string, PrivateDocumentIndex>();
    if (options.preparationOnly && documents.every(document => document.index !== null)) return baseline;
    nativeStarted = true;
    await runDocumentRetrievalRuntime([embedding, reranker].filter(binding => binding !== undefined), runtimeOptions, async (sequence, assertRuntimeCurrent) => {
      // The engine can quarantine a timed-out callback while it is still draining.
      // That callback retains its handles, but cannot start another portion.
      const checkNative = () => { assertRuntimeCurrent(); check(); };
      if (embedding) {
        await sequence.withContext(embedding.request, async context => {
          for (const document of documents) {
            checkNative();
            if (document.index) continue;
            const rows: DocumentIndexRow[] = [];
            let page = document.page;
            let processed = 0;
            while (true) {
              checkNative();
              if (page.sourceIdentity !== document.identity.extractionIdentity || page.totalChunks !== document.page.totalChunks) {
                throw new DocumentRetrievalError('ownership_changed');
              }
              for (const chunk of page.chunks) {
                const subchunks = await splitDocumentEmbeddingChunk(context, chunk, {
                  prefix: embedding.profile.documentPrefix, specialTokens: embedding.profile.specialTokens.nativeOuterOverhead,
                  tokenLimit: embedding.profile.maxInputTokens, check: checkNative,
                });
                if (rows.length + subchunks.length > LIMITS.subchunks
                  || (rows.length + subchunks.length) * document.identity.dimensions * 8 > LIMITS.indexBytes) {
                  throw new DocumentRetrievalError('quota_exceeded');
                }
                for (const subchunk of subchunks) {
                  const vector = await embedDocumentRetrievalText(context, embedding.profile, subchunk.chunk.text, 'document', checkNative, options.onNativeOperation);
                  rows.push({ ...subchunk, vector });
                }
                processed++;
                options.onProgress?.({ attachmentId: document.attachment.id, processed, totalStructuralChunks: document.page.totalChunks });
              }
              if (!page.nextCursor) break;
              page = await document.result.sessionContextSource!.enumerateChunks!({ cursor: page.nextCursor, signal: options.signal });
              checkNative();
            }
            if (processed !== document.page.totalChunks) throw new DocumentRetrievalError('index_stale');
            document.index = { identity: document.identity, rows };
            preparedIndexes.set(document.attachment.id, document.index);
          }
          if (!options.preparationOnly) {
            const queryVector = await embedDocumentRetrievalText(context, embedding.profile, query, 'query', checkNative, options.onNativeOperation);
            candidates = fuseDocumentCandidates(baseline.candidates, semanticDocumentCandidates(queryVector, documents.map(document => ({
              attachmentId: document.attachment.id, rows: document.index!.rows,
            }))));
          }
        });
      }
      if (reranker && candidates.length) {
        await sequence.withContext(reranker.request, async context => {
          const shortlist = distributeDocumentCandidates(candidates, LIMITS.rerankCandidates);
          for (const candidate of shortlist) await validateDocumentRerankPair(context, reranker.profile, query, candidate.chunk.text, checkNative);
          checkNative();
          // No native parallel API and no Promise.all: one bounded serial cross-encoder call.
          options.onNativeOperation?.({ operation: 'rerank', phase: 'started', inputCount: shortlist.length });
          let settled = false;
          const result = await context.rerank(query, shortlist.map(candidate => candidate.chunk.text), {}).then(value => {
            settled = true;
            options.onNativeOperation?.({ operation: 'rerank', phase: 'settled', inputCount: shortlist.length, indices: value.map(item => item.index) });
            return value;
          }).finally(() => { if (!settled) options.onNativeOperation?.({ operation: 'rerank', phase: 'settled', inputCount: shortlist.length }); });
          checkNative();
          const ranked = mapDocumentRerankResults(shortlist, result);
          const retained = new Set(ranked.map(candidate => `${candidate.attachmentId}:${candidate.chunk.index}`));
          candidates = [...ranked, ...candidates.filter(candidate => !retained.has(`${candidate.attachmentId}:${candidate.chunk.index}`))];
        });
      }
    });
    check();
    for (const document of documents) {
      if (preparedIndexes.has(document.attachment.id) && options.threadId && document.attachment.threadId === options.threadId) {
        await documentIndexStore.publish(options.threadId, document.attachment.id, document.index!, check);
        preparedIndexes.delete(document.attachment.id);
      }
    }
    check();
    return report({ candidates, preparedIndexes, actualMode: options.preparationOnly ? 'lexical' : embedding ? (reranker ? 'hybrid+rerank' : 'hybrid') : 'lexical+rerank' });
  } catch (error) {
    check();
    if (error instanceof DocumentRetrievalError && ['cancelled', 'ownership_changed', 'restore_failed'].includes(error.code)) throw error;
    // Failure after native admission is recoverable only through a confirmed exact-A receipt.
    if (nativeStarted && !restored) throw error;
    const fallbackReason = error instanceof DocumentRetrievalError ? error.code : 'native_failed';
    return report({ ...baseline, fallbackReason });
  }
}

/** Keep source-specific assets and locators; selected subchunks remain untrusted document context. */
export function applyDocumentRetrievalCandidates<T extends DocumentRetrievalEntry>(
  entries: readonly T[], result: DocumentRetrievalResult,
): T[] {
  return entries.map(entry => {
    const selected = result.candidates.filter(candidate => candidate.attachmentId === entry.attachment.id);
    const chunks: DocumentContextChunk[] = selected.map(candidate => candidate.chunk);
    return { ...entry, result: { ...entry.result, chunks,
      text: chunks.map(chunk => chunk.text).join('\n\n'), selectedChunkCount: chunks.length,
      extractedCharCount: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      truncated: entry.result.truncated || chunks.length < (entry.result.chunkCount ?? chunks.length),
      retrievalOrder: chunks.map(chunk => chunk.index),
      retrieval: { actualMode: result.actualMode, fallbackReason: result.fallbackReason },
    } };
  });
}
