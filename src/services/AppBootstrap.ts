import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

import i18n from '../i18n';
import { presetManager } from './PresetManager';
import {
  AppSettings,
  ChatHistoryEntry,
  clearLegacyChatHistory,
  getChatHistoryEntries,
  getSettings,
  repairChatHistoryIndex,
  updateSettings,
} from './SettingsStore';
import { getModelsDir, setupFileSystem } from './FileSystemSetup';
import { registry } from './LocalStorageRegistry';
import { getQueuedDownloadFileNames, useDownloadStore } from '../store/downloadStore';
import { llmEngineService } from './LLMEngineService';
import { useChatStore } from '../store/chatStore';
import { useModelsStore } from '../store/modelsStore';
import { performanceMonitor } from './PerformanceMonitor';
import { huggingFaceTokenService } from './HuggingFaceTokenService';
import {
  getPrivateStorageHealthSnapshot,
  initializePrivateStorageEncryption,
  type PrivateStorageHealthSnapshot,
} from './storage';
import { toAppError } from './AppError';
import { stopPrivateRuntimeWorkForStorageBlocked } from './PrivateStorageRecovery';
import { EngineStatus } from '../types/models';
import { isHighConfidenceLikelyOomMemoryFit } from '../utils/modelMemoryFitState';
import { safeJoinModelPath } from '../utils/safeFilePath';
import {
  ChatMessage,
  ChatThread,
  DEFAULT_PRESET_SNAPSHOT,
  DEFAULT_SYSTEM_PROMPT,
  deriveThreadTitle,
} from '../types/chat';

function isRuntimeTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test'
    || typeof process.env.JEST_WORKER_ID === 'string'
    || process.env.EXPO_OS === 'web';
}

function resolveMigratedPresetSnapshot(presetId: string | null) {
  if (!presetId) {
    return { ...DEFAULT_PRESET_SNAPSHOT };
  }

  const preset = presetManager.getPreset(presetId);
  if (!preset) {
    return {
      id: presetId,
      name: 'Missing Preset',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };
  }

  return {
    id: preset.id,
    name: preset.name,
    systemPrompt: preset.systemPrompt,
  };
}

function buildMigratedMessages(entry: ChatHistoryEntry): ChatMessage[] {
  return entry.messages
    .filter((message) => message.content.trim().length > 0)
    .map((message, index) => ({
      id: `${entry.id}-legacy-${index}`,
      role: message.role,
      content: message.content,
      createdAt: entry.createdAt + index,
      state: 'complete' as const,
    }));
}

function buildThreadFromLegacyHistory(entry: ChatHistoryEntry, settings: AppSettings): ChatThread {
  const messages = buildMigratedMessages(entry);

  return {
    id: entry.id,
    title: deriveThreadTitle(messages),
    modelId: entry.modelId,
    presetId: entry.presetId,
    presetSnapshot: resolveMigratedPresetSnapshot(entry.presetId),
    paramsSnapshot: {
      temperature: settings.temperature,
      topP: settings.topP,
      topK: settings.topK ?? 40,
      minP: settings.minP ?? 0.05,
      repetitionPenalty: settings.repetitionPenalty ?? 1,
      maxTokens: settings.maxTokens,
      reasoningEffort: settings.reasoningEffort ?? 'auto',
      seed: settings.seed ?? null,
    },
    messages,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastGeneratedAt: entry.updatedAt,
    status: 'idle',
  };
}

function migrateLegacyChatHistory(settings: AppSettings) {
  const legacyEntries = getChatHistoryEntries();
  if (legacyEntries.length === 0) {
    return 0;
  }

  const importedCount = useChatStore.getState().mergeImportedThreads(
    legacyEntries.map((entry) => buildThreadFromLegacyHistory(entry, settings)),
  );

  clearLegacyChatHistory();

  return importedCount;
}

type BootstrapOutcome = 'success' | 'active_model_missing' | 'active_model_blocked' | 'storage_blocked' | 'error';
type BootstrapCriticalResult =
  | { outcome: Exclude<BootstrapOutcome, 'storage_blocked'> }
  | { outcome: 'storage_blocked'; storageHealth: PrivateStorageHealthSnapshot };
export type BootstrapBackgroundResult =
  | { outcome: 'success' }
  | { outcome: 'storage_blocked'; storageHealth: PrivateStorageHealthSnapshot };

function sanitizePrivateStorageHealthSnapshot(
  storageHealth: PrivateStorageHealthSnapshot,
): PrivateStorageHealthSnapshot {
  return {
    status: storageHealth.status,
    ...(storageHealth.reason ? { reason: storageHealth.reason } : {}),
    retryable: storageHealth.retryable === true,
    requiresExplicitReset: storageHealth.requiresExplicitReset === true,
    ...(storageHealth.messageKey ? { messageKey: storageHealth.messageKey } : {}),
    lastUpdatedAt: Number.isFinite(storageHealth.lastUpdatedAt) ? storageHealth.lastUpdatedAt : Date.now(),
  };
}

function buildStorageBlockedCriticalResult(
  storageHealth: PrivateStorageHealthSnapshot,
): BootstrapCriticalResult {
  return {
    outcome: 'storage_blocked',
    storageHealth: sanitizePrivateStorageHealthSnapshot(storageHealth),
  };
}

function buildStorageBlockedBackgroundResult(
  storageHealth: PrivateStorageHealthSnapshot,
): BootstrapBackgroundResult {
  return {
    outcome: 'storage_blocked',
    storageHealth: sanitizePrivateStorageHealthSnapshot(storageHealth),
  };
}

async function stopPrivateRuntimeWorkForStorageBlockedSafely(): Promise<void> {
  try {
    await stopPrivateRuntimeWorkForStorageBlocked();
  } catch (error) {
    if (!isRuntimeTestEnvironment()) {
      console.warn('[bootstrapApp] Failed to stop runtime work after private storage blocked', error);
    }
  }
}

function getBlockedPrivateStorageHealthSnapshot(): PrivateStorageHealthSnapshot | null {
  const storageHealth = getPrivateStorageHealthSnapshot();
  return storageHealth.status === 'blocked' ? storageHealth : null;
}

async function hydratePersistedStores(): Promise<PrivateStorageHealthSnapshot | null> {
  const span = performanceMonitor.startSpan('bootstrap.hydratePersistedStores');
  let outcome: 'success' | 'storage_blocked' | 'error' = 'success';
  const errors: { scope: string; error: unknown }[] = [];

  const hydrate = async (scope: string, rehydrate: () => unknown) => {
    const hydrateSpan = performanceMonitor.startSpan(`bootstrap.hydrate.${scope}`);
    try {
      await Promise.resolve(rehydrate());
      const blockedStorageHealth = getBlockedPrivateStorageHealthSnapshot();
      if (blockedStorageHealth) {
        outcome = 'storage_blocked';
        hydrateSpan.end({ outcome: 'storage_blocked' });
        return blockedStorageHealth;
      }

      hydrateSpan.end({ outcome: 'success' });
      return null;
    } catch (error) {
      errors.push({ scope, error });
      const blockedStorageHealth = getBlockedPrivateStorageHealthSnapshot();
      if (blockedStorageHealth) {
        outcome = 'storage_blocked';
        hydrateSpan.end({ outcome: 'storage_blocked' });
        return blockedStorageHealth;
      }

      hydrateSpan.end({ outcome: 'error' });
      if (!isRuntimeTestEnvironment()) {
        console.warn(`[bootstrapApp] Failed to hydrate persisted store: ${scope}`, error);
      }
      return null;
    }
  };

  try {
    const chatStorageHealth = await hydrate('chatStore', () => useChatStore.persist.rehydrate());
    if (chatStorageHealth) {
      return chatStorageHealth;
    }

    const downloadStorageHealth = await hydrate('downloadStore', () => useDownloadStore.persist.rehydrate());
    if (downloadStorageHealth) {
      return downloadStorageHealth;
    }

    const modelsStorageHealth = await hydrate('modelsStore', () => useModelsStore.persist.rehydrate());
    if (modelsStorageHealth) {
      return modelsStorageHealth;
    }

    return null;
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    span.end({ outcome, errors: errors.length });
  }
}

async function hydrateHuggingFaceTokenState(): Promise<void> {
  const span = performanceMonitor.startSpan('bootstrap.hydrate.huggingFaceToken');
  let outcome: 'success' | 'error' = 'success';

  try {
    await huggingFaceTokenService.refreshState();
  } catch (error) {
    outcome = 'error';
    if (!isRuntimeTestEnvironment()) {
      console.warn('[bootstrapApp] Failed to hydrate Hugging Face token state', error);
    }
  } finally {
    span.end({ outcome });
  }
}

function scheduleAfterFirstFrame(task: () => void): void {
  if (process.env.NODE_ENV === 'test') {
    setTimeout(task, 0);
    return;
  }

  const requestIdleCallback = (
    globalThis as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => void;
    }
  ).requestIdleCallback;

  const nativeIdleDelayMs = 750;
  let didRun = false;
  let fallbackTimeout: ReturnType<typeof setTimeout> | null = null;

  const runOnce = () => {
    if (didRun) {
      return;
    }

    didRun = true;
    if (fallbackTimeout) {
      clearTimeout(fallbackTimeout);
      fallbackTimeout = null;
    }

    task();
  };

  const scheduleWhenIdle = () => {
    try {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(runOnce, { timeout: 2000 });
        return;
      }
    } catch {
      // ignore
    }

    const delayMs = Platform.OS === 'web' ? 0 : nativeIdleDelayMs;
    setTimeout(runOnce, delayMs);
  };

  const scheduleAfterPaint = () => {
    try {
      if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(() => {
          globalThis.requestAnimationFrame(() => {
            setTimeout(scheduleWhenIdle, 0);
          });
        });
        return;
      }
    } catch {
      // ignore
    }

    scheduleWhenIdle();
  };

  fallbackTimeout = setTimeout(runOnce, 3000);
  scheduleAfterPaint();
}

const MODEL_CATALOG_CACHE_HYDRATION_MAX_ATTEMPTS = 3;
const MODEL_CATALOG_CACHE_HYDRATION_RETRY_DELAY_MS = 1000;

function hydrateModelCatalogCacheWithRetry(attempt: number = 1): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('./ModelCatalogService') as typeof import('./ModelCatalogService');
    module.modelCatalogService.hydratePersistentCache();
  } catch (error) {
    const hasRetryRemaining = attempt < MODEL_CATALOG_CACHE_HYDRATION_MAX_ATTEMPTS;
    if (!isRuntimeTestEnvironment()) {
      console.warn(
        hasRetryRemaining
          ? '[bootstrapApp] Failed to hydrate model catalog cache; retry scheduled'
          : '[bootstrapApp] Failed to hydrate model catalog cache after bounded retries',
        {
          attempt,
          maxAttempts: MODEL_CATALOG_CACHE_HYDRATION_MAX_ATTEMPTS,
          retryDelayMs: hasRetryRemaining
            ? MODEL_CATALOG_CACHE_HYDRATION_RETRY_DELAY_MS * attempt
            : undefined,
        },
        error,
      );
    }

    if (hasRetryRemaining) {
      setTimeout(
        () => hydrateModelCatalogCacheWithRetry(attempt + 1),
        MODEL_CATALOG_CACHE_HYDRATION_RETRY_DELAY_MS * attempt,
      );
    }
  }
}

export function scheduleModelCatalogCacheHydrationAfterFirstFrame(): void {
  scheduleAfterFirstFrame(() => {
    // Cache-tier hydration can parse a bounded JSON payload. Load it only
    // after the app shell has committed its first frame. A short bounded retry
    // window recovers transient private-storage readiness failures without
    // moving cache parsing back onto the startup critical path.
    hydrateModelCatalogCacheWithRetry();
  });
}

type BootRestoreSkipReason =
  | 'settings_changed'
  | 'engine_ready_other'
  | 'engine_initializing_other'
  | 'engine_already_target'
  | 'engine_unknown';

function resolveBootRestoreTarget(requestedModelId: string): { modelId: string | null; reason?: BootRestoreSkipReason } {
  const settingsModelId = getSettings().activeModelId;
  if (settingsModelId !== requestedModelId) {
    return { modelId: null, reason: 'settings_changed' };
  }

  try {
    const engineState = llmEngineService.getState();
    if (
      (engineState.status === EngineStatus.READY || engineState.status === EngineStatus.INITIALIZING)
      && engineState.activeModelId
      && engineState.activeModelId !== requestedModelId
    ) {
      return {
        modelId: null,
        reason: engineState.status === EngineStatus.READY ? 'engine_ready_other' : 'engine_initializing_other',
      };
    }

    if (
      (engineState.status === EngineStatus.READY || engineState.status === EngineStatus.INITIALIZING)
      && engineState.activeModelId === requestedModelId
    ) {
      return { modelId: null, reason: 'engine_already_target' };
    }
  } catch {
    return { modelId: null, reason: 'engine_unknown' };
  }

  return { modelId: requestedModelId };
}

function scheduleActiveModelRestore(activeModelId: string): void {
  scheduleAfterFirstFrame(() => {
    const restoreSpan = performanceMonitor.startSpan('bootstrap.restoreActiveModel', {
      modelId: activeModelId,
    });

    const restore = async () => {
      try {
        const decision = resolveBootRestoreTarget(activeModelId);
        if (!decision.modelId) {
          restoreSpan.end({ outcome: 'skipped', reason: `skipped_stale_restore:${decision.reason ?? 'unknown'}` });
          return;
        }

        await llmEngineService.load(decision.modelId, { preferLastWorkingProfile: true });
        restoreSpan.end({ outcome: 'success' });
      } catch (error) {
        const appError = toAppError(error);
        if (appError.code === 'model_memory_warning' || appError.code === 'model_load_blocked') {
          // Do not auto-override memory policy during bootstrap. Preserve the user's selection
          // and let the UI prompt if they explicitly want to load anyway.
          restoreSpan.end({ outcome: 'skipped', reason: appError.code });
          return;
        }

        console.warn('[bootstrapApp] Failed to restore active model', error);
        restoreSpan.end({ outcome: 'error', reason: appError.code });
      }
    };

    void restore();
  });
}

export async function bootstrapAppCritical(): Promise<BootstrapCriticalResult> {
  const bootstrapSpan = performanceMonitor.startSpan('bootstrap.critical');
  let outcome: BootstrapOutcome = 'success';

  try {
    const encryptionSpan = performanceMonitor.startSpan('bootstrap.initializePrivateStorageEncryption');
    try {
      const currentStorageHealth = getPrivateStorageHealthSnapshot();
      if (currentStorageHealth.status === 'blocked') {
        outcome = 'storage_blocked';
        encryptionSpan.end({ outcome });
        return buildStorageBlockedCriticalResult(currentStorageHealth);
      }

      const initializedStorageHealth = await initializePrivateStorageEncryption();
      if (initializedStorageHealth.status === 'blocked') {
        outcome = 'storage_blocked';
        encryptionSpan.end({ outcome });
        return buildStorageBlockedCriticalResult(initializedStorageHealth);
      }

      encryptionSpan.end({ outcome: 'success' });
    } catch (error) {
      const currentStorageHealth = getPrivateStorageHealthSnapshot();
      if (currentStorageHealth.status === 'blocked') {
        outcome = 'storage_blocked';
        encryptionSpan.end({ outcome });
        return buildStorageBlockedCriticalResult(currentStorageHealth);
      }

      encryptionSpan.end({ outcome: 'error' });
      throw error;
    }

    const hydrationBlockedStorageHealth = await hydratePersistedStores();
    if (hydrationBlockedStorageHealth) {
      outcome = 'storage_blocked';
      return buildStorageBlockedCriticalResult(hydrationBlockedStorageHealth);
    }

    const settings = getSettings();

    try {
      if (i18n.language !== settings.language) {
        await i18n.changeLanguage(settings.language);
      }
    } catch (e) {
      console.warn('[bootstrapApp] Failed to set language', e);
    }

    if (settings.activeModelId) {
      const activeModelId = settings.activeModelId;
      const activeModel = registry.getModel(activeModelId);
      if (!activeModel?.localPath) {
        updateSettings({ activeModelId: null });
        outcome = 'active_model_missing';
        return { outcome };
      }

      try {
        await setupFileSystem();
      } catch (e) {
        console.warn('[bootstrapApp] Failed to setup filesystem for active model validation', e);
      }

      const modelsDir = getModelsDir();
      const activeModelUri = modelsDir ? safeJoinModelPath(modelsDir, activeModel.localPath) : null;
      if (!activeModelUri) {
        updateSettings({ activeModelId: null });
        outcome = 'active_model_missing';
        return { outcome };
      }

      try {
        const activeModelInfo = await FileSystem.getInfoAsync(activeModelUri);
        if (activeModelInfo.exists === false) {
          updateSettings({ activeModelId: null });
          outcome = 'active_model_missing';
          return { outcome };
        }
      } catch (e) {
        console.warn('[bootstrapApp] Failed to validate active model file, skipping cleanup', e);
      }

      if (isHighConfidenceLikelyOomMemoryFit(activeModel)) {
        outcome = 'active_model_blocked';
        return { outcome };
      }

      scheduleActiveModelRestore(activeModelId);
    }

    return { outcome };
  } catch (error) {
    const blockedStorageHealth = getBlockedPrivateStorageHealthSnapshot();
    if (blockedStorageHealth) {
      outcome = 'storage_blocked';
      return buildStorageBlockedCriticalResult(blockedStorageHealth);
    }

    outcome = 'error';
    throw error;
  } finally {
    bootstrapSpan.end({ outcome });
  }
}

export async function bootstrapAppBackground(): Promise<BootstrapBackgroundResult> {
  const bootstrapSpan = performanceMonitor.startSpan('bootstrap.background');
  let outcome: 'success' | 'storage_blocked' | 'error' = 'success';
  const errors: { scope: string; error: unknown }[] = [];

  const recordError = (scope: string, error: unknown) => {
    errors.push({ scope, error });
    if (!isRuntimeTestEnvironment()) {
      console.warn(`[bootstrapApp] Background bootstrap failed: ${scope}`, error);
    }
  };

  const buildBlockedResultIfNeeded = async (): Promise<BootstrapBackgroundResult | null> => {
    const blockedStorageHealth = getBlockedPrivateStorageHealthSnapshot();
    if (!blockedStorageHealth) {
      return null;
    }

    outcome = 'storage_blocked';
    await stopPrivateRuntimeWorkForStorageBlockedSafely();
    return buildStorageBlockedBackgroundResult(blockedStorageHealth);
  };

  try {
    const currentStorageHealth = getPrivateStorageHealthSnapshot();
    if (currentStorageHealth.status === 'blocked') {
      outcome = 'storage_blocked';
      await stopPrivateRuntimeWorkForStorageBlockedSafely();
      return buildStorageBlockedBackgroundResult(currentStorageHealth);
    }

    await hydrateHuggingFaceTokenState();

    const settings = getSettings();

    try {
      await setupFileSystem();
    } catch (e) {
      recordError('setupFileSystem', e);
    }
    const blockedAfterFileSystem = await buildBlockedResultIfNeeded();
    if (blockedAfterFileSystem) {
      return blockedAfterFileSystem;
    }

    try {
      await registry.validateRegistry(getQueuedDownloadFileNames());
    } catch (e) {
      recordError('validateRegistry', e);
    }
    const blockedAfterRegistry = await buildBlockedResultIfNeeded();
    if (blockedAfterRegistry) {
      return blockedAfterRegistry;
    }

    if (!isRuntimeTestEnvironment() && Platform.OS !== 'web') {
      scheduleAfterFirstFrame(() => {
        if (getPrivateStorageHealthSnapshot().status !== 'ready') {
          return;
        }

        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const module = require('./ModelDownloadManager') as typeof import('./ModelDownloadManager');
          module.resumeModelDownloadQueueIfStorageReady();
        } catch (e) {
          if (!isRuntimeTestEnvironment()) {
            console.warn('[bootstrapApp] Failed to warm modelDownloadManager', e);
          }
        }
      });
    }

    try {
      presetManager.getPresets();
    } catch (e) {
      recordError('presetManager.getPresets', e);
    }
    const blockedAfterPresets = await buildBlockedResultIfNeeded();
    if (blockedAfterPresets) {
      return blockedAfterPresets;
    }

    try {
      repairChatHistoryIndex();
      migrateLegacyChatHistory(settings);
      useChatStore.getState().pruneExpiredThreads(settings.chatRetentionDays);
    } catch (e) {
      recordError('chatHistory', e);
    }
    const blockedAfterChatHistory = await buildBlockedResultIfNeeded();
    if (blockedAfterChatHistory) {
      return blockedAfterChatHistory;
    }

    if (errors.length > 0) {
      const firstError = errors[0];
      const errorMessage = firstError?.error instanceof Error ? firstError.error.message : String(firstError?.error);
      const aggregateError = new Error(
        `[bootstrapApp] Background bootstrap encountered errors (${firstError?.scope ?? 'unknown'}): ${errorMessage}`,
      );
      (aggregateError as unknown as { cause?: unknown }).cause = firstError?.error;
      throw aggregateError;
    }

    return { outcome: 'success' };
  } catch (error) {
    const blockedStorageHealth = getBlockedPrivateStorageHealthSnapshot();
    if (blockedStorageHealth) {
      outcome = 'storage_blocked';
      await stopPrivateRuntimeWorkForStorageBlockedSafely();
      return buildStorageBlockedBackgroundResult(blockedStorageHealth);
    }

    outcome = 'error';
    throw error;
  } finally {
    bootstrapSpan.end({ outcome, errors: errors.length });
  }
}

export async function bootstrapApp() {
  const bootstrapSpan = performanceMonitor.startSpan('bootstrap.app');
  let outcome: BootstrapOutcome = 'success';

  try {
    const critical = await bootstrapAppCritical();
    outcome = critical.outcome;

    if (critical.outcome === 'storage_blocked') {
      return;
    }

    const background = await bootstrapAppBackground();
    if (background.outcome === 'storage_blocked') {
      outcome = 'storage_blocked';
    }
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    bootstrapSpan.end({ outcome });
  }
}
