import DeviceInfo from 'react-native-device-info';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { useDownloadStore } from '../store/downloadStore';
import {
  ModelAccessState,
  type ModelMemoryFitConfidence,
  type ModelMemoryFitDecision,
  ModelMetadata,
  LifecycleStatus,
} from '../types/models';
import type { ProjectorArtifact, ProjectorMatchStatus } from '../types/multimodal';
import { registry } from './LocalStorageRegistry';
import { getModelsDir } from './FileSystemSetup';
import { AppError, toAppError } from './AppError';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import { isHuggingFaceUrl } from '../utils/huggingFaceUrls';
import { getCandidateModelDownloadFileNames, getCandidateProjectorDownloadFileNames } from '../utils/modelFiles';
import { estimateFastMemoryFit } from '../memory/estimator';
import { fileUriToNativePath, isValidLocalFileName, safeJoinModelPath } from '../utils/safeFilePath';
import { DECIMAL_GIGABYTE, isStoredProjectorArtifact, normalizePositiveByteSize } from '../utils/modelSize';
import { getModelMemoryFitInputSizeBytes } from '../utils/memoryFit';
import { hardwareListenerService, type HardwareStatus } from './HardwareListenerService';
import { getSettings, subscribeSettings } from './SettingsStore';
import { backgroundTaskService } from './BackgroundTaskService';
import { notificationService, type DownloadErrorReason } from './NotificationService';
import { PrivateStorageUnavailableError, getPrivateStorageHealthSnapshot, isPrivateStorageWritable } from './storage';
import { GgufValidationError, validateGgufFileHeader } from '../utils/ggufValidation';
import { normalizeSha256Digest } from '../utils/sha256';
import { normalizeDownloadResumeData } from '../utils/downloadResumeData';
import { projectorArtifactService } from './ProjectorArtifactService';

function ignorePrivateStorageUnavailableDuringDownloadStop(error: unknown, scope: string): boolean {
  if (isPrivateStorageUnavailableError(error)) {
    console.warn(`[ModelDownloadManager] Skipped persisting ${scope} while private storage is blocked`, summarizeErrorForLog(error));
    return true;
  }

  return false;
}

function setDownloadRuntimeStateForStorageStop(
  nextState: Partial<ReturnType<typeof useDownloadStore.getState>>,
  scope: string,
): void {
  try {
    useDownloadStore.setState(nextState);
  } catch (error) {
    if (!ignorePrivateStorageUnavailableDuringDownloadStop(error, scope)) {
      throw error;
    }
  }
}

function isPrivateStorageUnavailableError(error: unknown): error is PrivateStorageUnavailableError {
  return error instanceof PrivateStorageUnavailableError
    || (error instanceof Error && error.name === 'PrivateStorageUnavailableError');
}

function assertPrivateStorageWritableForDownloadMutation(): void {
  if (isPrivateStorageWritable()) {
    return;
  }

  const health = getPrivateStorageHealthSnapshot();
  throw new PrivateStorageUnavailableError(health.reason ?? 'unknown', health);
}

function safeNormalizeResumeSnapshotValue(
  snapshot: unknown,
  {
    modelId,
    scope,
  }: {
    modelId: string;
    scope: string;
  },
): string | undefined {
  const resumeData = normalizeDownloadResumeData(snapshot);
  if (!resumeData && snapshot != null) {
    try {
      console.warn(`[ModelDownloadManager] Dropped unsafe or empty resume snapshot for ${modelId} (${scope})`);
    } catch {
      // ignore secondary logging errors
    }
  }

  return resumeData;
}

function safeNormalizeResumeSnapshot(
  resumable: { savable?: () => unknown } | null | undefined,
  {
    modelId,
    scope,
  }: {
    modelId: string;
    scope: string;
  },
): string | undefined {
  if (!resumable || typeof resumable.savable !== 'function') {
    return undefined;
  }

  let snapshot: unknown;
  try {
    snapshot = resumable.savable();
  } catch (error) {
    try {
      console.warn(`[ModelDownloadManager] Failed to snapshot resumable state for ${modelId} (${scope})`, summarizeErrorForLog(error));
    } catch {
      // ignore secondary logging errors
    }
    return undefined;
  }

  return safeNormalizeResumeSnapshotValue(snapshot, { modelId, scope });
}

function decodeUrlPathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function splitRepoIdPath(repoId: string): string[] {
  return repoId
    .trim()
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isTrustedHuggingFaceResolveUrlForRepo(url: string, repoId: string): boolean {
  if (!isHuggingFaceUrl(url)) {
    return false;
  }

  const expectedRepoSegments = splitRepoIdPath(repoId);
  if (expectedRepoSegments.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map(decodeUrlPathSegment);

    if (pathSegments.some((segment) => segment === null)) {
      return false;
    }

    if (pathSegments.length < expectedRepoSegments.length + 2) {
      return false;
    }

    const repoMatches = expectedRepoSegments.every((segment, index) => (
      pathSegments[index] === segment
    ));

    return repoMatches && pathSegments[expectedRepoSegments.length] === 'resolve';
  } catch {
    return false;
  }
}

type ActiveDownloadJob = {
  modelId: string;
  jobToken: number;
  resumable: ReturnType<typeof FileSystem.createDownloadResumable> | null;
  activeArtifact?: 'model' | 'projector';
  activeProjectorId?: string;
  stopReason: 'pause' | 'cancel' | null;
  deferredCancelCleanupFileNames?: string[];
};

type DownloadVerificationResult = {
  integrity: 'sha256' | 'size' | 'unverified';
  sha256?: string;
  sizeBytes: number;
};

type ProjectorDownloadResult = {
  projector: ProjectorArtifact;
  sizeBytes: number | null;
};

type DownloadMemoryFitSummary = {
  fitsInRam: boolean | null;
  decision: ModelMemoryFitDecision;
  confidence: ModelMemoryFitConfidence;
};

type ReusableModelDownloadFile = {
  fileName: string;
  localUri: string;
  verification: DownloadVerificationResult;
};

type ReusableProjectorDownloadFile = {
  fileName: string;
  sizeBytes: number | null;
};

const SENSITIVE_ERROR_DETAIL_KEYS = new Set([
  'uri',
  'localuri',
  'path',
  'localpath',
  'nativepath',
  'filepath',
  'absolutepath',
  'filename',
  'filenames',
  'candidate',
  'candidates',
  'projectorid',
  'artifactid',
  'ownervariantid',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveErrorDetailKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return SENSITIVE_ERROR_DETAIL_KEYS.has(normalizedKey)
    || normalizedKey.endsWith('uri')
    || normalizedKey.endsWith('path');
}

function isSensitivePathLikeString(value: string): boolean {
  const normalizedValue = value.replace(/\\/g, '/');
  return /^file:\/\//i.test(normalizedValue)
    || normalizedValue.includes('/models/')
    || normalizedValue.includes('test-dir/models')
    || /^[A-Za-z]:\//.test(normalizedValue);
}

function sanitizeDownloadErrorMessage(value: string): string {
  return value
    .replace(/file:\/\/[^'"),;\r\n]+?\.(?:gguf|bin|safetensors|tmp|part|download)\b/giu, '[path]')
    .replace(/[A-Za-z]:[\\/][^'"),;\r\n]+?\.(?:gguf|bin|safetensors|tmp|part|download)\b/gu, '[path]')
    .replace(/(?:\/data\/user|\/storage\/emulated|\/private|\/var\/mobile|test-dir\/models|test-cache\/models|[^\s'"),;]+\/models\/)[^'"),;\r\n]+?\.(?:gguf|bin|safetensors|tmp|part|download)\b/giu, '[path]')
    .replace(/file:\/\/[^\s'"),]+/giu, '[path]')
    .replace(/[A-Za-z]:[\\/][^\s'"),]+/gu, '[path]')
    .replace(/(?:\/data\/user|\/storage\/emulated|\/private|\/var\/mobile|test-dir\/models|test-cache\/models|[^\s'"),]+\/models\/)[^\s'"),]+/giu, '[path]');
}

function sanitizeErrorLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const sanitizedValue = sanitizeDownloadErrorMessage(value);
    return isSensitivePathLikeString(sanitizedValue) ? '[redacted-path]' : sanitizedValue;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeErrorLogValue);
  }

  if (isPlainObject(value)) {
    return sanitizeErrorDetails(value);
  }

  return value;
}

function sanitizeErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const sanitizedDetails: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (isSensitiveErrorDetailKey(key)) {
      continue;
    }

    sanitizedDetails[key] = sanitizeErrorLogValue(value);
  }

  return Object.keys(sanitizedDetails).length > 0 ? sanitizedDetails : undefined;
}

function getPathCategory(localUri: string): 'model_storage' | 'local_file' {
  const modelsDir = getModelsDir();
  return modelsDir && localUri.startsWith(modelsDir) ? 'model_storage' : 'local_file';
}

function buildVerificationErrorDetails(
  artifact: Pick<ModelMetadata, 'id'>,
  localUri: string,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  const projector = artifact as Partial<Pick<ProjectorArtifact, 'ownerModelId' | 'ownerVariantId'>>;
  const isProjector = typeof projector.ownerModelId === 'string' && projector.ownerModelId.length > 0;
  return {
    modelId: projector.ownerModelId ?? artifact.id,
    artifactKind: isProjector ? 'projector' : 'model',
    ...(isProjector ? {} : { artifactId: artifact.id }),
    pathCategory: getPathCategory(localUri),
    ...(sanitizeErrorDetails(details) ?? {}),
  };
}

function toSanitizedDownloadAppError(
  error: unknown,
  fallbackCode: Parameters<typeof toAppError>[1] = 'action_failed',
): AppError {
  const appError = toAppError(error, fallbackCode);
  return new AppError(appError.code, sanitizeDownloadErrorMessage(appError.message), {
    details: sanitizeErrorDetails(appError.details),
  });
}

function summarizeErrorForLog(error: unknown): Record<string, unknown> {
  const appError = toSanitizedDownloadAppError(error);
  const details = appError.details;
  return {
    name: error instanceof Error ? error.name : appError.name,
    code: appError.code,
    message: sanitizeErrorLogValue(appError.message),
    ...(details ? { details } : {}),
  };
}

function buildDownloadIntegrityMarker(
  verification: DownloadVerificationResult,
): ModelMetadata['downloadIntegrity'] {
  if (verification.integrity === 'unverified') {
    return undefined;
  }

  return {
    kind: verification.integrity,
    sizeBytes: verification.sizeBytes,
    checkedAt: Date.now(),
    ...(verification.sha256 ? { sha256: verification.sha256 } : {}),
  };
}

function shouldDeleteInvalidGgufDownload(reason: GgufValidationError['reason']): boolean {
  return reason !== 'read_failed';
}

function isFileSystemDirectory(info: { isDirectory?: boolean }): boolean {
  return info.isDirectory === true;
}

const REQUIRED_DOWNLOAD_BUFFER_BYTES = DECIMAL_GIGABYTE; // 1 GB

export class ModelDownloadManager {
  private static instance: ModelDownloadManager | undefined;
  private activeJob: ActiveDownloadJob | null = null;
  private nextJobToken = 0;
  private isProcessing = false;
  private queueProcessingHoldCount = 0;
  private downloadStoreUnsubscribe?: () => void;
  private hwUnsubscribe?: () => void;
  private settingsUnsubscribe?: () => void;

  private constructor() {
    // Subscribe to store changes to trigger queue processing
    this.downloadStoreUnsubscribe = useDownloadStore.subscribe(
      (state) => `${state.activeDownloadId ?? ''}|${state.queue.map((model) => `${model.id}:${model.lifecycleStatus}`).join(',')}`,
      () => { void this.processQueue(); },
    );

    let lastAllowCellularDownloads = getSettings().allowCellularDownloads;
    this.settingsUnsubscribe = subscribeSettings((settings) => {
      if (settings.allowCellularDownloads === lastAllowCellularDownloads) {
        return;
      }

      lastAllowCellularDownloads = settings.allowCellularDownloads;
      const status = hardwareListenerService.getCurrentStatus();

      if (status.networkType === 'cellular' && settings.allowCellularDownloads === false) {
        void this.handleHardwareStatusChange(status);
        return;
      }

      void this.processQueue();
    });

    this.hwUnsubscribe = hardwareListenerService.subscribe((status) => {
      void this.handleHardwareStatusChange(status);
    });
    // Initial check
    void this.processQueue();
  }

  public static getInstance(): ModelDownloadManager {
    if (!ModelDownloadManager.instance) {
      ModelDownloadManager.instance = new ModelDownloadManager();
    }
    return ModelDownloadManager.instance;
  }

  public static async resetRuntimeForPrivateStorageReset(): Promise<void> {
    if (!ModelDownloadManager.instance) {
      return;
    }

    ModelDownloadManager.instance.dispose();
    await ModelDownloadManager.instance.stopActiveJobForPrivateStorageReset({ clearQueue: true });
    ModelDownloadManager.instance = undefined;
  }

  public static async stopRuntimeForPrivateStorageBlocked(): Promise<void> {
    if (!ModelDownloadManager.instance) {
      return;
    }

    await ModelDownloadManager.instance.stopActiveJobForPrivateStorageReset({ clearQueue: false });
  }

  public resumeQueueIfStorageReady(): void {
    void this.processQueue();
  }

  public dispose(): void {
    this.downloadStoreUnsubscribe?.();
    this.downloadStoreUnsubscribe = undefined;
    this.settingsUnsubscribe?.();
    this.settingsUnsubscribe = undefined;
    this.hwUnsubscribe?.();
    this.hwUnsubscribe = undefined;
  }

  private getDownloadFailureUpdates(error: unknown, resumeData?: string): Partial<ModelMetadata> {
    const appError = toSanitizedDownloadAppError(error);
    const shouldDiscardResumeData = appError.code === 'download_verification_failed'
      || appError.code === 'download_file_missing';

    return {
      lifecycleStatus: LifecycleStatus.FAILED,
      resumeData: shouldDiscardResumeData ? undefined : resumeData,
      ...(shouldDiscardResumeData ? { downloadProgress: 0, downloadIntegrity: undefined } : {}),
      downloadErrorCode: appError.code,
      downloadErrorMessage: appError.message,
      downloadErrorAt: Date.now(),
    };
  }

  private resolveProjectorForDownload(model: ModelMetadata): ProjectorArtifact | null {
    const resolution = projectorArtifactService.resolveProjectorForModel(model);

    return resolution.selectedProjector
      ? {
        ...resolution.selectedProjector,
        matchReason: resolution.reason,
      }
      : null;
  }

  private getProjectorDownloadFileNameCandidates(
    projector: Pick<ProjectorArtifact, 'id' | 'repoId' | 'fileName' | 'hfRevision' | 'ownerModelId' | 'ownerVariantId' | 'localPath'>,
  ): string[] {
    return Array.from(new Set([
      ...(isValidLocalFileName(projector.localPath) ? [projector.localPath] : []),
      ...getCandidateProjectorDownloadFileNames(projector),
    ]));
  }

  private updateProjectorCandidates(
    model: Pick<ModelMetadata, 'projectorCandidates'>,
    projectorId: string,
    updates: Partial<ProjectorArtifact>,
  ): ProjectorArtifact[] | undefined {
    if (!model.projectorCandidates?.length) {
      return undefined;
    }

    return model.projectorCandidates.map((projector) => (
      projector.id === projectorId
        ? { ...projector, ...updates }
        : projector
    ));
  }

  private getQueuedModel(modelId: string, fallbackModel: ModelMetadata): ModelMetadata {
    return useDownloadStore.getState().queue.find((queuedModel) => queuedModel.id === modelId) ?? fallbackModel;
  }

  private async resolveReusableModelFile(
    model: Pick<ModelMetadata, 'id' | 'localPath' | 'size' | 'sha256' | 'downloadProgress' | 'downloadIntegrity' | 'metadataTrust'>,
    modelsDir: string,
  ): Promise<ReusableModelDownloadFile | null> {
    if (!isValidLocalFileName(model.localPath)) {
      return null;
    }

    const hasVerifiedCheckpoint = model.downloadProgress === 1
      || model.downloadIntegrity !== undefined
      || model.metadataTrust === 'verified_local';
    if (!hasVerifiedCheckpoint) {
      return null;
    }

    const localUri = safeJoinModelPath(modelsDir, model.localPath);
    if (!localUri) {
      return null;
    }

    const fileInfo = await FileSystem.getInfoAsync(localUri);
    if (!fileInfo.exists || isFileSystemDirectory(fileInfo)) {
      return null;
    }

    try {
      return {
        fileName: model.localPath,
        localUri,
        verification: await this.verifyChecksum(model, localUri),
      };
    } catch (error) {
      console.warn(`[ModelDownloadManager] Existing model artifact for ${model.id} cannot be reused`, summarizeErrorForLog(error));
      return null;
    }
  }

  private buildBaseModelCheckpointUpdates({
    model,
    fileName,
    downloadedSize,
    verification,
    preserveExistingVerifiedLocalMetadata,
  }: {
    model: ModelMetadata;
    fileName: string;
    downloadedSize: number | null;
    verification: DownloadVerificationResult;
    preserveExistingVerifiedLocalMetadata: boolean;
  }): Partial<ModelMetadata> {
    const hasTrustedIntegrity = verification.integrity === 'sha256';
    const hasPositiveDownloadedSize = typeof downloadedSize === 'number' && Number.isFinite(downloadedSize) && downloadedSize > 0;
    const existingVerifiedLocalSha256 = preserveExistingVerifiedLocalMetadata && model.metadataTrust === 'verified_local'
      ? normalizeSha256Digest(model.downloadIntegrity?.sha256)
      : undefined;
    const metadataTrust = hasTrustedIntegrity && hasPositiveDownloadedSize
      ? 'verified_local' as const
      : preserveExistingVerifiedLocalMetadata && model.metadataTrust === 'verified_local'
        ? 'verified_local' as const
        : model.metadataTrust === 'verified_local'
          ? undefined
          : model.metadataTrust;
    const shouldCarryForwardGgufMetadata = hasTrustedIntegrity
      || model.metadataTrust === 'trusted_remote'
      || (preserveExistingVerifiedLocalMetadata && model.metadataTrust === 'verified_local');
    const ggufMetadata = shouldCarryForwardGgufMetadata ? model.gguf : undefined;
    const downloadIntegrity = buildDownloadIntegrityMarker(verification);
    const strongestDownloadIntegrity = preserveExistingVerifiedLocalMetadata
      && model.downloadIntegrity?.kind === 'sha256'
      && verification.integrity !== 'sha256'
      ? model.downloadIntegrity
      : downloadIntegrity ?? (preserveExistingVerifiedLocalMetadata ? model.downloadIntegrity : undefined);

    return {
      size: downloadedSize ?? null,
      metadataTrust,
      downloadIntegrity: strongestDownloadIntegrity,
      gguf: shouldCarryForwardGgufMetadata && hasPositiveDownloadedSize
        ? {
          ...(ggufMetadata ?? {}),
          totalBytes: Math.round(downloadedSize),
        }
        : ggufMetadata,
      localPath: fileName,
      downloadProgress: 1,
      allowUnknownSizeDownload: false,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      sha256: verification.sha256 ?? normalizeSha256Digest(model.sha256) ?? existingVerifiedLocalSha256,
    };
  }

  private buildProjectorQueueUpdates(
    model: ModelMetadata,
    projector: ProjectorArtifact,
    updates: Partial<ProjectorArtifact>,
  ): Partial<ModelMetadata> {
    const projectorCandidates = this.updateProjectorCandidates(model, projector.id, {
      matchStatus: projector.matchStatus,
      matchReason: projector.matchReason,
      ...updates,
    });

    return projectorCandidates ? { projectorCandidates } : {};
  }

  private updateQueuedProjector(
    modelId: string,
    fallbackModel: ModelMetadata,
    projector: ProjectorArtifact,
    updates: Partial<ProjectorArtifact>,
  ): void {
    const { updateModelInQueue } = useDownloadStore.getState();
    const queuedModel = this.getQueuedModel(modelId, fallbackModel);
    const queueUpdates = this.buildProjectorQueueUpdates(queuedModel, projector, updates);
    if (queueUpdates.projectorCandidates) {
      updateModelInQueue(modelId, queueUpdates);
    }
  }

  private getProjectorFailureUpdates(
    model: ModelMetadata,
    projectorId: string | undefined,
    error: unknown,
    resumeData?: string,
  ): Partial<ModelMetadata> {
    if (!projectorId) {
      return {};
    }

    const appError = toSanitizedDownloadAppError(error);
    const shouldDiscardResumeData = appError.code === 'download_verification_failed'
      || appError.code === 'download_file_missing';
    const normalizedResumeData = shouldDiscardResumeData ? undefined : resumeData;
    const shouldClearLocalPath = shouldDiscardResumeData;
    const projectorCandidates = this.updateProjectorCandidates(model, projectorId, {
      lifecycleStatus: 'failed',
      matchStatus: 'failed',
      matchReason: appError.code,
      resumeData: normalizedResumeData,
      ...(normalizedResumeData
        ? {}
        : {
          ...(shouldClearLocalPath ? { localPath: undefined } : {}),
          downloadProgress: undefined,
        }),
    });

    return projectorCandidates ? { projectorCandidates } : {};
  }

  private buildTextReadyModelAfterProjectorFailure({
    model,
    projectorFailureUpdates,
    memoryFit,
  }: {
    model: ModelMetadata;
    projectorFailureUpdates: Partial<ModelMetadata>;
    memoryFit: DownloadMemoryFitSummary;
  }): ModelMetadata {
    return {
      ...model,
      ...projectorFailureUpdates,
      fitsInRam: memoryFit.fitsInRam,
      memoryFitDecision: memoryFit.decision,
      memoryFitConfidence: memoryFit.confidence,
      downloadedAt: Date.now(),
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
    };
  }

  private async stopActiveJobForPrivateStorageReset(options: { clearQueue: boolean }): Promise<void> {
    const job = this.activeJob;
    if (job) {
      job.stopReason = 'cancel';
    }

    this.isProcessing = true;
    this.nextJobToken += 1;
    this.activeJob = null;
    if (options.clearQueue) {
      setDownloadRuntimeStateForStorageStop({ queue: [], activeDownloadId: null }, 'download reset state');
    } else if (job) {
      const currentState = useDownloadStore.getState();
      setDownloadRuntimeStateForStorageStop({
        activeDownloadId: null,
        queue: currentState.queue.map((model) => (
          model.id === job.modelId && (
            model.lifecycleStatus === LifecycleStatus.DOWNLOADING
            || model.lifecycleStatus === LifecycleStatus.VERIFYING
          )
            ? { ...model, lifecycleStatus: LifecycleStatus.QUEUED, downloadProgress: 0 }
            : model
        )),
      }, 'download blocked state');
    } else {
      setDownloadRuntimeStateForStorageStop({ activeDownloadId: null }, 'download blocked idle state');
    }

    try {
      if (job?.resumable) {
        try {
          await job.resumable.pauseAsync();
        } catch (error) {
          console.warn(`[ModelDownloadManager] Failed to pause active download during private storage reset for ${job.modelId}`, summarizeErrorForLog(error));
        }
      }

      if (backgroundTaskService.isTaskActive('download')) {
        await backgroundTaskService.stopBackgroundTask('download').catch((error) => {
          console.warn('[ModelDownloadManager] Failed to stop background download task during private storage reset', summarizeErrorForLog(error));
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Check the queue and start next download if idle.
   */
  private async processQueue() {
    if (this.queueProcessingHoldCount > 0) return;
    if (this.isProcessing) return;

    if (!isPrivateStorageWritable()) {
      return;
    }
    
    const { queue, activeDownloadId, setActiveDownload, updateModelInQueue } = useDownloadStore.getState();
    
    // If already downloading something, stay idle
    if (activeDownloadId) return;

    const next = queue.find((m) => m.lifecycleStatus === LifecycleStatus.QUEUED);

    if (!next) {
      const hasPausedDownloads = queue.some((m) => m.lifecycleStatus === LifecycleStatus.PAUSED);

      // Keep the foreground-service notification around when downloads are paused,
      // so the user can understand why downloads aren't progressing.
      if (hasPausedDownloads) {
        return;
      }

      if (backgroundTaskService.isTaskActive('download')) {
        await backgroundTaskService.stopBackgroundTask('download');
      }
      return;
    }

    const settings = getSettings();
    const hardwareStatus = hardwareListenerService.getCurrentStatus();
    if (hardwareStatus.networkType === 'cellular' && settings.allowCellularDownloads === false) {
      if (next.lifecycleStatus !== LifecycleStatus.QUEUED) {
        const didPersist = await this.persistDownloadStoreMutation(() => {
          updateModelInQueue(next.id, { lifecycleStatus: LifecycleStatus.QUEUED });
        });
        if (!didPersist) {
          return;
        }
      }

      return;
    }

    const jobToken = ++this.nextJobToken;
    this.activeJob = { modelId: next.id, jobToken, resumable: null, stopReason: null };

    this.isProcessing = true;
    try {
      const didPersistActiveDownload = await this.persistDownloadStoreMutation(() => {
        setActiveDownload(next.id);
      });
      if (!didPersistActiveDownload) {
        this.clearFailedQueueStart(next.id, jobToken);
        return;
      }
    } catch (error) {
      this.clearFailedQueueStart(next.id, jobToken);
      throw error;
    }
    void this.runDownloadJob(next, jobToken);
  }

  private isCurrentJob(modelId: string, jobToken: number): boolean {
    return this.activeJob?.modelId === modelId && this.activeJob.jobToken === jobToken;
  }

  private getStopReason(modelId: string, jobToken: number): ActiveDownloadJob['stopReason'] {
    if (!this.isCurrentJob(modelId, jobToken)) {
      return null;
    }

    return this.activeJob?.stopReason ?? null;
  }

  private clearFailedQueueStart(modelId: string, jobToken: number): void {
    if (this.isCurrentJob(modelId, jobToken)) {
      this.activeJob = null;
      this.isProcessing = false;
    }

    if (useDownloadStore.getState().activeDownloadId !== modelId) {
      return;
    }

    this.queueProcessingHoldCount += 1;
    try {
      useDownloadStore.setState({ activeDownloadId: null });
    } catch (error) {
      console.warn(`[ModelDownloadManager] Failed to clear active download after queue start failure for ${modelId}`, summarizeErrorForLog(error));
    } finally {
      this.queueProcessingHoldCount = Math.max(0, this.queueProcessingHoldCount - 1);
    }
  }

  private async handlePrivateStorageUnavailable(error: unknown): Promise<boolean> {
    if (!isPrivateStorageUnavailableError(error)) {
      return false;
    }

    await this.stopActiveJobForPrivateStorageReset({ clearQueue: false });
    return true;
  }

  private async canPersistDownloadMutation(): Promise<boolean> {
    try {
      assertPrivateStorageWritableForDownloadMutation();
      return true;
    } catch (error) {
      if (await this.handlePrivateStorageUnavailable(error)) {
        return false;
      }

      throw error;
    }
  }

  private async persistDownloadStoreMutation(mutation: () => void): Promise<boolean> {
    try {
      assertPrivateStorageWritableForDownloadMutation();
      mutation();
      return true;
    } catch (error) {
      if (await this.handlePrivateStorageUnavailable(error)) {
        return false;
      }

      throw error;
    }
  }

  private async runDownloadJob(model: ModelMetadata, jobToken: number): Promise<void> {
    const { setActiveDownload, updateModelInQueue } = useDownloadStore.getState();

    try {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      await backgroundTaskService.startBackgroundDownload({
        type: 'downloadProgress',
        modelName: model.name,
        progressPercent: Math.round((model.downloadProgress ?? 0) * 100),
      });

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      await this.downloadModel(model, jobToken);
    } catch (e) {
      console.error(`[ModelDownloadManager] Failed to download ${model.id}`, summarizeErrorForLog(e));

      if (this.isCurrentJob(model.id, jobToken)) {
        await this.persistDownloadStoreMutation(() => {
          const currentQueueEntry = useDownloadStore
            .getState()
            .queue
            .find((queuedModel) => queuedModel.id === model.id);
          if (currentQueueEntry?.lifecycleStatus !== LifecycleStatus.FAILED) {
            updateModelInQueue(model.id, this.getDownloadFailureUpdates(e));
          }
          setActiveDownload(null);
        });
      }
    } finally {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      const deferredCancelCleanupFileNames = this.activeJob?.stopReason === 'cancel'
        ? this.activeJob.deferredCancelCleanupFileNames
        : undefined;
      if (deferredCancelCleanupFileNames?.length) {
        try {
          await this.deleteDownloadFiles(deferredCancelCleanupFileNames, model.id);
        } catch (error) {
          console.error(`[ModelDownloadManager] Failed to delete deferred canceled partial file for ${model.id}`, summarizeErrorForLog(error));
        }
      }

      this.activeJob = null;
      this.isProcessing = false;

      // Trigger next check
      void this.processQueue();
    }
  }

  private handleHardwareStatusChange = async (status: HardwareStatus) => {
    if (status.networkType === 'cellular') {
      const settings = getSettings();
      if (settings.allowCellularDownloads === true) {
        return;
      }

      const { activeDownloadId, queue } = useDownloadStore.getState();
      if (!activeDownloadId) {
        return;
      }

      const activeModel = queue.find((model) => model.id === activeDownloadId);
      if (!activeModel || activeModel.lifecycleStatus !== LifecycleStatus.DOWNLOADING) {
        return;
      }

      try {
        await this.pauseDownload(activeDownloadId);
      } catch (error) {
        console.warn('[ModelDownloadManager] Failed to pause download after cellular transition', summarizeErrorForLog(error));
      }

      // Update the foreground-service notification (Android) / cached notification details (iOS)
      // so the paused state is reflected even if the app is currently active.
      await backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' });

      if (AppState.currentState !== 'active') {
        void notificationService.sendPausedNotification();
      }

      return;
    }

    void this.processQueue();
  };

  private async downloadModel(model: ModelMetadata, jobToken: number) {
    const { updateModelInQueue, removeFromQueue, setActiveDownload } = useDownloadStore.getState();
    let resumable: ActiveDownloadJob['resumable'] = null;
    const modelsDir = getModelsDir();
    const selectedProjector = this.resolveProjectorForDownload(model);
    let reusableModelFile: ReusableModelDownloadFile | null = null;
    let reusableProjectorFile: ReusableProjectorDownloadFile | null = null;
    let baseModelMemoryFit: DownloadMemoryFitSummary | null = null;
    let downloadStage: 'base' | 'projector' | 'finalizing' = 'base';

    try {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      if (model.requiresTreeProbe && !model.resolvedFileName) {
        throw new AppError('download_metadata_unavailable', 'MODEL_METADATA_UNAVAILABLE', {
          details: { modelId: model.id },
        });
      }

      if (!modelsDir) {
        throw new AppError('action_failed', 'Local file system is unavailable on this platform.', {
          details: { modelId: model.id },
        });
      }

      reusableModelFile = await this.resolveReusableModelFile(model, modelsDir);
      if (!reusableModelFile && model.size === null && !model.allowUnknownSizeDownload) {
        throw new AppError('download_size_unknown', 'MODEL_SIZE_UNKNOWN', {
          details: { modelId: model.id },
        });
      }

      if (selectedProjector) {
        reusableProjectorFile = await this.resolveReusableProjectorFile(selectedProjector, modelsDir);

        if (!this.isCurrentJob(model.id, jobToken)) {
          return;
        }

        if (this.getStopReason(model.id, jobToken)) {
          return;
        }
      }

      const freeSpace = await FileSystem.getFreeDiskStorageAsync();
      if (this.getStopReason(model.id, jobToken)) {
        return;
      }
      const requiredModelBytes = reusableModelFile ? 0 : model.size ?? 0;
      const requiredProjectorBytes = selectedProjector && !reusableProjectorFile
        ? normalizePositiveByteSize(selectedProjector.size) ?? 0
        : 0;
      const requiredBytes = requiredModelBytes + requiredProjectorBytes + REQUIRED_DOWNLOAD_BUFFER_BYTES;
      const hasKnownDiskRequirement = requiredModelBytes > 0 || requiredProjectorBytes > 0;
      if (hasKnownDiskRequirement && freeSpace !== undefined && freeSpace < requiredBytes) {
        throw new AppError('download_disk_space_low', 'DISK_SPACE_LOW', {
          details: {
            modelId: model.id,
            ...(selectedProjector ? { artifactKind: 'projector' } : null),
            freeSpace,
            requiredBytes,
          },
        });
      }
    } catch (e: any) {
      console.error(`[ModelDownloadManager] Pre-download check failed for ${model.id}:`, summarizeErrorForLog(e));

      const stopReason = this.getStopReason(model.id, jobToken);
      if (stopReason) {
        return;
      }

      if (await this.handlePrivateStorageUnavailable(e)) {
        return;
      }

      if (this.isCurrentJob(model.id, jobToken)) {
        try {
          assertPrivateStorageWritableForDownloadMutation();
          const currentModel = this.getQueuedModel(model.id, model);
          const preflightError = toSanitizedDownloadAppError(e);
          const failedProjectorId = preflightError.code === 'download_disk_space_low'
            ? selectedProjector?.id
            : undefined;
          updateModelInQueue(model.id, {
            ...this.getDownloadFailureUpdates(e),
            ...this.getProjectorFailureUpdates(currentModel, failedProjectorId, e),
          });
          setActiveDownload(null);
        } catch (storageError) {
          if (await this.handlePrivateStorageUnavailable(storageError)) {
            return;
          }

          throw storageError;
        }
      }
      throw e;
    }

    if (this.getStopReason(model.id, jobToken)) {
      return;
    }

    const fileName = reusableModelFile?.fileName ?? await this.resolveDownloadFileName(model, modelsDir);
    if (this.getStopReason(model.id, jobToken)) {
      return;
    }

    const localUri = reusableModelFile?.localUri ?? safeJoinModelPath(modelsDir, fileName);
    if (!localUri) {
      throw new AppError('action_failed', 'Invalid download file name', {
        details: { modelId: model.id, artifactKind: 'model' },
      });
    }

    const PROGRESS_UPDATE_MIN_INTERVAL_MS = 500;
    const PROGRESS_UPDATE_MIN_DELTA = 0.005;
    let lastProgressUpdatedAt = 0;
    let lastProgress = -1;

    const NOTIFICATION_UPDATE_MIN_INTERVAL_MS = 2000;
    const NOTIFICATION_UPDATE_MIN_DELTA_PERCENT = 1;
    let lastNotificationUpdatedAt = 0;
    let lastNotifiedPercent = -1;

    let lastSpeedSampleWrittenBytes = 0;
    let lastSpeedSampleAt = 0;
    let lastSpeedBytesPerSec = 0;

    const callback = (downloadProgress: any) => {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      const writtenBytes = typeof downloadProgress?.totalBytesWritten === 'number'
        ? downloadProgress.totalBytesWritten
        : 0;
      const expectedBytes = typeof downloadProgress?.totalBytesExpectedToWrite === 'number'
        ? downloadProgress.totalBytesExpectedToWrite
        : 0;
      const progress = expectedBytes > 0 ? writtenBytes / expectedBytes : 0;
      const clampedProgress = Math.min(Math.max(progress, 0), 1);
      const now = Date.now();
      const delta = Math.abs(clampedProgress - lastProgress);
      const percent = Math.round(clampedProgress * 100);

      if (lastSpeedSampleAt === 0) {
        lastSpeedSampleAt = now;
        lastSpeedSampleWrittenBytes = writtenBytes;
      } else {
        const sampleDeltaMs = now - lastSpeedSampleAt;
        if (sampleDeltaMs >= 1000 && writtenBytes >= lastSpeedSampleWrittenBytes) {
          const deltaBytes = writtenBytes - lastSpeedSampleWrittenBytes;
          lastSpeedBytesPerSec = sampleDeltaMs > 0 ? (deltaBytes * 1000) / sampleDeltaMs : lastSpeedBytesPerSec;
          lastSpeedSampleAt = now;
          lastSpeedSampleWrittenBytes = writtenBytes;
        }
      }

      if (
        clampedProgress === 1 ||
        now - lastProgressUpdatedAt >= PROGRESS_UPDATE_MIN_INTERVAL_MS ||
        delta >= PROGRESS_UPDATE_MIN_DELTA
      ) {
        lastProgressUpdatedAt = now;
        lastProgress = clampedProgress;
        if (isPrivateStorageWritable()) {
          try {
            assertPrivateStorageWritableForDownloadMutation();
            updateModelInQueue(model.id, { downloadProgress: clampedProgress });
          } catch (error) {
            void this.handlePrivateStorageUnavailable(error).then((handled) => {
              if (!handled) {
                console.warn(`[ModelDownloadManager] Failed to persist progress for ${model.id}`, summarizeErrorForLog(error));
              }
            });
          }
        }
      }

      if (
        (percent === 100 && lastNotifiedPercent !== 100) ||
        (
          now - lastNotificationUpdatedAt >= NOTIFICATION_UPDATE_MIN_INTERVAL_MS
          && percent - lastNotifiedPercent >= NOTIFICATION_UPDATE_MIN_DELTA_PERCENT
        )
      ) {
        lastNotificationUpdatedAt = now;
        lastNotifiedPercent = percent;
        void backgroundTaskService.startBackgroundDownload({
          type: 'downloadProgress',
          modelName: model.name,
          progressPercent: percent,
          speedBytesPerSec: lastSpeedBytesPerSec,
        });
      }
    };

    const resumeString = normalizeDownloadResumeData(model.resumeData);

    if (!reusableModelFile) {
      // Prepare DownloadResumable
      resumable = FileSystem.createDownloadResumable(
        model.downloadUrl,
        localUri,
        await this.buildDownloadOptions(model, model.downloadUrl, model.id),
        callback,
        resumeString
      );

      if (this.isCurrentJob(model.id, jobToken) && this.activeJob) {
        this.activeJob.resumable = resumable;
        this.activeJob.activeArtifact = 'model';
        this.activeJob.activeProjectorId = undefined;
      }
    }

    try {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      assertPrivateStorageWritableForDownloadMutation();
      const latestQueuedModel = this.getQueuedModel(model.id, model);
      updateModelInQueue(model.id, {
        lifecycleStatus: LifecycleStatus.DOWNLOADING,
        ...(reusableModelFile ? {} : { downloadIntegrity: undefined }),
        downloadErrorAt: undefined,
        downloadErrorCode: undefined,
        downloadErrorMessage: undefined,
        ...(selectedProjector
          ? this.buildProjectorQueueUpdates(latestQueuedModel, selectedProjector, { lifecycleStatus: 'queued' })
          : {}),
      });
      
      let verification = reusableModelFile?.verification ?? null;
      if (!reusableModelFile) {
        const result = await resumable?.downloadAsync();

        if (!this.isCurrentJob(model.id, jobToken)) {
          return;
        }

        if (this.getStopReason(model.id, jobToken)) {
          return;
        }

        if (!result) {
          console.warn(`[ModelDownloadManager] downloadAsync returned undefined. Marking ${model.id} as paused to avoid a stuck queue.`);

          const updates: Partial<ModelMetadata> = { lifecycleStatus: LifecycleStatus.PAUSED };
          const resumeData = safeNormalizeResumeSnapshot(resumable as any, { modelId: model.id, scope: 'downloadAsync(undefined)' });
          if (resumeData) {
            updates.resumeData = resumeData;
          }

          assertPrivateStorageWritableForDownloadMutation();
          updateModelInQueue(model.id, updates);
          setActiveDownload(null);

          void backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' }).catch((error) => {
            console.warn('[ModelDownloadManager] Failed to update paused download notification', summarizeErrorForLog(error));
          });

          return;
        }

        // On some Android environments, status might be missing from result
        if (result.status && result.status >= 400) {
          throw new AppError('download_http_error', `Download failed with HTTP status ${result.status}`, {
            details: { modelId: model.id, status: result.status },
          });
        }

        assertPrivateStorageWritableForDownloadMutation();
        updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.VERIFYING });

        if (!this.isCurrentJob(model.id, jobToken)) {
          return;
        }

        if (this.getStopReason(model.id, jobToken)) {
          return;
        }

        verification = await this.verifyChecksum(model, localUri);
      }

      if (!verification) {
        throw new AppError('download_verification_failed', 'Download verification result is unavailable', {
          details: { modelId: model.id },
        });
      }

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      const downloadedFileInfo = await FileSystem.getInfoAsync(localUri);

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }
      if (this.getStopReason(model.id, jobToken)) {
        return;
      }
      if (!downloadedFileInfo.exists || isFileSystemDirectory(downloadedFileInfo)) {
        throw new AppError(
          'download_file_missing',
          downloadedFileInfo.exists
            ? 'Downloaded path became a directory before completion'
            : 'Downloaded file disappeared before completion',
          {
            details: buildVerificationErrorDetails(model, localUri),
          },
        );
      }
      const downloadedSize = (
        downloadedFileInfo.exists &&
        !isFileSystemDirectory(downloadedFileInfo) &&
        typeof downloadedFileInfo.size === 'number' &&
        Number.isFinite(downloadedFileInfo.size) &&
        downloadedFileInfo.size > 0
      )
        ? Math.round(downloadedFileInfo.size)
        : model.size;
      const latestBaseQueueModel = this.getQueuedModel(model.id, model);
      const baseCheckpointUpdates = this.buildBaseModelCheckpointUpdates({
        model: latestBaseQueueModel,
        fileName,
        downloadedSize,
        verification,
        preserveExistingVerifiedLocalMetadata: reusableModelFile !== null,
      });

      assertPrivateStorageWritableForDownloadMutation();
      updateModelInQueue(model.id, {
        ...baseCheckpointUpdates,
        lifecycleStatus: selectedProjector ? LifecycleStatus.DOWNLOADING : LifecycleStatus.VERIFYING,
      });

      const metadataTrust = baseCheckpointUpdates.metadataTrust;
      const ggufMetadata = baseCheckpointUpdates.gguf;
      baseModelMemoryFit = await this.resolveMemoryFit(downloadedSize, metadataTrust, ggufMetadata);

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      if (selectedProjector) {
        downloadStage = 'projector';

        if (!this.isCurrentJob(model.id, jobToken)) {
          return;
        }

        if (this.getStopReason(model.id, jobToken)) {
          return;
        }
      }

      const projectorResult = selectedProjector
        ? await this.downloadProjectorArtifact(
          this.getQueuedModel(model.id, model),
          selectedProjector,
          modelsDir,
          jobToken,
          await this.buildDownloadOptions(model, selectedProjector.downloadUrl, selectedProjector.repoId),
          reusableProjectorFile,
        )
        : null;

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }
      if (this.getStopReason(model.id, jobToken)) {
        return;
      }
      if (selectedProjector && projectorResult === null) {
        return;
      }

      downloadStage = 'finalizing';
      const memoryFitInputSize = typeof downloadedSize === 'number'
        ? getModelMemoryFitInputSizeBytes({
          modelSizeBytes: downloadedSize,
          projectorSizeBytes: projectorResult?.sizeBytes ?? undefined,
        }) ?? downloadedSize
        : downloadedSize;
      const memoryFit = projectorResult
        ? await this.resolveMemoryFit(memoryFitInputSize, metadataTrust, ggufMetadata)
        : baseModelMemoryFit ?? await this.resolveMemoryFit(memoryFitInputSize, metadataTrust, ggufMetadata);

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      // Success
      const latestCompletedQueueModel = this.getQueuedModel(model.id, model);
      const completedProjectorCandidates = projectorResult
        ? this.updateProjectorCandidates(latestCompletedQueueModel, projectorResult.projector.id, projectorResult.projector)
        : latestCompletedQueueModel.projectorCandidates;
      const completedModel: ModelMetadata = {
        ...latestCompletedQueueModel,
        ...baseCheckpointUpdates,
        fitsInRam: memoryFit.fitsInRam,
        memoryFitDecision: memoryFit.decision,
        memoryFitConfidence: memoryFit.confidence,
        downloadedAt: Date.now(),
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        projectorCandidates: completedProjectorCandidates,
      };

      assertPrivateStorageWritableForDownloadMutation();
      registry.updateModel(completedModel);
      assertPrivateStorageWritableForDownloadMutation();
      removeFromQueue(model.id);

      if (AppState.currentState !== 'active') {
        void notificationService.sendCompletionNotification('download', { modelName: model.name });
      }
      console.log(`[ModelDownloadManager] Downloaded and verified: ${model.id}`);

    } catch (e: any) {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      const stopReason = this.getStopReason(model.id, jobToken);
      if (stopReason) {
        return;
      }

      if (await this.handlePrivateStorageUnavailable(e)) {
        return;
      }

      console.error(`[ModelDownloadManager] Download error for ${model.id}`, summarizeErrorForLog(e));

      // If it fails, keep the entry in the queue with explicit failed state.
      // This avoids infinite retry loops while preserving retry and resume context.
      const failedProjectorId = this.activeJob?.activeArtifact === 'projector'
        ? this.activeJob.activeProjectorId
        : undefined;
      const isProjectorFailure = this.activeJob?.activeArtifact === 'projector';
      const resumeData = isProjectorFailure
        ? undefined
        : safeNormalizeResumeSnapshot(resumable as any, { modelId: model.id, scope: 'downloadError' });
      const projectorResumeData = isProjectorFailure
        ? safeNormalizeResumeSnapshot(this.activeJob?.resumable as any, { modelId: model.id, scope: 'projectorDownloadError' })
        : undefined;
      try {
        assertPrivateStorageWritableForDownloadMutation();
        const currentModel = this.getQueuedModel(model.id, model);
        const projectorStageFailedAfterBaseVerified = downloadStage === 'projector'
          && selectedProjector !== null
          && baseModelMemoryFit !== null;
        const projectorFailureUpdates = this.getProjectorFailureUpdates(
          currentModel,
          failedProjectorId ?? (projectorStageFailedAfterBaseVerified ? selectedProjector?.id : undefined),
          e,
          projectorResumeData,
        );

        if (projectorStageFailedAfterBaseVerified && baseModelMemoryFit) {
          registry.updateModel(this.buildTextReadyModelAfterProjectorFailure({
            model: currentModel,
            projectorFailureUpdates,
            memoryFit: baseModelMemoryFit,
          }));
          removeFromQueue(model.id);
        } else {
          updateModelInQueue(model.id, {
            ...this.getDownloadFailureUpdates(e, resumeData),
            ...projectorFailureUpdates,
          });
        }
        setActiveDownload(null);
      } catch (storageError) {
        if (await this.handlePrivateStorageUnavailable(storageError)) {
          return;
        }

        throw storageError;
      }

      if (AppState.currentState !== 'active') {
        const appError = toSanitizedDownloadAppError(e);
        const reason: DownloadErrorReason = appError.code === 'download_disk_space_low'
          ? 'storageFull'
          : appError.code === 'download_verification_failed'
            ? 'verificationFailed'
            : appError.code === 'download_http_error'
              ? 'connectionLost'
              : 'unknown';

        void notificationService.sendErrorNotification({ modelName: model.name, reason });
      }

      throw e;
    } finally {
      if (this.isCurrentJob(model.id, jobToken) && this.activeJob) {
        this.activeJob.resumable = null;
        this.activeJob.activeArtifact = undefined;
        this.activeJob.activeProjectorId = undefined;
      }
    }
    }

  private async resolveReusableProjectorFile(
    projector: ProjectorArtifact,
    modelsDir: string,
  ): Promise<ReusableProjectorDownloadFile | null> {
    if (!isStoredProjectorArtifact(projector) || !isValidLocalFileName(projector.localPath)) {
      return null;
    }

    const localUri = safeJoinModelPath(modelsDir, projector.localPath);
    if (!localUri) {
      return null;
    }

    const fileInfo = await FileSystem.getInfoAsync(localUri);
    if (!fileInfo.exists || isFileSystemDirectory(fileInfo)) {
      return null;
    }

    const sizeBytes = typeof fileInfo.size === 'number' && Number.isFinite(fileInfo.size) && fileInfo.size > 0
      ? Math.round(fileInfo.size)
      : null;

    return {
      fileName: projector.localPath,
      sizeBytes,
    };
  }

  private async assertSufficientDiskSpaceForProjectorDownload(
    model: ModelMetadata,
    projector: ProjectorArtifact,
  ): Promise<void> {
    const requiredProjectorBytes = normalizePositiveByteSize(projector.size) ?? 0;
    if (requiredProjectorBytes <= 0) {
      return;
    }

    const freeSpace = await FileSystem.getFreeDiskStorageAsync();
    const requiredBytes = requiredProjectorBytes + REQUIRED_DOWNLOAD_BUFFER_BYTES;
    if (freeSpace !== undefined && freeSpace < requiredBytes) {
      throw new AppError('download_disk_space_low', 'DISK_SPACE_LOW', {
        details: {
          modelId: model.id,
          artifactKind: 'projector',
          freeSpace,
          requiredBytes,
        },
      });
    }
  }

  private createProjectorProgressCallback(
    model: ModelMetadata,
    projector: ProjectorArtifact,
    jobToken: number,
  ): (downloadProgress: any) => void {
    const PROGRESS_UPDATE_MIN_INTERVAL_MS = 500;
    const PROGRESS_UPDATE_MIN_DELTA = 0.005;
    const NOTIFICATION_UPDATE_MIN_INTERVAL_MS = 2000;
    const NOTIFICATION_UPDATE_MIN_DELTA_PERCENT = 1;
    let lastProgressUpdatedAt = 0;
    let lastProgress = -1;
    let lastNotificationUpdatedAt = 0;
    let lastNotifiedPercent = -1;
    let lastSpeedSampleWrittenBytes = 0;
    let lastSpeedSampleAt = 0;
    let lastSpeedBytesPerSec = 0;

    return (downloadProgress: any) => {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      const writtenBytes = typeof downloadProgress?.totalBytesWritten === 'number'
        ? downloadProgress.totalBytesWritten
        : 0;
      const expectedBytes = typeof downloadProgress?.totalBytesExpectedToWrite === 'number'
        ? downloadProgress.totalBytesExpectedToWrite
        : 0;
      const progress = expectedBytes > 0 ? writtenBytes / expectedBytes : 0;
      const clampedProgress = Math.min(Math.max(progress, 0), 1);
      const now = Date.now();
      const delta = Math.abs(clampedProgress - lastProgress);
      const percent = Math.round(clampedProgress * 100);

      if (lastSpeedSampleAt === 0) {
        lastSpeedSampleAt = now;
        lastSpeedSampleWrittenBytes = writtenBytes;
      } else {
        const sampleDeltaMs = now - lastSpeedSampleAt;
        if (sampleDeltaMs >= 1000 && writtenBytes >= lastSpeedSampleWrittenBytes) {
          const deltaBytes = writtenBytes - lastSpeedSampleWrittenBytes;
          lastSpeedBytesPerSec = sampleDeltaMs > 0 ? (deltaBytes * 1000) / sampleDeltaMs : lastSpeedBytesPerSec;
          lastSpeedSampleAt = now;
          lastSpeedSampleWrittenBytes = writtenBytes;
        }
      }

      if (
        clampedProgress === 1 ||
        now - lastProgressUpdatedAt >= PROGRESS_UPDATE_MIN_INTERVAL_MS ||
        delta >= PROGRESS_UPDATE_MIN_DELTA
      ) {
        lastProgressUpdatedAt = now;
        lastProgress = clampedProgress;
        if (isPrivateStorageWritable()) {
          try {
            assertPrivateStorageWritableForDownloadMutation();
            const currentModel = this.getQueuedModel(model.id, model);
            this.updateQueuedProjector(model.id, currentModel, projector, { downloadProgress: clampedProgress });
          } catch (error) {
            void this.handlePrivateStorageUnavailable(error).then((handled) => {
              if (!handled) {
                console.warn(`[ModelDownloadManager] Failed to persist projector progress for ${model.id}`, summarizeErrorForLog(error));
              }
            });
          }
        }
      }

      if (
        (percent === 100 && lastNotifiedPercent !== 100) ||
        (
          now - lastNotificationUpdatedAt >= NOTIFICATION_UPDATE_MIN_INTERVAL_MS
          && percent - lastNotifiedPercent >= NOTIFICATION_UPDATE_MIN_DELTA_PERCENT
        )
      ) {
        lastNotificationUpdatedAt = now;
        lastNotifiedPercent = percent;
        void backgroundTaskService.startBackgroundDownload({
          type: 'downloadProgress',
          modelName: model.name,
          progressPercent: percent,
          speedBytesPerSec: lastSpeedBytesPerSec,
        });
      }
    };
  }

  private async resolveProjectorDownloadFileName(
    projector: ProjectorArtifact,
    modelsDir: string,
  ): Promise<string> {
    const candidates = this.getProjectorDownloadFileNameCandidates(projector);
    const protectedCompletedFileNames = this.getProtectedCompletedModelFileNames();
    let firstAvailableCandidate: string | undefined;

    for (const candidate of candidates) {
      if (protectedCompletedFileNames.has(candidate)) {
        console.warn('[ModelDownloadManager] Projector download candidate is already completed, skipping overwrite', {
          artifactKind: 'projector',
          pathCategory: 'model_storage',
        });
        continue;
      }

      const candidatePath = safeJoinModelPath(modelsDir, candidate);
      if (!candidatePath) {
        continue;
      }

      const info = await FileSystem.getInfoAsync(candidatePath);
      if (!info.exists) {
        firstAvailableCandidate ??= candidate;
        continue;
      }
      if (isFileSystemDirectory(info)) {
        console.warn('[ModelDownloadManager] Projector download candidate is a directory, skipping', {
          artifactKind: 'projector',
          pathCategory: 'model_storage',
        });
        continue;
      }

      return candidate;
    }

    if (firstAvailableCandidate) {
      return firstAvailableCandidate;
    }

    throw new AppError('download_file_missing', 'No safe projector download file target is available', {
      details: { artifactKind: 'projector', candidateCount: candidates.length },
    });
  }

  private async downloadProjectorArtifact(
    model: ModelMetadata,
    projector: ProjectorArtifact,
    modelsDir: string,
    jobToken: number,
    downloadOptions: { headers?: Record<string, string> },
    reusableProjectorFile: ReusableProjectorDownloadFile | null,
  ): Promise<ProjectorDownloadResult | null> {
    let reusableProjectorRejected = false;

    if (reusableProjectorFile) {
      if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
        return null;
      }

      const reusableLocalUri = safeJoinModelPath(modelsDir, reusableProjectorFile.fileName);
      if (reusableLocalUri) {
        try {
          if (this.isCurrentJob(model.id, jobToken) && this.activeJob) {
            this.activeJob.resumable = null;
            this.activeJob.activeArtifact = 'projector';
            this.activeJob.activeProjectorId = projector.id;
          }

          const verification = await this.verifyChecksum(projector, reusableLocalUri);

          if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
            return null;
          }

          return {
            projector: {
              ...projector,
              localPath: reusableProjectorFile.fileName,
              size: verification.sizeBytes,
              lifecycleStatus: 'downloaded',
            },
            sizeBytes: verification.sizeBytes,
          };
        } catch (error) {
          if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
            return null;
          }

          console.warn('[ModelDownloadManager] Existing projector artifact cannot be reused', {
            artifactKind: 'projector',
            ...summarizeErrorForLog(error),
          });
          reusableProjectorRejected = true;
        }
      }
    }

    if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
      return null;
    }

    if (reusableProjectorRejected) {
      await this.assertSufficientDiskSpaceForProjectorDownload(model, projector);

      if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
        return null;
      }
    }

    const fileName = await this.resolveProjectorDownloadFileName(projector, modelsDir);
    const localUri = safeJoinModelPath(modelsDir, fileName);
    if (!localUri) {
      throw new AppError('action_failed', 'Invalid projector download file name', {
        details: { modelId: model.id, artifactKind: 'projector' },
      });
    }

    this.updateQueuedProjector(model.id, model, projector, {
      lifecycleStatus: 'downloading',
      localPath: fileName,
      downloadProgress: 0,
    });

    if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
      return null;
    }

    const projectorResumeData = projector.lifecycleStatus === 'paused'
      ? normalizeDownloadResumeData(projector.resumeData)
      : undefined;
    const projectorResumable = FileSystem.createDownloadResumable(
      projector.downloadUrl,
      localUri,
      downloadOptions,
      this.createProjectorProgressCallback(model, projector, jobToken),
      projectorResumeData,
    );

    if (this.isCurrentJob(model.id, jobToken) && this.activeJob) {
      this.activeJob.resumable = projectorResumable;
      this.activeJob.activeArtifact = 'projector';
      this.activeJob.activeProjectorId = projector.id;
    }

    const result = await projectorResumable.downloadAsync();

    if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
      return null;
    }

    if (!result) {
      console.warn(`[ModelDownloadManager] projector downloadAsync returned undefined. Marking ${model.id} as paused to avoid a stuck queue.`);

      const { updateModelInQueue, setActiveDownload } = useDownloadStore.getState();
      const currentModel = this.getQueuedModel(model.id, model);
      const resumeData = safeNormalizeResumeSnapshot(projectorResumable as any, { modelId: model.id, scope: 'projectorDownloadAsync(undefined)' });
      assertPrivateStorageWritableForDownloadMutation();
      updateModelInQueue(model.id, {
        lifecycleStatus: LifecycleStatus.PAUSED,
        ...this.buildProjectorQueueUpdates(currentModel, projector, {
          lifecycleStatus: 'paused',
          resumeData,
        }),
      });
      setActiveDownload(null);

      void backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' }).catch((error) => {
        console.warn('[ModelDownloadManager] Failed to update paused projector download notification', summarizeErrorForLog(error));
      });

      return null;
    }

    if (result.status && result.status >= 400) {
      throw new AppError('download_http_error', `Projector download failed with HTTP status ${result.status}`, {
        details: { modelId: model.id, artifactKind: 'projector', status: result.status },
      });
    }

    if (this.isCurrentJob(model.id, jobToken) && this.activeJob) {
      // Projector bytes are fully downloaded now; checksum/GGUF validation is not
      // resumable. Keep activeArtifact metadata so verification failures are
      // recorded against the projector, but clear the resumable and move the
      // queue into VERIFYING so pause requests are ignored instead of persisting
      // stale resume data for an already-complete artifact.
      this.activeJob.resumable = null;
      this.activeJob.activeArtifact = 'projector';
      this.activeJob.activeProjectorId = projector.id;
    }

    assertPrivateStorageWritableForDownloadMutation();
    const currentModelBeforeVerification = this.getQueuedModel(model.id, model);
    const { updateModelInQueue } = useDownloadStore.getState();
    updateModelInQueue(model.id, {
      lifecycleStatus: LifecycleStatus.VERIFYING,
      ...this.buildProjectorQueueUpdates(currentModelBeforeVerification, projector, {
        localPath: fileName,
        resumeData: undefined,
        downloadProgress: 1,
      }),
    });

    const verification = await this.verifyChecksum(projector, localUri);

    if (!this.isCurrentJob(model.id, jobToken) || this.getStopReason(model.id, jobToken)) {
      return null;
    }

    const downloadedProjector: ProjectorArtifact = {
      ...projector,
      size: verification.sizeBytes,
      localPath: fileName,
      resumeData: undefined,
      downloadProgress: 1,
      lifecycleStatus: 'downloaded',
      matchStatus: projector.matchStatus as ProjectorMatchStatus,
    };

    this.updateQueuedProjector(model.id, model, downloadedProjector, downloadedProjector);

    return {
      projector: downloadedProjector,
      sizeBytes: verification.sizeBytes,
    };
  }

  public async verifyChecksum(
    model: Pick<ModelMetadata, 'id' | 'size' | 'sha256'>,
    localUri: string,
  ): Promise<DownloadVerificationResult> {
    try {
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (!fileInfo.exists) {
        throw new AppError('download_file_missing', 'File does not exist after download', {
          details: buildVerificationErrorDetails(model, localUri),
        });
      }
      if (isFileSystemDirectory(fileInfo)) {
        throw new AppError('download_file_missing', 'Downloaded path is a directory, not a model file', {
          details: buildVerificationErrorDetails(model, localUri),
        });
      }

      const downloadedSize = fileInfo.size ?? 0;
      const expectedSize = model.size;

      if (typeof expectedSize === 'number' && expectedSize > 0 && downloadedSize !== expectedSize) {
        await this.deleteCorruptedDownload(localUri, model.id);
        throw new AppError(
          'download_verification_failed',
          `Size mismatch: Expected ${expectedSize} but got ${downloadedSize}`,
          {
            details: buildVerificationErrorDetails(model, localUri, { expectedSize, downloadedSize }),
          },
        );
      }

      // SHA-256 proves byte-for-byte integrity against upstream metadata, but it does
      // not prove that the bytes are a loadable GGUF payload. Keep this validation
      // outside the hash branch so every completed download passes the same file
      // format gate before it can be marked DOWNLOADED/verified_local.
      try {
        await validateGgufFileHeader(localUri, fileInfo);
      } catch (error) {
        if (error instanceof GgufValidationError) {
          if (shouldDeleteInvalidGgufDownload(error.reason)) {
            await this.deleteCorruptedDownload(localUri, model.id);
          }
          throw new AppError(
            'download_verification_failed',
            error.message,
            {
              details: {
                ...buildVerificationErrorDetails(model, localUri),
                reason: error.reason,
                ...(sanitizeErrorDetails(error.details) ?? {}),
              },
            },
          );
        }

        throw error;
      }

      const expectedHash = normalizeSha256Digest(model.sha256);
      if (!expectedHash) {
        return {
          integrity: typeof expectedSize === 'number' && expectedSize > 0 ? 'size' : 'unverified',
          sizeBytes: downloadedSize,
        };
      }

      const actualHash = normalizeSha256Digest(
        await RNFS.hash(this.toNativeFilePath(localUri), 'sha256'),
      );
      if (!actualHash || actualHash !== expectedHash) {
        await this.deleteCorruptedDownload(localUri, model.id);
        throw new AppError(
          'download_verification_failed',
          `Checksum mismatch for ${model.id}`,
          {
            details: buildVerificationErrorDetails(model, localUri, { expectedHash, actualHash }),
          },
        );
      }

      return { integrity: 'sha256', sha256: actualHash, sizeBytes: downloadedSize };
    } catch (error) {
      throw toSanitizedDownloadAppError(error, 'download_verification_failed');
    }
  }

  private async buildDownloadOptions(
    model: ModelMetadata,
    targetUrl: string,
    expectedRepoId: string,
  ): Promise<{ headers?: Record<string, string> }> {
    const requiresAuth = model.accessState !== ModelAccessState.PUBLIC || model.isGated || model.isPrivate;
    const isTrustedHuggingFaceDownload = isTrustedHuggingFaceResolveUrlForRepo(targetUrl, expectedRepoId);

    if (!requiresAuth || !isTrustedHuggingFaceDownload) {
      return {};
    }

    const token = await huggingFaceTokenService.getToken();
    if (!token) {
      return {};
    }

    return {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    };
  }

  public async pauseDownload(modelId: string) {
    const { queue, updateModelInQueue, setActiveDownload } = useDownloadStore.getState();
    const queuedModel = queue.find((model) => model.id === modelId) ?? null;
    if (queuedModel?.lifecycleStatus === LifecycleStatus.VERIFYING) {
      // Verifying is not a resumable operation. Use "Cancel" to stop and clean up.
      console.warn(`[ModelDownloadManager] pauseDownload(${modelId}) ignored during VERIFYING`);
      return;
    }

    const activeJobForPauseGuard = this.activeJob?.modelId === modelId
      ? this.activeJob
      : null;
    if (activeJobForPauseGuard?.activeArtifact === 'projector' && activeJobForPauseGuard.resumable === null) {
      // Reusable projector checksum/GGUF verification is not resumable, even if
      // the owning model queue row still says DOWNLOADING after the base model
      // phase. Treat it like VERIFYING so pause cannot persist stale resume data.
      console.warn(`[ModelDownloadManager] pauseDownload(${modelId}) ignored during projector verification`);
      return;
    }

    if (!(await this.canPersistDownloadMutation())) {
      return;
    }

    const job = this.activeJob;
    if (!job || job.modelId !== modelId) {
      // Best-effort: allow pausing a queued download before it becomes active.
      await this.persistDownloadStoreMutation(() => {
        const queuedProjector = queuedModel ? this.resolveProjectorForDownload(queuedModel) : null;
        updateModelInQueue(modelId, {
          lifecycleStatus: LifecycleStatus.PAUSED,
          ...(queuedModel && queuedProjector
            ? this.buildProjectorQueueUpdates(queuedModel, queuedProjector, { lifecycleStatus: 'paused' })
            : {}),
        });
      });
      return;
    }

    const jobToken = job.jobToken;
    const activeArtifact = job.activeArtifact;
    const activeProjectorId = job.activeProjectorId;
    let resumeSnapshot: unknown | null = null;

    try {
      job.stopReason = 'pause';
      if (job.resumable) {
        try {
          resumeSnapshot = await job.resumable.pauseAsync();
        } catch (error) {
          console.warn(`[ModelDownloadManager] pauseAsync failed for ${modelId}`, summarizeErrorForLog(error));

          try {
            resumeSnapshot = job.resumable.savable?.() ?? null;
          } catch {
            resumeSnapshot = null;
          }
        }
      }

      // No resumable yet (pre-download checks). Mark as paused and drop the active state.
    } finally {
      if (this.isCurrentJob(modelId, jobToken)) {
        const updates: Partial<ModelMetadata> = { lifecycleStatus: LifecycleStatus.PAUSED };
        const resumeData = safeNormalizeResumeSnapshotValue(resumeSnapshot, { modelId, scope: 'pauseDownload' });
        if (resumeData && activeArtifact !== 'projector') {
          updates.resumeData = resumeData;
        }
        if (queuedModel && activeProjectorId) {
          const projectorResumeData = activeArtifact === 'projector' ? resumeData : undefined;
          const projectorCandidates = this.updateProjectorCandidates(queuedModel, activeProjectorId, {
            lifecycleStatus: 'paused',
            resumeData: projectorResumeData,
          });
          if (projectorCandidates) {
            updates.projectorCandidates = projectorCandidates;
          }
        }

        await this.persistDownloadStoreMutation(() => {
          updateModelInQueue(modelId, updates);
          setActiveDownload(null);
        });
      }
    }
  }

  public async cancelDownload(modelId: string) {
    const { queue, removeFromQueue, activeDownloadId, setActiveDownload } = useDownloadStore.getState();
    const queuedModel = queue.find((model) => model.id === modelId);
    let shouldProcessAfterCleanup = false;
    let shouldDeletePartialFiles = false;
    let safeToDeletePartialFiles = true;
    let shouldWaitForActiveJobToSettle = false;
    let cancelJob: ActiveDownloadJob | null = null;
    let cancelActiveArtifact: ActiveDownloadJob['activeArtifact'] = undefined;

    this.queueProcessingHoldCount += 1;
    try {
      if (!(await this.canPersistDownloadMutation())) {
        return;
      }

      const job = this.activeJob?.modelId === modelId
        ? this.activeJob
        : null;
      cancelJob = job;
      cancelActiveArtifact = job?.activeArtifact;
      const canInvalidateActiveJobImmediately = job !== null && job.resumable === null;
      if (job) {
        job.stopReason = 'cancel';
      }

      if (job?.resumable) {
        job.deferredCancelCleanupFileNames = this.getCancelCleanupFileNameCandidates(queuedModel, modelId, {
          activeArtifact: job.activeArtifact,
        });
        try {
          await job.resumable.pauseAsync(); // Stop active one
          job.deferredCancelCleanupFileNames = undefined;
        } catch (error) {
          console.warn(`[ModelDownloadManager] Failed to pause active download during cancel for ${modelId}`, summarizeErrorForLog(error));
          const activeJobStillCurrent = this.activeJob === job && this.isCurrentJob(modelId, job.jobToken);
          safeToDeletePartialFiles = !activeJobStillCurrent;
          shouldWaitForActiveJobToSettle = activeJobStillCurrent;
          if (activeJobStillCurrent) {
            this.isProcessing = true;
          }
        }
      }

      if (activeDownloadId === modelId) {
        const didPersistActiveClear = await this.persistDownloadStoreMutation(() => {
          setActiveDownload(null);
        });
        if (!didPersistActiveClear) {
          return;
        }
      }

      shouldProcessAfterCleanup = !shouldWaitForActiveJobToSettle;

      // Remove from queue first to stop UI
      const didPersistQueueRemoval = await this.persistDownloadStoreMutation(() => {
        removeFromQueue(modelId);
      });
      if (!didPersistQueueRemoval) {
        return;
      }
      if (canInvalidateActiveJobImmediately && job !== null && this.activeJob === job && this.isCurrentJob(modelId, job.jobToken)) {
        this.activeJob = null;
        this.isProcessing = false;
      }
      shouldDeletePartialFiles = safeToDeletePartialFiles;

    } finally {
      try {
        if (shouldDeletePartialFiles) {
          // Delete the partial file to free up disk space before allowing any requeued
          // item for the same filename to create a new resumable.
          await this.deleteDownloadFiles(
            this.getCancelCleanupFileNameCandidates(queuedModel, modelId, {
              activeArtifact: cancelActiveArtifact,
            }),
            modelId,
          );
        }
      } catch (error) {
        console.error(`[ModelDownloadManager] Failed to delete partial file for ${modelId}`, summarizeErrorForLog(error));
      } finally {
        this.queueProcessingHoldCount = Math.max(0, this.queueProcessingHoldCount - 1);
        const activeCancelJobStillCurrent = shouldWaitForActiveJobToSettle
          && cancelJob !== null
          && this.activeJob === cancelJob
          && this.isCurrentJob(modelId, cancelJob.jobToken);
        if (shouldProcessAfterCleanup || (shouldWaitForActiveJobToSettle && !activeCancelJobStillCurrent)) {
          void this.processQueue();
        }
      }
    }
  }

  private getDownloadFileNameCandidates(
    model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision' | 'localPath'>,
  ): string[] {
    const candidates = getCandidateModelDownloadFileNames(model);
    return model.localPath && isValidLocalFileName(model.localPath)
      ? Array.from(new Set([model.localPath, ...candidates]))
      : candidates;
  }

  private getCancelCleanupFileNameCandidates(
    queuedModel: ModelMetadata | undefined,
    modelId: string,
    options?: { activeArtifact?: ActiveDownloadJob['activeArtifact'] },
  ): string[] {
    const modelCandidates = queuedModel
      ? this.getDownloadFileNameCandidates(queuedModel)
      : getCandidateModelDownloadFileNames({
        id: modelId,
        resolvedFileName: undefined,
        hfRevision: undefined,
      });
    const selectedProjector = queuedModel ? this.resolveProjectorForDownload(queuedModel) : null;
    const projectorCandidates = selectedProjector
      ? this.getProjectorDownloadFileNameCandidates(selectedProjector)
      : [];
    const protectedBaseCheckpointFileName = options?.activeArtifact === 'projector' && queuedModel && this.hasVerifiedQueuedBaseCheckpoint(queuedModel)
      ? queuedModel.localPath
      : undefined;
    const safeModelCandidates = protectedBaseCheckpointFileName
      ? modelCandidates.filter((candidate) => candidate !== protectedBaseCheckpointFileName)
      : modelCandidates;
    const safeProjectorCandidates = protectedBaseCheckpointFileName
      ? projectorCandidates.filter((candidate) => candidate !== protectedBaseCheckpointFileName)
      : projectorCandidates;

    return Array.from(new Set([...safeModelCandidates, ...safeProjectorCandidates]));
  }

  private hasVerifiedQueuedBaseCheckpoint(
    model: Pick<ModelMetadata, 'localPath' | 'downloadProgress' | 'downloadIntegrity' | 'metadataTrust'>,
  ): model is typeof model & { localPath: string } {
    return isValidLocalFileName(model.localPath)
      && model.downloadProgress === 1
      && (model.downloadIntegrity !== undefined || model.metadataTrust === 'verified_local');
  }

  private getProtectedCompletedModelFileNames(): Set<string> {
    return new Set(
      registry.getModels()
        .flatMap((model) => [
          ...(
            model.lifecycleStatus === LifecycleStatus.DOWNLOADED
            || model.lifecycleStatus === LifecycleStatus.ACTIVE
              ? [model.localPath]
              : []
          ),
          ...(model.projectorCandidates ?? [])
            .filter((projector) => isStoredProjectorArtifact(projector))
            .map((projector) => projector.localPath),
        ])
        .filter((fileName): fileName is string => typeof fileName === 'string' && isValidLocalFileName(fileName)),
    );
  }

  private async resolveDownloadFileName(
    model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision' | 'localPath'>,
    modelsDir: string,
  ): Promise<string> {
    const candidates = this.getDownloadFileNameCandidates(model);
    const protectedCompletedFileNames = this.getProtectedCompletedModelFileNames();
    let firstAvailableCandidate: string | undefined;

    for (const candidate of candidates) {
      if (protectedCompletedFileNames.has(candidate)) {
        console.warn('[ModelDownloadManager] Download candidate is a completed model file, skipping', {
          artifactKind: 'model',
          pathCategory: 'model_storage',
        });
        continue;
      }

      const candidatePath = safeJoinModelPath(modelsDir, candidate);
      if (!candidatePath) {
        continue;
      }
      const info = await FileSystem.getInfoAsync(candidatePath);
      if (!info.exists) {
        firstAvailableCandidate ??= candidate;
        continue;
      }
      if (isFileSystemDirectory(info)) {
        console.warn('[ModelDownloadManager] Download candidate is a directory, skipping', {
          artifactKind: 'model',
          pathCategory: 'model_storage',
        });
        continue;
      }
      if (info.exists) {
        return candidate;
      }
    }

    if (firstAvailableCandidate) {
      return firstAvailableCandidate;
    }

    throw new AppError('download_file_missing', `No safe download file target is available for ${model.id}`, {
      details: { modelId: model.id, artifactKind: 'model', candidateCount: candidates.length },
    });
  }

  private async deleteDownloadFiles(fileNames: string[], modelId: string): Promise<void> {
    const modelsDir = getModelsDir();
    if (!modelsDir) {
      return;
    }

    let deletedAnyFile = false;
    const protectedCompletedFileNames = this.getProtectedCompletedModelFileNames();

    for (const fileName of Array.from(new Set(fileNames))) {
      if (protectedCompletedFileNames.has(fileName)) {
        console.warn('[ModelDownloadManager] Partial download candidate is a completed model file, skipping', {
          artifactKind: 'model',
          pathCategory: 'model_storage',
        });
        continue;
      }

      const localUri = safeJoinModelPath(modelsDir, fileName);
      if (!localUri) {
        continue;
      }
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (!fileInfo.exists) {
        continue;
      }
      if (isFileSystemDirectory(fileInfo)) {
        console.warn('[ModelDownloadManager] Partial download candidate is a directory, skipping', {
          artifactKind: 'model',
          pathCategory: 'model_storage',
        });
        continue;
      }

      await FileSystem.deleteAsync(localUri, { idempotent: true });
      deletedAnyFile = true;
    }

    if (deletedAnyFile) {
      console.log(`[ModelDownloadManager] Deleted partial download for ${modelId}`);
    }
  }

  private toNativeFilePath(fileUri: string): string {
    return fileUriToNativePath(fileUri);
  }

  private async resolveMemoryFit(
    size: number | null,
    metadataTrust: ModelMetadata['metadataTrust'],
    gguf?: ModelMetadata['gguf'],
  ): Promise<{
    fitsInRam: boolean | null;
    decision: ModelMemoryFitDecision;
    confidence: ModelMemoryFitConfidence;
  }> {
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      return { fitsInRam: null, decision: 'unknown', confidence: 'low' };
    }

    let totalMemoryBytes: number | null = null;
    try {
      totalMemoryBytes = await DeviceInfo.getTotalMemory();
    } catch {
      totalMemoryBytes = null;
    }
    const fit = estimateFastMemoryFit({
      modelSizeBytes: size,
      totalMemoryBytes,
      metadataTrust,
      ggufMetadata: gguf as Record<string, unknown> | undefined,
    });

    return {
      fitsInRam: fit.decision === 'unknown'
        ? null
        : fit.decision === 'fits_high_confidence' || fit.decision === 'fits_low_confidence',
      decision: fit.decision,
      confidence: fit.confidence,
    };
  }

  private async deleteCorruptedDownload(localUri: string, modelId: string): Promise<void> {
    try {
      const modelsDir = getModelsDir();
      const protectedCompletedUris = modelsDir
        ? new Set(
          Array.from(this.getProtectedCompletedModelFileNames())
            .map((fileName) => safeJoinModelPath(modelsDir, fileName))
            .filter((uri): uri is string => typeof uri === 'string'),
        )
        : new Set<string>();
      if (protectedCompletedUris.has(localUri)) {
        console.warn(`[ModelDownloadManager] Corrupted download path for ${modelId} is a completed model file, skipping delete`);
        return;
      }

      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (!fileInfo.exists || isFileSystemDirectory(fileInfo)) {
        if (fileInfo.exists) {
          console.warn(`[ModelDownloadManager] Corrupted download path for ${modelId} is a directory, skipping delete`);
        }
        return;
      }
      await FileSystem.deleteAsync(localUri, { idempotent: true });
    } catch (error) {
      console.warn(`[ModelDownloadManager] Failed to delete corrupted download for ${modelId}`, summarizeErrorForLog(error));
    }
  }
}

export function getModelDownloadManager(): ModelDownloadManager {
  return ModelDownloadManager.getInstance();
}

export function resumeModelDownloadQueueIfStorageReady(): void {
  ModelDownloadManager.getInstance().resumeQueueIfStorageReady();
}

export async function resetModelDownloadManagerForPrivateStorageReset(): Promise<void> {
  await ModelDownloadManager.resetRuntimeForPrivateStorageReset();
}

export async function stopModelDownloadManagerForPrivateStorageBlocked(): Promise<void> {
  await ModelDownloadManager.stopRuntimeForPrivateStorageBlocked();
}
