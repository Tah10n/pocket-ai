import { AppError } from './AppError';
import { hasActiveChatGenerationWork } from './ChatGenerationService';
import { updateSettings } from './SettingsStore';

export function assertActiveChatPresetMutationAllowed(): void {
  if (hasActiveChatGenerationWork()) {
    throw new AppError(
      'engine_busy',
      'Wait for the current chat work to finish before changing presets.',
    );
  }
}

export function selectActiveChatPreset(presetId: string | null) {
  assertActiveChatPresetMutationAllowed();
  return updateSettings({ activePresetId: presetId });
}
