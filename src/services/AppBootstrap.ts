import { InteractionManager } from 'react-native';

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
import { setupFileSystem } from './FileSystemSetup';
import { registry } from './LocalStorageRegistry';
import { getQueuedDownloadFileNames, useDownloadStore } from '../store/downloadStore';
import { llmEngineService } from './LLMEngineService';
import { useChatStore } from '../store/chatStore';
import { useModelsStore } from '../store/modelsStore';
import { performanceMonitor } from './PerformanceMonitor';
import { initializePrivateStorageEncryption } from './storage';
import { toAppError } from './AppError';
import {
  ChatMessage,
  ChatThread,
  DEFAULT_PRESET_SNAPSHOT,
  DEFAULT_SYSTEM_PROMPT,
  deriveThreadTitle,
} from '../types/chat';

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
      reasoningEnabled: settings.reasoningEnabled === true,
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

type BootstrapOutcome = 'success' | 'active_model_missing' | 'active_model_blocked' | 'error';

async function hydratePersistedStores(): Promise<void> {
  const span = performanceMonitor.startSpan('bootstrap.hydratePersistedStores');
  let outcome: 'success' | 'error' = 'success';
  const errors: { scope: string; error: unknown }[] = [];

  const hydrate = async (scope: string, rehydrate: () => unknown) => {
    const hydrateSpan = performanceMonitor.startSpan(`bootstrap.hydrate.${scope}`);
    try {
      await Promise.resolve(rehydrate());
      hydrateSpan.end({ outcome: 'success' });
    } catch (error) {
      errors.push({ scope, error });
      hydrateSpan.end({ outcome: 'error' });
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[bootstrapApp] Failed to hydrate persisted store: ${scope}`, error);
      }
    }
  };

  try {
    await hydrate('chatStore', () => useChatStore.persist.rehydrate());
    await hydrate('downloadStore', () => useDownloadStore.persist.rehydrate());
    await hydrate('modelsStore', () => useModelsStore.persist.rehydrate());
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    span.end({ outcome, errors: errors.length });
  }
}

function scheduleAfterFirstFrame(task: () => void): void {
  if (process.env.NODE_ENV === 'test') {
    setTimeout(task, 0);
    return;
  }

  const runAfterPaint = () => {
    try {
      if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(() => {
          setTimeout(task, 0);
        });
        return;
      }
    } catch {
      // ignore
    }

    setTimeout(task, 0);
  };

  try {
    if (typeof InteractionManager?.runAfterInteractions === 'function') {
      InteractionManager.runAfterInteractions(runAfterPaint);
      return;
    }
  } catch {
    // ignore
  }

  runAfterPaint();
}

function scheduleActiveModelRestore(activeModelId: string): void {
  scheduleAfterFirstFrame(() => {
    const restoreSpan = performanceMonitor.startSpan('bootstrap.restoreActiveModel', {
      modelId: activeModelId,
    });

    const restore = async () => {
      try {
        await llmEngineService.load(activeModelId);
        restoreSpan.end({ outcome: 'success' });
      } catch (error) {
        const appError = toAppError(error);
        if (appError.code === 'model_memory_warning') {
          try {
            await llmEngineService.load(activeModelId, { forceReload: true, allowUnsafeMemoryLoad: true });
            restoreSpan.end({ outcome: 'success_safe' });
            return;
          } catch (retryError) {
            console.warn('[bootstrapApp] Failed to restore active model after safe-load retry', retryError);
          }
        } else {
          console.warn('[bootstrapApp] Failed to restore active model', error);
        }

        updateSettings({ activeModelId: null });
        restoreSpan.end({ outcome: 'error' });
      }
    };

    void restore();
  });
}

export async function bootstrapAppCritical(): Promise<{ outcome: BootstrapOutcome }> {
  const bootstrapSpan = performanceMonitor.startSpan('bootstrap.critical');
  let outcome: BootstrapOutcome = 'success';

  try {
    const encryptionSpan = performanceMonitor.startSpan('bootstrap.initializePrivateStorageEncryption');
    try {
      await initializePrivateStorageEncryption();
      encryptionSpan.end({ outcome: 'success' });
    } catch (error) {
      encryptionSpan.end({ outcome: 'error' });
      throw error;
    }

    await hydratePersistedStores();

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

      if (activeModel.memoryFitDecision === 'likely_oom') {
        updateSettings({ activeModelId: null });
        outcome = 'active_model_blocked';
        return { outcome };
      }

      scheduleActiveModelRestore(activeModelId);
    }

    return { outcome };
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    bootstrapSpan.end({ outcome });
  }
}

export async function bootstrapAppBackground(): Promise<void> {
  const bootstrapSpan = performanceMonitor.startSpan('bootstrap.background');
  let outcome: 'success' | 'error' = 'success';
  const errors: { scope: string; error: unknown }[] = [];

  const recordError = (scope: string, error: unknown) => {
    errors.push({ scope, error });
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[bootstrapApp] Background bootstrap failed: ${scope}`, error);
    }
  };

  try {
    const settings = getSettings();

    try {
      await setupFileSystem();
    } catch (e) {
      recordError('setupFileSystem', e);
    }

    try {
      await registry.validateRegistry(getQueuedDownloadFileNames());
    } catch (e) {
      recordError('validateRegistry', e);
    }

    try {
      presetManager.getPresets();
    } catch (e) {
      recordError('presetManager.getPresets', e);
    }

    try {
      repairChatHistoryIndex();
      migrateLegacyChatHistory(settings);
      useChatStore.getState().pruneExpiredThreads(settings.chatRetentionDays);
    } catch (e) {
      recordError('chatHistory', e);
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
  } catch (error) {
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

    await bootstrapAppBackground();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    bootstrapSpan.end({ outcome });
  }
}
