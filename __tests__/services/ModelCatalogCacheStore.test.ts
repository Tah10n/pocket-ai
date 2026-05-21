import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
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

  it('sanitizes gated and private models in anonymous search caches', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [
        buildModel({ id: 'public/model' }),
        buildModel({
          id: 'gated/model',
          accessState: ModelAccessState.AUTHORIZED,
          isGated: true,
          resolvedFileName: 'secret.Q8_0.gguf',
          activeVariantId: 'secret.Q8_0.gguf',
          variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
        }),
        buildModel({
          id: 'private/model',
          accessState: ModelAccessState.AUTHORIZED,
          isPrivate: true,
          resolvedFileName: 'private.Q8_0.gguf',
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });

    const cached = store.getSearch(anonScope, 1000);
    expect(cached?.models.map((model) => model.id)).toEqual(['public/model', 'gated/model']);
    const gated = cached?.models.find((model) => model.id === 'gated/model');
    expect(gated).toEqual(expect.objectContaining({
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    }));
    expect(gated?.resolvedFileName).toBeUndefined();
    expect(gated?.activeVariantId).toBeUndefined();
    expect(gated?.variants).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).toContain('public/model');
    expect(raw).toContain('gated/model');
    expect(raw).not.toContain('secret.Q8_0.gguf');
    expect(raw).not.toContain('private/model');
  });

  it('caps persisted public variants while preserving the active variant', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const variants = Array.from({ length: 14 }, (_value, index) => ({
      variantId: `model-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      fileName: `model-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      quantizationLabel: 'Q4_K_M',
      size: (index + 1) * 1024 * 1024 * 1024,
      isLocal: true,
    }));
    const activeVariant = {
      variantId: 'model-active.Q8_0.gguf',
      fileName: 'model-active.Q8_0.gguf',
      quantizationLabel: 'Q8_0',
      size: 16 * 1024 * 1024 * 1024,
      isLocal: true,
    };

    store.putSearch(anonScope, {
      models: [buildModel({
        id: 'public/large-variant-list',
        resolvedFileName: activeVariant.fileName,
        activeVariantId: activeVariant.variantId,
        variants: [...variants, activeVariant],
      })],
      hasMore: false,
      nextCursor: null,
    });

    const cached = store.getSearch(anonScope, 1000);
    const model = cached?.models[0];
    expect(model?.variants).toHaveLength(12);
    expect(model?.variants?.some((variant) => variant.fileName === activeVariant.fileName)).toBe(true);
    expect(model?.variants?.some((variant) => variant.isLocal === true)).toBe(false);

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    const persisted = JSON.parse(raw) as any;
    expect(persisted.version).toBe(4);
    expect(persisted.entries[0].result.models[0].variants).toHaveLength(12);
    expect(raw).toContain(activeVariant.fileName);
    expect(raw).not.toContain('isLocal');
  });

  it('strips local runtime fields from public anonymous cache entries', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [buildModel({
        id: 'public/downloaded-model',
        localPath: 'private-local-file.gguf',
        downloadedAt: 123,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 123,
          checkedAt: 456,
          sha256: 'a'.repeat(64),
        },
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        metadataTrust: 'verified_local',
        sha256: 'a'.repeat(64),
        resumeData: 'resume-token',
      })],
      hasMore: false,
      nextCursor: null,
    });

    const cached = store.getSearch(anonScope, 1000);
    const model = cached?.models[0];
    expect(model).toEqual(expect.objectContaining({
      id: 'public/downloaded-model',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    }));
    expect(model?.localPath).toBeUndefined();
    expect(model?.downloadedAt).toBeUndefined();
    expect(model?.downloadIntegrity).toBeUndefined();
    expect(model?.metadataTrust).toBeUndefined();
    expect(model?.sha256).toBeUndefined();
    expect(model?.resumeData).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).not.toContain('private-local-file.gguf');
    expect(raw).not.toContain('resume-token');
  });

  it('migrates version 3 search payloads to version 4 with variant limiting', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const scope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const variants = Array.from({ length: 14 }, (_value, index) => ({
      variantId: `legacy-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      fileName: `legacy-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      quantizationLabel: 'Q4_K_M',
      size: (index + 1) * 1024,
    }));
    const activeVariant = {
      variantId: 'legacy-active.Q8_0.gguf',
      fileName: 'legacy-active.Q8_0.gguf',
      quantizationLabel: 'Q8_0',
      size: 16 * 1024,
    };

    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 3,
      entries: [{
        key: 'q::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope,
        result: {
          models: [buildModel({
            id: 'public/legacy-large-variant-list',
            resolvedFileName: activeVariant.fileName,
            activeVariantId: activeVariant.variantId,
            variants: [...variants, activeVariant],
          })],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const cached = store.getSearch(scope, 1000);
    const model = cached?.models[0];
    expect(model?.variants).toHaveLength(12);
    expect(model?.variants?.some((variant) => variant.fileName === activeVariant.fileName)).toBe(true);
    expect(model?.variants?.some((variant) => variant.isLocal === true)).toBe(false);

    const persisted = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persisted.version).toBe(4);
    expect(persisted.entries[0].result.models[0].variants).toHaveLength(12);
    expect(persisted.entries[0].result.models[0].variants.some(
      (variant: any) => variant.fileName === activeVariant.fileName,
    )).toBe(true);
    expect(storage.getString(SEARCH_CACHE_KEY)).not.toContain('isLocal');
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

    const reloadedStore = new ModelCatalogCacheStore();
    expect(reloadedStore.getModelSnapshot('snap-a', 'anon', 1000)?.id).toBe('snap-a');
    expect(reloadedStore.getModelSnapshot('snap-b', 'auth', 1000)).toBeNull();
  });

  it('loads persisted payloads, drops invalid versions, and strips anonymous auth states', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    // invalid payload should be removed
    storage.set(SEARCH_CACHE_KEY, '{not-json');

    // snapshot payload with AUTHORIZED model stored under anon should be sanitized
    const now = Date.now();
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 4,
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
            resolvedFileName: 'secret.Q8_0.gguf',
            activeVariantId: 'secret.Q8_0.gguf',
            variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
          },
        },
        {
          id: 'private/model',
          authScope: 'anon',
          timestamp: now,
          model: {
            id: 'private/model',
            accessState: ModelAccessState.AUTHORIZED,
            isGated: false,
            isPrivate: true,
          },
        },
      ],
    }));

    const store = new ModelCatalogCacheStore();

    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();

    const snapshot = store.getModelSnapshot('gated/model', 'anon', 1000);
    expect(snapshot?.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    expect(snapshot?.resolvedFileName).toBeUndefined();
    expect(snapshot?.activeVariantId).toBeUndefined();
    expect(snapshot?.variants).toBeUndefined();
    expect(store.getModelSnapshot('private/model', 'anon', 1000)).toBeNull();
  });

  it('drops legacy version 2 search payloads to clear auth-derived anonymous query caches', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const legacyScope = {
      query: 'private-org/exact-repo',
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };

    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 2,
      entries: [{
        key: 'private-org/exact-repo::null::20::null::anon',
        timestamp: Date.now(),
        scope: legacyScope,
        result: {
          models: [buildModel({ id: 'private-org/exact-repo' })],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));

    const store = new ModelCatalogCacheStore();

    expect(store.getSearch(legacyScope, 1000)).toBeNull();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
  });

  it('migrates version 3 snapshot payloads to version 4 with anonymous sanitization', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 3,
      entries: [
        {
          id: 'legacy/gated-snapshot',
          authScope: 'anon',
          timestamp: Date.now(),
          model: buildModel({
            id: 'legacy/gated-snapshot',
            accessState: ModelAccessState.AUTHORIZED,
            isGated: true,
            isPrivate: false,
            resolvedFileName: 'secret.Q8_0.gguf',
            activeVariantId: 'secret.Q8_0.gguf',
            variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
          }),
        },
        {
          id: 'legacy/private-snapshot',
          authScope: 'anon',
          timestamp: Date.now(),
          model: buildModel({
            id: 'legacy/private-snapshot',
            accessState: ModelAccessState.AUTHORIZED,
            isPrivate: true,
          }),
        },
      ],
    }));

    const store = new ModelCatalogCacheStore();

    const snapshot = store.getModelSnapshot('legacy/gated-snapshot', 'anon', 1000);
    expect(snapshot).toEqual(expect.objectContaining({
      id: 'legacy/gated-snapshot',
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    }));
    expect(snapshot?.resolvedFileName).toBeUndefined();
    expect(snapshot?.activeVariantId).toBeUndefined();
    expect(snapshot?.variants).toBeUndefined();
    expect(store.getModelSnapshot('legacy/private-snapshot', 'anon', 1000)).toBeNull();

    const raw = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    const persisted = JSON.parse(raw) as any;
    expect(persisted.version).toBe(4);
    expect(raw).toContain('legacy/gated-snapshot');
    expect(raw).not.toContain('secret.Q8_0.gguf');
    expect(raw).not.toContain('legacy/private-snapshot');
  });

  it('strips inaccessible anonymous snapshots before storing them in memory or persistence', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putModelSnapshots([
      buildModel({
        id: 'gated/snapshot',
        accessState: ModelAccessState.AUTHORIZED,
        isGated: true,
        resolvedFileName: 'secret.Q8_0.gguf',
        activeVariantId: 'secret.Q8_0.gguf',
        variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
      }),
      buildModel({
        id: 'private/snapshot',
        accessState: ModelAccessState.AUTHORIZED,
        isPrivate: true,
      }),
    ], 'anon');

    const cached = store.getModelSnapshot('gated/snapshot', 'anon', 1000);
    expect(cached).toEqual(expect.objectContaining({
      id: 'gated/snapshot',
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
    }));
    expect(cached?.resolvedFileName).toBeUndefined();
    expect(cached?.activeVariantId).toBeUndefined();
    expect(cached?.variants).toBeUndefined();
    expect(store.getModelSnapshot('private/snapshot', 'anon', 1000)).toBeNull();

    const raw = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    expect(raw).toContain('gated/snapshot');
    expect(raw).not.toContain('secret.Q8_0.gguf');
    expect(raw).not.toContain('private/snapshot');
  });

  it('deletes stale anonymous snapshots when a model becomes private', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putModelSnapshots([
      buildModel({
        id: 'stale/private',
        resolvedFileName: 'public.Q4_K_M.gguf',
        activeVariantId: 'public.Q4_K_M.gguf',
      }),
    ], 'anon');
    expect(store.getModelSnapshot('stale/private', 'anon', 1000)).toEqual(expect.objectContaining({
      resolvedFileName: 'public.Q4_K_M.gguf',
    }));

    store.deleteModelSnapshots(['stale/private'], 'anon');

    expect(store.getModelSnapshot('stale/private', 'anon', 1000)).toBeNull();
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).not.toContain('stale/private');
  });

  it('reconciles existing anonymous search entries when auth metadata changes visibility', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [
        buildModel({ id: 'public/model' }),
        buildModel({
          id: 'stale/gated',
          resolvedFileName: 'stale-gated.Q8_0.gguf',
          activeVariantId: 'stale-gated.Q8_0.gguf',
          variants: [{ variantId: 'stale-gated.Q8_0.gguf', fileName: 'stale-gated.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
        }),
        buildModel({
          id: 'stale/private',
          resolvedFileName: 'stale-private.Q8_0.gguf',
          activeVariantId: 'stale-private.Q8_0.gguf',
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });

    store.reconcileAnonymousSearchModels([
      buildModel({
        id: 'stale/gated',
        accessState: ModelAccessState.AUTHORIZED,
        isGated: true,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        resolvedFileName: 'secret.Q8_0.gguf',
        activeVariantId: 'secret.Q8_0.gguf',
        variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
      }),
      buildModel({
        id: 'stale/private',
        accessState: ModelAccessState.AUTHORIZED,
        isPrivate: true,
        resolvedFileName: 'private.Q8_0.gguf',
      }),
    ]);

    const cached = store.getSearch(anonScope, 1000);
    expect(cached?.models.map((model) => model.id)).toEqual(['public/model', 'stale/gated']);
    const gated = cached?.models.find((model) => model.id === 'stale/gated');
    expect(gated).toEqual(expect.objectContaining({
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    }));
    expect(gated?.resolvedFileName).toBeUndefined();
    expect(gated?.activeVariantId).toBeUndefined();
    expect(gated?.variants).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).not.toContain('stale-gated.Q8_0.gguf');
    expect(raw).not.toContain('stale-private');
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
