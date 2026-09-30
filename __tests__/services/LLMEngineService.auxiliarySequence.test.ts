import type { LlamaContext } from 'llama.rn';
import { initLlama, releaseAllLlama } from 'llama.rn';
import { llmEngineService, type AuxiliaryContextRequest } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { EngineStatus, LifecycleStatus, type EngineState, type ModelMetadata } from '../../src/types/models';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';
import type { ContextOperationRunner } from '../../src/services/LLMEngineService.runners';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';

jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: jest.fn(), updateModel: jest.fn() } }));
jest.mock('../../src/services/SystemMetricsService', () => ({ getFreshMemorySnapshot: jest.fn() }));
jest.mock('llama.rn', () => ({ initLlama: jest.fn(), releaseAllLlama: jest.fn(async () => undefined),
  BuildInfo: { number: 'test', commit: 'test' } }));

type TestAccess = {
  state: EngineState;
  context: LlamaContext | null;
  setContext(context: LlamaContext | null): void;
  effectiveLoadParameters: ModelLoadParameters | null;
  activeContextSize: number;
  activeGpuLayers: number | null;
  activeLoraAdapters: { path: string; scaled: number }[];
  loadedArtifactIdentity: Record<string, unknown> | null;
  activeMultimodalContext: Record<string, unknown> | null;
  contextOperationRunner: ContextOperationRunner;
  auxiliaryOperation: object | null;
  orphanedContextReleaseError: Error | null;
  orphanedContextReleasePromise: Promise<void> | null;
  loadWithProjectorResolutionOperationCache(modelId: string, options: { loadParamsOverride: ModelLoadParameters }, cache: Map<string, unknown>, internal: { runOwner?: symbol }): Promise<void>;
};
const service = llmEngineService as unknown as TestAccess;
const model = { id: 'chat/a', localPath: 'a.gguf', resolvedFileName: 'a.gguf',
  lifecycleStatus: LifecycleStatus.DOWNLOADED } as ModelMetadata;
const profile: ModelLoadParameters = { contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16', backendPolicy: 'cpu',
  selectedBackendDevices: [], cpuThreads: 2, nBatch: 128, nUbatch: 64,
  cacheTypeK: 'q8_0', cacheTypeV: 'f16', ropeFreqScale: 1.5, useMmap: true, parallelSlots: 1,
  loraAdapters: [
    { artifactId: 'one', artifactIdentity: 'one-bytes', baseModelIdentity: 'a-bytes', scale: 0.5, sizeBytes: 1024 },
    { artifactId: 'two', artifactIdentity: 'two-bytes', baseModelIdentity: 'a-bytes', scale: -0.25, sizeBytes: 2048 },
  ] };
const artifact = { localPath: 'a.gguf', resolvedPath: '/models/a.gguf', sizeBytes: 100,
  modificationTime: 1, fallbackDownloadMarker: null };
const projector = { modelId: model.id, projectorId: 'projector', projectorResolvedPath: '/models/projector.gguf' };
const adapters = [{ path: '/models/one.gguf', scaled: 0.5 }, { path: '/models/two.gguf', scaled: -0.25 }];
let events: string[];
let restore: jest.SpyInstance;
let a: LlamaContext;
let lease: ReturnType<typeof llmEngineService.beginLocalToolRun> | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await Promise.resolve();
  expect(predicate()).toBe(true);
}
function context(name: string): LlamaContext {
  return { model: { metadata: { 'general.architecture': 'qwen2', 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.pre': 'qwen2' } },
    release: jest.fn(async () => { events.push(`release:${name}`); }),
    releaseMultimodal: jest.fn(async () => { events.push(`release-media:${name}`); }),
    stopCompletion: jest.fn(async () => undefined),
    tokenize: jest.fn(async () => ({ tokens: [1] })),
    getFormattedChat: jest.fn(async () => ({ prompt: 'formatted', additional_stops: [] })),
    completion: jest.fn(async () => ({ text: 'answer' })),
  } as unknown as LlamaContext;
}
function phase(name: string): AuxiliaryContextRequest {
  return { modelId: name, initParams: { model: `/${name}.gguf`, embedding: true,
    ...(name === 'c' ? { pooling_type: 'rank' } : {}), n_ctx: 512, n_parallel: 1,
    state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 }, isCurrent: () => true };
}
function publishRestoredA(restoredProfile: ModelLoadParameters = profile) {
  service.setContext(context('restored-a'));
  service.state = { status: EngineStatus.READY, activeModelId: model.id, loadProgress: 1 };
  service.effectiveLoadParameters = { ...restoredProfile };
  service.activeContextSize = restoredProfile.contextSize!;
  service.loadedArtifactIdentity = { ...artifact };
  service.activeMultimodalContext = { ...projector };
  service.activeLoraAdapters = adapters.map(adapter => ({ ...adapter }));
}

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  service.contextOperationRunner.reset();
  service.auxiliaryOperation = null;
  service.orphanedContextReleaseError = null;
  service.orphanedContextReleasePromise = null;
  a = context('a');
  service.setContext(a);
  service.state = { status: EngineStatus.READY, activeModelId: model.id, loadProgress: 1 };
  service.effectiveLoadParameters = { ...profile };
  service.activeContextSize = 2048;
  service.activeGpuLayers = 0;
  service.loadedArtifactIdentity = { ...artifact };
  service.activeMultimodalContext = { ...projector };
  service.activeLoraAdapters = adapters.map(adapter => ({ ...adapter }));
  jest.mocked(registry.getModel).mockReturnValue(model);
  jest.mocked(getFreshMemorySnapshot).mockResolvedValue(null);
  jest.mocked(releaseAllLlama).mockImplementation(async () => { events.push('release:a'); });
  jest.mocked(initLlama).mockImplementation(async params => {
    const name = params.model.includes('/b.') ? 'b' : 'c';
    events.push(`init:${name}`);
    return context(name);
  });
  restore = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache').mockImplementation(async () => {
    events.push('restore:a'); publishRestoredA();
  });
});
afterEach(async () => {
  lease?.finish(); lease = undefined;
  service.orphanedContextReleaseError = null;
  if (service.orphanedContextReleasePromise) await service.orphanedContextReleasePromise;
  await llmEngineService.unload();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('performs A+LoRA+media -> B -> C -> A once under the genuine tool owner and rebinds only its epoch', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  const originalIdentity = llmEngineService.getPromptContextIdentity();
  const pending = deferred<void>();
  const receipt = jest.fn();
  let bStarted = false;
  const result = llmEngineService.runWithAuxiliarySequence({ runOwner: lease.token, isCurrent: () => true, onRestored: receipt }, async sequence => {
    await sequence.withContext(phase('b'), async () => { bStarted = true; await pending.promise; return [0.2, 0.8]; });
    return sequence.withContext(phase('c'), async () => ({ ranked: [1, 0] }));
  });
  await until(() => bStarted);
  lease.assertSelectionCurrent();
  expect(() => lease?.assertCurrent()).toThrow();
  await expect(llmEngineService.load('other')).rejects.toMatchObject({ code: 'engine_busy' });
  expect(events).toEqual(['release-media:a', 'release:a', 'init:b']);
  pending.resolve();
  await expect(result).resolves.toEqual({ ranked: [1, 0] });
  expect(events).toEqual(['release-media:a', 'release:a', 'init:b', 'release:b', 'init:c', 'release:c', 'restore:a']);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(restore.mock.calls[0][1].loadParamsOverride).toMatchObject(profile);
  expect(restore.mock.calls[0][3]).toEqual({ lifecycleOwned: true, runOwner: lease.token, restoreAuxiliaryOwner: true });
  expect(llmEngineService.getPromptContextIdentity()).not.toBe(originalIdentity);
  expect(receipt).toHaveBeenCalledWith({ previousContextIdentity: originalIdentity,
    restoredContextIdentity: llmEngineService.getPromptContextIdentity(), modelId: model.id });
  lease.assertCurrent();
  expect(service.contextOperationRunner.isAdmissionAllowed('passive_readiness')).toBe(false);
  await expect(llmEngineService.countPromptTokens({ messages: [], runOwner: lease.token })).resolves.toBe(1);
  await expect(llmEngineService.chatCompletion({ messages: [], runOwner: lease.token })).resolves.toMatchObject({ text: 'answer' });
  service.setContext(context('foreign-a'));
  expect(() => lease?.assertCurrent()).toThrow();
});

it('rejects a forged owner without suspending A or weakening ordinary auxiliary exclusion', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  const operation = jest.fn();
  await expect(llmEngineService.runWithAuxiliarySequence({ runOwner: Symbol('forged'), isCurrent: () => true }, operation))
    .rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.runWithAuxiliaryContext(phase('b'), operation)).rejects.toMatchObject({ code: 'engine_busy' });
  expect(events).toEqual([]);
  expect(operation).not.toHaveBeenCalled();
});

it('rejects a real but stale owner before initializing an auxiliary context', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  service.setContext(context('replacement-a'));
  const operation = jest.fn(async () => 1);
  await expect(llmEngineService.runWithAuxiliarySequence({ runOwner: lease.token, isCurrent: () => true }, operation))
    .rejects.toMatchObject({ code: 'engine_busy' });
  expect(operation).not.toHaveBeenCalled();
  expect(initLlama).not.toHaveBeenCalled();
});

it('waits for B release to settle before initializing C', async () => {
  const released = deferred<void>();
  const b = context('b');
  jest.mocked(b.release).mockImplementation(async () => { events.push('release:b'); await released.promise; });
  jest.mocked(initLlama).mockResolvedValueOnce(b);
  const transaction = llmEngineService.runWithAuxiliarySequence({ isCurrent: () => true }, async sequence => {
    await sequence.withContext(phase('b'), async () => 1);
    return sequence.withContext(phase('c'), async () => 2);
  });
  await until(() => events.includes('release:b'));
  expect(initLlama).toHaveBeenCalledTimes(1);
  expect(restore).not.toHaveBeenCalled();
  released.resolve();
  await expect(transaction).resolves.toBe(2);
  expect(initLlama).toHaveBeenCalledTimes(2);
});

it('Stop drains the running native embedding and starts neither C nor an old response', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  const pending = deferred<void>();
  let started = false;
  const cCallback = jest.fn(async () => 2);
  const receipt = jest.fn();
  const transaction = llmEngineService.runWithAuxiliarySequence({ runOwner: lease.token, isCurrent: () => true, onRestored: receipt }, async sequence => {
    await sequence.withContext(phase('b'), async () => { started = true; await pending.promise; return 1; });
    return sequence.withContext(phase('c'), cCallback);
  });
  const rejected = expect(transaction).rejects.toMatchObject({ code: 'engine_busy' });
  await until(() => started);
  await llmEngineService.stopCompletion();
  expect(lease.signal.aborted).toBe(true);
  expect(events).not.toContain('release:b');
  expect(llmEngineService.hasAuxiliaryContextOperation()).toBe(true);
  await expect(llmEngineService.load('other')).rejects.toMatchObject({ code: 'engine_busy' });
  pending.resolve(); await rejected;
  expect(events).toContain('release:b');
  expect(cCallback).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(initLlama).toHaveBeenCalledTimes(1);
  expect(a.stopCompletion).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
});

it.each([false, true])('safe Stop restores exact A after actual native drain with tool owner=%s, without continuation or receipt', async useToolOwner => {
  if (useToolOwner) lease = llmEngineService.beginLocalToolRun(model.id);
  const abort = new AbortController();
  const pending = deferred<void>();
  const receipt = jest.fn();
  const cCallback = jest.fn(async () => 2);
  let started = false;
  const transaction = llmEngineService.runWithAuxiliarySequence({
    runOwner: lease?.token, signal: abort.signal,
    isCurrent: () => !abort.signal.aborted,
    isSelectionCurrent: () => true, onRestored: receipt,
  }, async sequence => {
    await sequence.withContext({ ...phase('b'), signal: abort.signal }, async () => {
      started = true; await pending.promise; return 1;
    });
    return sequence.withContext(phase('c'), cCallback);
  });
  const rejected = expect(transaction).rejects.toMatchObject({ code: 'engine_busy' });
  await until(() => started);
  abort.abort();
  // Global Stop uses this path and waits for the retained tool lease to settle.
  const contextDrain = useToolOwner ? llmEngineService.cancelActiveContextOperations() : undefined;
  if (!useToolOwner) await llmEngineService.stopCompletion();
  expect(events).not.toContain('release:b');
  expect(restore).not.toHaveBeenCalled();
  expect(llmEngineService.hasAuxiliaryContextOperation()).toBe(true);
  pending.resolve();
  await rejected;
  expect(events.slice(-2)).toEqual(['release:b', 'restore:a']);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(restore.mock.calls[0][1].loadParamsOverride).toMatchObject(profile);
  expect(cCallback).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
  expect(llmEngineService.getState()).toMatchObject({ status: EngineStatus.READY, activeModelId: model.id });
  if (lease) {
    expect(lease.signal.aborted).toBe(true);
    expect(() => lease?.assertCurrent()).toThrow();
    await expect(llmEngineService.chatCompletion({ messages: [], runOwner: lease.token })).rejects.toMatchObject({ code: 'engine_busy' });
    lease.finish(); lease = undefined;
  }
  if (contextDrain) await expect(contextDrain).resolves.toBe('drained');
  await expect(llmEngineService.chatCompletion({ messages: [] })).resolves.toMatchObject({ text: 'answer' });
});

it.each(['selection', 'invalidation'])('Stop never restores A after stable %s ownership loss', async loss => {
  const pending = deferred<void>();
  const abort = new AbortController();
  let selected = true;
  let started = false;
  const transaction = llmEngineService.runWithAuxiliarySequence({ signal: abort.signal,
    isCurrent: () => !abort.signal.aborted, isSelectionCurrent: () => selected },
  sequence => sequence.withContext({ ...phase('b'), signal: abort.signal }, async () => {
    started = true; await pending.promise; return 1;
  }));
  const rejected = expect(transaction).rejects.toMatchObject({ code: 'engine_busy' });
  await until(() => started);
  abort.abort();
  if (loss === 'selection') selected = false;
  else llmEngineService.invalidateAuxiliaryContextOperation();
  pending.resolve();
  await rejected;
  expect(restore).not.toHaveBeenCalled();
  expect(events.at(-1)).toBe('release:b');
});

it('drains a late initialized B after cancellation and never executes its callback', async () => {
  const init = deferred<LlamaContext>();
  jest.mocked(initLlama).mockReturnValueOnce(init.promise);
  const abort = new AbortController();
  const callback = jest.fn(async () => 1);
  const transaction = llmEngineService.runWithAuxiliarySequence({ signal: abort.signal, isCurrent: () => true },
    sequence => sequence.withContext(phase('b'), callback));
  const rejected = expect(transaction).rejects.toMatchObject({ code: 'engine_busy' });
  await until(() => jest.mocked(initLlama).mock.calls.length === 1);
  abort.abort();
  expect(restore).not.toHaveBeenCalled();
  init.resolve(context('b'));
  await rejected;
  expect(callback).not.toHaveBeenCalled();
  expect(events).toContain('release:b');
});

it.each(['profile', 'lora', 'projector'])('rejects a restored A with a different %s instead of rebinding its owner', async changed => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  restore.mockImplementation(async () => {
    publishRestoredA(changed === 'profile' ? { ...profile, nBatch: 64 } : profile);
    if (changed === 'lora') service.activeLoraAdapters = [...adapters].reverse();
    if (changed === 'projector') service.activeMultimodalContext = { ...projector, projectorId: 'changed' };
  });
  await expect(llmEngineService.runWithAuxiliarySequence({ runOwner: lease.token, isCurrent: () => true },
    sequence => sequence.withContext(phase('b'), async () => 1))).rejects.toMatchObject({ code: 'model_load_failed' });
  expect(() => lease?.assertCurrent()).toThrow();
  expect(llmEngineService.getState().auxiliaryRestoreError).toBeDefined();
});

it('restores A after a settled native failure before returning the failure to a fallback caller', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  const receipt = jest.fn();
  await expect(llmEngineService.runWithAuxiliarySequence({ runOwner: lease.token, isCurrent: () => true, onRestored: receipt },
    sequence => sequence.withContext(phase('b'), async () => { throw new Error('native operation failed'); })))
    .rejects.toThrow('native operation failed');
  expect(events).toContain('release:b');
  expect(events.at(-1)).toBe('restore:a');
  lease.assertCurrent();
  expect(receipt).toHaveBeenCalledTimes(1);
});

it('a restore observer failure aborts continuation without claiming that the verified restore failed', async () => {
  await expect(llmEngineService.runWithAuxiliarySequence({ isCurrent: () => true,
    onRestored: () => { throw new Error('observer invalidated continuation'); } },
  sequence => sequence.withContext(phase('b'), async () => 1))).rejects.toThrow('observer invalidated continuation');
  expect(llmEngineService.getState()).toMatchObject({ status: EngineStatus.READY, activeModelId: model.id });
  expect(llmEngineService.getState().auxiliaryRestoreError).toBeUndefined();
});

it('rejects overlapping phases and still drains the first phase before restoring A', async () => {
  const pending = deferred<void>();
  let started = false;
  const transaction = llmEngineService.runWithAuxiliarySequence({ isCurrent: () => true }, async sequence => {
    void sequence.withContext(phase('b'), async () => { started = true; await pending.promise; return 1; });
    return sequence.withContext(phase('c'), async () => 2);
  });
  const rejected = expect(transaction).rejects.toMatchObject({ code: 'engine_busy' });
  await until(() => started);
  expect(restore).not.toHaveBeenCalled();
  expect(initLlama).toHaveBeenCalledTimes(1);
  pending.resolve(); await rejected;
  expect(events.at(-1)).toBe('restore:a');
});

it('never initializes C or restores stale A after permission/selection loss', async () => {
  let current = true;
  const transaction = llmEngineService.runWithAuxiliarySequence({ isCurrent: () => current }, async sequence => {
    await sequence.withContext(phase('b'), async () => { current = false; return 1; });
    return sequence.withContext(phase('c'), async () => 2);
  });
  await expect(transaction).rejects.toMatchObject({ code: 'engine_busy' });
  expect(initLlama).toHaveBeenCalledTimes(1);
  expect(restore).not.toHaveBeenCalled();
});

it('keeps timed-out native ownership until late drain and does not initialize C or restore A', async () => {
  jest.useFakeTimers();
  lease = llmEngineService.beginLocalToolRun(model.id);
  const pending = deferred<void>();
  let started = false;
  const transaction = llmEngineService.runWithAuxiliarySequence({ runOwner: lease.token, isCurrent: () => true }, async sequence => {
    await sequence.withContext({ ...phase('b'), nativeDrainTimeoutMs: 1000 }, async () => {
      started = true; await pending.promise; return 1;
    });
    return sequence.withContext(phase('c'), async () => 2);
  });
  const rejected = expect(transaction).rejects.toMatchObject({ code: 'engine_recovery_required' });
  try {
    await until(() => started);
    await jest.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(events).not.toContain('release:b');
    expect(restore).not.toHaveBeenCalled();
    expect(initLlama).toHaveBeenCalledTimes(1);
    expect(() => lease?.assertCurrent()).toThrow();
    await expect(llmEngineService.load('other')).rejects.toMatchObject({ code: 'engine_busy' });
  } finally {
    pending.resolve();
    await until(() => events.includes('release:b'));
    if (service.orphanedContextReleasePromise) await service.orphanedContextReleasePromise;
  }
});

it.each([0, 999, 600001, Number.NaN])('rejects invalid explicit native drain budget %s before phase initialization', async nativeDrainTimeoutMs => {
  await expect(llmEngineService.runWithAuxiliarySequence({ isCurrent: () => true }, sequence =>
    sequence.withContext({ ...phase('b'), nativeDrainTimeoutMs }, async () => 1))).rejects.toMatchObject({ code: 'action_failed' });
  expect(initLlama).not.toHaveBeenCalled();
  expect(restore).toHaveBeenCalledTimes(1);
});
