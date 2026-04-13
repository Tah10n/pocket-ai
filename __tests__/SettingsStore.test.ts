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

    expect(getModelLoadParametersForModel('author/model-q4')).toEqual(expect.objectContaining({
      backendPolicy: undefined,
      selectedBackendDevices: ['Adreno'],
    }));
  });
});

