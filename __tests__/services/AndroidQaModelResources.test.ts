import type { ChatMessage, ChatThread, LlmChatCompletionOptions } from '../../src/types/chat';
import type { ModelMetadata } from '../../src/types/models';
import { ANDROID_QA_EMBEDDING_REPO, ANDROID_QA_EMBEDDING_SHA256, ANDROID_QA_EMBEDDING_SIZE,
  getAndroidQaModelResourcesEvidence, resetAndroidQaModelResourcesForTests,
  runAndroidQaModelResources } from '../../src/services/AndroidQaModelResources';

let mockModels: Record<string, ModelMetadata> = {};
let mockThreads: Record<string, ChatThread> = {};
let mockActiveThread: string | null = null;
let mockGeneration = 0;
let mockLoaded = false;
let mockAuxiliaryActive = false;
let mockFixtureExists = false;
const mockEvents: string[] = [];
const mockEnabled = jest.fn(() => true);
const mockBaseline = jest.fn(() => ({ status: 'passed' }));
let mockSettings: any = { activeModelId: 'qa-chat', modelLoadParamsByModelId: {}, auxiliaryModels: {} };
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({
  ANDROID_QA_DOCUMENT_MODEL_ID: 'qa-chat', ANDROID_QA_DOCUMENT_MODEL_SHA256: 'chat-digest',
  isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled(),
}));
jest.mock('../../src/services/AndroidQaInferenceSmoke', () => ({ getAndroidQaInferenceSmokeEvidence: () => mockBaseline() }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getModelsDir: () => 'file:///qa-models/' }));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn(async () => ({ exists: mockFixtureExists })) }));
const mockOffload = jest.fn(async (id: string) => {
  mockEvents.push('offload'); delete mockModels[id]; mockFixtureExists = false;
});
jest.mock('../../src/services/StorageManagerService', () => ({ offloadModel: (id: string) => mockOffload(id) }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  getModel: (id: string) => mockModels[id], updateModel: (model: ModelMetadata) => { mockModels[model.id] = model; },
} }));
const mockDownload = jest.fn((model: ModelMetadata) => {
  mockEvents.push('prepare');
  mockFixtureExists = true;
  mockModels[model.id] = { ...model, localPath: 'embedding.gguf', lifecycleStatus: 'downloaded',
    downloadIntegrity: { kind: 'sha256', sha256: model.sha256!, sizeBytes: model.size!, checkedAt: 1 } } as ModelMetadata;
});
const mockCancelDownload = jest.fn(async () => undefined);
jest.mock('../../src/store/downloadStore', () => ({ useDownloadStore: { getState: () => ({ queue: [], addToQueue: mockDownload }) } }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ getModelDownloadManager: () => ({ cancelDownload: mockCancelDownload }) }));
jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: () => mockSettings,
  updateSettings: (patch: object) => { mockSettings = { ...mockSettings, ...patch }; },
}));
const mockSelect = jest.fn((_role: string, model: ModelMetadata) => {
  mockEvents.push('select'); mockSettings.auxiliaryModels = { embedding: { modelId: model.id } };
});
const mockCheck = jest.fn(async () => {
  mockEvents.push('check'); mockGeneration += 1;
  return { operation: 'embedding', dimensions: 384, memoryConfidence: 'low' };
});
jest.mock('../../src/services/AuxiliaryModelService', () => ({
  checkAuxiliaryModel: (...args: unknown[]) => (mockCheck as any)(...args),
  selectAuxiliaryModel: (...args: unknown[]) => (mockSelect as any)(...args),
}));
const mockLoad = jest.fn(async () => { mockEvents.push('load'); mockLoaded = true; mockGeneration += 1; });
const mockCompletion = jest.fn(async (request: LlmChatCompletionOptions) => {
  mockEvents.push('generate'); request.onToken?.({ token: 'dog' });
  return { text: 'A friendly dog.', tokens_predicted: 4, tokens_evaluated: 12 };
});
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  load: (...args: unknown[]) => (mockLoad as any)(...args), chatCompletion: (request: LlmChatCompletionOptions) => mockCompletion(request),
  getContextSize: () => 512, getPromptContextIdentity: () => `context-${mockGeneration}`,
  hasActiveCompletion: () => false, hasAuxiliaryContextOperation: () => mockAuxiliaryActive,
  getState: () => ({ activeModelId: mockLoaded ? 'qa-chat' : undefined, status: mockLoaded ? 'ready' : 'idle',
    diagnostics: { backendMode: 'cpu', actualGpuAccelerated: false, loadedGpuLayers: 0,
      initNParallel: 1, stateCacheBudgetMb: 0, stateCacheMaxCheckpoints: 8 } }),
} }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({
  activeThreadId: mockActiveThread, threads: mockThreads,
  beginNewThread: () => { mockActiveThread = null; return true; },
  createThread: (input: Partial<ChatThread>) => {
    mockActiveThread = 'owned';
    mockThreads.owned = { ...input, id: 'owned', messages: [], createdAt: 1, updatedAt: 1, status: 'idle' } as ChatThread;
    return 'owned';
  },
  appendMessage: (id: string, message: ChatMessage) => { mockThreads[id].messages.push(message); },
  deleteThread: (id: string) => { delete mockThreads[id]; },
  setActiveThread: (id: string | null) => { mockActiveThread = id; },
}) } }));

describe('stage 2 Android scenario contract, separate from native proof', () => {
  beforeEach(() => {
    jest.clearAllMocks(); jest.useRealTimers(); resetAndroidQaModelResourcesForTests();
    mockEvents.length = 0; mockGeneration = 0; mockLoaded = false; mockAuxiliaryActive = false;
    mockFixtureExists = false;
    mockOffload.mockImplementation(async (id: string) => {
      mockEvents.push('offload'); delete mockModels[id]; mockFixtureExists = false;
    });
    mockThreads = {}; mockActiveThread = null;
    mockSettings = { activeModelId: 'qa-chat', modelLoadParamsByModelId: {}, auxiliaryModels: {} };
    mockModels = { 'qa-chat': { id: 'qa-chat', downloadIntegrity: { kind: 'sha256', sha256: 'chat-digest' } } as ModelMetadata };
    mockEnabled.mockReturnValue(true); mockBaseline.mockReturnValue({ status: 'passed' });
    mockCheck.mockImplementation(async () => { mockEvents.push('check'); mockGeneration += 1;
      return { operation: 'embedding', dimensions: 384, memoryConfidence: 'low' }; });
  });
  afterEach(() => jest.useRealTimers());
  it('prepares the pinned model using the download queue and invokes the production specialized check between real-token assertions', async () => {
    await runAndroidQaModelResources();
    expect(mockEvents).toEqual(['load', 'generate', 'prepare', 'select', 'check', 'generate', 'offload', 'generate']);
    expect(mockDownload).toHaveBeenCalledWith(expect.objectContaining({ id: ANDROID_QA_EMBEDDING_REPO,
      sha256: ANDROID_QA_EMBEDDING_SHA256, size: ANDROID_QA_EMBEDDING_SIZE }));
    expect(mockCheck).toHaveBeenCalledWith('embedding', expect.objectContaining({ verifyEmbedding: true }));
    expect(getAndroidQaModelResourcesEvidence()).toMatchObject({ status: 'passed', requiresForceStop: false });
    expect(getAndroidQaModelResourcesEvidence().steps.map(step => step.id)).toEqual([
      'cpu_load', 'generate_before', 'prepare_embedding', 'embedding_check', 'restore_chat', 'generate_after',
      'offload_unused_embedding', 'generate_after_offload', 'confirm_context_retained',
    ]);
    expect(JSON.stringify(getAndroidQaModelResourcesEvidence())).not.toMatch(/friendly dog|embedding.gguf|vector/);
    expect(mockSettings.auxiliaryModels).toEqual({});
    expect(mockThreads).toEqual({});
    expect(mockOffload).toHaveBeenCalledWith(ANDROID_QA_EMBEDDING_REPO);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
  it.each(['context', 'history', 'settings', 'file'] as const)('rejects incorrect offload %s evidence', async failure => {
    mockOffload.mockImplementation(async (id: string) => {
      delete mockModels[id]; mockFixtureExists = failure === 'file';
      if (failure === 'context') mockGeneration += 1;
      if (failure === 'history') mockThreads.owned.title = 'changed';
      if (failure === 'settings') mockSettings.activeModelId = 'changed';
    });
    await runAndroidQaModelResources();
    expect(getAndroidQaModelResourcesEvidence().status).toBe('failed');
    expect(mockCompletion).toHaveBeenCalledTimes(2);
  });
  it('rejects a hidden reload during the response following offload', async () => {
    mockCompletion.mockImplementationOnce(async request => {
      request.onToken?.({ token: 'dog' });
      return { text: 'A friendly dog.', tokens_predicted: 4, tokens_evaluated: 12 };
    }).mockImplementationOnce(async request => {
      request.onToken?.({ token: 'dog' });
      return { text: 'A friendly dog.', tokens_predicted: 4, tokens_evaluated: 12 };
    }).mockImplementationOnce(async request => {
      mockGeneration += 1; request.onToken?.({ token: 'dog' });
      return { text: 'A friendly dog.', tokens_predicted: 4, tokens_evaluated: 12 };
    });
    await runAndroidQaModelResources();
    expect(getAndroidQaModelResourcesEvidence()).toMatchObject({ status: 'failed', failureCode: 'context_changed_on_offload' });
  });
  it('rejects a delayed mutation of existing history during the response following offload', async () => {
    mockOffload.mockImplementation(async id => {
      delete mockModels[id]; mockFixtureExists = false;
      mockCompletion.mockImplementationOnce(async request => {
        mockThreads.owned.messages[0].content = 'changed';
        request.onToken?.({ token: 'dog' });
        return { text: 'A friendly dog.', tokens_predicted: 4, tokens_evaluated: 12 };
      });
    });
    await runAndroidQaModelResources();
    expect(getAndroidQaModelResourcesEvidence()).toMatchObject({ status: 'failed', failureCode: 'chat_changed' });
  });
  it('does not start unless the existing CPU smoke passed', async () => {
    mockBaseline.mockReturnValue({ status: 'failed' });
    await runAndroidQaModelResources();
    expect(getAndroidQaModelResourcesEvidence()).toMatchObject({ status: 'failed', failureCode: 'baseline_not_passed' });
    expect(mockLoad).not.toHaveBeenCalled();
  });
  it('stays inert outside the isolated QA build gate', async () => {
    mockEnabled.mockReturnValue(false);
    await runAndroidQaModelResources();
    expect(getAndroidQaModelResourcesEvidence().status).toBe('idle');
    expect(mockDownload).not.toHaveBeenCalled();
  });
  it.each(['dimensions', 'history', 'settings'] as const)('fails incorrect %s instead of claiming A-B-A passed', async failure => {
    mockCheck.mockImplementation(async () => {
      mockGeneration += 1;
      if (failure === 'history') mockThreads.owned.title = 'changed';
      if (failure === 'settings') mockSettings.activeModelId = 'changed';
      return { operation: 'embedding', dimensions: failure === 'dimensions' ? 0 : 384, memoryConfidence: 'low' };
    });
    await runAndroidQaModelResources();
    expect(getAndroidQaModelResourcesEvidence().status).toBe('failed');
    expect(mockCompletion).toHaveBeenCalledTimes(1);
  });
  it('does not continue native work or cleanup stores after uncertain auxiliary timeout', async () => {
    jest.useFakeTimers();
    mockCheck.mockImplementation(() => { mockAuxiliaryActive = true; return new Promise(() => undefined); });
    const pending = runAndroidQaModelResources({ operationTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(150);
    await pending;
    expect(getAndroidQaModelResourcesEvidence()).toMatchObject({ status: 'failed', failureCode: 'timeout', requiresForceStop: true });
    expect(mockThreads.owned).toBeDefined();
    expect(mockCompletion).toHaveBeenCalledTimes(1);
    await runAndroidQaModelResources();
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});
