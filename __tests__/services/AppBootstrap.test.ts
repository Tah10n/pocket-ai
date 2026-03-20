jest.mock('i18next', () => ({
  __esModule: true,
  default: {
    language: 'en',
    changeLanguage: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/services/PresetManager', () => ({
  presetManager: {
    getPresets: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: jest.fn(),
  repairChatHistoryIndex: jest.fn(),
  updateSettings: jest.fn(),
}));

jest.mock('../../src/services/FileSystemSetup', () => ({
  setupFileSystem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    validateRegistry: jest.fn().mockResolvedValue(undefined),
    getModel: jest.fn(),
  },
}));

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    start: jest.fn(),
  },
}));

jest.mock('../../src/store/downloadStore', () => ({
  getQueuedDownloadFileNames: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    load: jest.fn().mockResolvedValue(undefined),
  },
}));

import { bootstrapApp } from '../../src/services/AppBootstrap';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getSettings, updateSettings } from '../../src/services/SettingsStore';

describe('AppBootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('restores the persisted active model when the file is still available', async () => {
    (getSettings as jest.Mock).mockReturnValue({
      language: 'en',
      activePresetId: null,
      activeModelId: 'author/model-q4',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      theme: 'system',
    });
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'author/model-q4',
      localPath: 'author_model-q4.gguf',
    });

    await bootstrapApp();

    expect(llmEngineService.load).toHaveBeenCalledWith('author/model-q4');
    expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: null });
  });

  it('clears the persisted active model when the file is missing', async () => {
    (getSettings as jest.Mock).mockReturnValue({
      language: 'en',
      activePresetId: null,
      activeModelId: 'author/missing-model',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      theme: 'system',
    });
    (registry.getModel as jest.Mock).mockReturnValue(undefined);

    await bootstrapApp();

    expect(llmEngineService.load).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: null });
  });
});
