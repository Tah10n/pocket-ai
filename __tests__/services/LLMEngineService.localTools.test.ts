import type { ContextOperationRunner } from '../../src/services/LLMEngineService.runners';
import type { LlamaContext } from 'llama.rn';
import { runLocalToolCompletion } from '../../src/services/LocalToolRun';
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
  contextOperationRunner: ContextOperationRunner;
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


it.each([undefined, { output: { mode: 'json_object' as const } }])(
  'freezes template time across real counting and completion dispatch with generation %j', async generation => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const initialNow = Math.floor(Date.now() / 1000);
    context.model.chatTemplates = { jinja: {
      default: true, defaultCaps: { tools: true, toolCalls: true }, toolUse: false,
    } } as LlamaContext['model']['chatTemplates'];
    const formattedTimes: unknown[] = [];
    const countedPrompts: string[] = [];
    const completionPrompts: string[] = [];
    jest.mocked(context.getFormattedChat).mockImplementation(async (_messages, _template, format) => {
      formattedTimes.push(format?.now);
      return { type: 'jinja', prompt: `prompt:${format?.now}:${format?.tool_choice}`,
        additional_stops: [], has_media: false, grammar: 'template grammar', chat_format: 1, chat_parser: 'parser' } as Awaited<ReturnType<LlamaContext['getFormattedChat']>>;
    });
    jest.mocked(context.tokenize).mockImplementation(async prompt => {
      countedPrompts.push(prompt);
      jest.setSystemTime(Date.now() + 2000);
      return { tokens: [1] } as Awaited<ReturnType<LlamaContext['tokenize']>>;
    });
    jest.mocked(context.completion).mockImplementation(async params => {
      expect(typeof params.prompt).toBe('string');
      completionPrompts.push(params.prompt ?? '');
      const content = generation ? '{"ok":true}' : 'reply';
      return { text: content, content, tokens_predicted: 3 } as Awaited<ReturnType<LlamaContext['completion']>>;
    });
    await expect(runLocalToolCompletion({
      options: { expectedModelId: model.id, messages: [{ role: 'user', content: 'Question' }], generation },
      threadId: 'clock-chat', runId: 'clock-run', settings: { enabled: true, allowedTools: ['calculate'] },
      assertCurrent: () => undefined, onProgress: () => undefined,
    })).resolves.toMatchObject({ text: generation ? '{"ok":true}' : 'reply' });
    expect(completionPrompts).toHaveLength(generation ? 2 : 1);
    expect(completionPrompts).toEqual(countedPrompts);
    expect(formattedTimes.every(now => now === initialNow)).toBe(true);
  },
);


it('preempts passive readiness while retaining its raw native queue owner until drain', async () => {
  const pending = deferred<void>();
  let started = false;
  let cancelled = () => false;
  const passive = service.contextOperationRunner.track(async cancellation => {
    started = true;
    cancelled = () => cancellation.isCancelled();
    await pending.promise;
  }, () => new Error('Passive operation cancelled'), { chatBlocking: false, priority: 'passive_readiness' }).catch(error => error);
  try {
    await until(() => started);
    lease = llmEngineService.beginLocalToolRun(model.id);
    expect(cancelled()).toBe(true);
    const counting = llmEngineService.countPromptTokens({
      messages: [{ role: 'user', content: 'next' }], runOwner: lease.token,
    });
    await Promise.resolve();
    expect(context.tokenize).not.toHaveBeenCalled();
    expect(context.completion).not.toHaveBeenCalled();
    await expect(llmEngineService.load('other/model')).rejects.toMatchObject({ code: 'engine_busy' });
    pending.resolve();
    await passive;
    await expect(counting).resolves.toBe(1);
    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'next' }], runOwner: lease.token,
    })).resolves.toMatchObject({ text: 'reply' });
    lease.assertCurrent();
  } finally {
    pending.resolve();
    await passive;
  }
});
