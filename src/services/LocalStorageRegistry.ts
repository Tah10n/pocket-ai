import DeviceInfo from 'react-native-device-info';
import * as FileSystem from 'expo-file-system/legacy';
import type { MMKV } from 'react-native-mmkv';
import { assertPrivateStorageWritable, createStorage } from './storage';
import { ModelMetadata, LifecycleStatus, type ModelVariant } from '../types/models';
import type { MultimodalReadinessState, ProjectorArtifact } from '../types/multimodal';
import { getModelsDir } from './FileSystemSetup';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { estimateFastMemoryFit } from '../memory/estimator';
import { isValidLocalFileName, safeJoinModelPath } from '../utils/safeFilePath';
import { GgufValidationError, validateGgufFileHeader } from '../utils/ggufValidation';
import { normalizeSha256Digest } from '../utils/sha256';
import type { CalibrationRecord } from '../memory/types';
import { getModelMemoryFitInputSizeBytes } from '../utils/memoryFit';
import { getStoredProjectorMemoryFitSizeBytes } from '../utils/modelSize';

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
  completedOnly: boolean;
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

function cloneProjectorArtifact(projector: ProjectorArtifact): ProjectorArtifact {
  return { ...projector };
}

function cloneMultimodalReadinessState(readiness: MultimodalReadinessState): MultimodalReadinessState {
  return {
    ...readiness,
    support: [...readiness.support],
  };
}

function cloneModelVariant(variant: ModelVariant): ModelVariant {
  return {
    ...variant,
    chatModalities: variant.chatModalities ? [...variant.chatModalities] : undefined,
    projectorCandidates: variant.projectorCandidates?.map(cloneProjectorArtifact),
  };
}

function getSanitizedRegistryErrorDetails(error: unknown): { errorName: string } | { errorType: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name,
    };
  }

  return { errorType: typeof error };
}

function getModelStorageLogDetails(scope: string): { pathCategory: 'model_storage'; scope: string } {
  return { pathCategory: 'model_storage', scope };
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

  if (marker.kind === 'sha256' && normalizeSha256Digest(marker.sha256) === undefined) {
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

function getSha256IntegrityMarkerDigest(marker: ModelMetadata['downloadIntegrity']): string | undefined {
  return marker?.kind === 'sha256'
    ? normalizeSha256Digest(marker.sha256)
    : undefined;
}

function getModelSha256Digest(model: Pick<ModelMetadata, 'sha256'>): string | undefined {
  return normalizeSha256Digest(model.sha256);
}

function hasMatchingExpectedSha256IntegrityMarker(model: ModelMetadata): boolean {
  const markerDigest = getSha256IntegrityMarkerDigest(model.downloadIntegrity);
  const expectedDigest = getModelSha256Digest(model);
  return markerDigest !== undefined && expectedDigest !== undefined && markerDigest === expectedDigest;
}

function clearVerifiedLocalDerivedMetadata(model: ModelMetadata): boolean {
  let changed = false;
  const shouldClearDerivedMetadata = model.metadataTrust === 'verified_local' || model.metadataTrust == null;

  if (model.metadataTrust === 'verified_local') {
    model.metadataTrust = undefined;
    changed = true;
  }

  if (!shouldClearDerivedMetadata) {
    return changed;
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

  if (model.maxContextTokens !== undefined) {
    model.maxContextTokens = undefined;
    changed = true;
  }

  if (model.hasVerifiedContextWindow !== undefined) {
    model.hasVerifiedContextWindow = undefined;
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
      '[LocalStorageRegistry] Failed to inspect model directory entry',
      {
        ...getModelStorageLogDetails(scope),
        ...getSanitizedRegistryErrorDetails(error),
      },
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
      completedOnly: true,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        fileNames: normalizeModelFileNames(parsed),
        scanComplete: true,
        completedOnly: false,
      };
    }

    const state = parsed as {
      fileNames?: unknown;
      scanComplete?: unknown;
      completedOnly?: unknown;
    };

    return {
      fileNames: normalizeModelFileNames(state.fileNames),
      scanComplete: state.scanComplete !== false,
      completedOnly: state.completedOnly === true,
    };
  } catch {
    getModelFilePreservationStorage().remove(PRIVATE_RESET_PRESERVED_MODEL_FILES_KEY);
    return {
      fileNames: new Set(),
      scanComplete: true,
      completedOnly: true,
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
      completedOnly: state.completedOnly,
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
    variants: model.variants?.map(cloneModelVariant),
    chatModalities: model.chatModalities ? [...model.chatModalities] : undefined,
    projectorCandidates: model.projectorCandidates?.map(cloneProjectorArtifact),
    multimodalReadiness: model.multimodalReadiness
      ? cloneMultimodalReadinessState(model.multimodalReadiness)
      : undefined,
  };
}

function hasCompletedProjectorStatus(projector: Pick<ProjectorArtifact, 'lifecycleStatus'>): boolean {
  return projector.lifecycleStatus === 'downloaded' || projector.lifecycleStatus === 'active';
}

function hasResumableProjectorStatus(projector: Pick<ProjectorArtifact, 'lifecycleStatus'>): boolean {
  return projector.lifecycleStatus === 'queued'
    || projector.lifecycleStatus === 'downloading'
    || projector.lifecycleStatus === 'paused'
    || projector.lifecycleStatus === 'failed';
}

function collectProtectedModelAssetLocalPaths(models: ModelMetadata[]): Set<string> {
  const localPaths = new Set<string>();

  for (const model of models) {
    if (hasCompletedLocalModelFile(model) && isValidLocalFileName(model.localPath)) {
      localPaths.add(model.localPath);
    }

    for (const projector of model.projectorCandidates ?? []) {
      if (
        (hasCompletedProjectorStatus(projector) || hasResumableProjectorStatus(projector))
        && isValidLocalFileName(projector.localPath)
      ) {
        localPaths.add(projector.localPath);
      }
    }
  }

  return localPaths;
}

function collectProtectedProjectorLocalPaths(models: ModelMetadata[]): Set<string> {
  const localPaths = new Set<string>();

  for (const model of models) {
    for (const projector of model.projectorCandidates ?? []) {
      const localPath = projector.localPath;
      if (
        (hasCompletedProjectorStatus(projector) || hasResumableProjectorStatus(projector))
        && isValidLocalFileName(localPath)
      ) {
        localPaths.add(localPath);
      }
    }
  }

  return localPaths;
}

function resetProjectorDownloadState(projector: ProjectorArtifact): boolean {
  let changed = false;

  if (projector.lifecycleStatus !== 'available') {
    projector.lifecycleStatus = 'available';
    changed = true;
  }

  if (projector.localPath !== undefined) {
    projector.localPath = undefined;
    changed = true;
  }

  if (projector.resumeData !== undefined) {
    projector.resumeData = undefined;
    changed = true;
  }

  if (projector.downloadProgress !== undefined) {
    projector.downloadProgress = undefined;
    changed = true;
  }

  return changed;
}

function clearMultimodalReadinessForProjector(
  model: ModelMetadata,
  projector: Pick<ProjectorArtifact, 'id'>,
): boolean {
  const readiness = model.multimodalReadiness;
  if (!readiness || readiness.projectorId !== projector.id) {
    return false;
  }

  model.multimodalReadiness = undefined;
  return true;
}

function resetProjectorDownloadStateForModel(
  model: ModelMetadata,
  projector: ProjectorArtifact,
): boolean {
  const changed = resetProjectorDownloadState(projector);
  return (changed && clearMultimodalReadinessForProjector(model, projector)) || changed;
}

function resetProjectorDownloadStates(model: ModelMetadata): boolean {
  let changed = false;

  for (const projector of model.projectorCandidates ?? []) {
    changed = resetProjectorDownloadStateForModel(model, projector) || changed;
  }

  return changed;
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
  resetProjectorDownloadStates(model);
}

function hasCompletedLocalModelFile(model: Pick<ModelMetadata, 'lifecycleStatus' | 'localPath'>): boolean {
  return (
    (model.lifecycleStatus === LifecycleStatus.DOWNLOADED
      || model.lifecycleStatus === LifecycleStatus.ACTIVE)
    && typeof model.localPath === 'string'
  );
}

function shouldPreserveGgufValidationReadFailure(error: unknown): boolean {
  return error instanceof GgufValidationError && error.reason === 'read_failed';
}

async function isExistingCompletedModelFileForPrivateReset(
  model: ModelMetadata,
  modelsDir: string,
): Promise<boolean> {
  if (!hasCompletedLocalModelFile(model) || !isValidLocalFileName(model.localPath)) {
    return false;
  }

  const localUri = safeJoinModelPath(modelsDir, model.localPath);
  if (!localUri) {
    return false;
  }

  let info: Awaited<ReturnType<typeof FileSystem.getInfoAsync>>;
  try {
    info = await FileSystem.getInfoAsync(localUri);
  } catch (error) {
    console.warn('[LocalStorageRegistry] Failed to inspect completed model file before private storage reset; preserving registry-owned file name', {
      ...getModelStorageLogDetails('private_storage_reset_snapshot'),
      artifactKind: 'model',
      ...getSanitizedRegistryErrorDetails(error),
    });
    return true;
  }
  if (!info.exists || isFileSystemDirectory(info)) {
    return false;
  }

  const expectedSizeBytes = getValidDownloadIntegritySizeBytes(model.downloadIntegrity)
    ?? getFileInfoSizeBytes({ size: model.size ?? undefined });
  const fileSizeBytes = getFileInfoSizeBytes(info);
  if (expectedSizeBytes !== null && fileSizeBytes !== null && fileSizeBytes !== expectedSizeBytes) {
    return false;
  }

  try {
    await validateGgufFileHeader(localUri, info);
  } catch (error) {
    return shouldPreserveGgufValidationReadFailure(error);
  }

  return true;
}

async function isExistingCompletedProjectorFileForPrivateReset(
  projector: ProjectorArtifact,
  modelsDir: string,
): Promise<boolean> {
  if (!hasCompletedProjectorStatus(projector) || !isValidLocalFileName(projector.localPath)) {
    return false;
  }

  const localUri = safeJoinModelPath(modelsDir, projector.localPath);
  if (!localUri) {
    return false;
  }

  let info: Awaited<ReturnType<typeof FileSystem.getInfoAsync>>;
  try {
    info = await FileSystem.getInfoAsync(localUri);
  } catch (error) {
    console.warn('[LocalStorageRegistry] Failed to inspect completed projector file before private storage reset; preserving registry-owned file name', {
      ...getModelStorageLogDetails('private_storage_reset_snapshot'),
      artifactKind: 'projector',
      ...getSanitizedRegistryErrorDetails(error),
    });
    return true;
  }
  if (!info.exists || isFileSystemDirectory(info)) {
    return false;
  }

  const expectedSizeBytes = getFileInfoSizeBytes({ size: projector.size ?? undefined });
  const fileSizeBytes = getFileInfoSizeBytes(info);
  if (expectedSizeBytes !== null && fileSizeBytes !== null && fileSizeBytes !== expectedSizeBytes) {
    return false;
  }

  try {
    await validateGgufFileHeader(localUri, info);
  } catch (error) {
    return shouldPreserveGgufValidationReadFailure(error);
  }

  return true;
}

type ModelAssetFileForRemoval = {
  fileName: string;
  kind: 'model' | 'projector';
};

function getModelAssetFilesForRemoval(
  model: ModelMetadata | undefined,
  remainingModels: ModelMetadata[],
): ModelAssetFileForRemoval[] {
  if (!model) {
    return [];
  }

  const protectedLocalPaths = collectProtectedModelAssetLocalPaths(remainingModels);
  const seen = new Set<string>();
  const files: ModelAssetFileForRemoval[] = [];
  const addFile = (fileName: string | undefined, kind: ModelAssetFileForRemoval['kind']) => {
    if (!isValidLocalFileName(fileName) || seen.has(fileName) || protectedLocalPaths.has(fileName)) {
      return;
    }

    seen.add(fileName);
    files.push({ fileName, kind });
  };

  addFile(model.localPath, 'model');

  for (const projector of model.projectorCandidates ?? []) {
    const localPath = projector.localPath;
    if (!isValidLocalFileName(localPath)) {
      continue;
    }

    addFile(localPath, 'projector');
  }

  return files;
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
    const modelsDir = getModelsDir();
    const preservedFileNames = new Set<string>();

    if (!modelsDir) {
      writePrivateResetPreservedModelFiles({
        fileNames: preservedFileNames,
        scanComplete: true,
        completedOnly: true,
      });
      return [];
    }

    try {
      for (const model of this.getModels()) {
        if (await isExistingCompletedModelFileForPrivateReset(model, modelsDir) && isValidLocalFileName(model.localPath)) {
          preservedFileNames.add(model.localPath);
        }

        for (const projector of model.projectorCandidates ?? []) {
          if (
            await isExistingCompletedProjectorFileForPrivateReset(projector, modelsDir)
            && isValidLocalFileName(projector.localPath)
          ) {
            preservedFileNames.add(projector.localPath);
          }
        }
      }

      writePrivateResetPreservedModelFiles({
        fileNames: preservedFileNames,
        scanComplete: true,
        completedOnly: true,
      });
      return Array.from(preservedFileNames).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      console.warn(
        '[LocalStorageRegistry] Failed to snapshot completed model files before private storage reset; falling back to fail-closed directory preservation.',
        {
          ...getModelStorageLogDetails('private_storage_reset_snapshot'),
          ...getSanitizedRegistryErrorDetails(error),
        },
      );

      try {
        const directoryFileNames = normalizeModelFileNames(await FileSystem.readDirectoryAsync(modelsDir));
        const fallbackFileNames = new Set([...directoryFileNames, ...preservedFileNames]);
        writePrivateResetPreservedModelFiles({
          fileNames: fallbackFileNames,
          scanComplete: false,
          completedOnly: false,
        });
        return Array.from(fallbackFileNames).sort((left, right) => left.localeCompare(right));
      } catch (directoryError) {
        console.warn(
          '[LocalStorageRegistry] Failed to snapshot model directory before private storage reset; preserving previous reset snapshot.',
          {
            ...getModelStorageLogDetails('private_storage_reset_snapshot'),
            ...getSanitizedRegistryErrorDetails(directoryError),
          },
        );

        if (preservedFileNames.size > 0) {
          writePrivateResetPreservedModelFiles({
            fileNames: preservedFileNames,
            scanComplete: false,
            completedOnly: false,
          });
          return Array.from(preservedFileNames).sort((left, right) => left.localeCompare(right));
        }

        return Array.from(readPrivateResetPreservedModelFiles().fileNames)
          .sort((left, right) => left.localeCompare(right));
      }
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

  private async deleteModelAssetFile(
    modelsDir: string,
    file: ModelAssetFileForRemoval,
  ): Promise<void> {
    try {
      const fileUri = safeJoinModelPath(modelsDir, file.fileName);
      if (!fileUri) {
        console.warn('[LocalStorageRegistry] Invalid localPath while deleting model asset file', {
          ...getModelStorageLogDetails('model_asset_delete'),
          fileKind: file.kind,
        });
        return;
      }

      const info = await FileSystem.getInfoAsync(fileUri);
      if (info.exists && !isFileSystemDirectory(info)) {
        await FileSystem.deleteAsync(fileUri);
      } else if (info.exists) {
        console.warn('[LocalStorageRegistry] Model asset localPath points to a directory, skipping file deletion', {
          ...getModelStorageLogDetails('model_asset_delete'),
          fileKind: file.kind,
        });
      }
    } catch (e) {
      console.error('[LocalStorageRegistry] Failed to delete model asset file', {
        ...getModelStorageLogDetails('model_asset_delete'),
        fileKind: file.kind,
        ...getSanitizedRegistryErrorDetails(e),
      });
    }
  }

  private async validateProjectorLocalState(model: ModelMetadata, modelsDir: string): Promise<boolean> {
    let changed = false;

    for (const projector of model.projectorCandidates ?? []) {
      const localPath = projector.localPath;
      const hasCompletedStatus = hasCompletedProjectorStatus(projector);
      if (!isValidLocalFileName(localPath)) {
        if (hasCompletedStatus || projector.localPath !== undefined) {
          changed = resetProjectorDownloadStateForModel(model, projector) || changed;
        }
        continue;
      }

      const fileUri = safeJoinModelPath(modelsDir, localPath);
      if (!fileUri) {
        console.warn('[LocalStorageRegistry] Invalid projector localPath, resetting projector to available', {
          ...getModelStorageLogDetails('projector_local_state_validation'),
          artifactKind: 'projector',
        });
        changed = resetProjectorDownloadStateForModel(model, projector) || changed;
        continue;
      }

      const info = await FileSystem.getInfoAsync(fileUri);
      if (!info.exists) {
        console.warn('[LocalStorageRegistry] Projector localPath missing, resetting projector to available', {
          ...getModelStorageLogDetails('projector_local_state_validation'),
          artifactKind: 'projector',
        });
        changed = resetProjectorDownloadStateForModel(model, projector) || changed;
        continue;
      }

      if (isFileSystemDirectory(info)) {
        console.warn('[LocalStorageRegistry] Projector localPath points to a directory, resetting projector to available', {
          ...getModelStorageLogDetails('projector_local_state_validation'),
          artifactKind: 'projector',
        });
        changed = resetProjectorDownloadStateForModel(model, projector) || changed;
        continue;
      }

      if (!hasCompletedStatus) {
        if (hasResumableProjectorStatus(projector)) {
          continue;
        }

        changed = resetProjectorDownloadStateForModel(model, projector) || changed;
        continue;
      }

      if (projector.lifecycleStatus === 'active') {
        projector.lifecycleStatus = 'downloaded';
        changed = true;
      }

      const fileSizeBytes = getFileInfoSizeBytes(info);
      const expectedSizeBytes = getFileInfoSizeBytes({ size: projector.size ?? undefined });
      if (expectedSizeBytes !== null && fileSizeBytes !== null && fileSizeBytes !== expectedSizeBytes) {
        console.warn('[LocalStorageRegistry] Projector file size mismatch, resetting projector to available', {
          ...getModelStorageLogDetails('projector_local_state_validation'),
          artifactKind: 'projector',
        });
        changed = resetProjectorDownloadStateForModel(model, projector) || changed;
        continue;
      }

      try {
        const ggufValidation = await validateGgufFileHeader(fileUri, info);
        if (projector.size !== ggufValidation.sizeBytes) {
          projector.size = ggufValidation.sizeBytes;
          changed = true;
        }
      } catch (error) {
        if (error instanceof GgufValidationError && error.reason === 'read_failed') {
          console.warn(
            '[LocalStorageRegistry] Projector GGUF validation could not read file, preserving downloaded projector state',
            {
              ...getModelStorageLogDetails('projector_local_state_validation'),
              artifactKind: 'projector',
              ...getSanitizedRegistryErrorDetails(error),
            },
          );
          continue;
        }

        console.warn(
          '[LocalStorageRegistry] Projector GGUF validation failed, resetting projector to available',
          {
            ...getModelStorageLogDetails('projector_local_state_validation'),
            artifactKind: 'projector',
            ...getSanitizedRegistryErrorDetails(error),
          },
        );
        changed = resetProjectorDownloadStateForModel(model, projector) || changed;
        continue;
      }

      if (fileSizeBytes !== null && projector.size === null) {
        projector.size = fileSizeBytes;
        changed = true;
      }
    }

    return changed;
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
    const state = this.getCachedModelsState();
    const model = state.modelsById.get(normalizedId);
    const nextModelsById = new Map(state.modelsById);
    const nextIds = state.ids.filter((id) => id !== normalizedId);
    nextModelsById.delete(normalizedId);

    const modelsDir = getModelsDir();
    if (model && modelsDir) {
      const remainingModels = Array.from(nextModelsById.values());
      const filesForRemoval = getModelAssetFilesForRemoval(model, remainingModels);

      for (const file of filesForRemoval) {
        await this.deleteModelAssetFile(modelsDir, file);
      }
    }

    const hadCompletedLocalFile = model ? hasCompletedLocalModelFile(model) : false;

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
        } else {
          changed = resetProjectorDownloadStates(model) || changed;
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
      let didValidateProjectors = false;

      if (!hasDownloadedState && model.localPath) {
        resetLocalDownloadState(model);
        changed = true;
        continue;
      }

      if (hasDownloadedState) {
        if (!model.localPath) {
          console.warn('[LocalStorageRegistry] Missing localPath, resetting model to available', getModelStorageLogDetails('model_local_state_validation'));
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }

        const fileUri = safeJoinModelPath(modelsDir, model.localPath);
        if (!fileUri) {
          console.warn('[LocalStorageRegistry] Invalid localPath, resetting model to available', getModelStorageLogDetails('model_local_state_validation'));
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }
        const info = await FileSystem.getInfoAsync(fileUri);
        if (!info.exists) {
          console.warn('[LocalStorageRegistry] Local file missing, resetting model to available', getModelStorageLogDetails('model_local_state_validation'));
          resetLocalDownloadState(model);
          changed = true;
          continue;
        } else if (isFileSystemDirectory(info)) {
          console.warn('[LocalStorageRegistry] Local path points to a directory, resetting model to available', getModelStorageLogDetails('model_local_state_validation'));
          resetLocalDownloadState(model);
          changed = true;
          continue;
        } else if (model.lifecycleStatus === LifecycleStatus.ACTIVE) {
          model.lifecycleStatus = LifecycleStatus.DOWNLOADED;
          changed = true;
        }

        const fileSizeBytes = getFileInfoSizeBytes(info);

        if (model.downloadIntegrity?.kind === 'sha256') {
          const markerSha256 = getSha256IntegrityMarkerDigest(model.downloadIntegrity);
          if (!markerSha256) {
            console.warn('[LocalStorageRegistry] SHA-256 integrity marker is invalid, resetting model to available', getModelStorageLogDetails('model_local_state_validation'));
            resetLocalDownloadState(model);
            changed = true;
            continue;
          }

          if (model.downloadIntegrity.sha256 !== markerSha256) {
            model.downloadIntegrity = {
              ...model.downloadIntegrity,
              sha256: markerSha256,
            };
            changed = true;
          }

          const expectedSha256 = getModelSha256Digest(model);
          if (model.sha256 !== undefined && expectedSha256 === undefined) {
            console.warn('[LocalStorageRegistry] Expected SHA-256 digest is invalid, downgrading local trust', getModelStorageLogDetails('model_local_state_validation'));
            model.sha256 = undefined;
            changed = true;
          } else if (expectedSha256 !== undefined && model.sha256 !== expectedSha256) {
            model.sha256 = expectedSha256;
            changed = true;
          }

          if (expectedSha256 !== undefined && markerSha256 !== expectedSha256) {
            console.warn('[LocalStorageRegistry] SHA-256 integrity marker no longer matches expected digest, resetting model to available', getModelStorageLogDetails('model_local_state_validation'));
            resetLocalDownloadState(model);
            changed = true;
            continue;
          }
        }

        const integritySizeBytes = getValidDownloadIntegritySizeBytes(model.downloadIntegrity);
        const hasMatchingIntegrityMarker = integritySizeBytes !== null
          && fileSizeBytes !== null
          && fileSizeBytes === integritySizeBytes;
        if (integritySizeBytes !== null && !hasMatchingIntegrityMarker) {
          console.warn('[LocalStorageRegistry] Integrity marker size mismatch, resetting model to available', getModelStorageLogDetails('model_local_state_validation'));
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
            console.warn('[LocalStorageRegistry] Local GGUF validation could not read file, preserving downloaded state', {
              ...getModelStorageLogDetails('model_local_state_validation'),
              ...getSanitizedRegistryErrorDetails(error),
            });
            changed = clearVerifiedLocalDerivedMetadata(model) || changed;
            continue;
          }

          console.warn('[LocalStorageRegistry] Local GGUF validation failed, resetting model to available', {
            ...getModelStorageLogDetails('model_local_state_validation'),
            ...getSanitizedRegistryErrorDetails(error),
          });
          resetLocalDownloadState(model);
          changed = true;
          continue;
        }

        const hasTrustedIntegrityMarker = hasMatchingIntegrityMarker
          && hasMatchingExpectedSha256IntegrityMarker(model);

        if (!hasTrustedIntegrityMarker) {
          changed = clearVerifiedLocalDerivedMetadata(model) || changed;
        }

        if (localSizeBytesForRegistry !== null && model.size !== localSizeBytesForRegistry) {
          model.size = localSizeBytesForRegistry;
          changed = true;
        }

        changed = await this.validateProjectorLocalState(model, modelsDir) || changed;
        didValidateProjectors = true;

        const persistedSizeBytes = (
          typeof model.size === 'number'
          && Number.isFinite(model.size)
          && model.size > 0
        )
          ? Math.round(model.size)
          : null;
        const sizeBytesForFit = localSizeBytesForRegistry ?? persistedSizeBytes;

        if (sizeBytesForFit !== null) {
          const memoryFitInputSizeBytes = getModelMemoryFitInputSizeBytes({
            modelSizeBytes: sizeBytesForFit,
            projectorSizeBytes: getStoredProjectorMemoryFitSizeBytes(model.projectorCandidates),
          }) ?? sizeBytesForFit;
          const metadataTrustForFit = hasTrustedIntegrityMarker
            ? 'verified_local' as const
            : model.metadataTrust;
          const fit = estimateFastMemoryFit({
            modelSizeBytes: memoryFitInputSizeBytes,
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

      if (!didValidateProjectors) {
        changed = await this.validateProjectorLocalState(model, modelsDir) || changed;
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
      let newlyQuarantinedCount = 0;

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
          quarantinedFileNames.set(filename, {
            fileName: filename,
            detectedAt: Date.now(),
            reason: 'orphaned',
          });
          quarantineChanged = true;
          newlyQuarantinedCount += 1;
        }
      }

      if (newlyQuarantinedCount > 0) {
        console.warn('[LocalStorageRegistry] Quarantined orphaned model files', {
          ...getModelStorageLogDetails('orphan_quarantine_scan'),
          count: newlyQuarantinedCount,
        });
      }

      if (quarantineChanged) {
        writeQuarantinedModelFiles(quarantinedFileNames);
      }
    } catch (e) {
      console.warn('[LocalStorageRegistry] Orphan quarantine scan failed', {
        ...getModelStorageLogDetails('orphan_quarantine_scan'),
        ...getSanitizedRegistryErrorDetails(e),
      });
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
    const protectedProjectorLocalPaths = collectProtectedProjectorLocalPaths(models);
    const queuedFileNamesSet = normalizeModelFileNames(queuedFileNames);
    const privateResetPreservedFileNames = this.getPreservedModelFileNamesForCleanup(
      directoryFileNames,
      new Set([...completedLocalPaths, ...protectedProjectorLocalPaths]),
    );

    return {
      currentSafeDirectoryFileNames,
      protectedFileNames: new Set([
        ...completedLocalPaths,
        ...protectedProjectorLocalPaths,
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

    if (!state.completedOnly) {
      const legacyCandidateFileNames = !state.scanComplete && state.fileNames.size === 0
        ? safeDirectoryFileNames
        : state.fileNames;
      for (const fileName of legacyCandidateFileNames) {
        if (!safeDirectoryFileNames.has(fileName)) {
          continue;
        }

        if (completedLocalPaths.has(fileName)) {
          continue;
        }

        nextFileNames.add(fileName);
      }

      const shouldPersistLegacy =
        nextFileNames.size !== state.fileNames.size
        || [...nextFileNames].some((fileName) => !state.fileNames.has(fileName));
      if (shouldPersistLegacy) {
        writePrivateResetPreservedModelFiles({
          fileNames: nextFileNames,
          scanComplete: state.scanComplete,
          completedOnly: false,
        });
      }
      return nextFileNames;
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
        completedOnly: true,
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
        console.warn('[LocalStorageRegistry] Model registry listener failed', getSanitizedRegistryErrorDetails(error));
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
      console.warn('[LocalStorageRegistry] Failed to parse models index, rebuilding', getSanitizedRegistryErrorDetails(e));
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
        console.warn('[LocalStorageRegistry] Failed to parse model metadata, dropping entry', getSanitizedRegistryErrorDetails(e));
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
      console.error('[LocalStorageRegistry] Failed to parse calibration records', getSanitizedRegistryErrorDetails(e));
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
      console.error('[LocalStorageRegistry] Failed to parse legacy registry data', getSanitizedRegistryErrorDetails(e));
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
