import DeviceInfo from 'react-native-device-info';

export interface ModelMetadata {
    id: string;
    name: string;
    parameters: string;
    contextWindow: number;
    sizeBytes: number;
    downloadUrl: string;
}

export class ModelCatalogService {
    async getDeviceCapabilities() {
        const totalMemory = await DeviceInfo.getTotalMemory();
        const freeStorage = await DeviceInfo.getFreeDiskStorage();
        return { totalMemory, freeStorage };
    }

    async fetchHuggingFaceModels(query: string = 'mlc-llm'): Promise<ModelMetadata[]> {
        const response = await fetch(`https://huggingface.co/api/models?search=${query}&limit=10`);
        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.statusText}`);
        }
        const data = await response.json();

        // In a real app, you would parse the model card or HF tags to get exact parameters,
        // context window, and exact GGUF/bin size.
        return data.map((model: any) => ({
            id: model._id || model.id,
            name: model.id,
            parameters: '3B', // Placeholder
            contextWindow: 4096,
            sizeBytes: 1.5 * 1024 * 1024 * 1024, // Placeholder 1.5GB
            downloadUrl: `https://huggingface.co/${model.id}/resolve/main/params/mlc-chat-config.json`, // Example URL
        }));
    }

    async getAvailableModels(): Promise<ModelMetadata[]> {
        const caps = await this.getDeviceCapabilities();
        const allModels = await this.fetchHuggingFaceModels();

        // Filter models based on hardware constraints
        // Strategy: retain models that fit in RAM with 800MB reserved for OS/App,
        // and fit in free storage with 1GB buffer.
        const maxAllowedRam = caps.totalMemory - (800 * 1024 * 1024);
        const maxAllowedStorage = caps.freeStorage - (1024 * 1024 * 1024);

        return allModels.filter(model => {
            const ramRequired = model.sizeBytes * 1.2; // Assume 20% overhead for memory
            return ramRequired <= maxAllowedRam && model.sizeBytes <= maxAllowedStorage;
        });
    }
}

export const modelCatalogService = new ModelCatalogService();
