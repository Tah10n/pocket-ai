import {
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
  getModelLoadParametersForModel,
  getSettings,
  getSettingsStorage,
  resetSettings,
  updateModelLoadParametersForModel,
  updateSettings,
} from '../src/services/SettingsStore';

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

  it('defaults to the standard visual theme', () => {
    expect(getSettings().themeId).toBe('default');
  });

  it('persists valid visual theme ids', () => {
    updateSettings({ themeId: 'glass' });
    expect(getSettings().themeId).toBe('glass');
  });

  it('sanitizes invalid visual theme ids back to the default', () => {
    updateSettings({ themeId: 'neon' as any });
    expect(getSettings().themeId).toBe('default');
  });

  it('writes a default visual theme id back into legacy settings payloads', () => {
    getSettingsStorage().set('app_settings', JSON.stringify({
      theme: 'dark',
      allowCellularDownloads: true,
    }));

    expect(getSettings().themeId).toBe('default');

    const rawSettings = JSON.parse(getSettingsStorage().getString('app_settings') ?? '{}');
    expect(rawSettings).toEqual(expect.objectContaining({
      theme: 'dark',
      themeId: 'default',
      allowCellularDownloads: true,
    }));
  });

  it('writes sanitized visual theme ids back over invalid persisted values', () => {
    getSettingsStorage().set('app_settings', JSON.stringify({
      themeId: 'neon',
    }));

    expect(getSettings().themeId).toBe('default');

    const rawSettings = JSON.parse(getSettingsStorage().getString('app_settings') ?? '{}');
    expect(rawSettings.themeId).toBe('default');
  });

  it('persists advanced inference settings scaffolding without corrupting load params', () => {
    updateSettings({ showAdvancedInferenceControls: true });
    updateModelLoadParametersForModel('author/model-q4', {
      gpuLayers: UNKNOWN_MODEL_GPU_LAYERS_CEILING + 99,
      backendPolicy: 'gpu',
      selectedBackendDevices: ['Adreno', ' Adreno ', '', 'Hexagon'],
    });

    expect(getSettings().showAdvancedInferenceControls).toBe(true);
    expect(getModelLoadParametersForModel('author/model-q4')).toEqual(expect.objectContaining({
      gpuLayers: UNKNOWN_MODEL_GPU_LAYERS_CEILING,
      backendPolicy: 'gpu',
      selectedBackendDevices: ['Adreno', 'Hexagon'],
    }));
  });

  it('drops invalid backend policy values instead of persisting junk', () => {
    updateModelLoadParametersForModel('author/model-q4', {
      backendPolicy: 'metal' as any,
      selectedBackendDevices: [' ', 42 as any, 'Adreno'],
    });

    const params = getModelLoadParametersForModel('author/model-q4');
    expect(params.backendPolicy).toBeUndefined();
    expect(params.selectedBackendDevices).toEqual(['Adreno']);
  });

  it('normalizes auto backend policy to undefined', () => {
    updateModelLoadParametersForModel('author/model-q4', {
      backendPolicy: 'auto',
    });

    expect(getModelLoadParametersForModel('author/model-q4').backendPolicy).toBeUndefined();
  });

  it('keeps parallel slots at one until parallel decoding is supported', () => {
    updateModelLoadParametersForModel('author/model-q4', {
      parallelSlots: 4,
    });

    expect(getModelLoadParametersForModel('author/model-q4').parallelSlots).toBe(1);
  });

  it('rejects backend device selectors with control chars, path traversal, or over-length', () => {
    updateModelLoadParametersForModel('author/model-q4', {
      selectedBackendDevices: [
        'Adreno\x00',
        '../../etc/passwd',
        'A'.repeat(64),
        'HTP$',
        'cpu:0',
        'HTP0',
        'HTP_1',
        'HTP*',
      ],
    });

    expect(getModelLoadParametersForModel('author/model-q4').selectedBackendDevices)
      .toEqual(['HTP0', 'HTP_1', 'HTP*']);
  });

  it('caps selectedBackendDevices at MAX_BACKEND_DEVICE_SELECTORS entries', () => {
    const manyDevices = Array.from({ length: 20 }, (_, i) => `HTP${i}`);
    updateModelLoadParametersForModel('author/model-q4', {
      selectedBackendDevices: manyDevices,
    });

    const stored = getModelLoadParametersForModel('author/model-q4').selectedBackendDevices ?? [];
    expect(stored).toHaveLength(10);
    expect(stored).toEqual(manyDevices.slice(0, 10));
  });

  it('migrates legacy reasoningEnabled settings to reasoningEffort', () => {
    getSettingsStorage().set('app_settings', JSON.stringify({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 512,
      reasoningEnabled: true,
      modelParamsByModelId: {
        'author/model-q4': {
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 1024,
          reasoningEnabled: false,
        },
      },
    }));

    expect(getSettings()).toEqual(expect.objectContaining({
      reasoningEffort: 'medium',
      modelParamsByModelId: {
        'author/model-q4': expect.objectContaining({
          reasoningEffort: 'off',
        }),
      },
    }));
  });
});

