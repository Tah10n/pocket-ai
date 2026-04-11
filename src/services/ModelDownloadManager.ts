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
import { registry } from './LocalStorageRegistry';
import { getModelsDir } from './FileSystemSetup';
import { AppError, toAppError } from './AppError';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import { isHuggingFaceUrl } from '../utils/huggingFaceUrls';
import { getCandidateModelDownloadFileNames } from '../utils/modelFiles';
import { estimateFastMemoryFit } from '../memory/estimator';
import { safeJoinModelPath } from '../utils/safeFilePath';
import { DECIMAL_GIGABYTE } from '../utils/modelSize';
import { hardwareListenerService, type HardwareStatus } from './HardwareListenerService';
import { getSettings, subscribeSettings } from './SettingsStore';
import { backgroundTaskService } from './BackgroundTaskService';
import { notificationService, type DownloadErrorReason } from './NotificationService';

type ActiveDownloadJob = {
  modelId: string;
  jobToken: number;
  resumable: ReturnType<typeof FileSystem.createDownloadResumable> | null;
  stopReason: 'pause' | 'cancel' | null;
};

export class ModelDownloadManager {
  private static instance: ModelDownloadManager;
  private activeJob: ActiveDownloadJob | null = null;
  private nextJobToken = 0;
  private isProcessing = false;
  private hwUnsubscribe?: () => void;
  private settingsUnsubscribe?: () => void;

  private constructor() {
    // Subscribe to store changes to trigger queue processing
    useDownloadStore.subscribe(
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

  /**
   * Check the queue and start next download if idle.
   */
  private async processQueue() {
    if (this.isProcessing) return;
    
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
        updateModelInQueue(next.id, { lifecycleStatus: LifecycleStatus.QUEUED });
      }

      return;
    }

    const jobToken = ++this.nextJobToken;
    this.activeJob = { modelId: next.id, jobToken, resumable: null, stopReason: null };

    this.isProcessing = true;
    setActiveDownload(next.id);
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

  private async runDownloadJob(model: ModelMetadata, jobToken: number): Promise<void> {
    const { setActiveDownload } = useDownloadStore.getState();

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
      console.error(`[ModelDownloadManager] Failed to download ${model.id}`, e);

      if (this.isCurrentJob(model.id, jobToken)) {
        setActiveDownload(null);
      }
    } finally {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
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
        console.warn('[ModelDownloadManager] Failed to pause download after cellular transition', error);
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

      if (model.size === null && !model.allowUnknownSizeDownload) {
        throw new AppError('download_size_unknown', 'MODEL_SIZE_UNKNOWN', {
          details: { modelId: model.id },
        });
      }

      const freeSpace = await FileSystem.getFreeDiskStorageAsync();
      if (this.getStopReason(model.id, jobToken)) {
        return;
      }
      const REQUIRED_BUFFER_BYTES = DECIMAL_GIGABYTE; // 1 GB
      const requiredModelBytes = model.size ?? 0;
      if (model.size !== null && freeSpace !== undefined && freeSpace < requiredModelBytes + REQUIRED_BUFFER_BYTES) {
        throw new AppError('download_disk_space_low', 'DISK_SPACE_LOW', {
          details: { modelId: model.id, freeSpace, requiredBytes: requiredModelBytes + REQUIRED_BUFFER_BYTES },
        });
      }
    } catch (e: any) {
      console.error(`[ModelDownloadManager] Pre-download check failed for ${model.id}:`, e.message);

      const stopReason = this.getStopReason(model.id, jobToken);
      if (stopReason) {
        return;
      }

      if (this.isCurrentJob(model.id, jobToken)) {
        updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.AVAILABLE });
        removeFromQueue(model.id);
        setActiveDownload(null);
      }
      throw e;
    }

    if (this.getStopReason(model.id, jobToken)) {
      return;
    }

    const modelsDir = getModelsDir();
    if (!modelsDir) {
      throw new AppError('action_failed', 'Local file system is unavailable on this platform.', {
        details: { modelId: model.id },
      });
    }

    const fileName = await this.resolveDownloadFileName(model, modelsDir);
    if (this.getStopReason(model.id, jobToken)) {
      return;
    }

    const localUri = safeJoinModelPath(modelsDir, fileName);
    if (!localUri) {
      throw new AppError('action_failed', `Invalid download file name: ${fileName}`, {
        details: { modelId: model.id },
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
        updateModelInQueue(model.id, { downloadProgress: clampedProgress });
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

    // Extract actual resumeData string from saved state if it exists
    let resumeString: string | undefined = undefined;
    if (model.resumeData) {
      try {
        const pauseState = JSON.parse(model.resumeData);
        resumeString = pauseState.resumeData || model.resumeData;
      } catch {
        resumeString = model.resumeData;
      }
    }

    // Prepare DownloadResumable
    resumable = FileSystem.createDownloadResumable(
      model.downloadUrl,
      localUri,
      await this.buildDownloadOptions(model),
      callback,
      resumeString
    );

    if (this.isCurrentJob(model.id, jobToken) && this.activeJob) {
      this.activeJob.resumable = resumable;
    }

    try {
      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.DOWNLOADING });
      
      const result = await resumable.downloadAsync();

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }
      
      if (!result) {
        console.warn(`[ModelDownloadManager] downloadAsync returned undefined. Marking ${model.id} as paused to avoid a stuck queue.`);

        let resumeSnapshot: unknown | null = null;
        try {
          resumeSnapshot = typeof resumable.savable === 'function' ? resumable.savable() : null;
        } catch (error) {
          console.warn(`[ModelDownloadManager] Failed to snapshot resumable state for ${model.id}`, error);
        }

        const updates: Partial<ModelMetadata> = { lifecycleStatus: LifecycleStatus.PAUSED };
        if (resumeSnapshot) {
          try {
            updates.resumeData = typeof resumeSnapshot === 'string'
              ? resumeSnapshot
              : JSON.stringify(resumeSnapshot);
          } catch (error) {
            console.warn(`[ModelDownloadManager] Failed to serialize resume snapshot for ${model.id}`, error);
          }
        }

        updateModelInQueue(model.id, updates);
        setActiveDownload(null);

        void backgroundTaskService.startBackgroundDownload({ type: 'downloadPaused' }).catch((error) => {
          console.warn('[ModelDownloadManager] Failed to update paused download notification', error);
        });

        return;
      }

      // On some Android environments, status might be missing from result
      if (result.status && result.status >= 400) {
        throw new AppError('download_http_error', `Download failed with HTTP status ${result.status}`, {
          details: { modelId: model.id, status: result.status },
        });
      }

      updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.VERIFYING });

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      const verificationHash = await this.verifyChecksum(model, localUri);

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
      const downloadedSize = (
        downloadedFileInfo.exists &&
        typeof downloadedFileInfo.size === 'number' &&
        Number.isFinite(downloadedFileInfo.size) &&
        downloadedFileInfo.size > 0
      )
        ? Math.round(downloadedFileInfo.size)
        : model.size;
      const metadataTrust = typeof downloadedSize === 'number' && Number.isFinite(downloadedSize) && downloadedSize > 0
        ? 'verified_local' as const
        : model.metadataTrust;
      const memoryFit = await this.resolveMemoryFit(downloadedSize, metadataTrust, model.gguf);

      if (!this.isCurrentJob(model.id, jobToken)) {
        return;
      }

      if (this.getStopReason(model.id, jobToken)) {
        return;
      }

      // Success
      const completedModel: ModelMetadata = {
        ...model,
        size: downloadedSize ?? null,
        fitsInRam: memoryFit.fitsInRam,
        memoryFitDecision: memoryFit.decision,
        memoryFitConfidence: memoryFit.confidence,
        metadataTrust,
        gguf: typeof downloadedSize === 'number' && Number.isFinite(downloadedSize) && downloadedSize > 0
          ? {
            ...(model.gguf ?? {}),
            totalBytes: Math.round(downloadedSize),
          }
          : model.gguf,
        localPath: fileName,
        downloadedAt: Date.now(),
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        allowUnknownSizeDownload: false,
        resumeData: undefined,
        sha256: verificationHash ?? model.sha256,
      };

      registry.updateModel(completedModel);
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

      console.error(`[ModelDownloadManager] Error during download: ${model.id}`, e);

      // If it fails, save resume data if we can and keep the entry in the queue as "available".
      // This avoids infinite retry loops while still allowing the user to retry and resume later.
      const savable = resumable ? resumable.savable() : null;
      updateModelInQueue(model.id, {
        resumeData: savable ? JSON.stringify(savable) : undefined,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
      });
      setActiveDownload(null);

      if (AppState.currentState !== 'active') {
        const appError = toAppError(e);
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
      }
    }
    }

  public async verifyChecksum(
    model: Pick<ModelMetadata, 'id' | 'size' | 'sha256'>,
    localUri: string,
  ): Promise<string | undefined> {
    try {
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (!fileInfo.exists) {
        throw new AppError('download_file_missing', 'File does not exist after download', {
          details: { modelId: model.id, localUri },
        });
      }

      const downloadedSize = fileInfo.size ?? 0;
      const expectedSize = model.size;

      if (typeof expectedSize === 'number' && expectedSize > 0 && Math.abs(downloadedSize - expectedSize) > 1024 * 1024) {
        await this.deleteCorruptedDownload(localUri, model.id);
        throw new AppError(
          'download_verification_failed',
          `Size mismatch: Expected ${expectedSize} but got ${downloadedSize}`,
          {
            details: { modelId: model.id, expectedSize, downloadedSize, localUri },
          },
        );
      }

      const expectedHash = this.normalizeSha256Digest(model.sha256);
      if (!expectedHash) {
        return undefined;
      }

      const actualHash = this.normalizeSha256Digest(
        await RNFS.hash(this.toNativeFilePath(localUri), 'sha256'),
      );
      if (!actualHash || actualHash !== expectedHash) {
        await this.deleteCorruptedDownload(localUri, model.id);
        throw new AppError(
          'download_verification_failed',
          `Checksum mismatch for ${model.id}`,
          {
            details: { modelId: model.id, expectedHash, actualHash, localUri },
          },
        );
      }

      return actualHash;
    } catch (error) {
      throw toAppError(error, 'download_verification_failed');
    }
  }

  private async buildDownloadOptions(model: ModelMetadata): Promise<{ headers?: Record<string, string> }> {
    const requiresAuth = model.accessState !== ModelAccessState.PUBLIC || model.isGated || model.isPrivate;
    const isHuggingFaceDownload = isHuggingFaceUrl(model.downloadUrl);

    if (!requiresAuth || !isHuggingFaceDownload) {
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

    const job = this.activeJob;
    if (!job || job.modelId !== modelId) {
      // Best-effort: allow pausing a queued download before it becomes active.
      updateModelInQueue(modelId, { lifecycleStatus: LifecycleStatus.PAUSED });
      return;
    }

    const jobToken = job.jobToken;
    let resumeSnapshot: unknown | null = null;

    try {
      job.stopReason = 'pause';
      if (job.resumable) {
        try {
          resumeSnapshot = await job.resumable.pauseAsync();
        } catch (error) {
          console.warn(`[ModelDownloadManager] pauseAsync failed for ${modelId}`, error);

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
        if (resumeSnapshot) {
          updates.resumeData = JSON.stringify(resumeSnapshot);
        }

        updateModelInQueue(modelId, updates);
        setActiveDownload(null);
      }
    }
  }

  public async cancelDownload(modelId: string) {
    const { queue, removeFromQueue, activeDownloadId, setActiveDownload } = useDownloadStore.getState();
    const queuedModel = queue.find((model) => model.id === modelId);

    const job = this.activeJob?.modelId === modelId
      ? this.activeJob
      : null;
    if (job) {
      job.stopReason = 'cancel';
    }

    if (activeDownloadId === modelId) {
      if (job?.resumable) {
        try {
          await job.resumable.pauseAsync(); // Stop active one
        } catch (error) {
          console.warn(`[ModelDownloadManager] Failed to pause active download during cancel for ${modelId}`, error);
        }
      }

      setActiveDownload(null);
    }
    
    // Remove from queue first to stop UI
    removeFromQueue(modelId);

    void this.processQueue();

    // Delete the partial file to free up disk space
    try {
      await this.deleteDownloadFiles(
        queuedModel
          ? this.getDownloadFileNameCandidates(queuedModel)
          : getCandidateModelDownloadFileNames({
            id: modelId,
            resolvedFileName: undefined,
            hfRevision: undefined,
          }),
        modelId,
      );
    } catch (e) {
      console.error(`[ModelDownloadManager] Failed to delete partial file for ${modelId}`, e);
    }
  }

  private getDownloadFileNameCandidates(
    model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision' | 'localPath'>,
  ): string[] {
    const candidates = getCandidateModelDownloadFileNames(model);
    return model.localPath
      ? Array.from(new Set([model.localPath, ...candidates]))
      : candidates;
  }

  private async resolveDownloadFileName(
    model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision' | 'localPath'>,
    modelsDir: string,
  ): Promise<string> {
    const candidates = this.getDownloadFileNameCandidates(model);

    for (const candidate of candidates) {
      const candidatePath = safeJoinModelPath(modelsDir, candidate);
      if (!candidatePath) {
        continue;
      }
      const info = await FileSystem.getInfoAsync(candidatePath);
      if (info.exists) {
        return candidate;
      }
    }

    return candidates[0];
  }

  private async deleteDownloadFiles(fileNames: string[], modelId: string): Promise<void> {
    const modelsDir = getModelsDir();
    if (!modelsDir) {
      return;
    }

    let deletedAnyFile = false;

    for (const fileName of Array.from(new Set(fileNames))) {
      const localUri = safeJoinModelPath(modelsDir, fileName);
      if (!localUri) {
        continue;
      }
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (!fileInfo.exists) {
        continue;
      }

      await FileSystem.deleteAsync(localUri, { idempotent: true });
      deletedAnyFile = true;
    }

    if (deletedAnyFile) {
      console.log(`[ModelDownloadManager] Deleted partial download for ${modelId}`);
    }
  }

  private normalizeSha256Digest(value: string | undefined): string | undefined {
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

  private toNativeFilePath(fileUri: string): string {
    if (!fileUri.startsWith('file://')) {
      return fileUri;
    }

    return decodeURI(fileUri.replace(/^file:\/+/, '/'));
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
      await FileSystem.deleteAsync(localUri, { idempotent: true });
    } catch (error) {
      console.warn(`[ModelDownloadManager] Failed to delete corrupted download for ${modelId}`, error);
    }
  }
}

export function getModelDownloadManager(): ModelDownloadManager {
  return ModelDownloadManager.getInstance();
}
