import { getSettings, getSettingsStorage, resetSettings, updateSettings } from '../src/services/SettingsStore';

describe('SettingsStore', () => {
  beforeEach(() => {
    getSettingsStorage().clearAll();
    resetSettings();
  });

  it('defaults allowCellularDownloads to false', () => {
    expect(getSettings().allowCellularDownloads).toBe(false);
  });

  it('persists allowCellularDownloads changes', () => {
    updateSettings({ allowCellularDownloads: true });
    expect(getSettings().allowCellularDownloads).toBe(true);
  });
});

