import DeviceInfo from 'react-native-device-info';
import { ModelAccessState, ModelMetadata, LifecycleStatus } from '../types/models';
import { hardwareListenerService } from './HardwareListenerService';
import { registry } from './LocalStorageRegistry';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import {
  ModelCatalogCacheStore,
  type CatalogCacheAuthScope,
  type CatalogCacheScope,
} from './ModelCatalogCacheStore';

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
  cardData?: HuggingFaceModelCardData;
  gguf?: {
    total?: number;
    context_length?: number;
    architecture?: string;
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
};

type HuggingFaceModelConfig = {
  max_position_embeddings?: number;
  n_positions?: number;
  max_sequence_length?: number;
  seq_length?: number;
  sliding_window?: number;
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
};

type ReadmeFrontMatterValue = string | string[];

type CatalogCacheEntry = {
  result: Omit<ModelCatalogSearchResult, 'warning'>;
  timestamp: number;
};

type CatalogBatchResult = {
  models: ModelMetadata[];
  nextCursor: string | null;
};

type ResolveTreeAccessStateOptions = {
  allowAuthorization?: boolean;
};

type CreateTreeProbeCandidateOptions = {
  allowPublic?: boolean;
};

export type CatalogServerSort = 'downloads' | 'likes';
export type ModelCatalogErrorCode = 'rate_limited' | 'network' | 'unknown';

const HF_BASE_URL = 'https://huggingface.co';
const MIN_GGUF_BYTES = 50 * 1024 * 1024;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const PERSISTENT_CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const README_SUMMARY_MAX_LENGTH = 320;

export function getHuggingFaceModelUrl(modelId: string): string {
  return `${HF_BASE_URL}/${modelId}`;
}

export const HUGGING_FACE_TOKEN_SETTINGS_URL = `${HF_BASE_URL}/settings/tokens`;

export class ModelCatalogError extends Error {
  public readonly code: ModelCatalogErrorCode;

  constructor(code: ModelCatalogErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ModelCatalogError';
  }
}

export function getModelCatalogErrorMessage(error: unknown): string {
  if (error instanceof ModelCatalogError) {
    if (error.code === 'rate_limited') {
      return 'Hugging Face rate limit reached. Please wait a moment and try again.';
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
  private readonly unsubscribeFromTokenService: () => void;

  constructor() {
    this.unsubscribeFromTokenService = huggingFaceTokenService.subscribe((_state, source) => {
      if (source !== 'mutation') {
        return;
      }

      this.authCacheVersion += 1;
      this.bufferedCursorSequence = 0;
      this.searchCache.clear();
      this.modelSnapshotCache.clear();
      this.persistentCache.clearAll();
    });
  }

  public dispose(): void {
    this.unsubscribeFromTokenService();
  }

  /**
   * Fetch GGUF models from Hugging Face with caching and offline support.
   */
  public async searchModels(
    query: string = 'gguf',
    options?: { cursor?: string | null; pageSize?: number; sort?: CatalogServerSort | null },
  ): Promise<ModelCatalogSearchResult> {
    const authToken = await huggingFaceTokenService.getToken();
    const cursor = options?.cursor ?? null;
    const pageSize = options?.pageSize ?? 20;
    const sort = options?.sort ?? null;
    const normalizedQuery = this.normalizeQuery(query);
    const hasAuthToken = Boolean(authToken);
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

    if (cached && (isCacheFresh || isBufferedCursor)) {
      return {
        ...cached.result,
        models: this.mergeWithRegistry(cached.result.models),
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
        authToken,
        cursor,
        sort,
      );
      const result = {
        models: fetched.models,
        hasMore: fetched.nextCursor !== null,
        nextCursor: fetched.nextCursor,
      };

      this.searchCache.set(cacheKey, {
        result,
        timestamp: Date.now(),
      });
      if (cursor === null) {
        this.persistentCache.putSearch(
          this.buildPersistentSearchScope(normalizedQuery, pageSize, sort, hasAuthToken),
          this.toPersistableSearchResult(result),
        );
      }

      return {
        ...result,
        models: this.mergeWithRegistry(result.models),
      };
    } catch (e) {
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
    const cached = this.modelSnapshotCache.get(modelId);
    const merged = this.mergeModelWithRegistry(cached);
    if (merged) {
      return merged;
    }

    const persisted = this.persistentCache.getModelSnapshot(modelId, PERSISTENT_CACHE_MAX_AGE);
    const mergedPersisted = this.mergeModelWithRegistry(persisted ?? undefined);
    if (mergedPersisted) {
      this.upsertModelSnapshots([mergedPersisted]);
      return mergedPersisted;
    }

    return registry.getModel(modelId) ?? null;
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

    if (isMemoryEntryFresh && memoryEntry) {
      return {
        ...memoryEntry.result,
        models: this.mergeWithRegistry(memoryEntry.result.models),
      };
    }

    const persistentEntry = this.persistentCache.getSearch(
      this.buildPersistentSearchScope(normalizedQuery, pageSize, sort, hasToken),
      PERSISTENT_CACHE_MAX_AGE,
    );
    if (!persistentEntry) {
      return null;
    }

    const mergedModels = this.mergeWithRegistry(persistentEntry.models);
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
    const authToken = await huggingFaceTokenService.getToken();
    const totalMemory = await this.getTotalMemory();
    const cachedModel = this.getCachedModel(modelId);
    const fallbackModel = cachedModel ?? this.createFallbackModel(modelId);
    const response = await fetch(`${HF_BASE_URL}/api/models/${modelId}`, {
      headers: this.buildHeaders(authToken),
    });
    let detailedModel = fallbackModel;

    if (response.ok) {
      const payload = await response.json() as HuggingFaceModelSummary;
      detailedModel = this.buildModelMetadataFromPayload(payload, totalMemory, authToken, fallbackModel);
      const [resolvedModel] = await this.resolveMissingModelMetadata([detailedModel], totalMemory, authToken);
      detailedModel = resolvedModel ?? detailedModel;
    } else if (response.status === 401 || response.status === 403) {
      detailedModel = normalizePersistedModelMetadata({
        ...fallbackModel,
        accessState: authToken
          ? ModelAccessState.ACCESS_DENIED
          : ModelAccessState.AUTH_REQUIRED,
      });
    } else {
      throw new ModelCatalogError('network', `HF model details failed: ${response.status}`);
    }

    const readmeData = await this.fetchModelReadmeData(modelId, authToken).catch((error) => {
      console.warn(`[ModelCatalogService] Failed to load README summary for ${modelId}`, error);
      return undefined;
    });

    if (readmeData) {
      detailedModel = normalizePersistedModelMetadata({
        ...detailedModel,
        description: readmeData.description ?? detailedModel.description,
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

    this.upsertModelSnapshots([detailedModel]);
    return this.mergeModelWithRegistry(detailedModel) ?? detailedModel;
  }

  public async refreshModelMetadata(model: ModelMetadata): Promise<ModelMetadata> {
    const totalMemory = await this.getTotalMemory();
    const authToken = await huggingFaceTokenService.getToken();
    const [resolved] = await this.resolveMissingModelMetadata([model], totalMemory, authToken);
    const refreshed = resolved ?? model;
    this.upsertModelSnapshots([refreshed]);
    return refreshed;
  }

  public async getLocalModels(): Promise<ModelMetadata[]> {
    const localModels = registry.getModels().map((model) => (
      this.mergeModelWithRegistry(this.modelSnapshotCache.get(model.id) ?? model) ?? model
    ));
    this.upsertModelSnapshots(localModels);
    return localModels;
  }

  private getLocalSearchResults(query: string): ModelCatalogSearchResult {
    const filtered = registry.getModels().filter((model) =>
      model.name.toLowerCase().includes(query.toLowerCase()) ||
      model.id.toLowerCase().includes(query.toLowerCase()),
    );
    const merged = filtered.map((model) => this.mergeModelWithRegistry(model) ?? model);
    this.upsertModelSnapshots(merged);

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
    authToken: string | null,
  ): Promise<ModelMetadata[]> {
    const resolveModel = async (model: ModelMetadata): Promise<ModelMetadata | null> => {
      const hasKnownSize = typeof model.size === 'number' && model.size > 0;
      const requiresAuthValidation = Boolean(authToken) && (
        model.accessState !== ModelAccessState.PUBLIC ||
        model.isGated ||
        model.isPrivate
      );

      if (hasKnownSize && !requiresAuthValidation) {
        return model;
      }

      try {
        const treeResponse = await this.fetchHuggingFaceModelTree(model.id, authToken);
        const selectedEntry = this.selectTreeEntryForModel(model, treeResponse.entries);
        const accessState = this.resolveTreeAccessState(model, authToken, treeResponse.status, {
          allowAuthorization: treeResponse.isComplete || selectedEntry !== undefined,
        });

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

        return normalizePersistedModelMetadata({
          ...model,
          size,
          fitsInRam,
          accessState,
          requiresTreeProbe: false,
          resolvedFileName,
          downloadUrl: `${HF_BASE_URL}/${model.id}/resolve/main/${resolvedFileName}`,
          sha256: this.getFileSha(selectedEntry) ?? model.sha256,
        });
      } catch (error) {
        console.warn(`[ModelCatalogService] Failed to resolve tree metadata for ${model.id}`, error);
      }

      return model;
    };

    const batchSize = 5;
    const results: ModelMetadata[] = [];
    for (let index = 0; index < models.length; index += batchSize) {
      const batch = models.slice(index, index + batchSize);
      const batchResults = await Promise.all(batch.map(resolveModel));
      results.push(...batchResults.filter((model): model is ModelMetadata => model !== null));
    }

    return results;
  }

  private async fetchCatalogBatch(
    normalizedQuery: string,
    minimumResults: number,
    totalMemory: number,
    authToken: string | null,
    initialCursor: string | null,
    sort: CatalogServerSort | null,
  ): Promise<CatalogBatchResult> {
    let models: ModelMetadata[] = [];
    let nextCursor = initialCursor;
    let exhausted = false;
    const visitedCursors = new Set<string>();
    const requestLimit = Math.max(1, minimumResults);

    while (models.length < minimumResults && !exhausted) {
      const requestedCursor = nextCursor;
      if (requestedCursor !== null) {
        visitedCursors.add(requestedCursor);
      }

      const page = await this.fetchHuggingFaceModels(
        normalizedQuery,
        requestLimit,
        authToken,
        requestedCursor,
        sort,
      );
      const baseModels = this.transformHFResponse(page.items, totalMemory, authToken);
      const hydratedModels = await this.resolveMissingModelMetadata(baseModels, totalMemory, authToken);
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
      Boolean(authToken),
    );
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
        },
      );
      nextCursor = bufferedCursor;
    }

    return nextCursor ?? this.createBufferedCursorToken();
  }

  private createBufferedCursorToken(): string {
    this.bufferedCursorSequence += 1;
    return `catalog-buffer:${this.authCacheVersion}:${this.bufferedCursorSequence}`;
  }

  private async fetchHuggingFaceModels(
    normalizedQuery: string,
    limit: number,
    authToken: string | null,
    nextCursor: string | null = null,
    sort: CatalogServerSort | null = null,
  ): Promise<HuggingFaceModelsPage> {
    const url = nextCursor ?? this.buildSearchUrl(normalizedQuery, limit, sort);
    const response = await fetch(url, {
      headers: this.buildHeaders(authToken),
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new ModelCatalogError('rate_limited', `HF Search rate limited: ${response.status}`);
      }

      throw new ModelCatalogError('network', `HF Search failed: ${response.status}`);
    }

    return {
      items: await response.json() as HuggingFaceModelSummary[],
      nextCursor: this.parseNextCursor(
        typeof response.headers?.get === 'function'
          ? response.headers.get('link')
          : null,
      ),
    };
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

      const size = this.getFileSize(ggufSibling) ?? item.gguf?.total ?? null;
      const fitsInRam = typeof size === 'number' ? size < totalMemory * 0.8 : null;
      const fileName = this.getFileName(ggufSibling) || 'model.gguf';
      const maxContextTokens = this.resolveMaxContextTokens(item.config) ?? item.gguf?.context_length;
      const requiresAuth = Boolean(item.gated) || item.private === true;
      const accessState = requiresAuth
        ? ModelAccessState.AUTH_REQUIRED
        : ModelAccessState.PUBLIC;

      results.push(normalizePersistedModelMetadata({
        id: repoId,
        name: repoId.split('/').pop() || repoId,
        author: item.author || repoId.split('/')[0],
        size,
        downloadUrl: `${HF_BASE_URL}/${repoId}/resolve/main/${fileName}`,
        resolvedFileName: fileName,
        fitsInRam,
        accessState,
        isGated: Boolean(item.gated),
        isPrivate: item.private === true,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        sha256: this.getFileSha(ggufSibling),
        maxContextTokens,
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
    if (!this.hasGgufCatalogSignal(repoId, item.tags)) {
      return null;
    }

    const requiresAuth = Boolean(item.gated) || item.private === true;
    if (!requiresAuth && options?.allowPublic !== true) {
      return null;
    }

    return normalizePersistedModelMetadata({
      id: repoId,
      name: repoId.split('/').pop() || repoId,
      author: item.author || repoId.split('/')[0],
      size: null,
      downloadUrl: `${HF_BASE_URL}/${repoId}/resolve/main/model.gguf`,
      fitsInRam: null,
      accessState: requiresAuth
        ? ModelAccessState.AUTH_REQUIRED
        : ModelAccessState.PUBLIC,
      isGated: Boolean(item.gated),
      isPrivate: item.private === true,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
      maxContextTokens: this.resolveMaxContextTokens(item.config) ?? item.gguf?.context_length,
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
  ): ModelMetadata {
    const repoId = payload.id || payload.modelId || fallbackModel.id;
    const selectedEntry = this.selectPreferredGgufEntry(payload.siblings ?? []);
    const resolvedFileName = selectedEntry
      ? this.getFileName(selectedEntry)
      : fallbackModel.resolvedFileName;
    const size = this.getFileSize(selectedEntry) ?? payload.gguf?.total ?? fallbackModel.size;
    const fitsInRam = typeof size === 'number'
      ? size < totalMemory * 0.8
      : fallbackModel.fitsInRam;
    const requiresAuth = Boolean(payload.gated) || payload.private === true;

    return normalizePersistedModelMetadata({
      ...fallbackModel,
      id: repoId,
      name: repoId.split('/').pop() || repoId,
      author: payload.author || repoId.split('/')[0],
      size,
      downloadUrl: resolvedFileName
        ? `${HF_BASE_URL}/${repoId}/resolve/main/${resolvedFileName}`
        : fallbackModel.downloadUrl,
      resolvedFileName,
      fitsInRam,
      accessState: this.resolveDetailAccessState(requiresAuth, authToken, fallbackModel.accessState),
      isGated: Boolean(payload.gated),
      isPrivate: payload.private === true,
      sha256: selectedEntry ? this.getFileSha(selectedEntry) ?? fallbackModel.sha256 : fallbackModel.sha256,
      maxContextTokens: this.resolveMaxContextTokens(payload.config) ?? payload.gguf?.context_length ?? fallbackModel.maxContextTokens,
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
      downloadUrl: `${HF_BASE_URL}/${modelId}/resolve/main/model.gguf`,
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    });
  }

  private mergeWithRegistry(remoteModels: ModelMetadata[]): ModelMetadata[] {
    const merged = remoteModels.map((model) => this.mergeModelWithRegistry(model) ?? model);
    this.upsertModelSnapshots(merged);
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

    return normalizePersistedModelMetadata({
      ...remoteModel,
      size: remoteModel.size ?? localModel.size,
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
      maxContextTokens: remoteModel.maxContextTokens ?? localModel.maxContextTokens,
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

  private upsertModelSnapshots(models: ModelMetadata[]) {
    const normalizedModels = models.map((model) => normalizePersistedModelMetadata(model));
    normalizedModels.forEach((model) => {
      this.modelSnapshotCache.set(model.id, model);
    });
    this.persistentCache.putModelSnapshots(normalizedModels);
  }

  private async fetchHuggingFaceModelTree(
    repoId: string,
    authToken: string | null,
  ): Promise<HuggingFaceTreeResponse> {
    let nextCursor: string | null = `${HF_BASE_URL}/api/models/${repoId}/tree/main?recursive=true`;
    const visitedCursors = new Set<string>();
    const entries: HuggingFaceTreeEntry[] = [];
    let status = 200;
    let isComplete = true;

    while (nextCursor !== null) {
      const requestedCursor = nextCursor;
      visitedCursors.add(requestedCursor);

      const response = await fetch(requestedCursor, {
        headers: this.buildHeaders(authToken),
      });

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

      status = response.status;
      entries.push(...await response.json() as HuggingFaceTreeEntry[]);
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
  }

  private async fetchModelReadmeData(
    repoId: string,
    authToken: string | null,
  ): Promise<ReadmeModelData | undefined> {
    const response = await fetch(`${getHuggingFaceModelUrl(repoId)}/raw/main/README.md`, {
      headers: this.buildHeaders(authToken),
    });

    if (!response.ok) {
      return undefined;
    }

    const markdown = await response.text();
    const readmeData = this.extractReadmeData(markdown);
    return readmeData.description || readmeData.cardData ? readmeData : undefined;
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
    if (model.resolvedFileName) {
      const exactMatch = entries.find((entry) => this.getFileName(entry) === model.resolvedFileName);
      if (exactMatch) {
        return exactMatch;
      }
    }

    return this.selectPreferredGgufEntry(entries);
  }

  private selectPreferredGgufEntry<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(
    entries: T[],
  ): T | undefined {
    const ggufs = entries.filter((entry) => this.isEligibleGgufEntry(entry));

    return ggufs.find((entry) => this.getFileName(entry).includes('Q4_K_M')) ?? ggufs[0];
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
      return authToken
        ? ModelAccessState.ACCESS_DENIED
        : ModelAccessState.AUTH_REQUIRED;
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

  private resolveDetailAccessState(
    requiresAuth: boolean,
    authToken: string | null,
    fallbackAccessState: ModelAccessState,
  ): ModelAccessState {
    if (!requiresAuth) {
      return ModelAccessState.PUBLIC;
    }

    if (!authToken) {
      return ModelAccessState.AUTH_REQUIRED;
    }

    if (
      fallbackAccessState === ModelAccessState.AUTHORIZED
      || fallbackAccessState === ModelAccessState.ACCESS_DENIED
    ) {
      return fallbackAccessState;
    }

    return ModelAccessState.AUTH_REQUIRED;
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

  private resolveMaxContextTokens(config?: HuggingFaceModelConfig): number | undefined {
    const candidates = [
      config?.max_position_embeddings,
      config?.n_positions,
      config?.max_sequence_length,
      config?.seq_length,
      config?.sliding_window,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 256) {
        return Math.round(candidate);
      }
    }

    return undefined;
  }
}

export const modelCatalogService = new ModelCatalogService();
