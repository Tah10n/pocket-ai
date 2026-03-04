import { MMKV } from 'react-native-mmkv';
import { ModelMetadata } from './ModelCatalogService';
import RNFS from 'react-native-fs';

export const storage = new MMKV();

class LocalStorageRegistry {
    private static readonly MODELS_KEY = 'downloaded_models_registry';

    getDownloadedModels(): ModelMetadata[] {
        const json = storage.getString(LocalStorageRegistry.MODELS_KEY);
        return json ? JSON.parse(json) : [];
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
        }
    }

    isModelDownloaded(modelId: string): boolean {
        return this.getDownloadedModels().some(m => m.id === modelId);
    }
}

export const localStorageRegistry = new LocalStorageRegistry();
