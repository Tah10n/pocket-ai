import DeviceInfo from 'react-native-device-info';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { useDownloadStore } from '../store/downloadStore';
import { ModelAccessState, ModelMetadata, LifecycleStatus } from '../types/models';
import { registry } from './LocalStorageRegistry';
import { getModelsDir } from './FileSystemSetup';
import { AppError, toAppError } from './AppError';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import { getSystemMemorySnapshot } from './SystemMetricsService';
import { HF_BASE_URL } from '../utils/huggingFaceUrls';
import { getCandidateModelDownloadFileNames } from '../utils/modelFiles';
import { assessModelMemoryFit, DEFAULT_TOTAL_MEMORY_BYTES } from '../utils/memoryFit';
import { DECIMAL_GIGABYTE } from '../utils/modelSize';

export class ModelDownloadManager {
  private static instance: ModelDownloadManager;
  private resumable: any = null;
  private isProcessing = false;

  private constructor() {
    // Subscribe to store changes to trigger queue processing
    useDownloadStore.subscribe(
      (state) => `${state.activeDownloadId ?? ''}|${state.queue.map((model) => `${model.id}:${model.lifecycleStatus}`).join(',')}`,
      () => { void this.processQueue(); },
    );
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
    
    const { queue, activeDownloadId, setActiveDownload } = useDownloadStore.getState();
    
    // If already downloading something, stay idle
    if (activeDownloadId) return;

    // Find next queued model
    const next = queue.find((m) => (
      m.lifecycleStatus === LifecycleStatus.QUEUED ||
      m.lifecycleStatus === LifecycleStatus.DOWNLOADING ||
      m.lifecycleStatus === LifecycleStatus.VERIFYING
    ));
    if (next) {
      this.isProcessing = true;
      setActiveDownload(next.id);
      try {
        await this.downloadModel(next);
      } catch (e) {
        console.error(`[ModelDownloadManager] Failed to download ${next.id}`, e);
        setActiveDownload(null);
      } finally {
        this.isProcessing = false;
        // Trigger next check
        this.processQueue();
      }
    }
  }

  private async downloadModel(model: ModelMetadata) {
    const { updateModelInQueue, removeFromQueue, setActiveDownload } = useDownloadStore.getState();

    try {
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
      const REQUIRED_BUFFER_BYTES = DECIMAL_GIGABYTE; // 1 GB
      const requiredModelBytes = model.size ?? 0;
      if (model.size !== null && freeSpace !== undefined && freeSpace < requiredModelBytes + REQUIRED_BUFFER_BYTES) {
        throw new AppError('download_disk_space_low', 'DISK_SPACE_LOW', {
          details: { modelId: model.id, freeSpace, requiredBytes: requiredModelBytes + REQUIRED_BUFFER_BYTES },
        });
      }
    } catch (e: any) {
      console.error(`[ModelDownloadManager] Pre-download check failed for ${model.id}:`, e.message);
      updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.AVAILABLE });
      removeFromQueue(model.id);
      setActiveDownload(null);
      throw e;
    }

    const modelsDir = getModelsDir();
    if (!modelsDir) {
      throw new AppError('action_failed', 'Local file system is unavailable on this platform.', {
        details: { modelId: model.id },
      });
    }

    const fileName = await this.resolveDownloadFileName(model, modelsDir);
    const localUri = modelsDir + fileName;

    const PROGRESS_UPDATE_MIN_INTERVAL_MS = 500;
    const PROGRESS_UPDATE_MIN_DELTA = 0.005;
    let lastProgressUpdatedAt = 0;
    let lastProgress = -1;

    const callback = (downloadProgress: any) => {
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

      if (
        clampedProgress === 1 ||
        now - lastProgressUpdatedAt >= PROGRESS_UPDATE_MIN_INTERVAL_MS ||
        delta >= PROGRESS_UPDATE_MIN_DELTA
      ) {
        lastProgressUpdatedAt = now;
        lastProgress = clampedProgress;
        updateModelInQueue(model.id, { downloadProgress: clampedProgress });
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
    this.resumable = FileSystem.createDownloadResumable(
      model.downloadUrl,
      localUri,
      await this.buildDownloadOptions(model),
      callback,
      resumeString
    );

    try {
      updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.DOWNLOADING });
      
      const result = await this.resumable.downloadAsync();
      
      if (!result) {
        console.warn(`[ModelDownloadManager] downloadAsync returned undefined. Task cancelled or paused.`);
        return;
      }

      // On some Android environments, status might be missing from result
      if (result.status && result.status >= 400) {
        throw new AppError('download_http_error', `Download failed with HTTP status ${result.status}`, {
          details: { modelId: model.id, status: result.status },
        });
      }

      updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.VERIFYING });
      const verificationHash = await this.verifyChecksum(model, localUri);
      const downloadedFileInfo = await FileSystem.getInfoAsync(localUri);
      const downloadedSize = (
        downloadedFileInfo.exists &&
        typeof downloadedFileInfo.size === 'number' &&
        Number.isFinite(downloadedFileInfo.size) &&
        downloadedFileInfo.size > 0
      )
        ? Math.round(downloadedFileInfo.size)
        : model.size;
      const fitsInRam = await this.resolveFitsInRam(downloadedSize);

      // Success
      const completedModel: ModelMetadata = {
        ...model,
        size: downloadedSize ?? null,
        fitsInRam,
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
      console.log(`[ModelDownloadManager] Downloaded and verified: ${model.id}`);

    } catch (e: any) {
      console.error(`[ModelDownloadManager] Error during download: ${model.id}`, e);

      // If it fails, save resume data if we can and keep the entry in the queue as "available".
      // This avoids infinite retry loops while still allowing the user to retry and resume later.
      const savable = this.resumable ? this.resumable.savable() : null;
      updateModelInQueue(model.id, {
        resumeData: savable ? JSON.stringify(savable) : undefined,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
      });
      setActiveDownload(null);

      throw e;
    } finally {
      this.resumable = null;
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
    const isHuggingFaceDownload = model.downloadUrl.startsWith(HF_BASE_URL);

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
    if (this.resumable && useDownloadStore.getState().activeDownloadId === modelId) {
      const pauseResult = await this.resumable.pauseAsync();
      useDownloadStore.getState().updateModelInQueue(modelId, { 
        resumeData: JSON.stringify(pauseResult),
        // No PAUSED status in enum, use QUEUED so it can be resumed
        lifecycleStatus: LifecycleStatus.QUEUED 
      });
      useDownloadStore.getState().setActiveDownload(null);
      // Reset processing flag so the queue can accept new downloads
      this.isProcessing = false;
    }
  }

  public async cancelDownload(modelId: string) {
    const { queue, removeFromQueue, activeDownloadId, setActiveDownload } = useDownloadStore.getState();
    const queuedModel = queue.find((model) => model.id === modelId);
    if (activeDownloadId === modelId) {
      if (this.resumable) {
        await this.resumable.pauseAsync(); // Stop active one
      }
      setActiveDownload(null);
    }
    
    // Remove from queue first to stop UI
    removeFromQueue(modelId);

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
      const info = await FileSystem.getInfoAsync(modelsDir + candidate);
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
      const localUri = modelsDir + fileName;
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

  private async resolveFitsInRam(size: number | null): Promise<boolean | null> {
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      return null;
    }

    const systemMemorySnapshot = await getSystemMemorySnapshot().catch(() => null);
    const totalMemoryBytes = systemMemorySnapshot?.totalBytes
      ?? await DeviceInfo.getTotalMemory().catch(() => DEFAULT_TOTAL_MEMORY_BYTES);
    const assessment = assessModelMemoryFit({
      modelSizeBytes: size,
      totalMemoryBytes,
      systemMemorySnapshot: null,
    });

    return assessment?.fitsInRam ?? null;
  }

  private async deleteCorruptedDownload(localUri: string, modelId: string): Promise<void> {
    try {
      await FileSystem.deleteAsync(localUri, { idempotent: true });
    } catch (error) {
      console.warn(`[ModelDownloadManager] Failed to delete corrupted download for ${modelId}`, error);
    }
  }
}

export const modelDownloadManager = ModelDownloadManager.getInstance();
