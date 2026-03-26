jest.mock('../../src/store/chatStore', () => ({
  useChatStore: {
    getState: jest.fn(),
  },
}));

jest.mock('../../src/store/storage', () => ({
  storage: {
    getString: jest.fn(),
  },
}));

jest.mock('../../src/services/FileSystemSetup', () => ({
  CACHE_DIR: 'test-cache/',
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    getState: jest.fn().mockReturnValue({ activeModelId: null }),
    getContextSize: jest.fn().mockReturnValue(2048),
    interruptActiveCompletion: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModels: jest.fn().mockReturnValue([]),
    getModel: jest.fn(),
    removeModel: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  CHAT_HISTORY_INDEX_KEY: 'chat_history_index',
  CHAT_HISTORY_PREFIX: 'chat_history_',
  SETTINGS_KEY: 'app_settings',
  clearLegacyChatHistory: jest.fn(),
  resetSettings: jest.fn(),
  storage: {
    getAllKeys: jest.fn().mockReturnValue([]),
    getString: jest.fn(),
  },
}));

import { clearChatHistory } from '../../src/services/StorageManagerService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { clearLegacyChatHistory } from '../../src/services/SettingsStore';
import { useChatStore } from '../../src/store/chatStore';

describe('StorageManagerService', () => {
  const mockClearAllThreads = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockClearAllThreads.mockReturnValue(2);
    (clearLegacyChatHistory as jest.Mock).mockReturnValue(3);
    (useChatStore.getState as jest.Mock).mockReturnValue({
      clearAllThreads: mockClearAllThreads,
    });
  });

  it('interrupts active completions before clearing persisted chat history', async () => {
    await expect(clearChatHistory()).resolves.toBe(5);

    expect(llmEngineService.interruptActiveCompletion).toHaveBeenCalledTimes(1);
    expect(mockClearAllThreads).toHaveBeenCalledTimes(1);
    expect(clearLegacyChatHistory).toHaveBeenCalledTimes(1);
    expect(
      (llmEngineService.interruptActiveCompletion as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(mockClearAllThreads.mock.invocationCallOrder[0]);
  });
});
