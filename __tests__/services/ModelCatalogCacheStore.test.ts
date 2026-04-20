import { ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { createStorage } from '../../src/services/storage';
import { ModelCatalogCacheStore } from '../../src/services/ModelCatalogCacheStore';

const STORAGE_ID = 'model-catalog-cache';
const SEARCH_CACHE_KEY = 'catalog-search-cache-v1';
const SNAPSHOT_CACHE_KEY = 'catalog-snapshot-cache-v1';

function clearCacheStorage() {
  createStorage(STORAGE_ID, { tier: 'cache' }).clearAll();
}

function buildModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'model',
    author: 'org',
    // The normalizer fills a lot of fields; we only need the ones used by cache sanitation.
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    ...overrides,
  } as any;
}

describe('ModelCatalogCacheStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    clearCacheStorage();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores and returns cached search results, respecting maxAge', () => {
    const store = new ModelCatalogCacheStore();
    const scope = {
      query: 'q',
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };

    expect(store.getSearch(scope, 1000)).toBeNull();

    store.putSearch(scope, {
      models: [buildModel({ id: 'a/model' })],
      hasMore: true,
      nextCursor: 'c1',
    });

    const fresh = store.getSearch(scope, 1000);
    expect(fresh).toEqual(expect.objectContaining({
      hasMore: true,
      nextCursor: 'c1',
      models: [expect.objectContaining({ id: 'a/model' })],
    }));

    jest.advanceTimersByTime(2000);
    expect(store.getSearch(scope, 1000)).toBeNull();
  });

  it('persists only anonymous search results; authenticated results stay in memory only', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    store.putSearch(anonScope, { models: [buildModel({ id: 'anon' })], hasMore: false, nextCursor: null });
    const persistedA = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persistedA.entries.every((entry: any) => entry.scope?.authScope === 'anon')).toBe(true);

    const authScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'auth' as const };
    store.putSearch(authScope, { models: [buildModel({ id: 'auth' })], hasMore: false, nextCursor: null });
    const persistedB = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persistedB.entries.every((entry: any) => entry.scope?.authScope === 'anon')).toBe(true);
  });

  it('prunes old search entries beyond MAX_PERSISTED_SEARCH_ENTRIES', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    for (let i = 0; i < 10; i += 1) {
      jest.setSystemTime(new Date(`2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
      store.putSearch(
        { query: `q${i}`, cursor: null, pageSize: 20, sort: null, authScope: 'anon' },
        { models: [buildModel({ id: `m${i}` })], hasMore: false, nextCursor: null },
      );
    }

    const persisted = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persisted.entries).toHaveLength(6);

    const queries = persisted.entries.map((entry: any) => entry.scope?.query);
    expect(queries).toEqual(['q9', 'q8', 'q7', 'q6', 'q5', 'q4']);
  });

  it('stores and returns model snapshots and respects authScope persistence', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putModelSnapshots([buildModel({ id: 'snap-a' })], 'anon');
    expect(store.getModelSnapshot('snap-a', 'anon', 1000)?.id).toBe('snap-a');
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toContain('snap-a');

    store.putModelSnapshots([buildModel({ id: 'snap-b', accessState: ModelAccessState.AUTHORIZED })], 'auth');
    expect(store.getModelSnapshot('snap-b', 'auth', 1000)?.id).toBe('snap-b');
    const raw = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    expect(raw).toContain('snap-a');
    expect(raw).not.toContain('snap-b');
  });

  it('loads persisted payloads, drops invalid versions, and sanitizes anonymous auth states', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    // invalid payload should be removed
    storage.set(SEARCH_CACHE_KEY, '{not-json');

    // snapshot payload with AUTHORIZED model stored under anon should be sanitized
    const now = Date.now();
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 2,
      entries: [
        {
          id: 'gated/model',
          authScope: 'anon',
          timestamp: now,
          model: {
            id: 'gated/model',
            accessState: ModelAccessState.AUTHORIZED,
            isGated: true,
            isPrivate: false,
          },
        },
      ],
    }));

    const store = new ModelCatalogCacheStore();

    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();

    const snapshot = store.getModelSnapshot('gated/model', 'anon', 1000);
    expect(snapshot?.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
  });

  it('reports persisted size and supports clearing caches', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putSearch({ query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' }, {
      models: [buildModel({ id: 'x' })],
      hasMore: false,
      nextCursor: null,
    });
    store.putModelSnapshots([buildModel({ id: 'y' })], 'anon');

    expect(store.getPersistedSizeBytes()).toBeGreaterThan(0);

    store.clearSnapshots();
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
    expect(store.getModelSnapshot('y', 'anon', 1000)).toBeNull();

    store.clearAll();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
  });
});
