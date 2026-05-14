import {
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
  getModelLoadParametersForModel,
  getSettings,
  getSettingsStorage,
  resetSettingsRuntimeForPrivateStorageReset,
  resetSettings,
  subscribeSettings,
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

  it('notifies live subscribers with default settings after a private storage reset', () => {
    updateSettings({ theme: 'dark', themeId: 'glass' });
    const listener = jest.fn();
    const unsubscribe = subscribeSettings(listener);
    listener.mockClear();

    resetSettingsRuntimeForPrivateStorageReset();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      theme: 'system',
      themeId: 'default',
    }));
    unsubscribe();
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

  it('normalizes CPU masks to a documented numeric list and range grammar', () => {
    updateModelLoadParametersForModel('author/model-q4', {
      cpuMask: ' 0-3, 5,7 ',
    });

    expect(getModelLoadParametersForModel('author/model-q4').cpuMask).toBe('0-3,5,7');
  });

  it('rejects unsafe CPU masks instead of persisting arbitrary native input', () => {
    updateModelLoadParametersForModel('author/model-q4', {
      cpuMask: '0-3;../../tmp',
    });

    expect(getModelLoadParametersForModel('author/model-q4').cpuMask).toBeNull();
  });

  it('rejects CPU masks with internal whitespace instead of changing their meaning', () => {
    updateModelLoadParametersForModel('author/model-q4', {
      cpuMask: '0 1',
    });

    expect(getModelLoadParametersForModel('author/model-q4').cpuMask).toBeNull();
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

  it('persists sanitized settings after non-theme migrations', () => {
    getSettingsStorage().set('app_settings', JSON.stringify({
      themeId: 'default',
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 16384,
          gpuLayers: 999,
          kvCacheType: 'q8',
          backendPolicy: 'auto',
          cpuMask: '../bad',
          parallelSlots: 8,
        },
      },
    }));

    const settings = getSettings();
    expect(settings.modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 16384,
      gpuLayers: UNKNOWN_MODEL_GPU_LAYERS_CEILING,
      kvCacheType: 'q8_0',
      cpuMask: null,
      parallelSlots: 1,
    });

    const storedOnce = getSettingsStorage().getString('app_settings');
    expect(storedOnce).toBe(JSON.stringify(settings));

    getSettings();
    expect(getSettingsStorage().getString('app_settings')).toBe(storedOnce);
  });
});

