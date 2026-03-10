import { initLlama, releaseAllLlama, LlamaContext, TokenData, NativeCompletionResult } from 'llama.rn';
import RNFS from 'react-native-fs';
import DeviceInfo from 'react-native-device-info';
import { hardwareListenerService } from './HardwareListenerService';
import { ModelMetadata } from './ModelCatalogService';

export type EngineState = 'uninitialized' | 'warming_up' | 'ready' | 'error';

type StateListener = (state: EngineState) => void;

class LLMEngineService {
    private context: LlamaContext | null = null;
    private currentModelId: string | null = null;
    private state: EngineState = 'uninitialized';
    private listeners: Set<StateListener> = new Set();
    private hwUnsubscribe?: () => void;
    private initPromise: Promise<void> | null = null;

    constructor() {
        this.hwUnsubscribe = hardwareListenerService.subscribe((status) => {
            if (status.isLowMemory && this.context) {
                console.warn('[LLMEngine] Low memory warning — unloading model');
                this.unload();
            }
        });
    }

    /**
     * Determine the number of GPU layers based on device RAM.
     * These numbers are heuristic for typical 3B-7B models.
     */
    private async calculateGpuLayers(): Promise<number> {
        try {
            const totalMemory = await DeviceInfo.getTotalMemory(); // bytes
            const totalGB = totalMemory / (1024 * 1024 * 1024);

            if (totalGB >= 12) return 35; // High-end: offload most layers
            if (totalGB >= 8) return 20;  // Mid-high
            if (totalGB >= 6) return 10;  // Mid
            return 0; // Low-end: CPU only for stability
        } catch (e) {
            console.error('[LLMEngine] Failed to calculate GPU layers', e);
            return 0;
        }
    }

    /**
     * Initialize the llama.rn engine and load a GGUF model from disk.
     */
    async initialize(model: ModelMetadata, onProgress?: (progress: number) => void) {
        if (this.state === 'ready' && this.context && this.currentModelId === model.id) {
            return;
        }

        if (this.state === 'warming_up' && this.initPromise && this.currentModelId === model.id) {
            await this.initPromise;
            return;
        }

        if (this.context || this.state !== 'uninitialized') {
            await this.unload();
        }

        this.currentModelId = model.id;
        this.initPromise = (async () => {
            try {
                this.updateState('warming_up');

                const modelPath = `${RNFS.DocumentDirectoryPath}/${model.id.replace(/\//g, '_')}.bin`;
                const exists = await RNFS.exists(modelPath);
                if (!exists) {
                    throw new Error(`Model file not found at ${modelPath}`);
                }

                let gpuLayers = await this.calculateGpuLayers();

                try {
                    this.context = await initLlama(
                        {
                            model: modelPath,
                            n_ctx: model.contextWindow || 2048,
                            n_gpu_layers: gpuLayers,
                            flash_attn_type: 'auto',
                        },
                        onProgress,
                    );
                } catch (gpuError) {
                    console.warn('[LLMEngine] GPU init failed, retrying with CPU only', gpuError);
                    // Fallback to CPU only
                    this.context = await initLlama(
                        {
                            model: modelPath,
                            n_ctx: model.contextWindow || 2048,
                            n_gpu_layers: 0,
                            flash_attn_type: 'auto',
                        },
                        onProgress,
                    );
                }

                this.updateState('ready');
            } catch (e) {
                console.error('[LLMEngine] Failed to initialize', e);
                this.updateState('error');
                throw e;
            } finally {
                this.initPromise = null;
            }
        })();

        await this.initPromise;
    }

    async chatCompletion(
        prompt: string,
        systemPrompt?: string,
        onToken?: (token: string) => void,
        params?: { temperature?: number; top_p?: number; n_predict?: number },
    ): Promise<NativeCompletionResult> {
        if (this.state === 'warming_up' && this.initPromise) {
            await this.initPromise;
        }

        if (!this.context || this.state !== 'ready') {
            throw new Error('Engine not ready');
        }

        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const result = await this.context.completion(
            {
                messages,
                n_predict: params?.n_predict ?? 512,
                temperature: params?.temperature ?? 0.7,
                top_p: params?.top_p ?? 0.9,
                stop: ['</s>', '<|im_end|>', '<|end|>'],
            },
            (data: TokenData) => {
                if (onToken && data.token) {
                    onToken(data.token);
                }
            },
        );

        return result;
    }

    async stopCompletion() {
        if (this.context) {
            await this.context.stopCompletion();
        }
    }

    async unload() {
        this.initPromise = null;
        if (this.context) {
            await releaseAllLlama();
            this.context = null;
        }
        this.currentModelId = null;
        this.updateState('uninitialized');
        hardwareListenerService.resetLowMemoryFlag();
    }

    subscribe(listener: StateListener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }

    getState(): EngineState {
        return this.state;
    }

    private updateState(newState: EngineState) {
        this.state = newState;
        this.listeners.forEach((l) => l(this.state));
    }
}

export const llmEngineService = new LLMEngineService();
