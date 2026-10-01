import { prepareDocumentRetrieval, cancelDocumentRetrievalPreparation, getDocumentRetrievalPreparationDocuments } from '../../src/services/DocumentRetrievalPreparation';
import { getDocumentRetrievalStatus, clearDocumentRetrievalStatus, updateDocumentRetrievalStatus } from '../../src/services/DocumentRetrievalStatus';
import { VERIFIED_RETRIEVAL_PROFILES } from '../../src/services/DocumentRetrievalProfiles';
import type { ChatThread } from '../../src/types/chat';
import type { ChatAttachment } from '../../src/types/attachments';
import type { DocumentIndexIdentity } from '../../src/types/documentRetrieval';

const mockListeners = new Set<() => void>();
const mockRetrieve = jest.fn();
const mockLoad = jest.fn();
const mockRelease = jest.fn();
const mockFinish = jest.fn();
const mockBeginWork = jest.fn();
const mockOnCancel = jest.fn();
const mockUnsubscribeCancellation = jest.fn();
const mockInspect = jest.fn();
const mockReconcile = jest.fn();
const mockGetVersion = jest.fn();
let mockWritable = true;
let mockSelection: { sha256: string } | undefined;
let mockState: { activeThreadId: string | null; inferenceRevision: number; thread?: ChatThread };
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/' }));
jest.mock('../../modules/pocket-anydoc', () => ({
  ...jest.requireActual('../../modules/pocket-anydoc'), getVersion: () => mockGetVersion(),
}));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: {
  getState: () => ({ ...mockState, getThread: () => mockState.thread }),
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
} }));
jest.mock('../../src/services/storage', () => ({ isPrivateStorageWritable: () => mockWritable }));
jest.mock('../../src/services/DocumentRetrievalDocuments', () => ({ loadOwnedRetrievalDocuments: (...args: unknown[]) => mockLoad(...args) }));
jest.mock('../../src/services/DocumentRetrievalService', () => ({ retrieveDocumentCandidates: (...args: unknown[]) => mockRetrieve(...args) }));
jest.mock('../../src/services/DocumentIndexStore', () => ({ documentIndexStore: {
  inspect: (...args: unknown[]) => mockInspect(...args), reconcile: () => mockReconcile(),
} }));
jest.mock('../../src/services/AuxiliaryModelService', () => ({ getAuxiliarySelection: () => mockSelection }));
jest.mock('../../src/services/DocumentRetrievalRuntime', () => ({ getDocumentRetrievalRuntimeIdentity: () => 'runtime-current' }));
jest.mock('../../src/services/ChatGenerationService', () => ({ beginChatGenerationWork: (...args: unknown[]) => mockBeginWork(...args) }));

const attachment: Extract<ChatAttachment, { kind: 'document' }> = {
  id: 'doc', kind: 'document', state: 'ready', threadId: 'thread', messageId: 'message',
  localUri: 'file:///documents/chat-attachments/doc.txt', pathCategory: 'chat_attachment', fileName: 'doc.txt',
  mimeType: 'text/plain', sizeBytes: 50, source: 'document_picker', createdAt: 1,
  document: { processorId: 'document-text', processorVersion: 3, canonicalFormat: 'txt',
    contentSha256: 'a'.repeat(64), sourceByteCount: 50, chunkCount: 1 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function identity(): DocumentIndexIdentity {
  const profile = VERIFIED_RETRIEVAL_PROFILES[0];
  return { documentSha256: 'a'.repeat(64), extractionIdentity: JSON.stringify(['document-chunks-v1', 'a'.repeat(64),
    'document-text', 3, 'txt', null, null, null, 50, 1]), chunkingVersion: 'document-chunks-v1',
    preprocessingVersion: 'tokenizer-prose-subchunks-v1', modelSha256: profile.modelSha256,
    modelRevision: profile.modelRevision, modelBytes: profile.modelBytes,
    tokenizerIdentity: JSON.stringify([profile.ggufTokenizer, profile.specialTokens, profile.contextTokens, profile.maxInputTokens]),
    pooling: 'mean', normalization: 2, queryPrefix: profile.queryPrefix, documentPrefix: profile.documentPrefix,
    dimensions: 384, vectorFormat: 'float32', runtimeIdentity: 'runtime-current' };
}
const currentNativeVersion = { moduleVersion: '1', parserId: 'anydoc', parserVersion: 'current', exactAnyDocCommit: 'c'.repeat(40) };
function nativeDocument() {
  const document = { ...attachment, fileName: 'doc.pdf', mimeType: 'application/pdf', document: {
    ...attachment.document, processorId: 'pocket-anydoc', processorVersion: 1, canonicalFormat: 'pdf',
    parserId: 'old-parser', parserVersion: 'old', exactAnyDocCommit: 'b'.repeat(40),
  } };
  mockState.thread!.messages[0].attachments = [document];
  mockInspect.mockReturnValue({ ...identity(), extractionIdentity: JSON.stringify(['document-chunks-v1', 'a'.repeat(64),
    'pocket-anydoc', 1, 'pdf', currentNativeVersion.parserId, currentNativeVersion.parserVersion,
    currentNativeVersion.exactAnyDocCommit, 50, 1]) });
  return document;
}
function freshPreparation() {
  let preparation!: typeof import('../../src/services/DocumentRetrievalPreparation');
  let status!: typeof import('../../src/services/DocumentRetrievalStatus');
  jest.isolateModules(() => {
    preparation = jest.requireActual('../../src/services/DocumentRetrievalPreparation');
    status = jest.requireActual('../../src/services/DocumentRetrievalStatus');
  });
  return { ...preparation, ...status };
}

describe('explicit document preparation ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks(); clearDocumentRetrievalStatus(); mockWritable = true; mockListeners.clear();
    mockSelection = { sha256: VERIFIED_RETRIEVAL_PROFILES[0].modelSha256 };
    mockState = { activeThreadId: 'thread', inferenceRevision: 1, thread: {
      id: 'thread', modelId: 'chat-A', status: 'idle', messages: [{ id: 'message', role: 'user', state: 'complete', content: '', createdAt: 1, attachments: [attachment] }],
    } as ChatThread };
    mockBeginWork.mockReset().mockImplementation(() => ({
      assertCurrent: jest.fn(), finish: () => mockFinish(), onCancel: (...args: unknown[]) => mockOnCancel(...args),
    }));
    mockOnCancel.mockReset().mockReturnValue(mockUnsubscribeCancellation);
    mockReconcile.mockReset();
    mockInspect.mockReturnValue(null);
    mockLoad.mockResolvedValue({ entries: [], truncated: false, release: () => mockRelease() });
    mockRelease.mockResolvedValue(undefined);
    mockRetrieve.mockResolvedValue({ candidates: [], preparedIndexes: new Map(), actualMode: 'lexical' });
    mockGetVersion.mockReset().mockResolvedValue(currentNativeVersion);
  });

  it('uses explicit document-only preparation without a fabricated query or reranker', async () => {
    await prepareDocumentRetrieval('thread', ['doc']);
    expect(mockRetrieve).toHaveBeenCalledWith('', [], { mode: 'hybrid', rerank: false }, expect.objectContaining({
      threadId: 'thread', prepareMissing: true, preparationOnly: true,
    }));
    expect(getDocumentRetrievalStatus('thread').preparation?.phase).toBe('ready');
    expect(getDocumentRetrievalStatus('thread')).not.toHaveProperty('lastSearch');
    expect(mockFinish).toHaveBeenCalledTimes(1); expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns a rejected promise for synchronous admission failure and allows a later explicit retry', async () => {
    const error = new Error('work admission denied');
    mockBeginWork.mockImplementationOnce(() => { throw error; });
    updateDocumentRetrievalStatus('thread', { preparation: { phase: 'ready', processed: 8, total: 8 } });
    let operation!: Promise<void>;
    expect(() => { operation = prepareDocumentRetrieval('thread', ['doc']); }).not.toThrow();
    await expect(operation).rejects.toBe(error);
    expect(getDocumentRetrievalPreparationDocuments('thread')[0]).toMatchObject({
      status: 'error', issue: 'native_failed', processed: 0, total: 0,
    });
    expect(getDocumentRetrievalStatus('thread').preparation?.attachmentId).toBe('doc');
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
    await prepareDocumentRetrieval('thread', ['doc']);
    expect(getDocumentRetrievalStatus('thread').preparation?.phase).toBe('ready');
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  it('finishes admitted work exactly once if cancellation registration rejects synchronously', async () => {
    const error = new Error('cancellation registration denied');
    mockOnCancel.mockImplementationOnce(() => { throw error; });
    await expect(prepareDocumentRetrieval('thread', ['doc'])).rejects.toBe(error);
    expect(getDocumentRetrievalPreparationDocuments('thread')[0]).toMatchObject({ status: 'error', processed: 0, total: 0 });
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockUnsubscribeCancellation).not.toHaveBeenCalled();
    await prepareDocumentRetrieval('thread', ['doc']);
    expect(mockFinish).toHaveBeenCalledTimes(2);
    expect(mockUnsubscribeCancellation).toHaveBeenCalledTimes(1);
  });

  it('attaches initial ownership failure to the requested document without starting source or native work', async () => {
    const operation = prepareDocumentRetrieval('thread', ['doc']);
    mockState.activeThreadId = 'other-thread';
    await expect(operation).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(getDocumentRetrievalPreparationDocuments('thread')[0]).toMatchObject({
      status: 'error', issue: 'ownership_changed', processed: 0, total: 0,
    });
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribeCancellation).toHaveBeenCalledTimes(1);
    expect(mockListeners.size).toBe(0);
    mockState.activeThreadId = 'thread';
    await prepareDocumentRetrieval('thread', ['doc']);
    expect(mockFinish).toHaveBeenCalledTimes(2);
  });

  it('reports reconciliation failure with zero progress and releases admission for a later retry', async () => {
    const error = new Error('index reconciliation denied');
    mockReconcile.mockImplementationOnce(() => { throw error; });
    updateDocumentRetrievalStatus('thread', { preparation: {
      phase: 'cancelled', attachmentId: 'older-document', processed: 9, total: 12,
    } });
    await expect(prepareDocumentRetrieval('thread', ['doc'])).rejects.toBe(error);
    expect(getDocumentRetrievalPreparationDocuments('thread')[0]).toMatchObject({
      status: 'error', issue: 'native_failed', processed: 0, total: 0,
    });
    expect(getDocumentRetrievalStatus('thread').preparation?.attachmentId).toBe('doc');
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockListeners.size).toBe(0);
    await prepareDocumentRetrieval('thread', ['doc']);
    expect(mockFinish).toHaveBeenCalledTimes(2);
  });

  it.each(['removed', 'private_reset'] as const)('does not recreate status after initial %s ownership loss', async loss => {
    const operation = prepareDocumentRetrieval('thread', ['doc']);
    if (loss === 'removed') mockState.thread = undefined;
    else mockWritable = false;
    clearDocumentRetrievalStatus('thread');
    await expect(operation).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(getDocumentRetrievalStatus('thread')).toEqual({});
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockListeners.size).toBe(0);
  });

  it('holds admission through cancellation until native settlement and retained-source release', async () => {
    const native = deferred<object>(); const release = deferred<void>(); const started = deferred<void>();
    mockRetrieve.mockImplementation(async () => { started.resolve(); return native.promise; });
    mockRelease.mockReturnValue(release.promise);
    const operation = prepareDocumentRetrieval('thread', ['doc']);
    const outcome = operation.then(() => 'resolved', error => error);
    await started.promise;
    cancelDocumentRetrievalPreparation('thread');
    expect(getDocumentRetrievalStatus('thread').preparation?.phase).toBe('cancelling');
    await expect(prepareDocumentRetrieval('thread', ['doc'])).rejects.toMatchObject({ code: 'native_failed' });
    expect(getDocumentRetrievalStatus('thread').preparation?.phase).toBe('cancelling');
    expect(mockFinish).not.toHaveBeenCalled();
    native.resolve({ candidates: [], preparedIndexes: new Map(), actualMode: 'lexical' });
    for (let step = 0; step < 12 && !mockRelease.mock.calls.length; step++) await Promise.resolve();
    expect(mockFinish).not.toHaveBeenCalled();
    release.resolve();
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a removed chat from a late preparation callback', async () => {
    const native = deferred<object>(); const started = deferred<void>();
    mockRetrieve.mockImplementation(async () => { started.resolve(); return native.promise; });
    const operation = prepareDocumentRetrieval('thread', ['doc']);
    const outcome = operation.then(() => 'resolved', error => error);
    await started.promise; mockState.thread = undefined; clearDocumentRetrievalStatus('thread');
    mockListeners.forEach(listener => listener());
    native.resolve({ candidates: [], preparedIndexes: new Map(), actualMode: 'lexical' });
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(getDocumentRetrievalStatus('thread')).toEqual({});
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps a saved manifest ready only for the exact document, extraction and selected profile', () => {
    mockInspect.mockReturnValue(identity());
    expect(getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('ready');
    for (const patch of [{ documentSha256: 'b'.repeat(64) }, { modelRevision: 'different' }, { queryPrefix: 'different: ' },
      { tokenizerIdentity: 'different' }, { runtimeIdentity: 'old-runtime' }, { extractionIdentity: 'old-processor' }]) {
      mockInspect.mockReturnValue({ ...identity(), ...patch });
      expect(getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('stale');
    }
    mockSelection = undefined;
    expect(getDocumentRetrievalPreparationDocuments('thread')[0]).toMatchObject({ status: 'stale', issue: 'model_unavailable' });
  });

  it('shows a current v3 index ready after re-preparing a legacy v2 attachment without rewriting history', async () => {
    const legacy = { ...attachment, document: { ...attachment.document, processorVersion: 2, chunkCount: 99 } };
    mockState.thread!.messages[0].attachments = [legacy];
    const ready = identity();
    mockInspect.mockReturnValue(ready);
    await prepareDocumentRetrieval('thread', ['doc']);
    expect(getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('ready');
    expect(legacy.document.processorVersion).toBe(2);
    expect(legacy.document.chunkCount).toBe(99);
    expect(mockGetVersion).not.toHaveBeenCalled();
    ready.extractionIdentity = JSON.stringify(['document-chunks-v1', 'a'.repeat(64), 'document-text', 2, 'txt', null, null, null, 50, 1]);
    expect(getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('stale');
  });

  it('does no metadata work for a direct document and rejects malformed source identities and changed routes', async () => {
    const fresh = freshPreparation();
    mockInspect.mockReturnValue(identity());
    await fresh.refreshDocumentRetrievalPreparationMetadata('thread');
    expect(mockGetVersion).not.toHaveBeenCalled();
    for (const extractionIdentity of ['{}', '["document-chunks-v1"]', JSON.stringify([
      'document-chunks-v1', 'a'.repeat(64), 'document-text', 3, 'json', null, null, null, 50, 1,
    ]), JSON.stringify(['document-chunks-v1', 'a'.repeat(64), 'document-text', 3, 'txt', null, null, null, 51, 1]),
    JSON.stringify(['document-chunks-v1', 'a'.repeat(64), 'document-text', 3, 'txt', null, null, null, 50, 2049])]) {
      mockInspect.mockReturnValue({ ...identity(), extractionIdentity });
      expect(fresh.getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('stale');
    }
  });

  it('establishes current native parser metadata only through explicit expansion and reuses one bounded snapshot', async () => {
    nativeDocument();
    const fresh = freshPreparation();
    expect(fresh.getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('stale');
    expect(mockGetVersion).not.toHaveBeenCalled();
    await fresh.refreshDocumentRetrievalPreparationMetadata('thread');
    expect(mockGetVersion).toHaveBeenCalledTimes(1);
    expect(fresh.getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('ready');
    await fresh.refreshDocumentRetrievalPreparationMetadata('thread');
    expect(mockGetVersion).toHaveBeenCalledTimes(1);
  });

  it('deduplicates pending metadata reads and never restores an old chat status after a switch', async () => {
    nativeDocument();
    const version = deferred<typeof currentNativeVersion>();
    mockGetVersion.mockReturnValue(version.promise);
    const fresh = freshPreparation();
    const one = fresh.refreshDocumentRetrievalPreparationMetadata('thread');
    const two = fresh.refreshDocumentRetrievalPreparationMetadata('thread');
    expect(mockGetVersion).toHaveBeenCalledTimes(1);
    mockState.activeThreadId = 'other-thread';
    version.resolve(currentNativeVersion);
    await Promise.all([one, two]);
    expect(fresh.getDocumentRetrievalStatus('thread')).toEqual({});
    expect(fresh.getDocumentRetrievalStatus('other-thread')).toEqual({});
  });

  it('fails closed for an unavailable or changed native parser and retries only another explicit action', async () => {
    nativeDocument();
    const fresh = freshPreparation();
    mockGetVersion.mockRejectedValueOnce(new Error('metadata unavailable'));
    await fresh.refreshDocumentRetrievalPreparationMetadata('thread');
    expect(fresh.getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('stale');
    mockGetVersion.mockResolvedValue({ ...currentNativeVersion, exactAnyDocCommit: 'd'.repeat(40) });
    await fresh.refreshDocumentRetrievalPreparationMetadata('thread');
    expect(mockGetVersion).toHaveBeenCalledTimes(2);
    expect(fresh.getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('stale');
  });

  it('learns authoritative native metadata from a successful real processing result without trusting saved parser fields', async () => {
    const document = nativeDocument();
    const fresh = freshPreparation();
    mockLoad.mockResolvedValue({ entries: [{ attachment: document, result: {
      processorId: 'pocket-anydoc', processorVersion: 1, canonicalFormat: 'pdf',
      parserId: currentNativeVersion.parserId, parserVersion: currentNativeVersion.parserVersion,
      exactAnyDocCommit: currentNativeVersion.exactAnyDocCommit,
    } }], truncated: false, release: () => mockRelease() });
    await fresh.prepareDocumentRetrieval('thread', ['doc']);
    expect(fresh.getDocumentRetrievalPreparationDocuments('thread')[0].status).toBe('ready');
    expect(document.document.parserVersion).toBe('old');
    expect(mockGetVersion).not.toHaveBeenCalled();
  });
});
