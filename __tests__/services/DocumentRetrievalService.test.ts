import * as RNFS from 'react-native-fs';
import type { LlamaContext } from 'llama.rn';
import {
  retrieveDocumentCandidates, applyDocumentRetrievalCandidates, type DocumentRetrievalEntry,
  type DocumentRetrievalOptions,
} from '../../src/services/DocumentRetrievalService';
import { DocumentIndexStore, documentIndexStore } from '../../src/services/DocumentIndexStore';
import { VERIFIED_RETRIEVAL_PROFILES } from '../../src/services/DocumentRetrievalProfiles';
import { rankDocumentContextCandidates, type DocumentContextChunk } from '../../src/services/DocumentContextService';
import { getAuxiliarySelection, validateAuxiliaryFile, claimNativePooledEmbeddingDimension } from '../../src/services/AuxiliaryModelService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { isPrivateStorageWritable } from '../../src/services/storage';
import { getAppStorage, type AppStorageFacade } from '../../src/store/storage';
import { useChatStore } from '../../src/store/chatStore';
import { getChatAttachmentsDir } from '../../src/utils/chatImageAttachments';
import { llmEngineService, type AuxiliaryContextRequest } from '../../src/services/LLMEngineService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import {
  DocumentRetrievalError, documentIndexFingerprint, DOCUMENT_RETRIEVAL_LIMITS as LIMITS,
  type DocumentRetrievalSettings, type DocumentIndexIdentity,
} from '../../src/types/documentRetrieval';

// Native/platform dependencies are replaced; service, runtime, lexical/semantic ranking and private index store are real.
jest.mock('../../src/services/AuxiliaryModelService', () => ({
  getAuxiliarySelection: jest.fn(), validateAuxiliaryFile: jest.fn(), claimNativePooledEmbeddingDimension: jest.fn(),
}));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: jest.fn() } }));
jest.mock('../../src/services/SystemMetricsService', () => ({ getSystemMemorySnapshot: jest.fn() }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getModelsDir: () => 'file:///models/' }));
jest.mock('../../src/services/storage', () => ({ isPrivateStorageWritable: jest.fn() }));
jest.mock('../../src/store/storage', () => ({ getAppStorage: jest.fn() }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: jest.fn() } }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ runWithIdleModelDownloads: (operation: () => Promise<unknown>) => operation() }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: { runWithAuxiliarySequence: jest.fn() } }));
jest.mock('../../src/services/LlamaRuntimeAdapter', () => ({ getLlamaBuildInfo: () => ({ version: '0.13.0-rc.3', build: 'fixture' }) }));

const profiles = VERIFIED_RETRIEVAL_PROFILES;
const embeddingProfile = profiles.find(profile => profile.role === 'embedding')!;
function model(role: 'embedding' | 'reranker'): ModelMetadata {
  const profile = profiles.find(entry => entry.role === role)!;
  return { id: profile.modelRepository, name: role, author: 'fixture', size: profile.modelBytes,
    downloadUrl: `https://huggingface.co/${profile.modelRepository}/resolve/${profile.modelRevision}/${profile.modelFilename}`,
    hfRevision: profile.modelRevision, resolvedFileName: profile.modelFilename, localPath: profile.modelFilename,
    sha256: profile.modelSha256, lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1,
    accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false, fitsInRam: null,
    roleEvidence: [{ role, source: 'model_card', confidence: 'declared' }] };
}
function vector(index = 0): number[] { return Array.from({ length: 384 }, (_, position) => position === index ? 1 : 0); }
function makeContext(role: 'embedding' | 'reranker') {
  return { model: { nEmbd: role === 'embedding' ? 384 : 1024, metadata: { 'tokenizer.ggml.model': 't5' } },
    tokenize: jest.fn(async (text: string) => ({ tokens: Array.from(text, (_, index) => index + 10) })),
    embedding: jest.fn(async (_input: string, _params: { embd_normalize: number }) => ({ embedding: vector() })),
    detokenize: jest.fn(async (_tokens: number[]) => 'native formatted pair'),
    rerank: jest.fn(async (_query: string, documents: string[], _params: object) => documents.map((_document, index) => ({ index, score: index }))),
  };
}
function makeStorage() {
  const data = new Map<string, string>();
  const facade = { set: jest.fn((key: string, value: string | number | boolean | ArrayBuffer) => { data.set(key, String(value)); }),
    getString: jest.fn((key: string) => data.get(key)), getNumber: jest.fn(), getBoolean: jest.fn(),
    contains: jest.fn((key: string) => data.has(key)), getAllKeys: jest.fn(() => [...data.keys()]),
    remove: jest.fn((key: string) => data.delete(key)), clearAll: jest.fn(() => { data.clear(); }),
  } satisfies AppStorageFacade;
  return { data, facade };
}
function entry(id = 'manual', chunks: DocumentContextChunk[] = [
  { index: 0, text: 'Orchids require water.', kind: 'paragraph', pageNumber: 3 },
  { index: 1, text: 'Automobiles need regular maintenance.', kind: 'paragraph', pageNumber: 9 },
]): DocumentRetrievalEntry {
  const text = chunks.map(chunk => chunk.text).join('\n\n');
  const value: DocumentRetrievalEntry = { attachment: { id, kind: 'document', state: 'ready', threadId: 'chat-a', messageId: 'user-a',
    localUri: `${getChatAttachmentsDir()}${id}.txt`, pathCategory: 'chat_attachment', fileName: `${id}.txt`,
    mimeType: 'text/plain', sizeBytes: text.length, source: 'document_picker', createdAt: 1,
    document: { processorId: 'document-text', processorVersion: 3 } },
  result: { attachmentId: id, runtimeInput: 'document_text', processorId: 'document-text', processorVersion: 3,
    canonicalFormat: 'txt', mimeType: 'text/plain', text, chunks, truncated: false,
    extractedCharCount: text.length, sourceCharCount: text.length, chunkCount: chunks.length,
    contentHash: `sha256:${'a'.repeat(64)}`, contentSha256: 'a'.repeat(64),
    sessionContextSource: { attachmentId: id, kind: 'memory', isReleased: () => false,
      selectContext: jest.fn(), release: jest.fn(),
      enumerateChunks: jest.fn(async () => ({ chunks, totalChunks: chunks.length, sourceIdentity: 'extraction-v1' })),
    } } };
  ownedDocuments.set(id, { ...value.attachment, document: { ...value.attachment.document } });
  return value;
}
function options(overrides: Partial<DocumentRetrievalOptions> = {}): DocumentRetrievalOptions {
  return { threadId: 'chat-a', prepareMissing: true, assertCurrent: jest.fn(), ...overrides };
}
const hybrid: DocumentRetrievalSettings = { mode: 'hybrid', rerank: false };
const hybridRank: DocumentRetrievalSettings = { mode: 'hybrid', rerank: true };
const lexicalRank: DocumentRetrievalSettings = { mode: 'lexical', rerank: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let storage: ReturnType<typeof makeStorage>;
let contexts: { embedding: ReturnType<typeof makeContext>; reranker: ReturnType<typeof makeContext> };
let selected: Partial<Record<'embedding' | 'reranker', ModelMetadata>>;
let sequenceEvents: string[];
let phaseActive: boolean;
let restoreConfirmed: boolean;
let ownedDocuments: Map<string, DocumentRetrievalEntry['attachment']>;

beforeEach(() => {
  jest.restoreAllMocks(); jest.clearAllMocks();
  storage = makeStorage();
  ownedDocuments = new Map();
  jest.mocked(useChatStore.getState).mockReturnValue({ getThread: (id: string) => id === 'chat-a'
    ? { messages: [{ id: 'user-a', attachments: [...ownedDocuments.values()] }] } : undefined } as never);
  jest.mocked(getAppStorage).mockReturnValue(storage.facade as unknown as ReturnType<typeof getAppStorage>);
  selected = { embedding: model('embedding'), reranker: model('reranker') };
  contexts = { embedding: makeContext('embedding'), reranker: makeContext('reranker') };
  sequenceEvents = []; phaseActive = false; restoreConfirmed = true;
  jest.mocked(getAuxiliarySelection).mockImplementation(role => role === 'embedding' || role === 'reranker' ? selected[role] : undefined);
  jest.mocked(registry.getModel).mockImplementation(id => Object.values(selected).find(value => value?.id === id));
  jest.mocked(validateAuxiliaryFile).mockResolvedValue(undefined as never);
  jest.mocked(isPrivateStorageWritable).mockReturnValue(true);
  jest.mocked(RNFS.hash).mockResolvedValue('a'.repeat(64));
  jest.mocked(getSystemMemorySnapshot).mockResolvedValue({ availableBytes: 4 * 2 ** 30, freeBytes: 4 * 2 ** 30,
    thresholdBytes: 0, lowMemory: false } as never);
  jest.mocked(llmEngineService.runWithAuxiliarySequence).mockImplementation(async (request, operation) => {
    sequenceEvents.push('detach:A');
    try {
      return await operation({ withContext: async <T>(phase: AuxiliaryContextRequest, callback: (context: LlamaContext) => Promise<T>) => {
        if (phaseActive) throw new Error('overlapping native contexts');
        phaseActive = true;
        const role = phase.modelId === embeddingProfile.modelRepository ? 'embedding' : 'reranker';
        const checkPhase = () => { if (!phase.isCurrent()) throw new DocumentRetrievalError(request.signal?.aborted ? 'cancelled' : 'ownership_changed'); };
        try {
          checkPhase(); await phase.beforeInit?.(); checkPhase(); sequenceEvents.push(`init:${role}`);
          const result = await callback(contexts[role] as unknown as LlamaContext);
          checkPhase(); return result;
        } finally { sequenceEvents.push(`release:${role}`); phaseActive = false; }
      } });
    } finally {
      if (restoreConfirmed && request.isCurrent()) {
        sequenceEvents.push('restore:A');
        request.onRestored?.({ modelId: 'chat/a', previousContextIdentity: 'epoch-a', restoredContextIdentity: 'epoch-restored-a' });
      }
    }
  });
});

describe('DocumentRetrievalService production routing', () => {
  it('runs B then C serially and sends exact prefixed embedding and raw rerank API arguments', async () => {
    const source = entry(); const onRestored = jest.fn();
    const result = await retrieveDocumentCandidates('car servicing', [source], hybridRank, options({ onRestored }));
    expect(result.actualMode).toBe('hybrid+rerank'); expect(result.fallbackReason).toBeUndefined();
    expect(sequenceEvents).toEqual(['detach:A', 'init:embedding', 'release:embedding', 'init:reranker', 'release:reranker', 'restore:A']);
    expect(contexts.embedding.embedding.mock.calls).toEqual([
      ['passage: Orchids require water.', { embd_normalize: 2 }],
      ['passage: Automobiles need regular maintenance.', { embd_normalize: 2 }],
      ['query: car servicing', { embd_normalize: 2 }],
    ]);
    expect(contexts.reranker.rerank).toHaveBeenCalledWith('car servicing', expect.arrayContaining(source.result.chunks.map(chunk => chunk.text)), {});
    expect(contexts.reranker.embedding).not.toHaveBeenCalled();
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onRestored.mock.invocationCallOrder[0]).toBeLessThan(storage.facade.set.mock.invocationCallOrder[0]);
    expect(result.preparedIndexes.size).toBe(0);
    expect([...storage.data.keys()].some(key => key.endsWith(':ready'))).toBe(true);
  });

  it('admits a semantic paraphrase absent from the lexical shortlist without shared query words', async () => {
    const target = { index: 31, text: 'Automobiles need regular maintenance.', kind: 'paragraph' as const, pageNumber: 9 };
    const chunks = [...Array.from({ length: 31 }, (_, index) => ({ index, text: `Car servicing invoice ${index}.`, kind: 'paragraph' as const })), target];
    const source = entry('manual', chunks);
    contexts.embedding.embedding.mockImplementation(async input => ({ embedding: input.includes('Automobiles') || input.startsWith('query: ') ? vector() : vector(1) }));
    const lexical = await rankDocumentContextCandidates('car servicing', [{ attachmentId: 'manual', displayName: 'manual.txt', canonicalFormat: 'txt', chunks }]);
    expect(lexical.slice(0, LIMITS.candidateCount).some(candidate => candidate.chunk.index === target.index)).toBe(false);
    const result = await retrieveDocumentCandidates('car servicing', [source], hybrid, options());
    expect(result.actualMode).toBe('hybrid');
    expect(result.candidates).toContainEqual(expect.objectContaining({ attachmentId: 'manual', chunk: target }));
    expect(target.text.toLowerCase().split(/\W+/u).some(word => ['car', 'servicing'].includes(word))).toBe(false);
    const applied = applyDocumentRetrievalCandidates([source], result);
    expect(applied[0].result.chunks.some(chunk => chunk.index === 31 && chunk.pageNumber === 9)).toBe(true);
    expect(applied[0].result.retrievalOrder).toContain(31);
    expect(applied[0].result.retrieval).toEqual({ actualMode: 'hybrid', fallbackReason: undefined });
  });

  it('reuses persisted exact-identity document vectors after index-store restart without document recomputation', async () => {
    const source = entry();
    await retrieveDocumentCandidates('car servicing', [source], hybrid, options());
    const restarted = new DocumentIndexStore(() => storage.facade); restarted.reconcile();
    jest.spyOn(documentIndexStore, 'read').mockImplementation(restarted.read.bind(restarted));
    contexts.embedding.embedding.mockClear();
    const result = await retrieveDocumentCandidates('repair schedule', [source], hybrid, options({ prepareMissing: false }));
    expect(result.actualMode).toBe('hybrid');
    expect(contexts.embedding.embedding.mock.calls).toEqual([['query: repair schedule', { embd_normalize: 2 }]]);
    expect(contexts.embedding.tokenize).toHaveBeenCalledWith('query: repair schedule');
  });

  it.each([
    ['model hash', { modelSha256: 'b'.repeat(64) }], ['source hash', { documentSha256: 'b'.repeat(64) }],
    ['model revision', { modelRevision: 'other-revision' }], ['query prefix', { queryPrefix: 'search_query: ' }],
    ['document prefix', { documentPrefix: 'search_document: ' }], ['runtime patch', { runtimeIdentity: 'old-patch' }],
  ] satisfies [string, Partial<DocumentIndexIdentity>][])('rejects a persisted changed %s instead of silently cold-indexing', async (_name, changed) => {
    const source = entry(); await retrieveDocumentCandidates('car servicing', [source], hybrid, options());
    const key = [...storage.data.keys()].find(value => value.endsWith(':ready'))!;
    const manifest = JSON.parse(storage.data.get(key)!);
    manifest.identity = { ...manifest.identity, ...changed };
    manifest.fingerprint = documentIndexFingerprint(manifest.identity);
    storage.data.set(key, JSON.stringify(manifest));
    contexts.embedding.embedding.mockClear(); jest.mocked(llmEngineService.runWithAuxiliarySequence).mockClear();
    const result = await retrieveDocumentCandidates('repair schedule', [source], hybrid, options({ prepareMissing: false }));
    expect(result.actualMode).toBe('lexical'); expect(result.fallbackReason).toBe('index_not_ready');
    expect(contexts.embedding.embedding).not.toHaveBeenCalled();
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it('keeps tools on the lexical fallback when a cold embedding index is missing', async () => {
    const result = await retrieveDocumentCandidates('car servicing', [entry()], hybridRank, options({ prepareMissing: false }));
    expect(result).toMatchObject({ actualMode: 'lexical', fallbackReason: 'index_not_ready' });
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
    expect(contexts.embedding.embedding).not.toHaveBeenCalled();
    expect(contexts.reranker.rerank).not.toHaveBeenCalled();
  });

  it('explicitly prepares an empty query using document embeddings only and persists readiness after restore', async () => {
    const source = entry(); const onRestored = jest.fn();
    const result = await retrieveDocumentCandidates('', [source], hybridRank, options({ preparationOnly: true, onRestored }));
    expect(result.actualMode).toBe('lexical'); expect(result.fallbackReason).toBeUndefined();
    expect(contexts.embedding.embedding.mock.calls.map(([input]) => input)).toEqual(source.result.chunks.map(chunk => 'passage: ' + chunk.text));
    expect(contexts.reranker.rerank).not.toHaveBeenCalled();
    expect(sequenceEvents).toEqual(['detach:A', 'init:embedding', 'release:embedding', 'restore:A']);
    expect(onRestored.mock.invocationCallOrder[0]).toBeLessThan(storage.facade.set.mock.invocationCallOrder[0]);
    contexts.embedding.embedding.mockClear();
    const searched = await retrieveDocumentCandidates('water', [source], hybrid, options({ prepareMissing: false }));
    expect(searched.actualMode).toBe('hybrid');
    expect(contexts.embedding.embedding.mock.calls).toEqual([['query: water', { embd_normalize: 2 }]]);
  });

  it('allows true rerank of the lexical shortlist without an embedding model', async () => {
    selected.embedding = undefined;
    const source = entry(); const result = await retrieveDocumentCandidates('water', [source], lexicalRank, options({ prepareMissing: false }));
    expect(result.actualMode).toBe('lexical+rerank');
    expect(sequenceEvents).toEqual(['detach:A', 'init:reranker', 'release:reranker', 'restore:A']);
    expect(contexts.embedding.embedding).not.toHaveBeenCalled(); expect(RNFS.hash).toHaveBeenCalledTimes(1);
    expect(contexts.reranker.rerank).toHaveBeenCalledWith('water', expect.any(Array), {});
    expect(storage.data.size).toBe(0);
  });

  it.each(['model_unavailable', 'profile_unverified'] as const)('falls back before native ownership for %s', async reason => {
    selected.embedding = reason === 'model_unavailable' ? undefined : { ...selected.embedding!, sha256: 'c'.repeat(64) };
    const result = await retrieveDocumentCandidates('water', [entry()], hybrid, options());
    expect(result).toMatchObject({ actualMode: 'lexical', fallbackReason: reason });
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', []], ['wrong dimension', [1]], ['zero', Array(384).fill(0)], ['NaN', [NaN, ...Array(383).fill(0)]],
  ] satisfies [string, number[]][])('falls back from %s native vectors only after confirmed A restoration', async (_name, badVector) => {
    contexts.embedding.embedding.mockResolvedValue({ embedding: badVector });
    const result = await retrieveDocumentCandidates('water', [entry()], hybrid, options());
    expect(result).toMatchObject({ actualMode: 'lexical', fallbackReason: 'invalid_vector' });
    expect(sequenceEvents.at(-1)).toBe('restore:A'); expect(storage.data.size).toBe(0);
    expect(contexts.reranker.rerank).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', [{ index: 0, score: 1 }]], ['duplicate', [{ index: 0, score: 1 }, { index: 0, score: 2 }]],
    ['out of range', [{ index: 0, score: 1 }, { index: 2, score: 2 }]],
    ['fractional', [{ index: 0.5, score: 1 }, { index: 1, score: 2 }]],
    ['nonfinite', [{ index: 0, score: NaN }, { index: 1, score: 2 }]],
    ['native failure sentinel', [{ index: 0, score: -1000000 }, { index: 1, score: 2 }]],
  ])('rejects %s rerank results and preserves the restored lexical baseline', async (_name, results) => {
    contexts.reranker.rerank.mockResolvedValue(results);
    const result = await retrieveDocumentCandidates('water', [entry()], lexicalRank, options());
    expect(result).toMatchObject({ actualMode: 'lexical', fallbackReason: 'invalid_ranking' });
    expect(result.candidates[0].chunk.index).toBe(0);
    expect(sequenceEvents.at(-1)).toBe('restore:A');
  });

  it('does not fall back from uncertain native drain without a restoration receipt', async () => {
    restoreConfirmed = false; const failure = new Error('native drain remains owned');
    contexts.embedding.embedding.mockRejectedValue(failure);
    await expect(retrieveDocumentCandidates('water', [entry()], hybrid, options())).rejects.toBe(failure);
    expect(sequenceEvents).not.toContain('restore:A'); expect(storage.data.size).toBe(0);
  });

  it('never converts failed A restoration into a lexical fallback', async () => {
    contexts.embedding.embedding.mockRejectedValue(new DocumentRetrievalError('restore_failed'));
    await expect(retrieveDocumentCandidates('water', [entry()], hybrid, options())).rejects.toMatchObject({ code: 'restore_failed' });
    expect(storage.data.size).toBe(0);
  });

  it('never converts cancellation into lexical fallback and waits for the in-flight native call to settle', async () => {
    const gate = deferred<{ embedding: number[] }>(); const started = deferred<void>(); const controller = new AbortController();
    contexts.embedding.embedding.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const work = retrieveDocumentCandidates('water', [entry()], hybridRank, options({ signal: controller.signal }));
    const outcome = work.then(() => 'resolved', error => error);
    await started.promise; controller.abort();
    await Promise.resolve();
    expect(phaseActive).toBe(true); expect(sequenceEvents).not.toContain('release:embedding');
    expect(contexts.reranker.rerank).not.toHaveBeenCalled();
    gate.resolve({ embedding: vector() });
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(phaseActive).toBe(false); expect(storage.data.size).toBe(0);
    expect(contexts.embedding.embedding).toHaveBeenCalledTimes(1);
  });

  it('rejects a same-path model hash mutation during native embedding without publishing or starting C', async () => {
    const gate = deferred<{ embedding: number[] }>(); const started = deferred<void>();
    contexts.embedding.embedding.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const work = retrieveDocumentCandidates('water', [entry()], hybridRank, options());
    const outcome = work.then(() => 'resolved', error => error);
    await started.promise; selected.embedding = { ...selected.embedding!, sha256: 'b'.repeat(64) };
    gate.resolve({ embedding: vector() });
    expect(await outcome).toMatchObject({ code: 'ownership_changed' });
    expect(contexts.reranker.rerank).not.toHaveBeenCalled(); expect(storage.data.size).toBe(0);
    expect(sequenceEvents).not.toContain('restore:A');
  });

  it('retains a quarantined callback until actual settlement and prevents its next document portion', async () => {
    const gate = deferred<{ embedding: number[] }>(); const started = deferred<void>();
    const timeout = new Error('engine recovery required: native callback is still owned');
    contexts.embedding.embedding.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    jest.mocked(llmEngineService.runWithAuxiliarySequence).mockImplementation(async (_request, operation) => operation({
      withContext: async <T>(_phase: AuxiliaryContextRequest, callback: (context: LlamaContext) => Promise<T>) => {
        const actual = callback(contexts.embedding as unknown as LlamaContext);
        void actual.catch(() => undefined);
        await started.promise;
        throw timeout;
      },
    }));
    let settled = false;
    const outcome = retrieveDocumentCandidates('water', [entry()], hybridRank, options()).then(
      () => { settled = true; return undefined; }, error => { settled = true; return error; },
    );
    await started.promise;
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(contexts.embedding.embedding).toHaveBeenCalledTimes(1);
    expect(storage.data.size).toBe(0);
    gate.resolve({ embedding: vector() });
    expect(await outcome).toBe(timeout);
    expect(contexts.embedding.embedding).toHaveBeenCalledTimes(1);
    expect(contexts.reranker.rerank).not.toHaveBeenCalled();
    expect(storage.data.size).toBe(0);
  });

  it('rejects changed source bytes even at the same attachment URI before native ownership', async () => {
    jest.mocked(RNFS.hash).mockResolvedValue('b'.repeat(64));
    await expect(retrieveDocumentCandidates('water', [entry()], hybrid, options())).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it('requires byte identity for rerank-only documents too', async () => {
    jest.mocked(RNFS.hash).mockResolvedValue('b'.repeat(64));
    await expect(retrieveDocumentCandidates('water', [entry()], lexicalRank, options())).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(contexts.reranker.rerank).not.toHaveBeenCalled();
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it('rechecks actual chat attachment ownership after a deferred source hash operation', async () => {
    const gate = deferred<string>(); const started = deferred<void>(); const source = entry();
    jest.mocked(RNFS.hash).mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const work = retrieveDocumentCandidates('water', [source], lexicalRank, options());
    const outcome = work.then(() => 'resolved', error => error);
    await started.promise; ownedDocuments.delete(source.attachment.id); gate.resolve('a'.repeat(64));
    expect(await outcome).toMatchObject({ code: 'ownership_changed' });
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it('rejects a document belonging to another chat before hashing or native work', async () => {
    const source = entry(); source.attachment.threadId = 'other-chat';
    await expect(retrieveDocumentCandidates('water', [source], hybrid, options())).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(RNFS.hash).not.toHaveBeenCalled(); expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it('does not fall back when private-storage ownership disappears while hashing', async () => {
    jest.mocked(RNFS.hash).mockImplementation(async () => { jest.mocked(isPrivateStorageWritable).mockReturnValue(false); return 'a'.repeat(64); });
    await expect(retrieveDocumentCandidates('water', [entry()], hybrid, options())).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it('enforces document and structural traversal quotas before evaluating vectors', async () => {
    await expect(retrieveDocumentCandidates('water', Array.from({ length: LIMITS.documents + 1 }, (_, index) => entry(String(index))), hybrid, options()))
      .resolves.toMatchObject({ actualMode: 'lexical', fallbackReason: 'quota_exceeded' });
    const source = entry(); jest.mocked(source.result.sessionContextSource!.enumerateChunks!).mockResolvedValue({ chunks: source.result.chunks,
      totalChunks: LIMITS.structuralChunks + 1, sourceIdentity: 'extraction-v1' });
    const result = await retrieveDocumentCandidates('water', [source], hybrid, options());
    expect(result).toMatchObject({ actualMode: 'lexical', fallbackReason: 'quota_exceeded' });
    expect(contexts.embedding.embedding).not.toHaveBeenCalled();
  });

  it('checks each paginated extraction identity and never publishes a partial traversal', async () => {
    const source = entry(); jest.mocked(source.result.sessionContextSource!.enumerateChunks!)
      .mockResolvedValueOnce({ chunks: [source.result.chunks[0]], totalChunks: 2, sourceIdentity: 'extraction-v1', nextCursor: 'next' })
      .mockResolvedValueOnce({ chunks: [source.result.chunks[1]], totalChunks: 2, sourceIdentity: 'extraction-v2' });
    await expect(retrieveDocumentCandidates('water', [source], hybrid, options())).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(contexts.embedding.embedding).toHaveBeenCalledTimes(1); expect(storage.data.size).toBe(0);
  });

  it('publishes tokenizer-bounded long prose subchunks with real source-relative offsets beyond 4000', async () => {
    const text = 'x'.repeat(4500); const source = entry('long', [{ index: 0, text, kind: 'paragraph', sourceStart: 100, sourceEnd: 4600 }]);
    const tokenize = async (input: string) => ({ tokens: Array(Math.ceil(input.length / 4)).fill(10) });
    contexts.embedding.tokenize.mockImplementation(tokenize);
    const result = await retrieveDocumentCandidates('source', [source], hybrid, options());
    expect(result.actualMode).toBe('hybrid'); expect(result.fallbackReason).toBeUndefined();
    const rows = [...storage.data.entries()].filter(([key]) => !key.endsWith(':ready')).flatMap(([, raw]) => JSON.parse(raw));
    expect(rows.length).toBeGreaterThan(1); expect(rows.at(-1).end).toBe(4500);
    expect(rows.every(row => row.chunk.text.length <= LIMITS.subchunkCharacters && row.chunk.sourceStart === row.start + 100
      && row.chunk.sourceEnd === row.end + 100)).toBe(true);
    expect(contexts.embedding.embedding.mock.calls.every(([input]) => Math.ceil(input.length / 4) + 2 <= 511)).toBe(true);
  });

  it('returns provisional indexes for uncommitted attachments without publishing private readiness', async () => {
    const source = entry(); source.attachment.threadId = 'draft';
    const result = await retrieveDocumentCandidates('water', [source], hybrid, options({ assertProvisionalEntryCurrent: jest.fn() }));
    expect(result.actualMode).toBe('hybrid'); expect(result.preparedIndexes.has(source.attachment.id)).toBe(true);
    expect(storage.data.size).toBe(0);
  });

  it('keeps overview and legacy lexical requests on their original nonnative route', async () => {
    for (const query of ['', 'summarize the document']) {
      const result = await retrieveDocumentCandidates(query, [entry()], hybridRank, options());
      expect(result.actualMode).toBe('lexical'); expect(result.fallbackReason).toBeUndefined();
    }
    const legacy = await retrieveDocumentCandidates('water', [entry()], { mode: 'lexical', rerank: false }, options());
    expect(legacy.actualMode).toBe('lexical'); expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
    expect(claimNativePooledEmbeddingDimension).not.toHaveBeenCalled();
  });
});
