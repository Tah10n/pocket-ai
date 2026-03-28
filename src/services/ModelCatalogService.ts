import DeviceInfo from 'react-native-device-info';
import { ModelAccessState, ModelMetadata, LifecycleStatus } from '../types/models';
import { hardwareListenerService } from './HardwareListenerService';
import { registry } from './LocalStorageRegistry';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';

type HuggingFaceModelSummary = {
  id?: string;
  modelId?: string;
  sha?: string;
  siblings?: HuggingFaceSibling[];
  config?: HuggingFaceModelConfig;
  gated?: boolean | string;
  private?: boolean;
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
};

const HF_BASE_URL = 'https://huggingface.co';
const MIN_GGUF_BYTES = 50 * 1024 * 1024;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export type ModelCatalogErrorCode = 'rate_limited' | 'network' | 'unknown';

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

type CatalogCacheEntry = {
  result: Omit<ModelCatalogSearchResult, 'warning'>;
  timestamp: number;
};

type CatalogBatchResult = {
  models: ModelMetadata[];
  nextCursor: string | null;
};

export class ModelCatalogService {
  private searchCache: Map<string, CatalogCacheEntry> = new Map();
  private readonly fetchChunkSize = 30;
  private authCacheVersion = 0;

  constructor() {
    huggingFaceTokenService.subscribe(() => {
      this.authCacheVersion += 1;
      this.searchCache.clear();
    });
  }

  /**
   * Fetch GGUF models from Hugging Face with caching and offline support.
   */
  public async searchModels(
    query: string = 'gguf',
    options?: { cursor?: string | null; pageSize?: number }
  ): Promise<ModelCatalogSearchResult> {
    const isConnected = hardwareListenerService.getCurrentStatus().isConnected;
    const authToken = await huggingFaceTokenService.getToken();
    const cursor = options?.cursor ?? null;
    const pageSize = options?.pageSize ?? 20;
    
    // If offline, return only downloaded/local models from registry that match query
    if (!isConnected) {
      console.log('[ModelCatalogService] Offline mode: fetching from local registry');
      return this.getLocalSearchResults(query);
    }

    try {
      const normalizedQuery = this.normalizeQuery(query);
      const cursorKey = cursor ?? '__initial__';
      const cacheKey = `${normalizedQuery}::${cursorKey}::${pageSize}::${authToken ? 'auth' : 'anon'}::${this.authCacheVersion}`;
      const cached = this.searchCache.get(cacheKey);
      const isCacheFresh = Boolean(cached) && Date.now() - (cached?.timestamp ?? 0) < CACHE_TTL;
      if (isCacheFresh && cached) {
        return {
          ...cached.result,
          models: this.mergeWithRegistry(cached.result.models),
        };
      }

      const totalMemory = await this.getTotalMemory();
      const fetched = await this.fetchCatalogBatch(
        normalizedQuery,
        pageSize,
        totalMemory,
        authToken,
        cursor,
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

      return {
        ...result,
        models: this.mergeWithRegistry(result.models),
      };
    } catch (e) {
      console.error('[ModelCatalogService] Search failed', e);

      if (e instanceof ModelCatalogError) {
        if (cursor === null) {
          const fallback = this.getLocalSearchResults(query);
          return {
            ...fallback,
            warning: e,
          };
        }

        throw e;
      }

      const networkError = new ModelCatalogError('network', 'Model catalog request failed');
      if (cursor === null) {
        const fallback = this.getLocalSearchResults(query);
        return {
          ...fallback,
          warning: networkError,
        };
      }

      throw networkError;
    }
  }

  private getLocalSearchResults(
    query: string,
  ): ModelCatalogSearchResult {
    const filtered = registry.getModels().filter((model) =>
      model.name.toLowerCase().includes(query.toLowerCase()) ||
      model.id.toLowerCase().includes(query.toLowerCase()),
    );

    return {
      models: filtered,
      hasMore: false,
      nextCursor: null,
    };
  }

  public async refreshModelMetadata(model: ModelMetadata): Promise<ModelMetadata> {
    const totalMemory = await this.getTotalMemory();
    const authToken = await huggingFaceTokenService.getToken();
    const [resolved] = await this.resolveMissingModelMetadata([model], totalMemory, authToken);
    return resolved ?? model;
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
    const resolveModel = async (model: ModelMetadata): Promise<ModelMetadata> => {
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
        const accessState = this.resolveTreeAccessState(model, authToken, treeResponse.status);

        if (!selectedEntry) {
          return normalizePersistedModelMetadata({
            ...model,
            accessState,
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
          resolvedFileName,
          downloadUrl: `${HF_BASE_URL}/${model.id}/resolve/main/${resolvedFileName}`,
          sha256: this.getFileSha(selectedEntry) ?? model.sha256,
        });
      } catch (error) {
        console.warn(`[ModelCatalogService] Failed to resolve tree metadata for ${model.id}`, error);
      }

      return model;
    };

    const BATCH_SIZE = 5;
    const results: ModelMetadata[] = [];
    for (let i = 0; i < models.length; i += BATCH_SIZE) {
      const batch = models.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(resolveModel));
      results.push(...batchResults);
    }
    return results;
  }

  private async fetchCatalogBatch(
    normalizedQuery: string,
    minimumResults: number,
    totalMemory: number,
    authToken: string | null,
    initialCursor: string | null,
  ): Promise<CatalogBatchResult> {
    let models: ModelMetadata[] = [];
    let nextCursor = initialCursor;
    let exhausted = false;

    while (models.length < minimumResults && !exhausted) {
      const page = await this.fetchHuggingFaceModels(
        normalizedQuery,
        this.fetchChunkSize,
        authToken,
        nextCursor,
      );
      const baseModels = this.transformHFResponse(page.items, totalMemory, authToken);
      const hydratedModels = await this.resolveMissingModelMetadata(baseModels, totalMemory, authToken);
      models = this.mergeUniqueModelsById([...models, ...hydratedModels]);
      nextCursor = page.nextCursor;
      exhausted = page.nextCursor === null;

      if (page.items.length === 0) {
        exhausted = true;
      }
    }

    return {
      models,
      nextCursor,
    };
  }

  private async fetchHuggingFaceModels(
    normalizedQuery: string,
    limit: number,
    authToken: string | null,
    nextCursor: string | null = null,
  ): Promise<HuggingFaceModelsPage> {
    const url = nextCursor ?? `${HF_BASE_URL}/api/models?search=${encodeURIComponent(normalizedQuery)}&limit=${limit}&full=true&config=true`;
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

  private normalizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return 'gguf';
    return trimmed.toLowerCase().includes('gguf') ? trimmed : `${trimmed} gguf`;
  }

  private transformHFResponse(
    data: HuggingFaceModelSummary[],
    totalMemory: number,
    authToken: string | null,
  ): ModelMetadata[] {
    const results: ModelMetadata[] = [];

    for (const item of data) {
      const repoId = item.id || item.modelId;
      if (!repoId || !item.siblings) continue;

      // Find the first reasonably named GGUF file. 
      // We prefer Q4_K_M or similar if multiple exist, but any .gguf will do.
      const ggufs = item.siblings.filter(s => {
        const name = s.rfilename || s.filename || '';
        const size = s.size || s.lfs?.size || 0;
        return name.toLowerCase().endsWith('.gguf') && (size === 0 || size >= MIN_GGUF_BYTES);
      });

      if (ggufs.length === 0) continue;

      // Try to find a Q4/Q5 variant, otherwise just take the first one
      const ggufSibling = ggufs.find(s => (s.rfilename || '').includes('Q4_K_M')) || ggufs[0];

      const size = ggufSibling.size || ggufSibling.lfs?.size || null;
      const fitsInRam = typeof size === 'number' ? size < totalMemory * 0.8 : null;
      const fileName = ggufSibling.rfilename || ggufSibling.filename || 'model.gguf';
      const maxContextTokens = this.resolveMaxContextTokens(item.config);
      const requiresAuth = Boolean(item.gated) || item.private === true;
      const accessState = requiresAuth
        ? authToken
          ? ModelAccessState.AUTHORIZED
          : ModelAccessState.AUTH_REQUIRED
        : ModelAccessState.PUBLIC;

      results.push(normalizePersistedModelMetadata({
        id: repoId,
        name: repoId.split('/').pop() || repoId,
        author: repoId.split('/')[0],
        size,
        downloadUrl: `${HF_BASE_URL}/${repoId}/resolve/main/${fileName}`,
        resolvedFileName: fileName,
        fitsInRam,
        accessState,
        isGated: Boolean(item.gated),
        isPrivate: item.private === true,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        sha256: ggufSibling.lfs?.sha256,
        maxContextTokens,
        modelType: item.config?.model_type,
        architectures: item.config?.architectures,
      }));
    }

    return results;
  }

  /**
   * Merges remote search results with local registry states.
   * Ensures that if a model is already downloaded/downloading, its status is reflected.
   */
  private mergeWithRegistry(remoteModels: ModelMetadata[]): ModelMetadata[] {
    const localModels = registry.getModels();
    const merged = [...remoteModels];

    localModels.forEach(local => {
      const index = merged.findIndex(m => m.id === local.id);
      if (index !== -1) {
        merged[index] = local;
      } else {
        // If it's in registry but not in search results (e.g. searching for something else),
        // we might still want to see it if we're looking at "My Models" view, 
        // but here we just return search results.
      }
    });

    return merged;
  }

  public async getLocalModels(): Promise<ModelMetadata[]> {
    return registry.getModels();
  }

  private async fetchHuggingFaceModelTree(
    repoId: string,
    authToken: string | null,
  ): Promise<HuggingFaceTreeResponse> {
    const response = await fetch(`${HF_BASE_URL}/api/models/${repoId}/tree/main?recursive=true`, {
      headers: this.buildHeaders(authToken),
    });

    if (!response.ok) {
      return {
        entries: [],
        status: response.status,
      };
    }

    return {
      entries: await response.json() as HuggingFaceTreeEntry[],
      status: response.status,
    };
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
    const ggufs = entries.filter((entry) => {
      const name = this.getFileName(entry);
      const size = this.getFileSize(entry);
      return name.toLowerCase().endsWith('.gguf') && (size === null || size >= MIN_GGUF_BYTES);
    });

    return ggufs.find((entry) => this.getFileName(entry).includes('Q4_K_M')) ?? ggufs[0];
  }

  private getFileName(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string {
    return entry.rfilename || entry.filename || ('path' in entry ? entry.path : '') || '';
  }

  private getFileSize(entry: HuggingFaceSibling | HuggingFaceTreeEntry): number | null {
    const size = entry.size || entry.lfs?.size;
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

    const nextLinkPart = linkHeader
      .split(',')
      .map((part) => part.trim())
      .find((part) => /rel="?next"?/i.test(part));

    if (!nextLinkPart) {
      return null;
    }

    const match = nextLinkPart.match(/<([^>]+)>/);
    return match?.[1] ?? null;
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
  ): ModelAccessState {
    if (responseStatus === 401 || responseStatus === 403) {
      return authToken
        ? ModelAccessState.ACCESS_DENIED
        : ModelAccessState.AUTH_REQUIRED;
    }

    if (model.accessState === ModelAccessState.AUTH_REQUIRED && authToken) {
      return ModelAccessState.AUTHORIZED;
    }

    if (
      responseStatus >= 200 &&
      responseStatus < 300 &&
      authToken &&
      (model.isGated || model.isPrivate || model.accessState !== ModelAccessState.PUBLIC)
    ) {
      return ModelAccessState.AUTHORIZED;
    }

    return model.accessState;
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
