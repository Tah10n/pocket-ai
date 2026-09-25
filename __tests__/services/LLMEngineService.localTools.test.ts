import type { LlamaContext } from 'llama.rn';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { resolveLoraProfileForLoad } from '../../src/services/LoraProfileResolver';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';
import { EngineStatus, LifecycleStatus, type EngineState, type ModelMetadata } from '../../src/types/models';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';

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
let loaded: { path: string; scaled: number }[];
let context: LlamaContext;
let lease: ReturnType<typeof llmEngineService.beginLocalToolRun> | undefined;
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
  lease?.finish();
  lease = undefined;
  jest.restoreAllMocks();
  if (service.orphanedContextReleasePromise) await service.orphanedContextReleasePromise;
  await llmEngineService.unload();
  jest.useRealTimers();
});


it('reserves native dispatch throughout gaps and releases without a recursive lock', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  expect(() => llmEngineService.beginLocalToolRun(model.id)).toThrow();
  await expect(llmEngineService.load('other/model')).rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.applyLoraConfiguration(model.id, [])).rejects.toMatchObject({ code: 'engine_busy' });
  expect(() => llmEngineService.reserveAutotuneContext()).toThrow();
  const operation = jest.fn();
  await expect(llmEngineService.runWithAuxiliaryContext({ modelId: 'embedding', initParams: { model: '/embedding.gguf' }, isCurrent: () => true }, operation))
    .rejects.toMatchObject({ code: 'engine_busy' });
  expect(operation).not.toHaveBeenCalled();
  const messages = [{ role: 'user' as const, content: 'Question' }];
  await expect(llmEngineService.countPromptTokens({ messages })).rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.chatCompletion({ messages })).rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.inspectTokens('blocked')).rejects.toMatchObject({ code: 'engine_busy' });
  expect(context.tokenize).not.toHaveBeenCalled();
  expect(context.completion).not.toHaveBeenCalled();
  await expect(llmEngineService.countPromptTokens({ messages, runOwner: lease.token })).resolves.toBe(1);
  await expect(llmEngineService.chatCompletion({ messages, runOwner: lease.token })).resolves.toMatchObject({ text: 'reply' });
  lease.assertCurrent();
  await expect(llmEngineService.chatCompletion({ messages })).rejects.toMatchObject({ code: 'engine_busy' });
  lease.finish();
  lease.finish();
  await expect(llmEngineService.chatCompletion({ messages, runOwner: lease.token })).rejects.toMatchObject({ code: 'engine_busy' });
  await expect(llmEngineService.chatCompletion({ messages })).resolves.toMatchObject({ text: 'reply' });
});

it('Stop cancels the owner between completions and permits a new ordinary request after drain', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  const stopping = llmEngineService.stopCompletion();
  expect(lease.signal.aborted).toBe(true);
  expect(() => lease?.assertCurrent()).toThrow();
  await expect(llmEngineService.chatCompletion({ messages: [], runOwner: lease.token })).rejects.toMatchObject({ code: 'engine_busy' });
  lease.finish();
  await stopping;
  expect(context.completion).not.toHaveBeenCalled();
  await expect(llmEngineService.chatCompletion({ messages: [{ role: 'user', content: 'next' }] })).resolves.toMatchObject({ text: 'reply' });
});

it('holds ownership while deferred native completion drains after Stop', async () => {
  const pending = deferred<Awaited<ReturnType<LlamaContext['completion']>>>();
  jest.mocked(context.completion).mockImplementationOnce(async () => pending.promise);
  lease = llmEngineService.beginLocalToolRun(model.id);
  const completion = llmEngineService.chatCompletion({ messages: [{ role: 'user', content: 'start' }], runOwner: lease.token });
  const settled = completion.catch(error => error);
  await until(() => jest.mocked(context.completion).mock.calls.length === 1);
  const stopping = llmEngineService.stopCompletion();
  expect(lease.signal.aborted).toBe(true);
  await expect(llmEngineService.load('other/model')).rejects.toMatchObject({ code: 'engine_busy' });
  pending.resolve({ text: '', interrupted: true } as Awaited<ReturnType<LlamaContext['completion']>>);
  await settled;
  lease.finish();
  await stopping;
  await expect(llmEngineService.chatCompletion({ messages: [{ role: 'user', content: 'next' }] })).resolves.toMatchObject({ text: 'reply' });
});

it('rejects an owner after native context identity changes', () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  service.setContext({ ...context } as LlamaContext);
  expect(() => lease?.assertCurrent()).toThrow();
});

it('private-storage cleanup waits for actual deferred document work to release its lease', async () => {
  lease = llmEngineService.beginLocalToolRun(model.id);
  const document = deferred<void>();
  const work = document.promise.finally(() => lease?.finish());
  let drained = false;
  const draining = llmEngineService.cancelActiveContextOperations({ timeoutMs: 1000 }).then(result => { drained = true; return result; });
  await Promise.resolve();
  expect(lease.signal.aborted).toBe(true);
  expect(drained).toBe(false);
  expect(() => llmEngineService.beginLocalToolRun(model.id)).toThrow();
  document.resolve();
  await work;
  await expect(draining).resolves.toBe('drained');
  expect(drained).toBe(true);
});

it('a document drain timeout does not release ownership or permit native reuse', async () => {
  jest.useFakeTimers();
  lease = llmEngineService.beginLocalToolRun(model.id);
  const draining = llmEngineService.cancelActiveContextOperations({ timeoutMs: 10, detachOnTimeout: true });
  await jest.advanceTimersByTimeAsync(11);
  await expect(draining).resolves.toBe('timed_out');
  expect(lease.signal.aborted).toBe(true);
  expect(() => llmEngineService.beginLocalToolRun(model.id)).toThrow();
  await expect(llmEngineService.load('other/model')).rejects.toMatchObject({ code: 'engine_busy' });
  lease.finish();
  await expect(llmEngineService.chatCompletion({ messages: [{ role: 'user', content: 'next' }] })).resolves.toMatchObject({ text: 'reply' });
});
