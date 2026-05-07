import { resetPrivateAppStorageAndRuntimeStateAfterConfirmation } from '../../src/services/PrivateStorageRecovery';
import { registry } from '../../src/services/LocalStorageRegistry';
import * as privateStorage from '../../src/services/storage';
import { getAppStorage } from '../../src/store/storage';
import { useChatStore } from '../../src/store/chatStore';
import { useDownloadStore } from '../../src/store/downloadStore';
import { useModelsStore } from '../../src/store/modelsStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

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
    expect(registry.hasAnyDownloadedModels()).toBe(true);
  });
});
