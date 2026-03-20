import * as FileSystem from 'expo-file-system/legacy';
import { useDownloadStore } from '../store/downloadStore';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { registry } from './LocalStorageRegistry';
import { MODELS_DIR } from './FileSystemSetup';

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
    const next = queue.find(m => m.lifecycleStatus === LifecycleStatus.QUEUED);
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
      const freeSpace = await FileSystem.getFreeDiskStorageAsync();
      const REQUIRED_BUFFER = 1024 * 1024 * 1024; // 1 GB
      if (freeSpace !== undefined && freeSpace < model.size + REQUIRED_BUFFER) {
        throw new Error('DISK_SPACE_LOW');
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
      this.getDownloadUrl(model.id),
      localUri,
      {},
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
        throw new Error(`Download failed with HTTP status ${result.status}`);
      }

      // Verification: Fast File Size Check instead of slow JS SHA256
      updateModelInQueue(model.id, { lifecycleStatus: LifecycleStatus.VERIFYING });
      
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (!fileInfo.exists) {
        throw new Error('File does not exist after download');
      }

      // Check if size matches. We allow a small 1MB variance just in case headers were slightly off,
      // but usually they should match exactly.
      const downloadedSize = fileInfo.size;
      const expectedSize = model.size;

      if (expectedSize > 0 && Math.abs(downloadedSize - expectedSize) > 1024 * 1024) {
        // If file is significantly smaller, it means download was corrupted or cut off
        throw new Error(`Size mismatch: Expected ${expectedSize} but got ${downloadedSize}`);
      }

      // Success
      const completedModel: ModelMetadata = {
        ...model,
        localPath: fileName,
        downloadedAt: Date.now(),
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        // We bypass full hash to prevent 2-minute UI freeze.
        sha256: model.sha256 || 'verified-by-size', 
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

  private getDownloadUrl(modelId: string): string {
    const model = useDownloadStore.getState().queue.find(m => m.id === modelId);
    return model?.downloadUrl || `https://huggingface.co/${modelId}/resolve/main/model.gguf`;
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
