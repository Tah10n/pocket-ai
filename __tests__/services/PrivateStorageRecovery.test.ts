import { resetPrivateAppStorageAndRuntimeStateAfterConfirmation } from '../../src/services/PrivateStorageRecovery';
import { registry } from '../../src/services/LocalStorageRegistry';
import * as privateStorage from '../../src/services/storage';
import { getPrivateStorageHealthSnapshot } from '../../src/services/storage';
import { getAppStorage } from '../../src/store/storage';
import { useChatStore } from '../../src/store/chatStore';
import { useDownloadStore } from '../../src/store/downloadStore';
import { useModelsStore } from '../../src/store/modelsStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { chatAttachmentStorageService } from '../../src/services/ChatAttachmentStorageService';
import * as chatSession from '../../src/hooks/useChatSession';

jest.mock('expo-secure-store', () => ({
  isAvailableAsync: jest.fn(async () => true),
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

function createModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'author/model-q4',
    name: 'Model Q4',
    author: 'author',
    size: 1024,
    downloadUrl: 'https://example.com/model.gguf',
    resolvedFileName: 'model.gguf',
    localPath: 'model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
    ...overrides,
  };
}

describe('PrivateStorageRecovery', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(registry, 'preserveExistingModelFilesForPrivateStorageReset').mockResolvedValue([]);
    jest.spyOn(chatAttachmentStorageService, 'deleteAllAttachmentFilesForPrivateStorageReset').mockResolvedValue(undefined);
    useChatStore.setState({ threads: {}, activeThreadId: null });
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
    useModelsStore.setState({
      tabPreferences: {
        all: {
          filters: { fitsInRamOnly: false, noTokenRequiredOnly: false, sizeRanges: [] },
          sort: { field: 'name', direction: 'asc' },
          discoveryMode: 'uninitialized',
        },
        downloaded: {
          filters: { fitsInRamOnly: false, noTokenRequiredOnly: false, sizeRanges: [] },
          sort: { field: 'name', direction: 'asc' },
          discoveryMode: 'full',
        },
      },
    });
    registry.invalidatePrivateStorageRuntimeState();
  });

  it('clears cached private handles and in-memory private persisted state after explicit reset', async () => {
    const preResetAppStorage = getAppStorage();
    preResetAppStorage.set('stale-private-key', 'stale-value');

    useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: { id: 'default', name: 'Default', systemPrompt: 'Be helpful.' },
      paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 128, seed: null },
    });
    useDownloadStore.getState().addToQueue(createModel());
    useModelsStore.getState().setFitsInRamOnly('all', true);
    registry.saveModels([createModel()]);

    await expect(resetPrivateAppStorageAndRuntimeStateAfterConfirmation()).resolves.toEqual(expect.objectContaining({
      status: 'ready',
    }));

    const postResetAppStorage = getAppStorage();
    expect(postResetAppStorage).not.toBe(preResetAppStorage);
    expect(postResetAppStorage.getString('stale-private-key')).toBeUndefined();
    expect(useChatStore.getState().getConversationIndex()).toEqual([]);
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([]);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useModelsStore.getState().tabPreferences.all.filters.fitsInRamOnly).toBe(false);
    expect(useModelsStore.getState().tabPreferences.all.discoveryMode).toBe('uninitialized');
    expect(registry.preserveExistingModelFilesForPrivateStorageReset).toHaveBeenCalledTimes(1);
    expect(chatAttachmentStorageService.deleteAllAttachmentFilesForPrivateStorageReset).toHaveBeenCalledTimes(1);
    expect(registry.getModels()).toEqual([]);
  });

  it('preserves the registry cache when the destructive reset remains blocked', async () => {
    jest.spyOn(privateStorage, 'resetPrivateAppStorageAfterConfirmation').mockResolvedValueOnce({
      status: 'blocked',
      reason: 'reset_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.resetFailed',
      lastUpdatedAt: 1,
    });
    const cachedModel = createModel();
    registry.saveModels([cachedModel]);

    await expect(resetPrivateAppStorageAndRuntimeStateAfterConfirmation()).resolves.toEqual(expect.objectContaining({
      status: 'blocked',
      reason: 'reset_failed',
    }));

    expect(registry.getModels()).toEqual([expect.objectContaining({
      id: cachedModel.id,
      localPath: cachedModel.localPath,
    })]);
    expect(registry.preserveExistingModelFilesForPrivateStorageReset).toHaveBeenCalledTimes(1);
    expect(chatAttachmentStorageService.deleteAllAttachmentFilesForPrivateStorageReset).not.toHaveBeenCalled();
    expect(registry.hasAnyDownloadedModels()).toBe(true);
  });

  it('continues a confirmed reset after chat stop and discards the retained generation controller', async () => {
    const stopChatSpy = jest
      .spyOn(chatSession, 'stopActiveChatGenerationForPrivateStorageBlocked')
      .mockResolvedValue(undefined);
    const resetChatRuntimeSpy = jest
      .spyOn(chatSession, 'resetActiveChatGenerationRuntimeForPrivateStorageReset')
      .mockImplementation(() => undefined);
    const resetStorageSpy = jest.spyOn(privateStorage, 'resetPrivateAppStorageAfterConfirmation');

    await expect(resetPrivateAppStorageAndRuntimeStateAfterConfirmation()).resolves.toEqual(
      expect.objectContaining({ status: 'ready' }),
    );

    expect(stopChatSpy).toHaveBeenCalledTimes(1);
    expect(resetStorageSpy).toHaveBeenCalledTimes(1);
    expect(resetChatRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(stopChatSpy.mock.invocationCallOrder[0]).toBeLessThan(
      resetStorageSpy.mock.invocationCallOrder[0],
    );
    expect(resetStorageSpy.mock.invocationCallOrder[0]).toBeLessThan(
      resetChatRuntimeSpy.mock.invocationCallOrder[0],
    );
  });

  it('returns blocked reset health when chat attachment cleanup fails after private storage reset', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(chatAttachmentStorageService, 'deleteAllAttachmentFilesForPrivateStorageReset')
      .mockRejectedValueOnce(new Error('secret file:///private/chat-attachments/delete-me.jpg'));
    useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: { id: 'default', name: 'Default', systemPrompt: 'Be helpful.' },
      paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 128, seed: null },
    });
    useDownloadStore.getState().addToQueue(createModel());
    registry.saveModels([createModel()]);

    await expect(resetPrivateAppStorageAndRuntimeStateAfterConfirmation()).resolves.toEqual(expect.objectContaining({
      status: 'blocked',
      reason: 'reset_failed',
      retryable: true,
      requiresExplicitReset: true,
      messageKey: 'storage.private.resetFailed',
    }));

    expect(chatAttachmentStorageService.deleteAllAttachmentFilesForPrivateStorageReset).toHaveBeenCalledTimes(1);
    expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: 'reset_failed',
      requiresExplicitReset: true,
    }));
    expect(useChatStore.getState().getConversationIndex()).toEqual([]);
    expect(useDownloadStore.getState().queue).toEqual([]);
    expect(registry.getModels()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[PrivateStorageRecovery] Failed to clean chat attachments during private storage reset',
      expect.objectContaining({
        pathCategory: 'chat_attachment',
        context: 'private_storage_reset_attachment_cleanup',
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('file:///private/chat-attachments/delete-me.jpg');
    warnSpy.mockRestore();
  });
});
