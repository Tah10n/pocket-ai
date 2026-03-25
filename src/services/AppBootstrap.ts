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
import { hardwareListenerService } from './HardwareListenerService';
import { getQueuedDownloadFileNames } from '../store/downloadStore';
import { llmEngineService } from './LLMEngineService';
import { useChatStore } from '../store/chatStore';
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

export async function bootstrapApp() {
  const settings = getSettings();

  // Core Infrastructure
  try {
    await setupFileSystem();
    await registry.validateRegistry(getQueuedDownloadFileNames());
    hardwareListenerService.start();
  } catch (e) {
    console.error('[bootstrapApp] Infrastructure setup failed', e);
  }

  try {
    if (i18n.language !== settings.language) {
      await i18n.changeLanguage(settings.language);
    }
  } catch (e) {
    console.warn('[bootstrapApp] Failed to set language', e);
  }

  try {
    presetManager.getPresets();
  } catch (e) {
    console.warn('[bootstrapApp] Failed to initialize presets', e);
  }

  try {
    repairChatHistoryIndex();
    migrateLegacyChatHistory(settings);
    useChatStore.getState().pruneExpiredThreads(settings.chatRetentionDays);
  } catch (e) {
    console.warn('[bootstrapApp] Failed to repair or migrate chat history', e);
  }

  if (settings.activeModelId) {
    const activeModel = registry.getModel(settings.activeModelId);
    if (!activeModel?.localPath) {
      updateSettings({ activeModelId: null });
      return;
    }

    try {
      await llmEngineService.load(settings.activeModelId);
    } catch (e) {
      console.warn('[bootstrapApp] Failed to restore active model', e);
      updateSettings({ activeModelId: null });
    }
  }
}
