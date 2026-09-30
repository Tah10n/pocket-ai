jest.mock('../../src/store/storage', () => ({ getAppStorage: jest.fn() }));

import type { AppStorageFacade } from '../../src/store/storage';
import {
  DocumentIndexStore, validateDocumentVector, type DocumentIndexRow, type PrivateDocumentIndex,
} from '../../src/services/DocumentIndexStore';
import {
  DOCUMENT_RETRIEVAL_LIMITS, DocumentRetrievalError, type DocumentIndexIdentity,
} from '../../src/types/documentRetrieval';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function createPrivateStorage() {
  const data = new Map<string, string>();
  const facade = {
    set: jest.fn((key: string, value: boolean | string | number | ArrayBuffer) => {
      if (typeof value !== 'string') throw new Error('Expected a bounded encrypted string record.');
      data.set(key, value);
    }),
    getString: jest.fn((key: string) => data.get(key)),
    getNumber: jest.fn((key: string) => data.has(key) ? Number(data.get(key)) : undefined),
    getBoolean: jest.fn((key: string) => data.has(key) ? data.get(key) === 'true' : undefined),
    contains: jest.fn((key: string) => data.has(key)),
    getAllKeys: jest.fn(() => [...data.keys()]),
    remove: jest.fn((key: string) => data.delete(key)),
    clearAll: jest.fn(() => { data.clear(); }),
  } satisfies AppStorageFacade;
  return { data, facade };
}

function createIdentity(overrides: Partial<DocumentIndexIdentity> = {}): DocumentIndexIdentity {
  return {
    documentSha256: 'a'.repeat(64), extractionIdentity: 'anydoc-pinned-v1', chunkingVersion: 'structural-v1',
    preprocessingVersion: 'embedding-subchunks-v1', modelSha256: 'b'.repeat(64), modelRevision: 'revision-1',
    modelBytes: 128, tokenizerIdentity: 'tokenizer-1', pooling: 'mean', normalization: 2,
    queryPrefix: 'query: ', documentPrefix: 'passage: ', dimensions: 2, vectorFormat: 'float32',
    runtimeIdentity: 'llama.rn-0.13.0-rc.3-patch-sha', ...overrides,
  };
}

function createRows(count = 1): DocumentIndexRow[] {
  return Array.from({ length: count }, (_, index) => {
    const text = `Source ${index}`;
    return { chunk: { index, text, kind: 'paragraph', pageNumber: index + 1, heading: `Heading ${index}` },
      start: 0, end: text.length, vector: [1, 0] };
  });
}

function createIndex(count = 1, identity = createIdentity()): PrivateDocumentIndex {
  return { identity, rows: createRows(count) };
}

async function finish<T>(operation: Promise<T>): Promise<T> {
  const outcome = operation.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  await jest.runAllTimersAsync();
  const settled = await outcome;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

describe('DocumentIndexStore private derived data', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('publishes bounded immutable shards before readiness and reuses the index after restart', async () => {
    const { facade, data } = createPrivateStorage();
    data.set('chat-store:unrelated', 'private user history');
    const store = new DocumentIndexStore(() => facade);
    const index = createIndex(DOCUMENT_RETRIEVAL_LIMITS.shardRows + 1);
    const publication = store.publish('chat-a', 'attachment-a', index, () => {});
    expect([...data.keys()].some(key => key.endsWith('ready'))).toBe(false);
    await finish(publication);
    const writes = facade.set.mock.calls;
    expect(writes).toHaveLength(3);
    expect(writes.at(-1)?.[0]).toMatch(/:ready$/u);
    expect(writes.slice(0, -1).every(([, raw]) => JSON.parse(raw as string).length <= DOCUMENT_RETRIEVAL_LIMITS.shardRows)).toBe(true);
    const restarted = new DocumentIndexStore(() => facade);
    restarted.reconcile();
    await expect(finish(restarted.read('chat-a', 'attachment-a', index.identity, () => {}))).resolves.toEqual(index);
    expect(data.get('chat-store:unrelated')).toBe('private user history');
  });

  it.each([
    ['source bytes', { documentSha256: 'c'.repeat(64) }],
    ['embedding model bytes', { modelSha256: 'c'.repeat(64) }],
    ['revision', { modelRevision: 'revision-2' }],
    ['byte length', { modelBytes: 129 }],
    ['tokenizer', { tokenizerIdentity: 'tokenizer-2' }],
    ['pooling', { pooling: 'cls' as const }],
    ['query prefix', { queryPrefix: 'search_query: ' }],
    ['document prefix', { documentPrefix: 'search_document: ' }],
    ['extraction', { extractionIdentity: 'anydoc-pinned-v2' }],
    ['chunking', { chunkingVersion: 'structural-v2' }],
    ['preprocessing', { preprocessingVersion: 'embedding-subchunks-v2' }],
    ['runtime patch', { runtimeIdentity: 'different-patch-sha' }],
  ] satisfies [string, Partial<DocumentIndexIdentity>][])('rejects a changed %s despite the same vector dimensions', async (_name, changed) => {
    const { facade } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    const index = createIndex();
    await finish(store.publish('chat', 'attachment', index, () => {}));
    await expect(store.read('chat', 'attachment', createIdentity(changed), () => {})).resolves.toBeNull();
    await expect(finish(store.read('chat', 'attachment', index.identity, () => {}))).resolves.toEqual(index);
  });

  it.each([
    ['empty', []], ['NaN', [NaN, 0]], ['infinite', [Infinity, 0]], ['wrong dimensions', [1]],
    ['zero norm', [0, 0]], ['nonunit norm', [0.5, 0.5]], ['float32 overflow', [1e50, 0]],
  ])('rejects %s vectors before publishing a ready generation', async (_name, vector) => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    const index = createIndex();
    index.rows[0].vector = vector;
    await expect(store.publish('chat', 'attachment', index, () => {})).rejects.toMatchObject({ code: 'invalid_vector' });
    expect(data.size).toBe(0);
    expect(() => validateDocumentVector(vector, 2)).toThrow(DocumentRetrievalError);
  });

  it.each(['malformed JSON', 'missing shard', 'NaN vector', 'duplicate source range', 'manifest byte mismatch', 'unknown kind', 'partial source range', 'false source range'])('rejects a persisted %s and removes only its damaged index', async (damage) => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    const index = createIndex(2);
    await finish(store.publish('chat', 'attachment', index, () => {}));
    await finish(store.publish('other-chat', 'other-attachment', createIndex(), () => {}));
    const ready = [...data.keys()].find(key => key.startsWith('document-retrieval-v1:chat:attachment:') && key.endsWith('ready'))!;
    const manifest = JSON.parse(data.get(ready)!);
    const shard = `${manifest.scope}${manifest.job}:0`;
    if (damage === 'malformed JSON') data.set(shard, '{broken');
    else if (damage === 'missing shard') data.delete(shard);
    else if (damage === 'manifest byte mismatch') { manifest.bytes++; data.set(ready, JSON.stringify(manifest)); }
    else {
      const rows = JSON.parse(data.get(shard)!);
      if (damage === 'NaN vector') rows[0].vector = [null, 0];
      else if (damage === 'unknown kind') rows[0].chunk.kind = 'invented';
      else if (damage === 'partial source range') rows[0].chunk.sourceStart = 0;
      else if (damage === 'false source range') { rows[0].chunk.sourceStart = 0; rows[0].chunk.sourceEnd = 999; }
      else rows[1] = rows[0];
      manifest.bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
      data.set(ready, JSON.stringify(manifest));
      data.set(shard, JSON.stringify(rows));
    }
    await expect(finish(store.read('chat', 'attachment', index.identity, () => {}))).resolves.toBeNull();
    expect(data.has(ready)).toBe(false);
    await expect(finish(store.read('other-chat', 'other-attachment', index.identity, () => {}))).resolves.not.toBeNull();
  });

  it('purges only unpublished shards and invalid manifests during restart reconciliation', async () => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    await finish(store.publish('chat', 'attachment', createIndex(), () => {}));
    data.set('document-retrieval-v1:chat:attachment:unfinished:0', 'private derived orphan');
    data.set('document-retrieval-v1:damaged:attachment:ready', '{broken');
    data.set('settings-unrelated', 'keep');
    const restarted = new DocumentIndexStore(() => facade);
    restarted.reconcile();
    expect(data.has('document-retrieval-v1:chat:attachment:unfinished:0')).toBe(false);
    expect(data.has('document-retrieval-v1:damaged:attachment:ready')).toBe(false);
    expect(data.get('settings-unrelated')).toBe('keep');
    await expect(finish(restarted.read('chat', 'attachment', createIdentity(), () => {}))).resolves.not.toBeNull();
  });

  it('cancels a partial replacement without changing the previous ready index', async () => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    const previous = createIndex();
    await finish(store.publish('chat', 'attachment', previous, () => {}));
    const readyKey = [...data.keys()].find(key => key.endsWith('ready'))!;
    const readyBefore = data.get(readyKey);
    const firstShard = deferred<void>();
    facade.set.mockImplementation((key, value) => { data.set(key, value as string); firstShard.resolve(); });
    let cancelled = false;
    const replacement = store.publish('chat', 'attachment', createIndex(9, createIdentity({ queryPrefix: 'new: ' })), () => {
      if (cancelled) throw new DocumentRetrievalError('cancelled');
    });
    const rejection = expect(replacement).rejects.toMatchObject({ code: 'cancelled' });
    await firstShard.promise;
    cancelled = true;
    await jest.runAllTimersAsync();
    await rejection;
    expect(data.get(readyKey)).toBe(readyBefore);
    expect([...data.keys()].filter(key => !key.endsWith('ready'))).toHaveLength(1);
    await expect(finish(store.read('chat', 'attachment', previous.identity, () => {}))).resolves.toEqual(previous);
  });

  it.each(['clear', 'remove', 'retain'])('prevents deferred publication resurrection after %s while preserving other chats', async (action) => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    await finish(store.publish('other-chat', 'attachment', createIndex(), () => {}));
    const firstShard = deferred<void>();
    facade.set.mockImplementation((key, value) => { data.set(key, value as string); firstShard.resolve(); });
    const pending = store.publish('chat', 'attachment', createIndex(9), () => {});
    const rejection = expect(pending).rejects.toMatchObject({ code: 'ownership_changed' });
    await firstShard.promise;
    if (action === 'clear') store.clear();
    else if (action === 'remove') store.remove('chat', 'attachment');
    else store.retain('chat', new Set());
    await jest.runAllTimersAsync();
    await rejection;
    await expect(store.read('chat', 'attachment', createIdentity(), () => {})).resolves.toBeNull();
    const other = await finish(store.read('other-chat', 'attachment', createIdentity(), () => {}));
    if (action === 'clear') expect(other).toBeNull();
    else expect(other).not.toBeNull();
  });

  it('retains restored branch owners and removes committed tail indexes without touching another chat', async () => {
    const { facade } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    await finish(store.publish('chat', 'old-branch', createIndex(), () => {}));
    await finish(store.publish('chat', 'tail', createIndex(), () => {}));
    await finish(store.publish('other-chat', 'tail', createIndex(), () => {}));
    store.retain('chat', new Set(['old-branch', 'tail'])); // Empty replacement rolled back.
    await expect(finish(store.read('chat', 'tail', createIdentity(), () => {}))).resolves.not.toBeNull();
    store.retain('chat', new Set(['old-branch'])); // Terminal branch write committed.
    await expect(store.read('chat', 'tail', createIdentity(), () => {})).resolves.toBeNull();
    await expect(finish(store.read('chat', 'old-branch', createIdentity(), () => {}))).resolves.not.toBeNull();
    await expect(finish(store.read('other-chat', 'tail', createIdentity(), () => {}))).resolves.not.toBeNull();
  });

  it('does not serve another chat with identical document bytes', async () => {
    const { facade } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    await finish(store.publish('owner-chat', 'attachment', createIndex(), () => {}));
    await expect(store.read('foreign-chat', 'attachment', createIdentity(), () => {})).resolves.toBeNull();
  });

  it('checks index dimensions and vector allocation quotas before acquiring storage or copying vectors', async () => {
    const { facade } = createPrivateStorage();
    const provider = jest.fn(() => facade);
    const store = new DocumentIndexStore(provider);
    await expect(store.publish('chat', 'attachment', createIndex(300, createIdentity({ dimensions: 4096 })), () => {}))
      .rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(provider).not.toHaveBeenCalled();
    await expect(store.publish('chat', 'attachment', createIndex(2049), () => {})).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(provider).not.toHaveBeenCalled();
    await expect(store.publish('chat', 'attachment', createIndex(1, createIdentity({ dimensions: 4097 })), () => {}))
      .rejects.toMatchObject({ code: 'index_stale' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('enforces the document quota before serializing a fifth index', async () => {
    const { facade } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    for (let document = 0; document < DOCUMENT_RETRIEVAL_LIMITS.documents; document++) {
      await finish(store.publish('chat', `attachment-${document}`, createIndex(), () => {}));
    }
    const index = createIndex();
    const getVector = jest.fn(() => [1, 0]);
    Object.defineProperty(index.rows[0], 'vector', { get: getVector });
    await expect(store.publish('chat', 'attachment-extra', index, () => {})).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(getVector).not.toHaveBeenCalled();
  });

  it('rejects a shard exceeding its byte quota while preserving the old ready generation', async () => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    const previous = createIndex();
    await finish(store.publish('chat', 'attachment', previous, () => {}));
    const readyKey = [...data.keys()].find(key => key.endsWith('ready'))!;
    const readyBefore = data.get(readyKey);
    const replacement = createIndex(8, createIdentity({ dimensions: 4095 }));
    replacement.rows.forEach(row => { row.vector = Array.from({ length: 4095 }, () => 1 / Math.sqrt(4095)); });
    await expect(store.publish('chat', 'attachment', replacement, () => {})).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(data.get(readyKey)).toBe(readyBefore);
    await expect(finish(store.read('chat', 'attachment', previous.identity, () => {}))).resolves.toEqual(previous);
  });

  it('accounts for the previous ready generation in the aggregate cache quota during replacement', async () => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    const large = createIndex(1800);
    large.rows.forEach(row => { row.chunk.text = 'x'.repeat(4000); row.end = 4000; });
    for (let document = 0; document < DOCUMENT_RETRIEVAL_LIMITS.documents; document++) {
      await finish(store.publish('chat', `attachment-${document}`, large, () => {}));
    }
    const readyKey = [...data.keys()].find(key => key.startsWith('document-retrieval-v1:chat:attachment-0:') && key.endsWith('ready'))!;
    const readyBefore = data.get(readyKey);
    const replacement = store.publish('chat', 'attachment-0', large, () => {});
    const rejection = expect(replacement).rejects.toMatchObject({ code: 'quota_exceeded' });
    await jest.runAllTimersAsync();
    await rejection;
    expect(data.get(readyKey)).toBe(readyBefore);
    const readyManifests = [...data.entries()].filter(([key]) => key.endsWith('ready')).map(([, value]) => JSON.parse(value));
    expect(readyManifests.reduce((sum, manifest) => sum + manifest.bytes, 0)).toBeLessThanOrEqual(DOCUMENT_RETRIEVAL_LIMITS.cacheBytes);
    expect(data.size).toBe(4 * (Math.ceil(large.rows.length / DOCUMENT_RETRIEVAL_LIMITS.shardRows) + 1));
  });

  it('preserves the previous ready index after a failed manifest write', async () => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    const previous = createIndex();
    await finish(store.publish('chat', 'attachment', previous, () => {}));
    facade.set.mockImplementation((key, value) => {
      if (key.endsWith('ready')) throw new Error('private storage write failed');
      data.set(key, value as string);
    });
    const replacement = store.publish('chat', 'attachment', createIndex(9), () => {});
    const rejection = expect(replacement).rejects.toThrow('private storage write failed');
    await jest.runAllTimersAsync();
    await rejection;
    await expect(finish(store.read('chat', 'attachment', previous.identity, () => {}))).resolves.toEqual(previous);
  });

  it('releases its writer reservation even when failed-publication cleanup also throws', async () => {
    const { facade, data } = createPrivateStorage();
    const store = new DocumentIndexStore(() => facade);
    facade.set.mockImplementationOnce(() => { throw new Error('private write failed'); });
    facade.remove.mockImplementationOnce(() => { throw new Error('private cleanup failed'); });
    await expect(store.publish('chat', 'attachment', createIndex(), () => {})).rejects.toThrow();
    expect(data.size).toBe(0);
    await expect(finish(store.publish('chat', 'attachment', createIndex(), () => {}))).resolves.toBeUndefined();
  });

  it('propagates private storage read blocking and prevents publication after ownership changed', async () => {
    const blocked = new Error('private storage unavailable');
    const store = new DocumentIndexStore(() => { throw blocked; });
    await expect(store.read('chat', 'attachment', createIdentity(), () => {})).rejects.toBe(blocked);
    const { facade } = createPrivateStorage();
    const owned = new DocumentIndexStore(() => facade);
    await finish(owned.publish('chat', 'attachment', createIndex(9), () => {}));
    let cancelled = false;
    const pendingRead = owned.read('chat', 'attachment', createIdentity(), () => {
      if (cancelled) throw new DocumentRetrievalError('cancelled');
    });
    const rejection = expect(pendingRead).rejects.toMatchObject({ code: 'cancelled' });
    cancelled = true;
    await jest.runAllTimersAsync();
    await rejection;
    await expect(finish(owned.read('chat', 'attachment', createIdentity(), () => {}))).resolves.not.toBeNull();
  });
});
