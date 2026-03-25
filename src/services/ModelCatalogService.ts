import DeviceInfo from 'react-native-device-info';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { hardwareListenerService } from './HardwareListenerService';
import { registry } from './LocalStorageRegistry';

type HuggingFaceModelSummary = {
  id?: string;
  modelId?: string;
  sha?: string;
  siblings?: HuggingFaceSibling[];
  config?: HuggingFaceModelConfig;
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
  warning?: ModelCatalogError;
}

export class ModelCatalogService {
  private searchCache: Map<
    string,
    { data: ModelMetadata[]; timestamp: number; hasMore: boolean }
  > = new Map();
  private readonly fetchChunkSize = 30;

  /**
   * Fetch GGUF models from Hugging Face with caching and offline support.
   */
  public async searchModels(
    query: string = 'gguf',
    options?: { page?: number; pageSize?: number }
  ): Promise<ModelCatalogSearchResult> {
    const isConnected = hardwareListenerService.getCurrentStatus().isConnected;
    const page = options?.page ?? 0;
    const pageSize = options?.pageSize ?? 20;
    const requiredLimit = Math.max((page + 1) * pageSize, pageSize);
    const sliceStart = page * pageSize;
    const sliceEnd = sliceStart + pageSize;
    
    // If offline, return only downloaded/local models from registry that match query
    if (!isConnected) {
      console.log('[ModelCatalogService] Offline mode: fetching from local registry');
      return this.getLocalSearchResults(query, page, pageSize);
    }

    const cacheKey = query.toLowerCase();
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL && cached.data.length >= requiredLimit) {
      return {
        models: this.mergeWithRegistry(cached.data.slice(sliceStart, sliceEnd)),
        hasMore: cached.hasMore,
      };
    }

    try {
      const normalizedQuery = this.normalizeQuery(query);
      const totalMemory = await this.getTotalMemory();
      const { models, hasMore } = await this.fetchCatalogPage(
        normalizedQuery,
        sliceEnd,
        totalMemory,
      );

      this.searchCache.set(cacheKey, { data: models, timestamp: Date.now(), hasMore });
      return {
        models: this.mergeWithRegistry(models.slice(sliceStart, sliceEnd)),
        hasMore,
      };
    } catch (e) {
      console.error('[ModelCatalogService] Search failed', e);

      if (e instanceof ModelCatalogError) {
        if (page === 0) {
          const fallback = this.getLocalSearchResults(query, page, pageSize);
          return {
            ...fallback,
            warning: e,
          };
        }

        throw e;
      }

      const networkError = new ModelCatalogError('network', 'Model catalog request failed');
      if (page === 0) {
        const fallback = this.getLocalSearchResults(query, page, pageSize);
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
    page: number,
    pageSize: number,
  ): ModelCatalogSearchResult {
    const sliceStart = page * pageSize;
    const sliceEnd = sliceStart + pageSize;
    const filtered = registry.getModels().filter((model) =>
      model.name.toLowerCase().includes(query.toLowerCase()) ||
      model.id.toLowerCase().includes(query.toLowerCase()),
    );

    return {
      models: filtered.slice(sliceStart, sliceEnd),
      hasMore: sliceEnd < filtered.length,
    };
  }

  private async getTotalMemory(): Promise<number> {
    try {
      return await DeviceInfo.getTotalMemory();
    } catch {
      return 8 * 1024 * 1024 * 1024; // Fallback 8GB
    }
  }

  private async fetchFileSizes(models: ModelMetadata[], totalMemory: number): Promise<ModelMetadata[]> {
    const fetchSize = async (model: ModelMetadata): Promise<ModelMetadata> => {
      if (model.size > 0) return model;
      try {
        const response = await fetch(model.downloadUrl, { method: 'HEAD' });
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          const fitsInRam = size < totalMemory * 0.8;
          return { ...model, size, fitsInRam };
        }
      } catch {
        console.warn(`[ModelCatalogService] Failed to fetch size for ${model.id}`);
      }
      return model;
    };

    // Process in batches of 5 to avoid HuggingFace rate-limiting
    const BATCH_SIZE = 5;
    const results: ModelMetadata[] = [];
    for (let i = 0; i < models.length; i += BATCH_SIZE) {
      const batch = models.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(fetchSize));
      results.push(...batchResults);
    }
    return results;
  }

  private async fetchCatalogPage(
    normalizedQuery: string,
    minimumResults: number,
    totalMemory: number,
  ): Promise<{ models: ModelMetadata[]; hasMore: boolean }> {
    let requestLimit = Math.max(minimumResults, this.fetchChunkSize);

    while (true) {
      const data = await this.fetchHuggingFaceModels(normalizedQuery, requestLimit);
      const baseModels = this.transformHFResponse(data, totalMemory);
      const models = await this.fetchFileSizes(baseModels, totalMemory);
      const exhausted = data.length < requestLimit;

      if (models.length > minimumResults || exhausted) {
        return {
          models,
          hasMore: !exhausted && models.length > minimumResults,
        };
      }

      requestLimit += Math.max(this.fetchChunkSize, minimumResults);
    }
  }

  private async fetchHuggingFaceModels(
    normalizedQuery: string,
    limit: number,
  ): Promise<HuggingFaceModelSummary[]> {
    const url = `${HF_BASE_URL}/api/models?search=${encodeURIComponent(normalizedQuery)}&limit=${limit}&full=true&config=true`;
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 429) {
        throw new ModelCatalogError('rate_limited', `HF Search rate limited: ${response.status}`);
      }

      throw new ModelCatalogError('network', `HF Search failed: ${response.status}`);
    }

    return response.json() as Promise<HuggingFaceModelSummary[]>;
  }

  private normalizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return 'gguf';
    return trimmed.toLowerCase().includes('gguf') ? trimmed : `${trimmed} gguf`;
  }

  private transformHFResponse(data: HuggingFaceModelSummary[], totalMemory: number): ModelMetadata[] {
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

      const size = ggufSibling.size || ggufSibling.lfs?.size || 0;
      const fitsInRam = size > 0 ? size < totalMemory * 0.8 : true; // Assume true if size unknown
      const fileName = ggufSibling.rfilename || ggufSibling.filename || 'model.gguf';
      const maxContextTokens = this.resolveMaxContextTokens(item.config);

      results.push({
        id: repoId,
        name: repoId.split('/').pop() || repoId,
        author: repoId.split('/')[0],
        size: size,
        downloadUrl: `${HF_BASE_URL}/${repoId}/resolve/main/${fileName}`,
        fitsInRam,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        sha256: ggufSibling.lfs?.sha256,
        maxContextTokens,
        modelType: item.config?.model_type,
        architectures: item.config?.architectures,
      });
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
