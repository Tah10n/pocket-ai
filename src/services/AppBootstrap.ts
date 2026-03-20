import i18n from 'i18next';
import { presetManager } from './PresetManager';
import { getSettings, repairChatHistoryIndex, updateSettings } from './SettingsStore';
import { setupFileSystem } from './FileSystemSetup';
import { registry } from './LocalStorageRegistry';
import { hardwareListenerService } from './HardwareListenerService';
import { getQueuedDownloadFileNames } from '../store/downloadStore';
import { llmEngineService } from './LLMEngineService';

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
  } catch (e) {
    console.warn('[bootstrapApp] Failed to repair chat history index', e);
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
