import DeviceInfo from 'react-native-device-info';
import { ModelAccessState, ModelMetadata, LifecycleStatus } from '../types/models';
import { hardwareListenerService } from './HardwareListenerService';
import { registry } from './LocalStorageRegistry';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { performanceMonitor } from './PerformanceMonitor';
import {
  ModelCatalogCacheStore,
  type CatalogCacheAuthScope,
  type CatalogCacheScope,
} from './ModelCatalogCacheStore';
import {
  buildHuggingFaceModelApiUrl,
  buildHuggingFaceRawUrl,
  buildHuggingFaceResolveUrl,
  buildHuggingFaceTreeUrl,
  getHuggingFaceModelUrl,
  HF_BASE_URL,
} from '../utils/huggingFaceUrls';

type HuggingFaceModelSummary = {
  id?: string;
  modelId?: string;
  author?: string;
  sha?: string;
  siblings?: HuggingFaceSibling[];
  config?: HuggingFaceModelConfig;
  gated?: boolean | string;
  private?: boolean;
  downloads?: number;
  likes?: number;
  tags?: string[];
  pipeline_tag?: string;
  cardData?: HuggingFaceModelCardData;
  gguf?: {
    total?: number;
    context_length?: number;
    architecture?: string;
    size_label?: string;
  };
};

type HuggingFaceModelCardData = {
  model_name?: string;
  model_type?: string;
  base_model?: string | string[];
  license?: string;
  language?: string | string[];
  datasets?: string[];
  model_creator?: string;
  quantized_by?: string;
  context_length?: number | string;
  max_position_embeddings?: number | string;
  n_positions?: number | string;
  max_sequence_length?: number | string;
  seq_length?: number | string;
  sliding_window?: number | string;
  model_max_length?: number | string;
  n_ctx?: number | string;
  n_ctx_train?: number | string;
  num_ctx?: number | string;
};

type HuggingFaceModelConfig = {
  max_position_embeddings?: number;
  n_positions?: number;
  max_sequence_length?: number;
  seq_length?: number;
  sliding_window?: number;
  context_length?: number;
  model_max_length?: number;
  n_ctx?: number;
  n_ctx_train?: number;
  num_ctx?: number;
  original_max_position_embeddings?: number;
  text_config?: HuggingFaceModelConfig;
  rope_scaling?: {
    original_max_position_embeddings?: number;
    max_position_embeddings?: number;
  };
  model_type?: string;
  architectures?: string[];
};

type HuggingFaceSibling = {
  rfilename?: string;
  filename?: string;
  size?: number;
  lfs?: {
    size?: number;
    sha256?: string;
  };
};

type HuggingFaceTreeEntry = {
  path?: string;
  rfilename?: string;
  filename?: string;
  size?: number;
  lfs?: {
    size?: number;
    sha256?: string;
    oid?: string;
  };
};

type HuggingFaceModelsPage = {
  items: HuggingFaceModelSummary[];
  nextCursor: string | null;
};

type HuggingFaceTreeResponse = {
  entries: HuggingFaceTreeEntry[];
  status: number;
  isComplete: boolean;
};

type ReadmeModelData = {
  description?: string;
  cardData?: Partial<HuggingFaceModelCardData>;
  maxContextTokens?: number;
};

type ReadmeFrontMatterValue = string | string[];

type CatalogCacheEntry = {
  result: Omit<ModelCatalogSearchResult, 'warning'>;
  timestamp: number;
  isBufferedCursor: boolean;
};

type CatalogBatchResult = {
  models: ModelMetadata[];
  nextCursor: string | null;
};

type CatalogRequestContext = {
  authToken: string | null;
  hasAuthToken: boolean;
  authVersion: number;
};

type ResolvedFileProbeCacheEntry = {
  state: ModelAccessState | null;
  timestamp: number;
};

type ResolveTreeAccessStateOptions = {
  allowAuthorization?: boolean;
};

type CreateTreeProbeCandidateOptions = {
  allowPublic?: boolean;
};

export type CatalogServerSort = 'downloads' | 'likes';
export type ModelCatalogErrorCode = 'rate_limited' | 'timeout' | 'network' | 'unknown';

const MIN_GGUF_BYTES = 50 * 1024 * 1024;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const PERSISTENT_CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const ACCESS_PROBE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const README_SUMMARY_MAX_LENGTH = 320;
const HF_REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_CACHE_MAX_ENTRIES = 120;
const BUFFERED_SEARCH_CACHE_MAX_AGE = 20 * 60 * 1000; // 20 minutes
const MODEL_SNAPSHOT_CACHE_MAX_ENTRIES = 2000;
const ACCESS_PROBE_CACHE_MAX_ENTRIES = 500;
const EXCLUDED_CATALOG_PIPELINE_TAGS = new Set([
  'text-to-image',
  'image-to-image',
  'image-text-to-text',
  'image-classification',
  'image-segmentation',
  'zero-shot-image-classification',
  'object-detection',
  'depth-estimation',
  'visual-question-answering',
  'document-question-answering',
  'video-classification',
  'video-text-to-text',
  'text-to-video',
  'image-to-video',
  'text-to-audio',
  'audio-to-audio',
  'audio-classification',
  'automatic-speech-recognition',
]);
const EXCLUDED_CATALOG_SIGNAL_EXACT_MATCHES = new Set([
  'diffusers',
  'stable-diffusion',
  'image-generation',
  'clip-vision-model',
]);
const EXCLUDED_CATALOG_SIGNAL_FRAGMENTS = [
  'stable-diffusion',
  'sdxl',
  'diffusion',
  'flux',
];

export const HUGGING_FACE_TOKEN_SETTINGS_URL = `${HF_BASE_URL}/settings/tokens`;
export { getHuggingFaceModelUrl };

export class ModelCatalogError extends Error {
  public readonly code: ModelCatalogErrorCode;

  constructor(code: ModelCatalogErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ModelCatalogError';
  }
}

class StaleCatalogAuthError extends Error {
  constructor() {
    super('Catalog auth context changed while the request was in flight');
    this.name = 'StaleCatalogAuthError';
  }
}

export function getModelCatalogErrorMessage(error: unknown): string {
  if (error instanceof ModelCatalogError) {
    if (error.code === 'rate_limited') {
      return 'Hugging Face rate limit reached. Please wait a moment and try again.';
    }

    if (error.code === 'timeout') {
      return 'Hugging Face request timed out. Please check your connection and try again.';
    }

    if (error.code === 'network') {
      return 'Network error while loading models. Check your connection and try again.';
    }
  }

  return 'Could not load models right now. Please try again.';
}

export interface ModelCatalogSearchResult {
  models: ModelMetadata[];
  hasMore: boolean;
  nextCursor: string | null;
  warning?: ModelCatalogError;
}

export class ModelCatalogService {
  private searchCache: Map<string, CatalogCacheEntry> = new Map();
  private modelSnapshotCache: Map<string, ModelMetadata> = new Map();
  private persistentCache = new ModelCatalogCacheStore();
  private authCacheVersion = 0;
  private bufferedCursorSequence = 0;
  private treeRequestCache: Map<string, Promise<HuggingFaceTreeResponse>> = new Map();
  private readmeRequestCache: Map<string, Promise<ReadmeModelData | undefined>> = new Map();
  private resolvedFileProbeCache: Map<string, Promise<ModelAccessState | null>> = new Map();
  private resolvedFileProbeStateCache: Map<string, ResolvedFileProbeCacheEntry> = new Map();
  private readonly unsubscribeFromTokenService: () => void;

  constructor() {
    this.unsubscribeFromTokenService = huggingFaceTokenService.subscribe((_state, source) => {
      if (source !== 'mutation') {
        return;
      }

      this.authCacheVersion += 1;
      this.clearCache();
    });
  }

  public dispose(): void {
    this.unsubscribeFromTokenService();
  }

  public getPersistentCacheBytes(): number {
    return this.persistentCache.getPersistedSizeBytes();
  }

  public clearCache(): void {
    this.bufferedCursorSequence = 0;
    this.searchCache.clear();
    this.modelSnapshotCache.clear();
    this.treeRequestCache.clear();
    this.readmeRequestCache.clear();
    this.resolvedFileProbeCache.clear();
    this.resolvedFileProbeStateCache.clear();
    this.persistentCache.clearAll();
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
    while (true) {
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
    options?: { cursor?: string | null; pageSize?: number; sort?: CatalogServerSort | null },
  ): Promise<ModelCatalogSearchResult> {
    return this.searchModelsInternal(query, options, 0);
  }

  private async searchModelsInternal(
    query: string,
    options: { cursor?: string | null; pageSize?: number; sort?: CatalogServerSort | null } | undefined,
    retryCount: number,
  ): Promise<ModelCatalogSearchResult> {
    const requestContext = await this.createRequestContext();
    const cursor = options?.cursor ?? null;
    const pageSize = options?.pageSize ?? 20;
    const sort = options?.sort ?? null;
    const normalizedQuery = this.normalizeQuery(query);
    const hasAuthToken = requestContext.hasAuthToken;
    const cacheKey = this.buildMemorySearchCacheKey(
      normalizedQuery,
      cursor,
      pageSize,
      sort,
      hasAuthToken,
    );
    const cached = this.searchCache.get(cacheKey);
    const isBufferedCursor = this.isBufferedCursor(cursor);
    const isCacheFresh = Boolean(cached) && Date.now() - (cached?.timestamp ?? 0) < CACHE_TTL;

    if (cached && !isCacheFresh && !isBufferedCursor) {
      this.searchCache.delete(cacheKey);
    }

    if (cached && (isCacheFresh || isBufferedCursor)) {
      const filteredCachedModels = this.filterCatalogSearchModels(cached.result.models);
      return {
        ...cached.result,
        models: this.mergeWithRegistry(filteredCachedModels, this.getAuthScope(hasAuthToken)),
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

      const cachedSearch = this.getCachedSearchResultForScope(query, options, hasAuthToken);
      if (cachedSearch) {
        console.log('[ModelCatalogService] Offline mode: using persisted catalog cache');
        return this.toNonPaginatedFallback(cachedSearch);
      }

      console.log('[ModelCatalogService] Offline mode: fetching from local registry');
      return this.getLocalSearchResults(query);
    }

    try {
      const totalMemory = await this.getTotalMemory();
      const fetched = await this.fetchCatalogBatch(
        normalizedQuery,
        pageSize,
        totalMemory,
        requestContext,
        cursor,
        sort,
      );
      this.assertRequestContextIsCurrent(requestContext);
      const filteredModels = this.filterCatalogSearchModels(fetched.models);
      const result = {
        models: filteredModels,
        hasMore: fetched.nextCursor !== null,
        nextCursor: fetched.nextCursor,
      };

      this.searchCache.set(cacheKey, {
        result,
        timestamp: Date.now(),
        isBufferedCursor,
      });
      this.pruneSearchCache();
      if (cursor === null) {
        this.persistentCache.putSearch(
          this.buildPersistentSearchScope(normalizedQuery, pageSize, sort, hasAuthToken),
          this.toPersistableSearchResult(result),
        );
      }

      return {
        ...result,
        models: this.mergeWithRegistry(result.models, this.getAuthScope(hasAuthToken)),
      };
    } catch (e) {
      if (e instanceof StaleCatalogAuthError) {
        if (cursor === null && retryCount < 1) {
          return this.searchModelsInternal(query, options, retryCount + 1);
        }

        throw new ModelCatalogError('network', 'Catalog auth context changed during request');
      }

      console.error('[ModelCatalogService] Search failed', e);

      if (e instanceof ModelCatalogError) {
        if (cursor === null) {
          const fallback = this.getCachedSearchResultForScope(query, options, hasAuthToken);
          return {
            ...(fallback ? this.toNonPaginatedFallback(fallback) : this.getLocalSearchResults(query)),
            warning: e,
          };
        }

        throw e;
      }

      const networkError = new ModelCatalogError('network', 'Model catalog request failed');
      if (cursor === null) {
        const fallback = this.getCachedSearchResultForScope(query, options, hasAuthToken);
        return {
          ...(fallback ? this.toNonPaginatedFallback(fallback) : this.getLocalSearchResults(query)),
          warning: networkError,
        };
      }

      throw networkError;
    }
  }

  public getCachedModel(modelId: string): ModelMetadata | null {
    const cachedSnapshot = this.getCachedModelSnapshot(modelId);
    if (cachedSnapshot) {
      const merged = this.mergeModelWithRegistry(cachedSnapshot.model);
      if (merged) {
        this.cacheModelSnapshotsInMemory([merged], cachedSnapshot.authScope);
        return merged;
      }
    }

    return registry.getModel(modelId) ?? null;
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
    options?: { cursor?: string | null; pageSize?: number; sort?: CatalogServerSort | null },
  ): Omit<ModelCatalogSearchResult, 'warning'> | null {
    const cached = this.getCachedSearchResultForScope(
      query,
      options,
      huggingFaceTokenService.getCachedState().hasToken,
    );

    if (!cached) {
      return null;
    }

    return this.coerceCachedResultForConnectivity(cached);
  }

  private getCachedSearchResultForScope(
    query: string,
    options: { cursor?: string | null; pageSize?: number; sort?: CatalogServerSort | null } | undefined,
    hasToken: boolean,
  ): Omit<ModelCatalogSearchResult, 'warning'> | null {
    const cursor = options?.cursor ?? null;
    if (cursor !== null) {
      return null;
    }

    const pageSize = options?.pageSize ?? 20;
    const sort = options?.sort ?? null;
    const normalizedQuery = this.normalizeQuery(query);
    const memoryKey = this.buildMemorySearchCacheKey(
      normalizedQuery,
      cursor,
      pageSize,
      sort,
      hasToken,
    );
    const memoryEntry = this.searchCache.get(memoryKey);
    const isMemoryEntryFresh = Boolean(memoryEntry) && Date.now() - (memoryEntry?.timestamp ?? 0) < CACHE_TTL;

    if (memoryEntry && !isMemoryEntryFresh) {
      this.searchCache.delete(memoryKey);
    }

    if (isMemoryEntryFresh && memoryEntry) {
      const filteredMemoryModels = this.filterCatalogSearchModels(memoryEntry.result.models);
      return {
        ...memoryEntry.result,
        models: this.mergeWithRegistry(filteredMemoryModels, this.getAuthScope(hasToken)),
      };
    }

    const persistentEntry = this.persistentCache.getSearch(
      this.buildPersistentSearchScope(normalizedQuery, pageSize, sort, hasToken),
      PERSISTENT_CACHE_MAX_AGE,
    );
    if (!persistentEntry) {
      return null;
    }

    const filteredPersistedModels = this.filterCatalogSearchModels(persistentEntry.models);
    const mergedModels = this.mergeWithRegistry(filteredPersistedModels, this.getAuthScope(hasToken));
    return {
      ...persistentEntry,
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

  public async getModelDetails(modelId: string): Promise<ModelMetadata> {
    return this.getModelDetailsInternal(modelId, 0);
  }

  private async getModelDetailsInternal(modelId: string, retryCount: number): Promise<ModelMetadata> {
    const requestContext = await this.createRequestContext();
    const totalMemory = await this.getTotalMemory();

    try {
      const cachedModel = this.getCachedModel(modelId);
      const fallbackModel = cachedModel ?? this.createFallbackModel(modelId);
      const response = await this.fetchWithTimeout(buildHuggingFaceModelApiUrl(modelId), {
        headers: this.buildHeaders(requestContext.authToken),
      });
      let detailedModel = fallbackModel;
      let hasVerifiedContextWindow = fallbackModel.hasVerifiedContextWindow === true;

      if (response.ok) {
        const payload = await response.json() as HuggingFaceModelSummary;
        this.assertRequestContextIsCurrent(requestContext);
        const payloadMaxContextTokens = this.resolveSummaryMaxContextTokens(payload);
        detailedModel = this.buildModelMetadataFromPayload(
          payload,
          totalMemory,
          requestContext.authToken,
          fallbackModel,
          payloadMaxContextTokens,
        );
        const [resolvedModel] = await this.resolveMissingModelMetadata(
          [detailedModel],
          totalMemory,
          requestContext,
        );
        detailedModel = resolvedModel ?? detailedModel;
        hasVerifiedContextWindow = hasVerifiedContextWindow || typeof payloadMaxContextTokens === 'number';
      } else if (response.status === 401 || response.status === 403) {
        detailedModel = normalizePersistedModelMetadata({
          ...fallbackModel,
          accessState: requestContext.authToken
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
          maxContextTokens: this.resolveMergedMaxContextTokens(
            detailedModel.maxContextTokens,
            readmeData.maxContextTokens,
          ),
          modelType: this.resolveStringMetadata(
            detailedModel.modelType,
            readmeData.cardData?.model_type,
          ),
          baseModels: this.resolveStringArrayMetadata(
            detailedModel.baseModels,
            readmeData.cardData?.base_model,
          ),
          license: this.resolveStringMetadata(
            detailedModel.license,
            readmeData.cardData?.license,
          ),
          languages: this.resolveStringArrayMetadata(
            detailedModel.languages,
            readmeData.cardData?.language,
          ),
          datasets: this.resolveStringArrayMetadata(
            detailedModel.datasets,
            readmeData.cardData?.datasets,
          ),
          quantizedBy: this.resolveStringMetadata(
            detailedModel.quantizedBy,
            readmeData.cardData?.quantized_by,
          ),
          modelCreator: this.resolveStringMetadata(
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
      this.upsertModelSnapshots([detailedModel], this.getAuthScope(requestContext.hasAuthToken));
      return this.syncRegistryModelIfPresent(detailedModel);
    } catch (error) {
      if (error instanceof StaleCatalogAuthError && retryCount < 1) {
        return this.getModelDetailsInternal(modelId, retryCount + 1);
      }

      throw error;
    }
  }

  public async refreshModelMetadata(model: ModelMetadata): Promise<ModelMetadata> {
    return this.refreshModelMetadataInternal(model, 0);
  }

  private async refreshModelMetadataInternal(
    model: ModelMetadata,
    retryCount: number,
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

      if (canRefreshDetailsForContextWindow) {
        return this.getModelDetailsInternal(model.id, retryCount);
      }

      const totalMemory = await this.getTotalMemory();
      const [resolved] = await this.resolveMissingModelMetadata([model], totalMemory, requestContext);
      this.assertRequestContextIsCurrent(requestContext);
      const refreshed = resolved ?? model;
      this.upsertModelSnapshots([refreshed], this.getAuthScope(requestContext.hasAuthToken));
      return this.syncRegistryModelIfPresent(refreshed);
    } catch (error) {
      if (error instanceof StaleCatalogAuthError && retryCount < 1) {
        return this.refreshModelMetadataInternal(model, retryCount + 1);
      }

      throw error;
    }
  }

  public async getLocalModels(): Promise<ModelMetadata[]> {
    const localModels = registry.getModels().map((model) => (
      this.getCachedModel(model.id) ?? model
    ));
    this.upsertModelSnapshots(localModels, 'anon');
    return localModels;
  }

  private getLocalSearchResults(query: string): ModelCatalogSearchResult {
    const filtered = registry.getModels().filter((model) =>
      model.name.toLowerCase().includes(query.toLowerCase()) ||
      model.id.toLowerCase().includes(query.toLowerCase()),
    );
    const merged = filtered.map((model) => this.mergeModelWithRegistry(model) ?? model);
    this.upsertModelSnapshots(merged, 'anon');

    return {
      models: merged,
      hasMore: false,
      nextCursor: null,
    };
  }

  private async getTotalMemory(): Promise<number> {
    try {
      return await DeviceInfo.getTotalMemory();
    } catch {
      return 8 * 1024 * 1024 * 1024; // Fallback 8GB
    }
  }

  private async resolveMissingModelMetadata(
    models: ModelMetadata[],
    totalMemory: number,
    requestContext: CatalogRequestContext,
  ): Promise<ModelMetadata[]> {
    const span = performanceMonitor.startSpan('catalog.resolveMissingModelMetadata', {
      count: models.length,
      hasAuthToken: requestContext.hasAuthToken,
    });
    performanceMonitor.incrementCounter('catalog.resolveMissingModelMetadata.calls');

    const resolveModel = async (model: ModelMetadata): Promise<ModelMetadata | null> => {
      const hasKnownSize = typeof model.size === 'number' && model.size > 0;
      const requiresAuthValidation = requestContext.hasAuthToken && (
        model.accessState !== ModelAccessState.PUBLIC ||
        model.isGated ||
        model.isPrivate
      );

      if (hasKnownSize && !requiresAuthValidation && model.requiresTreeProbe !== true) {
        return model;
      }

      if (hasKnownSize && requiresAuthValidation && model.requiresTreeProbe !== true) {
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
        const treeResponse = await this.fetchHuggingFaceModelTree(
          model.id,
          model.hfRevision,
          requestContext,
        );
        const selectedEntry = this.selectTreeEntryForModel(model, treeResponse.entries);
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
            treeResponse.isComplete &&
            treeResponse.status >= 200 &&
            treeResponse.status < 300
          ) {
            return null;
          }

          return normalizePersistedModelMetadata({
            ...model,
            accessState,
            requiresTreeProbe: model.requiresTreeProbe && !treeResponse.isComplete,
          });
        }

        const resolvedFileName = this.getFileName(selectedEntry);
        const size = this.getFileSize(selectedEntry);
        const fitsInRam = size === null ? null : size < totalMemory * 0.8;

        if (model.requiresTreeProbe && !treeResponse.isComplete) {
          return normalizePersistedModelMetadata({
            ...model,
            size,
            fitsInRam,
            accessState,
            requiresTreeProbe: true,
            hfRevision: model.hfRevision,
            resolvedFileName,
            downloadUrl: buildHuggingFaceResolveUrl(model.id, resolvedFileName, model.hfRevision),
            sha256: this.getFileSha(selectedEntry) ?? model.sha256,
          });
        }

        return normalizePersistedModelMetadata({
          ...model,
          size,
          fitsInRam,
          accessState,
          requiresTreeProbe: false,
          hfRevision: model.hfRevision,
          resolvedFileName,
          downloadUrl: buildHuggingFaceResolveUrl(model.id, resolvedFileName, model.hfRevision),
          sha256: this.getFileSha(selectedEntry) ?? model.sha256,
        });
      } catch (error) {
        if (error instanceof StaleCatalogAuthError) {
          throw error;
        }

        console.warn(`[ModelCatalogService] Failed to resolve tree metadata for ${model.id}`, error);
      }

      return model;
    };

    const batchSize = 5;
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
    totalMemory: number,
    requestContext: CatalogRequestContext,
    initialCursor: string | null,
    sort: CatalogServerSort | null,
  ): Promise<CatalogBatchResult> {
    const span = performanceMonitor.startSpan('catalog.fetchCatalogBatch', {
      query: normalizedQuery,
      minimumResults,
      hasAuthToken: requestContext.hasAuthToken,
      sort: sort ?? undefined,
    });
    performanceMonitor.incrementCounter('catalog.fetchCatalogBatch.calls');

    let models: ModelMetadata[] = [];
    let nextCursor = initialCursor;
    let exhausted = false;
    const visitedCursors = new Set<string>();
    const requestLimit = Math.max(1, minimumResults);
    let pagesFetched = 0;
    let outcome: 'success' | 'error' = 'success';

    try {
      while (models.length < minimumResults && !exhausted) {
        pagesFetched += 1;
        const requestedCursor = nextCursor;
        if (requestedCursor !== null) {
          visitedCursors.add(requestedCursor);
        }

        const page = await this.fetchHuggingFaceModels(
          normalizedQuery,
          requestLimit,
          requestContext,
          requestedCursor,
          sort,
        );
        const baseModels = this.transformHFResponse(page.items, totalMemory, requestContext.authToken);
        const hydratedModels = await this.resolveMissingModelMetadata(
          baseModels,
          totalMemory,
          requestContext,
        );
        models = this.mergeUniqueModelsById([...models, ...hydratedModels]);
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
        minimumResults,
        sort,
        requestContext.hasAuthToken,
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

  private createPaginatedCatalogBatchResult(
    normalizedQuery: string,
    models: ModelMetadata[],
    nextCursor: string | null,
    pageSize: number,
    sort: CatalogServerSort | null,
    hasAuthToken: boolean,
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
    nextCursor: string | null = null,
    sort: CatalogServerSort | null = null,
  ): Promise<HuggingFaceModelsPage> {
    const span = performanceMonitor.startSpan('catalog.fetchHuggingFaceModels', {
      query: normalizedQuery,
      limit,
      hasAuthToken: requestContext.hasAuthToken,
      cursor: nextCursor ? 'cursor' : 'initial',
      sort: sort ?? undefined,
    });
    performanceMonitor.incrementCounter('catalog.fetchHuggingFaceModels.calls');

    let status = 0;
    let itemsCount = 0;
    let outcome: 'success' | 'error' = 'success';

    const url = nextCursor ?? this.buildSearchUrl(normalizedQuery, limit, sort);

    try {
      const response = await this.fetchWithTimeout(url, {
        headers: this.buildHeaders(requestContext.authToken),
      });
      status = response.status;
      this.assertRequestContextIsCurrent(requestContext);

      if (!response.ok) {
        if (response.status === 429) {
          throw new ModelCatalogError('rate_limited', `HF Search rate limited: ${response.status}`);
        }

        throw new ModelCatalogError('network', `HF Search failed: ${response.status}`);
      }

      const items = await response.json() as HuggingFaceModelSummary[];
      itemsCount = items.length;
      this.assertRequestContextIsCurrent(requestContext);

      return {
        items,
        nextCursor: this.parseNextCursor(
          typeof response.headers?.get === 'function'
            ? response.headers.get('link')
            : null,
        ),
      };
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      span.end({ outcome, status, items: itemsCount });
    }
  }

  private buildSearchUrl(
    normalizedQuery: string,
    limit: number,
    sort: CatalogServerSort | null,
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

    return `${HF_BASE_URL}/api/models?${params.join('&')}`;
  }

  private normalizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return 'gguf';
    return trimmed.toLowerCase().includes('gguf') ? trimmed : `${trimmed} gguf`;
  }

  private transformHFResponse(
    data: HuggingFaceModelSummary[],
    totalMemory: number,
    _authToken: string | null,
  ): ModelMetadata[] {
    const results: ModelMetadata[] = [];

    for (const item of data) {
      const repoId = item.id || item.modelId;
      if (!repoId) continue;
      if (!this.isCatalogSummarySupported(item)) {
        continue;
      }

      const hasSiblingMetadata = Array.isArray(item.siblings) && item.siblings.length > 0;
      const probeCandidate = this.createTreeProbeCandidate(item, repoId, {
        allowPublic: !hasSiblingMetadata,
      });
      if (!hasSiblingMetadata) {
        if (probeCandidate) {
          results.push(probeCandidate);
        }
        continue;
      }

      const siblings = item.siblings ?? [];
      const ggufSibling = this.selectPreferredGgufEntry(siblings);
      if (!ggufSibling) {
        if (probeCandidate) {
          results.push(probeCandidate);
        }
        continue;
      }

      const selectedEntrySize = this.getFileSize(ggufSibling);
      const size = selectedEntrySize ?? item.gguf?.total ?? null;
      const fitsInRam = typeof size === 'number' ? size < totalMemory * 0.8 : null;
      const fileName = this.getFileName(ggufSibling) || 'model.gguf';
      const hfRevision = item.sha ?? undefined;
      const maxContextTokens = this.resolveSummaryMaxContextTokens(item);
      const requiresAuth = Boolean(item.gated) || item.private === true;
      const requiresTreeProbe = this.shouldRevalidateCatalogSummarySelection(ggufSibling);
      const accessState = requiresAuth
        ? ModelAccessState.AUTH_REQUIRED
        : ModelAccessState.PUBLIC;

      results.push(normalizePersistedModelMetadata({
        id: repoId,
        name: repoId.split('/').pop() || repoId,
        author: item.author || repoId.split('/')[0],
        size,
        downloadUrl: buildHuggingFaceResolveUrl(repoId, fileName, hfRevision),
        hfRevision,
        resolvedFileName: fileName,
        fitsInRam,
        accessState,
        isGated: Boolean(item.gated),
        isPrivate: item.private === true,
        requiresTreeProbe,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        sha256: this.getFileSha(ggufSibling),
        maxContextTokens,
        parameterSizeLabel: this.resolveStringMetadata(undefined, item.gguf?.size_label),
        modelType: item.config?.model_type ?? item.gguf?.architecture,
        architectures: item.config?.architectures,
        baseModels: this.resolveStringArrayMetadata(undefined, item.cardData?.base_model),
        license: this.resolveStringMetadata(undefined, item.cardData?.license),
        languages: this.resolveStringArrayMetadata(undefined, item.cardData?.language),
        datasets: this.resolveStringArrayMetadata(undefined, item.cardData?.datasets),
        quantizedBy: this.resolveStringMetadata(undefined, item.cardData?.quantized_by),
        modelCreator: this.resolveStringMetadata(undefined, item.cardData?.model_creator),
        downloads: item.downloads ?? null,
        likes: item.likes ?? null,
        tags: item.tags,
      }));
    }

    return results;
  }

  private createTreeProbeCandidate(
    item: HuggingFaceModelSummary,
    repoId: string,
    options?: CreateTreeProbeCandidateOptions,
  ): ModelMetadata | null {
    const requiresAuth = Boolean(item.gated) || item.private === true;
    if (!this.hasGgufCatalogSignal(repoId, item.tags)) {
      return null;
    }

    if (!requiresAuth && options?.allowPublic !== true) {
      return null;
    }

    return normalizePersistedModelMetadata({
      id: repoId,
      name: repoId.split('/').pop() || repoId,
      author: item.author || repoId.split('/')[0],
      size: null,
      downloadUrl: buildHuggingFaceResolveUrl(repoId, 'model.gguf', item.sha ?? undefined),
      fitsInRam: null,
      accessState: requiresAuth
        ? ModelAccessState.AUTH_REQUIRED
        : ModelAccessState.PUBLIC,
      isGated: Boolean(item.gated),
      isPrivate: item.private === true,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
      hfRevision: item.sha ?? undefined,
      maxContextTokens: this.resolveSummaryMaxContextTokens(item),
      parameterSizeLabel: this.resolveStringMetadata(undefined, item.gguf?.size_label),
      modelType: item.config?.model_type ?? item.gguf?.architecture,
      baseModels: this.resolveStringArrayMetadata(undefined, item.cardData?.base_model),
      license: this.resolveStringMetadata(undefined, item.cardData?.license),
      languages: this.resolveStringArrayMetadata(undefined, item.cardData?.language),
      datasets: this.resolveStringArrayMetadata(undefined, item.cardData?.datasets),
      quantizedBy: this.resolveStringMetadata(undefined, item.cardData?.quantized_by),
      modelCreator: this.resolveStringMetadata(undefined, item.cardData?.model_creator),
      downloads: item.downloads ?? null,
      likes: item.likes ?? null,
      tags: item.tags,
    });
  }

  private buildModelMetadataFromPayload(
    payload: HuggingFaceModelSummary,
    totalMemory: number,
    authToken: string | null,
    fallbackModel: ModelMetadata,
    payloadMaxContextTokens?: number,
  ): ModelMetadata {
    const repoId = payload.id || payload.modelId || fallbackModel.id;
    const hfRevision = payload.sha ?? fallbackModel.hfRevision;
    const selectedEntry = this.selectPreferredGgufEntry(payload.siblings ?? []);
    const selectedEntrySize = this.getFileSize(selectedEntry);
    const resolvedFileName = selectedEntry
      ? this.getFileName(selectedEntry)
      : fallbackModel.resolvedFileName;
    const size = selectedEntrySize ?? payload.gguf?.total ?? fallbackModel.size;
    const fitsInRam = typeof size === 'number'
      ? size < totalMemory * 0.8
      : fallbackModel.fitsInRam;
    const requiresAuth = Boolean(payload.gated) || payload.private === true;
    const requiresTreeProbe = selectedEntry
      ? selectedEntrySize === null
      : fallbackModel.requiresTreeProbe === true;

    return normalizePersistedModelMetadata({
      ...fallbackModel,
      id: repoId,
      name: repoId.split('/').pop() || repoId,
      author: payload.author || repoId.split('/')[0],
      size,
      downloadUrl: resolvedFileName
        ? buildHuggingFaceResolveUrl(repoId, resolvedFileName, hfRevision)
        : fallbackModel.downloadUrl,
      hfRevision,
      resolvedFileName,
      fitsInRam,
      accessState: this.resolveDetailAccessState(requiresAuth, authToken),
      isGated: Boolean(payload.gated),
      isPrivate: payload.private === true,
      requiresTreeProbe,
      parameterSizeLabel: this.resolveStringMetadata(fallbackModel.parameterSizeLabel, payload.gguf?.size_label),
      sha256: selectedEntry ? this.getFileSha(selectedEntry) ?? fallbackModel.sha256 : fallbackModel.sha256,
      maxContextTokens: payloadMaxContextTokens ?? fallbackModel.maxContextTokens,
      modelType: payload.config?.model_type ?? payload.cardData?.model_type ?? fallbackModel.modelType,
      architectures: payload.config?.architectures ?? fallbackModel.architectures,
      baseModels: this.resolveStringArrayMetadata(fallbackModel.baseModels, payload.cardData?.base_model),
      license: this.resolveStringMetadata(fallbackModel.license, payload.cardData?.license),
      languages: this.resolveStringArrayMetadata(fallbackModel.languages, payload.cardData?.language),
      datasets: this.resolveStringArrayMetadata(fallbackModel.datasets, payload.cardData?.datasets),
      quantizedBy: this.resolveStringMetadata(fallbackModel.quantizedBy, payload.cardData?.quantized_by),
      modelCreator: this.resolveStringMetadata(fallbackModel.modelCreator, payload.cardData?.model_creator),
      downloads: payload.downloads ?? fallbackModel.downloads ?? null,
      likes: payload.likes ?? fallbackModel.likes ?? null,
      tags: payload.tags ?? fallbackModel.tags,
    });
  }

  private createFallbackModel(modelId: string): ModelMetadata {
    return normalizePersistedModelMetadata({
      id: modelId,
      name: modelId.split('/').pop() || modelId,
      author: modelId.split('/')[0] || 'unknown',
      size: null,
      downloadUrl: buildHuggingFaceResolveUrl(modelId, 'model.gguf', undefined),
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    });
  }

  private filterCatalogSearchModels(models: ModelMetadata[]): ModelMetadata[] {
    return models.filter((model) => this.isCatalogModelSupported(model));
  }

  private isCatalogSummarySupported(item: HuggingFaceModelSummary): boolean {
    return !this.hasUnsupportedCatalogSignals({
      pipelineTag: item.pipeline_tag,
      tags: item.tags,
      modelTypes: [
        item.config?.model_type,
        item.cardData?.model_type,
        item.gguf?.architecture,
      ],
      architectures: item.config?.architectures,
    });
  }

  private isCatalogModelSupported(model: ModelMetadata): boolean {
    return !this.hasUnsupportedCatalogSignals({
      tags: model.tags,
      modelTypes: [model.modelType],
      architectures: model.architectures,
    });
  }

  private hasUnsupportedCatalogSignals(options: {
    pipelineTag?: string;
    tags?: string[];
    modelTypes?: (string | undefined)[];
    architectures?: string[];
  }): boolean {
    const pipelineTag = this.normalizeCatalogSignal(options.pipelineTag);
    if (pipelineTag && EXCLUDED_CATALOG_PIPELINE_TAGS.has(pipelineTag)) {
      return true;
    }

    const signals = [
      ...this.normalizeCatalogSignals(options.tags),
      ...this.normalizeCatalogSignals(options.modelTypes),
      ...this.normalizeCatalogSignals(options.architectures),
    ];

    return signals.some((signal) => (
      EXCLUDED_CATALOG_PIPELINE_TAGS.has(signal)
      || EXCLUDED_CATALOG_SIGNAL_EXACT_MATCHES.has(signal)
      || EXCLUDED_CATALOG_SIGNAL_FRAGMENTS.some((fragment) => signal.includes(fragment))
    ));
  }

  private mergeWithRegistry(
    remoteModels: ModelMetadata[],
    authScope: CatalogCacheAuthScope = 'anon',
  ): ModelMetadata[] {
    const merged = remoteModels.map((model) => this.mergeModelWithRegistry(model) ?? model);
    this.upsertModelSnapshots(merged, authScope);
    return merged;
  }

  private mergeModelWithRegistry(remoteModel?: ModelMetadata): ModelMetadata | undefined {
    if (!remoteModel) {
      return undefined;
    }

    const localModel = registry.getModel(remoteModel.id);
    if (!localModel) {
      return remoteModel;
    }

    const {
      maxContextTokens,
      hasVerifiedContextWindow,
    } = this.resolveMergedContextWindowMetadata(remoteModel, localModel);

    return normalizePersistedModelMetadata({
      ...remoteModel,
      size: remoteModel.size ?? localModel.size,
      hfRevision: remoteModel.hfRevision ?? localModel.hfRevision,
      resolvedFileName: remoteModel.resolvedFileName ?? localModel.resolvedFileName,
      localPath: localModel.localPath,
      downloadedAt: localModel.downloadedAt,
      sha256: remoteModel.sha256 ?? localModel.sha256,
      fitsInRam: remoteModel.fitsInRam ?? localModel.fitsInRam,
      accessState: remoteModel.accessState,
      isGated: remoteModel.isGated,
      isPrivate: remoteModel.isPrivate,
      lifecycleStatus: localModel.lifecycleStatus,
      downloadProgress: localModel.downloadProgress,
      resumeData: localModel.resumeData,
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
    });
  }

  private resolveMergedContextWindowMetadata(
    remoteModel: ModelMetadata,
    localModel: ModelMetadata,
  ): Pick<ModelMetadata, 'maxContextTokens' | 'hasVerifiedContextWindow'> {
    const remoteHasVerifiedContextWindow = remoteModel.hasVerifiedContextWindow === true;
    const localHasVerifiedContextWindow = localModel.hasVerifiedContextWindow === true;

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
      maxContextTokens: this.resolveMergedMaxContextTokens(
        remoteModel.maxContextTokens,
        localModel.maxContextTokens,
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
    const normalizedModels = models.map((model) => normalizePersistedModelMetadata(model));
    normalizedModels.forEach((model) => {
      this.setModelSnapshotInMemory(this.buildModelSnapshotCacheKey(model.id, authScope), model);
    });
    this.pruneModelSnapshotCache();
  }

  private upsertModelSnapshots(
    models: ModelMetadata[],
    authScope: CatalogCacheAuthScope = 'anon',
  ) {
    const normalizedModels = models.map((model) => normalizePersistedModelMetadata(model));
    this.cacheModelSnapshotsInMemory(normalizedModels, authScope);
    this.persistentCache.putModelSnapshots(normalizedModels, authScope);
  }

  private async fetchHuggingFaceModelTree(
    repoId: string,
    revision: string | undefined,
    requestContext: CatalogRequestContext,
  ): Promise<HuggingFaceTreeResponse> {
    return this.withInFlightDedup(
      this.treeRequestCache,
      this.buildRequestCacheKey('tree', repoId, revision, requestContext),
      async () => {
        const span = performanceMonitor.startSpan('catalog.fetchHuggingFaceModelTree', {
          repoId,
          revision: revision ?? 'main',
          hasAuthToken: requestContext.hasAuthToken,
        });
        performanceMonitor.incrementCounter('catalog.fetchHuggingFaceModelTree.calls');

        let nextCursor: string | null = buildHuggingFaceTreeUrl(repoId, revision);
        const visitedCursors = new Set<string>();
        const entries: HuggingFaceTreeEntry[] = [];
        let status = 200;
        let isComplete = true;
        let pageCount = 0;
        let outcome: 'success' | 'error' = 'success';

        try {
          while (nextCursor !== null) {
            pageCount += 1;
            const requestedCursor = nextCursor;
            visitedCursors.add(requestedCursor);

            const response = await this.fetchWithTimeout(requestedCursor, {
              headers: this.buildHeaders(requestContext.authToken),
            });
            status = response.status;
            this.assertRequestContextIsCurrent(requestContext);

            if (!response.ok) {
              if (entries.length > 0) {
                console.warn(`[ModelCatalogService] Tree pagination stopped early for ${repoId}: ${response.status}`);
                isComplete = false;
                break;
              }

              return {
                entries: [],
                status: response.status,
                isComplete: false,
              };
            }

            entries.push(...await response.json() as HuggingFaceTreeEntry[]);
            this.assertRequestContextIsCurrent(requestContext);
            nextCursor = this.resolveNextCatalogCursor(
              requestedCursor,
              this.parseNextCursor(
                typeof response.headers?.get === 'function'
                  ? response.headers.get('link')
                  : null,
              ),
              visitedCursors,
            );
          }

          return {
            entries,
            status,
            isComplete,
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
          });
        }
      },
    );
  }

  private async fetchModelReadmeData(
    repoId: string,
    revision: string | undefined,
    requestContext: CatalogRequestContext,
  ): Promise<ReadmeModelData | undefined> {
    return this.withInFlightDedup(
      this.readmeRequestCache,
      this.buildRequestCacheKey('readme', repoId, revision, requestContext),
      async () => {
        const response = await this.fetchWithTimeout(buildHuggingFaceRawUrl(repoId, 'README.md', revision), {
          headers: this.buildHeaders(requestContext.authToken),
        });
        this.assertRequestContextIsCurrent(requestContext);

        if (!response.ok) {
          return undefined;
        }

        const markdown = await response.text();
        this.assertRequestContextIsCurrent(requestContext);
        const readmeData = this.extractReadmeData(markdown);
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
    model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision'>,
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
          this.setCachedResolvedFileProbeState(cacheKey, state);
          return state;
        };

        try {
          const headResponse = await this.fetchWithTimeout(probeUrl, {
            method: 'HEAD',
            headers: this.buildHeaders(requestContext.authToken),
          });
          this.assertRequestContextIsCurrent(requestContext);
          const headState = this.resolveResolvedFileProbeState(
            headResponse.status,
            requestContext.authToken,
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

          const getResponse = await this.fetchWithTimeout(probeUrl, {
            method: 'GET',
            headers: {
              ...(this.buildHeaders(requestContext.authToken) ?? {}),
              Range: 'bytes=0-0',
            },
          });
          this.assertRequestContextIsCurrent(requestContext);
          const getState = this.resolveResolvedFileProbeState(
            getResponse.status,
            requestContext.authToken,
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

  private extractReadmeData(markdown: string): ReadmeModelData {
    if (!markdown.trim()) {
      return {};
    }

    let body = markdown.replace(/\r\n/g, '\n');
    let frontMatter: Record<string, ReadmeFrontMatterValue> | undefined;
    if (body.startsWith('---\n')) {
      const frontMatterEnd = body.indexOf('\n---\n', 4);
      if (frontMatterEnd >= 0) {
        frontMatter = this.parseReadmeFrontMatter(body.slice(4, frontMatterEnd));
        body = body.slice(frontMatterEnd + 5);
      }
    }

    return {
      description: this.extractReadmeSummaryFromBody(body),
      cardData: frontMatter ? this.mapReadmeFrontMatterToCardData(frontMatter) : undefined,
      maxContextTokens: frontMatter ? this.resolveFrontMatterMaxContextTokens(frontMatter) : undefined,
    };
  }

  private extractReadmeSummaryFromBody(body: string): string | undefined {
    if (!body.trim()) {
      return undefined;
    }

    const paragraphs = body
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => this.isReadableReadmeParagraph(paragraph))
      .map((paragraph) => this.stripMarkdown(paragraph))
      .filter((paragraph) => paragraph.length >= 24);

    const summary = paragraphs[0];
    if (!summary) {
      return undefined;
    }

    if (summary.length <= README_SUMMARY_MAX_LENGTH) {
      return summary;
    }

    return `${summary.slice(0, README_SUMMARY_MAX_LENGTH).trimEnd()}...`;
  }

  private parseReadmeFrontMatter(frontMatter: string): Record<string, ReadmeFrontMatterValue> {
    const parsed: Record<string, ReadmeFrontMatterValue> = {};
    let activeListKey: string | null = null;

    for (const rawLine of frontMatter.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const listMatch = trimmed.match(/^-\s+(.+)$/);
      if (listMatch && activeListKey) {
        const normalizedItem = this.normalizeFrontMatterScalar(listMatch[1]);
        if (!normalizedItem) {
          continue;
        }

        const existing = parsed[activeListKey];
        const nextList = Array.isArray(existing) ? existing : [];
        nextList.push(normalizedItem);
        parsed[activeListKey] = nextList;
        continue;
      }

      const keyValueMatch = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!keyValueMatch) {
        activeListKey = null;
        continue;
      }

      const [, key, rawValue] = keyValueMatch;
      const value = rawValue.trim();

      if (!value) {
        parsed[key] = [];
        activeListKey = key;
        continue;
      }

      activeListKey = null;
      if (value.startsWith('[') && value.endsWith(']')) {
        const inlineList = value
          .slice(1, -1)
          .split(',')
          .map((entry) => this.normalizeFrontMatterScalar(entry))
          .filter((entry): entry is string => entry.length > 0);

        if (inlineList.length > 0) {
          parsed[key] = inlineList;
        }
        continue;
      }

      const normalizedValue = this.normalizeFrontMatterScalar(value);
      if (normalizedValue) {
        parsed[key] = normalizedValue;
      }
    }

    return parsed;
  }

  private mapReadmeFrontMatterToCardData(
    frontMatter: Record<string, ReadmeFrontMatterValue>,
  ): Partial<HuggingFaceModelCardData> | undefined {
    const baseModels = this.getFrontMatterArray(frontMatter, 'base_model');
    const languages = this.getFrontMatterArray(frontMatter, 'language');
    const datasets = this.getFrontMatterArray(frontMatter, 'datasets');
    const license = this.getFrontMatterString(frontMatter, 'license');
    const modelCreator = this.getFrontMatterString(frontMatter, 'model_creator');
    const quantizedBy = this.getFrontMatterString(frontMatter, 'quantized_by');
    const modelType = this.getFrontMatterString(frontMatter, 'model_type');

    const cardData: Partial<HuggingFaceModelCardData> = {};
    if (baseModels?.length) {
      cardData.base_model = baseModels.length === 1 ? baseModels[0] : baseModels;
    }
    if (languages?.length) {
      cardData.language = languages.length === 1 ? languages[0] : languages;
    }
    if (datasets?.length) {
      cardData.datasets = datasets;
    }
    if (license) {
      cardData.license = license;
    }
    if (modelCreator) {
      cardData.model_creator = modelCreator;
    }
    if (quantizedBy) {
      cardData.quantized_by = quantizedBy;
    }
    if (modelType) {
      cardData.model_type = modelType;
    }

    return Object.keys(cardData).length > 0 ? cardData : undefined;
  }

  private resolveFrontMatterMaxContextTokens(
    frontMatter: Record<string, ReadmeFrontMatterValue>,
  ): number | undefined {
    return this.resolveLargestContextTokenValue([
      this.getFrontMatterString(frontMatter, 'context_length'),
      this.getFrontMatterString(frontMatter, 'max_position_embeddings'),
      this.getFrontMatterString(frontMatter, 'n_positions'),
      this.getFrontMatterString(frontMatter, 'max_sequence_length'),
      this.getFrontMatterString(frontMatter, 'seq_length'),
      this.getFrontMatterString(frontMatter, 'sliding_window'),
      this.getFrontMatterString(frontMatter, 'model_max_length'),
      this.getFrontMatterString(frontMatter, 'n_ctx'),
      this.getFrontMatterString(frontMatter, 'n_ctx_train'),
      this.getFrontMatterString(frontMatter, 'num_ctx'),
      this.getFrontMatterString(frontMatter, 'original_max_position_embeddings'),
    ]);
  }

  private normalizeFrontMatterScalar(value: string): string {
    const normalized = value
      .trim()
      .replace(/^['"]/, '')
      .replace(/['"]$/, '')
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1')
      .trim();

    if (normalized === 'null' || normalized === '[]') {
      return '';
    }

    return normalized;
  }

  private getFrontMatterString(
    frontMatter: Record<string, ReadmeFrontMatterValue>,
    key: string,
  ): string | undefined {
    const value = frontMatter[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }

    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }

    return undefined;
  }

  private getFrontMatterArray(
    frontMatter: Record<string, ReadmeFrontMatterValue>,
    key: string,
  ): string[] | undefined {
    const value = frontMatter[key];
    if (Array.isArray(value)) {
      return value.length > 0 ? value : undefined;
    }

    if (typeof value === 'string' && value.length > 0) {
      return [value];
    }

    return undefined;
  }

  private isReadableReadmeParagraph(paragraph: string): boolean {
    if (!paragraph) {
      return false;
    }

    return !(
      paragraph.startsWith('#')
      || paragraph.startsWith('![')
      || paragraph.startsWith('[')
      || paragraph.startsWith('<')
      || paragraph.startsWith('|')
      || paragraph.startsWith('```')
      || paragraph.startsWith('---')
    );
  }

  private stripMarkdown(text: string): string {
    return text
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~>#-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private selectTreeEntryForModel(
    model: ModelMetadata,
    entries: HuggingFaceTreeEntry[],
  ): HuggingFaceTreeEntry | undefined {
    if (model.requiresTreeProbe !== true && model.resolvedFileName) {
      const exactMatch = entries.find((entry) => this.getFileName(entry) === model.resolvedFileName);
      if (exactMatch) {
        return exactMatch;
      }
    }

    return this.selectPreferredGgufEntry(entries);
  }

  private shouldRevalidateCatalogSummarySelection(
    selectedEntry: HuggingFaceSibling,
  ): boolean {
    return this.getFileSize(selectedEntry) === null;
  }

  private selectPreferredGgufEntry<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(
    entries: T[],
  ): T | undefined {
    const ggufs = entries.filter((entry) => this.isEligibleGgufEntry(entry));

    return ggufs.find((entry) => this.isPreferredQuantFileName(this.getFileName(entry))) ?? ggufs[0];
  }

  private isPreferredQuantFileName(fileName: string): boolean {
    return fileName.toUpperCase().includes('Q4_K_M');
  }

  private isEligibleGgufEntry(entry: HuggingFaceSibling | HuggingFaceTreeEntry): boolean {
    const name = this.getFileName(entry);
    const size = this.getFileSize(entry);
    return name.toLowerCase().endsWith('.gguf') && (size === null || size >= MIN_GGUF_BYTES);
  }

  private getFileName(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string {
    return entry.rfilename || entry.filename || ('path' in entry ? entry.path : '') || '';
  }

  private getFileSize(entry: HuggingFaceSibling | HuggingFaceTreeEntry | undefined): number | null {
    const size = entry?.size || entry?.lfs?.size;
    return typeof size === 'number' && size > 0 ? size : null;
  }

  private getFileSha(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string | undefined {
    const lfs = entry.lfs as { sha256?: string; oid?: string } | undefined;
    return lfs?.sha256 || lfs?.oid;
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
    extraSegment?: string,
  ): string {
    return [
      scope,
      repoId,
      revision ?? '__default__',
      extraSegment ?? '__none__',
      requestContext.hasAuthToken ? 'auth' : 'anon',
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

  private parseNextCursor(linkHeader: string | null): string | null {
    if (!linkHeader) {
      return null;
    }

    for (const linkValue of this.splitLinkHeader(linkHeader, ',')) {
      const segments = this.splitLinkHeader(linkValue, ';');
      if (segments.length === 0) {
        continue;
      }

      const target = this.parseLinkTarget(segments[0]);
      if (!target) {
        continue;
      }

      const hasNextRelation = segments.slice(1).some((segment) => {
        const parameter = this.parseLinkParameter(segment);
        if (!parameter || parameter.name !== 'rel') {
          return false;
        }

        return parameter.value
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .includes('next');
      });

      if (hasNextRelation) {
        return target;
      }
    }

    return null;
  }

  private splitLinkHeader(headerValue: string, delimiter: ',' | ';'): string[] {
    const parts: string[] = [];
    let currentPart = '';
    let inQuotes = false;
    let inAngleBrackets = false;
    let escapeNextCharacter = false;

    for (const character of headerValue) {
      if (escapeNextCharacter) {
        currentPart += character;
        escapeNextCharacter = false;
        continue;
      }

      if (character === '\\' && inQuotes) {
        currentPart += character;
        escapeNextCharacter = true;
        continue;
      }

      if (character === '"') {
        inQuotes = !inQuotes;
        currentPart += character;
        continue;
      }

      if (character === '<' && !inQuotes) {
        inAngleBrackets = true;
        currentPart += character;
        continue;
      }

      if (character === '>' && !inQuotes) {
        inAngleBrackets = false;
        currentPart += character;
        continue;
      }

      if (character === delimiter && !inQuotes && !inAngleBrackets) {
        const trimmedPart = currentPart.trim();
        if (trimmedPart) {
          parts.push(trimmedPart);
        }

        currentPart = '';
        continue;
      }

      currentPart += character;
    }

    const trailingPart = currentPart.trim();
    if (trailingPart) {
      parts.push(trailingPart);
    }

    return parts;
  }

  private parseLinkTarget(linkSegment: string): string | null {
    const trimmedSegment = linkSegment.trim();
    const start = trimmedSegment.indexOf('<');
    const end = trimmedSegment.indexOf('>', start + 1);
    if (start === -1 || end === -1 || end <= start + 1) {
      return null;
    }

    return trimmedSegment.slice(start + 1, end);
  }

  private parseLinkParameter(segment: string): { name: string; value: string } | null {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) {
      return null;
    }

    const separatorIndex = trimmedSegment.indexOf('=');
    const rawName = separatorIndex === -1
      ? trimmedSegment
      : trimmedSegment.slice(0, separatorIndex);
    const name = rawName.trim().toLowerCase();
    if (!name) {
      return null;
    }

    let value = separatorIndex === -1
      ? ''
      : trimmedSegment.slice(separatorIndex + 1).trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }

    return { name, value };
  }

  private resolveNextCatalogCursor(
    requestedCursor: string | null,
    nextCursor: string | null,
    visitedCursors: Set<string>,
  ): string | null {
    if (!nextCursor) {
      return null;
    }

    // Stop pagination if the API points back to the page we just fetched or to an
    // already-visited cursor, otherwise we can loop forever on duplicate pages.
    if (nextCursor === requestedCursor || visitedCursors.has(nextCursor)) {
      return null;
    }

    return nextCursor;
  }

  private mergeUniqueModelsById(models: ModelMetadata[]): ModelMetadata[] {
    const seen = new Set<string>();
    return models.filter((model) => {
      if (seen.has(model.id)) {
        return false;
      }

      seen.add(model.id);
      return true;
    });
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
  ): ModelAccessState | null {
    if (responseStatus === 401 || responseStatus === 403) {
      return this.resolveDeniedAccessState(authToken);
    }

    return null;
  }

  private shouldRetryResolvedFileProbe(responseStatus: number): boolean {
    return responseStatus === 405 || responseStatus === 501;
  }

  private resolveDeniedAccessState(authToken: string | null): ModelAccessState {
    return authToken
      ? ModelAccessState.ACCESS_DENIED
      : ModelAccessState.AUTH_REQUIRED;
  }

  private resolveDetailAccessState(
    requiresAuth: boolean,
    authToken: string | null,
  ): ModelAccessState {
    if (!requiresAuth) {
      return ModelAccessState.PUBLIC;
    }

    if (!authToken) {
      return ModelAccessState.AUTH_REQUIRED;
    }

    // A successful gated/private details fetch with a bearer token proves the
    // current auth context can read the repo metadata. Later tree/probe checks
    // may still downgrade this to access denied for the selected file.
    return ModelAccessState.AUTHORIZED;
  }

  private hasGgufCatalogSignal(repoId: string, tags?: string[]): boolean {
    if (repoId.toLowerCase().includes('gguf')) {
      return true;
    }

    return Array.isArray(tags)
      && tags.some((tag) => typeof tag === 'string' && tag.toLowerCase().includes('gguf'));
  }

  private resolveStringMetadata(
    primaryValue: string | undefined,
    fallbackValue: string | undefined,
  ): string | undefined {
    return typeof primaryValue === 'string' && primaryValue.trim().length > 0
      ? primaryValue.trim()
      : typeof fallbackValue === 'string' && fallbackValue.trim().length > 0
        ? fallbackValue.trim()
        : undefined;
  }

  private normalizeCatalogSignal(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeCatalogSignals(values: (string | undefined)[] | undefined): string[] {
    if (!Array.isArray(values)) {
      return [];
    }

    return values
      .map((value) => this.normalizeCatalogSignal(value))
      .filter((value): value is string => value !== null);
  }

  private resolveStringArrayMetadata(
    primaryValue: string[] | undefined,
    fallbackValue: string | string[] | undefined,
  ): string[] | undefined {
    const normalizedPrimary = this.normalizeStringArrayMetadata(primaryValue);
    if (normalizedPrimary) {
      return normalizedPrimary;
    }

    return this.normalizeStringArrayMetadata(fallbackValue);
  }

  private normalizeStringArrayMetadata(value: string | string[] | undefined): string[] | undefined {
    const rawValues = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? [value]
        : [];

    if (rawValues.length === 0) {
      return undefined;
    }

    const normalized = rawValues
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return normalized.length > 0 ? normalized : undefined;
  }

  private buildMemorySearchCacheKey(
    normalizedQuery: string,
    cursor: string | null,
    pageSize: number,
    sort: CatalogServerSort | null,
    hasAuthToken: boolean,
  ): string {
    const cursorKey = cursor ?? '__initial__';
    const sortKey = sort ?? '__default__';
    return `${normalizedQuery}::${cursorKey}::${pageSize}::${sortKey}::${this.getAuthScope(hasAuthToken)}::${this.authCacheVersion}`;
  }

  private isBufferedCursor(cursor: string | null): boolean {
    return typeof cursor === 'string' && cursor.startsWith('catalog-buffer:');
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

  private buildHeaders(authToken: string | null): HeadersInit | undefined {
    if (!authToken) {
      return undefined;
    }

    return {
      Authorization: `Bearer ${authToken}`,
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs = HF_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    const signal = controller?.signal ?? init.signal;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const externalSignal = init.signal;
    const abortListener = () => controller?.abort();

    if (externalSignal && controller) {
      if (externalSignal.aborted) {
        controller.abort();
      } else if (typeof externalSignal.addEventListener === 'function') {
        externalSignal.addEventListener('abort', abortListener);
      }
    }

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new ModelCatalogError('timeout', `HF request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const fetchPromise = fetch(url, signal ? { ...init, signal } : init);
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (
        externalSignal &&
        controller &&
        typeof externalSignal.removeEventListener === 'function'
      ) {
        externalSignal.removeEventListener('abort', abortListener);
      }
    }
  }

  private normalizeContextTokenValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 256) {
      return Math.round(value);
    }

    if (typeof value === 'string') {
      const normalizedValue = value.trim().toLowerCase().replace(/[_\s,]/g, '');
      const shorthandMatch = normalizedValue.match(/^(\d+(?:\.\d+)?)([km])?(?:tokens?)?$/);
      const multiplier = shorthandMatch?.[2] === 'm'
        ? 1024 * 1024
        : shorthandMatch?.[2] === 'k'
          ? 1024
          : 1;
      const normalized = shorthandMatch
        ? Number(shorthandMatch[1]) * multiplier
        : Number(normalizedValue);
      if (Number.isFinite(normalized) && normalized >= 256) {
        return Math.round(normalized);
      }
    }

    return undefined;
  }

  private resolveLargestContextTokenValue(values: unknown[]): number | undefined {
    let resolved: number | undefined;

    for (const value of values) {
      const normalized = this.normalizeContextTokenValue(value);
      if (normalized === undefined) {
        continue;
      }

      resolved = resolved === undefined ? normalized : Math.max(resolved, normalized);
    }

    return resolved;
  }

  private resolveCardDataMaxContextTokens(
    cardData?: Partial<HuggingFaceModelCardData>,
  ): number | undefined {
    if (!cardData) {
      return undefined;
    }

    return this.resolveLargestContextTokenValue([
      cardData.context_length,
      cardData.max_position_embeddings,
      cardData.n_positions,
      cardData.max_sequence_length,
      cardData.seq_length,
      cardData.sliding_window,
      cardData.model_max_length,
      cardData.n_ctx,
      cardData.n_ctx_train,
      cardData.num_ctx,
    ]);
  }

  private resolveSummaryMaxContextTokens(
    summary?: Pick<HuggingFaceModelSummary, 'config' | 'cardData' | 'gguf'>,
  ): number | undefined {
    if (!summary) {
      return undefined;
    }

    return this.resolveLargestContextTokenValue([
      this.resolveMaxContextTokens(summary.config),
      this.resolveCardDataMaxContextTokens(summary.cardData),
      summary.gguf?.context_length,
    ]);
  }

  private resolveMergedMaxContextTokens(...values: (number | undefined)[]): number | undefined {
    return this.resolveLargestContextTokenValue(values);
  }

  private resolveMaxContextTokens(config?: HuggingFaceModelConfig): number | undefined {
    return this.resolveLargestContextTokenValue([
      config?.max_position_embeddings,
      config?.n_positions,
      config?.max_sequence_length,
      config?.seq_length,
      config?.sliding_window,
      config?.context_length,
      config?.model_max_length,
      config?.n_ctx,
      config?.n_ctx_train,
      config?.num_ctx,
      config?.original_max_position_embeddings,
      config?.rope_scaling?.original_max_position_embeddings,
      config?.rope_scaling?.max_position_embeddings,
      config?.text_config?.max_position_embeddings,
      config?.text_config?.n_positions,
      config?.text_config?.max_sequence_length,
      config?.text_config?.seq_length,
      config?.text_config?.sliding_window,
      config?.text_config?.context_length,
      config?.text_config?.model_max_length,
      config?.text_config?.n_ctx,
      config?.text_config?.n_ctx_train,
      config?.text_config?.num_ctx,
      config?.text_config?.original_max_position_embeddings,
      config?.text_config?.rope_scaling?.original_max_position_embeddings,
      config?.text_config?.rope_scaling?.max_position_embeddings,
    ]);
  }
}

export const modelCatalogService = new ModelCatalogService();
