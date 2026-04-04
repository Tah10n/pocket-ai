import {
  initLlama,
  releaseAllLlama,
  LlamaContext,
  TokenData,
  NativeCompletionResult,
  toggleNativeLog,
  addNativeLogListener,
  loadLlamaModelInfo,
  BuildInfo,
} from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceInfo from 'react-native-device-info';
import { hardwareListenerService } from './HardwareListenerService';
import { EngineStatus, EngineState } from '../types/models';
import { LlmChatCompletionOptions, LlmChatMessage } from '../types/chat';
import { registry } from './LocalStorageRegistry';
import { getModelsDir } from './FileSystemSetup';
import {
  getModelLoadParametersForModel,
  updateSettings,
} from './SettingsStore';
import { AppError, toAppError } from './AppError';
import { getSystemMemorySnapshot } from './SystemMetricsService';
import { MIN_CONTEXT_WINDOW_TOKENS, resolveContextWindowCeiling } from '../utils/contextWindow';
import {
  DEFAULT_TOTAL_MEMORY_BYTES,
  FITS_IN_RAM_HEADROOM_RATIO,
  resolveConservativeAvailableMemoryBudget,
} from '../memory/budget';
import { estimateMemoryFitFromModelSize } from '../memory/estimator';
import type { MemoryFitResult } from '../memory/types';
import { DECIMAL_GIGABYTE } from '../utils/modelSize';

export interface LoadModelOptions {
  forceReload?: boolean;
  allowUnsafeMemoryLoad?: boolean;
}

type StateListener = (state: EngineState) => void;
const DEFAULT_CONTEXT_SIZE = 4096;
const MAX_NATIVE_LOG_LINES = 120;

function getErrorMessageText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return '';
}

function isConversationAlternationError(error: unknown): boolean {
  const message = getErrorMessageText(error);
  return /Conversation roles must alternate user\/assistant/i.test(message);
}

function getModelInfoString(modelInfo: unknown, key: string): string | null {
  if (!modelInfo || typeof modelInfo !== 'object') {
    return null;
  }

  const value = (modelInfo as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : null;
}

function mergeConsecutiveMessages(messages: LlmChatMessage[]): LlmChatMessage[] {
  const merged: LlmChatMessage[] = [];

  for (const message of messages) {
    if (merged.length === 0) {
      merged.push({ ...message });
      continue;
    }

    const lastMessage = merged[merged.length - 1];
    if (lastMessage.role === message.role) {
      merged[merged.length - 1] = {
        role: lastMessage.role,
        content: `${lastMessage.content}\n\n${message.content}`,
      };
      continue;
    }

    merged.push({ ...message });
  }

  return merged;
}

function normalizeMessagesForStrictRoleAlternation(messages: LlmChatMessage[]): LlmChatMessage[] {
  const systemParts: string[] = [];
  const nonSystemMessages: LlmChatMessage[] = [];

  for (const message of messages) {
    const content = message.content ?? '';
    if (content.trim().length === 0) {
      continue;
    }

    if (message.role === 'system') {
      systemParts.push(content);
      continue;
    }

    nonSystemMessages.push({ role: message.role, content });
  }

  let merged = mergeConsecutiveMessages(nonSystemMessages);

  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged = merged.slice(1);
  }

  const systemContent = systemParts.join('\n\n');
  const trimmedSystemContent = systemContent.trim();
  if (trimmedSystemContent.length > 0) {
    const sysWrappedRegex = /^\s*<<SYS>>[\s\S]*<<\/SYS>>\s*$/;
    const isAlreadyWrapped = sysWrappedRegex.test(trimmedSystemContent);

    const cleanedSystemContent = isAlreadyWrapped
      ? trimmedSystemContent
      : trimmedSystemContent
          .replace(/<<SYS>>/g, '')
          .replace(/<<\/SYS>>/g, '')
          .trim();

    if (cleanedSystemContent.length === 0) {
      return mergeConsecutiveMessages(merged);
    }

    const normalizedSystemContent = isAlreadyWrapped
      ? cleanedSystemContent
      : `<<SYS>>\n${cleanedSystemContent}\n<</SYS>>`;

    if (merged.length === 0) {
      merged = [{ role: 'user', content: normalizedSystemContent }];
    } else if (merged[0].role === 'user') {
      merged[0] = { role: 'user', content: `${normalizedSystemContent}\n\n${merged[0].content}` };
    } else {
      merged.unshift({ role: 'user', content: normalizedSystemContent });
    }
  }

  return mergeConsecutiveMessages(merged);
}

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
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[LLMEngine] Low memory warning — unloading model');
        }
        this.unload();
      }
    });
  }

  /**
   * Determine the number of GPU layers based on device RAM.
   */
  private suggestGpuLayersForTotalMemory(totalMemory: number): number {
    const totalGB = totalMemory / DECIMAL_GIGABYTE;

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

      this.initPromise = this.initializeModel(
        modelId,
        model.localPath,
        model.maxContextTokens,
        model.size ?? null,
        options?.allowUnsafeMemoryLoad === true,
      );
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

    let hasStreamedTokens = false;
    const markTokensStreamed = () => {
      hasStreamedTokens = true;
    };

    const runCompletion = async (completionMessages: LlmChatMessage[], onTokensStreamed: () => void) => {
      const completionPromise = this.context!.completion(
        {
          messages: completionMessages,
          n_predict: params?.n_predict ?? 512,
          temperature: params?.temperature ?? 0.7,
          top_p: params?.top_p ?? 0.9,
          top_k: params?.top_k ?? 40,
          min_p: params?.min_p ?? 0.05,
          penalty_repeat: params?.penalty_repeat ?? 1,
          enable_thinking: params?.enable_thinking ?? false,
          reasoning_format: params?.reasoning_format ?? 'none',
          stop: ['</s>', '<|im_end|>', '<|end|>'],
        },
        (data: TokenData) => {
          if (data.token || data.content !== undefined || data.reasoning_content !== undefined) {
            onTokensStreamed();
            onToken?.({
              token: data.token ?? '',
              content: data.content,
              reasoningContent: data.reasoning_content,
              accumulatedText: data.accumulated_text,
            });
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
    };

    try {
      hasStreamedTokens = false;
      return await runCompletion(messages, markTokensStreamed);
    } catch (error) {
      if (isConversationAlternationError(error)) {
        if (hasStreamedTokens && onToken) {
          console.warn(
            '[LLMEngine] Conversation alternation error after streaming started; skipping retry to avoid duplicate output',
          );
          throw error;
        }

        console.warn('[LLMEngine] Retrying completion after normalizing chat roles for strict templates');
        const normalizedMessages = normalizeMessagesForStrictRoleAlternation(messages);
        hasStreamedTokens = false;
        return await runCompletion(normalizedMessages, markTokensStreamed);
      }

      throw error;
    }
  }

  public async stopCompletion(): Promise<void> {
    if (this.context) {
      await this.context.stopCompletion();
    }
  }

  public async interruptActiveCompletion(): Promise<void> {
    const activeCompletion = this.activeCompletionPromise;
    if (!activeCompletion) {
      return;
    }

    try {
      await this.stopCompletion();
    } catch (error) {
      console.warn('[LLMEngine] Failed to interrupt active completion', error);
    }

    try {
      await activeCompletion;
    } catch {
      // Completion failures are handled by the chat flow that initiated them.
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
  public async fitsInRam(modelSize: number): Promise<MemoryFitResult> {
    const totalMemoryBytes = await DeviceInfo.getTotalMemory().catch(() => DEFAULT_TOTAL_MEMORY_BYTES);

    // This is a cheap UI-facing estimate: it must never depend on live "available memory" snapshots.
    return estimateMemoryFitFromModelSize({
      modelSizeBytes: modelSize,
      totalMemoryBytes,
      systemMemorySnapshot: null,
    });
  }

  private async runExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previousOperation = this.operationQueue;
    let releaseQueue: () => void = () => undefined;

    this.operationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousOperation.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseQueue();
    }
  }

  private async initializeModel(
    modelId: string,
    localPath: string,
    modelMaxContextTokens?: number,
    modelSizeBytes?: number | null,
    allowUnsafeMemoryLoad = false,
  ): Promise<void> {
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    const nativeLogs: { level: string; text: string }[] = [];
    let nativeLogListener: { remove: () => void } | null = null;
    let didEnableNativeLogs = false;
    let initDiagnostics: Record<string, unknown> | null = null;
    let gpuInitError: unknown | null = null;
    let cpuInitError: unknown | null = null;
    const shouldBridgeNativeLogs = (
      isDev
      && process.env.NODE_ENV !== 'test'
      && process.env.EXPO_PUBLIC_LLAMA_NATIVE_LOGS === '1'
    );

    try {
      this.isUnloading = false;
      this.updateState({
        status: EngineStatus.INITIALIZING,
        activeModelId: modelId,
        loadProgress: 0,
        lastError: undefined,
      });

      const modelsDir = getModelsDir();
      if (!modelsDir) {
        throw new AppError('action_failed', 'Local file system is unavailable on this platform.', {
          details: { modelId },
        });
      }

      const modelPath = modelsDir + localPath;
      const fileInfo = await FileSystem.getInfoAsync(modelPath);
      if (!fileInfo.exists) {
        throw new AppError('download_file_missing', `Model file not found at ${modelPath}`, {
          details: { modelId, modelPath },
        });
      }

      const loadParams = getModelLoadParametersForModel(modelId);
      const systemMemorySnapshot = await getSystemMemorySnapshot().catch(() => null);
      let totalMemoryBytes: number | null = null;
      try {
        totalMemoryBytes = await DeviceInfo.getTotalMemory();
      } catch (error) {
        console.warn('[LLMEngine] Failed to resolve total device memory', error);
      }

      const resolvedTotalMemoryBytes = systemMemorySnapshot?.totalBytes ?? totalMemoryBytes;
      const resolvedModelSizeBytes = typeof fileInfo.size === 'number' ? fileInfo.size : modelSizeBytes ?? null;
      let memoryFit: MemoryFitResult | null = null;

      let modelInfo: Record<string, unknown> | null = null;
      try {
        modelInfo = await loadLlamaModelInfo(modelPath) as Record<string, unknown>;
      } catch (error) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[LLMEngine] Failed to read GGUF metadata', error);
        }
      }

      const ggufArchitecture = getModelInfoString(modelInfo, 'general.architecture')?.toLowerCase() ?? null;
      const ggufType = getModelInfoString(modelInfo, 'general.type')?.toLowerCase() ?? null;
      if (ggufType === 'mmproj' || ggufArchitecture === 'clip') {
        throw new AppError(
          'model_incompatible',
          'CLIP projector models (mmproj) cannot be used as the main model. Download the base language model GGUF instead.',
          {
            details: {
              modelId,
              ggufType,
              ggufArchitecture,
            },
          },
        );
      }

      initDiagnostics = {
        modelId,
        llamaRnBuild: BuildInfo,
        fileSizeBytes: typeof fileInfo.size === 'number' ? fileInfo.size : null,
        totalMemoryBytes: resolvedTotalMemoryBytes,
        hasSystemMemorySnapshot: systemMemorySnapshot !== null,
        lowMemorySignal: systemMemorySnapshot?.lowMemory ?? hardwareListenerService.getCurrentStatus().isLowMemory,
        requestedModelSizeBytes: resolvedModelSizeBytes,
        ggufInfo: {
          architecture: ggufArchitecture,
          type: ggufType,
        },
        loadParams,
      };
      if (typeof resolvedModelSizeBytes === 'number' && Number.isFinite(resolvedModelSizeBytes) && resolvedModelSizeBytes > 0 && typeof resolvedTotalMemoryBytes === 'number' && Number.isFinite(resolvedTotalMemoryBytes) && resolvedTotalMemoryBytes > 0) {
        memoryFit = estimateMemoryFitFromModelSize({
          modelSizeBytes: resolvedModelSizeBytes,
          totalMemoryBytes: resolvedTotalMemoryBytes,
          systemMemorySnapshot,
        });

        if (initDiagnostics) {
          initDiagnostics = {
            ...initDiagnostics,
            memoryFit,
          };
        }

        const overBudgetRatio = memoryFit.effectiveBudgetBytes > 0
          ? memoryFit.requiredBytes / memoryFit.effectiveBudgetBytes
          : Number.POSITIVE_INFINITY;
        const shouldBlockUnsafeLoad = memoryFit.decision === 'likely_oom' || overBudgetRatio > 1.25;
        const exceedsBudget = memoryFit.effectiveBudgetBytes > 0 && memoryFit.requiredBytes >= memoryFit.effectiveBudgetBytes;
        const availableBudgetBytes = systemMemorySnapshot
          ? resolveConservativeAvailableMemoryBudget(systemMemorySnapshot)
          : null;

        if (exceedsBudget && (!allowUnsafeMemoryLoad || shouldBlockUnsafeLoad)) {
          throw new AppError('model_memory_insufficient', 'Not enough memory to load this model.', {
            details: {
              modelId,
              modelSizeBytes: resolvedModelSizeBytes,
              estimatedRuntimeBytes: memoryFit.requiredBytes,
              totalMemoryBytes: resolvedTotalMemoryBytes,
              availableMemoryBytes: systemMemorySnapshot?.availableBytes,
              freeMemoryBytes: systemMemorySnapshot?.freeBytes,
              thresholdBytes: systemMemorySnapshot?.thresholdBytes,
              totalBudgetBytes: memoryFit.budget.totalMemoryBytes * FITS_IN_RAM_HEADROOM_RATIO,
              availableBudgetBytes,
              effectiveAvailableBudgetBytes: memoryFit.effectiveBudgetBytes,
              lowMemory: systemMemorySnapshot?.lowMemory ?? hardwareListenerService.getCurrentStatus().isLowMemory,
              allowUnsafeMemoryLoad,
              overBudgetRatio,
              decision: memoryFit.decision,
              confidence: memoryFit.confidence,
            },
          });
        }
      }

      const resolvedContextSize = resolveContextWindowCeiling({
        modelMaxContextTokens,
        modelSizeBytes: typeof fileInfo.size === 'number' ? fileInfo.size : modelSizeBytes ?? null,
        totalMemoryBytes: resolvedTotalMemoryBytes,
        appMaxContextTokens: loadParams.contextSize,
      });
      const shouldUseSafeLoadProfile = Boolean(
        allowUnsafeMemoryLoad
        && memoryFit
        && memoryFit.effectiveBudgetBytes > 0
        && memoryFit.requiredBytes >= memoryFit.effectiveBudgetBytes,
      );
      const finalContextSize = shouldUseSafeLoadProfile ? MIN_CONTEXT_WINDOW_TOKENS : resolvedContextSize;
      const gpuLayers = shouldUseSafeLoadProfile
        ? 0
        : loadParams.gpuLayers ?? (
        resolvedTotalMemoryBytes != null
          ? this.suggestGpuLayersForTotalMemory(resolvedTotalMemoryBytes)
          : await this.calculateGpuLayers()
      );
      let resolvedGpuLayers = gpuLayers;

      if (initDiagnostics) {
        initDiagnostics = {
          ...initDiagnostics,
          resolvedContextSize: finalContextSize,
          requestedGpuLayers: gpuLayers,
          safeLoadProfile: shouldUseSafeLoadProfile,
        };
      }

      if (shouldBridgeNativeLogs) {
        try {
          nativeLogListener = addNativeLogListener((level, text) => {
            nativeLogs.push({ level, text });
            if (nativeLogs.length > MAX_NATIVE_LOG_LINES) {
              nativeLogs.splice(0, nativeLogs.length - MAX_NATIVE_LOG_LINES);
            }
          });
          await toggleNativeLog(true);
          didEnableNativeLogs = true;
        } catch (error) {
          console.warn('[LLMEngine] Failed to enable native llama logs', error);
        }
      }

      try {
        this.context = await initLlama(
          {
            model: modelPath,
            n_ctx: finalContextSize,
            n_gpu_layers: gpuLayers,
            use_mmap: true,
            use_mlock: false,
            flash_attn_type: 'auto',
          },
          (progress) => {
            this.updateState({ ...this.state, loadProgress: progress });
          }
        );
      } catch (gpuError) {
        gpuInitError = gpuError;
        if (gpuLayers > 0) {
          if (process.env.NODE_ENV !== 'test') {
            console.warn('[LLMEngine] GPU init failed, falling back to CPU', gpuError);
          }
          resolvedGpuLayers = 0;
          try {
            this.context = await initLlama(
              {
                model: modelPath,
                n_ctx: resolvedContextSize,
                n_gpu_layers: 0,
                use_mmap: true,
                use_mlock: false,
                flash_attn_type: 'auto',
              },
              (progress) => {
                this.updateState({ ...this.state, loadProgress: progress });
              }
            );
          } catch (cpuError) {
            cpuInitError = cpuError;
            throw cpuError;
          }
        } else {
          throw gpuError;
        }
      }

      this.activeContextSize = finalContextSize;
      this.activeGpuLayers = resolvedGpuLayers;
      this.updateState({ ...this.state, status: EngineStatus.READY, loadProgress: 1 });
      updateSettings({ activeModelId: modelId });
    } catch (error) {
      const baseError = toAppError(error, 'model_load_failed');
      const extraDetails: Record<string, unknown> = {
        ...(baseError.details ?? {}),
        ...(initDiagnostics ?? {}),
      };

      if (gpuInitError) {
        extraDetails.gpuInitError = getErrorMessageText(gpuInitError);
      }

      if (cpuInitError) {
        extraDetails.cpuInitError = getErrorMessageText(cpuInitError);
      }

      if (isDev && nativeLogs.length > 0) {
        extraDetails.nativeLogs = nativeLogs.map((line) => `${line.level}: ${line.text}`);
      }

      const errorCause = baseError.cause ?? (error instanceof AppError ? error.cause : error);
      const appError = Object.keys(extraDetails).length > 0
        ? new AppError(baseError.code, baseError.message, {
            cause: errorCause,
            details: extraDetails,
          })
        : baseError;

      console.error('[LLMEngine] Failed to initialize', appError, Object.keys(extraDetails).length > 0 ? extraDetails : undefined);
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
      if (nativeLogListener) {
        nativeLogListener.remove();
      }

      if (didEnableNativeLogs) {
        await toggleNativeLog(false).catch(() => undefined);
      }

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
