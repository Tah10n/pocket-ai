import DeviceInfo from 'react-native-device-info';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { hardwareListenerService } from './HardwareListenerService';
import { registry } from './LocalStorageRegistry';

type HuggingFaceModelSummary = {
  id?: string;
  modelId?: string;
  sha?: string;
  siblings?: HuggingFaceSibling[];
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

export class ModelCatalogService {
  private searchCache: Map<string, { data: ModelMetadata[]; timestamp: number }> = new Map();

  /**
   * Fetch GGUF models from Hugging Face with caching and offline support.
   */
  public async searchModels(query: string = 'gguf'): Promise<ModelMetadata[]> {
    const isConnected = hardwareListenerService.getCurrentStatus().isConnected;
    
    // If offline, return only downloaded/local models from registry that match query
    if (!isConnected) {
      console.log('[ModelCatalogService] Offline mode: fetching from local registry');
      const localModels = registry.getModels();
      return localModels.filter(m => 
        m.name.toLowerCase().includes(query.toLowerCase()) || 
        m.id.toLowerCase().includes(query.toLowerCase())
      );
    }

    const cacheKey = query.toLowerCase();
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return this.mergeWithRegistry(cached.data);
    }

    try {
      const normalizedQuery = this.normalizeQuery(query);
      const url = `${HF_BASE_URL}/api/models?search=${encodeURIComponent(normalizedQuery)}&limit=20&full=true&config=true`;
      
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HF Search failed: ${response.status}`);

      const data = await response.json() as HuggingFaceModelSummary[];
      const baseModels = this.transformHFResponse(data);
      const models = await this.fetchFileSizes(baseModels);
      
      this.searchCache.set(cacheKey, { data: models, timestamp: Date.now() });
      return this.mergeWithRegistry(models);
    } catch (e) {
      console.error('[ModelCatalogService] Search failed', e);
      // Fallback to local registry on error
      return this.mergeWithRegistry([]);
    }
  }

  private async fetchFileSizes(models: ModelMetadata[]): Promise<ModelMetadata[]> {
    let totalMemory = 8 * 1024 * 1024 * 1024;
    try {
      totalMemory = await DeviceInfo.getTotalMemory();
    } catch (e) {
      // Fallback
    }

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
      } catch (e) {
        console.warn(`[ModelCatalogService] Failed to fetch size for ${model.id}`);
      }
      return model;
    };

    return Promise.all(models.map(fetchSize));
  }

  private normalizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return 'gguf';
    return trimmed.toLowerCase().includes('gguf') ? trimmed : `${trimmed} gguf`;
  }

  private transformHFResponse(data: HuggingFaceModelSummary[]): ModelMetadata[] {
    const results: ModelMetadata[] = [];
    const totalMemory = 8 * 1024 * 1024 * 1024; // Default 8GB if DeviceInfo fails, we'll improve this

    for (const item of data) {
      const repoId = item.id || item.modelId;
      if (!repoId || !item.siblings) continue;

      // Find the first reasonably named GGUF file. 
      // We prefer Q4_K_M or similar if multiple exist, but any .gguf will do.
      const ggufs = item.siblings.filter(s => {
        const name = s.rfilename || s.filename || '';
        return name.toLowerCase().endsWith('.gguf');
      });

      if (ggufs.length === 0) continue;

      // Try to find a Q4/Q5 variant, otherwise just take the first one
      let ggufSibling = ggufs.find(s => (s.rfilename || '').includes('Q4_K_M')) || ggufs[0];

      const size = ggufSibling.size || ggufSibling.lfs?.size || 0;
      const fitsInRam = size > 0 ? size < totalMemory * 0.8 : true; // Assume true if size unknown
      const fileName = ggufSibling.rfilename || ggufSibling.filename || 'model.gguf';

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
}

export const modelCatalogService = new ModelCatalogService();
