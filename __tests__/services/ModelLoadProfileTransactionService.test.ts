import { applyActiveModelLoadProfile, captureModelProfileSelection } from '../../src/services/ModelLoadProfileTransactionService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { hasActiveChatGenerationWork } from '../../src/services/ChatGenerationService';
import { getModelLoadParametersForModel, getSettingsStorage, resetSettings, updateModelLoadParametersForModel,
  updateSettings, type ModelLoadParameters } from '../../src/services/SettingsStore';
import { useChatStore, flushPendingChatPersistenceWrites } from '../../src/store/chatStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

let mockModel: ModelMetadata;
const mockRegistryListeners = new Set<() => void>();
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  getModel: () => mockModel,
  subscribeModels: (listener: () => void) => { mockRegistryListeners.add(listener); return () => mockRegistryListeners.delete(listener); },
} }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: { applyLoadProfileTransaction: jest.fn() } }));
jest.mock('../../src/services/ChatGenerationService', () => ({ hasActiveChatGenerationWork: jest.fn(() => false) }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ runWithIdleModelDownloads: <T,>(operation: () => Promise<T>) => operation() }));

const requested: ModelLoadParameters = { contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16', cacheTypeK: 'q8_0' };
const applyMock = jest.mocked(llmEngineService.applyLoadProfileTransaction);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function createChat() {
  return useChatStore.getState().createThread({ modelId: mockModel.id, presetId: null,
    presetSnapshot: { id: null, name: 'Default', systemPrompt: '' },
    paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 512, seed: null } });
}
beforeEach(() => {
  jest.clearAllMocks();
  flushPendingChatPersistenceWrites('background');
  useChatStore.setState({ threads: {}, activeThreadId: null });
  getSettingsStorage().clearAll(); resetSettings();
  mockModel = { id: 'test/base', name: 'Base', author: 'test', size: 1000,
    downloadUrl: 'https://example.test/base.gguf', hfRevision: 'base-rev', resolvedFileName: 'base.gguf',
    localPath: 'base.gguf', accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false,
    fitsInRam: true, lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1 };
  updateSettings({ activeModelId: mockModel.id });
  jest.mocked(hasActiveChatGenerationWork).mockReturnValue(false);
});
afterEach(() => { expect(mockRegistryListeners.size).toBe(0); });

it('allows persistence only after confirmed native completion for the original selection', async () => {
  createChat();
  const before = getModelLoadParametersForModel(mockModel.id);
  const pending = deferred<ModelLoadParameters>();
  applyMock.mockReturnValueOnce(pending.promise);
  const operation = applyActiveModelLoadProfile(mockModel.id, { loadParamsOverride: requested }, captureModelProfileSelection(mockModel.id))
    .then(() => updateModelLoadParametersForModel(mockModel.id, requested));
  expect(getModelLoadParametersForModel(mockModel.id)).toEqual(before);
  expect(applyMock.mock.calls[0][2]()).toBe(true);
  pending.resolve(requested); await operation;
  expect(getModelLoadParametersForModel(mockModel.id)).toEqual(requested);
});

it.each(['chat', 'chat-round-trip', 'variant', 'active-model'] as const)(
  'rejects late native success after %s changes without publishing a persistence receipt', async change => {
    const other = createChat(); const original = createChat();
    const before = getModelLoadParametersForModel(mockModel.id);
    const pending = deferred<ModelLoadParameters>();
    applyMock.mockReturnValueOnce(pending.promise);
    const operation = applyActiveModelLoadProfile(mockModel.id, { loadParamsOverride: requested }, captureModelProfileSelection(mockModel.id))
      .then(() => updateModelLoadParametersForModel(mockModel.id, requested));
    if (change === 'chat' || change === 'chat-round-trip') {
      useChatStore.setState({ activeThreadId: other });
      if (change === 'chat-round-trip') useChatStore.setState({ activeThreadId: original });
    } else if (change === 'variant') {
      mockModel = { ...mockModel, hfRevision: 'replacement-revision' };
      mockRegistryListeners.forEach(listener => listener());
    } else updateSettings({ activeModelId: 'other/model' });
    expect(applyMock.mock.calls[0][2]()).toBe(false);
    pending.resolve(requested);
    await expect(operation).rejects.toMatchObject({ code: 'engine_busy' });
    expect(getModelLoadParametersForModel(mockModel.id)).toEqual(before);
  },
);

it('rejects a synchronous READY subscriber switch after the final engine guard', async () => {
  const other = createChat(); createChat();
  const before = getModelLoadParametersForModel(mockModel.id);
  applyMock.mockImplementationOnce(async (_modelId, _options, isCurrent) => {
    expect(isCurrent()).toBe(true);
    // Engine READY notification dispatches synchronously after its final check.
    useChatStore.setState({ activeThreadId: other });
    return requested;
  });
  const operation = applyActiveModelLoadProfile(mockModel.id, { loadParamsOverride: requested }, captureModelProfileSelection(mockModel.id))
    .then(() => updateModelLoadParametersForModel(mockModel.id, requested));
  await expect(operation).rejects.toMatchObject({ code: 'engine_busy' });
  expect(getModelLoadParametersForModel(mockModel.id)).toEqual(before);
});

it('rejects a stale delayed retry before calling native and retains generation exclusion', async () => {
  const other = createChat(); createChat();
  const isCurrent = captureModelProfileSelection(mockModel.id);
  useChatStore.setState({ activeThreadId: other });
  await expect(applyActiveModelLoadProfile(mockModel.id, {}, isCurrent)).rejects.toMatchObject({ code: 'engine_busy' });
  expect(applyMock).not.toHaveBeenCalled();
  jest.mocked(hasActiveChatGenerationWork).mockReturnValue(true);
  await expect(applyActiveModelLoadProfile(mockModel.id, {}, captureModelProfileSelection(mockModel.id))).rejects.toMatchObject({ code: 'engine_busy' });
  expect(applyMock).not.toHaveBeenCalled();
});
