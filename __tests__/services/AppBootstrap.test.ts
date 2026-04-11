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
  getModelsDir: jest.fn().mockReturnValue('test-dir/models/'),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    validateRegistry: jest.fn().mockResolvedValue(undefined),
    getModel: jest.fn(),
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

jest.mock('../../src/services/ModelDownloadManager', () => ({
  getModelDownloadManager: jest.fn(),
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

import { bootstrapApp, bootstrapAppBackground, bootstrapAppCritical } from '../../src/services/AppBootstrap';
import { setupFileSystem } from '../../src/services/FileSystemSetup';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { getModelDownloadManager } from '../../src/services/ModelDownloadManager';
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

  it('restores the persisted active model during critical bootstrap when the file is still available', async () => {
    jest.useFakeTimers();
    try {
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

      await bootstrapAppCritical();
      jest.runAllTimers();
      await Promise.resolve();

      expect(llmEngineService.load).toHaveBeenCalledWith('author/model-q4');
      expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the persisted active model during critical bootstrap when the file is missing', async () => {
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

    await bootstrapAppCritical();

    expect(llmEngineService.load).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: null });
  });

  it('restores medium-confidence likely_oom active models during critical bootstrap', async () => {
    jest.useFakeTimers();
    try {
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
        memoryFitDecision: 'likely_oom',
        memoryFitConfidence: 'medium',
      });

      await bootstrapAppCritical();
      jest.runAllTimers();
      await Promise.resolve();

      expect(llmEngineService.load).toHaveBeenCalledWith('author/model-q4');
      expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears high-confidence likely_oom active models during critical bootstrap', async () => {
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
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
    });

    const result = await bootstrapAppCritical();

    expect(result.outcome).toBe('active_model_blocked');
    expect(llmEngineService.load).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: null });
  });

  it('does not block critical bootstrap on infrastructure setup', async () => {
    (getSettings as jest.Mock).mockReturnValue({
      language: 'en',
      activePresetId: null,
      activeModelId: null,
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      theme: 'system',
      chatRetentionDays: null,
    });

    await bootstrapAppCritical();

    expect(setupFileSystem).not.toHaveBeenCalled();
    expect(registry.validateRegistry).not.toHaveBeenCalled();
  });

  it('migrates legacy chat history entries into the thread store during background bootstrap', async () => {
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

    await bootstrapAppBackground();

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

  it('runs critical bootstrap before background bootstrap', async () => {
    const callOrder: string[] = [];
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

    (registry.getModel as jest.Mock).mockImplementation(() => {
      callOrder.push('critical');
      return { id: 'author/model-q4', localPath: 'author_model-q4.gguf' };
    });

    (setupFileSystem as jest.Mock).mockImplementation(async () => {
      callOrder.push('background');
    });

    await bootstrapApp();

    expect(callOrder[0]).toBe('critical');
    expect(callOrder).toContain('background');
  });

  it('surfaces background bootstrap failures so the UI can display initialization errors', async () => {
    (getSettings as jest.Mock).mockReturnValue({
      language: 'en',
      activePresetId: null,
      activeModelId: null,
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      theme: 'system',
      chatRetentionDays: null,
    });

    (setupFileSystem as jest.Mock).mockRejectedValueOnce(new Error('filesystem failed'));

    await expect(bootstrapAppBackground()).rejects.toThrow('Background bootstrap encountered errors');
    expect(registry.validateRegistry).toHaveBeenCalled();
  });

  it('does not fail background bootstrap when warming ModelDownloadManager fails outside tests', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';

      const requestAnimationFrameMock = jest.fn((cb: any) => cb(0));
      globalThis.requestAnimationFrame = requestAnimationFrameMock;

      (getSettings as jest.Mock).mockReturnValue({
        language: 'en',
        activePresetId: null,
        activeModelId: null,
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 2048,
        theme: 'system',
        chatRetentionDays: null,
      });

      (getModelDownloadManager as unknown as jest.Mock).mockImplementation(() => {
        throw new Error('download manager init failed');
      });

      await expect(bootstrapAppBackground()).resolves.toBeUndefined();

      expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(800);
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(
        '[bootstrapApp] Failed to warm modelDownloadManager',
        expect.any(Error),
      );
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
