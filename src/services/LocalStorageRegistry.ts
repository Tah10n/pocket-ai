import DeviceInfo from 'react-native-device-info';
import * as FileSystem from 'expo-file-system/legacy';
import type { MMKV } from 'react-native-mmkv';
import { createStorage } from './storage';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { getModelsDir } from './FileSystemSetup';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { DEFAULT_TOTAL_MEMORY_BYTES } from '../memory/budget';
import { estimateFastMemoryFit } from '../memory/estimator';

const REGISTRY_KEY = 'models-registry';

function cloneModelMetadata(model: ModelMetadata): ModelMetadata {
  return {
    ...model,
    gguf: model.gguf ? { ...model.gguf } : undefined,
    architectures: model.architectures ? [...model.architectures] : undefined,
    baseModels: model.baseModels ? [...model.baseModels] : undefined,
    datasets: model.datasets ? [...model.datasets] : undefined,
    languages: model.languages ? [...model.languages] : undefined,
    tags: model.tags ? [...model.tags] : undefined,
  };
}

export class LocalStorageRegistry {
  private static instance: LocalStorageRegistry;
  private storage: MMKV | null = null;
  private cachedModels: ModelMetadata[] | null = null;
  private cachedModelsById: Map<string, ModelMetadata> | null = null;

  private constructor() {}

  public static getInstance(): LocalStorageRegistry {
    if (!LocalStorageRegistry.instance) {
      LocalStorageRegistry.instance = new LocalStorageRegistry();
    }
    return LocalStorageRegistry.instance;
  }

  private getStorage(): MMKV {
    if (!this.storage) {
      this.storage = createStorage(REGISTRY_KEY, { tier: 'private' });
    }

    return this.storage;
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
    this.getStorage().set(
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
    const modelsDir = getModelsDir();
    if (model && model.localPath) {
      try {
        if (modelsDir) {
          const fileUri = modelsDir + model.localPath;
          const info = await FileSystem.getInfoAsync(fileUri);
          if (info.exists) {
            await FileSystem.deleteAsync(fileUri);
          }
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
   * Also performs Garbage Collection: deletes files in the models directory that are neither completed nor currently queued.
   */
  public async validateRegistry(queuedFileNames: string[] = []): Promise<void> {
    const models = this.getModels();
    const modelsDir = getModelsDir();
    const totalMemory = await this.getTotalMemory();
    let changed = false;

    if (!modelsDir) {
      for (const model of models) {
        if (model.localPath) {
          model.localPath = undefined;
          if (
            model.lifecycleStatus === LifecycleStatus.DOWNLOADED ||
            model.lifecycleStatus === LifecycleStatus.ACTIVE
          ) {
            model.lifecycleStatus = LifecycleStatus.AVAILABLE;
          }
          changed = true;
        }
      }

      if (changed) {
        this.saveModels(models);
      }

      return;
    }

    // 1. Check if recorded files actually exist
    for (const model of models) {
      if (model.lifecycleStatus === LifecycleStatus.DOWNLOADED || model.lifecycleStatus === LifecycleStatus.ACTIVE) {
        if (model.localPath) {
          const fileUri = modelsDir + model.localPath;
          const info = await FileSystem.getInfoAsync(fileUri);
          if (!info.exists) {
            console.warn(`[LocalStorageRegistry] File missing for ${model.id}, resetting to available`);
            model.lifecycleStatus = LifecycleStatus.AVAILABLE;
            model.localPath = undefined;
            changed = true;
            continue;
          } else if (model.lifecycleStatus === LifecycleStatus.ACTIVE) {
            model.lifecycleStatus = LifecycleStatus.DOWNLOADED;
            changed = true;
          }

          const verifiedSizeBytes = (
            typeof info.size === 'number'
            && Number.isFinite(info.size)
            && info.size > 0
          )
            ? Math.round(info.size)
            : null;

          if (verifiedSizeBytes !== null && model.size !== verifiedSizeBytes) {
            model.size = verifiedSizeBytes;
            changed = true;
          }

          const persistedSizeBytes = (
            typeof model.size === 'number'
            && Number.isFinite(model.size)
            && model.size > 0
          )
            ? Math.round(model.size)
            : null;
          const sizeBytesForFit = verifiedSizeBytes ?? persistedSizeBytes;

          if (sizeBytesForFit !== null) {
            const metadataTrustForFit = verifiedSizeBytes !== null
              ? 'verified_local' as const
              : model.metadataTrust;
            const fit = estimateFastMemoryFit({
              modelSizeBytes: sizeBytesForFit,
              totalMemoryBytes: totalMemory,
              metadataTrust: metadataTrustForFit,
            });
            const fitsInRam = fit.decision === 'unknown'
              ? null
              : fit.decision === 'fits_high_confidence' || fit.decision === 'fits_low_confidence';

            if (verifiedSizeBytes !== null) {
              const metadataTrust = 'verified_local' as const;
              if (model.metadataTrust !== metadataTrust) {
                model.metadataTrust = metadataTrust;
                changed = true;
              }

              const mergedGgufTotalBytes = model.gguf?.totalBytes === verifiedSizeBytes
                ? model.gguf
                : {
                  ...(model.gguf ?? {}),
                  totalBytes: verifiedSizeBytes,
                };
              if (mergedGgufTotalBytes !== model.gguf) {
                model.gguf = mergedGgufTotalBytes;
                changed = true;
              }
            }

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
      const dirInfo = await FileSystem.readDirectoryAsync(modelsDir);

      const completedLocalPaths = new Set(
        models
          .map((model) => model.localPath)
          .filter((localPath): localPath is string => typeof localPath === 'string'),
      );
      const queuedFileNamesSet = new Set(queuedFileNames);

      for (const filename of dirInfo) {
        if (completedLocalPaths.has(filename) || queuedFileNamesSet.has(filename)) {
          continue;
        }

        // It's neither completed nor queued -> it's a dead partial download. Delete it.
        const fileUri = modelsDir + filename;
        console.log(`[LocalStorageRegistry] Garbage collecting orphaned file: ${filename}`);
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
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
    const rawData = this.getStorage().getString(REGISTRY_KEY);
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
