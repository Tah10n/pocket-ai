import { initLlama, releaseAllLlama, LlamaContext, TokenData, NativeCompletionResult } from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { hardwareListenerService } from './HardwareListenerService';
import { EngineStatus, EngineState } from '../types/models';
import { LlmChatCompletionOptions } from '../types/chat';
import { registry } from './LocalStorageRegistry';
import { MODELS_DIR } from './FileSystemSetup';
import {
  getModelLoadParametersForModel,
  updateSettings,
} from './SettingsStore';
import { AppError, toAppError } from './AppError';

interface LoadModelOptions {
  forceReload?: boolean;
}

type StateListener = (state: EngineState) => void;
const DEFAULT_CONTEXT_SIZE = 2048;

class LLMEngineService {
  private context: LlamaContext | null = null;
  private activeContextSize = DEFAULT_CONTEXT_SIZE;
  private activeGpuLayers: number | null = null;
  private state: EngineState = {
    status: EngineStatus.IDLE,
    loadProgress: 0,
  };
  private listeners: Set<StateListener> = new Set();
  private hwUnsubscribe?: () => void;
  private initPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private activeCompletionPromise: Promise<NativeCompletionResult> | null = null;
  private isUnloading = false;

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
  private suggestGpuLayersForTotalMemory(totalMemory: number): number {
    const totalGB = totalMemory / (1024 * 1024 * 1024);

    if (totalGB >= 12) return 35;
    if (totalGB >= 8) return 20;
    if (totalGB >= 6) return 10;
    return 0;
  }

  private async calculateGpuLayers(): Promise<number> {
    try {
      const totalMemory = await DeviceInfo.getTotalMemory();
      return this.suggestGpuLayersForTotalMemory(totalMemory);
    } catch (e) {
      console.error('[LLMEngine] Failed to calculate GPU layers', e);
      return 0;
    }
  }

  /**
   * Initialize the llama.rn engine and load a GGUF model from disk.
   */
  public async load(modelId: string, options?: LoadModelOptions): Promise<void> {
    await this.runExclusiveOperation(async () => {
      const model = registry.getModel(modelId);
      if (!model || !model.localPath) {
        throw new AppError('model_not_found', `Model ${modelId} not found or not downloaded`, {
          details: { modelId },
        });
      }

      const forceReload = options?.forceReload === true;

      if (
        this.state.status === EngineStatus.READY &&
        this.state.activeModelId === modelId &&
        !forceReload
      ) {
        return;
      }

      if (this.state.activeModelId && (this.state.activeModelId !== modelId || forceReload)) {
        await this.unloadInternal();
      }

      this.initPromise = this.initializeModel(modelId, model.localPath);
      await this.initPromise;
    });
  }

  public async unload(): Promise<void> {
    await this.runExclusiveOperation(async () => {
      await this.unloadInternal();
    });
  }

  public async chatCompletion({
    messages,
    onToken,
    params,
  }: LlmChatCompletionOptions): Promise<NativeCompletionResult> {
    if (this.state.status === EngineStatus.INITIALIZING && this.initPromise) {
      await this.initPromise;
    }

    if (this.isUnloading) {
      throw new AppError('engine_unloading', 'The model engine is unloading. Please wait a moment.');
    }

    if (this.activeCompletionPromise) {
      throw new AppError('engine_busy', 'A response is already being generated.');
    }

    if (!this.context || this.state.status !== EngineStatus.READY) {
      throw new AppError('engine_not_ready', 'Engine not ready');
    }

    const completionPromise = this.context.completion(
      {
        messages,
        n_predict: params?.n_predict ?? 512,
        temperature: params?.temperature ?? 0.7,
        top_p: params?.top_p ?? 0.9,
        top_k: params?.top_k ?? 40,
        min_p: params?.min_p ?? 0.05,
        penalty_repeat: params?.penalty_repeat ?? 1,
        stop: ['</s>', '<|im_end|>', '<|end|>'],
      },
      (data: TokenData) => {
        if (onToken && data.token) {
          onToken(data.token);
        }
      },
    );

    this.activeCompletionPromise = completionPromise;

    try {
      return await completionPromise;
    } finally {
      if (this.activeCompletionPromise === completionPromise) {
        this.activeCompletionPromise = null;
      }
    }
  }

  public async stopCompletion(): Promise<void> {
    if (this.context) {
      await this.context.stopCompletion();
    }
  }

  public getState(): EngineState {
    return this.state;
  }

  public getContextSize(): number {
    return this.activeContextSize;
  }

  public getLoadedGpuLayers(): number | null {
    return this.activeGpuLayers;
  }

  public async getRecommendedGpuLayers(): Promise<number> {
    return this.calculateGpuLayers();
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

  private async runExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previousOperation = this.operationQueue;
    let releaseQueue: (() => void) | null = null;

    this.operationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousOperation.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseQueue?.();
    }
  }

  private async initializeModel(modelId: string, localPath: string): Promise<void> {
    try {
      this.isUnloading = false;
      this.updateState({
        status: EngineStatus.INITIALIZING,
        activeModelId: modelId,
        loadProgress: 0,
        lastError: undefined,
      });

      const modelPath = MODELS_DIR + localPath;
      const fileInfo = await FileSystem.getInfoAsync(modelPath);
      if (!fileInfo.exists) {
        throw new AppError('download_file_missing', `Model file not found at ${modelPath}`, {
          details: { modelId, modelPath },
        });
      }

      const loadParams = getModelLoadParametersForModel(modelId);
      const gpuLayers = loadParams.gpuLayers ?? await this.calculateGpuLayers();
      let resolvedGpuLayers = gpuLayers;

      try {
        this.context = await initLlama(
          {
            model: modelPath,
            n_ctx: loadParams.contextSize,
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
          resolvedGpuLayers = 0;
          this.context = await initLlama(
            {
              model: modelPath,
              n_ctx: loadParams.contextSize,
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

      this.activeContextSize = loadParams.contextSize;
      this.activeGpuLayers = resolvedGpuLayers;
      this.updateState({ ...this.state, status: EngineStatus.READY, loadProgress: 1 });
      updateSettings({ activeModelId: modelId });
    } catch (error) {
      const appError = toAppError(error, 'model_load_failed');
      console.error('[LLMEngine] Failed to initialize', appError);
      this.context = null;
      this.activeContextSize = DEFAULT_CONTEXT_SIZE;
      this.activeGpuLayers = null;
      updateSettings({ activeModelId: null });
      this.updateState({
        status: EngineStatus.ERROR,
        activeModelId: undefined,
        loadProgress: 0,
        lastError: appError.message,
      });
      throw appError;
    } finally {
      this.initPromise = null;
    }
  }

  private async unloadInternal(): Promise<void> {
    this.isUnloading = true;
    this.updateState({
      status: EngineStatus.IDLE,
      activeModelId: undefined,
      loadProgress: 0,
      lastError: undefined,
    });

    try {
      if (this.activeCompletionPromise) {
        try {
          await this.stopCompletion();
        } catch (error) {
          console.warn('[LLMEngine] Failed to stop completion before unload', error);
        }

        try {
          await this.activeCompletionPromise;
        } catch {
          // Completion failures are handled by the chat flow.
        }
      }

      if (this.context) {
        await releaseAllLlama();
      }
    } finally {
      this.context = null;
      this.activeContextSize = DEFAULT_CONTEXT_SIZE;
      this.activeGpuLayers = null;
      this.initPromise = null;
      this.activeCompletionPromise = null;
      this.isUnloading = false;
      updateSettings({ activeModelId: null });
      hardwareListenerService.resetLowMemoryFlag();
    }
  }
}

export const llmEngineService = new LLMEngineService();
