import {
  __resetChatGenerationServiceForTests,
  beginChatGenerationWork,
} from '../../src/services/ChatGenerationService';
import { selectActiveChatPreset } from '../../src/services/ActiveChatPresetService';
import { getSettings, updateSettings } from '../../src/services/SettingsStore';

describe('ActiveChatPresetService', () => {
  beforeEach(() => {
    __resetChatGenerationServiceForTests();
    updateSettings({ activePresetId: null });
  });

  afterEach(() => {
    __resetChatGenerationServiceForTests();
  });

  it('rejects a preset mutation while document preparation owns chat work', () => {
    const work = beginChatGenerationWork('document_prepare');

    expect(() => selectActiveChatPreset('preset-2')).toThrow(
      'Wait for the current chat work to finish before changing presets.',
    );
    expect(getSettings().activePresetId).toBeNull();

    work.finish();
    selectActiveChatPreset('preset-2');
    expect(getSettings().activePresetId).toBe('preset-2');
  });
});
