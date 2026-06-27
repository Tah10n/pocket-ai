import DeviceInfo from 'react-native-device-info';
import { LifecycleStatus, ModelAccessState, type ModelMetadata, type ModelVariant } from '../types/models';
import type { MultimodalReadinessState, ProjectorArtifact } from '../types/multimodal';
import { hardwareListenerService } from './HardwareListenerService';
import { registry } from './LocalStorageRegistry';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { performanceMonitor } from './PerformanceMonitor';
import type { SystemMemorySnapshot } from './SystemMetricsService';
import { uniqueByKey } from '../utils/uniqueBy';
import {
  ModelCatalogCacheStore,
  sanitizeAnonymousCatalogModel,
  sanitizeCatalogModelRuntimeState,
  type CatalogCacheAuthScope,
  type CatalogCacheScope,
} from './ModelCatalogCacheStore';
import { extractReadmeData } from './ModelReadmeParser';
import {
  buildHeaders,
  fetchWithTimeout,
  ModelCatalogError,
  parseNextCursor,
  resolveRequestAuthToken,
  resolveRetryAfterMs,
} from './ModelCatalogHttpClient';
import {
  buildCatalogModelVariants,
  CATALOG_SEARCH_VARIANT_LIMIT,
  filterCatalogSearchModels,
  getFileName,
  getFileSha,
  getFileSize,
  isEligibleGgufEntry,
  isPreferredQuantFileName,
  isProjectorFileName,
  isUnsupportedMtpFileName,
  limitModelVariants,
  selectTreeEntryForModel,
} from './ModelCatalogFileSelector';
import {
  attachMemoryFitToVariants,
  buildProjectorCandidatesFromEntries,
  buildModelMetadataFromPayload,
  createFallbackModel,
  resolveMemoryFitSummary,
  resolveMergedMaxContextTokens,
  resolveStringArrayMetadata,
  resolveStringMetadata,
  resolveSummaryMaxContextTokens,
  transformHFResponse,
} from './ModelCatalogTransformer';
import {
  buildHuggingFaceModelApiUrl,
  buildHuggingFaceRawUrl,
  buildHuggingFaceResolveUrl,
  buildHuggingFaceTreeUrl,
  getHuggingFaceModelUrl,
  HF_BASE_URL,
} from '../utils/huggingFaceUrls';
import { applyModelVariantSelectionIfAvailable } from '../utils/modelVariants';
import { normalizeSha256Digest } from '../utils/sha256';
import { getProjectorMemoryFitSizeBytes } from '../utils/modelSize';
import { mergeProjectorRuntimeState as mergeCompatibleProjectorRuntimeState } from '../utils/projectorRuntimeState';
import {
  getCompatibleLocalDownloadStatePatch,
  resolveVerifiedLocalShaCompatibility,
} from './ModelIntegrityMetadata';
import {
  REQUEST_AUTH_POLICY,
  type CatalogBatchResult,
  type CatalogCacheEntry,
  type CatalogRequestContext,
  type HuggingFaceModelSummary,
  type HuggingFaceModelsPage,
  type HuggingFaceTreeEntry,
  type HuggingFaceTreeResponse,
  type HuggingFaceTreeStopReason,
  type ReadmeModelData,
  type RequestAuthPolicy,
  type ResolvedFileProbeCacheEntry,
  type ResolveTreeAccessStateOptions,
} from '../types/huggingFace';

export type CatalogServerSort = 'downloads' | 'likes' | 'lastModified';
export type ModelCatalogCacheInvalidationSource = 'replay' | 'manual' | 'token' | 'unknown';
export { ModelCatalogError, getModelCatalogErrorMessage, type ModelCatalogErrorCode } from './ModelCatalogHttpClient';

type CacheInvalidationListener = (revision: number, source: ModelCatalogCacheInvalidationSource) => void;

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const PERSISTENT_CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const ACCESS_PROBE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
// Keep one buffered page for fast first load-more without hydrating three pages on entry.
const CATALOG_PREFETCH_PAGES = 2;
const CATALOG_PREFETCH_MAX_LIMIT = 60;
const HF_TREE_PAGINATION_MAX_PAGES = 20;
const HF_TREE_SEARCH_PAGINATION_MAX_PAGES = 4;
const HF_TREE_DETAIL_PAGINATION_MAX_PAGES = HF_TREE_SEARCH_PAGINATION_MAX_PAGES;
const HF_TREE_PROJECTOR_PAGINATION_MAX_PAGES = HF_TREE_PAGINATION_MAX_PAGES;
const HF_TREE_PREFERRED_LOOKAHEAD_PAGES = 2;
const SEARCH_CACHE_MAX_ENTRIES = 120;
const BUFFERED_SEARCH_CACHE_MAX_AGE = 20 * 60 * 1000; // 20 minutes
const MODEL_SNAPSHOT_CACHE_MAX_ENTRIES = 2000;
const ACCESS_PROBE_CACHE_MAX_ENTRIES = 500;

export const HUGGING_FACE_TOKEN_SETTINGS_URL = `${HF_BASE_URL}/settings/tokens`;
export { getHuggingFaceModelUrl };

class StaleCatalogAuthError extends Error {
  constructor() {
    super('Catalog auth context changed while the request was in flight');
    this.name = 'StaleCatalogAuthError';
  }
}

export interface ModelCatalogSearchResult {
  models: ModelMetadata[];
  hasMore: boolean;
  nextCursor: string | null;
  warning?: ModelCatalogError;
}

type RefreshModelMetadataOptions = {
  includeDetails?: boolean;
};

type ResolveMissingModelMetadataOptions = {
  treeProbeMode?: 'bounded' | 'full';
};

type FetchModelTreeOptions = {
  expectedFileName?: string;
  allowTargetEarlyStop?: boolean;
  maxPages?: number;
};

type CatalogMemoryFitContext = {
  totalMemoryBytes: number | null;
  systemMemorySnapshot: SystemMemorySnapshot | null;
};

type ProjectorMetadataMerge = Pick<ModelMetadata, 'projectorCandidates' | 'selectedProjectorId' | 'multimodalReadiness'>;

export class ModelCatalogService {
  private searchCache: Map<string, CatalogCacheEntry<Omit<ModelCatalogSearchResult, 'warning'>>> = new Map();
  private searchRequestCache: Map<string, Promise<ModelCatalogSearchResult>> = new Map();
  private modelSnapshotCache: Map<string, ModelMetadata> = new Map();
  private persistentCache = new ModelCatalogCacheStore();
  private authCacheVersion = 0;
  private bufferedCursorSequence = 0;
  private rateLimitUntilByAuthScope: Record<CatalogCacheAuthScope, number> = { anon: 0, auth: 0 };
  private rateLimitBackoffMsByAuthScope: Record<CatalogCacheAuthScope, number> = { anon: 0, auth: 0 };
  private cacheInvalidationRevision = 0;
  private cacheInvalidationListeners: Set<CacheInvalidationListener> = new Set();
  private treeRequestCache: Map<string, Promise<HuggingFaceTreeResponse>> = new Map();
  private readmeRequestCache: Map<string, Promise<ReadmeModelData | undefined>> = new Map();
  private resolvedFileProbeCache: Map<string, Promise<ModelAccessState | null>> = new Map();
  private resolvedFileProbeStateCache: Map<string, ResolvedFileProbeCacheEntry> = new Map();
  private lastMemoryFitContext: CatalogMemoryFitContext | null = null;
  private readonly unsubscribeFromTokenService: () => void;

  constructor() {
    this.unsubscribeFromTokenService = huggingFaceTokenService.subscribe((_state, source) => {
      if (source === 'replay') {
        return;
      }

      this.authCacheVersion += 1;
      if (source === 'mutation') {
        this.clearCache('token');
      } else {
        this.clearVolatileCache('token', { emit: false });
        this.persistentCache.clearSnapshotsForScope('auth');
        this.emitCacheInvalidation('token');
      }
    });
  }

  public dispose(): void {
    this.unsubscribeFromTokenService();
  }

  public getPersistentCacheBytes(): number {
    return this.persistentCache.getPersistedSizeBytes();
  }

  public subscribeCacheInvalidations(listener: CacheInvalidationListener): () => void {
    this.cacheInvalidationListeners.add(listener);
    this.notifyCacheInvalidation(listener, this.cacheInvalidationRevision, 'replay');
    return () => {
      this.cacheInvalidationListeners.delete(listener);
    };
  }

  public clearCache(source: Exclude<ModelCatalogCacheInvalidationSource, 'replay'> = 'unknown'): void {
    this.clearVolatileCache(source, { emit: false });

    if (source === 'token') {
      this.persistentCache.clearSnapshots();
    } else {
      this.persistentCache.clearAll();
    }

    this.emitCacheInvalidation(source);
  }

  private clearVolatileCache(
    source: Exclude<ModelCatalogCacheInvalidationSource, 'replay'> = 'unknown',
    options: { emit?: boolean } = {},
  ): void {
    this.bufferedCursorSequence = 0;
    this.searchCache.clear();
    this.searchRequestCache.clear();
    this.modelSnapshotCache.clear();
    this.rateLimitUntilByAuthScope = { anon: 0, auth: 0 };
    this.rateLimitBackoffMsByAuthScope = { anon: 0, auth: 0 };
    this.treeRequestCache.clear();
    this.readmeRequestCache.clear();
    this.resolvedFileProbeCache.clear();
    this.resolvedFileProbeStateCache.clear();
    this.lastMemoryFitContext = null;

    if (options.emit !== false) {
      this.emitCacheInvalidation(source);
    }
  }

  private emitCacheInvalidation(source: Exclude<ModelCatalogCacheInvalidationSource, 'replay'>) {
    this.cacheInvalidationRevision += 1;
    const revision = this.cacheInvalidationRevision;
    this.cacheInvalidationListeners.forEach((listener) => this.notifyCacheInvalidation(listener, revision, source));
  }

  private notifyCacheInvalidation(
    listener: CacheInvalidationListener,
    revision: number,
    source: ModelCatalogCacheInvalidationSource,
  ): void {
    try {
      listener(revision, source);
    } catch (error) {
      console.warn('[ModelCatalogService] Cache invalidation listener failed', error);
    }
  }

  private pruneSearchCache(): void {
    const now = Date.now();

    for (const [key, entry] of this.searchCache.entries()) {
      if (!entry.isBufferedCursor && now - entry.timestamp > CACHE_TTL) {
        this.searchCache.delete(key);
      } else if (entry.isBufferedCursor && now - entry.timestamp > BUFFERED_SEARCH_CACHE_MAX_AGE) {
        this.searchCache.delete(key);
      }
    }

    if (this.searchCache.size <= SEARCH_CACHE_MAX_ENTRIES) {
      return;
    }

    for (const [key, entry] of this.searchCache.entries()) {
      if (this.searchCache.size <= SEARCH_CACHE_MAX_ENTRIES) {
        break;
      }

      if (!entry.isBufferedCursor) {
        this.searchCache.delete(key);
      }
    }

    for (const key of this.searchCache.keys()) {
      if (this.searchCache.size <= SEARCH_CACHE_MAX_ENTRIES) {
        break;
      }

      this.searchCache.delete(key);
    }
  }

  private pruneModelSnapshotCache(): void {
    while (this.modelSnapshotCache.size > MODEL_SNAPSHOT_CACHE_MAX_ENTRIES) {
      const oldestKey = this.modelSnapshotCache.keys().next().value;
      if (!oldestKey) {
        break;
      }

      this.modelSnapshotCache.delete(oldestKey);
    }
  }

  private async createRequestContext(): Promise<CatalogRequestContext> {
    // Guard against a theoretical infinite loop if auth token mutations happen continuously.
    // In practice, this settles quickly (token changes are rare), but keep a best-effort escape hatch.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const authVersion = this.authCacheVersion;
      const authToken = await huggingFaceTokenService.getToken();
      if (authVersion !== this.authCacheVersion) {
        continue;
      }

      return {
        authToken,
        hasAuthToken: Boolean(authToken),
        authVersion,
      };
    }

    const authToken = await huggingFaceTokenService.getToken();

    return {
      authToken,
      hasAuthToken: Boolean(authToken),
      authVersion: this.authCacheVersion,
    };
  }

  private assertRequestContextIsCurrent(requestContext: CatalogRequestContext): void {
    if (this.authCacheVersion !== requestContext.authVersion) {
      throw new StaleCatalogAuthError();
    }
  }

  /**
   * Fetch GGUF models from Hugging Face with caching and offline support.
   */
  public async searchModels(
    query: string = 'gguf',
    options?: {
      cursor?: string | null;
      pageSize?: number;
      sort?: CatalogServerSort | null;
      forceRefresh?: boolean;
      gated?: boolean;
    },
  ): Promise<ModelCatalogSearchResult> {
    return this.searchModelsInternal(query, options, 0);
  }

  private async searchModelsInternal(
    query: string,
    options: {
      cursor?: string | null;
      pageSize?: number;
      sort?: CatalogServerSort | null;
      forceRefresh?: boolean;
      gated?: boolean;
    } | undefined,
    retryCount: number,
  ): Promise<ModelCatalogSearchResult> {
    const requestContext = await this.createRequestContext();
    const memoryFitContextPromise = this.getCurrentMemoryFitContext();
    const rawCursor = options?.cursor ?? null;
    const cursor = this.normalizeCatalogSearchCursor(rawCursor);
    if (rawCursor !== null && cursor === null) {
      throw new ModelCatalogError('network', 'Invalid Hugging Face catalog cursor');
    }
    const pageSize = options?.pageSize ?? 20;
    const sort = options?.sort ?? null;
    const forceRefresh = options?.forceRefresh === true && cursor === null;
    const gated = options?.gated;
    const normalizedQuery = this.normalizeQuery(query);
    const catalogSearchAuthPolicy = requestContext.hasAuthToken
      ? REQUEST_AUTH_POLICY.OPTIONAL_AUTH
      : REQUEST_AUTH_POLICY.ANONYMOUS;
    const catalogSearchHasAuthScope = this.resolveRequestAuthScope(
      catalogSearchAuthPolicy,
      requestContext.authToken,
    ) === 'auth';
    const cacheKey = this.buildMemorySearchCacheKey(
      normalizedQuery,
      cursor,
      pageSize,
      sort,
      catalogSearchHasAuthScope,
      gated,
    );
    const cached = this.searchCache.get(cacheKey);
    const isBufferedCursor = this.isBufferedCursor(cursor);
    const cacheNow = Date.now();
    const cachedTimestamp = cached?.timestamp ?? 0;
    const isCacheFresh = Boolean(cached) && cacheNow - cachedTimestamp < CACHE_TTL;
    const isBufferedCursorFresh =
      Boolean(cached) && isBufferedCursor && cacheNow - cachedTimestamp < BUFFERED_SEARCH_CACHE_MAX_AGE;

    if (cached && isBufferedCursor && !isBufferedCursorFresh) {
      this.searchCache.delete(cacheKey);
    }

    if (cached && !isBufferedCursor && !isCacheFresh) {
      this.searchCache.delete(cacheKey);
    }

    if (!forceRefresh && cached && (isCacheFresh || isBufferedCursorFresh)) {
      const filteredCachedModels = filterCatalogSearchModels(
        this.sanitizeCachedCatalogModelsResolvedFiles(cached.result.models),
      ).map((model) => this.toSearchResultModel(model));
      const memoryFitContext = await memoryFitContextPromise;
      return {
        ...this.sanitizeSearchResultCursor(cached.result),
        models: this.mergeWithRegistry(
          filteredCachedModels,
          this.getAuthScope(catalogSearchHasAuthScope),
          memoryFitContext,
        ),
      };
    }

    if (isBufferedCursor) {
      this.searchCache.delete(cacheKey);
      throw new ModelCatalogError('network', 'Buffered catalog page expired');
    }

    const isConnected = hardwareListenerService.getCurrentStatus().isConnected;

    if (!isConnected) {
      if (cursor !== null) {
        throw new ModelCatalogError('network', 'Cannot load more models while offline');
      }

      const memoryFitContext = await memoryFitContextPromise;
      const cachedSearch = (
        this.getCachedSearchResultForScope(query, options, catalogSearchHasAuthScope, memoryFitContext)
        ?? (catalogSearchHasAuthScope
          ? this.getCachedSearchResultForScope(query, options, false, memoryFitContext)
          : null)
      );
      if (cachedSearch) {
        if (process.env.NODE_ENV !== 'test') {
          console.log('[ModelCatalogService] Offline mode: using persisted catalog cache');
        }
        return this.toNonPaginatedFallback(cachedSearch);
      }

      if (process.env.NODE_ENV !== 'test') {
        console.log('[ModelCatalogService] Offline mode: fetching from local registry');
      }
      return this.getLocalSearchResults(query, memoryFitContext);
    }

    const authScope = this.getAuthScope(catalogSearchHasAuthScope);
    const now = Date.now();
    const rateLimitUntil = this.rateLimitUntilByAuthScope[authScope] ?? 0;

    if (rateLimitUntil > now) {
      const retryAfterMs = rateLimitUntil - now;
      const rateLimitError = new ModelCatalogError(
        'rate_limited',
        'Hugging Face rate limit reached.',
        { retryAfterMs },
      );

      if (cursor === null) {
        const memoryFitContext = await memoryFitContextPromise;
        const fallback = (
          this.getCachedSearchResultForScope(query, options, catalogSearchHasAuthScope, memoryFitContext)
          ?? (catalogSearchHasAuthScope
            ? this.getCachedSearchResultForScope(query, options, false, memoryFitContext)
            : null)
        );
        return {
          ...(fallback
            ? this.toNonPaginatedFallback(fallback)
            : this.getLocalSearchResults(query, memoryFitContext)),
          warning: rateLimitError,
        };
      }

      throw rateLimitError;
    }

    const inFlight = this.searchRequestCache.get(cacheKey);
    const requestPromise = inFlight ?? (async (): Promise<ModelCatalogSearchResult> => {
      try {
        const memoryFitContext = await memoryFitContextPromise;
        const fetched = await this.fetchCatalogBatch(
          normalizedQuery,
          pageSize,
          memoryFitContext,
          requestContext,
          cursor,
          sort,
          gated,
          catalogSearchAuthPolicy,
        );
        this.assertRequestContextIsCurrent(requestContext);
        const filteredModels = filterCatalogSearchModels(fetched.models);
        const searchResultModels = filteredModels.map((model) => this.toSearchResultModel(model));
        const result = {
          models: searchResultModels,
          hasMore: fetched.nextCursor !== null,
          nextCursor: fetched.nextCursor,
        };

        this.searchCache.set(cacheKey, {
          result,
          timestamp: Date.now(),
          isBufferedCursor,
        });
        this.pruneSearchCache();
        if (cursor === null && typeof gated !== 'boolean' && !catalogSearchHasAuthScope) {
          const persistableResult = this.toPersistableSearchResult(result);
          const persistableModels = persistableResult.models.filter((model) => {
            if (model.isPrivate) {
              return false;
            }

            if (!catalogSearchHasAuthScope) {
              return true;
            }

            return model.accessState === ModelAccessState.PUBLIC && !model.isGated;
          });

          this.persistentCache.putSearch(
            this.buildPersistentSearchScope(normalizedQuery, pageSize, sort, false),
            {
              ...persistableResult,
              models: persistableModels.map((model) => (
                model.accessState === ModelAccessState.AUTHORIZED || model.accessState === ModelAccessState.ACCESS_DENIED
                  ? {
                    ...model,
                    accessState: model.isGated || model.isPrivate
                      ? ModelAccessState.AUTH_REQUIRED
                      : ModelAccessState.PUBLIC,
                  }
                  : model
              )),
            },
          );
        }

        const mergedModels = this.mergeWithRegistry(
          result.models,
          this.getAuthScope(catalogSearchHasAuthScope),
          memoryFitContext,
        );

        if (catalogSearchHasAuthScope && mergedModels.length > 0) {
          this.reconcileAnonymousModelVisibility(mergedModels);
        }

        return {
          ...result,
          models: mergedModels,
        };
      } catch (e) {
        if (e instanceof StaleCatalogAuthError) {
          throw e;
        }

        if (e instanceof ModelCatalogError && e.code === 'rate_limited') {
          if (process.env.NODE_ENV !== 'test') {
            console.warn('[ModelCatalogService] Search rate limited', e);
          }
        } else {
          console.error('[ModelCatalogService] Search failed', e);
        }

        if (e instanceof ModelCatalogError) {
          if (cursor === null) {
            const memoryFitContext = await memoryFitContextPromise;
            const fallback = (
              this.getCachedSearchResultForScope(query, options, catalogSearchHasAuthScope, memoryFitContext)
              ?? (catalogSearchHasAuthScope
                ? this.getCachedSearchResultForScope(query, options, false, memoryFitContext)
                : null)
            );
            return {
              ...(fallback
                ? this.toNonPaginatedFallback(fallback)
                : this.getLocalSearchResults(query, memoryFitContext)),
              warning: e,
            };
          }

          throw e;
        }

        const networkError = new ModelCatalogError('network', 'Model catalog request failed');
        if (cursor === null) {
          const memoryFitContext = await memoryFitContextPromise;
          const fallback = (
            this.getCachedSearchResultForScope(query, options, catalogSearchHasAuthScope, memoryFitContext)
            ?? (catalogSearchHasAuthScope
              ? this.getCachedSearchResultForScope(query, options, false, memoryFitContext)
              : null)
          );
          return {
            ...(fallback
              ? this.toNonPaginatedFallback(fallback)
              : this.getLocalSearchResults(query, memoryFitContext)),
            warning: networkError,
          };
        }

        throw networkError;
      }
    })();

    if (!inFlight) {
      this.searchRequestCache.set(cacheKey, requestPromise);
    }

    try {
      return await requestPromise;
    } catch (e) {
      if (e instanceof StaleCatalogAuthError) {
        if (this.searchRequestCache.get(cacheKey) === requestPromise) {
          this.searchRequestCache.delete(cacheKey);
        }

        if (cursor === null && retryCount < 1) {
          return this.searchModelsInternal(query, options, retryCount + 1);
        }

        throw new ModelCatalogError('network', 'Catalog auth context changed during request');
      }

      throw e;
    } finally {
      if (!inFlight && this.searchRequestCache.get(cacheKey) === requestPromise) {
        this.searchRequestCache.delete(cacheKey);
      }
    }
  }

  public getCachedModel(modelId: string): ModelMetadata | null {
    const cachedSnapshot = this.getCachedModelSnapshot(modelId);
    if (cachedSnapshot) {
      const merged = this.mergeModelWithRegistry(cachedSnapshot.model, this.getRememberedMemoryFitContext());
      if (merged) {
        this.cacheModelSnapshotsInMemory([merged], cachedSnapshot.authScope);
        return merged;
      }
    }

    const localModel = registry.getModel(modelId);
    return localModel ? this.withResolvedMemoryFit(localModel, this.getRememberedMemoryFitContext()) : null;
  }

  private isSupportedResolvedCatalogFileName(fileName: string | undefined): boolean {
    const normalized = fileName?.trim();
    return Boolean(
      normalized
      && normalized.toLowerCase().endsWith('.gguf')
      && !isProjectorFileName(normalized)
      && !isUnsupportedMtpFileName(normalized),
    );
  }

  private extractResolvedFileNameFromDownloadUrl(downloadUrl: string | undefined): string | undefined {
    const normalized = downloadUrl?.trim();
    if (!normalized) {
      return undefined;
    }

    try {
      const parsed = new URL(normalized);
      const pathSegments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
      const resolveIndex = pathSegments.indexOf('resolve');
      const fileSegments = resolveIndex >= 0 && pathSegments.length > resolveIndex + 2
        ? pathSegments.slice(resolveIndex + 2)
        : pathSegments.slice(-1);
      const decoded = fileSegments.map((segment) => decodeURIComponent(segment)).join('/').trim();
      return decoded.length > 0 ? decoded : undefined;
    } catch {
      const withoutQuery = normalized.split(/[?#]/)[0] ?? normalized;
      const fallback = withoutQuery.split(/[\\/]/).filter(Boolean).pop()?.trim();
      return fallback && fallback.length > 0 ? fallback : undefined;
    }
  }

  private sanitizeCachedCatalogModelResolvedFile(
    model: ModelMetadata,
    fallbackModel?: ModelMetadata,
  ): ModelMetadata {
    const resolvedFileName = model.resolvedFileName?.trim();
    const downloadFileName = this.extractResolvedFileNameFromDownloadUrl(model.downloadUrl);
    const fallbackFileName = this.isSupportedResolvedCatalogFileName(fallbackModel?.resolvedFileName)
      ? fallbackModel?.resolvedFileName
      : undefined;
    const hasSupportedResolvedFileName = this.isSupportedResolvedCatalogFileName(resolvedFileName);
    const hasUnsupportedDownloadFileName = Boolean(
      downloadFileName && !this.isSupportedResolvedCatalogFileName(downloadFileName),
    );

    if (!resolvedFileName && model.requiresTreeProbe !== true && !fallbackFileName && !hasUnsupportedDownloadFileName) {
      return model;
    }

    const hasMismatchedDownloadFileName = Boolean(
      hasSupportedResolvedFileName
      && downloadFileName
      && downloadFileName !== resolvedFileName,
    );

    if (
      (!resolvedFileName || hasSupportedResolvedFileName)
      && !hasUnsupportedDownloadFileName
      && !hasMismatchedDownloadFileName
    ) {
      return model;
    }

    const replacementFileName = fallbackFileName ?? (hasSupportedResolvedFileName ? resolvedFileName : undefined);
    const metadataSource = fallbackFileName ? fallbackModel : undefined;

    if (replacementFileName) {
      const hfRevision = metadataSource ? metadataSource.hfRevision : model.hfRevision;
      return normalizePersistedModelMetadata({
        ...model,
        size: metadataSource?.size ?? null,
        fitsInRam: metadataSource?.fitsInRam ?? null,
        memoryFitDecision: metadataSource?.memoryFitDecision,
        memoryFitConfidence: metadataSource?.memoryFitConfidence,
        metadataTrust: metadataSource?.metadataTrust,
        gguf: metadataSource?.gguf,
        capabilitySnapshot: metadataSource?.capabilitySnapshot,
        maxContextTokens: metadataSource?.maxContextTokens,
        hasVerifiedContextWindow: metadataSource?.hasVerifiedContextWindow === true,
        parameterSizeLabel: metadataSource?.parameterSizeLabel,
        variants: metadataSource?.variants ?? model.variants,
        activeVariantId: replacementFileName,
        hfRevision,
        resolvedFileName: replacementFileName,
        downloadUrl: buildHuggingFaceResolveUrl(model.id, replacementFileName, hfRevision),
        sha256: metadataSource?.sha256,
        requiresTreeProbe: metadataSource ? metadataSource.requiresTreeProbe === true : true,
      });
    }

    return normalizePersistedModelMetadata({
      ...model,
      size: null,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
      metadataTrust: undefined,
      gguf: undefined,
      capabilitySnapshot: undefined,
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
      parameterSizeLabel: undefined,
      variants: undefined,
      activeVariantId: undefined,
      resolvedFileName: undefined,
      downloadUrl: buildHuggingFaceResolveUrl(model.id, 'model.gguf', model.hfRevision),
      sha256: undefined,
      requiresTreeProbe: true,
    });
  }

  private createUnresolvedTreeProbeMissModel(model: ModelMetadata): ModelMetadata {
    return normalizePersistedModelMetadata({
      ...model,
      size: null,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
      metadataTrust: undefined,
      gguf: undefined,
      capabilitySnapshot: undefined,
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
      parameterSizeLabel: undefined,
      variants: undefined,
      activeVariantId: undefined,
      resolvedFileName: undefined,
      localPath: undefined,
      downloadedAt: undefined,
      downloadIntegrity: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      downloadErrorAt: undefined,
      downloadUrl: getHuggingFaceModelUrl(model.id),
      sha256: undefined,
      requiresTreeProbe: false,
      chatModalities: model.chatModalities?.filter((modality) => modality !== 'vision'),
      artifactRole: undefined,
      visionSource: undefined,
      visionConfidence: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
    });
  }

  private finalizeUnresolvedTreeProbeMissModel(model: ModelMetadata): ModelMetadata {
    const unresolvedModel = this.createUnresolvedTreeProbeMissModel(model);
    this.evictModelFromCatalogCaches(model.id);

    if (registry.getModel(model.id)) {
      registry.updateModel(unresolvedModel);
    }

    return unresolvedModel;
  }

  private evictModelFromCatalogCaches(modelId: string, authScope?: CatalogCacheAuthScope): void {
    const scopes = authScope ? [authScope] : (['anon', 'auth'] as const);
    scopes.forEach((scope) => {
      this.modelSnapshotCache.delete(this.buildModelSnapshotCacheKey(modelId, scope));
      this.persistentCache.deleteModelSnapshots([modelId], scope);
    });

    for (const [key, entry] of this.searchCache.entries()) {
      const nextModels = entry.result.models.filter((model) => model.id !== modelId);
      if (nextModels.length === entry.result.models.length) {
        continue;
      }

      this.searchCache.set(key, {
        ...entry,
        result: {
          ...entry.result,
          models: nextModels,
        },
      });
    }
    this.persistentCache.deleteSearchModels([modelId], authScope);
  }

  private sanitizeCachedCatalogModelsResolvedFiles(models: ModelMetadata[]): ModelMetadata[] {
    return models.map((model) => this.sanitizeCachedCatalogModelResolvedFile(model, registry.getModel(model.id)));
  }

  private getCachedModelSnapshot(
    modelId: string,
  ): { model: ModelMetadata; authScope: CatalogCacheAuthScope } | null {
    for (const authScope of this.getSnapshotReadScopes()) {
      const cacheKey = this.buildModelSnapshotCacheKey(modelId, authScope);
      const inMemorySnapshot = this.getModelSnapshotFromMemory(cacheKey);
      if (inMemorySnapshot) {
        return { model: inMemorySnapshot, authScope };
      }

      const persistedSnapshot = this.persistentCache.getModelSnapshot(
        modelId,
        authScope,
        PERSISTENT_CACHE_MAX_AGE,
      );
      if (persistedSnapshot) {
        return { model: persistedSnapshot, authScope };
      }
    }

    return null;
  }

  private getSnapshotReadScopes(): CatalogCacheAuthScope[] {
    const currentScope = this.getCurrentSnapshotAuthScope();
    return currentScope === 'auth' ? ['auth', 'anon'] : ['anon'];
  }

  private getCurrentSnapshotAuthScope(): CatalogCacheAuthScope {
    return this.getAuthScope(huggingFaceTokenService.getCachedState().hasToken);
  }

  private buildModelSnapshotCacheKey(
    modelId: string,
    authScope: CatalogCacheAuthScope,
  ): string {
    return `${modelId}::${authScope}`;
  }

  private getModelSnapshotFromMemory(cacheKey: string): ModelMetadata | null {
    const cached = this.modelSnapshotCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    // Map#set does not change insertion order when updating an existing key, so we
    // delete+set to keep the cache eviction order closer to LRU.
    this.modelSnapshotCache.delete(cacheKey);
    this.modelSnapshotCache.set(cacheKey, cached);
    return cached;
  }

  private setModelSnapshotInMemory(cacheKey: string, model: ModelMetadata): void {
    // Ensure insertion order reflects recency for eviction.
    if (this.modelSnapshotCache.has(cacheKey)) {
      this.modelSnapshotCache.delete(cacheKey);
    }
    this.modelSnapshotCache.set(cacheKey, model);
  }

  public getCachedSearchResult(
    query: string = 'gguf',
    options?: { cursor?: string | null; pageSize?: number; sort?: CatalogServerSort | null; gated?: boolean },
  ): Omit<ModelCatalogSearchResult, 'warning'> | null {
    const cached = this.getCachedSearchResultForScope(
      query,
      options,
      false,
    );

    if (!cached) {
      return null;
    }

    return this.coerceCachedResultForConnectivity(cached);
  }

  private getCachedSearchResultForScope(
    query: string,
    options: { cursor?: string | null; pageSize?: number; sort?: CatalogServerSort | null; gated?: boolean } | undefined,
    hasToken: boolean,
    memoryFitContext: CatalogMemoryFitContext | null = this.getRememberedMemoryFitContext(),
  ): Omit<ModelCatalogSearchResult, 'warning'> | null {
    const cursor = options?.cursor ?? null;
    if (cursor !== null) {
      return null;
    }

    const pageSize = options?.pageSize ?? 20;
    const sort = options?.sort ?? null;
    const gated = options?.gated;
    const normalizedQuery = this.normalizeQuery(query);
    const memoryKey = this.buildMemorySearchCacheKey(
      normalizedQuery,
      cursor,
      pageSize,
      sort,
      hasToken,
      gated,
    );
    const memoryEntry = this.searchCache.get(memoryKey);
    const isMemoryEntryFresh = Boolean(memoryEntry) && Date.now() - (memoryEntry?.timestamp ?? 0) < CACHE_TTL;

    if (memoryEntry && !isMemoryEntryFresh) {
      this.searchCache.delete(memoryKey);
    }

    if (isMemoryEntryFresh && memoryEntry) {
      const filteredMemoryModels = filterCatalogSearchModels(
        this.sanitizeCachedCatalogModelsResolvedFiles(memoryEntry.result.models),
      ).map((model) => this.toSearchResultModel(model));
      return {
        ...memoryEntry.result,
        models: this.mergeWithRegistry(filteredMemoryModels, this.getAuthScope(hasToken), memoryFitContext),
      };
    }

    if (typeof gated === 'boolean') {
      return null;
    }

    const persistentEntry = this.persistentCache.getSearch(
      this.buildPersistentSearchScope(normalizedQuery, pageSize, sort, hasToken),
      PERSISTENT_CACHE_MAX_AGE,
    );
    if (!persistentEntry) {
      return null;
    }

    const filteredPersistedModels = filterCatalogSearchModels(
      this.sanitizeCachedCatalogModelsResolvedFiles(persistentEntry.models),
    ).map((model) => this.toSearchResultModel(model));
    const mergedModels = this.mergeWithRegistry(
      filteredPersistedModels,
      this.getAuthScope(hasToken),
      memoryFitContext,
    );
      return {
        ...this.sanitizeSearchResultCursor(persistentEntry),
        models: mergedModels,
      };
  }

  private coerceCachedResultForConnectivity(
    result: Omit<ModelCatalogSearchResult, 'warning'>,
  ): Omit<ModelCatalogSearchResult, 'warning'> {
    const isConnected = hardwareListenerService.getCurrentStatus().isConnected;
    return isConnected ? result : this.toNonPaginatedFallback(result);
  }

  private toNonPaginatedFallback(
    result: Omit<ModelCatalogSearchResult, 'warning'>,
  ): Omit<ModelCatalogSearchResult, 'warning'> {
    return {
      ...result,
      hasMore: false,
      nextCursor: null,
    };
  }

  private toSearchResultModel(model: ModelMetadata): ModelMetadata {
    const variants = limitModelVariants(model.variants, {
      limit: CATALOG_SEARCH_VARIANT_LIMIT,
      includeFileNames: [model.resolvedFileName, model.activeVariantId],
      includeVariantIds: [model.activeVariantId],
    });

    if (variants === model.variants) {
      return model;
    }

    return normalizePersistedModelMetadata({
      ...model,
      variants,
    });
  }

  public async getModelDetails(modelId: string): Promise<ModelMetadata> {
    return this.getModelDetailsInternal(modelId, 0);
  }

  private async getModelDetailsInternal(modelId: string, retryCount: number): Promise<ModelMetadata> {
    const requestContext = await this.createRequestContext();
    const memoryFitContext = await this.getCurrentMemoryFitContext();

    try {
      const cachedModel = this.getCachedModel(modelId);
      const fallbackModel = cachedModel ?? createFallbackModel(modelId);
      const requiresAuthHint = fallbackModel.isGated
        || fallbackModel.isPrivate
        || fallbackModel.accessState !== ModelAccessState.PUBLIC;
      const detailsUrl = buildHuggingFaceModelApiUrl(modelId);
      let detailsAuthToken: string | null = null;
      let response = await fetchWithTimeout(detailsUrl, {
        headers: buildHeaders(REQUEST_AUTH_POLICY.ANONYMOUS, requestContext.authToken),
      });
      this.assertRequestContextIsCurrent(requestContext);

      if (
        !response.ok
        && (response.status === 401 || response.status === 403 || response.status === 404)
        && requestContext.hasAuthToken
      ) {
        detailsAuthToken = requestContext.authToken;
        response = await fetchWithTimeout(detailsUrl, {
          headers: buildHeaders(REQUEST_AUTH_POLICY.REQUIRED_AUTH, requestContext.authToken),
        });
        this.assertRequestContextIsCurrent(requestContext);
      }
      let detailedModel = fallbackModel;
      let hasVerifiedContextWindow = fallbackModel.hasVerifiedContextWindow === true;

      if (response.ok) {
        const payload = await response.json() as HuggingFaceModelSummary;
        this.assertRequestContextIsCurrent(requestContext);
        const payloadMaxContextTokens = resolveSummaryMaxContextTokens(payload);
        detailedModel = buildModelMetadataFromPayload(
          payload,
          memoryFitContext,
          requestContext.authToken,
          fallbackModel,
          payloadMaxContextTokens,
        );
        const [resolvedModel] = await this.resolveMissingModelMetadata(
          [detailedModel],
          memoryFitContext,
          requestContext,
          { treeProbeMode: 'full' },
        );
        if (!resolvedModel && detailedModel.requiresTreeProbe === true) {
          return this.finalizeUnresolvedTreeProbeMissModel(detailedModel);
        }

        detailedModel = resolvedModel ?? detailedModel;
        hasVerifiedContextWindow = detailedModel.hasVerifiedContextWindow === true || typeof payloadMaxContextTokens === 'number';
      } else if (response.status === 401 || response.status === 403) {
        detailedModel = normalizePersistedModelMetadata({
          ...fallbackModel,
          accessState: detailsAuthToken
            ? ModelAccessState.ACCESS_DENIED
            : ModelAccessState.AUTH_REQUIRED,
        });
      } else if (response.status === 404) {
        if (!requiresAuthHint) {
          throw new ModelCatalogError('network', `HF model details failed: ${response.status}`);
        }

        detailedModel = normalizePersistedModelMetadata({
          ...fallbackModel,
          accessState: detailsAuthToken
            ? ModelAccessState.ACCESS_DENIED
            : ModelAccessState.AUTH_REQUIRED,
        });
      } else {
        throw new ModelCatalogError('network', `HF model details failed: ${response.status}`);
      }

      const readmeData = await this.fetchModelReadmeData(
        modelId,
        detailedModel.hfRevision,
        requestContext,
        {
          retryNotFoundWithAuth: this.isAuthRestrictedModel(detailedModel),
        },
      ).catch((error) => {
        if (error instanceof StaleCatalogAuthError) {
          throw error;
        }

        console.warn(`[ModelCatalogService] Failed to load README summary for ${modelId}`, error);
        return undefined;
      });

      if (readmeData) {
        detailedModel = normalizePersistedModelMetadata({
          ...detailedModel,
          description: readmeData.description ?? detailedModel.description,
          maxContextTokens: resolveMergedMaxContextTokens(
            detailedModel.maxContextTokens,
            readmeData.maxContextTokens,
          ),
          modelType: resolveStringMetadata(
            detailedModel.modelType,
            readmeData.cardData?.model_type,
          ),
          baseModels: resolveStringArrayMetadata(
            detailedModel.baseModels,
            readmeData.cardData?.base_model,
          ),
          license: resolveStringMetadata(
            detailedModel.license,
            readmeData.cardData?.license,
          ),
          languages: resolveStringArrayMetadata(
            detailedModel.languages,
            readmeData.cardData?.language,
          ),
          datasets: resolveStringArrayMetadata(
            detailedModel.datasets,
            readmeData.cardData?.datasets,
          ),
          quantizedBy: resolveStringMetadata(
            detailedModel.quantizedBy,
            readmeData.cardData?.quantized_by,
          ),
          modelCreator: resolveStringMetadata(
            detailedModel.modelCreator,
            readmeData.cardData?.model_creator,
          ),
        });
      }

      if (typeof readmeData?.maxContextTokens === 'number') {
        hasVerifiedContextWindow = true;
      }

      detailedModel = normalizePersistedModelMetadata({
        ...detailedModel,
        hasVerifiedContextWindow,
      });

      this.assertRequestContextIsCurrent(requestContext);
      if (detailsAuthToken) {
        this.upsertModelSnapshots([detailedModel], 'auth');
        this.reconcileAnonymousModelVisibility([detailedModel]);
      } else {
        this.reconcileAnonymousModelVisibility([detailedModel]);
        if (
          detailedModel.accessState === ModelAccessState.AUTHORIZED
          || detailedModel.accessState === ModelAccessState.ACCESS_DENIED
        ) {
          this.upsertModelSnapshots([detailedModel], 'auth');
        }
      }
      return this.syncRegistryModelIfPresent(detailedModel);
    } catch (error) {
      if (error instanceof StaleCatalogAuthError && retryCount < 1) {
        return this.getModelDetailsInternal(modelId, retryCount + 1);
      }

      throw error;
    }
  }

  public async refreshModelMetadata(
    model: ModelMetadata,
    options?: RefreshModelMetadataOptions,
  ): Promise<ModelMetadata> {
    return this.refreshModelMetadataInternal(model, 0, {
      includeDetails: options?.includeDetails !== false,
    });
  }

  private async refreshModelMetadataInternal(
    model: ModelMetadata,
    retryCount: number,
    options: { includeDetails: boolean },
  ): Promise<ModelMetadata> {
    const requestContext = await this.createRequestContext();
    try {
      const canRefreshDetailsForContextWindow = (
        model.hasVerifiedContextWindow !== true
        && (
          model.accessState === ModelAccessState.PUBLIC
          || requestContext.hasAuthToken
        )
      );

      if (options.includeDetails && canRefreshDetailsForContextWindow) {
        return this.getModelDetailsInternal(model.id, retryCount);
      }

      const memoryFitContext = await this.getCurrentMemoryFitContext();
      const [resolved] = await this.resolveMissingModelMetadata([model], memoryFitContext, requestContext, {
        treeProbeMode: options.includeDetails ? 'full' : 'bounded',
      });
      this.assertRequestContextIsCurrent(requestContext);
      if (!resolved && model.requiresTreeProbe === true) {
        return this.finalizeUnresolvedTreeProbeMissModel(model);
      }

      const refreshed = resolved ?? model;
      const snapshotAuthScope = this.getAuthScope(requestContext.hasAuthToken && (
        refreshed.accessState !== ModelAccessState.PUBLIC
        || refreshed.isGated
        || refreshed.isPrivate
      ));
      this.upsertModelSnapshots([refreshed], snapshotAuthScope);
      if (snapshotAuthScope === 'auth') {
        this.reconcileAnonymousModelVisibility([refreshed]);
      }
      return this.syncRegistryModelIfPresent(refreshed);
    } catch (error) {
      if (error instanceof StaleCatalogAuthError && retryCount < 1) {
        return this.refreshModelMetadataInternal(model, retryCount + 1, options);
      }

      throw error;
    }
  }

  public async getLocalModels(): Promise<ModelMetadata[]> {
    await this.getCurrentMemoryFitContext();
    const localModels = registry.getModels().map((model) => (
      this.getCachedModel(model.id) ?? model
    ));
    this.upsertModelSnapshots(localModels, 'anon');
    return localModels;
  }

  private getLocalSearchResults(
    query: string,
    memoryFitContext: CatalogMemoryFitContext | null = this.getRememberedMemoryFitContext(),
  ): ModelCatalogSearchResult {
    const filtered = registry.getModels().filter((model) =>
      model.name.toLowerCase().includes(query.toLowerCase()) ||
      model.id.toLowerCase().includes(query.toLowerCase()),
    );
    const merged = filtered.map((model) => this.withResolvedMemoryFit(model, memoryFitContext));
    this.upsertModelSnapshots(merged, 'anon');

    return {
      models: merged,
      hasMore: false,
      nextCursor: null,
    };
  }

  private async getTotalMemory(): Promise<number | null> {
    try {
      const totalMemoryBytes = await DeviceInfo.getTotalMemory();
      return typeof totalMemoryBytes === 'number' && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
        ? totalMemoryBytes
        : null;
    } catch {
      return null;
    }
  }

  private async getCurrentMemoryFitContext(): Promise<CatalogMemoryFitContext> {
    const remembered = this.lastMemoryFitContext;
    if (remembered && remembered.totalMemoryBytes !== null) {
      return remembered;
    }

    const deviceTotalMemoryBytes = await this.getTotalMemory();
    const totalMemoryBytes = deviceTotalMemoryBytes;
    const memoryFitContext = {
      totalMemoryBytes,
      systemMemorySnapshot: null,
    };
    this.lastMemoryFitContext = memoryFitContext;
    return memoryFitContext;
  }

  private getRememberedMemoryFitContext(): CatalogMemoryFitContext | null {
    return this.lastMemoryFitContext;
  }

  private resolveVariantProjectorMemoryFitSizeBytes(
    entries: HuggingFaceTreeEntry[],
    repoId: string,
    hfRevision: string | undefined,
    variant: ModelVariant,
  ): number {
    const projectorCandidates = buildProjectorCandidatesFromEntries(entries, {
      repoId,
      hfRevision,
      ownerModelId: repoId,
      ownerVariantId: variant.variantId,
      ownerFileName: variant.fileName,
    });

    return getProjectorMemoryFitSizeBytes(projectorCandidates, variant.selectedProjectorId);
  }

  private resolveActiveVariantKeys(
    model: Pick<ModelMetadata, 'activeVariantId' | 'resolvedFileName' | 'variants'>,
  ): Set<string> {
    const activeVariantId = this.normalizeProjectorVariantId(model.activeVariantId);
    const resolvedFileName = this.normalizeProjectorVariantId(model.resolvedFileName);
    const activeVariant = model.variants?.find((variant) => (
      (activeVariantId && (variant.variantId === activeVariantId || variant.fileName === activeVariantId))
      || (resolvedFileName && (variant.variantId === resolvedFileName || variant.fileName === resolvedFileName))
    ));

    return new Set([
      activeVariantId,
      resolvedFileName,
      this.normalizeProjectorVariantId(activeVariant?.variantId),
      this.normalizeProjectorVariantId(activeVariant?.fileName),
    ].filter((value): value is string => typeof value === 'string'));
  }

  private resolveActiveVariantProjectorMemoryFitSizeBytes(
    model: Pick<
      ModelMetadata,
      'id' | 'activeVariantId' | 'resolvedFileName' | 'variants' | 'projectorCandidates' | 'selectedProjectorId'
    >,
  ): number {
    const activeVariantKeys = this.resolveActiveVariantKeys(model);
    const compatibleCandidates = (model.projectorCandidates ?? []).filter((projector) => {
      if (projector.ownerModelId !== model.id) {
        return false;
      }

      const ownerVariantId = this.normalizeProjectorVariantId(projector.ownerVariantId);
      return !ownerVariantId || activeVariantKeys.size === 0 || activeVariantKeys.has(ownerVariantId);
    });

    return getProjectorMemoryFitSizeBytes(compatibleCandidates, model.selectedProjectorId);
  }

  private withActiveVariantResolvedMemoryFit(
    variants: ModelVariant[] | undefined,
    activeVariantId: string | undefined,
    resolvedMemoryFit: ReturnType<typeof resolveMemoryFitSummary>,
  ): ModelVariant[] | undefined {
    if (!variants?.length || !activeVariantId || !resolvedMemoryFit) {
      return variants;
    }

    let didUpdate = false;
    const nextVariants = variants.map((variant) => {
      const isActiveVariant = variant.variantId === activeVariantId || variant.fileName === activeVariantId;
      if (!isActiveVariant) {
        return variant;
      }

      if (
        variant.ramFit === resolvedMemoryFit.decision
        && variant.ramFitConfidence === resolvedMemoryFit.confidence
      ) {
        return variant;
      }

      didUpdate = true;
      return {
        ...variant,
        ramFit: resolvedMemoryFit.decision,
        ramFitConfidence: resolvedMemoryFit.confidence,
      };
    });

    return didUpdate ? nextVariants : variants;
  }

  private withResolvedMemoryFit(
    model: ModelMetadata,
    memoryFitContext: CatalogMemoryFitContext | null = this.getRememberedMemoryFitContext(),
  ): ModelMetadata {
    const resolvedMemoryFit = resolveMemoryFitSummary(model, memoryFitContext, {
      projectorSizeBytes: this.resolveActiveVariantProjectorMemoryFitSizeBytes(model),
    });
    const fitsInRam = resolvedMemoryFit?.fitsInRam ?? model.fitsInRam;
    const memoryFitDecision = resolvedMemoryFit?.decision ?? model.memoryFitDecision;
    const memoryFitConfidence = resolvedMemoryFit?.confidence ?? model.memoryFitConfidence;
    const variants = this.withActiveVariantResolvedMemoryFit(
      model.variants,
      model.activeVariantId ?? model.resolvedFileName,
      resolvedMemoryFit,
    );

    if (
      fitsInRam === model.fitsInRam
      && memoryFitDecision === model.memoryFitDecision
      && memoryFitConfidence === model.memoryFitConfidence
      && variants === model.variants
    ) {
      return model;
    }

    return normalizePersistedModelMetadata({
      ...model,
      fitsInRam,
      memoryFitDecision,
      memoryFitConfidence,
      variants,
    });
  }

  private isProjectorAwareModel(model: ModelMetadata): boolean {
    return model.chatModalities?.includes('vision') === true
      || Boolean(model.projectorCandidates?.length)
      || Boolean(model.selectedProjectorId)
      || model.multimodalReadiness?.support.includes('vision') === true
      || model.visionSource !== undefined
      || model.visionConfidence !== undefined;
  }

  private async resolveMissingModelMetadata(
    models: ModelMetadata[],
    memoryFitContext: CatalogMemoryFitContext,
    requestContext: CatalogRequestContext,
    options: ResolveMissingModelMetadataOptions = {},
  ): Promise<ModelMetadata[]> {
    const batchSize = 5;
    const span = performanceMonitor.startSpan('catalog.resolveMissingModelMetadata', {
      count: models.length,
      hasAuthToken: requestContext.hasAuthToken,
      batchSize,
    });
    performanceMonitor.incrementCounter('catalog.resolveMissingModelMetadata.calls');

    const resolveModel = async (model: ModelMetadata): Promise<ModelMetadata | null> => {
      const hasKnownSize = typeof model.size === 'number' && model.size > 0;
      const shouldCollectProjectorCandidates = this.isProjectorAwareModel(model);
      const requiresAuthValidation = requestContext.hasAuthToken && (
        model.accessState !== ModelAccessState.PUBLIC ||
        model.isGated ||
        model.isPrivate
      );

      if (
        hasKnownSize
        && !requiresAuthValidation
        && model.requiresTreeProbe !== true
        && !shouldCollectProjectorCandidates
      ) {
        return model;
      }

      if (
        hasKnownSize
        && requiresAuthValidation
        && model.requiresTreeProbe !== true
        && !shouldCollectProjectorCandidates
      ) {
        const probedAccessState = await this.probeResolvedModelAccess(model, requestContext);
        if (probedAccessState) {
          return normalizePersistedModelMetadata({
            ...model,
            accessState: probedAccessState,
            requiresTreeProbe: false,
          });
        }
      }

      try {
        const treeAuthPolicy = (
          model.accessState !== ModelAccessState.PUBLIC
          || model.isGated
          || model.isPrivate
        )
          ? REQUEST_AUTH_POLICY.OPTIONAL_AUTH
          : REQUEST_AUTH_POLICY.ANONYMOUS;
        const useFullTreeProbe = options.treeProbeMode === 'full';
        const shouldScanForProjectorCandidates = useFullTreeProbe && shouldCollectProjectorCandidates;
        const treeResponse = await this.fetchHuggingFaceModelTree(
          model.id,
          model.hfRevision,
          requestContext,
          treeAuthPolicy,
          {
            expectedFileName: model.resolvedFileName,
            allowTargetEarlyStop: !shouldScanForProjectorCandidates,
            maxPages: shouldScanForProjectorCandidates
              ? HF_TREE_PROJECTOR_PAGINATION_MAX_PAGES
              : useFullTreeProbe ? HF_TREE_DETAIL_PAGINATION_MAX_PAGES : HF_TREE_SEARCH_PAGINATION_MAX_PAGES,
          },
        );
        const selectedEntry = selectTreeEntryForModel(model, treeResponse.entries);
        const treeProbeIsFinal = treeResponse.isComplete || (
          model.requiresTreeProbe !== true && (
            treeResponse.stopReason === 'target_found'
            || treeResponse.stopReason === 'preferred_found'
            || treeResponse.stopReason === 'lookahead'
          )
        );
        const shouldKeepTreeProbe = !treeProbeIsFinal && (
          model.requiresTreeProbe === true
          || shouldCollectProjectorCandidates
        );
        const accessState = this.resolveTreeAccessState(
          model,
          requestContext.authToken,
          treeResponse.status,
          {
            allowAuthorization: treeResponse.isComplete || selectedEntry !== undefined,
          },
        );

        if (!selectedEntry) {
          if (
            model.requiresTreeProbe &&
            treeProbeIsFinal &&
            treeResponse.status >= 200 &&
            treeResponse.status < 300
          ) {
            return null;
          }

          const projectorMetadataPatch = shouldCollectProjectorCandidates && !treeResponse.isComplete
            ? this.mergeProjectorMetadataWithLocalState(
              {
                ...model,
                projectorCandidates: model.projectorCandidates,
              },
              model,
              false,
            )
            : {};

          return normalizePersistedModelMetadata({
            ...model,
            accessState,
            requiresTreeProbe: shouldKeepTreeProbe,
            ...projectorMetadataPatch,
          });
        }

        const resolvedFileName = getFileName(selectedEntry);
        const expectedResolvedFileName = model.resolvedFileName?.trim();
        const selectedEntryMatchesExpectedFile = Boolean(
          expectedResolvedFileName && resolvedFileName === expectedResolvedFileName,
        );

        if (
          expectedResolvedFileName
          && !selectedEntryMatchesExpectedFile
          && !treeProbeIsFinal
        ) {
          return normalizePersistedModelMetadata({
            ...model,
            accessState,
            requiresTreeProbe: true,
          });
        }

        const variants = attachMemoryFitToVariants(buildCatalogModelVariants(treeResponse.entries, {
          limit: CATALOG_SEARCH_VARIANT_LIMIT,
          includeFileNames: [resolvedFileName, model.resolvedFileName, model.activeVariantId],
          includeVariantIds: [model.activeVariantId],
        }), memoryFitContext, {
          resolveProjectorSizeBytes: (variant) => this.resolveVariantProjectorMemoryFitSizeBytes(
            treeResponse.entries,
            model.id,
            model.hfRevision,
            variant,
          ),
        });
        const discoveredProjectorCandidates = buildProjectorCandidatesFromEntries(treeResponse.entries, {
          repoId: model.id,
          hfRevision: model.hfRevision,
          ownerModelId: model.id,
          ownerFileName: resolvedFileName,
        });
        const projectorCandidates = discoveredProjectorCandidates
          ?? (useFullTreeProbe && treeResponse.isComplete ? [] : undefined);
        const hasVisionCapability = model.chatModalities?.includes('vision') === true
          || Boolean(projectorCandidates?.length);
        const treeEntrySha256 = getFileSha(selectedEntry);
        const treeEntrySize = getFileSize(selectedEntry);
        const {
          localVerifiedSha256,
          canUseLocalVerifiedMetadata,
          canPreserveDownloadIntegrity,
          shouldResetLocalDownloadState,
        } = resolveVerifiedLocalShaCompatibility(model, {
          sha256: treeEntrySha256,
          resolvedFileName,
          size: treeEntrySize,
        });
        const shouldPreserveVerifiedLocal = canUseLocalVerifiedMetadata;
        const localDownloadStatePatch = getCompatibleLocalDownloadStatePatch(model, {
          shouldResetLocalDownloadState,
          canPreserveDownloadIntegrity,
        });
        const size = shouldPreserveVerifiedLocal
          ? model.size ?? treeEntrySize
          : treeEntrySize;
        const treeEntryHasTrustedSize = typeof treeEntrySize === 'number'
          && Number.isFinite(treeEntrySize)
          && treeEntrySize > 0;
        const metadataTrust = shouldPreserveVerifiedLocal
          ? model.metadataTrust
          : treeEntryHasTrustedSize ? 'trusted_remote' as const : undefined;
        const { totalBytes: _staleTotalBytes, ...existingGguf } = model.gguf ?? {};
        const gguf = shouldPreserveVerifiedLocal
          ? model.gguf
          : treeEntryHasTrustedSize
            ? {
              ...existingGguf,
              totalBytes: Math.round(treeEntrySize),
            }
            : Object.keys(existingGguf).length > 0
              ? existingGguf
              : undefined;
        const canCarryForwardLocalSha256 = !shouldResetLocalDownloadState
          && model.metadataTrust !== 'verified_local';
        const sha256 = treeEntrySha256
          ?? (shouldPreserveVerifiedLocal
            ? localVerifiedSha256
            : canCarryForwardLocalSha256 ? model.sha256 : undefined);
        const projectorCandidatesForMerge = projectorCandidates
          ?? (shouldResetLocalDownloadState ? undefined : model.projectorCandidates);
        const projectorMetadataPatch = this.mergeProjectorMetadataWithLocalState(
          {
            ...model,
            projectorCandidates: projectorCandidatesForMerge,
          },
          model,
          shouldResetLocalDownloadState,
          projectorCandidates !== undefined && !treeResponse.isComplete && !shouldResetLocalDownloadState,
        );
        const resolvedMemoryFit = shouldPreserveVerifiedLocal
          ? null
          : resolveMemoryFitSummary({ size, metadataTrust, gguf }, memoryFitContext, {
            projectorSizeBytes: this.resolveActiveVariantProjectorMemoryFitSizeBytes({
              ...model,
              resolvedFileName,
              activeVariantId: resolvedFileName,
              variants,
              projectorCandidates: projectorMetadataPatch.projectorCandidates,
              selectedProjectorId: projectorMetadataPatch.selectedProjectorId,
            }),
          });
        const didChangeSize = size !== model.size;
        const fitsInRam = shouldPreserveVerifiedLocal
          ? model.fitsInRam
          : resolvedMemoryFit
            ? resolvedMemoryFit.fitsInRam
            : didChangeSize
              ? null
              : model.fitsInRam;
        const memoryFitDecision = shouldPreserveVerifiedLocal
          ? model.memoryFitDecision
          : resolvedMemoryFit
            ? resolvedMemoryFit.decision
            : didChangeSize
              ? undefined
              : model.memoryFitDecision;
        const memoryFitConfidence = shouldPreserveVerifiedLocal
          ? model.memoryFitConfidence
          : resolvedMemoryFit
            ? resolvedMemoryFit.confidence
            : didChangeSize
              ? undefined
              : model.memoryFitConfidence;
        const variantsWithResolvedActiveMemoryFit = this.withActiveVariantResolvedMemoryFit(
          variants,
          resolvedFileName,
          resolvedMemoryFit,
        );

        if (shouldKeepTreeProbe) {
          return normalizePersistedModelMetadata({
            ...model,
            ...localDownloadStatePatch,
            size,
            fitsInRam,
            memoryFitDecision,
            memoryFitConfidence,
            metadataTrust,
            gguf,
            accessState,
            requiresTreeProbe: true,
            hfRevision: model.hfRevision,
            resolvedFileName,
            downloadUrl: buildHuggingFaceResolveUrl(model.id, resolvedFileName, model.hfRevision),
            sha256,
            variants: variantsWithResolvedActiveMemoryFit,
            activeVariantId: resolvedFileName,
            chatModalities: hasVisionCapability ? ['text', 'vision'] : model.chatModalities,
            artifactRole: 'primary_chat_model',
            visionSource: projectorCandidates?.length ? 'tree_probe' : model.visionSource,
            visionConfidence: projectorCandidates?.length ? 'trusted' : model.visionConfidence,
            ...projectorMetadataPatch,
          });
        }

        return normalizePersistedModelMetadata({
          ...model,
          ...localDownloadStatePatch,
          size,
          fitsInRam,
          memoryFitDecision,
          memoryFitConfidence,
          metadataTrust,
          gguf,
          accessState,
          requiresTreeProbe: false,
          hfRevision: model.hfRevision,
          resolvedFileName,
          downloadUrl: buildHuggingFaceResolveUrl(model.id, resolvedFileName, model.hfRevision),
          sha256,
          variants: variantsWithResolvedActiveMemoryFit,
          activeVariantId: resolvedFileName,
          chatModalities: hasVisionCapability ? ['text', 'vision'] : model.chatModalities,
          artifactRole: 'primary_chat_model',
          visionSource: projectorCandidates?.length ? 'tree_probe' : model.visionSource,
          visionConfidence: projectorCandidates?.length ? 'trusted' : model.visionConfidence,
          ...projectorMetadataPatch,
        });
      } catch (error) {
        if (error instanceof StaleCatalogAuthError) {
          throw error;
        }

        console.warn(`[ModelCatalogService] Failed to resolve tree metadata for ${model.id}`, error);
      }

      return model;
    };

    let results: ModelMetadata[] = [];
    let outcome: 'success' | 'error' = 'success';

    try {
      for (let index = 0; index < models.length; index += batchSize) {
        const batch = models.slice(index, index + batchSize);
        const batchResults = await Promise.all(batch.map(resolveModel));
        results.push(...batchResults.filter((model): model is ModelMetadata => model !== null));
      }

      return results;
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      span.end({ outcome, resolved: results.length });
    }
  }

  private async fetchCatalogBatch(
    normalizedQuery: string,
    minimumResults: number,
    memoryFitContext: CatalogMemoryFitContext,
    requestContext: CatalogRequestContext,
    initialCursor: string | null,
    sort: CatalogServerSort | null,
    gated: boolean | undefined,
    catalogAuthPolicy: RequestAuthPolicy = REQUEST_AUTH_POLICY.ANONYMOUS,
  ): Promise<CatalogBatchResult> {
    const catalogAuthToken = resolveRequestAuthToken(catalogAuthPolicy, requestContext.authToken);
    const hasAuthToken = Boolean(catalogAuthToken);
    const span = performanceMonitor.startSpan('catalog.fetchCatalogBatch', {
      query: normalizedQuery,
      minimumResults,
      hasAuthToken,
      sort: sort ?? undefined,
    });
    performanceMonitor.incrementCounter('catalog.fetchCatalogBatch.calls');

    let models: ModelMetadata[] = [];
    let nextCursor = initialCursor;
    let exhausted = false;
    const visitedCursors = new Set<string>();
    const resolvedPageSize = Math.max(1, Math.round(minimumResults));
    const requestLimit = this.resolveCatalogRequestLimit(resolvedPageSize);
    let pagesFetched = 0;
    let outcome: 'success' | 'error' = 'success';

    try {
      while (models.length < resolvedPageSize && !exhausted) {
        pagesFetched += 1;
        const requestedCursor = nextCursor;
        if (requestedCursor !== null) {
          visitedCursors.add(requestedCursor);
        }

        const page = await this.fetchHuggingFaceModels(
          normalizedQuery,
          requestLimit,
          requestContext,
          catalogAuthPolicy,
          requestedCursor,
          sort,
          gated,
        );
        const baseModels = transformHFResponse(page.items, memoryFitContext, requestContext.authToken);
        const hydratedModels = await this.resolveMissingModelMetadata(
          baseModels,
          memoryFitContext,
          requestContext,
          { treeProbeMode: 'bounded' },
        );
        // Merge with the local registry so downloaded entries don't disappear just because the
        // remote payload omitted some metadata or a tree lookup failed.
        const mergedHydratedModels = hydratedModels.map((model) => (
          this.mergeModelWithRegistry(model, memoryFitContext) ?? model
        ));
        models = this.mergeUniqueModelsById([...models, ...mergedHydratedModels]);
        nextCursor = this.resolveNextCatalogCursor(requestedCursor, page.nextCursor, visitedCursors);
        exhausted = nextCursor === null;

        if (page.items.length === 0) {
          exhausted = true;
        }
      }

      return this.createPaginatedCatalogBatchResult(
        normalizedQuery,
        models,
        nextCursor,
        resolvedPageSize,
        sort,
        hasAuthToken,
        gated,
      );
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      span.end({
        outcome,
        pagesFetched,
        models: models.length,
        hasMore: nextCursor !== null,
      });
    }
  }

  private resolveCatalogRequestLimit(pageSize: number): number {
    const resolvedPageSize = Math.max(1, Math.round(pageSize));
    const maxLimit = Math.max(CATALOG_PREFETCH_MAX_LIMIT, resolvedPageSize);
    const maxPages = Math.max(1, Math.floor(maxLimit / resolvedPageSize));
    const pagesToFetch = Math.min(CATALOG_PREFETCH_PAGES, maxPages);
    return resolvedPageSize * pagesToFetch;
  }

  private createPaginatedCatalogBatchResult(
    normalizedQuery: string,
    models: ModelMetadata[],
    nextCursor: string | null,
    pageSize: number,
    sort: CatalogServerSort | null,
    hasAuthToken: boolean,
    gated: boolean | undefined,
  ): CatalogBatchResult {
    if (models.length <= pageSize) {
      return {
        models,
        nextCursor,
      };
    }

    return {
      models: models.slice(0, pageSize),
      nextCursor: this.cacheBufferedCursorPages(
        normalizedQuery,
        models.slice(pageSize),
        nextCursor,
        pageSize,
        sort,
        hasAuthToken,
        gated,
      ),
    };
  }

  private cacheBufferedCursorPages(
    normalizedQuery: string,
    models: ModelMetadata[],
    finalNextCursor: string | null,
    pageSize: number,
    sort: CatalogServerSort | null,
    hasAuthToken: boolean,
    gated: boolean | undefined,
  ): string {
    const timestamp = Date.now();
    let nextCursor = finalNextCursor;

    for (let end = models.length; end > 0; end -= pageSize) {
      const start = Math.max(0, end - pageSize);
      const bufferedCursor = this.createBufferedCursorToken();
      this.searchCache.set(
        this.buildMemorySearchCacheKey(
          normalizedQuery,
          bufferedCursor,
          pageSize,
          sort,
          hasAuthToken,
          gated,
        ),
        {
          result: {
            models: models.slice(start, end),
            hasMore: nextCursor !== null,
            nextCursor,
          },
          timestamp,
          isBufferedCursor: true,
        },
      );
      nextCursor = bufferedCursor;
    }

    this.pruneSearchCache();
    return nextCursor ?? this.createBufferedCursorToken();
  }

  private createBufferedCursorToken(): string {
    this.bufferedCursorSequence += 1;
    return `catalog-buffer:${this.authCacheVersion}:${this.bufferedCursorSequence}`;
  }

  private async fetchHuggingFaceModels(
    normalizedQuery: string,
    limit: number,
    requestContext: CatalogRequestContext,
    authPolicy: RequestAuthPolicy,
    nextCursor: string | null = null,
    sort: CatalogServerSort | null = null,
    gated?: boolean,
  ): Promise<HuggingFaceModelsPage> {
    const cursorType = nextCursor ? 'cursor' : 'initial';
    const authToken = resolveRequestAuthToken(authPolicy, requestContext.authToken);
    const hasAuthToken = Boolean(authToken);
    const span = performanceMonitor.startSpan('catalog.fetchHuggingFaceModels', {
      query: normalizedQuery,
      limit,
      hasAuthToken,
      cursorType,
      cursorHash: nextCursor ? this.hashForTrace(nextCursor) : undefined,
      sort: sort ?? undefined,
    });
    performanceMonitor.incrementCounter('catalog.fetchHuggingFaceModels.calls');

    let status = 0;
    let itemsCount = 0;
    let outcome: 'success' | 'error' = 'success';

    const url = nextCursor ?? this.buildSearchUrl(normalizedQuery, limit, sort, gated);

    try {
      const response = await fetchWithTimeout(url, {
        headers: buildHeaders(authPolicy, authToken),
      });
      status = response.status;
      this.assertRequestContextIsCurrent(requestContext);

      if (!response.ok) {
        if (response.status === 429) {
          const authScope = this.getAuthScope(hasAuthToken);
          const now = Date.now();
          const resolvedRetryAfterMs = resolveRetryAfterMs(response);
          const baseRetryAfterMs = resolvedRetryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
          const previousBackoffMs = this.rateLimitBackoffMsByAuthScope[authScope] ?? 0;
          const clampedRetryAfterMs = this.clampRetryAfterMs(Math.max(baseRetryAfterMs, previousBackoffMs));
          const until = now + clampedRetryAfterMs;

          this.rateLimitBackoffMsByAuthScope[authScope] = this.clampRetryAfterMs(clampedRetryAfterMs * 2);
          this.rateLimitUntilByAuthScope[authScope] = Math.max(
            this.rateLimitUntilByAuthScope[authScope] ?? 0,
            until,
          );

          throw new ModelCatalogError(
            'rate_limited',
            `HF Search rate limited: ${response.status}`,
            { retryAfterMs: this.rateLimitUntilByAuthScope[authScope] - now },
          );
        }

        throw new ModelCatalogError('network', `HF Search failed: ${response.status}`);
      }

      this.rateLimitBackoffMsByAuthScope[this.getAuthScope(hasAuthToken)] = 0;
      const items = await response.json() as HuggingFaceModelSummary[];
      itemsCount = items.length;
      this.assertRequestContextIsCurrent(requestContext);

      return {
        items,
        nextCursor: this.resolveTrustedHuggingFaceApiCursor(parseNextCursor(
          typeof response.headers?.get === 'function'
            ? response.headers.get('link')
            : null,
        )),
      };
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      span.end({ outcome, status, items: itemsCount });
    }
  }

  private clampRetryAfterMs(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_RATE_LIMIT_BACKOFF_MS;
    }

    return Math.min(
      Math.max(1_000, Math.round(value)),
      MAX_RATE_LIMIT_BACKOFF_MS,
    );
  }

  private hashForTrace(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16);
  }

  private buildSearchUrl(
    normalizedQuery: string,
    limit: number,
    sort: CatalogServerSort | null,
    gated?: boolean,
  ): string {
    const params = [
      `search=${encodeURIComponent(normalizedQuery)}`,
      `limit=${limit}`,
      'full=true',
      'config=true',
    ];

    if (sort) {
      params.push(`sort=${sort}`);
      params.push('direction=-1');
    }

    if (typeof gated === 'boolean') {
      params.push(`gated=${gated ? 'true' : 'false'}`);
    }

    return `${HF_BASE_URL}/api/models?${params.join('&')}`;
  }

  private normalizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return 'gguf';
    return trimmed.toLowerCase().includes('gguf') ? trimmed : `${trimmed} gguf`;
  }

  private mergeWithRegistry(
    remoteModels: ModelMetadata[],
    authScope: CatalogCacheAuthScope = 'anon',
    memoryFitContext: CatalogMemoryFitContext | null = this.getRememberedMemoryFitContext(),
  ): ModelMetadata[] {
    const merged = remoteModels.map((model) => this.mergeModelWithRegistry(model, memoryFitContext) ?? model);
    this.upsertModelSnapshots(merged, authScope);
    const authScoped = merged.filter((model) => (
      model.accessState === ModelAccessState.AUTHORIZED
      || model.accessState === ModelAccessState.ACCESS_DENIED
    ));
    if (authScoped.length > 0) {
      this.upsertModelSnapshots(authScoped, 'auth');
    }
    return merged;
  }

  private mergeProjectorMetadataWithLocalState(
    remoteModel: ModelMetadata,
    localModel: ModelMetadata,
    shouldResetLocalDownloadState: boolean,
    preserveUnmatchedLocalProjectors = false,
  ): ProjectorMetadataMerge {
    const remoteCandidates = remoteModel.projectorCandidates;
    const localCandidates = localModel.projectorCandidates ?? [];

    if (shouldResetLocalDownloadState) {
      const remoteCandidateIds = new Set((remoteCandidates ?? []).map((projector) => projector.id));
      const selectedProjectorId = this.resolveMergedSelectedProjectorId(
        remoteModel.selectedProjectorId,
        undefined,
        remoteCandidateIds,
        new Map(),
      );

      return {
        projectorCandidates: remoteCandidates,
        selectedProjectorId,
        multimodalReadiness: this.resolveMergedMultimodalReadiness(
          remoteModel.id,
          remoteModel.multimodalReadiness,
          undefined,
          remoteCandidateIds,
          new Map(),
          selectedProjectorId,
        ),
      };
    }

    if (!remoteCandidates) {
      const runtimeVariantId = this.resolveProjectorRuntimeVariantId(remoteModel, localModel);
      const blockedLocalProjectorIds = new Set<string>();
      const compatibleLocalCandidates = localCandidates.filter((localProjector) => {
        const canPreserveLocalProjector = this.projectorAppliesToRuntimeVariant(
          localProjector,
          runtimeVariantId,
        );
        if (!canPreserveLocalProjector) {
          blockedLocalProjectorIds.add(localProjector.id);
        }

        return canPreserveLocalProjector;
      });
      const localCandidateIds = new Set(compatibleLocalCandidates.map((projector) => projector.id));
      const selectedProjectorId = this.resolveMergedSelectedProjectorId(
        remoteModel.selectedProjectorId,
        localModel.selectedProjectorId,
        localCandidateIds,
        new Map(),
        blockedLocalProjectorIds,
        new Set(),
      );

      return {
        projectorCandidates: compatibleLocalCandidates.length > 0 ? compatibleLocalCandidates : remoteCandidates,
        selectedProjectorId,
        multimodalReadiness: this.resolveMergedMultimodalReadiness(
          remoteModel.id,
          remoteModel.multimodalReadiness,
          localModel.multimodalReadiness,
          localCandidateIds,
          new Map(),
          selectedProjectorId,
          new Set(),
          blockedLocalProjectorIds,
        ),
      };
    }

    const usedLocalProjectorIds = new Set<string>();
    const localToRemoteProjectorIds = new Map<string, string>();
    const incompatibleLocalReadinessProjectorIds = new Set<string>();
    const incompatibleRemoteReadinessProjectorIds = new Set<string>();
    const blockedLocalProjectorIds = new Set<string>();
    const blockedRemoteProjectorIds = new Set<string>();
    const runtimeVariantId = this.resolveProjectorRuntimeVariantId(remoteModel, localModel);
    const mergedCandidates = remoteCandidates.map((remoteProjector) => {
      const exactLocalProjector = localCandidates.find((localProjector) => (
        !usedLocalProjectorIds.has(localProjector.id)
        && localProjector.id === remoteProjector.id
      ));
      if (
        exactLocalProjector
        && !this.projectorsShareStableArtifact(remoteProjector, exactLocalProjector, runtimeVariantId)
      ) {
        blockedLocalProjectorIds.add(exactLocalProjector.id);
        blockedRemoteProjectorIds.add(remoteProjector.id);
      }

      const localProjector = this.findLocalProjectorForRemote(
        remoteProjector,
        localCandidates,
        usedLocalProjectorIds,
        runtimeVariantId,
      );

      if (!localProjector) {
        return remoteProjector;
      }

      usedLocalProjectorIds.add(localProjector.id);
      localToRemoteProjectorIds.set(localProjector.id, remoteProjector.id);

      if (!this.projectorsHaveCompatibleRuntimeMetadata(remoteProjector, localProjector)) {
        incompatibleLocalReadinessProjectorIds.add(localProjector.id);
        incompatibleRemoteReadinessProjectorIds.add(remoteProjector.id);
      }

      return this.mergeProjectorRuntimeState(remoteProjector, localProjector);
    });
    if (preserveUnmatchedLocalProjectors) {
      for (const localProjector of localCandidates) {
        if (
          usedLocalProjectorIds.has(localProjector.id)
          || blockedLocalProjectorIds.has(localProjector.id)
          || mergedCandidates.some((candidate) => candidate.id === localProjector.id)
        ) {
          continue;
        }

        if (!this.projectorAppliesToRuntimeVariant(localProjector, runtimeVariantId)) {
          blockedLocalProjectorIds.add(localProjector.id);
          continue;
        }

        mergedCandidates.push(localProjector);
      }
    }
    const mergedCandidateIds = new Set(mergedCandidates.map((projector) => projector.id));
    const selectedProjectorId = this.resolveMergedSelectedProjectorId(
      remoteModel.selectedProjectorId,
      localModel.selectedProjectorId,
      mergedCandidateIds,
      localToRemoteProjectorIds,
      blockedLocalProjectorIds,
      blockedRemoteProjectorIds,
    );
    const blockedRemoteReadinessProjectorIds = new Set([
      ...incompatibleRemoteReadinessProjectorIds,
      ...blockedRemoteProjectorIds,
    ]);
    const blockedLocalReadinessProjectorIds = new Set([
      ...incompatibleLocalReadinessProjectorIds,
      ...blockedLocalProjectorIds,
    ]);
    const blockedLocalResolvedReadinessProjectorIds = new Set([
      ...incompatibleRemoteReadinessProjectorIds,
    ]);
    const shouldSuppressLocalReadinessFallback = (
      typeof remoteModel.selectedProjectorId === 'string'
      && blockedRemoteProjectorIds.has(remoteModel.selectedProjectorId)
      && selectedProjectorId === undefined
    );

    return {
      projectorCandidates: mergedCandidates,
      selectedProjectorId,
      multimodalReadiness: this.resolveMergedMultimodalReadiness(
        remoteModel.id,
        remoteModel.multimodalReadiness,
        localModel.multimodalReadiness,
        mergedCandidateIds,
        localToRemoteProjectorIds,
        selectedProjectorId,
        blockedRemoteReadinessProjectorIds,
        blockedLocalReadinessProjectorIds,
        blockedLocalResolvedReadinessProjectorIds,
        shouldSuppressLocalReadinessFallback,
      ),
    };
  }

  private findLocalProjectorForRemote(
    remoteProjector: ProjectorArtifact,
    localProjectors: ProjectorArtifact[],
    usedLocalProjectorIds: Set<string>,
    runtimeVariantId?: string,
  ): ProjectorArtifact | undefined {
    const exactMatch = localProjectors.find((localProjector) => (
      !usedLocalProjectorIds.has(localProjector.id)
      && localProjector.id === remoteProjector.id
      && this.projectorsShareStableArtifact(remoteProjector, localProjector, runtimeVariantId)
    ));
    if (exactMatch) {
      return exactMatch;
    }

    return localProjectors.find((localProjector) => (
      !usedLocalProjectorIds.has(localProjector.id)
      && this.projectorsShareStableArtifact(remoteProjector, localProjector, runtimeVariantId)
    ));
  }

  private resolveProjectorRuntimeVariantId(
    remoteModel: ModelMetadata,
    localModel: ModelMetadata,
  ): string | undefined {
    return remoteModel.activeVariantId
      ?? remoteModel.resolvedFileName
      ?? localModel.activeVariantId
      ?? localModel.resolvedFileName;
  }

  private normalizeProjectorVariantId(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private projectorAppliesToRuntimeVariant(
    projector: ProjectorArtifact,
    runtimeVariantId: string | undefined,
  ): boolean {
    const projectorVariantId = this.normalizeProjectorVariantId(projector.ownerVariantId);
    const activeVariantId = this.normalizeProjectorVariantId(runtimeVariantId);
    return !projectorVariantId || !activeVariantId || projectorVariantId === activeVariantId;
  }

  private projectorsShareRuntimeVariantScope(
    remoteProjector: ProjectorArtifact,
    localProjector: ProjectorArtifact,
    runtimeVariantId: string | undefined,
  ): boolean {
    const remoteVariantId = this.normalizeProjectorVariantId(remoteProjector.ownerVariantId);
    const localVariantId = this.normalizeProjectorVariantId(localProjector.ownerVariantId);
    if (remoteVariantId === localVariantId) {
      return true;
    }

    if (remoteVariantId && localVariantId) {
      return false;
    }

    const scopedVariantId = remoteVariantId ?? localVariantId;
    return Boolean(
      scopedVariantId
      && this.normalizeProjectorVariantId(runtimeVariantId) === scopedVariantId,
    );
  }

  private projectorsShareStableArtifact(
    remoteProjector: ProjectorArtifact,
    localProjector: ProjectorArtifact,
    runtimeVariantId?: string,
  ): boolean {
    if (
      remoteProjector.ownerModelId !== localProjector.ownerModelId
      || remoteProjector.repoId !== localProjector.repoId
      || remoteProjector.fileName !== localProjector.fileName
      || (remoteProjector.hfRevision ?? 'main') !== (localProjector.hfRevision ?? 'main')
    ) {
      return false;
    }

    return this.projectorsShareRuntimeVariantScope(remoteProjector, localProjector, runtimeVariantId);
  }

  private projectorsHaveCompatibleRuntimeMetadata(
    remoteProjector: ProjectorArtifact,
    localProjector: ProjectorArtifact,
  ): boolean {
    if (this.projectorComparableValuesConflict(
      normalizeSha256Digest(remoteProjector.sha256),
      normalizeSha256Digest(localProjector.sha256),
    )) {
      return false;
    }

    if (this.projectorComparableValuesConflict(
      this.normalizeComparableProjectorSize(remoteProjector.size),
      this.normalizeComparableProjectorSize(localProjector.size),
    )) {
      return false;
    }

    return !this.projectorComparableValuesConflict(
      this.normalizeComparableProjectorDownloadUrl(remoteProjector.downloadUrl),
      this.normalizeComparableProjectorDownloadUrl(localProjector.downloadUrl),
    );
  }

  private projectorComparableValuesConflict<T>(
    remoteValue: T | undefined,
    localValue: T | undefined,
  ): boolean {
    return remoteValue !== undefined && localValue !== undefined && remoteValue !== localValue;
  }

  private normalizeComparableProjectorSize(size: number | null | undefined): number | undefined {
    return typeof size === 'number' && Number.isFinite(size) && size >= 0
      ? Math.round(size)
      : undefined;
  }

  private normalizeComparableProjectorDownloadUrl(
    downloadUrl: string | undefined,
  ): string | undefined {
    if (typeof downloadUrl !== 'string') {
      return undefined;
    }

    const trimmed = downloadUrl.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = new URL(trimmed);
      parsed.hash = '';
      parsed.protocol = parsed.protocol.toLowerCase();
      parsed.hostname = parsed.hostname.toLowerCase();
      return parsed.toString();
    } catch {
      return trimmed;
    }
  }

  private mergeProjectorRuntimeState(
    remoteProjector: ProjectorArtifact,
    localProjector: ProjectorArtifact,
  ): ProjectorArtifact {
    const hasLocalRuntimeState = (
      typeof localProjector.localPath === 'string'
      || typeof localProjector.resumeData === 'string'
      || typeof localProjector.downloadProgress === 'number'
      || localProjector.lifecycleStatus !== 'available'
      || localProjector.matchStatus !== remoteProjector.matchStatus
      || localProjector.matchReason !== remoteProjector.matchReason
    );

    if (
      !hasLocalRuntimeState
      || !this.projectorsHaveCompatibleRuntimeMetadata(remoteProjector, localProjector)
    ) {
      return remoteProjector;
    }

    const mergedProjector = mergeCompatibleProjectorRuntimeState(remoteProjector, localProjector);

    return {
      ...mergedProjector,
      downloadProgress: localProjector.downloadProgress ?? mergedProjector.downloadProgress,
    };
  }

  private resolveMergedSelectedProjectorId(
    remoteSelectedProjectorId: string | undefined,
    localSelectedProjectorId: string | undefined,
    candidateIds: Set<string>,
    localToRemoteProjectorIds: Map<string, string>,
    blockedLocalProjectorIds: Set<string> = new Set(),
    blockedRemoteProjectorIds: Set<string> = blockedLocalProjectorIds,
  ): string | undefined {
    const blockedRemoteSelectedProjectorId = remoteSelectedProjectorId
      && candidateIds.has(remoteSelectedProjectorId)
      && blockedRemoteProjectorIds.has(remoteSelectedProjectorId)
      ? remoteSelectedProjectorId
      : undefined;

    if (remoteSelectedProjectorId && candidateIds.has(remoteSelectedProjectorId)) {
      if (candidateIds.has(remoteSelectedProjectorId) && !blockedRemoteSelectedProjectorId) {
        return remoteSelectedProjectorId;
      }

      if (!localSelectedProjectorId || blockedLocalProjectorIds.has(localSelectedProjectorId)) {
        return undefined;
      }

      const selectedProjectorId = localToRemoteProjectorIds.get(localSelectedProjectorId)
        ?? localSelectedProjectorId;

      if (blockedRemoteSelectedProjectorId) {
        return selectedProjectorId === blockedRemoteSelectedProjectorId
          && localSelectedProjectorId !== selectedProjectorId
          && candidateIds.has(selectedProjectorId)
          ? selectedProjectorId
          : undefined;
      }

      return selectedProjectorId === remoteSelectedProjectorId && candidateIds.has(selectedProjectorId)
        ? selectedProjectorId
        : undefined;
    }

    if (!localSelectedProjectorId) {
      return undefined;
    }

    if (blockedLocalProjectorIds.has(localSelectedProjectorId)) {
      return undefined;
    }

    const selectedProjectorId = localToRemoteProjectorIds.get(localSelectedProjectorId)
      ?? localSelectedProjectorId;

    return candidateIds.has(selectedProjectorId) ? selectedProjectorId : undefined;
  }

  private resolveMergedMultimodalReadiness(
    modelId: string,
    remoteReadiness: MultimodalReadinessState | undefined,
    localReadiness: MultimodalReadinessState | undefined,
    candidateIds: Set<string>,
    localToRemoteProjectorIds: Map<string, string>,
    selectedProjectorId?: string,
    blockedRemoteReadinessProjectorIds: Set<string> = new Set(),
    blockedLocalReadinessProjectorIds: Set<string> = blockedRemoteReadinessProjectorIds,
    blockedLocalResolvedReadinessProjectorIds: Set<string> = blockedLocalReadinessProjectorIds,
    suppressLocalReadinessFallback = false,
  ): MultimodalReadinessState | undefined {
    const remoteMergedReadiness = this.remapMultimodalReadiness(
      modelId,
      remoteReadiness,
      candidateIds,
      localToRemoteProjectorIds,
      selectedProjectorId,
      blockedRemoteReadinessProjectorIds,
      blockedRemoteReadinessProjectorIds,
    );

    if (remoteMergedReadiness || suppressLocalReadinessFallback) {
      return remoteMergedReadiness;
    }

    return this.remapMultimodalReadiness(
      modelId,
      localReadiness,
      candidateIds,
      localToRemoteProjectorIds,
      selectedProjectorId,
      blockedLocalReadinessProjectorIds,
      blockedLocalResolvedReadinessProjectorIds,
    );
  }

  private remapMultimodalReadiness(
    modelId: string,
    readiness: MultimodalReadinessState | undefined,
    candidateIds: Set<string>,
    localToRemoteProjectorIds: Map<string, string>,
    selectedProjectorId?: string,
    blockedSourceProjectorIds: Set<string> = new Set(),
    blockedResolvedProjectorIds: Set<string> = blockedSourceProjectorIds,
  ): MultimodalReadinessState | undefined {
    if (!readiness || readiness.modelId !== modelId) {
      return undefined;
    }

    if (!readiness.projectorId) {
      return readiness;
    }

    if (blockedSourceProjectorIds.has(readiness.projectorId)) {
      return undefined;
    }

    const projectorId = localToRemoteProjectorIds.get(readiness.projectorId)
      ?? readiness.projectorId;

    if (blockedResolvedProjectorIds.has(projectorId)) {
      return undefined;
    }

    if (!candidateIds.has(projectorId)) {
      return undefined;
    }

    if (selectedProjectorId && projectorId !== selectedProjectorId) {
      return undefined;
    }

    return projectorId === readiness.projectorId
      ? readiness
      : { ...readiness, projectorId };
  }

  private mergeModelWithRegistry(
    remoteModel?: ModelMetadata,
    memoryFitContext: CatalogMemoryFitContext | null = this.getRememberedMemoryFitContext(),
  ): ModelMetadata | undefined {
    if (!remoteModel) {
      return undefined;
    }

    const localModel = registry.getModel(remoteModel.id);
    remoteModel = this.sanitizeCachedCatalogModelResolvedFile(remoteModel, localModel);
    if (!localModel) {
      // Search results and model snapshots are cached in memory (and persisted), but the local
      // registry is not. When a user offloads/deletes a model, cached results can still contain
      // stale "downloaded" runtime fields (localPath, lifecycleStatus, progress).
      // Clear these fields when the registry entry is missing so UI reflects the deletion without
      // requiring a forced network refresh.
      const needsRuntimeReset = (
        remoteModel.lifecycleStatus !== LifecycleStatus.AVAILABLE
        || typeof remoteModel.localPath === 'string'
        || typeof remoteModel.downloadedAt === 'number'
        || typeof remoteModel.downloadIntegrity === 'object'
        || remoteModel.downloadProgress > 0
        || typeof remoteModel.resumeData === 'string'
        || typeof remoteModel.downloadErrorAt === 'number'
        || typeof remoteModel.downloadErrorCode === 'string'
        || typeof remoteModel.downloadErrorMessage === 'string'
        || typeof remoteModel.selectedProjectorId === 'string'
        || remoteModel.multimodalReadiness !== undefined
        || (remoteModel.projectorCandidates?.some((projector) => (
          typeof projector.localPath === 'string'
          || projector.lifecycleStatus !== 'available'
          || projector.matchStatus === 'failed'
          || projector.matchStatus === 'user_selected'
        )) ?? false)
      );

      const sanitized = needsRuntimeReset
        ? sanitizeCatalogModelRuntimeState(remoteModel)
        : remoteModel;

      return this.withResolvedMemoryFit(sanitized, memoryFitContext);
    }

    remoteModel = applyModelVariantSelectionIfAvailable(remoteModel, localModel, {
      // Catalog merges must remain conservative: if a fresh catalog payload selects a
      // same-size different file and the previous local record has no explicit
      // variant id, keep the remote identity so compatibility checks can clear stale
      // downloaded state. Exact catalog variant matches with distinct identity can
      // still preserve legacy downloaded non-default variants.
      allowResolvedFileNameFallback: false,
    });

    const {
      remoteSha256,
      localVerifiedSha256,
      canUseLocalVerifiedMetadata,
      canPreserveDownloadIntegrity,
      shouldResetLocalDownloadState,
    } = resolveVerifiedLocalShaCompatibility(localModel, {
      sha256: remoteModel.sha256,
      resolvedFileName: remoteModel.resolvedFileName,
      size: remoteModel.size,
    });
    const localHasVerifiedSize = canUseLocalVerifiedMetadata;
    const allowLocalVerifiedDerivedMetadata = !shouldResetLocalDownloadState
      && (localHasVerifiedSize || localModel.metadataTrust !== 'verified_local');
    const localDownloadStatePatch = getCompatibleLocalDownloadStatePatch(localModel, {
      shouldResetLocalDownloadState,
      canPreserveDownloadIntegrity,
    });
    const {
      maxContextTokens,
      hasVerifiedContextWindow,
    } = this.resolveMergedContextWindowMetadata(remoteModel, localModel, allowLocalVerifiedDerivedMetadata);
    const resolvedSize = localHasVerifiedSize
      ? localModel.size ?? remoteModel.size
      : remoteModel.size ?? (allowLocalVerifiedDerivedMetadata ? localModel.size : null);
    const fallbackLocalMetadataTrust = localModel.metadataTrust === 'verified_local'
      ? undefined
      : localModel.metadataTrust;
    const metadataTrust = localHasVerifiedSize
      ? localModel.metadataTrust
      : remoteModel.metadataTrust ?? fallbackLocalMetadataTrust;
    const gguf = remoteModel.gguf || (allowLocalVerifiedDerivedMetadata ? localModel.gguf : undefined)
      ? localHasVerifiedSize
        ? {
          ...(remoteModel.gguf ?? {}),
          ...(localModel.gguf ?? {}),
        }
        : {
          ...(allowLocalVerifiedDerivedMetadata ? (localModel.gguf ?? {}) : {}),
          ...(remoteModel.gguf ?? {}),
        }
      : undefined;
    const remoteHasVisionEvidence = remoteModel.chatModalities?.includes('vision') === true
      || Boolean(remoteModel.projectorCandidates?.length)
      || remoteModel.visionSource !== undefined;
    const shouldPreserveLocalVisionMetadata = !shouldResetLocalDownloadState
      && !remoteHasVisionEvidence
      && localModel.chatModalities?.includes('vision') === true;
    const canUseLocalVisionFallback = !shouldResetLocalDownloadState;
    const chatModalities = shouldPreserveLocalVisionMetadata
      ? localModel.chatModalities
      : remoteModel.chatModalities ?? (canUseLocalVisionFallback ? localModel.chatModalities : undefined);
    const artifactRole = shouldPreserveLocalVisionMetadata
      ? localModel.artifactRole ?? remoteModel.artifactRole
      : remoteModel.artifactRole ?? (canUseLocalVisionFallback ? localModel.artifactRole : undefined);
    const visionSource = shouldPreserveLocalVisionMetadata
      ? localModel.visionSource ?? remoteModel.visionSource
      : remoteModel.visionSource ?? (canUseLocalVisionFallback ? localModel.visionSource : undefined);
    const visionConfidence = shouldPreserveLocalVisionMetadata
      ? localModel.visionConfidence ?? remoteModel.visionConfidence
      : remoteModel.visionConfidence ?? (canUseLocalVisionFallback ? localModel.visionConfidence : undefined);
    const projectorMetadataPatch = this.mergeProjectorMetadataWithLocalState(
      remoteModel,
      localModel,
      shouldResetLocalDownloadState,
    );
    const resolvedMemoryFit = resolveMemoryFitSummary({ size: resolvedSize, metadataTrust, gguf }, memoryFitContext, {
      projectorSizeBytes: this.resolveActiveVariantProjectorMemoryFitSizeBytes({
        ...remoteModel,
        resolvedFileName: remoteModel.resolvedFileName ?? localModel.resolvedFileName,
        projectorCandidates: projectorMetadataPatch.projectorCandidates,
        selectedProjectorId: projectorMetadataPatch.selectedProjectorId,
      }),
    });
    const fitsInRam = resolvedMemoryFit?.fitsInRam
      ?? remoteModel.fitsInRam
      ?? (allowLocalVerifiedDerivedMetadata ? localModel.fitsInRam : null);
    const memoryFitDecision = resolvedMemoryFit?.decision
      ?? remoteModel.memoryFitDecision
      ?? (allowLocalVerifiedDerivedMetadata ? localModel.memoryFitDecision : undefined);
    const memoryFitConfidence = resolvedMemoryFit?.confidence
      ?? remoteModel.memoryFitConfidence
      ?? (allowLocalVerifiedDerivedMetadata ? localModel.memoryFitConfidence : undefined);
    const variants = this.withActiveVariantResolvedMemoryFit(
      remoteModel.variants,
      remoteModel.activeVariantId ?? remoteModel.resolvedFileName,
      resolvedMemoryFit,
    );

    return normalizePersistedModelMetadata({
      ...remoteModel,
      ...localDownloadStatePatch,
      size: resolvedSize,
      hfRevision: remoteModel.hfRevision ?? localModel.hfRevision,
      resolvedFileName: remoteModel.resolvedFileName ?? localModel.resolvedFileName,
      localPath: shouldResetLocalDownloadState ? undefined : localModel.localPath,
      downloadedAt: shouldResetLocalDownloadState ? undefined : localModel.downloadedAt,
      lastModifiedAt: remoteModel.lastModifiedAt ?? localModel.lastModifiedAt,
      sha256: remoteSha256 ?? (localHasVerifiedSize ? localVerifiedSha256 : undefined),
      downloadIntegrity: canPreserveDownloadIntegrity ? localModel.downloadIntegrity : undefined,
      metadataTrust,
      gguf,
      fitsInRam,
      memoryFitDecision,
      memoryFitConfidence,
      variants,
      accessState: remoteModel.accessState,
      isGated: remoteModel.isGated,
      isPrivate: remoteModel.isPrivate,
      lifecycleStatus: shouldResetLocalDownloadState ? LifecycleStatus.AVAILABLE : localModel.lifecycleStatus,
      downloadProgress: shouldResetLocalDownloadState ? 0 : localModel.downloadProgress,
      resumeData: shouldResetLocalDownloadState ? undefined : localModel.resumeData,
      downloadErrorAt: shouldResetLocalDownloadState ? undefined : localModel.downloadErrorAt,
      downloadErrorCode: shouldResetLocalDownloadState ? undefined : localModel.downloadErrorCode,
      downloadErrorMessage: shouldResetLocalDownloadState ? undefined : localModel.downloadErrorMessage,
      maxContextTokens,
      hasVerifiedContextWindow,
      parameterSizeLabel: remoteModel.parameterSizeLabel ?? localModel.parameterSizeLabel,
      modelType: remoteModel.modelType ?? localModel.modelType,
      architectures: remoteModel.architectures ?? localModel.architectures,
      baseModels: remoteModel.baseModels ?? localModel.baseModels,
      license: remoteModel.license ?? localModel.license,
      languages: remoteModel.languages ?? localModel.languages,
      datasets: remoteModel.datasets ?? localModel.datasets,
      quantizedBy: remoteModel.quantizedBy ?? localModel.quantizedBy,
      modelCreator: remoteModel.modelCreator ?? localModel.modelCreator,
      downloads: remoteModel.downloads ?? localModel.downloads ?? null,
      likes: remoteModel.likes ?? localModel.likes ?? null,
      tags: remoteModel.tags ?? localModel.tags,
      description: remoteModel.description ?? localModel.description,
      chatModalities,
      artifactRole,
      visionSource,
      visionConfidence,
      ...projectorMetadataPatch,
    });
  }

  private resolveMergedContextWindowMetadata(
    remoteModel: ModelMetadata,
    localModel: ModelMetadata,
    allowLocalVerifiedContextWindow: boolean,
  ): Pick<ModelMetadata, 'maxContextTokens' | 'hasVerifiedContextWindow'> {
    const remoteHasVerifiedContextWindow = remoteModel.hasVerifiedContextWindow === true;
    const localHasVerifiedContextWindow = allowLocalVerifiedContextWindow && localModel.hasVerifiedContextWindow === true;

    if (remoteHasVerifiedContextWindow) {
      return {
        maxContextTokens: remoteModel.maxContextTokens ?? localModel.maxContextTokens,
        hasVerifiedContextWindow: true,
      };
    }

    if (localHasVerifiedContextWindow) {
      return {
        maxContextTokens: localModel.maxContextTokens ?? remoteModel.maxContextTokens,
        hasVerifiedContextWindow: true,
      };
    }

    return {
      maxContextTokens: resolveMergedMaxContextTokens(
        remoteModel.maxContextTokens,
        allowLocalVerifiedContextWindow ? localModel.maxContextTokens : undefined,
      ),
      hasVerifiedContextWindow: false,
    };
  }

  private syncRegistryModelIfPresent(model: ModelMetadata): ModelMetadata {
    const mergedModel = this.mergeModelWithRegistry(model) ?? model;
    if (registry.getModel(model.id)) {
      registry.updateModel(mergedModel);
    }

    return mergedModel;
  }

  private cacheModelSnapshotsInMemory(
    models: ModelMetadata[],
    authScope: CatalogCacheAuthScope,
  ) {
    const scopedModels = authScope === 'anon'
      ? models.flatMap((model) => {
        const sanitized = this.sanitizeAnonymousSnapshotModel(model);
        return sanitized ? [sanitized] : [];
      })
      : models;
    const normalizedModels = scopedModels.map((model) => (
      this.limitSnapshotModelVariants(normalizePersistedModelMetadata(model))
    ));
    normalizedModels.forEach((model) => {
      this.setModelSnapshotInMemory(this.buildModelSnapshotCacheKey(model.id, authScope), model);
    });
    this.pruneModelSnapshotCache();
  }

  private upsertModelSnapshots(
    models: ModelMetadata[],
    authScope: CatalogCacheAuthScope = 'anon',
  ) {
    const modelIdsToDelete: string[] = [];
    const sanitizedModels = authScope === 'anon'
      ? models.flatMap((model) => {
        const sanitized = this.sanitizeAnonymousSnapshotModel(model);
        if (!sanitized) {
          modelIdsToDelete.push(model.id);
          return [];
        }

        return [sanitized];
      })
      : models;

    if (modelIdsToDelete.length > 0) {
      modelIdsToDelete.forEach((modelId) => {
        this.modelSnapshotCache.delete(this.buildModelSnapshotCacheKey(modelId, authScope));
      });
      this.persistentCache.deleteModelSnapshots(modelIdsToDelete, authScope);
    }

    const normalizedModels = sanitizedModels.map((model) => (
      this.limitSnapshotModelVariants(normalizePersistedModelMetadata(model))
    ));
    if (normalizedModels.length === 0) {
      return;
    }

    this.cacheModelSnapshotsInMemory(normalizedModels, authScope);
    this.persistentCache.putModelSnapshots(normalizedModels, authScope);
  }

  private reconcileAnonymousModelVisibility(models: ModelMetadata[]): void {
    if (models.length === 0) {
      return;
    }

    this.upsertModelSnapshots(models, 'anon');
    this.reconcileAnonymousSearchCacheEntries(models);
    this.persistentCache.reconcileAnonymousSearchModels(models);
  }

  private reconcileAnonymousSearchCacheEntries(models: ModelMetadata[]): void {
    const replacements = new Map<string, ModelMetadata | null>();
    models.forEach((model) => {
      replacements.set(model.id, this.sanitizeAnonymousSnapshotModel(model));
    });

    if (replacements.size === 0) {
      return;
    }

    for (const [key, entry] of this.searchCache.entries()) {
      if (!key.includes('::anon::')) {
        continue;
      }

      let didChange = false;
      const modelsForEntry = entry.result.models.flatMap((model) => {
        if (!replacements.has(model.id)) {
          return [model];
        }

        didChange = true;
        const replacement = replacements.get(model.id) ?? null;
        return replacement ? [this.toSearchResultModel(replacement)] : [];
      });

      if (didChange) {
        this.searchCache.set(key, {
          ...entry,
          result: {
            ...entry.result,
            models: modelsForEntry,
          },
        });
      }
    }
  }

  private limitSnapshotModelVariants(model: ModelMetadata): ModelMetadata {
    const variants = limitModelVariants(model.variants, {
      limit: CATALOG_SEARCH_VARIANT_LIMIT,
      includeFileNames: [model.resolvedFileName, model.activeVariantId],
      includeVariantIds: [model.activeVariantId],
    });

    if (variants === model.variants) {
      return model;
    }

    return normalizePersistedModelMetadata({
      ...model,
      variants,
    });
  }

  private sanitizeAnonymousSnapshotModel(model: ModelMetadata): ModelMetadata | null {
    return sanitizeAnonymousCatalogModel(model);
  }

  private async fetchHuggingFaceModelTree(
    repoId: string,
    revision: string | undefined,
    requestContext: CatalogRequestContext,
    authPolicy: RequestAuthPolicy,
    options?: FetchModelTreeOptions,
  ): Promise<HuggingFaceTreeResponse> {
    const expectedFileName = typeof options?.expectedFileName === 'string'
      ? options.expectedFileName.trim()
      : '';
    const allowTargetEarlyStop = options?.allowTargetEarlyStop !== false;
    const maxPages = typeof options?.maxPages === 'number' && Number.isFinite(options.maxPages)
      ? Math.max(1, Math.round(options.maxPages))
      : HF_TREE_PAGINATION_MAX_PAGES;
    const expectedFileNameCacheSegment = expectedFileName.length > 0
      ? `target:${encodeURIComponent(expectedFileName)}`
      : 'target:__none__';
    const targetEarlyStopCacheSegment = allowTargetEarlyStop ? 'target-stop:early' : 'target-stop:full';
    const treeCacheSegment = `${expectedFileNameCacheSegment}:${targetEarlyStopCacheSegment}:max-pages:${maxPages}`;

    return this.withInFlightDedup(
      this.treeRequestCache,
      this.buildRequestCacheKey(
        'tree',
        repoId,
        revision,
        requestContext,
        authPolicy,
        treeCacheSegment,
      ),
      async () => {
        const span = performanceMonitor.startSpan('catalog.fetchHuggingFaceModelTree', {
          repoId,
          revision: revision ?? 'main',
          hasAuthToken: this.resolveRequestAuthScope(authPolicy, requestContext.authToken) === 'auth',
        });
        performanceMonitor.incrementCounter('catalog.fetchHuggingFaceModelTree.calls');

        let expectedTargetKnownIneligible = expectedFileName.length > 0 && (
          isProjectorFileName(expectedFileName)
          || isUnsupportedMtpFileName(expectedFileName)
        );
        let nextCursor: string | null = buildHuggingFaceTreeUrl(repoId, revision);
        const visitedCursors = new Set<string>();
        const entries: HuggingFaceTreeEntry[] = [];
        let status = 200;
        let isComplete = true;
        let pageCount = 0;
        let outcome: 'success' | 'error' = 'success';
        let stopReason: HuggingFaceTreeStopReason = 'complete';
        let firstEligibleGgufPage: number | null = null;

        try {
          while (nextCursor !== null) {
            if (pageCount >= maxPages) {
              isComplete = false;
              stopReason = 'max_pages';
              break;
            }

            pageCount += 1;
            const requestedCursor = nextCursor;
            visitedCursors.add(requestedCursor);

            const response = await fetchWithTimeout(requestedCursor, {
              headers: buildHeaders(authPolicy, requestContext.authToken),
            });
            status = response.status;
            this.assertRequestContextIsCurrent(requestContext);

            if (!response.ok) {
              if (
                entries.length === 0
                && (response.status === 401 || response.status === 403)
                && authPolicy === REQUEST_AUTH_POLICY.ANONYMOUS
                && requestContext.hasAuthToken
              ) {
                // Retry once with an auth token only when the repo proves it needs it.
                return this.fetchHuggingFaceModelTree(
                  repoId,
                  revision,
                  requestContext,
                  REQUEST_AUTH_POLICY.REQUIRED_AUTH,
                  options,
                );
              }

              if (entries.length > 0) {
                if (process.env.NODE_ENV !== 'test') {
                  console.warn(
                    `[ModelCatalogService] Tree pagination stopped early for ${repoId}: ${response.status}`,
                  );
                }
                isComplete = false;
                stopReason = 'http_error';
                break;
              }

              return {
                entries: [],
                status: response.status,
                isComplete: false,
                stopReason: 'http_error',
              };
            }

            const pageEntries = await response.json() as HuggingFaceTreeEntry[];
            entries.push(...pageEntries);
            this.assertRequestContextIsCurrent(requestContext);

            const parsedNextCursor = parseNextCursor(
              typeof response.headers?.get === 'function'
                ? response.headers.get('link')
                : null,
            );
            const resolvedNextCursor = this.resolveNextCatalogCursor(
              requestedCursor,
              parsedNextCursor,
              visitedCursors,
            );

            if (parsedNextCursor && !resolvedNextCursor && !this.isTrustedHuggingFaceApiCursor(parsedNextCursor)) {
              isComplete = false;
              stopReason = 'invalid_cursor';
              break;
            }

            const targetMatch = expectedFileName.length > 0 && !expectedTargetKnownIneligible
              ? pageEntries.find((entry) => getFileName(entry) === expectedFileName)
              : undefined;
            if (targetMatch) {
              if (isEligibleGgufEntry(targetMatch)) {
                if (allowTargetEarlyStop) {
                  isComplete = resolvedNextCursor === null;
                  stopReason = 'target_found';
                  break;
                }
              } else {
                expectedTargetKnownIneligible = true;
              }
            }

            const canUseFallbackStop = allowTargetEarlyStop && (
              expectedFileName.length === 0 || expectedTargetKnownIneligible
            );

            if (canUseFallbackStop && firstEligibleGgufPage === null) {
              const firstGguf = pageEntries.find((entry) => isEligibleGgufEntry(entry));
              if (firstGguf) {
                firstEligibleGgufPage = pageCount;
              }
            }

            if (canUseFallbackStop) {
              const preferred = pageEntries.find((entry) => (
                isEligibleGgufEntry(entry) && isPreferredQuantFileName(getFileName(entry))
              ));
              if (preferred) {
                isComplete = resolvedNextCursor === null;
                stopReason = 'preferred_found';
                break;
              }

              if (
                firstEligibleGgufPage !== null
                && pageCount - firstEligibleGgufPage >= HF_TREE_PREFERRED_LOOKAHEAD_PAGES
              ) {
                isComplete = resolvedNextCursor === null;
                stopReason = 'lookahead';
                break;
              }
            }

            nextCursor = resolvedNextCursor;
          }

          return {
            entries,
            status,
            isComplete,
            stopReason,
          };
        } catch (error) {
          outcome = 'error';
          throw error;
        } finally {
          span.end({
            outcome,
            status,
            pages: pageCount,
            entries: entries.length,
            isComplete,
            stopReason,
          });
        }
      },
    );
  }

  private async fetchModelReadmeData(
    repoId: string,
    revision: string | undefined,
    requestContext: CatalogRequestContext,
    options?: { retryNotFoundWithAuth?: boolean },
  ): Promise<ReadmeModelData | undefined> {
    const authPolicy = requestContext.hasAuthToken
      ? REQUEST_AUTH_POLICY.OPTIONAL_AUTH
      : REQUEST_AUTH_POLICY.ANONYMOUS;
    const retryNotFoundWithAuth = options?.retryNotFoundWithAuth === true;
    return this.withInFlightDedup(
      this.readmeRequestCache,
      this.buildRequestCacheKey(
        'readme',
        repoId,
        revision,
        requestContext,
        authPolicy,
        retryNotFoundWithAuth ? 'hidden-404-auth-retry' : 'default',
      ),
      async () => {
        const readmeUrl = buildHuggingFaceRawUrl(repoId, 'README.md', revision);
        let response = await fetchWithTimeout(readmeUrl, {
          headers: buildHeaders(REQUEST_AUTH_POLICY.ANONYMOUS, requestContext.authToken),
        });
        this.assertRequestContextIsCurrent(requestContext);

        if (
          !response.ok
          && (
            response.status === 401
            || response.status === 403
            || (response.status === 404 && retryNotFoundWithAuth)
          )
          && requestContext.hasAuthToken
        ) {
          response = await fetchWithTimeout(readmeUrl, {
            headers: buildHeaders(REQUEST_AUTH_POLICY.REQUIRED_AUTH, requestContext.authToken),
          });
          this.assertRequestContextIsCurrent(requestContext);
        }

        if (!response.ok) {
          return undefined;
        }

        const markdown = await response.text();
        this.assertRequestContextIsCurrent(requestContext);
        const readmeData = extractReadmeData(markdown);
        return (
          readmeData.description
          || readmeData.cardData
          || typeof readmeData.maxContextTokens === 'number'
        )
          ? readmeData
          : undefined;
      },
    );
  }

  private async probeResolvedModelAccess(
    model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision' | 'accessState' | 'isGated' | 'isPrivate'>,
    requestContext: CatalogRequestContext,
  ): Promise<ModelAccessState | null> {
    const resolvedFileName = model.resolvedFileName;
    if (!requestContext.authToken || !resolvedFileName) {
      return null;
    }

    const cacheKey = this.buildRequestCacheKey(
      'probe',
      model.id,
      model.hfRevision,
      requestContext,
      REQUEST_AUTH_POLICY.REQUIRED_AUTH,
      model.resolvedFileName,
    );
    const cachedState = this.getCachedResolvedFileProbeState(cacheKey);
    if (cachedState !== undefined) {
      return cachedState;
    }

    return this.withInFlightDedup(
      this.resolvedFileProbeCache,
      cacheKey,
      async () => {
        const probeUrl = buildHuggingFaceResolveUrl(
          model.id,
          resolvedFileName,
          model.hfRevision,
        );
        const cacheResolvedProbeState = (state: ModelAccessState | null): ModelAccessState | null => {
          if (state === ModelAccessState.AUTHORIZED && this.isAuthRestrictedModel(model)) {
            this.resolvedFileProbeStateCache.delete(cacheKey);
            return state;
          }

          this.setCachedResolvedFileProbeState(cacheKey, state);
          return state;
        };

        try {
          const headResponse = await fetchWithTimeout(probeUrl, {
            method: 'HEAD',
            headers: buildHeaders(REQUEST_AUTH_POLICY.REQUIRED_AUTH, requestContext.authToken),
          });
          this.assertRequestContextIsCurrent(requestContext);
          const headState = this.resolveResolvedFileProbeState(
            headResponse.status,
            requestContext.authToken,
            model,
          );
          if (headState) {
            return cacheResolvedProbeState(headState);
          }

          if (headResponse.ok) {
            return cacheResolvedProbeState(ModelAccessState.AUTHORIZED);
          }

          if (!this.shouldRetryResolvedFileProbe(headResponse.status)) {
            return cacheResolvedProbeState(null);
          }

          const getResponse = await fetchWithTimeout(probeUrl, {
            method: 'GET',
            headers: {
              ...(buildHeaders(REQUEST_AUTH_POLICY.REQUIRED_AUTH, requestContext.authToken) ?? {}),
              Range: 'bytes=0-0',
            },
          });
          this.assertRequestContextIsCurrent(requestContext);
          const getState = this.resolveResolvedFileProbeState(
            getResponse.status,
            requestContext.authToken,
            model,
          );
          if (getState) {
            return cacheResolvedProbeState(getState);
          }

          return cacheResolvedProbeState(getResponse.ok ? ModelAccessState.AUTHORIZED : null);
        } catch (error) {
          if (error instanceof StaleCatalogAuthError) {
            throw error;
          }

          return cacheResolvedProbeState(null);
        }
      },
    );
  }

  private getCachedResolvedFileProbeState(key: string): ModelAccessState | null | undefined {
    const cachedEntry = this.resolvedFileProbeStateCache.get(key);
    if (!cachedEntry) {
      return undefined;
    }

    if (Date.now() - cachedEntry.timestamp > ACCESS_PROBE_CACHE_TTL) {
      this.resolvedFileProbeStateCache.delete(key);
      return undefined;
    }

    return cachedEntry.state;
  }

  private setCachedResolvedFileProbeState(
    key: string,
    state: ModelAccessState | null,
  ): void {
    this.resolvedFileProbeStateCache.set(key, {
      state,
      timestamp: Date.now(),
    });

    const now = Date.now();
    for (const [entryKey, entry] of this.resolvedFileProbeStateCache.entries()) {
      if (now - entry.timestamp > ACCESS_PROBE_CACHE_TTL) {
        this.resolvedFileProbeStateCache.delete(entryKey);
      }
    }

    if (this.resolvedFileProbeStateCache.size <= ACCESS_PROBE_CACHE_MAX_ENTRIES) {
      return;
    }

    const entries = Array.from(this.resolvedFileProbeStateCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.length - ACCESS_PROBE_CACHE_MAX_ENTRIES;
    for (let index = 0; index < toRemove; index += 1) {
      const [entryKey] = entries[index];
      this.resolvedFileProbeStateCache.delete(entryKey);
    }
  }

  private buildRequestCacheKey(
    scope: 'tree' | 'readme' | 'probe',
    repoId: string,
    revision: string | undefined,
    requestContext: CatalogRequestContext,
    authPolicy: RequestAuthPolicy,
    extraSegment?: string,
  ): string {
    return [
      scope,
      repoId,
      revision ?? '__default__',
      extraSegment ?? '__none__',
      this.resolveRequestAuthScope(authPolicy, requestContext.authToken),
      requestContext.authVersion,
    ].join('::');
  }

  private async withInFlightDedup<T>(
    requestMap: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const cachedPromise = requestMap.get(key);
    if (cachedPromise) {
      return cachedPromise;
    }

    const requestPromise = load().finally(() => {
      if (requestMap.get(key) === requestPromise) {
        requestMap.delete(key);
      }
    });

    requestMap.set(key, requestPromise);
    return requestPromise;
  }

  private resolveNextCatalogCursor(
    requestedCursor: string | null,
    nextCursor: string | null,
    visitedCursors: Set<string>,
  ): string | null {
    const trustedNextCursor = this.resolveTrustedHuggingFaceApiCursor(nextCursor);
    if (!trustedNextCursor) {
      return null;
    }

    // Stop pagination if the API points back to the page we just fetched or to an
    // already-visited cursor, otherwise we can loop forever on duplicate pages.
    if (trustedNextCursor === requestedCursor || visitedCursors.has(trustedNextCursor)) {
      return null;
    }

    return trustedNextCursor;
  }

  private resolveTrustedHuggingFaceApiCursor(cursor: string | null): string | null {
    if (!cursor) {
      return null;
    }

    try {
      const baseUrl = new URL(HF_BASE_URL);
      const cursorUrl = new URL(cursor, baseUrl);
      if (
        cursorUrl.protocol !== 'https:'
        || cursorUrl.origin !== baseUrl.origin
        || !cursorUrl.pathname.startsWith('/api/models')
      ) {
        return null;
      }

      return cursorUrl.toString();
    } catch {
      return null;
    }
  }

  private isTrustedHuggingFaceApiCursor(cursor: string): boolean {
    return this.resolveTrustedHuggingFaceApiCursor(cursor) !== null;
  }

  private mergeUniqueModelsById(models: ModelMetadata[]): ModelMetadata[] {
    return uniqueByKey(models, (model) => model.id);
  }

  private resolveTreeAccessState(
    model: ModelMetadata,
    authToken: string | null,
    responseStatus: number,
    options?: ResolveTreeAccessStateOptions,
  ): ModelAccessState {
    if (responseStatus === 401 || responseStatus === 403) {
      return this.resolveDeniedAccessState(authToken);
    }

    if (responseStatus === 404 && this.isAuthRestrictedModel(model)) {
      return this.resolveDeniedAccessState(authToken);
    }

    if (
      options?.allowAuthorization !== false &&
      responseStatus >= 200 &&
      responseStatus < 300 &&
      authToken &&
      (model.isGated || model.isPrivate || model.accessState !== ModelAccessState.PUBLIC)
    ) {
      return ModelAccessState.AUTHORIZED;
    }

    return model.accessState;
  }

  private resolveResolvedFileProbeState(
    responseStatus: number,
    authToken: string | null,
    model: Pick<ModelMetadata, 'accessState' | 'isGated' | 'isPrivate'>,
  ): ModelAccessState | null {
    if (responseStatus === 401 || responseStatus === 403) {
      return this.resolveDeniedAccessState(authToken);
    }

    if (responseStatus === 404 && this.isAuthRestrictedModel(model)) {
      return this.resolveDeniedAccessState(authToken);
    }

    return null;
  }

  private isAuthRestrictedModel(model: Pick<ModelMetadata, 'accessState' | 'isGated' | 'isPrivate'>): boolean {
    return model.accessState !== ModelAccessState.PUBLIC
      || model.isGated === true
      || model.isPrivate === true;
  }

  private shouldRetryResolvedFileProbe(responseStatus: number): boolean {
    return responseStatus === 405 || responseStatus === 501;
  }

  private resolveDeniedAccessState(authToken: string | null): ModelAccessState {
    return authToken
      ? ModelAccessState.ACCESS_DENIED
      : ModelAccessState.AUTH_REQUIRED;
  }

  private buildMemorySearchCacheKey(
    normalizedQuery: string,
    cursor: string | null,
    pageSize: number,
    sort: CatalogServerSort | null,
    hasAuthToken: boolean,
    gated: boolean | undefined,
  ): string {
    const cursorKey = cursor ?? '__initial__';
    const sortKey = sort ?? '__default__';
    const gatedKey = typeof gated === 'boolean' ? String(gated) : '__any__';
    return `${normalizedQuery}::${cursorKey}::${pageSize}::${sortKey}::${this.getAuthScope(hasAuthToken)}::gated:${gatedKey}::${this.authCacheVersion}`;
  }

  private isBufferedCursor(cursor: string | null): boolean {
    return typeof cursor === 'string' && cursor.startsWith('catalog-buffer:');
  }

  private normalizeCatalogSearchCursor(cursor: string | null): string | null {
    if (cursor === null) {
      return null;
    }

    if (this.isBufferedCursor(cursor)) {
      return cursor;
    }

    return this.resolveTrustedHuggingFaceApiCursor(cursor);
  }

  private sanitizeSearchResultCursor<T extends Omit<ModelCatalogSearchResult, 'warning'>>(result: T): T {
    const nextCursor = this.normalizeCatalogSearchCursor(result.nextCursor);
    if (result.nextCursor === nextCursor) {
      return result;
    }

    return {
      ...result,
      hasMore: nextCursor !== null,
      nextCursor,
    };
  }

  private toPersistableSearchResult(
    result: Omit<ModelCatalogSearchResult, 'warning'>,
  ): Omit<ModelCatalogSearchResult, 'warning'> {
    if (!this.isBufferedCursor(result.nextCursor)) {
      return result;
    }

    return {
      ...result,
      hasMore: false,
      nextCursor: null,
    };
  }

  private buildPersistentSearchScope(
    normalizedQuery: string,
    pageSize: number,
    sort: CatalogServerSort | null,
    hasAuthToken: boolean,
  ): CatalogCacheScope {
    return {
      query: normalizedQuery,
      cursor: null,
      pageSize,
      sort,
      authScope: this.getAuthScope(hasAuthToken),
    };
  }

  private getAuthScope(hasAuthToken: boolean): CatalogCacheAuthScope {
    return hasAuthToken ? 'auth' : 'anon';
  }

  private resolveRequestAuthScope(
    policy: RequestAuthPolicy,
    authToken: string | null,
  ): CatalogCacheAuthScope {
    return policy !== REQUEST_AUTH_POLICY.ANONYMOUS && Boolean(authToken) ? 'auth' : 'anon';
  }
}

export const modelCatalogService = new ModelCatalogService();
