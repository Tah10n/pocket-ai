import * as FileSystem from 'expo-file-system/legacy';
import { createStorage } from './storage';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { MODELS_DIR } from './FileSystemSetup';
import { useDownloadStore } from '../store/downloadStore';

const REGISTRY_KEY = 'models-registry';

export class LocalStorageRegistry {
  private static instance: LocalStorageRegistry;
  private storage = createStorage(REGISTRY_KEY);

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
    const rawData = this.storage.getString(REGISTRY_KEY);
    if (!rawData) return [];
    try {
      return JSON.parse(rawData);
    } catch (e) {
      console.error('[LocalStorageRegistry] Failed to parse registry data', e);
      return [];
    }
  }

  /**
   * Save the entire list of models.
   */
  public saveModels(models: ModelMetadata[]): void {
    this.storage.set(REGISTRY_KEY, JSON.stringify(models));
  }

  /**
   * Update a single model's metadata.
   */
  public updateModel(model: ModelMetadata): void {
    const models = this.getModels();
    const index = models.findIndex((m) => m.id === model.id);
    if (index !== -1) {
      models[index] = model;
    } else {
      models.push(model);
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
  public async validateRegistry(): Promise<void> {
    const models = this.getModels();
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
          // If it's not a completed model, check if it's currently in the download queue
          // We can reconstruct the expected filename from the queued model's ID
          const queue = useDownloadStore.getState().queue;
          
          const isQueued = queue.some((q: ModelMetadata) => {
            const expectedFileName = q.id.replace(/\//g, '_') + '.gguf';
            return expectedFileName === filename;
          });

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
    return this.getModels().find((m) => m.id === modelId);
  }
}

export const registry = LocalStorageRegistry.getInstance();
