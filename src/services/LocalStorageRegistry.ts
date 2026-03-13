import { createStorage } from './storage';
import { ModelMetadata } from './ModelCatalogService';
import RNFS from 'react-native-fs';

export const storage = createStorage();

class LocalStorageRegistry {
    private static readonly MODELS_KEY = 'downloaded_models_registry';
    private static readonly ACTIVE_MODEL_KEY = 'active_model_id';
    private listeners: Set<() => void> = new Set();

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notify() {
        this.listeners.forEach((l) => l());
    }

    getDownloadedModels(): ModelMetadata[] {
        const json = storage.getString(LocalStorageRegistry.MODELS_KEY);
        if (!json) return [];
        try {
            const parsed = JSON.parse(json);
            return Array.isArray(parsed) ? (parsed as ModelMetadata[]) : [];
        } catch (e) {
            console.warn('[LocalStorageRegistry] Corrupted models registry, resetting.', e);
            storage.remove(LocalStorageRegistry.MODELS_KEY);
            return [];
        }
    }

    addModel(model: ModelMetadata) {
        const models = this.getDownloadedModels();
        const existingIndex = models.findIndex(m => m.id === model.id);
        if (existingIndex >= 0) {
            models[existingIndex] = model;
        } else {
            models.push(model);
        }
        storage.set(LocalStorageRegistry.MODELS_KEY, JSON.stringify(models));
        this.notify();
    }

    async removeModel(modelId: string) {
        const models = this.getDownloadedModels();
        const model = models.find(m => m.id === modelId);
        if (model) {
            // Delete the file
            const destPath = `${RNFS.DocumentDirectoryPath}/${model.id.replace(/\//g, '_')}.bin`;
            try {
                await RNFS.unlink(destPath);
            } catch (e) {
                console.warn(`Failed to delete model file: ${destPath}`, e);
            }

            const newModels = models.filter(m => m.id !== modelId);
            storage.set(LocalStorageRegistry.MODELS_KEY, JSON.stringify(newModels));

            if (this.getActiveModelId() === modelId) {
                this.setActiveModelId(null);
                return;
            }

            this.notify();
        }
    }

    isModelDownloaded(modelId: string): boolean {
        return this.getDownloadedModels().some(m => m.id === modelId);
    }

    getActiveModelId(): string | null {
        const value = storage.getString(LocalStorageRegistry.ACTIVE_MODEL_KEY);
        return typeof value === 'string' && value.length > 0 ? value : null;
    }

    setActiveModelId(modelId: string | null) {
        if (!modelId) {
            storage.remove(LocalStorageRegistry.ACTIVE_MODEL_KEY);
        } else {
            storage.set(LocalStorageRegistry.ACTIVE_MODEL_KEY, modelId);
        }
        this.notify();
    }
}

export const localStorageRegistry = new LocalStorageRegistry();
