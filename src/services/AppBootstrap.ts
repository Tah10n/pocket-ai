import i18n from 'i18next';
import { presetManager } from './PresetManager';
import { getSettings, repairChatHistoryIndex } from './SettingsStore';
import { setupFileSystem } from './FileSystemSetup';
import { registry } from './LocalStorageRegistry';
import { hardwareListenerService } from './HardwareListenerService';

export async function bootstrapApp() {
  const settings = getSettings();

  // Core Infrastructure
  try {
    await setupFileSystem();
    await registry.validateRegistry();
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
}
