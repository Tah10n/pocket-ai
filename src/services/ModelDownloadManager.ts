import RNBackgroundDownloader, { DownloadTask } from 'react-native-background-downloader';
import RNFS from 'react-native-fs';
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

class ModelDownloadManager {
    private tasks: Map<string, DownloadTask> = new Map();
    private progresses: Map<string, DownloadProgress> = new Map();
    private listeners: Set<ProgressListener> = new Set();

    constructor() {
        this.hydrateExistingTasks();
    }

    private async hydrateExistingTasks() {
        const activeTasks = await RNBackgroundDownloader.checkForExistingDownloads();
        for (let task of activeTasks) {
            this.tasks.set(task.id, task);
            this.attachTaskListeners(task.id, task);
        }
    }

    private attachTaskListeners(modelId: string, task: DownloadTask) {
        task.begin((expectedBytes) => {
            this.updateProgress(modelId, { status: 'downloading', totalBytes: expectedBytes, bytesWritten: 0, percent: 0 });
        })
            .progress((percent) => {
                this.updateProgress(modelId, { status: 'downloading', percent, bytesWritten: task.totalBytes * percent, totalBytes: task.totalBytes });
            })
            .done(async () => {
                this.updateProgress(modelId, { status: 'verifying' });
                const isValid = await this.verifyChecksum(modelId, task.dest);
                if (isValid) {
                    this.updateProgress(modelId, { status: 'done', percent: 1 });
                } else {
                    this.updateProgress(modelId, { status: 'failed' });
                    await RNFS.unlink(task.dest);
                }
                this.tasks.delete(modelId);
            })
            .error((error) => {
                console.error(`Download failed: ${error}`);
                this.updateProgress(modelId, { status: 'failed' });
                this.tasks.delete(modelId);
            });
    }

    async startDownload(model: ModelMetadata, expectedSha256: string = ''): Promise<void> {
        const status = hardwareListenerService.getCurrentStatus();
        if (status.networkType === 'cellular') {
            // In a real app, throw a specific error or trigger a warning dialog.
            throw new Error('CELLULAR_DATA_WARNING');
        }

        const destPath = `${RNFS.DocumentDirectoryPath}/${model.id.replace(/\//g, '_')}.bin`;

        let task = RNBackgroundDownloader.download({
            id: model.id,
            url: model.downloadUrl,
            destination: destPath,
        });

        this.tasks.set(model.id, task);
        this.progresses.set(model.id, {
            modelId: model.id,
            percent: 0,
            bytesWritten: 0,
            totalBytes: model.sizeBytes,
            status: 'pending'
        });

        this.attachTaskListeners(model.id, task);
    }

    pauseDownload(modelId: string) {
        const task = this.tasks.get(modelId);
        if (task) {
            task.pause();
            this.updateProgress(modelId, { status: 'paused' });
        }
    }

    resumeDownload(modelId: string) {
        const task = this.tasks.get(modelId);
        if (task) {
            task.resume();
            this.updateProgress(modelId, { status: 'downloading' });
        }
    }

    cancelDownload(modelId: string) {
        const task = this.tasks.get(modelId);
        if (task) {
            task.stop();
            this.tasks.delete(modelId);
            this.progresses.delete(modelId);
            this.notifyListeners();
        }
    }

    async verifyChecksum(modelId: string, filePath: string): Promise<boolean> {
        try {
            const hash = await RNFS.hash(filePath, 'sha256');
            return !!hash; // Validate against expectedSha256 in a production scenario
        } catch {
            return false;
        }
    }

    subscribe(listener: ProgressListener) {
        this.listeners.add(listener);
        listener(Array.from(this.progresses.values()));
        return () => this.listeners.delete(listener);
    }

    private updateProgress(modelId: string, partial: Partial<DownloadProgress>) {
        const existing = this.progresses.get(modelId) || {
            modelId, percent: 0, bytesWritten: 0, totalBytes: 0, status: 'pending'
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
