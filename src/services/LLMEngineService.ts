import { initLlama, releaseAllLlama, LlamaContext, TokenData, NativeCompletionResult } from 'llama.rn';
import RNFS from 'react-native-fs';
import { hardwareListenerService } from './HardwareListenerService';
import { ModelMetadata } from './ModelCatalogService';

export type EngineState = 'uninitialized' | 'warming_up' | 'ready' | 'error';

type StateListener = (state: EngineState) => void;

class LLMEngineService {
    private context: LlamaContext | null = null;
    private state: EngineState = 'uninitialized';
    private listeners: Set<StateListener> = new Set();
    private hwUnsubscribe?: () => void;

    constructor() {
        this.hwUnsubscribe = hardwareListenerService.subscribe((status) => {
            // Unload the model gracefully if the OS warns about low memory
            if (status.isLowMemory && this.context) {
                console.warn('[LLMEngine] Low memory warning — unloading model');
                this.unload();
            }
        });
    }

    /**
     * Initialize the llama.rn engine and load a GGUF model from disk.
     * @param model Metadata of the model (id is used to find the .gguf file on disk)
     * @param onProgress Progress callback (0-100)
     */
    async initialize(model: ModelMetadata, onProgress?: (progress: number) => void) {
        try {
            this.updateState('warming_up');

            const modelPath = `${RNFS.DocumentDirectoryPath}/${model.id.replace(/\//g, '_')}.bin`;
            const exists = await RNFS.exists(modelPath);
            if (!exists) {
                throw new Error(`Model file not found at ${modelPath}`);
            }

            this.context = await initLlama(
                {
                    model: modelPath,
                    n_ctx: model.contextWindow || 2048,
                    n_gpu_layers: 99, // Offload as many layers as possible to GPU
                    flash_attn_type: 'auto',
                },
                onProgress,
            );

            this.updateState('ready');
        } catch (e) {
            console.error('[LLMEngine] Failed to initialize', e);
            this.updateState('error');
            throw e;
        }
    }

    /**
     * Run a chat completion with streaming token callback.
     * Returns the full NativeCompletionResult when done.
     */
    async chatCompletion(
        prompt: string,
        systemPrompt?: string,
        onToken?: (token: string) => void,
        params?: { temperature?: number; top_p?: number; n_predict?: number },
    ): Promise<NativeCompletionResult> {
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

    /**
     * Stop the currently running completion.
     */
    async stopCompletion() {
        if (this.context) {
            await this.context.stopCompletion();
        }
    }

    /**
     * Unload the model and release native resources.
     */
    async unload() {
        if (this.context) {
            await releaseAllLlama();
            this.context = null;
        }
        this.updateState('uninitialized');
    }

    subscribe(listener: StateListener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
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
