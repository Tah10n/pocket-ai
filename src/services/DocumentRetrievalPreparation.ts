import { useChatStore } from '../store/chatStore';
import { getThreadActiveModelId } from '../types/chat';
import { DOCUMENT_RETRIEVAL_LIMITS as LIMITS, DocumentRetrievalError,
  type DocumentRetrievalIssue, type DocumentIndexIdentity } from '../types/documentRetrieval';
import { getOwnedRetrievalDocuments } from './DocumentRetrievalOwnership';
import { loadOwnedRetrievalDocuments } from './DocumentRetrievalDocuments';
import { retrieveDocumentCandidates } from './DocumentRetrievalService';
import { documentIndexStore } from './DocumentIndexStore';
import { getAuxiliarySelection } from './AuxiliaryModelService';
import { getVerifiedRetrievalProfile } from './DocumentRetrievalProfiles';
import { getDocumentRetrievalRuntimeIdentity } from './DocumentRetrievalRuntime';
import { getDocumentRetrievalStatus, updateDocumentRetrievalStatus, type DocumentRetrievalStatus } from './DocumentRetrievalStatus';
import { isPrivateStorageWritable } from './storage';
import { beginChatGenerationWork } from './ChatGenerationService';
import { DOCUMENT_TEXT_PROCESSOR_ID, DOCUMENT_TEXT_PROCESSOR_VERSION,
  POCKET_ANYDOC_PROCESSOR_ID, POCKET_ANYDOC_PROCESSOR_VERSION } from './ChatAttachmentProcessorRegistry';
import { getVersion as getPocketAnydocVersion, type PocketAnydocVersion } from '../../modules/pocket-anydoc';
import { isSupportedChatAnydocDocumentMimeType, resolveChatAttachmentExtension,
  resolveChatProcessableDocumentMimeType, MAX_CHAT_ANYDOC_DOCUMENT_ATTACHMENT_BYTES } from '../utils/chatAttachments';
import type { OwnedRetrievalDocument } from './DocumentRetrievalOwnership';
import type { ChatDocumentTextProcessorResult } from './ChatAttachmentProcessorRegistry';

let active: { threadId: string; controller: AbortController; promise: Promise<void> } | undefined;
type NativeExtractorMetadata = Pick<PocketAnydocVersion, 'parserId' | 'parserVersion' | 'exactAnyDocCommit'>;
let nativeExtractorMetadata: NativeExtractorMetadata | null | undefined;
let nativeMetadataRequest: Promise<void> | undefined;

/** Reading metadata is explicit and never loads an auxiliary model or prepares document text. */
export async function refreshDocumentRetrievalPreparationMetadata(threadId: string): Promise<void> {
  const owned = getOwnedRetrievalDocuments(threadId);
  if (!isPrivateStorageWritable() || useChatStore.getState().activeThreadId !== threadId
    || !owned.some(document => isSupportedChatAnydocDocumentMimeType(resolveChatProcessableDocumentMimeType(document)))) return;
  if (nativeExtractorMetadata === undefined) {
    if (!nativeMetadataRequest) {
      nativeMetadataRequest = getPocketAnydocVersion().then(version => {
        nativeExtractorMetadata = version;
      }).catch(() => { /* Unknown metadata cannot establish a compatible prepared index. */ })
        .finally(() => { nativeMetadataRequest = undefined; });
    }
    await nativeMetadataRequest;
  }
  const state = useChatStore.getState();
  if (isPrivateStorageWritable() && state.activeThreadId === threadId && state.getThread(threadId)) {
    updateDocumentRetrievalStatus(threadId, {});
  }
}

function isCurrentExtractionIdentity(identity: DocumentIndexIdentity, document: OwnedRetrievalDocument): boolean {
  let value: unknown;
  try { value = JSON.parse(identity.extractionIdentity); } catch { return false; }
  if (!Array.isArray(value) || value.length !== 10 || value[0] !== 'document-chunks-v1'
    || value[1] !== document.document.contentSha256 || value[8] !== document.sizeBytes
    || !Number.isSafeInteger(value[9]) || value[9] < 1 || value[9] > LIMITS.structuralChunks
    || typeof value[4] !== 'string' || !value[4].length || value[4].length > 64) return false;
  const mimeType = resolveChatProcessableDocumentMimeType(document);
  if (!mimeType) return false;
  if (isSupportedChatAnydocDocumentMimeType(mimeType)
    && !(mimeType === 'application/pdf' && nativeExtractorMetadata === null)) {
    return Boolean(nativeExtractorMetadata && value[2] === POCKET_ANYDOC_PROCESSOR_ID
      && value[3] === POCKET_ANYDOC_PROCESSOR_VERSION && value[5] === nativeExtractorMetadata.parserId
      && value[6] === nativeExtractorMetadata.parserVersion && value[7] === nativeExtractorMetadata.exactAnyDocCommit);
  }
  const extension = resolveChatAttachmentExtension(document.fileName);
  const canonicalFormat = mimeType === 'application/pdf' ? 'pdf'
    : extension === 'md' || extension === 'markdown' ? 'markdown' : extension === 'tsv' ? 'tsv'
      : extension === 'json' || mimeType === 'application/json' ? 'json' : 'txt';
  return value[2] === DOCUMENT_TEXT_PROCESSOR_ID && value[3] === DOCUMENT_TEXT_PROCESSOR_VERSION
    && value[4] === canonicalFormat && value[5] === null && value[6] === null && value[7] === null;
}

function learnCurrentNativeExtractor(result: ChatDocumentTextProcessorResult): void {
  if (result.processorId === POCKET_ANYDOC_PROCESSOR_ID && result.processorVersion === POCKET_ANYDOC_PROCESSOR_VERSION
    && result.parserId && result.parserVersion && result.exactAnyDocCommit) {
    nativeExtractorMetadata = { parserId: result.parserId, parserVersion: result.parserVersion,
      exactAnyDocCommit: result.exactAnyDocCommit };
  } else if (result.processorId === DOCUMENT_TEXT_PROCESSOR_ID && result.processorVersion === DOCUMENT_TEXT_PROCESSOR_VERSION
    && result.canonicalFormat === 'pdf') {
    // A real current PDF result proves that this native build took the compatibility fallback.
    nativeExtractorMetadata = null;
  }
}

export type DocumentPreparationItem = {
  attachmentId: string; displayName: string;
  status: 'not_ready' | 'stale' | 'preparing' | 'ready' | 'error' | 'cancelled';
  processed?: number; total?: number; issue?: DocumentRetrievalIssue;
};

/** A saved ready manifest describes preparation; search quality is reported separately. */
export function getDocumentRetrievalPreparationDocuments(threadId: string): DocumentPreparationItem[] {
  const selected = getAuxiliarySelection('embedding');
  const profile = selected ? getVerifiedRetrievalProfile('embedding', selected.sha256) : undefined;
  const progress = getDocumentRetrievalStatus(threadId).preparation;
  return getOwnedRetrievalDocuments(threadId).slice(0, LIMITS.documents).map(attachment => {
    let status: DocumentPreparationItem['status'] = 'not_ready';
    let issue: DocumentRetrievalIssue | undefined;
    try {
      const identity = documentIndexStore.inspect(threadId, attachment.id);
      if (identity) status = profile && identity.documentSha256 === attachment.document.contentSha256
        && isCurrentExtractionIdentity(identity, attachment)
        && identity.modelSha256 === profile.modelSha256 && identity.modelRevision === profile.modelRevision
        && identity.modelBytes === profile.modelBytes && identity.queryPrefix === profile.queryPrefix
        && identity.documentPrefix === profile.documentPrefix && identity.dimensions === profile.dimensions
        && identity.pooling === profile.pooling && identity.normalization === profile.normalization
        && identity.tokenizerIdentity === JSON.stringify([profile.ggufTokenizer, profile.specialTokens, profile.contextTokens, profile.maxInputTokens])
        && identity.chunkingVersion === 'document-chunks-v1' && identity.preprocessingVersion === 'tokenizer-prose-subchunks-v1'
        && identity.runtimeIdentity === getDocumentRetrievalRuntimeIdentity(profile) ? 'ready' : 'stale';
    } catch { status = 'error'; issue = 'ownership_changed'; }
    if (!profile) issue = selected ? 'profile_unverified' : 'model_unavailable';
    if (progress?.attachmentId === attachment.id) {
      if (progress.phase === 'preparing' || progress.phase === 'cancelling') status = 'preparing';
      if (progress.phase === 'error') { status = 'error'; issue = progress.reason; }
      if (progress.phase === 'cancelled') status = 'cancelled';
    }
    return { attachmentId: attachment.id, displayName: attachment.displayName ?? attachment.fileName, status,
      ...(progress?.attachmentId === attachment.id ? { processed: progress.processed, total: progress.total } : {}), issue };
  });
}

export function cancelDocumentRetrievalPreparation(threadId: string): void {
  if (active?.threadId !== threadId) return;
  active.controller.abort();
  const previous = getDocumentRetrievalStatus(threadId).preparation;
  if (previous) updateDocumentRetrievalStatus(threadId, { preparation: { ...previous, phase: 'cancelling' } });
}

/** Private reset waits for real native and document release, rather than dropping the job. */
export async function stopDocumentRetrievalPreparation(): Promise<void> {
  const owned = active;
  if (!owned) return;
  cancelDocumentRetrievalPreparation(owned.threadId);
  try { await owned.promise; } catch { /* Terminal cancellation/error is already recorded. */ }
}

function recordPreparationFailure(
  threadId: string, attachmentId: string | undefined, error: unknown,
  previous?: DocumentRetrievalStatus['preparation'],
): void {
  const reason = error instanceof DocumentRetrievalError ? error.code : 'native_failed';
  try {
    // A removed chat or reset must not regain a late UI record.
    if (isPrivateStorageWritable() && useChatStore.getState().getThread(threadId)) {
      updateDocumentRetrievalStatus(threadId, { preparation: {
        ...previous, attachmentId: previous?.attachmentId ?? attachmentId,
        phase: reason === 'cancelled' ? 'cancelled' : 'error', reason,
        processed: previous?.processed ?? 0, total: previous?.total ?? 0,
      } });
    }
  } catch { /* Reporting cannot replace the original admission/operation failure. */ }
}

export async function prepareDocumentRetrieval(threadId: string, attachmentIds?: readonly string[]): Promise<void> {
  // A second request must not overwrite the active owner's progress or cancellation.
  if (active) throw new DocumentRetrievalError('native_failed');
  const initial = useChatStore.getState();
  const initialThread = initial.getThread(threadId);
  const modelId = initialThread ? getThreadActiveModelId(initialThread) : undefined;
  const controller = new AbortController();
  let work: ReturnType<typeof beginChatGenerationWork>;
  try {
    work = beginChatGenerationWork('document_retrieval_preparation');
  } catch (error) {
    recordPreparationFailure(threadId, attachmentIds?.[0], error);
    throw error;
  }
  let unsubscribeCancellation: () => void;
  try {
    unsubscribeCancellation = work.onCancel(() => controller.abort());
  } catch (error) {
    work.finish();
    recordPreparationFailure(threadId, attachmentIds?.[0], error);
    throw error;
  }
  const checkSelection = () => {
    const state = useChatStore.getState();
    const thread = state.getThread(threadId);
    if (!isPrivateStorageWritable() || !thread || state.activeThreadId !== threadId
      || thread.status === 'generating' || getThreadActiveModelId(thread) !== modelId
      || state.inferenceRevision !== initial.inferenceRevision) throw new DocumentRetrievalError('ownership_changed');
  };
  const check = () => {
    if (controller.signal.aborted) throw new DocumentRetrievalError('cancelled');
    work.assertCurrent();
    checkSelection();
  };
  const operation = async () => {
    let loaded: Awaited<ReturnType<typeof loadOwnedRetrievalDocuments>> | undefined;
    let unsubscribe: () => void = () => undefined;
    let hasRecordedPreparation = false;
    try {
      unsubscribe = useChatStore.subscribe(() => { try { check(); } catch { controller.abort(); } });
      check();
      documentIndexStore.reconcile();
      updateDocumentRetrievalStatus(threadId, { preparation: { phase: 'preparing', attachmentId: attachmentIds?.[0], processed: 0, total: 0 } });
      hasRecordedPreparation = true;
      loaded = await loadOwnedRetrievalDocuments(threadId, attachmentIds, {
        query: '', signal: controller.signal, assertCurrent: check,
        maxFileBytes: MAX_CHAT_ANYDOC_DOCUMENT_ATTACHMENT_BYTES, maxChars: 16000, maxChunks: 64,
      });
      const result = await retrieveDocumentCandidates('', loaded.entries, { mode: 'hybrid', rerank: false }, {
        threadId, signal: controller.signal, assertCurrent: check, assertSelectionCurrent: checkSelection,
        prepareMissing: true, preparationOnly: true,
        onProgress: progress => updateDocumentRetrievalStatus(threadId, { preparation: {
          phase: 'preparing', attachmentId: progress.attachmentId, processed: progress.processed, total: progress.totalStructuralChunks,
        } }),
      });
      check();
      if (result.fallbackReason) throw new DocumentRetrievalError(result.fallbackReason);
      if (result.cacheFailures?.length) throw new DocumentRetrievalError(result.cacheFailures[0].reason);
      loaded.entries.forEach(entry => learnCurrentNativeExtractor(entry.result));
      const previous = getDocumentRetrievalStatus(threadId).preparation;
      updateDocumentRetrievalStatus(threadId, { preparation: { phase: 'ready', processed: previous?.processed ?? 0, total: previous?.total ?? 0 } });
    } catch (error) {
      recordPreparationFailure(threadId, attachmentIds?.[0], error,
        hasRecordedPreparation ? getDocumentRetrievalStatus(threadId).preparation : undefined);
      throw error;
    } finally {
      unsubscribe();
      try { await loaded?.release(); } finally { unsubscribeCancellation(); work.finish(); }
    }
  };
  // Start on the next microtask so cancellation retains the owner until the whole drain/release finishes.
  const promise = Promise.resolve().then(operation).finally(() => { if (active?.controller === controller) active = undefined; });
  active = { threadId, controller, promise };
  return promise;
}
