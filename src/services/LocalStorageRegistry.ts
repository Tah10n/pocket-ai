import DeviceInfo from 'react-native-device-info';
import * as FileSystem from 'expo-file-system/legacy';
import type { MMKV } from 'react-native-mmkv';
import { createStorage } from './storage';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { getModelsDir } from './FileSystemSetup';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { estimateFastMemoryFit } from '../memory/estimator';
import { safeJoinModelPath } from '../utils/safeFilePath';
import type { CalibrationRecord } from '../memory/types';

const REGISTRY_STORAGE_ID = 'models-registry';

// Legacy format: one JSON array stored under the same key as the MMKV instance id.
const LEGACY_MODELS_KEY = REGISTRY_STORAGE_ID;

// Normalized format: O(1) per-model storage + compact index for ordering.
const MODELS_INDEX_KEY = 'models-registry:index-v1';
const MODEL_KEY_PREFIX = 'models-registry:model-v1:';

const CALIBRATION_RECORDS_KEY = 'memory-fit-calibration-records-v1';
const MAX_CALIBRATION_RECORDS = 200;

function cloneCalibrationRecord(record: CalibrationRecord): CalibrationRecord {
  return { ...record };
}

function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeModelIndex(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const uniqueIds = new Set<string>();
  for (const value of input) {
    const normalizedId = normalizeModelId(value);
    if (!normalizedId) {
      continue;
    }

    uniqueIds.add(normalizedId);
  }

  return [...uniqueIds];
}

function getModelStorageKey(modelId: string): string {
  return `${MODEL_KEY_PREFIX}${encodeURIComponent(modelId)}`;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeCalibrationRecord(value: unknown): CalibrationRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<CalibrationRecord>;
  if (typeof record.key !== 'string' || record.key.trim().length === 0) {
    return null;
  }

  const sampleCount = toFiniteNumber(record.sampleCount);
  const successCount = toFiniteNumber(record.successCount);
  const failureCount = toFiniteNumber(record.failureCount);
  const weightsCorrectionFactor = toFiniteNumber(record.weightsCorrectionFactor);
  const computeCorrectionFactor = toFiniteNumber(record.computeCorrectionFactor);
  const overheadCorrectionFactor = toFiniteNumber(record.overheadCorrectionFactor);
  const failurePenaltyFactor = toFiniteNumber(record.failurePenaltyFactor);
  const lastObservedAtMs = toFiniteNumber(record.lastObservedAtMs);
  const learnedSafeBudgetBytes = toFiniteNumber(record.learnedSafeBudgetBytes);

  if (
    sampleCount === null
    || successCount === null
    || failureCount === null
    || weightsCorrectionFactor === null
    || computeCorrectionFactor === null
    || overheadCorrectionFactor === null
    || failurePenaltyFactor === null
    || lastObservedAtMs === null
  ) {
    return null;
  }

  return {
    key: record.key,
    sampleCount: Math.max(0, Math.floor(sampleCount)),
    successCount: Math.max(0, Math.floor(successCount)),
    failureCount: Math.max(0, Math.floor(failureCount)),
    weightsCorrectionFactor,
    computeCorrectionFactor,
    overheadCorrectionFactor,
    failurePenaltyFactor,
    learnedSafeBudgetBytes: learnedSafeBudgetBytes === null ? undefined : learnedSafeBudgetBytes,
    lastObservedAtMs: Math.max(0, Math.floor(lastObservedAtMs)),
  };
}

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
  private cachedModelIds: string[] | null = null;
  private cachedModelsById: Map<string, ModelMetadata> | null = null;
  private cachedDownloadedModelsCount: number | null = null;
  private cachedCalibrationRecordsByKey: Map<string, CalibrationRecord> | null = null;
  private modelsRevision = 0;
  private modelsListeners: Set<() => void> = new Set();

  private constructor() {}

  public static getInstance(): LocalStorageRegistry {
    if (!LocalStorageRegistry.instance) {
      LocalStorageRegistry.instance = new LocalStorageRegistry();
    }
    return LocalStorageRegistry.instance;
  }

  private getStorage(): MMKV {
    if (!this.storage) {
      this.storage = createStorage(REGISTRY_STORAGE_ID, { tier: 'private' });
    }

    return this.storage;
  }

  /**
   * Get all models from the registry.
   */
  public getModels(): ModelMetadata[] {
    const { ids, modelsById } = this.getCachedModelsState();
    const models: ModelMetadata[] = [];

    for (const modelId of ids) {
      const model = modelsById.get(modelId);
      if (model) {
        models.push(cloneModelMetadata(model));
      }
    }

    return models;
  }

  public hasAnyDownloadedModels(): boolean {
    return this.getDownloadedModelsCount() > 0;
  }

  public getDownloadedModelsCount(): number {
    if (this.cachedDownloadedModelsCount == null) {
      this.getCachedModelsState();
    }

    return this.cachedDownloadedModelsCount ?? 0;
  }

  public getModelsRevision(): number {
    return this.modelsRevision;
  }

  public subscribeModels(listener: () => void): () => void {
    this.modelsListeners.add(listener);

    return () => {
      this.modelsListeners.delete(listener);
    };
  }

  public getCalibrationRecord(key: string): CalibrationRecord | undefined {
    const record = this.getCachedCalibrationRecords().get(key);
    return record ? cloneCalibrationRecord(record) : undefined;
  }

  public saveCalibrationRecord(record: CalibrationRecord): void {
    const normalizedKey = typeof record.key === 'string' ? record.key.trim() : '';
    if (normalizedKey.length === 0) {
      return;
    }

    const records = this.getCachedCalibrationRecords();
    records.set(normalizedKey, cloneCalibrationRecord({ ...record, key: normalizedKey }));
    this.persistCalibrationRecords(records);
  }

  /**
   * Save the entire list of models.
   */
  public saveModels(models: ModelMetadata[]): void {
    const previousState = this.getCachedModelsState();
    const nextState = this.normalizeModelsState(models);
    const removedIds = previousState.ids.filter((id) => !nextState.modelsById.has(id));

    nextState.ids.forEach((modelId) => {
      const model = nextState.modelsById.get(modelId);
      if (!model) {
        return;
      }

      this.persistModel(modelId, model);
    });

    removedIds.forEach((modelId) => {
      this.getStorage().remove(getModelStorageKey(modelId));
    });

    this.persistModelsIndex(nextState.ids);

    // Ensure the new format is the single source of truth.
    this.getStorage().remove(LEGACY_MODELS_KEY);

    this.cachedModelIds = nextState.ids;
    this.cachedModelsById = nextState.modelsById;
    this.cachedDownloadedModelsCount = nextState.downloadedCount;
    this.emitModelsChanged();
  }

  /**
   * Update a single model's metadata.
   */
  public updateModel(model: ModelMetadata): void {
    const modelId = normalizeModelId(model.id);
    if (!modelId) {
      return;
    }

    const { ids, modelsById } = this.getCachedModelsState();
    const normalized = normalizePersistedModelMetadata({ ...model, id: modelId });
    const existing = modelsById.get(modelId);
    const hadLocalPath = typeof existing?.localPath === 'string';
    const hasLocalPath = typeof normalized.localPath === 'string';

    const isNew = !modelsById.has(modelId);
    if (isNew) {
      ids.push(modelId);
    }

    modelsById.set(modelId, normalized);
    this.persistModel(modelId, normalized);

    if (isNew) {
      this.persistModelsIndex(ids);
    }

    // Ensure the new format is the single source of truth.
    this.getStorage().remove(LEGACY_MODELS_KEY);

    if (this.cachedDownloadedModelsCount == null) {
      this.cachedDownloadedModelsCount = this.countDownloadedModels(modelsById);
    } else if (hadLocalPath !== hasLocalPath) {
      this.cachedDownloadedModelsCount += hasLocalPath ? 1 : -1;
    }

    this.emitModelsChanged();
  }

  /**
   * Remove a model from the registry and delete its local files.
   */
  public async removeModel(modelId: string): Promise<void> {
    const normalizedId = normalizeModelId(modelId);
    if (!normalizedId) {
      return;
    }

    const model = this.getModel(normalizedId);
    const modelsDir = getModelsDir();
    if (model && model.localPath) {
      try {
        if (modelsDir) {
          const fileUri = safeJoinModelPath(modelsDir, model.localPath);
          if (!fileUri) {
            console.warn(`[LocalStorageRegistry] Invalid localPath for ${modelId}, skipping file deletion`);
          } else {
            const info = await FileSystem.getInfoAsync(fileUri);
            if (info.exists) {
              await FileSystem.deleteAsync(fileUri);
            }
          }
        }
      } catch (e) {
        console.error(`[LocalStorageRegistry] Failed to delete file for ${modelId}`, e);
      }
    }

    const state = this.getCachedModelsState();
    const existing = state.modelsById.get(normalizedId);
    const hadLocalPath = typeof existing?.localPath === 'string';

    state.modelsById.delete(normalizedId);
    const index = state.ids.indexOf(normalizedId);
    if (index !== -1) {
      state.ids.splice(index, 1);
    }

    this.getStorage().remove(getModelStorageKey(normalizedId));
    this.persistModelsIndex(state.ids);

    // Ensure the new format is the single source of truth.
    this.getStorage().remove(LEGACY_MODELS_KEY);

    if (this.cachedDownloadedModelsCount == null) {
      this.cachedDownloadedModelsCount = this.countDownloadedModels(state.modelsById);
    } else if (hadLocalPath) {
      this.cachedDownloadedModelsCount = Math.max(0, this.cachedDownloadedModelsCount - 1);
    }

    this.emitModelsChanged();
  }

  /**
   * Validate the registry on startup: check if files exist and update status.
   * Also performs Garbage Collection: deletes files in the models directory that are neither completed nor currently queued.
   */
  public async validateRegistry(queuedFileNames: string[] = []): Promise<void> {
    const models = this.getModels();
    const modelsDir = getModelsDir();
    const totalMemoryBytes = await this.getTotalMemory();
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
          const fileUri = safeJoinModelPath(modelsDir, model.localPath);
          if (!fileUri) {
            console.warn(`[LocalStorageRegistry] Invalid localPath for ${model.id}, resetting to available`);
            model.lifecycleStatus = LifecycleStatus.AVAILABLE;
            model.localPath = undefined;
            changed = true;
            continue;
          }
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
              totalMemoryBytes,
              metadataTrust: metadataTrustForFit,
              ggufMetadata: model.gguf as Record<string, unknown> | undefined,
            });
            const fitsInRam = fit.decision === 'unknown'
              ? null
              : fit.decision === 'fits_high_confidence' || fit.decision === 'fits_low_confidence';
            const memoryFitDecision = fit.decision;
            const memoryFitConfidence = fit.confidence;

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

            if (model.memoryFitDecision !== memoryFitDecision) {
              model.memoryFitDecision = memoryFitDecision;
              changed = true;
            }

            if (model.memoryFitConfidence !== memoryFitConfidence) {
              model.memoryFitConfidence = memoryFitConfidence;
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
        const fileUri = safeJoinModelPath(modelsDir, filename);
        if (!fileUri) {
          continue;
        }
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
    const normalizedId = normalizeModelId(modelId);
    if (!normalizedId) {
      return undefined;
    }

    const model = this.getCachedModelsState().modelsById.get(normalizedId);
    return model ? cloneModelMetadata(model) : undefined;
  }

  private getCachedCalibrationRecords(): Map<string, CalibrationRecord> {
    if (this.cachedCalibrationRecordsByKey == null) {
      this.cachedCalibrationRecordsByKey = this.readCalibrationRecordsFromStorage();
    }

    return this.cachedCalibrationRecordsByKey ?? new Map<string, CalibrationRecord>();
  }

  private getCachedModelsState(): { ids: string[]; modelsById: Map<string, ModelMetadata> } {
    if (this.cachedModelIds == null || this.cachedModelsById == null) {
      this.hydrateModelsCache();
    }

    return {
      ids: this.cachedModelIds ?? [],
      modelsById: this.cachedModelsById ?? new Map<string, ModelMetadata>(),
    };
  }

  private emitModelsChanged(): void {
    this.modelsRevision += 1;
    this.modelsListeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.warn('[LocalStorageRegistry] Model registry listener failed', error);
      }
    });
  }

  private normalizeModelsState(models: ModelMetadata[]): {
    ids: string[];
    modelsById: Map<string, ModelMetadata>;
    downloadedCount: number;
  } {
    const ids: string[] = [];
    const modelsById = new Map<string, ModelMetadata>();

    for (const model of models) {
      const modelId = normalizeModelId(model.id);
      if (!modelId) {
        continue;
      }

      const normalized = normalizePersistedModelMetadata({ ...model, id: modelId });
      if (!modelsById.has(modelId)) {
        ids.push(modelId);
      }
      modelsById.set(modelId, normalized);
    }

    return {
      ids,
      modelsById,
      downloadedCount: this.countDownloadedModels(modelsById),
    };
  }

  private countDownloadedModels(modelsById: Map<string, ModelMetadata>): number {
    let count = 0;

    for (const model of modelsById.values()) {
      if (typeof model.localPath === 'string') {
        count += 1;
      }
    }

    return count;
  }

  private persistModelsIndex(ids: string[]): void {
    if (ids.length === 0) {
      this.getStorage().remove(MODELS_INDEX_KEY);
      return;
    }

    this.getStorage().set(MODELS_INDEX_KEY, JSON.stringify(ids));
  }

  private persistModel(modelId: string, model: ModelMetadata): void {
    this.getStorage().set(getModelStorageKey(modelId), JSON.stringify(model));
  }

  private mergeModelsIndexWithStorage(index: string[]): string[] {
    const discoveredIds = this.discoverModelsIndexFromStorage();
    if (discoveredIds.length === 0) {
      return index;
    }

    const indexedIds = new Set(index);
    const extras = discoveredIds.filter((id) => !indexedIds.has(id));
    if (extras.length === 0) {
      return index;
    }

    return [...index, ...extras];
  }

  private hydrateModelsCache(): void {
    const storage = this.getStorage();

    const storedIndex = this.readModelsIndexFromStorage();
    if (storedIndex !== null) {
      const mergedIndex = this.mergeModelsIndexWithStorage(storedIndex);
      const hydrated = this.hydrateModelsFromIndex(mergedIndex);

      if (!areStringArraysEqual(hydrated.ids, storedIndex)) {
        this.persistModelsIndex(hydrated.ids);
      }

      this.cachedModelIds = hydrated.ids;
      this.cachedModelsById = hydrated.modelsById;
      this.cachedDownloadedModelsCount = hydrated.downloadedCount;
      return;
    }

    const legacyModels = this.readLegacyModelsFromStorage();
    if (legacyModels !== null) {
      const normalized = this.normalizeModelsState(legacyModels);

      // If we have legacy data, treat it as authoritative and clean up any partial migrations.
      storage
        .getAllKeys()
        .filter((key) => key.startsWith(MODEL_KEY_PREFIX))
        .forEach((key) => storage.remove(key));

      normalized.ids.forEach((modelId) => {
        const model = normalized.modelsById.get(modelId);
        if (model) {
          this.persistModel(modelId, model);
        }
      });

      this.persistModelsIndex(normalized.ids);
      storage.remove(LEGACY_MODELS_KEY);

      this.cachedModelIds = normalized.ids;
      this.cachedModelsById = normalized.modelsById;
      this.cachedDownloadedModelsCount = normalized.downloadedCount;
      return;
    }

    const discoveredIds = this.discoverModelsIndexFromStorage();
    if (discoveredIds.length > 0) {
      const hydrated = this.hydrateModelsFromIndex(discoveredIds);
      this.persistModelsIndex(hydrated.ids);

      this.cachedModelIds = hydrated.ids;
      this.cachedModelsById = hydrated.modelsById;
      this.cachedDownloadedModelsCount = hydrated.downloadedCount;
      return;
    }

    this.cachedModelIds = [];
    this.cachedModelsById = new Map();
    this.cachedDownloadedModelsCount = 0;
  }

  private readModelsIndexFromStorage(): string[] | null {
    const rawIndex = this.getStorage().getString(MODELS_INDEX_KEY);
    if (!rawIndex) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawIndex) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn('[LocalStorageRegistry] Models index is not an array, rebuilding');
        this.getStorage().remove(MODELS_INDEX_KEY);
        return null;
      }

      const sanitized = sanitizeModelIndex(parsed);
      if (parsed.length > 0 && sanitized.length === 0) {
        console.warn('[LocalStorageRegistry] Models index contains no valid ids, rebuilding');
        this.getStorage().remove(MODELS_INDEX_KEY);
        return null;
      }

      const shouldRewrite =
        sanitized.length !== parsed.length ||
        sanitized.some((id, index) => id !== parsed[index]);

      if (shouldRewrite) {
        this.persistModelsIndex(sanitized);
      }

      return sanitized;
    } catch (e) {
      console.warn('[LocalStorageRegistry] Failed to parse models index, rebuilding', e);
      this.getStorage().remove(MODELS_INDEX_KEY);
      return null;
    }
  }

  private discoverModelsIndexFromStorage(): string[] {
    const keys = this.getStorage().getAllKeys();
    const discovered: string[] = [];

    for (const key of keys) {
      if (!key.startsWith(MODEL_KEY_PREFIX)) {
        continue;
      }

      const encodedId = key.slice(MODEL_KEY_PREFIX.length);
      try {
        const decoded = decodeURIComponent(encodedId);
        const normalizedId = normalizeModelId(decoded);
        if (normalizedId) {
          discovered.push(normalizedId);
        }
      } catch {
        // Ignore malformed ids.
      }
    }

    discovered.sort((left, right) => left.localeCompare(right));
    return sanitizeModelIndex(discovered);
  }

  private hydrateModelsFromIndex(index: string[]): {
    ids: string[];
    modelsById: Map<string, ModelMetadata>;
    downloadedCount: number;
  } {
    const storage = this.getStorage();
    const modelsById = new Map<string, ModelMetadata>();
    const ids: string[] = [];

    for (const modelId of index) {
      const raw = storage.getString(getModelStorageKey(modelId));
      if (!raw) {
        continue;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') {
          continue;
        }

        const normalized = normalizePersistedModelMetadata({ ...(parsed as Partial<ModelMetadata>), id: modelId });
        modelsById.set(modelId, normalized);
        ids.push(modelId);
      } catch (e) {
        console.warn('[LocalStorageRegistry] Failed to parse model metadata, dropping entry', modelId, e);
        storage.remove(getModelStorageKey(modelId));
      }
    }

    return {
      ids,
      modelsById,
      downloadedCount: this.countDownloadedModels(modelsById),
    };
  }

  private persistCalibrationRecords(records: Map<string, CalibrationRecord>): void {
    const sorted = Array.from(records.values())
      .sort((left, right) => right.lastObservedAtMs - left.lastObservedAtMs);
    const trimmed = sorted.length > MAX_CALIBRATION_RECORDS
      ? sorted.slice(0, MAX_CALIBRATION_RECORDS)
      : sorted;
    this.getStorage().set(CALIBRATION_RECORDS_KEY, JSON.stringify(trimmed));
    this.cachedCalibrationRecordsByKey = new Map(trimmed.map((record) => [record.key, record]));
  }

  private readCalibrationRecordsFromStorage(): Map<string, CalibrationRecord> {
    const rawData = this.getStorage().getString(CALIBRATION_RECORDS_KEY);
    if (!rawData) {
      return new Map();
    }

    try {
      const parsed = JSON.parse(rawData) as unknown;
      const records = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? Object.values(parsed as Record<string, unknown>)
          : [];
      const normalized = records
        .map((entry) => normalizeCalibrationRecord(entry))
        .filter((record): record is CalibrationRecord => record !== null);
      return new Map(normalized.map((record) => [record.key, record]));
    } catch (e) {
      console.error('[LocalStorageRegistry] Failed to parse calibration records', e);
      return new Map();
    }
  }

  private readLegacyModelsFromStorage(): ModelMetadata[] | null {
    const rawData = this.getStorage().getString(LEGACY_MODELS_KEY);
    if (!rawData) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawData) as unknown;
      if (!Array.isArray(parsed)) {
        return null;
      }

      return parsed
        .filter((entry): entry is Partial<ModelMetadata> & { id: string } => (
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string'
        ))
        .map((entry) => normalizePersistedModelMetadata(entry));
    } catch (e) {
      console.error('[LocalStorageRegistry] Failed to parse legacy registry data', e);
      return null;
    }
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
}

export const registry = LocalStorageRegistry.getInstance();
