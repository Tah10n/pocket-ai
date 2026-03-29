import * as FileSystem from 'expo-file-system/legacy';
import { useDownloadStore } from '../store/downloadStore';
import { ModelAccessState, ModelMetadata, LifecycleStatus } from '../types/models';
import { registry } from './LocalStorageRegistry';
import { MODELS_DIR } from './FileSystemSetup';
import { AppError, toAppError } from './AppError';
import { huggingFaceTokenService } from './HuggingFaceTokenService';

const HF_BASE_URL = 'https://huggingface.co';

export class ModelDownloadManager {
  private static instance: ModelDownloadManager;
  private resumable: any = null;
  private isProcessing = false;

  private constructor() {
    // Subscribe to store changes to trigger queue processing
    useDownloadStore.subscribe(
      () => this.processQueue()
    );
    // Initial check
    this.processQueue();
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
      if (model.size === null && !model.allowUnknownSizeDownload) {
        throw new AppError('download_size_unknown', 'MODEL_SIZE_UNKNOWN', {
          details: { modelId: model.id },
        });
      }

      const freeSpace = await FileSystem.getFreeDiskStorageAsync();
      const REQUIRED_BUFFER = 1024 * 1024 * 1024; // 1 GB
      const requiredModelBytes = model.size ?? 0;
      if (model.size !== null && freeSpace !== undefined && freeSpace < requiredModelBytes + REQUIRED_BUFFER) {
        throw new AppError('download_disk_space_low', 'DISK_SPACE_LOW', {
          details: { modelId: model.id, freeSpace, requiredBytes: requiredModelBytes + REQUIRED_BUFFER },
        });
      }
    } catch (e: any) {
      console.error(`[ModelDownloadManager] Pre-download check failed for ${model.id}:`, e.message);
      updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.AVAILABLE });
      removeFromQueue(model.id);
      setActiveDownload(null);
      throw e;
    }

    const fileName = model.id.replace(/\//g, '_') + '.gguf';
    const localUri = MODELS_DIR + fileName;

    const callback = (downloadProgress: any) => {
      const progress = downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite;
      updateModelInQueue(model.id, { 
        downloadProgress: progress,
        lifecycleStatus: LifecycleStatus.DOWNLOADING 
      });
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

      // Success
      const completedModel: ModelMetadata = {
        ...model,
        localPath: fileName,
        downloadedAt: Date.now(),
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        sha256: verificationHash ?? model.sha256,
      };

      registry.updateModel(completedModel);
      removeFromQueue(model.id);
      console.log(`[ModelDownloadManager] Downloaded and verified: ${model.id}`);

    } catch (e: any) {
      console.error(`[ModelDownloadManager] Error during download: ${model.id}`, e);

      // If it fails, save resume data if we can, but remove from queue to prevent infinite retry loops.
      const savable = this.resumable ? this.resumable.savable() : null;
      updateModelInQueue(model.id, { 
        resumeData: savable ? JSON.stringify(savable) : undefined,
        lifecycleStatus: LifecycleStatus.AVAILABLE 
      });
      removeFromQueue(model.id);
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
        throw new AppError(
          'download_verification_failed',
          `Size mismatch: Expected ${expectedSize} but got ${downloadedSize}`,
          {
            details: { modelId: model.id, expectedSize, downloadedSize, localUri },
          },
        );
      }

      // The current runtime only validates file presence and, when known, expected size.
      // Keep any real digest metadata, but do not fabricate a checksum marker.
      return model.sha256?.trim() || undefined;
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
    const { removeFromQueue, activeDownloadId, setActiveDownload } = useDownloadStore.getState();
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
      const fileName = modelId.replace(/\//g, '_') + '.gguf';
      const localUri = MODELS_DIR + fileName;
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (fileInfo.exists) {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
        console.log(`[ModelDownloadManager] Deleted partial download for ${modelId}`);
      }
    } catch (e) {
      console.error(`[ModelDownloadManager] Failed to delete partial file for ${modelId}`, e);
    }
  }
}

export const modelDownloadManager = ModelDownloadManager.getInstance();
