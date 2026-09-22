import type { LlamaContext, NativeTokenizeResult } from 'llama.rn';
import { releaseAllLlama } from 'llama.rn';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { AppError } from '../../src/services/AppError';
import { registry } from '../../src/services/LocalStorageRegistry';
import { resolveLoraProfileForLoad } from '../../src/services/LoraProfileResolver';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';
import { EngineStatus, LifecycleStatus, type EngineState, type ModelMetadata } from '../../src/types/models';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';
import type { LoraProfileAdapter } from '../../src/utils/advancedLoadProfile';

jest.mock('../../src/services/LoraProfileResolver', () => ({ resolveLoraProfileForLoad: jest.fn() }));
jest.mock('../../src/services/SystemMetricsService', () => ({ getFreshMemorySnapshot: jest.fn() }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: jest.fn(), updateModel: jest.fn() } }));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  BuildInfo: { number: 'test', commit: 'test' },
}));

type EngineTestAccess = {
  state: EngineState;
  updateState(state: EngineState): void;
  context: LlamaContext | null;
  setContext(context: LlamaContext | null): void;
  effectiveLoadParameters: ModelLoadParameters | null;
  requestedLoadParameters: ModelLoadParameters | null;
  activeLoraAdapters: { path: string; scaled: number }[];
  uncertainLoraPaths: Set<string>;
  loadedArtifactIdentity: { resolvedPath: string } | null;
  orphanedContextReleasePromise: Promise<void> | null;
  loadWithProjectorResolutionOperationCache(modelId: string, options: { loadParamsOverride: ModelLoadParameters }, cache: Map<string, unknown>, internal: object): Promise<void>;
};
const service = llmEngineService as unknown as EngineTestAccess;
const model = { id: 'base/a', localPath: 'base.gguf', resolvedFileName: 'base.gguf', lifecycleStatus: LifecycleStatus.DOWNLOADED } as ModelMetadata;
const baseProfile: ModelLoadParameters = { contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16', loraAdapters: [] };
const selected: LoraProfileAdapter[] = [{ artifactId: 'adapter', artifactIdentity: 'source', baseModelIdentity: 'base', scale: 0.5, sizeBytes: 1024 }];
let loaded: { path: string; scaled: number }[];
let context: LlamaContext;
let apply: jest.Mock;
let remove: jest.Mock;
let list: jest.Mock;
let clear: jest.Mock;
let release: jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  loaded = [];
  apply = jest.fn(async (adapters: { path: string; scaled: number }[]) => { loaded = adapters; });
  remove = jest.fn(async () => { loaded = []; });
  list = jest.fn(async () => loaded.map(adapter => ({ ...adapter })));
  clear = jest.fn(async () => undefined);
  release = jest.fn(async () => undefined);
  context = {
    model: { metadata: { 'general.architecture': 'qwen2', 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.pre': 'qwen2' } },
    applyLoraAdapters: apply, removeLoraAdapters: remove, getLoadedLoraAdapters: list,
    clearCache: clear, release,
    getFormattedChat: jest.fn(async () => ({ prompt: 'prompt', additional_stops: [] })),
    tokenize: jest.fn(async () => ({ tokens: [1] })), detokenize: jest.fn(async () => 'text'),
    completion: jest.fn(async () => ({ text: 'reply' })), stopCompletion: jest.fn(async () => undefined),
  } as unknown as LlamaContext;
  service.setContext(context);
  service.state = { status: EngineStatus.READY, activeModelId: model.id, loadProgress: 1 };
  service.effectiveLoadParameters = { ...baseProfile };
  service.requestedLoadParameters = { ...baseProfile };
  service.activeLoraAdapters = [];
  service.uncertainLoraPaths.clear();
  service.loadedArtifactIdentity = { resolvedPath: '/models/base.gguf' };
  jest.mocked(registry.getModel).mockReturnValue({ ...model });
  jest.mocked(getFreshMemorySnapshot).mockResolvedValue({ availableBytes: 2 ** 30, freeBytes: 2 ** 30, thresholdBytes: 0,
    lowMemory: false, pressureLevel: 'normal', timestampMs: Date.now(), platform: 'android', totalBytes: 2 ** 31, usedBytes: 0, appUsedBytes: 0 });
  jest.mocked(resolveLoraProfileForLoad).mockImplementation(async (_model, selection) => ({
    profile: [...(selection ?? [])], adapters: (selection ?? []).map(entry => ({ path: `/models/${entry.artifactId}.gguf`, scaled: entry.scale })),
    sizeBytes: (selection ?? []).reduce((sum, entry) => sum + (entry.sizeBytes ?? 1024), 0),
  }));
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (service.orphanedContextReleasePromise) await service.orphanedContextReleasePromise;
  await llmEngineService.unload();
  jest.useRealTimers();
});

it('applies, reads back, changes scale and removes while invalidating prompt identity', async () => {
  const identity = llmEngineService.getPromptContextIdentity();
  expect(await llmEngineService.applyLoraConfiguration(model.id, selected)).toEqual(selected);
  expect(apply).toHaveBeenCalledWith([{ path: '/models/adapter.gguf', scaled: 0.5 }]);
  expect(list).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledWith(true);
  expect(llmEngineService.getPromptContextIdentity()).not.toBe(identity);
  expect(llmEngineService.getEffectiveLoadParameters()?.loraAdapters).toEqual(selected);
  await llmEngineService.applyLoraConfiguration(model.id, [{ ...selected[0], scale: 0 }]);
  expect(loaded[0].scaled).toBe(0);
  await llmEngineService.applyLoraConfiguration(model.id, []);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(loaded).toEqual([]);
  expect(llmEngineService.getEffectiveLoadParameters()?.loraAdapters).toEqual([]);
  expect(llmEngineService.getState().status).toBe(EngineStatus.READY);
});

it('protects the original applied file even after registry selection changes but permits independent deletion', async () => {
  await llmEngineService.applyLoraConfiguration(model.id, selected);
  jest.mocked(registry.getModel).mockReturnValue({ ...model, artifacts: [] });
  expect(() => llmEngineService.assertModelResourcesIdle(['/models/adapter.gguf'])).toThrow();
  expect(() => llmEngineService.assertModelResourcesIdle(['/models/independent.gguf'])).not.toThrow();
});

it('reserves ownership before verification and forbids concurrent completion, tokenization and adapter changes', async () => {
  const pending = deferred<void>();
  apply.mockImplementationOnce(async () => pending.promise);
  const applying = llmEngineService.applyLoraConfiguration(model.id, selected);
  await until(() => apply.mock.calls.length === 1);
  expect(llmEngineService.getState().status).not.toBe(EngineStatus.READY);
  await expect(llmEngineService.chatCompletion({ messages: [{ role: 'user', content: 'blocked' }] })).rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.countPromptTokens({ messages: [{ role: 'user', content: 'blocked' }] })).rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.inspectTokens('blocked')).rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.applyLoraConfiguration(model.id, [])).rejects.toMatchObject({ code: 'engine_busy' });
  loaded = [{ path: '/models/adapter.gguf', scaled: 0.5 }];
  pending.resolve();
  await applying;
});

it('rejects applying while a deferred tokenizer still owns native resources', async () => {
  const pending = deferred<NativeTokenizeResult>();
  jest.mocked(context.tokenize).mockImplementationOnce(async () => pending.promise);
  const counting = llmEngineService.countPromptTokens({ messages: [{ role: 'user', content: 'count' }] });
  await until(() => jest.mocked(context.tokenize).mock.calls.length === 1);
  await expect(llmEngineService.applyLoraConfiguration(model.id, selected)).rejects.toMatchObject({ code: 'engine_busy' });
  expect(apply).not.toHaveBeenCalled();
  pending.resolve({ tokens: [1], has_media: false, bitmap_hashes: [], chunk_pos: [], chunk_pos_media: [] });
  await counting;
});

it('rejects insufficient or unknown live memory before mutating the loaded adapter set', async () => {
  jest.mocked(getFreshMemorySnapshot).mockResolvedValueOnce(null);
  await expect(llmEngineService.applyLoraConfiguration(model.id, selected)).rejects.toMatchObject({ code: 'model_memory_insufficient' });
  expect(apply).not.toHaveBeenCalled();
  expect(llmEngineService.getEffectiveLoadParameters()?.loraAdapters).toEqual([]);
  expect(llmEngineService.getState().status).toBe(EngineStatus.READY);
});

it('reloads the previous confirmed profile after non-atomic apply failure', async () => {
  const previous = { ...selected[0], artifactId: 'previous', scale: 0.25 };
  service.effectiveLoadParameters = { ...baseProfile, loraAdapters: [previous] };
  service.activeLoraAdapters = [{ path: '/models/previous.gguf', scaled: 0.25 }];
  apply.mockImplementationOnce(async () => { loaded = [{ path: '/models/partial.gguf', scaled: 1 }]; throw new Error('partial failure'); });
  const restore = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache').mockImplementation(async (_id, options) => {
    expect(releaseAllLlama).toHaveBeenCalled();
    service.setContext(context);
    service.effectiveLoadParameters = options.loadParamsOverride;
    service.state = { status: EngineStatus.READY, activeModelId: model.id, loadProgress: 1 };
  });
  await expect(llmEngineService.applyLoraConfiguration(model.id, selected)).rejects.toMatchObject({ code: 'model_load_failed' });
  expect(restore).toHaveBeenCalledWith(model.id, expect.objectContaining({ loadParamsOverride: expect.objectContaining({ loraAdapters: [previous] }) }), expect.any(Map), { lifecycleOwned: true });
  expect(llmEngineService.getEffectiveLoadParameters()?.loraAdapters).toEqual([previous]);
});

it.each(['readback', 'clear'] as const)('treats %s failure as uncertain and never publishes READY if recovery fails', async (failure) => {
  if (failure === 'readback') list.mockResolvedValueOnce([]);
  else clear.mockRejectedValueOnce(new Error('clear failed'));
  jest.spyOn(service, 'loadWithProjectorResolutionOperationCache').mockRejectedValueOnce(new Error('restore failed'));
  await expect(llmEngineService.applyLoraConfiguration(model.id, selected)).rejects.toMatchObject({ code: 'engine_recovery_required' });
  if (failure === 'readback') expect(clear).not.toHaveBeenCalled();
  expect(llmEngineService.getState().status).toBe(EngineStatus.ERROR);
});

it('confirms an active load transaction only after its deferred native load settles', async () => {
  const pending = deferred<void>();
  const previous = { ...baseProfile, loraAdapters: selected };
  service.effectiveLoadParameters = previous;
  const load = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache').mockImplementation(async (_id, options) => {
    service.state = { ...service.state, status: EngineStatus.INITIALIZING };
    await pending.promise;
    service.effectiveLoadParameters = { ...options.loadParamsOverride, gpuLayers: 0 };
    service.state = { ...service.state, status: EngineStatus.READY };
  });
  const transaction = llmEngineService.applyLoadProfileTransaction(model.id, { loadParamsOverride: { contextSize: 4096, gpuLayers: 4 } }, () => true);
  await until(() => load.mock.calls.length === 1);
  expect(llmEngineService.hasAuxiliaryContextOperation()).toBe(true);
  expect(llmEngineService.getEffectiveLoadParameters()).toEqual(previous);
  pending.resolve();
  await expect(transaction).resolves.toMatchObject({ contextSize: 4096, gpuLayers: 0, loraAdapters: selected });
  expect(load.mock.calls[0][1].loadParamsOverride.loraAdapters).toEqual(selected);
});

it('rolls a failed load transaction back to the complete previous effective profile including LoRA', async () => {
  const previous = { ...baseProfile, cacheTypeK: 'q8_0' as const, cacheTypeV: 'f16' as const, ropeFreqScale: 0.5, loraAdapters: selected };
  service.effectiveLoadParameters = previous;
  const load = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache')
    .mockRejectedValueOnce(new Error('new profile failed'))
    .mockImplementationOnce(async (_id, options) => {
      service.effectiveLoadParameters = options.loadParamsOverride;
      service.state = { ...service.state, status: EngineStatus.READY };
    });
  await expect(llmEngineService.applyLoadProfileTransaction(model.id, { loadParamsOverride: { contextSize: 8192 } }, () => true))
    .rejects.toMatchObject({ code: 'model_load_failed' });
  expect(load).toHaveBeenCalledTimes(2);
  expect(load.mock.calls[1][1].loadParamsOverride).toEqual(previous);
  expect(llmEngineService.getEffectiveLoadParameters()).toEqual(previous);
});

it.each(['model_load_blocked', 'model_memory_warning', 'model_memory_insufficient'] as const)
('preserves the %s consent/retry receipt after restoring the confirmed profile', async code => {
  const previous = { ...baseProfile, loraAdapters: selected };
  service.effectiveLoadParameters = previous;
  const memoryGate = new AppError(code, 'Memory policy gate', { details: { requiredBytes: 100 } });
  const load = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache')
    .mockRejectedValueOnce(memoryGate)
    .mockImplementationOnce(async (_id, options) => {
      service.effectiveLoadParameters = options.loadParamsOverride;
      service.state = { ...service.state, status: EngineStatus.READY };
    });
  await expect(llmEngineService.applyLoadProfileTransaction(model.id, { loadParamsOverride: { contextSize: 8192 } }, () => true))
    .rejects.toBe(memoryGate);
  expect(load.mock.calls[1][1].loadParamsOverride).toEqual(previous);
  expect(llmEngineService.getEffectiveLoadParameters()).toEqual(previous);
});

it('drains a stale load transaction and unloads without restoring over the newly selected chat', async () => {
  const pending = deferred<void>();
  let current = true;
  const load = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache').mockImplementation(async () => {
    await pending.promise;
    service.updateState({ ...service.state, status: EngineStatus.READY });
    expect(service.state.status).not.toBe(EngineStatus.READY);
  });
  const transaction = llmEngineService.applyLoadProfileTransaction(model.id, {}, () => current);
  await until(() => load.mock.calls.length === 1);
  current = false;
  expect(releaseAllLlama).not.toHaveBeenCalled();
  pending.resolve();
  await expect(transaction).rejects.toMatchObject({ code: 'engine_busy' });
  expect(load).toHaveBeenCalledTimes(1);
  expect(releaseAllLlama).toHaveBeenCalled();
  expect(service.context).toBeNull();
});

it('waits for cancelled apply to settle before release and never restores an obsolete chat', async () => {
  const pending = deferred<void>();
  const controller = new AbortController();
  let current = true;
  apply.mockImplementationOnce(async () => { await pending.promise; loaded = [{ path: '/models/adapter.gguf', scaled: 0.5 }]; });
  const applying = llmEngineService.applyLoraConfiguration(model.id, selected, { signal: controller.signal, isCurrent: () => current });
  await until(() => apply.mock.calls.length === 1);
  controller.abort(); current = false;
  expect(releaseAllLlama).not.toHaveBeenCalled();
  expect(llmEngineService.hasAuxiliaryContextOperation()).toBe(true);
  pending.resolve();
  await expect(applying).rejects.toMatchObject({ code: 'engine_busy' });
  expect(releaseAllLlama).toHaveBeenCalled();
  expect(service.context).toBeNull();
});

it('withholds READY when a partial-apply rollback becomes stale during native reload', async () => {
  const pending = deferred<void>();
  let current = true;
  apply.mockRejectedValueOnce(new Error('partial apply'));
  const load = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache').mockImplementation(async () => {
    await pending.promise;
    service.setContext(context);
    service.updateState({ status: EngineStatus.READY, activeModelId: model.id, loadProgress: 1 });
    expect(service.state.status).not.toBe(EngineStatus.READY);
  });
  const applying = llmEngineService.applyLoraConfiguration(model.id, selected, { isCurrent: () => current });
  await until(() => load.mock.calls.length === 1);
  current = false;
  pending.resolve();
  await expect(applying).rejects.toMatchObject({ code: 'engine_busy' });
  expect(service.context).toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
});

it('keeps timed-out apply paths protected until late native completion and confirmed release', async () => {
  jest.useFakeTimers();
  const pending = deferred<void>();
  apply.mockImplementationOnce(async () => { await pending.promise; loaded = [{ path: '/models/adapter.gguf', scaled: 0.5 }]; });
  const applying = llmEngineService.applyLoraConfiguration(model.id, selected).catch(error => error);
  await until(() => apply.mock.calls.length === 1);
  await jest.advanceTimersByTimeAsync(30_001);
  expect(await applying).toMatchObject({ code: 'engine_recovery_required' });
  expect(llmEngineService.getState().status).toBe(EngineStatus.ERROR);
  expect(release).not.toHaveBeenCalled();
  expect(() => llmEngineService.assertModelResourcesIdle(['/models/adapter.gguf'])).toThrow();
  pending.resolve();
  await service.orphanedContextReleasePromise;
  expect(release).toHaveBeenCalledTimes(1);
  expect(service.uncertainLoraPaths.size).toBe(0);
});
