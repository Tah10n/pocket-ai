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

jest.mock('../../src/services/storage', () => ({
  getPrivateStorageHealthSnapshot: jest.fn(),
  initializePrivateStorageEncryption: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    validateRegistry: jest.fn().mockResolvedValue(undefined),
    getModel: jest.fn(),
  },
}));

jest.mock('../../src/store/downloadStore', () => ({
  getQueuedDownloadFileNames: jest.fn().mockReturnValue([]),
  useDownloadStore: {
    persist: {
      rehydrate: jest.fn().mockResolvedValue(undefined),
    },
  },
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    ensurePersistedCapabilitySnapshot: jest.fn().mockReturnValue(null),
    getState: jest.fn(),
    load: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/services/ModelDownloadManager', () => ({
  getModelDownloadManager: jest.fn(),
  resumeModelDownloadQueueIfStorageReady: jest.fn(),
}));

const mockStopPrivateRuntimeWorkForStorageBlocked = jest.fn();

jest.mock('../../src/services/PrivateStorageRecovery', () => ({
  stopPrivateRuntimeWorkForStorageBlocked: (...args: unknown[]) => mockStopPrivateRuntimeWorkForStorageBlocked(...args),
}));

const mockMergeImportedThreads = jest.fn();
const mockPruneExpiredThreads = jest.fn();

jest.mock('../../src/store/chatStore', () => ({
  useChatStore: {
    persist: {
      rehydrate: jest.fn().mockResolvedValue(undefined),
    },
    getState: () => ({
      mergeImportedThreads: mockMergeImportedThreads,
      pruneExpiredThreads: mockPruneExpiredThreads,
    }),
  },
}));

jest.mock('../../src/store/modelsStore', () => ({
  useModelsStore: {
    persist: {
      rehydrate: jest.fn().mockResolvedValue(undefined),
    },
  },
}));

import { bootstrapApp, bootstrapAppBackground, bootstrapAppCritical } from '../../src/services/AppBootstrap';
import { setupFileSystem } from '../../src/services/FileSystemSetup';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { getModelDownloadManager, resumeModelDownloadQueueIfStorageReady } from '../../src/services/ModelDownloadManager';
import { presetManager } from '../../src/services/PresetManager';
import { registry } from '../../src/services/LocalStorageRegistry';
import { clearLegacyChatHistory, getChatHistoryEntries, getSettings, updateSettings } from '../../src/services/SettingsStore';
import {
  getPrivateStorageHealthSnapshot,
  initializePrivateStorageEncryption,
  type PrivateStorageHealthSnapshot,
} from '../../src/services/storage';
import { useChatStore } from '../../src/store/chatStore';
import { getQueuedDownloadFileNames, useDownloadStore } from '../../src/store/downloadStore';
import { useModelsStore } from '../../src/store/modelsStore';
import * as FileSystem from 'expo-file-system/legacy';
import { EngineStatus } from '../../src/types/models';

function buildPrivateStorageHealth(
  overrides: Partial<PrivateStorageHealthSnapshot> = {},
): PrivateStorageHealthSnapshot {
  return {
    status: 'ready',
    retryable: false,
    requiresExplicitReset: false,
    lastUpdatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('AppBootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const readyStorageHealth = buildPrivateStorageHealth();
    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(readyStorageHealth);
    (initializePrivateStorageEncryption as jest.Mock).mockResolvedValue(readyStorageHealth);
    mockStopPrivateRuntimeWorkForStorageBlocked.mockResolvedValue(undefined);
    (useChatStore.persist.rehydrate as jest.Mock).mockResolvedValue(undefined);
    (useDownloadStore.persist.rehydrate as jest.Mock).mockResolvedValue(undefined);
    (useModelsStore.persist.rehydrate as jest.Mock).mockResolvedValue(undefined);
    mockMergeImportedThreads.mockReset();
    mockMergeImportedThreads.mockReturnValue(0);
    mockPruneExpiredThreads.mockReset();
    mockPruneExpiredThreads.mockReturnValue(0);

    (llmEngineService.getState as jest.Mock).mockReturnValue({
      status: EngineStatus.IDLE,
      activeModelId: undefined,
      loadProgress: 0,
      lastError: undefined,
    });
  });

  it('returns a storage-blocked critical outcome and skips hydration when private storage is already blocked', async () => {
    const blockedStorageHealth = {
      ...buildPrivateStorageHealth({
        status: 'blocked',
        reason: 'secure_key_unavailable',
        retryable: true,
        messageKey: 'storage.private.secureKeyUnavailable',
      }),
      errorMessage: 'raw secure-store failure',
    } as PrivateStorageHealthSnapshot & { errorMessage: string };

    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(blockedStorageHealth);

    const result = await bootstrapAppCritical();

    expect(result.outcome).toBe('storage_blocked');
    if (result.outcome !== 'storage_blocked') {
      throw new Error('Expected storage-blocked bootstrap result');
    }
    expect(result).toEqual({
      outcome: 'storage_blocked',
      storageHealth: {
        status: 'blocked',
        reason: 'secure_key_unavailable',
        retryable: true,
        requiresExplicitReset: false,
        messageKey: 'storage.private.secureKeyUnavailable',
        lastUpdatedAt: 1_700_000_000_000,
      },
    });
    expect(result.storageHealth).not.toHaveProperty('errorMessage');
    expect(initializePrivateStorageEncryption).not.toHaveBeenCalled();
    expect(useChatStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(useDownloadStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(useModelsStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(registry.getModel).not.toHaveBeenCalled();
  });

  it('returns a storage-blocked critical outcome and skips hydration when encryption initialization blocks', async () => {
    const blockedStorageHealth = buildPrivateStorageHealth({
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.encryptedOpenFailed',
    });

    (initializePrivateStorageEncryption as jest.Mock).mockResolvedValueOnce(blockedStorageHealth);

    const result = await bootstrapAppCritical();

    expect(result).toEqual({
      outcome: 'storage_blocked',
      storageHealth: blockedStorageHealth,
    });
    expect(initializePrivateStorageEncryption).toHaveBeenCalledTimes(1);
    expect(useChatStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(useDownloadStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(useModelsStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('returns a storage-blocked critical outcome and stops remaining hydration when private storage blocks during resolved hydration', async () => {
    const readyStorageHealth = buildPrivateStorageHealth();
    const blockedStorageHealth = buildPrivateStorageHealth({
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.encryptedOpenFailed',
    });

    (getPrivateStorageHealthSnapshot as jest.Mock)
      .mockReturnValueOnce(readyStorageHealth)
      .mockReturnValueOnce(blockedStorageHealth);
    (initializePrivateStorageEncryption as jest.Mock).mockResolvedValueOnce(readyStorageHealth);
    (useChatStore.persist.rehydrate as jest.Mock).mockResolvedValueOnce(undefined);

    const result = await bootstrapAppCritical();

    expect(result).toEqual({
      outcome: 'storage_blocked',
      storageHealth: blockedStorageHealth,
    });
    expect(useChatStore.persist.rehydrate).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(useModelsStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(registry.getModel).not.toHaveBeenCalled();
  });

  it('does not run background bootstrap work when private storage is blocked during full bootstrap', async () => {
    const blockedStorageHealth = buildPrivateStorageHealth({
      status: 'blocked',
      reason: 'secure_key_unavailable',
      retryable: true,
      messageKey: 'storage.private.secureKeyUnavailable',
    });

    (initializePrivateStorageEncryption as jest.Mock).mockResolvedValueOnce(blockedStorageHealth);

    await bootstrapApp();

    expect(useChatStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(useDownloadStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(useModelsStore.persist.rehydrate).not.toHaveBeenCalled();
    expect(setupFileSystem).not.toHaveBeenCalled();
    expect(getQueuedDownloadFileNames).not.toHaveBeenCalled();
    expect(registry.validateRegistry).not.toHaveBeenCalled();
    expect(presetManager.getPresets).not.toHaveBeenCalled();
    expect(mockMergeImportedThreads).not.toHaveBeenCalled();
    expect(getModelDownloadManager).not.toHaveBeenCalled();
  });

  it('does not run background bootstrap work while private storage health is blocked', async () => {
    const blockedStorageHealth = buildPrivateStorageHealth({
      status: 'blocked',
      reason: 'secure_key_unavailable',
      retryable: true,
      messageKey: 'storage.private.secureKeyUnavailable',
    });

    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(blockedStorageHealth);

    await expect(bootstrapAppBackground()).resolves.toEqual({
      outcome: 'storage_blocked',
      storageHealth: blockedStorageHealth,
    });

    expect(getSettings).not.toHaveBeenCalled();
    expect(setupFileSystem).not.toHaveBeenCalled();
    expect(getQueuedDownloadFileNames).not.toHaveBeenCalled();
    expect(registry.validateRegistry).not.toHaveBeenCalled();
    expect(presetManager.getPresets).not.toHaveBeenCalled();
    expect(mockMergeImportedThreads).not.toHaveBeenCalled();
    expect(getModelDownloadManager).not.toHaveBeenCalled();
  });

  it('returns a storage-blocked background outcome when private storage blocks during background work', async () => {
    const readyStorageHealth = buildPrivateStorageHealth();
    const blockedStorageHealth = buildPrivateStorageHealth({
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.encryptedOpenFailed',
    });

    (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(readyStorageHealth);
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
    (registry.validateRegistry as jest.Mock).mockImplementationOnce(() => {
      (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(blockedStorageHealth);
      throw new Error('registry private storage blocked');
    });

    await expect(bootstrapAppBackground()).resolves.toEqual({
      outcome: 'storage_blocked',
      storageHealth: blockedStorageHealth,
    });
    expect(presetManager.getPresets).not.toHaveBeenCalled();
    expect(mockMergeImportedThreads).not.toHaveBeenCalled();
    expect(mockStopPrivateRuntimeWorkForStorageBlocked).toHaveBeenCalledTimes(1);
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

      expect(llmEngineService.load).toHaveBeenCalledWith('author/model-q4', { preferLastWorkingProfile: true });
      expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not override a newer user-selected model when deferred bootstrap restore fires', async () => {
    jest.useFakeTimers();
    try {
      (getSettings as jest.Mock).mockReturnValue({
        language: 'en',
        activePresetId: null,
        activeModelId: 'author/model-a',
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 2048,
        theme: 'system',
        chatRetentionDays: null,
      });
      (registry.getModel as jest.Mock).mockReturnValue({
        id: 'author/model-a',
        localPath: 'author_model-a.gguf',
      });

      (llmEngineService.getState as jest.Mock).mockReturnValue({
        status: EngineStatus.INITIALIZING,
        activeModelId: 'author/model-b',
        loadProgress: 0.2,
      });

      await bootstrapAppCritical();
      jest.runAllTimers();
      await Promise.resolve();

      expect(llmEngineService.load).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips deferred bootstrap restore when engine is already ready with a different model', async () => {
    jest.useFakeTimers();
    try {
      (getSettings as jest.Mock).mockReturnValue({
        language: 'en',
        activePresetId: null,
        activeModelId: 'author/model-a',
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 2048,
        theme: 'system',
        chatRetentionDays: null,
      });
      (registry.getModel as jest.Mock).mockReturnValue({
        id: 'author/model-a',
        localPath: 'author_model-a.gguf',
      });

      (llmEngineService.getState as jest.Mock).mockReturnValue({
        status: EngineStatus.READY,
        activeModelId: 'author/model-b',
        loadProgress: 1,
      });

      await bootstrapAppCritical();
      jest.runAllTimers();
      await Promise.resolve();

      expect(llmEngineService.load).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips deferred bootstrap restore when settings activeModelId changed after scheduling', async () => {
    jest.useFakeTimers();
    try {
      (getSettings as jest.Mock)
        .mockReturnValueOnce({
          language: 'en',
          activePresetId: null,
          activeModelId: 'author/model-a',
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 2048,
          theme: 'system',
          chatRetentionDays: null,
        })
        .mockReturnValueOnce({
          language: 'en',
          activePresetId: null,
          activeModelId: 'author/model-b',
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 2048,
          theme: 'system',
          chatRetentionDays: null,
        });
      (registry.getModel as jest.Mock).mockReturnValue({
        id: 'author/model-a',
        localPath: 'author_model-a.gguf',
      });

      await bootstrapAppCritical();
      jest.runAllTimers();
      await Promise.resolve();

      expect(llmEngineService.load).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear the persisted active model during critical bootstrap when file validation fails', async () => {
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
      (FileSystem.getInfoAsync as jest.Mock).mockRejectedValueOnce(new Error('fs read failed'));

      await bootstrapAppCritical();
      jest.runAllTimers();
      await Promise.resolve();

      expect(llmEngineService.load).toHaveBeenCalledWith('author/model-q4', { preferLastWorkingProfile: true });
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

  it('clears the persisted active model during critical bootstrap when the active model file is missing on disk', async () => {
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
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: false });

    const result = await bootstrapAppCritical();

    expect(result.outcome).toBe('active_model_missing');
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

      expect(llmEngineService.load).toHaveBeenCalledWith('author/model-q4', { preferLastWorkingProfile: true });
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

    await expect(bootstrapAppBackground()).resolves.toEqual({ outcome: 'success' });

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
    const originalExpoOs = process.env.EXPO_OS;
    const originalJestWorkerId = process.env.JEST_WORKER_ID;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      (process.env as any).EXPO_OS = 'ios';
      delete (process.env as any).JEST_WORKER_ID;

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

      (resumeModelDownloadQueueIfStorageReady as unknown as jest.Mock).mockImplementation(() => {
        throw new Error('download manager init failed');
      });

      await expect(bootstrapAppBackground()).resolves.toEqual({ outcome: 'success' });

      expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(800);
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(
        '[bootstrapApp] Failed to warm modelDownloadManager',
        expect.any(Error),
      );
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      (process.env as any).EXPO_OS = originalExpoOs;
      (process.env as any).JEST_WORKER_ID = originalJestWorkerId;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('skips scheduled ModelDownloadManager warm-up if private storage blocks before it runs', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalExpoOs = process.env.EXPO_OS;
    const originalJestWorkerId = process.env.JEST_WORKER_ID;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const blockedStorageHealth = buildPrivateStorageHealth({
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.encryptedOpenFailed',
    });

    jest.useFakeTimers();

    try {
      (process.env as any).NODE_ENV = 'production';
      (process.env as any).EXPO_OS = 'ios';
      delete (process.env as any).JEST_WORKER_ID;

      globalThis.requestAnimationFrame = jest.fn((cb: any) => cb(0));
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

      await expect(bootstrapAppBackground()).resolves.toEqual({ outcome: 'success' });
      (getPrivateStorageHealthSnapshot as jest.Mock).mockReturnValue(blockedStorageHealth);

      jest.advanceTimersByTime(800);
      await Promise.resolve();

      expect(resumeModelDownloadQueueIfStorageReady).not.toHaveBeenCalled();
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      (process.env as any).EXPO_OS = originalExpoOs;
      (process.env as any).JEST_WORKER_ID = originalJestWorkerId;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      jest.useRealTimers();
    }
  });
});
