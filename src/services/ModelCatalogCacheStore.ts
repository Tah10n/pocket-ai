import { ModelAccessState, type ModelMetadata } from '../types/models';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { createStorage } from './storage';

export type CatalogCacheAuthScope = 'anon' | 'auth';
export type CatalogCacheSort = 'downloads' | 'likes' | 'lastModified' | null;

export type CatalogCacheScope = {
  query: string;
  cursor: string | null;
  pageSize: number;
  sort: CatalogCacheSort;
  authScope: CatalogCacheAuthScope;
};

export type CatalogCacheResult = {
  models: ModelMetadata[];
  hasMore: boolean;
  nextCursor: string | null;
};

type SearchCacheEntry = {
  key: string;
  timestamp: number;
  scope: CatalogCacheScope;
  result: CatalogCacheResult;
};

type SnapshotCacheEntry = {
  key: string;
  id: string;
  authScope: CatalogCacheAuthScope;
  timestamp: number;
  model: ModelMetadata;
};

type PersistedPayload<T> = {
  version: number;
  entries: T[];
};

const STORAGE_ID = 'model-catalog-cache';
const SEARCH_CACHE_KEY = 'catalog-search-cache-v1';
const SNAPSHOT_CACHE_KEY = 'catalog-snapshot-cache-v1';
const PERSISTED_CACHE_VERSION = 2;
const MAX_PERSISTED_SEARCH_ENTRIES = 6;
const MAX_PERSISTED_SNAPSHOT_ENTRIES = 40;
const PERSISTED_CACHE_KEYS = [SEARCH_CACHE_KEY, SNAPSHOT_CACHE_KEY] as const;

function getTextByteLength(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }

  return unescape(encodeURIComponent(value)).length;
}

function isSort(value: unknown): value is CatalogCacheSort {
  return value === null
    || value === 'downloads'
    || value === 'likes'
    || value === 'lastModified';
}

function normalizeModels(models: unknown): ModelMetadata[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .filter((entry): entry is Partial<ModelMetadata> & { id: string } => (
      Boolean(entry)
      && typeof entry === 'object'
      && typeof (entry as { id?: unknown }).id === 'string'
    ))
    .map((entry) => normalizePersistedModelMetadata(entry));
}

function inferSnapshotAuthScope(model: ModelMetadata): CatalogCacheAuthScope {
  return model.accessState === ModelAccessState.AUTHORIZED
    || model.accessState === ModelAccessState.ACCESS_DENIED
    ? 'auth'
    : 'anon';
}

function buildSnapshotKey(modelId: string, authScope: CatalogCacheAuthScope): string {
  return `${modelId}::${authScope}`;
}

function normalizeSearchResult(value: unknown): CatalogCacheResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    models?: unknown;
    hasMore?: unknown;
    nextCursor?: unknown;
  };
  const models = normalizeModels(candidate.models);
  const hasMore = candidate.hasMore === true;
  const nextCursor = typeof candidate.nextCursor === 'string' ? candidate.nextCursor : null;

  return {
    models,
    hasMore,
    nextCursor,
  };
}

function normalizeSearchScope(value: unknown): CatalogCacheScope | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CatalogCacheScope>;
  if (typeof candidate.query !== 'string') {
    return null;
  }

  return {
    query: candidate.query,
    cursor: typeof candidate.cursor === 'string' ? candidate.cursor : null,
    pageSize: typeof candidate.pageSize === 'number' && Number.isFinite(candidate.pageSize)
      ? Math.max(1, Math.round(candidate.pageSize))
      : 20,
    sort: isSort(candidate.sort) ? candidate.sort : null,
    authScope: candidate.authScope === 'auth' ? 'auth' : 'anon',
  };
}

function normalizeSearchEntry(value: unknown): SearchCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    key?: unknown;
    timestamp?: unknown;
    scope?: unknown;
    result?: unknown;
  };
  const scope = normalizeSearchScope(candidate.scope);
  const result = normalizeSearchResult(candidate.result);

  if (!scope || !result || typeof candidate.key !== 'string') {
    return null;
  }

  return {
    key: candidate.key,
    timestamp: typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? Math.round(candidate.timestamp)
      : 0,
    scope,
    result,
  };
}

function normalizeSnapshotEntry(value: unknown): SnapshotCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    key?: unknown;
    id?: unknown;
    authScope?: unknown;
    timestamp?: unknown;
    model?: unknown;
  };

  if (typeof candidate.id !== 'string') {
    return null;
  }

  const models = normalizeModels(candidate.model ? [candidate.model] : []);
  const model = models[0];
  if (!model) {
    return null;
  }

  const authScope = candidate.authScope === 'auth' || candidate.authScope === 'anon'
    ? candidate.authScope
    : inferSnapshotAuthScope(model);

  return {
    key: typeof candidate.key === 'string'
      ? candidate.key
      : buildSnapshotKey(candidate.id, authScope),
    id: candidate.id,
    authScope,
    timestamp: typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? Math.round(candidate.timestamp)
      : 0,
    model,
  };
}

export class ModelCatalogCacheStore {
  private storage = createStorage(STORAGE_ID);
  private searchEntries = new Map<string, SearchCacheEntry>();
  private snapshotEntries = new Map<string, SnapshotCacheEntry>();

  constructor() {
    this.loadPersistedEntries();
  }

  public getSearch(scope: CatalogCacheScope, maxAgeMs: number): CatalogCacheResult | null {
    const entry = this.searchEntries.get(this.buildSearchKey(scope));
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > maxAgeMs) {
      return null;
    }

    return this.cloneSearchResult(entry.result);
  }

  public putSearch(scope: CatalogCacheScope, result: CatalogCacheResult): void {
    const key = this.buildSearchKey(scope);
    const entry: SearchCacheEntry = {
      key,
      timestamp: Date.now(),
      scope: {
        ...scope,
        cursor: scope.cursor ?? null,
      },
      result: this.cloneSearchResult(result),
    };

    this.searchEntries.set(key, entry);
    this.pruneSearchEntries();
    this.persistSearchEntries();
  }

  public getModelSnapshot(
    modelId: string,
    authScope: CatalogCacheAuthScope,
    maxAgeMs: number,
  ): ModelMetadata | null {
    const entry = this.snapshotEntries.get(buildSnapshotKey(modelId, authScope));
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > maxAgeMs) {
      return null;
    }

    return normalizePersistedModelMetadata(entry.model);
  }

  public putModelSnapshots(models: ModelMetadata[], authScope: CatalogCacheAuthScope): void {
    const timestamp = Date.now();
    models.forEach((model) => {
      const key = buildSnapshotKey(model.id, authScope);
      this.snapshotEntries.set(key, {
        key,
        id: model.id,
        authScope,
        timestamp,
        model: normalizePersistedModelMetadata(model),
      });
    });

    this.pruneSnapshotEntries();
    this.persistSnapshotEntries();
  }

  public getPersistedSizeBytes(): number {
    return PERSISTED_CACHE_KEYS.reduce((sum, key) => {
      const value = this.storage.getString(key);
      if (!value) {
        return sum;
      }

      return sum + getTextByteLength(key) + getTextByteLength(value);
    }, 0);
  }

  public clearAll(): void {
    this.searchEntries.clear();
    this.snapshotEntries.clear();
    this.storage.remove(SEARCH_CACHE_KEY);
    this.storage.remove(SNAPSHOT_CACHE_KEY);
  }

  private loadPersistedEntries(): void {
    const searchPayload = this.parsePayload<SearchCacheEntry>(
      this.storage.getString(SEARCH_CACHE_KEY),
      normalizeSearchEntry,
    );
    searchPayload.forEach((entry) => {
      this.searchEntries.set(entry.key, entry);
    });

    const snapshotPayload = this.parsePayload<SnapshotCacheEntry>(
      this.storage.getString(SNAPSHOT_CACHE_KEY),
      normalizeSnapshotEntry,
    );
    snapshotPayload.forEach((entry) => {
      this.snapshotEntries.set(entry.key, entry);
    });
  }

  private parsePayload<T>(
    rawValue: string | undefined,
    normalizeEntry: (value: unknown) => T | null,
  ): T[] {
    if (!rawValue) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue) as PersistedPayload<unknown>;
      if (
        !parsed
        || typeof parsed !== 'object'
        || parsed.version !== PERSISTED_CACHE_VERSION
        || !Array.isArray(parsed.entries)
      ) {
        return [];
      }

      return parsed.entries
        .map((entry) => normalizeEntry(entry))
        .filter((entry): entry is T => entry !== null);
    } catch {
      return [];
    }
  }

  private persistSearchEntries(): void {
    const payload: PersistedPayload<SearchCacheEntry> = {
      version: PERSISTED_CACHE_VERSION,
      entries: this.getSortedSearchEntries(),
    };
    this.storage.set(SEARCH_CACHE_KEY, JSON.stringify(payload));
  }

  private persistSnapshotEntries(): void {
    const payload: PersistedPayload<SnapshotCacheEntry> = {
      version: PERSISTED_CACHE_VERSION,
      entries: this.getSortedSnapshotEntries(),
    };
    this.storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify(payload));
  }

  private getSortedSearchEntries(): SearchCacheEntry[] {
    return Array.from(this.searchEntries.values())
      .sort((left, right) => right.timestamp - left.timestamp);
  }

  private getSortedSnapshotEntries(): SnapshotCacheEntry[] {
    return Array.from(this.snapshotEntries.values())
      .sort((left, right) => right.timestamp - left.timestamp);
  }

  private pruneSearchEntries(): void {
    const staleEntries = this.getSortedSearchEntries().slice(MAX_PERSISTED_SEARCH_ENTRIES);
    staleEntries.forEach((entry) => {
      this.searchEntries.delete(entry.key);
    });
  }

  private pruneSnapshotEntries(): void {
    const staleEntries = this.getSortedSnapshotEntries().slice(MAX_PERSISTED_SNAPSHOT_ENTRIES);
    staleEntries.forEach((entry) => {
      this.snapshotEntries.delete(entry.key);
    });
  }

  private cloneSearchResult(result: CatalogCacheResult): CatalogCacheResult {
    return {
      models: result.models.map((model) => normalizePersistedModelMetadata(model)),
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    };
  }

  private buildSearchKey(scope: CatalogCacheScope): string {
    return [
      scope.query,
      scope.cursor ?? '__initial__',
      scope.pageSize,
      scope.sort ?? '__default__',
      scope.authScope,
    ].join('::');
  }
}
