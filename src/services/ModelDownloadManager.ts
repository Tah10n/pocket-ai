import RNFS, { DownloadResult, DownloadProgressCallbackResult } from 'react-native-fs';
import { hardwareListenerService } from './HardwareListenerService';
import { localStorageRegistry } from './LocalStorageRegistry';
import { ModelMetadata } from './ModelCatalogService';

export interface DownloadProgress {
    modelId: string;
    percent: number;
    bytesWritten: number;
    totalBytes: number;
    status: 'pending' | 'downloading' | 'paused' | 'done' | 'failed' | 'verifying';
    error?: string;
}

type ProgressListener = (progress: DownloadProgress[]) => void;

interface ActiveDownload {
    jobId: number;
    promise: Promise<DownloadResult>;
}

class ModelDownloadManager {
    private activeDownloads: Map<string, ActiveDownload> = new Map();
    private progresses: Map<string, DownloadProgress> = new Map();
    private listeners: Set<ProgressListener> = new Set();

    /**
     * Check if there is enough free space on the disk.
     * Reserves 1GB as a safety buffer.
     */
    async checkAvailableSpace(requiredBytes: number): Promise<boolean> {
        try {
            const info = await RNFS.getFSInfo();
            const buffer = 1024 * 1024 * 1024; // 1GB buffer
            return info.freeSpace > (requiredBytes + buffer);
        } catch (e) {
            console.error('[ModelDownloadManager] Failed to get FS info', e);
            return true; // Fallback to true if we can't check
        }
    }

    /**
     * Start downloading a model file using RNFS.downloadFile.
     * Throws 'CELLULAR_DATA_WARNING' if on cellular network.
     * Throws 'DISK_SPACE_LOW' if not enough space.
     */
    async startDownload(model: ModelMetadata): Promise<void> {
        const status = hardwareListenerService.getCurrentStatus();
        if (status.networkType === 'cellular') {
            throw new Error('CELLULAR_DATA_WARNING');
        }

        const hasSpace = await this.checkAvailableSpace(model.sizeBytes);
        if (!hasSpace) {
            this.updateProgress(model.id, { status: 'failed', error: 'DISK_SPACE_LOW' });
            throw new Error('DISK_SPACE_LOW');
        }

        const destPath = `${RNFS.DocumentDirectoryPath}/${model.id.replace(/\//g, '_')}.bin`;

        this.progresses.set(model.id, {
            modelId: model.id,
            percent: 0,
            bytesWritten: 0,
            totalBytes: model.sizeBytes,
            status: 'pending',
        });
        this.notifyListeners();

        const { jobId, promise } = RNFS.downloadFile({
            fromUrl: model.downloadUrl,
            toFile: destPath,
            progressDivider: 5, // Report progress every 5%
            begin: (res) => {
                this.updateProgress(model.id, {
                    status: 'downloading',
                    totalBytes: res.contentLength,
                });
            },
            progress: (res: DownloadProgressCallbackResult) => {
                const percent = res.contentLength > 0 ? res.bytesWritten / res.contentLength : 0;
                this.updateProgress(model.id, {
                    status: 'downloading',
                    percent,
                    bytesWritten: res.bytesWritten,
                    totalBytes: res.contentLength,
                });
            },
        });

        this.activeDownloads.set(model.id, { jobId, promise });

        try {
            const result = await promise;
            if (result.statusCode === 200) {
                this.updateProgress(model.id, { status: 'verifying' });
                const isValid = await this.verifyChecksum(model.id, destPath, model.sha256);
                if (isValid) {
                    localStorageRegistry.addModel(model);
                    this.updateProgress(model.id, { status: 'done', percent: 1 });
                } else {
                    this.updateProgress(model.id, { status: 'failed', error: 'CHECKSUM_MISMATCH' });
                    await RNFS.unlink(destPath).catch(() => { });
                }
            } else {
                console.error(`[ModelDownloadManager] Download failed (${result.statusCode}) for ${model.downloadUrl}`);
                this.updateProgress(model.id, { status: 'failed', error: `HTTP_${result.statusCode}` });
            }
        } catch (error) {
            console.error(`[ModelDownloadManager] Download error:`, error);
            this.updateProgress(model.id, { status: 'failed', error: 'DOWNLOAD_ERROR' });
        } finally {
            this.activeDownloads.delete(model.id);
        }
    }

    /**
     * Cancel an active download.
     */
    cancelDownload(modelId: string) {
        const download = this.activeDownloads.get(modelId);
        if (download) {
            RNFS.stopDownload(download.jobId);
            this.activeDownloads.delete(modelId);
            this.progresses.delete(modelId);
            this.notifyListeners();
        }
    }

    /**
     * Validate the downloaded file integrity.
     */
    async verifyChecksum(modelId: string, filePath: string, expectedSha256?: string): Promise<boolean> {
        if (!expectedSha256) {
            console.warn(`[ModelDownloadManager] No expected SHA256 provided for ${modelId}, skipping verification.`);
            return true;
        }

        try {
            const hash = await RNFS.hash(filePath, 'sha256');
            const isValid = hash.toLowerCase() === expectedSha256.toLowerCase();
            if (!isValid) {
                console.error(`[ModelDownloadManager] Checksum mismatch for ${modelId}. Expected: ${expectedSha256}, Got: ${hash}`);
            }
            return isValid;
        } catch (e) {
            console.error(`[ModelDownloadManager] Failed to compute hash for ${modelId}`, e);
            return false;
        }
    }

    subscribe(listener: ProgressListener) {
        this.listeners.add(listener);
        listener(Array.from(this.progresses.values()));
        return () => {
            this.listeners.delete(listener);
        };
    }

    private updateProgress(modelId: string, partial: Partial<DownloadProgress>) {
        const existing = this.progresses.get(modelId) || {
            modelId,
            percent: 0,
            bytesWritten: 0,
            totalBytes: 0,
            status: 'pending' as const,
        };
        this.progresses.set(modelId, { ...existing, ...partial });
        this.notifyListeners();
    }

    private notifyListeners() {
        const arr = Array.from(this.progresses.values());
        this.listeners.forEach((l) => l(arr));
    }
}

export const modelDownloadManager = new ModelDownloadManager();
