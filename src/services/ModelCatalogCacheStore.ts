import { LifecycleStatus, ModelAccessState, type ModelMetadata, type ModelVariant } from '../types/models';
import type { ProjectorArtifact, ProjectorMatchStatus, VisionCapabilitySource } from '../types/multimodal';
import { CATALOG_SEARCH_VARIANT_LIMIT, limitModelVariants } from './ModelCatalogFileSelector';
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

type ParsedPayload<T> = {
  status: 'empty' | 'invalid' | 'ok';
  entries: T[];
  needsRewrite: boolean;
};

const STORAGE_ID = 'model-catalog-cache';
const SEARCH_CACHE_KEY = 'catalog-search-cache-v1';
const SNAPSHOT_CACHE_KEY = 'catalog-snapshot-cache-v1';
// Cache-tier persistence is intentionally limited to anonymous catalog data.
// Auth-scoped searches/snapshots can include gated/private access state, so
// they stay memory-only and anonymous snapshots are sanitized before storage.
const PERSISTED_CACHE_VERSION = 4;
const SUPPORTED_PERSISTED_CACHE_VERSIONS = new Set([3, PERSISTED_CACHE_VERSION]);
const MAX_PERSISTED_SEARCH_ENTRIES = 6;
const MAX_PERSISTED_SNAPSHOT_ENTRIES = 40;
const PERSISTED_CACHE_KEYS = [SEARCH_CACHE_KEY, SNAPSHOT_CACHE_KEY] as const;
const CATALOG_SAFE_VISION_SOURCES = new Set<VisionCapabilitySource>(['catalog_metadata', 'tree_probe']);

type CatalogVisionRuntimeSource = Pick<ModelMetadata | ModelVariant, 'visionSource'> & Partial<Pick<
  ModelMetadata | ModelVariant,
  'chatModalities' | 'projectorCandidates' | 'visionConfidence'
>>;

function isPublicAnonymousModel(model: ModelMetadata): boolean {
  return model.accessState === ModelAccessState.PUBLIC
    && model.isGated !== true
    && model.isPrivate !== true;
}

function sanitizeCatalogProjectorMatchStatus(projector: ProjectorArtifact): ProjectorMatchStatus {
  if (projector.matchStatus === 'failed' || projector.matchStatus === 'user_selected') {
    return 'missing';
  }

  if (projector.matchReason === 'multiple_projector_candidates') {
    return 'ambiguous';
  }

  if (projector.matchReason === 'single_projector_candidate') {
    return 'matched';
  }

  return projector.matchStatus;
}

function sanitizeCatalogProjectorMatchReason(projector: ProjectorArtifact): string | undefined {
  return projector.matchReason === 'single_projector_candidate'
    || projector.matchReason === 'deterministic_filename_affinity'
    || projector.matchReason === 'multiple_projector_candidates'
    ? projector.matchReason
    : undefined;
}

function modelHasCatalogSafeVisionSource(model: Pick<ModelMetadata, 'visionSource'>): boolean {
  return Boolean(model.visionSource && CATALOG_SAFE_VISION_SOURCES.has(model.visionSource));
}

function hasProjectorRuntimeFields(projectors: ModelMetadata['projectorCandidates']): boolean {
  return projectors?.some((projector) => (
    typeof projector.localPath === 'string'
    || typeof projector.resumeData === 'string'
    || projector.downloadProgress !== undefined
    || projector.lifecycleStatus !== 'available'
    || projector.matchStatus === 'failed'
    || projector.matchStatus === 'user_selected'
    || projector.matchReason === 'user_selected_projector'
    || projector.matchReason === 'unselected_projector_candidate'
  )) ?? false;
}

function hasUnsafeAnonymousVisionProvenance(model: CatalogVisionRuntimeSource): boolean {
  const hasSafeVisionSource = modelHasCatalogSafeVisionSource(model);
  const hasVisionModality = Array.isArray(model.chatModalities) && model.chatModalities.includes('vision');
  const hasUnsafeProjectorCandidates = Boolean(model.projectorCandidates?.length && !hasSafeVisionSource);
  const hasCatalogVisionEvidence = hasSafeVisionSource;

  return Boolean(
    (model.visionSource && !hasSafeVisionSource)
    || (model.visionConfidence && !hasSafeVisionSource)
    || hasUnsafeProjectorCandidates
    || (hasVisionModality && !hasCatalogVisionEvidence),
  );
}

function hasAnonymousVariantRuntimeFields(variant: ModelVariant): boolean {
  return variant.isLocal === true
    || typeof variant.selectedProjectorId === 'string'
    || hasUnsafeAnonymousVisionProvenance(variant)
    || hasProjectorRuntimeFields(variant.projectorCandidates);
}

export function sanitizeCatalogProjectorRuntimeState(projectors: ModelMetadata['projectorCandidates']): ModelMetadata['projectorCandidates'] {
  if (!projectors?.length) {
    return projectors;
  }

  return projectors.map((projector) => ({
    ...projector,
    localPath: undefined,
    resumeData: undefined,
    downloadProgress: undefined,
    lifecycleStatus: 'available' as const,
    matchStatus: sanitizeCatalogProjectorMatchStatus(projector),
    matchReason: sanitizeCatalogProjectorMatchReason(projector),
  }));
}

export function sanitizeCatalogModelRuntimeState(model: ModelMetadata): ModelMetadata {
  const hasCatalogSafeVisionSource = modelHasCatalogSafeVisionSource(model);
  const projectorCandidates = hasCatalogSafeVisionSource
    ? sanitizeCatalogProjectorRuntimeState(model.projectorCandidates)
    : undefined;
  const hasCatalogVisionEvidence = hasCatalogSafeVisionSource;
  const chatModalities = Array.isArray(model.chatModalities) && !hasCatalogVisionEvidence
    ? model.chatModalities.filter((modality) => modality !== 'vision')
    : model.chatModalities;

  return normalizePersistedModelMetadata({
    ...model,
    localPath: undefined,
    downloadedAt: undefined,
    downloadIntegrity: undefined,
    resumeData: undefined,
    downloadErrorAt: undefined,
    downloadErrorCode: undefined,
    downloadErrorMessage: undefined,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    metadataTrust: model.metadataTrust === 'verified_local' ? undefined : model.metadataTrust,
    ...(model.metadataTrust === 'verified_local' ? {
      sha256: undefined,
      capabilitySnapshot: undefined,
    } : {}),
    chatModalities,
    visionSource: hasCatalogSafeVisionSource ? model.visionSource : undefined,
    visionConfidence: hasCatalogSafeVisionSource ? model.visionConfidence : undefined,
    selectedProjectorId: undefined,
    multimodalReadiness: undefined,
    projectorCandidates,
  });
}

function sanitizeCatalogVariantRuntimeState(variant: ModelVariant): ModelVariant {
  const hasCatalogSafeVisionSource = modelHasCatalogSafeVisionSource(variant);
  const projectorCandidates = hasCatalogSafeVisionSource
    ? sanitizeCatalogProjectorRuntimeState(variant.projectorCandidates)
    : undefined;
  const hasCatalogVisionEvidence = hasCatalogSafeVisionSource;
  const chatModalities = Array.isArray(variant.chatModalities) && !hasCatalogVisionEvidence
    ? variant.chatModalities.filter((modality) => modality !== 'vision')
    : variant.chatModalities;

  return {
    ...variant,
    chatModalities,
    visionSource: hasCatalogSafeVisionSource ? variant.visionSource : undefined,
    visionConfidence: hasCatalogSafeVisionSource ? variant.visionConfidence : undefined,
    selectedProjectorId: undefined,
    projectorCandidates,
  };
}

export function sanitizeAnonymousCatalogModel(model: ModelMetadata): ModelMetadata | null {
  if (model.isPrivate) {
    return null;
  }

  if (isPublicAnonymousModel(model)) {
    return limitAnonymousCatalogModelVariants(toAnonymousPublicCatalogModel(model));
  }

  return normalizePersistedModelMetadata({
    id: model.id,
    name: model.name,
    author: model.author,
    accessState: ModelAccessState.AUTH_REQUIRED,
    isGated: model.isGated === true,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  });
}

function toAnonymousPublicCatalogModel(model: ModelMetadata): ModelMetadata {
  return sanitizeCatalogModelRuntimeState(model);
}

function limitAnonymousCatalogModelVariants(model: ModelMetadata): ModelMetadata {
  const variants = limitModelVariants(model.variants, {
    limit: CATALOG_SEARCH_VARIANT_LIMIT,
    includeFileNames: [model.resolvedFileName, model.activeVariantId],
    includeVariantIds: [model.activeVariantId],
  });
  const hasLocalVariantMarker = variants?.some((variant) => variant.isLocal === true) ?? false;
  const hasVariantRuntimeFields = variants?.some(hasAnonymousVariantRuntimeFields) ?? false;
  const sanitizedVariants = variants?.map(({ isLocal: _isLocal, ...variant }) => (
    sanitizeCatalogVariantRuntimeState(variant)
  ));

  if (variants === model.variants && !hasLocalVariantMarker && !hasVariantRuntimeFields) {
    return model;
  }

  return normalizePersistedModelMetadata({
    ...model,
    variants: sanitizedVariants,
  });
}

function sanitizeAnonymousPersistedModels(models: ModelMetadata[]): ModelMetadata[] {
  return models.flatMap((model) => {
    const sanitized = sanitizeAnonymousCatalogModel(model);
    return sanitized ? [sanitized] : [];
  });
}

function hasAnonymousRuntimeFields(model: ModelMetadata): boolean {
  return typeof model.localPath === 'string'
    || typeof model.downloadedAt === 'number'
    || model.downloadIntegrity !== undefined
    || typeof model.resumeData === 'string'
    || typeof model.downloadErrorAt === 'number'
    || typeof model.downloadErrorCode === 'string'
    || typeof model.downloadErrorMessage === 'string'
    || model.lifecycleStatus !== LifecycleStatus.AVAILABLE
    || model.downloadProgress !== 0
    || model.metadataTrust === 'verified_local'
    || (model.variants?.some(hasAnonymousVariantRuntimeFields) ?? false)
    || hasUnsafeAnonymousVisionProvenance(model)
    || typeof model.selectedProjectorId === 'string'
    || model.multimodalReadiness !== undefined
    || hasProjectorRuntimeFields(model.projectorCandidates);
}

function needsAnonymousPersistedModelSanitization(model: ModelMetadata): boolean {
  return !isPublicAnonymousModel(model) || hasAnonymousRuntimeFields(model);
}

function needsAnonymousPersistedModelsSanitization(models: ModelMetadata[]): boolean {
  return models.some((model) => needsAnonymousPersistedModelSanitization(model));
}

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
  private storage = createStorage(STORAGE_ID, { tier: 'cache' });
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
    const clonedResult = this.cloneSearchResult(result);
    const entry: SearchCacheEntry = {
      key,
      timestamp: Date.now(),
      scope: {
        ...scope,
        cursor: scope.cursor ?? null,
      },
      result: scope.authScope === 'anon'
        ? {
          ...clonedResult,
          models: sanitizeAnonymousPersistedModels(clonedResult.models),
        }
        : clonedResult,
    };

    this.searchEntries.set(key, entry);
    this.pruneSearchEntries();

    if (scope.authScope === 'anon') {
      this.persistSearchEntries();
    }
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
    const modelsToStore = authScope === 'anon'
      ? sanitizeAnonymousPersistedModels(models)
      : models.map((model) => normalizePersistedModelMetadata(model));

    modelsToStore.forEach((model) => {
      const key = buildSnapshotKey(model.id, authScope);
      this.snapshotEntries.set(key, {
        key,
        id: model.id,
        authScope,
        timestamp,
        model,
      });
    });

    this.pruneSnapshotEntries();

    if (authScope === 'anon') {
      this.persistSnapshotEntries();
    }
  }

  public deleteModelSnapshots(modelIds: string[], authScope: CatalogCacheAuthScope): void {
    const uniqueModelIds = new Set(modelIds.filter((modelId) => modelId.trim().length > 0));
    if (uniqueModelIds.size === 0) {
      return;
    }

    let didDelete = false;
    uniqueModelIds.forEach((modelId) => {
      didDelete = this.snapshotEntries.delete(buildSnapshotKey(modelId, authScope)) || didDelete;
    });

    if (didDelete && authScope === 'anon') {
      this.persistSnapshotEntries();
    }
  }

  public deleteSearchModels(modelIds: string[], authScope?: CatalogCacheAuthScope): void {
    const uniqueModelIds = new Set(modelIds.filter((modelId) => modelId.trim().length > 0));
    if (uniqueModelIds.size === 0) {
      return;
    }

    let didPersistedAnonChange = false;
    for (const [key, entry] of this.searchEntries.entries()) {
      if (authScope && entry.scope.authScope !== authScope) {
        continue;
      }

      const nextModels = entry.result.models.filter((model) => !uniqueModelIds.has(model.id));
      if (nextModels.length === entry.result.models.length) {
        continue;
      }

      this.searchEntries.set(key, {
        ...entry,
        result: {
          ...entry.result,
          models: nextModels,
        },
      });
      didPersistedAnonChange = didPersistedAnonChange || entry.scope.authScope === 'anon';
    }

    if (didPersistedAnonChange) {
      this.persistSearchEntries();
    }
  }

  public reconcileAnonymousSearchModels(models: ModelMetadata[]): void {
    const replacements = new Map<string, ModelMetadata | null>();
    models.forEach((model) => {
      replacements.set(model.id, sanitizeAnonymousCatalogModel(model));
    });

    if (replacements.size === 0) {
      return;
    }

    let didChange = false;
    for (const [key, entry] of this.searchEntries.entries()) {
      if (entry.scope.authScope !== 'anon') {
        continue;
      }

      let didChangeEntry = false;
      const nextModels = entry.result.models.flatMap((model) => {
        if (!replacements.has(model.id)) {
          return [model];
        }

        didChangeEntry = true;
        const replacement = replacements.get(model.id) ?? null;
        return replacement ? [replacement] : [];
      });

      if (didChangeEntry) {
        didChange = true;
        this.searchEntries.set(key, {
          ...entry,
          result: {
            ...entry.result,
            models: nextModels,
          },
        });
      }
    }

    if (didChange) {
      this.persistSearchEntries();
    }
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

  public clearSnapshots(): void {
    this.snapshotEntries.clear();
    this.storage.remove(SNAPSHOT_CACHE_KEY);
  }

  public clearSnapshotsForScope(authScope: CatalogCacheAuthScope): void {
    let didDelete = false;
    for (const [key, entry] of this.snapshotEntries.entries()) {
      if (entry.authScope !== authScope) {
        continue;
      }

      this.snapshotEntries.delete(key);
      didDelete = true;
    }

    if (didDelete && authScope === 'anon') {
      this.persistSnapshotEntries();
    }
  }

  private loadPersistedEntries(): void {
    let shouldRewriteSearchPayload = false;
    const searchPayloadResult = this.parsePayload<SearchCacheEntry>(
      this.storage.getString(SEARCH_CACHE_KEY),
      normalizeSearchEntry,
    );
    shouldRewriteSearchPayload = searchPayloadResult.needsRewrite;

    if (searchPayloadResult.status === 'invalid') {
      this.storage.remove(SEARCH_CACHE_KEY);
    }

    searchPayloadResult.entries.forEach((entry) => {
      if (entry.scope.authScope !== 'anon') {
        shouldRewriteSearchPayload = true;
        return;
      }

      if (needsAnonymousPersistedModelsSanitization(entry.result.models)) {
        shouldRewriteSearchPayload = true;
      }

      entry.result.models = sanitizeAnonymousPersistedModels(entry.result.models);
      this.searchEntries.set(entry.key, entry);
    });

    let shouldRewriteSnapshotPayload = false;
    const snapshotPayloadResult = this.parsePayload<SnapshotCacheEntry>(
      this.storage.getString(SNAPSHOT_CACHE_KEY),
      normalizeSnapshotEntry,
    );
    shouldRewriteSnapshotPayload = snapshotPayloadResult.needsRewrite;

    if (snapshotPayloadResult.status === 'invalid') {
      this.storage.remove(SNAPSHOT_CACHE_KEY);
    }

    snapshotPayloadResult.entries.forEach((entry) => {
      if (entry.authScope !== 'anon') {
        shouldRewriteSnapshotPayload = true;
        return;
      }

      if (needsAnonymousPersistedModelSanitization(entry.model)) {
        shouldRewriteSnapshotPayload = true;
      }

      const sanitizedModel = sanitizeAnonymousCatalogModel(entry.model);
      if (sanitizedModel) {
        entry.model = sanitizedModel;
        this.snapshotEntries.set(entry.key, entry);
      } else {
        shouldRewriteSnapshotPayload = true;
      }
    });

    const searchEntriesBeforePrune = this.searchEntries.size;
    this.pruneSearchEntries();
    if (searchEntriesBeforePrune !== this.searchEntries.size) {
      shouldRewriteSearchPayload = true;
    }

    const snapshotEntriesBeforePrune = this.snapshotEntries.size;
    this.pruneSnapshotEntries();
    if (snapshotEntriesBeforePrune !== this.snapshotEntries.size) {
      shouldRewriteSnapshotPayload = true;
    }

    if (shouldRewriteSearchPayload) {
      this.persistSearchEntries();
    }

    if (shouldRewriteSnapshotPayload) {
      this.persistSnapshotEntries();
    }
  }

  private parsePayload<T>(
    rawValue: string | undefined,
    normalizeEntry: (value: unknown) => T | null,
  ): ParsedPayload<T> {
    if (!rawValue) {
      return { status: 'empty', entries: [], needsRewrite: false };
    }

    try {
      const parsed = JSON.parse(rawValue) as PersistedPayload<unknown>;
      if (
        !parsed
        || typeof parsed !== 'object'
        || typeof parsed.version !== 'number'
        || !SUPPORTED_PERSISTED_CACHE_VERSIONS.has(parsed.version)
        || !Array.isArray(parsed.entries)
      ) {
        return { status: 'invalid', entries: [], needsRewrite: false };
      }

      const entries = parsed.entries
        .map((entry) => normalizeEntry(entry))
        .filter((entry): entry is T => entry !== null);

      return {
        status: 'ok',
        entries,
        needsRewrite: parsed.version !== PERSISTED_CACHE_VERSION,
      };
    } catch {
      return { status: 'invalid', entries: [], needsRewrite: false };
    }
  }

  private persistSearchEntries(): void {
    const payload: PersistedPayload<SearchCacheEntry> = {
      version: PERSISTED_CACHE_VERSION,
      entries: this.getSortedSearchEntries()
        .filter((entry) => entry.scope.authScope === 'anon')
        .map((entry) => ({
          ...entry,
          result: {
            ...entry.result,
            models: sanitizeAnonymousPersistedModels(entry.result.models),
          },
        })),
    };
    this.storage.set(SEARCH_CACHE_KEY, JSON.stringify(payload));
  }

  private persistSnapshotEntries(): void {
    const entries = this.getSortedSnapshotEntries()
      .filter((entry) => entry.authScope === 'anon')
      .flatMap((entry) => {
        const sanitizedModel = sanitizeAnonymousCatalogModel(entry.model);
        return sanitizedModel
          ? [{
            ...entry,
            model: sanitizedModel,
          }]
          : [];
      });
    const payload: PersistedPayload<SnapshotCacheEntry> = {
      version: PERSISTED_CACHE_VERSION,
      entries,
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
