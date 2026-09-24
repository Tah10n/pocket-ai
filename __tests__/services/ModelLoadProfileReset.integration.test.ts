import { act, renderHook } from '@testing-library/react-native';
import { initLlama } from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import { useModelParametersSheetController } from '../../src/hooks/useModelParametersSheetController';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { DEFAULT_MODEL_LOAD_PARAMETERS, getModelLoadParametersForModel, getSettingsStorage, resetSettings,
  updateModelLoadParametersForModel, updateSettings, resetSettingsRuntimeForPrivateStorageReset } from '../../src/services/SettingsStore';
import { resolveLoraProfileForLoad } from '../../src/services/LoraProfileResolver';
import { useChatStore, flushPendingChatPersistenceWrites } from '../../src/store/chatStore';
import type { ModelMetadata } from '../../src/types/models';
jest.mock('../../src/services/ChatGenerationService', () => ({ hasActiveChatGenerationWork: () => false }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ runWithIdleModelDownloads: (run: () => unknown) => run() }));
jest.mock('../../src/services/ModelCatalogService', () => ({ modelCatalogService: { refreshModelMetadata: async (model: unknown) => model } }));
jest.mock('../../src/services/SystemMetricsService', () => ({ getFreshMemorySnapshot: async () => null }));
jest.mock('../../src/services/LoraProfileResolver', () => ({ resolveLoraProfileForLoad: jest.fn() }));
jest.mock('react-native-device-info', () => ({ getTotalMemory: async () => 8 * 1024 ** 3,
  getModel: () => 'Test', supportedAbis: async () => ['arm64-v8a'], getBuildId: async () => 'test' }));
jest.mock('llama.rn', () => ({
  initLlama: jest.fn(), releaseAllLlama: jest.fn(async () => undefined),
  toggleNativeLog: jest.fn(async () => undefined), addNativeLogListener: jest.fn(() => ({ remove: jest.fn() })),
  loadLlamaModelInfo: jest.fn(async () => ({ 'general.architecture': 'llama', 'general.type': 'model',
    'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.embedding_length': 4096 })),
  getBackendDevicesInfo: jest.fn(async () => []), BuildInfo: { number: 'test', commit: 'test' },
}));
const model = { id: 'reset/model', name: 'Reset test', localPath: 'reset.gguf', lifecycleStatus: 'downloaded',
  thinkingCapability: { detectedAt: 1, supportsThinking: false, canDisableThinking: true } } as ModelMetadata;
const adapters = [{ artifactId: 'adapter', artifactIdentity: 'source', baseModelIdentity: 'base', scale: 0.5, sizeBytes: 1024 }];
const advanced = { cacheTypeK: 'f32' as const, cacheTypeV: 'f16' as const, ropeFreqBase: 10000, ropeFreqScale: 0.5,
  noExtraBufts: true, swaFull: false, nCpuMoe: 0, specDraftNMax: 5, specDraftNMin: 0, specDraftPMin: 0,
  specDraftPSplit: 0, specDraftNGpuLayers: 0, specDraftCacheTypeK: 'f16' as const, specDraftCacheTypeV: 'f16' as const,
  cpuThreads: 2, cpuStrict: true, useMmap: false, useMlock: false, nBatch: 64, nUbatch: 32, loraAdapters: adapters };
const showError = jest.fn();
beforeEach(async () => {
  jest.clearAllMocks();
  flushPendingChatPersistenceWrites('background');
  useChatStore.setState({ threads: {}, activeThreadId: null });
  getSettingsStorage().clearAll(); resetSettings();
  jest.spyOn(registry, 'getModel').mockImplementation(id => id === model.id ? model : undefined);
  jest.spyOn(registry, 'updateModel').mockImplementation(() => undefined);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: true, size: 1024 } as any);
  jest.mocked(resolveLoraProfileForLoad).mockImplementation(async (_model, selected) => ({
    profile: [...(selected ?? [])], adapters: (selected ?? []).map(a => ({ path: '/models/adapter.gguf', scaled: a.scale })), sizeBytes: selected?.length ? 1024 : 0,
  }));
  jest.mocked(initLlama).mockImplementation(async params => ({
    model: { metadata: { 'general.architecture': 'qwen2', 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.pre': 'qwen2' } },
    completion: jest.fn(async () => ({ text: 'ok' })), getFormattedChat: jest.fn(async () => ({ prompt: 'prompt', additional_stops: [] })),
    tokenize: jest.fn(async () => ({ tokens: [] })), release: jest.fn(async () => undefined), stopCompletion: jest.fn(async () => undefined),
    getLoadedLoraAdapters: jest.fn(async () => params.lora_list ?? []), gpu: false, devices: [], reasonNoGPU: 'GPU disabled',
  } as any));
  updateSettings({ activeModelId: model.id });
  updateModelLoadParametersForModel(model.id, { contextSize: 4096, gpuLayers: 0, kvCacheType: 'f16', ...advanced });
  await llmEngineService.load(model.id);
});
afterEach(async () => { await llmEngineService.unload(); jest.restoreAllMocks(); });
it.each([false, true])('Reset all then basic edit=%s replaces native and persisted profiles', async edit => {
  const { result } = renderHook(() => useModelParametersSheetController({
    getModelById: () => model, showError, applyReloadErrorScope: 'test', activeModelId: model.id,
  }));
  await act(async () => { result.current.openModelParameters(model.id); });
  await act(async () => { result.current.sheetProps.onReset(); });
  if (edit) await act(async () => { result.current.sheetProps.onChangeLoadParams({ contextSize: 2048 }); });
  await act(async () => { await result.current.sheetProps.onApplyReload(); });
  expect(showError).not.toHaveBeenCalled();
  const calls = jest.mocked(initLlama).mock.calls;
  const lastInit = calls[calls.length - 1][0];
  expect(lastInit.rope_freq_scale).toBeUndefined();
  expect(lastInit.cache_type_k).not.toBe('f32');
  expect(lastInit.lora_list ?? []).toEqual([]);
  expect(getModelLoadParametersForModel(model.id)).toEqual({ ...DEFAULT_MODEL_LOAD_PARAMETERS, contextSize: edit ? 2048 : 4096 });
  expect(llmEngineService.getEffectiveLoadParameters()?.ropeFreqScale).toBeUndefined();
  expect(llmEngineService.getState().diagnostics?.requestedAdvancedLoad).toEqual({});
  await act(async () => { result.current.closeModelParameters(); });
  await act(async () => { result.current.openModelParameters(model.id); });
  expect(result.current.sheetProps.loadParamsDraft.ropeFreqScale).toBeUndefined();
  await act(async () => { await llmEngineService.unload(); resetSettingsRuntimeForPrivateStorageReset(); });
  expect(getModelLoadParametersForModel(model.id)).toEqual({ ...DEFAULT_MODEL_LOAD_PARAMETERS, contextSize: edit ? 2048 : 4096 });
  await act(async () => { await llmEngineService.load(model.id); });
  expect(jest.mocked(initLlama).mock.calls.slice(-1)[0][0].rope_freq_scale).toBeUndefined();
});

it('preserves ordinary patches including false, zero and empty lists, and clears explicit undefined', async () => {
  await llmEngineService.applyLoadProfileTransaction(model.id, { loadParamsOverride: { contextSize: 2048,
    noExtraBufts: false, ropeFreqBase: 0, loraAdapters: [], cacheTypeK: undefined } }, () => true);
  const profile = llmEngineService.getEffectiveLoadParameters();
  expect(profile).toMatchObject({ contextSize: 2048, ropeFreqScale: 0.5, noExtraBufts: false, ropeFreqBase: 0, loraAdapters: [] });
  expect(jest.mocked(initLlama).mock.calls.slice(-1)[0][0].cache_type_k).not.toBe('f32');
  updateModelLoadParametersForModel(model.id, { noExtraBufts: false, ropeFreqBase: 0, loraAdapters: [], cacheTypeK: undefined });
  expect(getModelLoadParametersForModel(model.id)).toMatchObject({ noExtraBufts: false, ropeFreqBase: 0, loraAdapters: [], ropeFreqScale: 0.5 });
  expect(getModelLoadParametersForModel(model.id).cacheTypeK).toBeUndefined();
});

it('inactive reset plus a basic edit replaces future settings without native init or other model changes', async () => {
  await llmEngineService.unload();
  updateSettings({ activeModelId: 'other/model' });
  updateModelLoadParametersForModel('other/model', { ropeFreqScale: 0.75 });
  const beforeCalls = jest.mocked(initLlama).mock.calls.length;
  const { result } = renderHook(() => useModelParametersSheetController({
    getModelById: () => model, showError, applyReloadErrorScope: 'test', activeModelId: 'other/model',
  }));
  await act(async () => { result.current.openModelParameters(model.id); });
  await act(async () => { result.current.sheetProps.onReset(); });
  await act(async () => { result.current.sheetProps.onChangeLoadParams({ contextSize: 2048 }); });
  await act(async () => { await result.current.sheetProps.onApplyReload(); });
  expect(showError).not.toHaveBeenCalled();
  expect(jest.mocked(initLlama).mock.calls.length).toBe(beforeCalls);
  expect(getModelLoadParametersForModel(model.id)).toEqual({ ...DEFAULT_MODEL_LOAD_PARAMETERS, contextSize: 2048 });
  expect(getModelLoadParametersForModel('other/model').ropeFreqScale).toBe(0.75);
  await llmEngineService.load(model.id);
  expect(jest.mocked(initLlama).mock.calls.slice(-1)[0][0].rope_freq_scale).toBeUndefined();
});

function createThread() {
  return useChatStore.getState().createThread({ modelId: model.id, presetId: null,
    presetSnapshot: { id: null, name: 'Default', systemPrompt: '' },
    paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 512, seed: null }, loraSnapshot: adapters });
}
function openController(loraOverride?: typeof adapters) {
  return renderHook(() => useModelParametersSheetController({ getModelById: () => model,
    showError, applyReloadErrorScope: 'test', activeModelId: model.id, loraOverride }));
}

it('commits adapter removal to the active thread and model default, then A to B to A keeps removal', async () => {
  const threadId = createThread();
  const otherThread = createThread();
  useChatStore.getState().setActiveThread(threadId);
  const { result } = openController(adapters);
  await act(async () => { result.current.openModelParameters(model.id); });
  await act(async () => { result.current.sheetProps.onReset(); });
  expect(useChatStore.getState().threads[threadId].loraSnapshot).toEqual(adapters);
  await act(async () => { await result.current.sheetProps.onApplyReload(); });
  expect(showError).not.toHaveBeenCalled();
  expect(useChatStore.getState().threads[threadId].loraSnapshot).toEqual([]);
  expect(useChatStore.getState().threads[otherThread].loraSnapshot).toEqual(adapters);
  expect(getModelLoadParametersForModel(model.id).loraAdapters).toBeUndefined();
  const other = { ...model, id: 'other/model', localPath: 'other.gguf' };
  jest.mocked(registry.getModel).mockImplementation(id => id === model.id ? model : other);
  await act(async () => { await llmEngineService.load(other.id); await llmEngineService.load(model.id); });
  expect(jest.mocked(initLlama).mock.calls.slice(-1)[0][0].lora_list ?? []).toEqual([]);
});

it('a basic chat edit preserves the distinct model-default adapter configuration', async () => {
  const defaultAdapters = [{ ...adapters[0], scale: 0.25 }];
  updateModelLoadParametersForModel(model.id, { loraAdapters: defaultAdapters });
  const threadId = createThread();
  const { result } = openController(adapters);
  await act(async () => { result.current.openModelParameters(model.id); });
  await act(async () => { result.current.sheetProps.onChangeLoadParams({ contextSize: 2048 }); });
  await act(async () => { await result.current.sheetProps.onApplyReload(); });
  expect(showError).not.toHaveBeenCalled();
  expect(getModelLoadParametersForModel(model.id).loraAdapters).toEqual(defaultAdapters);
  expect(llmEngineService.getEffectiveLoadParameters()?.loraAdapters).toEqual(adapters);
  expect(useChatStore.getState().threads[threadId].loraSnapshot).toEqual(adapters);
});

it('failed reset reload restores the complete confirmed profile and leaves persistence and snapshot unchanged', async () => {
  const previous = getModelLoadParametersForModel(model.id);
  const previousEffective = llmEngineService.getEffectiveLoadParameters();
  const threadId = createThread();
  const originalInit = jest.mocked(initLlama).getMockImplementation()!;
  jest.mocked(initLlama).mockImplementation(async (...args) => {
    if (args[0].rope_freq_scale === undefined) throw new Error('Native load failed');
    return originalInit(...args);
  });
  const { result } = openController(adapters);
  await act(async () => { result.current.openModelParameters(model.id); });
  await act(async () => { result.current.sheetProps.onReset(); });
  await act(async () => { await result.current.sheetProps.onApplyReload(); });
  expect(showError).toHaveBeenCalled();
  expect(getModelLoadParametersForModel(model.id)).toEqual(previous);
  expect(llmEngineService.getEffectiveLoadParameters()).toEqual(previousEffective);
  expect(useChatStore.getState().threads[threadId].loraSnapshot).toEqual(adapters);
});

it.each(['model', 'chat'])('a %s change during reset prevents stale settings and snapshot commit', async change => {
  const previous = getModelLoadParametersForModel(model.id);
  const threadId = createThread();
  const originalInit = jest.mocked(initLlama).getMockImplementation()!;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let started = false;
  jest.mocked(initLlama).mockImplementationOnce(async (...args) => { started = true; await pending; return originalInit(...args); });
  const { result } = openController(adapters);
  await act(async () => { result.current.openModelParameters(model.id); });
  await act(async () => { result.current.sheetProps.onReset(); });
  let applying!: Promise<void>;
  await act(async () => {
    applying = result.current.sheetProps.onApplyReload();
    for (let i = 0; i < 200 && !started; i++) await Promise.resolve();
  });
  expect(started).toBe(true);
  await act(async () => {
    if (change === 'model') updateSettings({ activeModelId: 'other/model' });
    else useChatStore.getState().setActiveThread(null);
    finish(); await applying;
  });
  expect(showError).toHaveBeenCalled();
  expect(getModelLoadParametersForModel(model.id)).toEqual(previous);
  expect(useChatStore.getState().threads[threadId].loraSnapshot).toEqual(adapters);
});

it('reset marks legacy-only overrides dirty and removes them from native initialization', async () => {
  updateModelLoadParametersForModel(model.id, { ...DEFAULT_MODEL_LOAD_PARAMETERS,
    cpuThreads: 2, cpuStrict: true, useMmap: false, useMlock: true, nBatch: 64, nUbatch: 32,
    selectedBackendDevices: [], cpuMask: '0x3', flashAttention: 'off', kvUnified: false }, 'replace');
  await llmEngineService.load(model.id, { forceReload: true });
  const { result } = openController();
  await act(async () => { result.current.openModelParameters(model.id); });
  await act(async () => { result.current.sheetProps.onReset(); });
  expect(result.current.sheetProps.showApplyReload).toBe(true);
  await act(async () => { await result.current.sheetProps.onApplyReload(); });
  expect(showError).not.toHaveBeenCalled();
  expect(getModelLoadParametersForModel(model.id)).toEqual(DEFAULT_MODEL_LOAD_PARAMETERS);
  expect(jest.mocked(initLlama).mock.calls.slice(-1)[0][0]).toMatchObject({ use_mmap: true, use_mlock: false });
  expect(jest.mocked(initLlama).mock.calls.slice(-1)[0][0].cpu_strict).toBeUndefined();
  expect(jest.mocked(initLlama).mock.calls.slice(-1)[0][0].cpu_mask).toBeUndefined();
});
