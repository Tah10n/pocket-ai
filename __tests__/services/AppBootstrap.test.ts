jest.mock('i18next', () => {
  const mockI18nInstance = {
    language: 'en',
    use: jest.fn().mockReturnThis(),
    init: jest.fn().mockResolvedValue(undefined),
    changeLanguage: jest.fn().mockResolvedValue(undefined),
  };

  return {
    __esModule: true,
    createInstance: jest.fn(() => mockI18nInstance),
  };
});

jest.mock('../../src/services/PresetManager', () => ({
  presetManager: {
    getPresets: jest.fn(),
    getPreset: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  clearLegacyChatHistory: jest.fn(),
  getChatHistoryEntries: jest.fn().mockReturnValue([]),
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

const mockMergeImportedThreads = jest.fn();
const mockPruneExpiredThreads = jest.fn();

jest.mock('../../src/store/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      mergeImportedThreads: mockMergeImportedThreads,
      pruneExpiredThreads: mockPruneExpiredThreads,
    }),
  },
}));

import { bootstrapApp } from '../../src/services/AppBootstrap';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { clearLegacyChatHistory, getChatHistoryEntries, getSettings, updateSettings } from '../../src/services/SettingsStore';

describe('AppBootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMergeImportedThreads.mockReset();
    mockMergeImportedThreads.mockReturnValue(0);
    mockPruneExpiredThreads.mockReset();
    mockPruneExpiredThreads.mockReturnValue(0);
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
      chatRetentionDays: null,
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
      chatRetentionDays: null,
    });
    (registry.getModel as jest.Mock).mockReturnValue(undefined);

    await bootstrapApp();

    expect(llmEngineService.load).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: null });
  });

  it('migrates legacy chat history entries into the thread store during bootstrap', async () => {
    (getSettings as jest.Mock).mockReturnValue({
      language: 'en',
      activePresetId: null,
      activeModelId: null,
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      theme: 'system',
      chatRetentionDays: 90,
    });
    (getChatHistoryEntries as jest.Mock).mockReturnValue([
      {
        id: 'chat-1',
        messages: [
          { role: 'user', content: 'Legacy prompt' },
          { role: 'assistant', content: 'Legacy reply' },
        ],
        modelId: 'author/model-q4',
        presetId: null,
        createdAt: 10,
        updatedAt: 20,
      },
    ]);

    await bootstrapApp();

    expect(mockMergeImportedThreads).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'chat-1',
        modelId: 'author/model-q4',
        title: 'Legacy prompt',
        messages: [
          expect.objectContaining({ role: 'user', content: 'Legacy prompt' }),
          expect.objectContaining({ role: 'assistant', content: 'Legacy reply' }),
        ],
      }),
    ]);
    expect(clearLegacyChatHistory).toHaveBeenCalled();
    expect(mockPruneExpiredThreads).toHaveBeenCalledWith(90);
  });
});
