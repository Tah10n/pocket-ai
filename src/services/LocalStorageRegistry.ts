import DeviceInfo from 'react-native-device-info';
import * as FileSystem from 'expo-file-system/legacy';
import { createStorage } from './storage';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { MODELS_DIR } from './FileSystemSetup';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';

const REGISTRY_KEY = 'models-registry';
const FITS_IN_RAM_HEADROOM_RATIO = 0.8;
const DEFAULT_TOTAL_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;

function cloneModelMetadata(model: ModelMetadata): ModelMetadata {
  return {
    ...model,
    architectures: model.architectures ? [...model.architectures] : undefined,
    baseModels: model.baseModels ? [...model.baseModels] : undefined,
    datasets: model.datasets ? [...model.datasets] : undefined,
    languages: model.languages ? [...model.languages] : undefined,
    tags: model.tags ? [...model.tags] : undefined,
  };
}

export class LocalStorageRegistry {
  private static instance: LocalStorageRegistry;
  private storage = createStorage(REGISTRY_KEY);
  private cachedModels: ModelMetadata[] | null = null;
  private cachedModelsById: Map<string, ModelMetadata> | null = null;

  private constructor() {}

  public static getInstance(): LocalStorageRegistry {
    if (!LocalStorageRegistry.instance) {
      LocalStorageRegistry.instance = new LocalStorageRegistry();
    }
    return LocalStorageRegistry.instance;
  }

  /**
   * Get all models from the registry.
   */
  public getModels(): ModelMetadata[] {
    return this.getCachedModels().map((model) => cloneModelMetadata(model));
  }

  /**
   * Save the entire list of models.
   */
  public saveModels(models: ModelMetadata[]): void {
    const normalizedModels = models.map((model) => normalizePersistedModelMetadata(model));
    this.storage.set(
      REGISTRY_KEY,
      JSON.stringify(normalizedModels),
    );
    this.updateCache(normalizedModels);
  }

  /**
   * Update a single model's metadata.
   */
  public updateModel(model: ModelMetadata): void {
    const models = this.getModels();
    const index = models.findIndex((m) => m.id === model.id);
    const normalized = normalizePersistedModelMetadata(model);
    if (index !== -1) {
      models[index] = normalized;
    } else {
      models.push(normalized);
    }
    this.saveModels(models);
  }

  /**
   * Remove a model from the registry and delete its local files.
   */
  public async removeModel(modelId: string): Promise<void> {
    const model = this.getModel(modelId);
    if (model && model.localPath) {
      try {
        const fileUri = MODELS_DIR + model.localPath;
        const info = await FileSystem.getInfoAsync(fileUri);
        if (info.exists) {
          await FileSystem.deleteAsync(fileUri);
        }
      } catch (e) {
        console.error(`[LocalStorageRegistry] Failed to delete file for ${modelId}`, e);
      }
    }

    const models = this.getModels();
    const filtered = models.filter((m) => m.id !== modelId);
    this.saveModels(filtered);
  }

  /**
   * Validate the registry on startup: check if files exist and update status.
   * Also performs Garbage Collection: deletes files in MODELS_DIR that are neither completed nor currently queued.
   */
  public async validateRegistry(queuedFileNames: string[] = []): Promise<void> {
    const models = this.getModels();
    const totalMemory = await this.getTotalMemory();
    let changed = false;

    // 1. Check if recorded files actually exist
    for (const model of models) {
      if (model.lifecycleStatus === LifecycleStatus.DOWNLOADED || model.lifecycleStatus === LifecycleStatus.ACTIVE) {
        if (model.localPath) {
          const fileUri = MODELS_DIR + model.localPath;
          const info = await FileSystem.getInfoAsync(fileUri);
          if (!info.exists) {
            console.warn(`[LocalStorageRegistry] File missing for ${model.id}, resetting to available`);
            model.lifecycleStatus = LifecycleStatus.AVAILABLE;
            model.localPath = undefined;
            changed = true;
          } else if (model.lifecycleStatus === LifecycleStatus.ACTIVE) {
            model.lifecycleStatus = LifecycleStatus.DOWNLOADED;
            changed = true;
          }

          const resolvedSize = (
            info.exists &&
            typeof info.size === 'number' &&
            Number.isFinite(info.size) &&
            info.size > 0
          )
            ? Math.round(info.size)
            : null;

          if (resolvedSize !== null && model.size !== resolvedSize) {
            model.size = resolvedSize;
            changed = true;
          }

          if (resolvedSize !== null) {
            const fitsInRam = resolvedSize < totalMemory * FITS_IN_RAM_HEADROOM_RATIO;
            if (model.fitsInRam !== fitsInRam) {
              model.fitsInRam = fitsInRam;
              changed = true;
            }
          }
        }
      }
    }

    if (changed) {
      this.saveModels(models);
    }

    // 2. Garbage Collection: clean up orphaned files
    try {
      const dirInfo = await FileSystem.readDirectoryAsync(MODELS_DIR);
      
      for (const filename of dirInfo) {
        // Find if this file belongs to a completed model
        const isCompleted = models.some(m => m.localPath === filename);
        
        if (!isCompleted) {
          const isQueued = queuedFileNames.includes(filename);

          if (!isQueued) {
            // It's neither completed nor queued -> it's a dead partial download. Delete it.
            const fileUri = MODELS_DIR + filename;
            console.log(`[LocalStorageRegistry] Garbage collecting orphaned file: ${filename}`);
            await FileSystem.deleteAsync(fileUri, { idempotent: true });
          }
        }
      }
    } catch (e) {
      console.warn('[LocalStorageRegistry] Garbage collection failed', e);
    }
  }

  /**
   * Get a specific model by ID.
   */
  public getModel(modelId: string): ModelMetadata | undefined {
    const model = this.getCachedModelsById().get(modelId);
    return model ? cloneModelMetadata(model) : undefined;
  }

  private getCachedModels(): ModelMetadata[] {
    if (this.cachedModels === null) {
      this.updateCache(this.readModelsFromStorage());
    }

    return this.cachedModels ?? [];
  }

  private getCachedModelsById(): Map<string, ModelMetadata> {
    if (this.cachedModelsById === null) {
      this.updateCache(this.readModelsFromStorage());
    }

    return this.cachedModelsById ?? new Map<string, ModelMetadata>();
  }

  private updateCache(models: ModelMetadata[]): void {
    this.cachedModels = models.map((model) => cloneModelMetadata(model));
    this.cachedModelsById = new Map(this.cachedModels.map((model) => [model.id, model]));
  }

  private readModelsFromStorage(): ModelMetadata[] {
    const rawData = this.storage.getString(REGISTRY_KEY);
    if (!rawData) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawData) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((entry): entry is Partial<ModelMetadata> & { id: string } => (
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string'
        ))
        .map((entry) => normalizePersistedModelMetadata(entry));
    } catch (e) {
      console.error('[LocalStorageRegistry] Failed to parse registry data', e);
      return [];
    }
  }

  private async getTotalMemory(): Promise<number> {
    try {
      return await DeviceInfo.getTotalMemory();
    } catch {
      return DEFAULT_TOTAL_MEMORY_BYTES;
    }
  }
}

export const registry = LocalStorageRegistry.getInstance();
