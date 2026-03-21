import { initLlama, releaseAllLlama, LlamaContext, TokenData, NativeCompletionResult } from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { hardwareListenerService } from './HardwareListenerService';
import { EngineStatus, EngineState } from '../types/models';
import { LlmChatCompletionOptions } from '../types/chat';
import { registry } from './LocalStorageRegistry';
import { MODELS_DIR } from './FileSystemSetup';
import { updateSettings } from './SettingsStore';

type StateListener = (state: EngineState) => void;

class LLMEngineService {
  private context: LlamaContext | null = null;
  private state: EngineState = {
    status: EngineStatus.IDLE,
    loadProgress: 0,
  };
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
   */
  private async calculateGpuLayers(): Promise<number> {
    try {
      const totalMemory = await DeviceInfo.getTotalMemory();
      const totalGB = totalMemory / (1024 * 1024 * 1024);

      if (totalGB >= 12) return 35;
      if (totalGB >= 8) return 20;
      if (totalGB >= 6) return 10;
      return 0;
    } catch (e) {
      console.error('[LLMEngine] Failed to calculate GPU layers', e);
      return 0;
    }
  }

  /**
   * Initialize the llama.rn engine and load a GGUF model from disk.
   */
  public async load(modelId: string): Promise<void> {
    const model = registry.getModel(modelId);
    if (!model || !model.localPath) {
      throw new Error(`Model ${modelId} not found or not downloaded`);
    }

    if (this.state.status === EngineStatus.READY && this.state.activeModelId === modelId) {
      return;
    }

    if (this.state.status === EngineStatus.INITIALIZING && this.initPromise && this.state.activeModelId === modelId) {
      await this.initPromise;
      return;
    }

    // Unload current if different
    if (this.state.activeModelId && this.state.activeModelId !== modelId) {
      await this.unload();
    }

    this.initPromise = (async () => {
      try {
        this.updateState({ 
          status: EngineStatus.INITIALIZING, 
          activeModelId: modelId, 
          loadProgress: 0 
        });

        const modelPath = MODELS_DIR + model.localPath;
        const fileInfo = await FileSystem.getInfoAsync(modelPath);
        if (!fileInfo.exists) {
          throw new Error(`Model file not found at ${modelPath}`);
        }

        const gpuLayers = await this.calculateGpuLayers();

        try {
          this.context = await initLlama(
            {
              model: modelPath,
              n_ctx: 2048,
              n_gpu_layers: gpuLayers,
              flash_attn_type: 'auto',
            },
            (progress) => {
              this.updateState({ ...this.state, loadProgress: progress });
            }
          );
        } catch (gpuError) {
          if (gpuLayers > 0) {
            console.warn('[LLMEngine] GPU init failed, falling back to CPU', gpuError);
            this.context = await initLlama(
              {
                model: modelPath,
                n_ctx: 2048,
                n_gpu_layers: 0,
                flash_attn_type: 'auto',
              },
              (progress) => {
                this.updateState({ ...this.state, loadProgress: progress });
              }
            );
          } else {
            throw gpuError;
          }
        }

        this.updateState({ ...this.state, status: EngineStatus.READY, loadProgress: 1 });
        updateSettings({ activeModelId: modelId });
      } catch (e) {
        console.error('[LLMEngine] Failed to initialize', e);
        updateSettings({ activeModelId: null });
        this.updateState({ ...this.state, status: EngineStatus.ERROR, lastError: String(e) });
        throw e;
      } finally {
        this.initPromise = null;
      }
    })();

    await this.initPromise;
  }

  public async unload(): Promise<void> {
    if (this.context) {
      await releaseAllLlama();
      this.context = null;
    }
    // Reset initPromise only after the context has been fully released
    // to prevent a concurrent load() call from thinking no init is in progress
    this.initPromise = null;
    
    this.updateState({
      status: EngineStatus.IDLE,
      activeModelId: undefined,
      loadProgress: 0,
    });
    updateSettings({ activeModelId: null });
    hardwareListenerService.resetLowMemoryFlag();
  }

  public async chatCompletion({
    messages,
    onToken,
    params,
  }: LlmChatCompletionOptions): Promise<NativeCompletionResult> {
    if (this.state.status === EngineStatus.INITIALIZING && this.initPromise) {
      await this.initPromise;
    }

    if (!this.context || this.state.status !== EngineStatus.READY) {
      throw new Error('Engine not ready');
    }

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

  public async stopCompletion(): Promise<void> {
    if (this.context) {
      await this.context.stopCompletion();
    }
  }

  public getState(): EngineState {
    return this.state;
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private updateState(newState: EngineState) {
    this.state = newState;
    this.listeners.forEach((l) => l(this.state));
  }

  /**
   * Helper to calculate if model fits in RAM.
   */
  public async fitsInRam(modelSize: number): Promise<boolean> {
    try {
      const totalMemory = await DeviceInfo.getTotalMemory();
      // Heuristic: model size + 20% overhead should be less than 80% of total RAM
      return (modelSize * 1.2) < (totalMemory * 0.8);
    } catch {
      return false;
    }
  }
}

export const llmEngineService = new LLMEngineService();
