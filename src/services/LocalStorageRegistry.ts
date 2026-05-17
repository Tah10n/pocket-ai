import DeviceInfo from 'react-native-device-info';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import type { MMKV } from 'react-native-mmkv';
import { assertPrivateStorageWritable, createStorage } from './storage';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { getModelsDir } from './FileSystemSetup';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { estimateFastMemoryFit } from '../memory/estimator';
import { fileUriToNativePath, isValidLocalFileName, safeJoinModelPath } from '../utils/safeFilePath';
import { GgufValidationError, validateGgufFileHeader } from '../utils/ggufValidation';
import type { CalibrationRecord } from '../memory/types';

const REGISTRY_STORAGE_ID = 'models-registry';
const MODEL_FILE_PRESERVATION_STORAGE_ID = 'model-file-preservation';
const PRIVATE_RESET_PRESERVED_MODEL_FILES_KEY = 'private-reset-preserved-model-files-v1';
const QUARANTINED_MODEL_FILES_KEY = 'quarantined-model-files-v1';

// Legacy format: one JSON array stored under the same key as the MMKV instance id.
const LEGACY_MODELS_KEY = REGISTRY_STORAGE_ID;

// Normalized format: O(1) per-model storage + compact index for ordering.
const MODELS_INDEX_KEY = 'models-registry:index-v1';
const MODEL_KEY_PREFIX = 'models-registry:model-v1:';

const CALIBRATION_RECORDS_KEY = 'memory-fit-calibration-records-v1';
const MAX_CALIBRATION_RECORDS = 200;

let modelFilePreservationStorage: MMKV | null = null;

type PrivateResetModelFilePreservationState = {
  fileNames: Set<string>;
  scanComplete: boolean;
};

type QuarantinedModelFile = {
  fileName: string;
  detectedAt: number;
  reason: 'orphaned';
};

type QueuedModelFileNamesInput = string[] | (() => string[]);

type ModelDirectoryEntryInspection =
  | { kind: 'file'; fileUri: string }
  | { kind: 'directory' | 'missing' | 'unknown'; fileUri?: string };

function cloneCalibrationRecord(record: CalibrationRecord): CalibrationRecord {
  return { ...record };
}

function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getModelFilePreservationStorage(): MMKV {
  if (modelFilePreservationStorage) {
    return modelFilePreservationStorage;
  }

  const created = createStorage(MODEL_FILE_PRESERVATION_STORAGE_ID, { tier: 'cache' });
  modelFilePreservationStorage = created;
  return created;
}

function normalizeModelFileNames(input: unknown): Set<string> {
  const values = Array.isArray(input) ? input : [];
  return new Set(values.filter(isValidLocalFileName));
}

function isFileSystemDirectory(info: { isDirectory?: boolean }): boolean {
  return info.isDirectory === true;
}

function getFileInfoSizeBytes(info: { size?: number }): number | null {
  return (
    typeof info.size === 'number'
    && Number.isFinite(info.size)
    && info.size > 0
  )
    ? Math.round(info.size)
    : null;
}

function getValidDownloadIntegritySizeBytes(
  marker: ModelMetadata['downloadIntegrity'],
): number | null {
  if (!marker || (marker.kind !== 'size' && marker.kind !== 'sha256')) {
    return null;
  }

  if (marker.kind === 'sha256' && (typeof marker.sha256 !== 'string' || marker.sha256.trim().length === 0)) {
    return null;
  }

  return (
    typeof marker.sizeBytes === 'number'
    && Number.isFinite(marker.sizeBytes)
    && marker.sizeBytes > 0
    && typeof marker.checkedAt === 'number'
    && Number.isFinite(marker.checkedAt)
  )
    ? Math.round(marker.sizeBytes)
    : null;
}

function normalizeSha256Digest(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith('sha256:')
    ? trimmed.slice('sha256:'.length)
    : trimmed;
}

async function verifySha256IntegrityMarker(
  fileUri: string,
  marker: ModelMetadata['downloadIntegrity'],
): Promise<'match' | 'mismatch' | 'unavailable'> {
  if (!marker || marker.kind !== 'sha256') {
    return 'unavailable';
  }

  const expectedHash = normalizeSha256Digest(marker.sha256);
  if (!expectedHash) {
    return 'mismatch';
  }

  try {
    const actualHash = normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(fileUri), 'sha256'));
    return actualHash === expectedHash ? 'match' : 'mismatch';
  } catch (error) {
    console.warn('[LocalStorageRegistry] Failed to hash local model file during registry validation', error);
    return 'unavailable';
  }
}

function clearVerifiedLocalDerivedMetadata(model: ModelMetadata): boolean {
  let changed = false;

  if (model.metadataTrust === 'verified_local') {
    model.metadataTrust = undefined;
    changed = true;
  }

  if (model.gguf !== undefined) {
    model.gguf = undefined;
    changed = true;
  }

  if (model.fitsInRam !== null) {
    model.fitsInRam = null;
    changed = true;
  }

  if (model.memoryFitDecision !== undefined) {
    model.memoryFitDecision = undefined;
    changed = true;
  }

  if (model.memoryFitConfidence !== undefined) {
    model.memoryFitConfidence = undefined;
    changed = true;
  }

  return changed;
}

function resolveQueuedModelFileNames(input: QueuedModelFileNamesInput): string[] {
  return typeof input === 'function' ? input() : input;
}

async function inspectModelDirectoryEntry(
  modelsDir: string,
  fileName: string,
  scope: string,
): Promise<ModelDirectoryEntryInspection> {
  const fileUri = safeJoinModelPath(modelsDir, fileName);
  if (!fileUri) {
    return { kind: 'unknown' };
  }

  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      return { kind: 'missing', fileUri };
    }

    if (isFileSystemDirectory(info)) {
      return { kind: 'directory', fileUri };
    }

    return { kind: 'file', fileUri };
  } catch (error) {
    console.warn(
      `[LocalStorageRegistry] Failed to inspect model directory entry during ${scope}: ${fileName}`,
      error,
    );
    return { kind: 'unknown', fileUri };
  }
}

function readPrivateResetPreservedModelFiles(): PrivateResetModelFilePreservationState {
  const raw = getModelFilePreservationStorage().getString(PRIVATE_RESET_PRESERVED_MODEL_FILES_KEY);
  if (!raw) {
    return {
      fileNames: new Set(),
      scanComplete: true,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        fileNames: normalizeModelFileNames(parsed),
        scanComplete: true,
      };
    }

    const state = parsed as {
      fileNames?: unknown;
      scanComplete?: unknown;
    };

    return {
      fileNames: normalizeModelFileNames(state.fileNames),
      scanComplete: state.scanComplete !== false,
    };
  } catch {
    getModelFilePreservationStorage().remove(PRIVATE_RESET_PRESERVED_MODEL_FILES_KEY);
    return {
      fileNames: new Set(),
      scanComplete: true,
    };
  }
}

function writePrivateResetPreservedModelFiles(state: PrivateResetModelFilePreservationState): void {
  const fileNames = Array.from(state.fileNames).sort((left, right) => left.localeCompare(right));
  if (state.scanComplete && fileNames.length === 0) {
    getModelFilePreservationStorage().remove(PRIVATE_RESET_PRESERVED_MODEL_FILES_KEY);
    return;
  }

  getModelFilePreservationStorage().set(
    PRIVATE_RESET_PRESERVED_MODEL_FILES_KEY,
    JSON.stringify({
      fileNames,
      scanComplete: state.scanComplete,
      updatedAt: Date.now(),
    }),
  );
}

function readQuarantinedModelFiles(): Map<string, QuarantinedModelFile> {
  const raw = getModelFilePreservationStorage().getString(QUARANTINED_MODEL_FILES_KEY);
  if (!raw) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)
        ? (parsed as { files: unknown[] }).files
        : [];

    const quarantined = new Map<string, QuarantinedModelFile>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const fileName = record.fileName;
      if (!isValidLocalFileName(fileName)) {
        continue;
      }

      const detectedAt = typeof record.detectedAt === 'number' && Number.isFinite(record.detectedAt)
        ? Math.max(0, Math.round(record.detectedAt))
        : Date.now();
      quarantined.set(fileName, { fileName, detectedAt, reason: 'orphaned' });
    }

    return quarantined;
  } catch {
    getModelFilePreservationStorage().remove(QUARANTINED_MODEL_FILES_KEY);
    return new Map();
  }
}

function writeQuarantinedModelFiles(filesByName: Map<string, QuarantinedModelFile>): void {
  const files = Array.from(filesByName.values())
    .filter((entry) => isValidLocalFileName(entry.fileName))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));

  if (files.length === 0) {
    getModelFilePreservationStorage().remove(QUARANTINED_MODEL_FILES_KEY);
    return;
  }

  getModelFilePreservationStorage().set(
    QUARANTINED_MODEL_FILES_KEY,
    JSON.stringify({ files }),
  );
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
    capabilitySnapshot: model.capabilitySnapshot ? { ...model.capabilitySnapshot } : undefined,
    downloadIntegrity: model.downloadIntegrity ? { ...model.downloadIntegrity } : undefined,
    gguf: model.gguf ? { ...model.gguf } : undefined,
    thinkingCapability: model.thinkingCapability ? { ...model.thinkingCapability } : undefined,
    architectures: model.architectures ? [...model.architectures] : undefined,
    baseModels: model.baseModels ? [...model.baseModels] : undefined,
    datasets: model.datasets ? [...model.datasets] : undefined,
    languages: model.languages ? [...model.languages] : undefined,
    tags: model.tags ? [...model.tags] : undefined,
  };
}

function resetLocalDownloadState(model: ModelMetadata): void {
  clearVerifiedLocalDerivedMetadata(model);

  model.lifecycleStatus = LifecycleStatus.AVAILABLE;
  model.localPath = undefined;
  model.downloadedAt = undefined;
  model.downloadIntegrity = undefined;
  model.resumeData = undefined;
  model.downloadErrorAt = undefined;
  model.downloadErrorCode = undefined;
  model.downloadErrorMessage = undefined;
  model.downloadProgress = 0;
}

function hasCompletedLocalModelFile(model: Pick<ModelMetadata, 'lifecycleStatus' | 'localPath'>): boolean {
  return (
    (model.lifecycleStatus === LifecycleStatus.DOWNLOADED
      || model.lifecycleStatus === LifecycleStatus.ACTIVE)
    && typeof model.localPath === 'string'
  );
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
    if (this.storage) {
      assertPrivateStorageWritable();
      return this.storage;
    }

    const created = createStorage(REGISTRY_STORAGE_ID, { tier: 'private' });
    this.storage = created;
    return created;
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

  public invalidatePrivateStorageRuntimeHandle(): void {
    this.storage = null;
  }

  public invalidatePrivateStorageRuntimeState(): void {
    this.invalidatePrivateStorageRuntimeHandle();
    this.cachedModelIds = [];
    this.cachedModelsById = new Map<string, ModelMetadata>();
    this.cachedDownloadedModelsCount = 0;
    this.cachedCalibrationRecordsByKey = new Map<string, CalibrationRecord>();
    this.emitModelsChanged();
  }

  public async preserveExistingModelFilesForPrivateStorageReset(): Promise<string[]> {
    const currentState = readPrivateResetPreservedModelFiles();
    const modelsDir = getModelsDir();

    if (!modelsDir) {
      writePrivateResetPreservedModelFiles({
        fileNames: currentState.fileNames,
        scanComplete: false,
      });
      return Array.from(currentState.fileNames).sort((left, right) => left.localeCompare(right));
    }

    try {
      const fileNames = normalizeModelFileNames(await FileSystem.readDirectoryAsync(modelsDir));
      const nextFileNames = new Set([...currentState.fileNames, ...fileNames]);
      writePrivateResetPreservedModelFiles({
        fileNames: nextFileNames,
        scanComplete: true,
      });
      return Array.from(nextFileNames).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      console.warn('[LocalStorageRegistry] Failed to snapshot model files before private storage reset; suspending orphan cleanup until the next registry validation can rescan.', error);
      writePrivateResetPreservedModelFiles({
        fileNames: currentState.fileNames,
        scanComplete: false,
      });
      return Array.from(currentState.fileNames).sort((left, right) => left.localeCompare(right));
    }
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

    assertPrivateStorageWritable();
    const records = new Map(this.getCachedCalibrationRecords());
    records.set(normalizedKey, cloneCalibrationRecord({ ...record, key: normalizedKey }));
    this.persistCalibrationRecords(records);
  }

  /**
   * Save the entire list of models.
   */
  public saveModels(models: ModelMetadata[]): void {
    assertPrivateStorageWritable();
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

    assertPrivateStorageWritable();
    const { ids, modelsById } = this.getCachedModelsState();
    const normalized = normalizePersistedModelMetadata({ ...model, id: modelId });
    const existing = modelsById.get(modelId);
    const hadCompletedLocalFile = existing ? hasCompletedLocalModelFile(existing) : false;
    const hasCompletedLocalFile = hasCompletedLocalModelFile(normalized);
    const isNew = !modelsById.has(modelId);
    const nextIds = isNew ? [...ids, modelId] : ids.slice();
    const nextModelsById = new Map(modelsById);
    nextModelsById.set(modelId, normalized);

    this.persistModel(modelId, normalized);

    if (isNew) {
      this.persistModelsIndex(nextIds);
    }

    // Ensure the new format is the single source of truth.
    this.getStorage().remove(LEGACY_MODELS_KEY);

    this.cachedModelIds = nextIds;
    this.cachedModelsById = nextModelsById;
    this.cachedDownloadedModelsCount = this.cachedDownloadedModelsCount == null
      ? this.countDownloadedModels(nextModelsById)
      : this.cachedDownloadedModelsCount + (
        hadCompletedLocalFile === hasCompletedLocalFile
          ? 0
          : hasCompletedLocalFile ? 1 : -1
      );

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

    assertPrivateStorageWritable();
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
            if (info.exists && !isFileSystemDirectory(info)) {
              await FileSystem.deleteAsync(fileUri);
            } else if (info.exists) {
              console.warn(`[LocalStorageRegistry] Local path for ${modelId} points to a directory, skipping file deletion`);
            }
          }
        }
      } catch (e) {
        console.error(`[LocalStorageRegistry] Failed to delete file for ${modelId}`, e);
      }
    }

    const state = this.getCachedModelsState();
    const existing = state.modelsById.get(normalizedId);
    const hadCompletedLocalFile = existing ? hasCompletedLocalModelFile(existing) : false;
    const nextModelsById = new Map(state.modelsById);
    const nextIds = state.ids.filter((id) => id !== normalizedId);

    nextModelsById.delete(normalizedId);

    this.getStorage().remove(getModelStorageKey(normalizedId));
    this.persistModelsIndex(nextIds);

    // Ensure the new format is the single source of truth.
    this.getStorage().remove(LEGACY_MODELS_KEY);

    this.cachedModelIds = nextIds;
    this.cachedModelsById = nextModelsById;
    this.cachedDownloadedModelsCount = this.cachedDownloadedModelsCount == null
      ? this.countDownloadedModels(nextModelsById)
      : hadCompletedLocalFile
        ? Math.max(0, this.cachedDownloadedModelsCount - 1)
        : this.cachedDownloadedModelsCount;

    this.emitModelsChanged();
  }

  /**
   * Validate the registry on startup: check if files exist and update status.
   * Also quarantines files in the models directory that are neither completed nor currently queued.
   */
  public async validateRegistry(queuedFileNames: string[] = []): Promise<void> {
    const models = this.getModels();
    const modelsDir = getModelsDir();
    const totalMemoryBytes = await this.getTotalMemory();
    let changed = false;

    if (!modelsDir) {
      for (const model of models) {
        const hasDownloadedState = model.lifecycleStatus === LifecycleStatus.DOWNLOADED
          || model.lifecycleStatus === LifecycleStatus.ACTIVE;
        if (model.localPath || hasDownloadedState) {
          resetLocalDownloadState(model);
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
      const hasDownloadedState = model.lifecycleStatus === LifecycleStatus.DOWNLOADED
        || model.lifecycleStatus === LifecycleStatus.ACTIVE;

      if (!hasDownloadedState && model.localPath) {
        resetLocalDownloadState(model);
        changed = true;
        continue;
      }

      if (hasDownloadedState) {
        if (!model.localPath) {
          console.warn(`[LocalStorageRegistry] Missing localPath for ${model.id}, resetting to available`);
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }

        const fileUri = safeJoinModelPath(modelsDir, model.localPath);
        if (!fileUri) {
          console.warn(`[LocalStorageRegistry] Invalid localPath for ${model.id}, resetting to available`);
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }
        const info = await FileSystem.getInfoAsync(fileUri);
        if (!info.exists) {
          console.warn(`[LocalStorageRegistry] File missing for ${model.id}, resetting to available`);
          resetLocalDownloadState(model);
          changed = true;
          continue;
        } else if (isFileSystemDirectory(info)) {
          console.warn(`[LocalStorageRegistry] Local path for ${model.id} points to a directory, resetting to available`);
          resetLocalDownloadState(model);
          changed = true;
          continue;
        } else if (model.lifecycleStatus === LifecycleStatus.ACTIVE) {
          model.lifecycleStatus = LifecycleStatus.DOWNLOADED;
          changed = true;
        }

        const fileSizeBytes = getFileInfoSizeBytes(info);

        const integritySizeBytes = getValidDownloadIntegritySizeBytes(model.downloadIntegrity);
        const hasMatchingIntegrityMarker = integritySizeBytes !== null
          && fileSizeBytes !== null
          && fileSizeBytes === integritySizeBytes;
        if (integritySizeBytes !== null && !hasMatchingIntegrityMarker) {
          console.warn(`[LocalStorageRegistry] Integrity marker size mismatch for ${model.id}, resetting to available`);
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }

        let localSizeBytesForRegistry = fileSizeBytes;
        try {
          const ggufValidation = await validateGgufFileHeader(fileUri, info);
          localSizeBytesForRegistry = ggufValidation.sizeBytes;
        } catch (error) {
          if (error instanceof GgufValidationError && error.reason === 'read_failed') {
            console.warn(`[LocalStorageRegistry] Local GGUF validation could not read ${model.id}, preserving downloaded state`, error);
            changed = clearVerifiedLocalDerivedMetadata(model) || changed;
            continue;
          }

          console.warn(`[LocalStorageRegistry] Local GGUF validation failed for ${model.id}, resetting to available`, error);
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }

        const sha256IntegrityResult = model.downloadIntegrity?.kind === 'sha256' && hasMatchingIntegrityMarker
          ? await verifySha256IntegrityMarker(fileUri, model.downloadIntegrity)
          : 'unavailable';
        if (sha256IntegrityResult === 'mismatch') {
          console.warn(`[LocalStorageRegistry] SHA-256 integrity marker mismatch for ${model.id}, resetting to available`);
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }
        if (sha256IntegrityResult === 'unavailable' && model.downloadIntegrity?.kind === 'sha256' && hasMatchingIntegrityMarker) {
          changed = clearVerifiedLocalDerivedMetadata(model) || changed;
          continue;
        }

        const hasTrustedIntegrityMarker = hasMatchingIntegrityMarker && sha256IntegrityResult === 'match';

        if (!hasTrustedIntegrityMarker && model.metadataTrust === 'verified_local') {
          changed = clearVerifiedLocalDerivedMetadata(model) || changed;
        }

        if (localSizeBytesForRegistry !== null && model.size !== localSizeBytesForRegistry) {
          model.size = localSizeBytesForRegistry;
          changed = true;
        }

        const persistedSizeBytes = (
          typeof model.size === 'number'
          && Number.isFinite(model.size)
          && model.size > 0
        )
          ? Math.round(model.size)
          : null;
        const sizeBytesForFit = localSizeBytesForRegistry ?? persistedSizeBytes;

        if (sizeBytesForFit !== null) {
          const metadataTrustForFit = hasTrustedIntegrityMarker
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

          if (hasTrustedIntegrityMarker && localSizeBytesForRegistry !== null) {
            const metadataTrust = 'verified_local' as const;
            if (model.metadataTrust !== metadataTrust) {
              model.metadataTrust = metadataTrust;
              changed = true;
            }

            const mergedGgufTotalBytes = model.gguf?.totalBytes === localSizeBytesForRegistry
              ? model.gguf
              : {
                ...(model.gguf ?? {}),
                totalBytes: localSizeBytesForRegistry,
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

    if (changed) {
      this.saveModels(models);
    }

    // 2. Quarantine orphaned files instead of deleting them automatically.
    try {
      const dirInfo = await FileSystem.readDirectoryAsync(modelsDir);

      const {
        currentSafeDirectoryFileNames,
        protectedFileNames,
      } = this.getProtectedModelFileNamesForCleanup(dirInfo, queuedFileNames, models);
      const quarantinedFileNames = readQuarantinedModelFiles();
      const entryInspectionCache = new Map<string, ModelDirectoryEntryInspection>();
      const inspectEntry = async (fileName: string) => {
        let inspection = entryInspectionCache.get(fileName);
        if (!inspection) {
          inspection = await inspectModelDirectoryEntry(modelsDir, fileName, 'orphan quarantine scan');
          entryInspectionCache.set(fileName, inspection);
        }

        return inspection;
      };
      let quarantineChanged = false;

      for (const fileName of Array.from(quarantinedFileNames.keys())) {
        if (
          !currentSafeDirectoryFileNames.has(fileName)
          || protectedFileNames.has(fileName)
        ) {
          quarantinedFileNames.delete(fileName);
          quarantineChanged = true;
          continue;
        }

        const inspection = await inspectEntry(fileName);
        if (inspection.kind === 'missing' || inspection.kind === 'directory') {
          quarantinedFileNames.delete(fileName);
          quarantineChanged = true;
        }
      }

      for (const filename of dirInfo) {
        if (!currentSafeDirectoryFileNames.has(filename) || protectedFileNames.has(filename)) {
          continue;
        }

        // It is neither completed nor queued, so hold it for explicit cleanup.
        const inspection = await inspectEntry(filename);
        if (inspection.kind !== 'file') {
          continue;
        }
        if (!quarantinedFileNames.has(filename)) {
          console.warn(`[LocalStorageRegistry] Quarantining orphaned model file: ${filename}`);
          quarantinedFileNames.set(filename, {
            fileName: filename,
            detectedAt: Date.now(),
            reason: 'orphaned',
          });
          quarantineChanged = true;
        }
      }

      if (quarantineChanged) {
        writeQuarantinedModelFiles(quarantinedFileNames);
      }
    } catch (e) {
      console.warn('[LocalStorageRegistry] Orphan quarantine scan failed', e);
    }
  }

  public getQuarantinedModelFileNames(): string[] {
    return Array.from(readQuarantinedModelFiles().keys())
      .sort((left, right) => left.localeCompare(right));
  }

  public async deleteQuarantinedModelFiles(
    fileNames?: string[],
    queuedFileNames: QueuedModelFileNamesInput = [],
  ): Promise<number> {
    const modelsDir = getModelsDir();
    if (!modelsDir) {
      return 0;
    }

    const dirInfo = await FileSystem.readDirectoryAsync(modelsDir);
    const currentSafeDirectoryFileNames = normalizeModelFileNames(dirInfo);
    const quarantinedFileNames = readQuarantinedModelFiles();
    const requestedFileNames = fileNames
      ? normalizeModelFileNames(fileNames)
      : new Set(quarantinedFileNames.keys());
    let deletedCount = 0;
    let changed = false;

    for (const fileName of requestedFileNames) {
      if (!quarantinedFileNames.has(fileName)) {
        continue;
      }

      const { protectedFileNames } = this.getProtectedModelFileNamesForCleanup(
        dirInfo,
        resolveQueuedModelFileNames(queuedFileNames),
      );
      if (!currentSafeDirectoryFileNames.has(fileName) || protectedFileNames.has(fileName)) {
        quarantinedFileNames.delete(fileName);
        changed = true;
        continue;
      }

      const inspection = await inspectModelDirectoryEntry(modelsDir, fileName, 'quarantined model cleanup');
      if (inspection.kind === 'missing' || inspection.kind === 'directory') {
        quarantinedFileNames.delete(fileName);
        changed = true;
        continue;
      }
      if (inspection.kind !== 'file') {
        continue;
      }

      await FileSystem.deleteAsync(inspection.fileUri, { idempotent: true });
      quarantinedFileNames.delete(fileName);
      deletedCount += 1;
      changed = true;
    }

    if (changed) {
      writeQuarantinedModelFiles(quarantinedFileNames);
    }

    return deletedCount;
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

  private getProtectedModelFileNamesForCleanup(
    directoryFileNames: string[],
    queuedFileNames: string[],
    models: ModelMetadata[] = this.getModels(),
  ): {
    currentSafeDirectoryFileNames: Set<string>;
    protectedFileNames: Set<string>;
  } {
    const currentSafeDirectoryFileNames = normalizeModelFileNames(directoryFileNames);
    const completedLocalPaths = new Set(
      models
        .filter(hasCompletedLocalModelFile)
        .map((model) => model.localPath)
        .filter((localPath): localPath is string => isValidLocalFileName(localPath)),
    );
    const queuedFileNamesSet = normalizeModelFileNames(queuedFileNames);
    const privateResetPreservedFileNames = this.getPreservedModelFileNamesForCleanup(
      directoryFileNames,
      completedLocalPaths,
    );

    return {
      currentSafeDirectoryFileNames,
      protectedFileNames: new Set([
        ...completedLocalPaths,
        ...queuedFileNamesSet,
        ...privateResetPreservedFileNames,
      ]),
    };
  }

  private getPreservedModelFileNamesForCleanup(
    directoryFileNames: string[],
    completedLocalPaths: Set<string>,
  ): Set<string> {
    const state = readPrivateResetPreservedModelFiles();
    const safeDirectoryFileNames = normalizeModelFileNames(directoryFileNames);
    const nextFileNames = new Set<string>();

    if (!state.scanComplete) {
      for (const fileName of safeDirectoryFileNames) {
        state.fileNames.add(fileName);
      }
    }

    for (const fileName of state.fileNames) {
      if (!safeDirectoryFileNames.has(fileName)) {
        continue;
      }

      if (completedLocalPaths.has(fileName)) {
        continue;
      }

      nextFileNames.add(fileName);
    }

    const shouldPersist =
      !state.scanComplete
      || nextFileNames.size !== state.fileNames.size
      || [...nextFileNames].some((fileName) => !state.fileNames.has(fileName));

    if (shouldPersist) {
      writePrivateResetPreservedModelFiles({
        fileNames: nextFileNames,
        scanComplete: true,
      });
    }

    return nextFileNames;
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
      if (hasCompletedLocalModelFile(model)) {
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
