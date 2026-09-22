import { applyModelLoraAdapters, buildLoraProfile } from '../../src/services/LoraConfigurationService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { hasActiveChatGenerationWork } from '../../src/services/ChatGenerationService';
import { getModelLoadParametersForModel, getSettingsStorage, resetSettings, subscribeSettings, updateSettings } from '../../src/services/SettingsStore';
import { useChatStore, flushPendingChatPersistenceWrites } from '../../src/store/chatStore';
import { getCompanionBindingIdentity } from '../../src/utils/modelArtifacts';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { LoraProfileAdapter } from '../../src/utils/advancedLoadProfile';

let mockModel: ModelMetadata;
const mockRegistryListeners = new Set<() => void>();
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  getModel: () => mockModel,
  subscribeModels: (listener: () => void) => { mockRegistryListeners.add(listener); return () => mockRegistryListeners.delete(listener); },
} }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: { applyLoraConfiguration: jest.fn() } }));
jest.mock('../../src/services/ChatGenerationService', () => ({ hasActiveChatGenerationWork: jest.fn(() => false) }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ runWithIdleModelDownloads: <T,>(operation: () => Promise<T>) => operation() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function createChat() {
  return useChatStore.getState().createThread({ modelId: mockModel.id, presetId: null,
    presetSnapshot: { id: null, name: 'Default', systemPrompt: '' },
    paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 512, seed: null }, loraSnapshot: [] });
}
const applyMock = jest.mocked(llmEngineService.applyLoraConfiguration);
const selection = [{ artifactId: 'adapter', scale: 0.5 }];

beforeEach(() => {
  jest.clearAllMocks();
  flushPendingChatPersistenceWrites('background');
  useChatStore.setState({ threads: {}, activeThreadId: null });
  getSettingsStorage().clearAll();
  resetSettings();
  mockModel = { id: 'test/base', name: 'Base', author: 'test', size: 1000,
    downloadUrl: 'https://example.test/base.gguf', hfRevision: 'base-rev', resolvedFileName: 'base.gguf',
    localPath: 'base.gguf', accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false,
    fitsInRam: true, lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1 };
  mockModel.artifacts = [{ id: 'adapter', kind: 'lora_adapter', requiredFor: [], selected: false,
    boundToModelIdentity: getCompanionBindingIdentity(mockModel), hfRevision: 'adapter-rev',
    remoteFileName: 'adapter.gguf', downloadUrl: 'https://example.test/adapter.gguf', sizeBytes: 64,
    localPath: 'adapter.gguf', installState: 'installed' }];
  updateSettings({ activeModelId: mockModel.id });
  jest.mocked(hasActiveChatGenerationWork).mockReturnValue(false);
});
afterEach(() => { expect(mockRegistryListeners.size).toBe(0); });

it('persists the native-confirmed list only after completion, preserving the other chat and old messages', async () => {
  const second = createChat();
  const first = createChat();
  const oldMessage = { id: 'reply', role: 'assistant' as const, content: 'Saved reply', createdAt: 1, state: 'complete' as const };
  useChatStore.setState(state => ({ threads: { ...state.threads, [first]: { ...state.threads[first], messages: [oldMessage] } } }));
  const pending = deferred<LoraProfileAdapter[]>();
  applyMock.mockReturnValueOnce(pending.promise);
  const operation = applyModelLoraAdapters(mockModel.id, selection);
  expect(getModelLoadParametersForModel(mockModel.id).loraAdapters).toBeUndefined();
  expect(useChatStore.getState().threads[first].loraSnapshot).toEqual([]);
  const confirmed = buildLoraProfile(mockModel.id, [{ artifactId: 'adapter', scale: 0 }]);
  pending.resolve(confirmed);
  await expect(operation).resolves.toEqual(confirmed);
  expect(getModelLoadParametersForModel(mockModel.id).loraAdapters).toEqual(confirmed);
  expect(useChatStore.getState().threads[first].loraSnapshot).toEqual(confirmed);
  expect(useChatStore.getState().threads[second].loraSnapshot).toEqual([]);
  expect(useChatStore.getState().threads[first].messages[0]).toBe(oldMessage);
});

it.each(['chat', 'variant', 'artifact', 'chat-round-trip'] as const)('rejects late completion after %s changes without persisting', async change => {
  const other = createChat();
  const original = createChat();
  const pending = deferred<LoraProfileAdapter[]>();
  const confirmed = buildLoraProfile(mockModel.id, selection);
  applyMock.mockReturnValueOnce(pending.promise);
  const operation = applyModelLoraAdapters(mockModel.id, selection);
  if (change === 'chat' || change === 'chat-round-trip') {
    useChatStore.setState({ activeThreadId: other });
    if (change === 'chat-round-trip') useChatStore.setState({ activeThreadId: original });
  } else {
    if (change === 'variant') mockModel = { ...mockModel, hfRevision: 'other-rev' };
    else mockModel.artifacts![0].localPath = 'replacement.gguf';
    mockRegistryListeners.forEach(listener => listener());
  }
  expect(applyMock.mock.calls[0][2]?.isCurrent?.()).toBe(false);
  pending.resolve(confirmed);
  await expect(operation).rejects.toMatchObject({ code: 'action_failed' });
  expect(getModelLoadParametersForModel(mockModel.id).loraAdapters).toBeUndefined();
  expect(useChatStore.getState().threads[original].loraSnapshot).toEqual([]);
  expect(useChatStore.getState().threads[other].loraSnapshot).toEqual([]);
});

it('keeps prior persistence after native failure and masks private native error text', async () => {
  const chat = createChat();
  const original = buildLoraProfile(mockModel.id, selection);
  applyMock.mockResolvedValueOnce(original);
  await applyModelLoraAdapters(mockModel.id, selection);
  applyMock.mockRejectedValueOnce(new Error('/private/user/adapter.gguf failed after first adapter'));
  await expect(applyModelLoraAdapters(mockModel.id, [])).rejects.toMatchObject({ code: 'model_incompatible', message: 'The adapters could not be applied.' });
  expect(getModelLoadParametersForModel(mockModel.id).loraAdapters).toEqual(original);
  expect(useChatStore.getState().threads[chat].loraSnapshot).toEqual(original);
});

it('never assigns the confirmed result to a different chat opened by a synchronous settings subscriber', async () => {
  const other = createChat();
  createChat();
  const confirmed = buildLoraProfile(mockModel.id, selection);
  const unsubscribe = subscribeSettings(settings => {
    if (settings.modelLoadParamsByModelId[mockModel.id]?.loraAdapters?.length) {
      useChatStore.setState({ activeThreadId: other });
    }
  });
  try {
    applyMock.mockResolvedValueOnce(confirmed);
    await applyModelLoraAdapters(mockModel.id, selection).catch(() => undefined);
    expect(useChatStore.getState().threads[other].loraSnapshot).toEqual([]);
  } finally { unsubscribe(); }
});

it('does not persist a late success after abort and never treats cancellation as native completion', async () => {
  createChat();
  const pending = deferred<LoraProfileAdapter[]>();
  const controller = new AbortController();
  applyMock.mockReturnValueOnce(pending.promise);
  const operation = applyModelLoraAdapters(mockModel.id, selection, controller.signal);
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  pending.resolve(buildLoraProfile(mockModel.id, selection));
  await expect(operation).rejects.toMatchObject({ code: 'action_failed' });
  expect(getModelLoadParametersForModel(mockModel.id).loraAdapters).toBeUndefined();
});

it('blocks generation overlap before native and rejects unmanaged or duplicate adapter references', async () => {
  jest.mocked(hasActiveChatGenerationWork).mockReturnValue(true);
  await expect(applyModelLoraAdapters(mockModel.id, selection)).rejects.toMatchObject({ code: 'engine_busy' });
  expect(applyMock).not.toHaveBeenCalled();
  expect(() => buildLoraProfile(mockModel.id, [...selection, ...selection])).toThrow();
  expect(() => buildLoraProfile(mockModel.id, [{ artifactId: '/private/arbitrary.gguf', scale: 1 }])).toThrow();
});
