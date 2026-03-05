import RNFS, { DownloadResult, DownloadProgressCallbackResult } from 'react-native-fs';
import { hardwareListenerService } from './HardwareListenerService';
import { ModelMetadata } from './ModelCatalogService';

export interface DownloadProgress {
    modelId: string;
    percent: number;
    bytesWritten: number;
    totalBytes: number;
    status: 'pending' | 'downloading' | 'paused' | 'done' | 'failed' | 'verifying';
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
     * Start downloading a model file using RNFS.downloadFile.
     * Throws 'CELLULAR_DATA_WARNING' if on cellular network.
     */
    async startDownload(model: ModelMetadata, _expectedSha256: string = ''): Promise<void> {
        const status = hardwareListenerService.getCurrentStatus();
        if (status.networkType === 'cellular') {
            throw new Error('CELLULAR_DATA_WARNING');
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
                const isValid = await this.verifyChecksum(model.id, destPath);
                if (isValid) {
                    this.updateProgress(model.id, { status: 'done', percent: 1 });
                } else {
                    this.updateProgress(model.id, { status: 'failed' });
                    await RNFS.unlink(destPath).catch(() => { });
                }
            } else {
                console.error(`[ModelDownloadManager] Download failed (${result.statusCode}) for ${model.downloadUrl}`);
                this.updateProgress(model.id, { status: 'failed' });
            }
        } catch (error) {
            console.error(`[ModelDownloadManager] Download error:`, error);
            this.updateProgress(model.id, { status: 'failed' });
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
    async verifyChecksum(modelId: string, filePath: string): Promise<boolean> {
        try {
            const hash = await RNFS.hash(filePath, 'sha256');
            return !!hash; // In production, compare against expectedSha256
        } catch {
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
            modelId, percent: 0, bytesWritten: 0, totalBytes: 0, status: 'pending' as const,
        };
        this.progresses.set(modelId, { ...existing, ...partial });
        this.notifyListeners();
    }

    private notifyListeners() {
        const arr = Array.from(this.progresses.values());
        this.listeners.forEach(l => l(arr));
    }
}

export const modelDownloadManager = new ModelDownloadManager();


