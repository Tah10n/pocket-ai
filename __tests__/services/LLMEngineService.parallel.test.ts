import type { ContextParams, LlamaContext, ParallelStatus, TokenData } from 'llama.rn';
import { initLlama, releaseAllLlama } from 'llama.rn';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';
import { isPrivateStorageWritable } from '../../src/services/storage';
import { EngineStatus, type EngineState, type ModelMetadata } from '../../src/types/models';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';
import type { ActiveCompletionRunner, ContextOperationRunner } from '../../src/services/LLMEngineService.runners';
import { admitComparisonMemory, buildComparisonNativeProfile } from '../../src/services/LLMEngineService.parallel';

jest.mock('llama.rn', () => ({ initLlama: jest.fn(), releaseAllLlama: jest.fn(async () => undefined),
  BuildInfo: { number: 'test', commit: 'test' } }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: jest.fn(), updateModel: jest.fn() } }));
jest.mock('../../src/services/SystemMetricsService', () => ({ getFreshMemorySnapshot: jest.fn() }));
jest.mock('../../src/services/storage', () => ({ isPrivateStorageWritable: jest.fn(() => true) }));
jest.mock('../../src/services/SettingsStore', () => ({
  ...jest.requireActual('../../src/services/SettingsStore'), getModelLoadParametersForModel: jest.fn(() => ({})),
}));

type TestAccess = {
  state: EngineState; context: LlamaContext | null;
  updateState(state: EngineState): void;
  setContext(context: LlamaContext | null): void;
  activeNativeInitParams: ContextParams | null;
  effectiveLoadParameters: ModelLoadParameters | null;
  activeContextSize: number; activeGpuLayers: number | null;
  activeLoraAdapters: { path: string; scaled: number }[];
  loadedArtifactIdentity: Record<string, unknown> | null;
  activeMultimodalContext: null;
  contextOperationRunner: ContextOperationRunner;
  completionRunner: ActiveCompletionRunner<object>;
  auxiliaryOperation: object | null;
  comparisonOperation: object | null;
  orphanedContextReleaseError: Error | null;
  orphanedContextReleasePromise: Promise<void> | null;
  loadWithProjectorResolutionOperationCache(modelId: string, options: { loadParamsOverride: ModelLoadParameters }): Promise<void>;
};
const service = llmEngineService as unknown as TestAccess;
const metadata = { 'general.architecture': 'llama', 'tokenizer.ggml.model': 'llama',
  'llama.block_count': 8, 'llama.embedding_length': 256,
  'llama.attention.head_count': 4, 'llama.attention.head_count_kv': 2 };
const model = { id: 'a', localPath: 'a.gguf', resolvedFileName: 'a.gguf', sha256: 'a-hash' } as ModelMetadata;
const profile: ModelLoadParameters = { contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16', backendPolicy: 'cpu', parallelSlots: 1,
  loraAdapters: [{ artifactId: 'adapter', artifactIdentity: 'adapter-bytes', baseModelIdentity: 'a-bytes', scale: 0.5, sizeBytes: 1024 }] };
const nativeProfile: ContextParams = { model: '/a.gguf', n_ctx: 2048, n_parallel: 1, n_gpu_layers: 0,
  n_batch: 128, n_ubatch: 64, cache_type_k: 'f16', cache_type_v: 'f16', use_mmap: true };
const artifact = { resolvedPath: '/a.gguf', localPath: 'a.gguf', sizeBytes: 128 * 1024 * 1024, modificationTime: 1, fallbackDownloadMarker: null };
const snapshot = { timestampMs: 1, platform: 'android' as const, totalBytes: 8 * 1024 ** 3,
  availableBytes: 6 * 1024 ** 3, freeBytes: 5 * 1024 ** 3, usedBytes: 2 * 1024 ** 3,
  appUsedBytes: 128 * 1024 ** 2, thresholdBytes: 256 * 1024 ** 2, lowMemory: false, pressureLevel: 'normal' as const };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 150 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}
let events: string[];
let restore: jest.SpyInstance;
const jobs: { id: number; result: ReturnType<typeof deferred<{ text: string; content?: string }>>;
  admission: ReturnType<typeof deferred<{ requestId: number; promise: Promise<{ text: string; content?: string }>; stop: () => Promise<void> }>>;
  stop: jest.Mock; token: (id: number, data: TokenData) => void }[] = [];
function context(): LlamaContext {
  const live = new Set<number>();
  return {
    model: { metadata },
    getLoadedLoraAdapters: jest.fn(async () => [{ path: '/adapter.gguf', scaled: 0.5 }]),
    getFormattedChat: jest.fn(async (_messages, _template, options) => {
      events.push('format'); return { type: 'jinja', prompt: 'prepared', additional_stops: [], now: options?.now };
    }),
    tokenize: jest.fn(async () => { events.push('tokenize'); return { tokens: [1, 2] }; }),
    release: jest.fn(async () => { events.push('release-comparison'); }),
    stopCompletion: jest.fn(async () => undefined),
    parallel: {
      enable: jest.fn(async () => { events.push('enable'); }), disable: jest.fn(async () => { events.push('disable'); }),
      configure: jest.fn(async () => undefined),
      getStatus: jest.fn(async (): Promise<ParallelStatus> => ({ n_parallel: 2, active_slots: live.size, queued_requests: 0,
        requests: [...live].map(id => ({ request_id: id, type: 'completion', state: 'generating',
          prompt_length: 2, tokens_generated: 0, prompt_ms: 0, generation_ms: 0, tokens_per_second: 0 })),
      })),
      subscribeToStatus: jest.fn(async () => ({ remove: jest.fn(() => { events.push('unsubscribe'); }) })),
      completion: jest.fn((_params, callback) => {
        events.push('admit');
        const id = jobs.length;
        const result = deferred<{ text: string; content?: string }>();
        const admission = deferred<{ requestId: number; promise: Promise<{ text: string; content?: string }>; stop: () => Promise<void> }>();
        const stop = jest.fn(async () => { events.push(`stop:${id}`); });
        live.add(id);
        void result.promise.then(() => live.delete(id), () => live.delete(id));
        jobs.push({ id, result, admission, stop, token: callback });
        return admission.promise;
      }),
    },
  } as unknown as LlamaContext;
}
function restoreA() {
  service.setContext(context());
  service.state = { status: EngineStatus.READY, activeModelId: model.id, loadProgress: 1 };
  service.effectiveLoadParameters = { ...profile };
  service.activeNativeInitParams = { ...nativeProfile };
  service.activeContextSize = 2048;
  service.activeGpuLayers = 0;
  service.loadedArtifactIdentity = { ...artifact };
  service.activeLoraAdapters = [{ path: '/adapter.gguf', scaled: 0.5 }];
}
function admit(index: number) {
  const job = jobs[index];
  job.admission.resolve({ requestId: job.id, promise: job.result.promise, stop: job.stop });
}
function compare(extra: Partial<Parameters<typeof llmEngineService.compareChatCompletions>[0]> = {}) {
  return llmEngineService.compareChatCompletions({ expectedModelId: model.id,
    messages: [{ role: 'user', content: 'hello' }], variants: [{ params: { seed: 1, n_predict: 32 } }, { params: { seed: 2, n_predict: 32 } }],
    isCurrent: () => true, ...extra });
}

beforeEach(() => {
  jest.clearAllMocks(); events = []; jobs.length = 0;
  service.contextOperationRunner.reset(); service.completionRunner.reset();
  service.auxiliaryOperation = null; service.comparisonOperation = null;
  service.orphanedContextReleaseError = null; service.orphanedContextReleasePromise = null;
  restoreA();
  jest.mocked(registry.getModel).mockReturnValue(model);
  jest.mocked(isPrivateStorageWritable).mockReturnValue(true);
  jest.mocked(getFreshMemorySnapshot).mockResolvedValue(snapshot);
  jest.mocked(initLlama).mockImplementation(async () => context());
  jest.mocked(releaseAllLlama).mockImplementation(async () => { events.push('release-a'); });
  restore = jest.spyOn(service, 'loadWithProjectorResolutionOperationCache').mockImplementation(async () => { events.push('restore-a'); restoreA(); });
});
afterEach(async () => {
  await llmEngineService.unload();
  jest.restoreAllMocks(); jest.useRealTimers();
});

it('prepares both requests before decoding, isolates out-of-order results, and restores exact A+LoRA', async () => {
  const token = jest.fn();
  const result = compare({ onToken: token });
  await until(() => jobs.length === 2);
  expect(events.slice(0, 6)).toEqual(['release-a', 'format', 'tokenize', 'tokenize', 'enable', 'admit']);
  // Identical formatting reuses PreparedLlamaRequest; both token counts still finish before admission.
  expect(jest.mocked(initLlama).mock.calls[0][0]).toMatchObject({ n_parallel: 2, n_ctx: 4096,
    lora_list: [{ path: '/adapter.gguf', scaled: 0.5 }], state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 });
  jobs[1].token(1, { token: 'second', content: 'second' } as TokenData);
  admit(1); admit(0); jobs[1].result.resolve({ text: 'second' });
  await until(() => token.mock.calls.length === 1);
  expect(token.mock.calls[0][0]).toBe(1);
  expect(restore).not.toHaveBeenCalled();
  expect(() => llmEngineService.assertModelResourcesIdle(['/a.gguf'])).toThrow();
  await expect(llmEngineService.load('other')).rejects.toMatchObject({ code: 'engine_busy' });
  jobs[0].result.resolve({ text: 'first' });
  await expect(result).resolves.toEqual([{ status: 'success', result: expect.objectContaining({ text: 'first' }) },
    { status: 'success', result: expect.objectContaining({ text: 'second' }) }]);
  expect(restore.mock.calls[0][1].loadParamsOverride).toEqual(profile);
  expect(events.slice(-4)).toEqual(['unsubscribe', 'disable', 'release-comparison', 'restore-a']);
  expect(llmEngineService.getState().diagnostics?.comparison).toMatchObject({ slots: 2, perRequestContextTokens: 2048,
    totalContextTokens: 4096, calibration: 'uncalibrated' });
  await until(() => service.comparisonOperation === null);
  service.updateState({ ...service.state, activeModelId: 'other-model' });
  expect(llmEngineService.getState().diagnostics?.comparison).toBeUndefined();
});

it('Stop before native ID cancels only the selected variant and waits for its actual result', async () => {
  const token = jest.fn();
  const result = compare({ onToken: token });
  await until(() => jobs.length === 2);
  await llmEngineService.stopComparisonVariant(0);
  jobs[0].token(0, { token: 'late' } as TokenData);
  admit(0); admit(1);
  await until(() => jobs[0].stop.mock.calls.length === 1);
  expect(jobs[1].stop).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  jobs[1].result.resolve({ text: 'second survives' });
  expect(restore).not.toHaveBeenCalled();
  jobs[0].result.resolve({ text: 'discarded partial' });
  await expect(result).resolves.toEqual([{ status: 'cancelled' },
    { status: 'success', result: expect.objectContaining({ text: 'second survives' }) }]);
});

it('one admission failure does not release the other native job', async () => {
  const result = compare(); await until(() => jobs.length === 2);
  // No admitted work exists for the rejection, unlike a native terminal error.
  jobs[0].result.resolve({ text: '' }); jobs[0].admission.reject(new Error('admission failed')); admit(1);
  await Promise.resolve(); expect(restore).not.toHaveBeenCalled();
  jobs[1].result.resolve({ text: 'survivor' });
  await expect(result).resolves.toEqual([{ status: 'error', error: expect.any(Error) },
    { status: 'success', result: expect.objectContaining({ text: 'survivor' }) }]);
});

it('rejects injected prompt or parser parameters before unloading A', async () => {
  const injected = { n_predict: 32, prompt: 'unformatted', chat_parser: 'foreign' };
  await expect(compare({ variants: [{ params: injected }, { params: { n_predict: 32 } }] }))
    .rejects.toMatchObject({ code: 'action_failed' });
  expect(initLlama).not.toHaveBeenCalled();
  expect(releaseAllLlama).not.toHaveBeenCalled();
  expect(jobs).toHaveLength(0);
});

it('rejects an interrupted GBNF answer without discarding its completed neighbour', async () => {
  const result = compare({ variants: [
    { params: { n_predict: 32 }, generation: { output: { mode: 'gbnf', grammar: 'root ::= "ok"' } } },
    { params: { n_predict: 32 } },
  ] });
  await until(() => jobs.length === 2);
  admit(0); admit(1);
  jobs[0].result.resolve({ text: 'o', interrupted: true } as { text: string });
  jobs[1].result.resolve({ text: 'second' });
  await expect(result).resolves.toEqual([{ status: 'error', error: expect.any(Error) },
    { status: 'success', result: expect.objectContaining({ text: 'second' }) }]);
  expect(restore).toHaveBeenCalledTimes(1);
});

it('rejects an unknown two-slot budget before native init and restores A', async () => {
  jest.mocked(getFreshMemorySnapshot).mockResolvedValue(null);
  await expect(compare()).rejects.toMatchObject({ code: 'model_memory_insufficient' });
  expect(initLlama).not.toHaveBeenCalled(); expect(restore).toHaveBeenCalledTimes(1);
});

it('uses total KV allocation, rejects insufficient free memory, and never changes the saved single-slot profile', () => {
  const params = buildComparisonNativeProfile(nativeProfile, 2048);
  expect(params).toMatchObject({ n_ctx: 4096, n_parallel: 2 });
  expect(nativeProfile).toMatchObject({ n_ctx: 2048, n_parallel: 1 });
  expect(admitComparisonMemory({ params, metadata, modelBytes: artifact.sizeBytes, loraBytes: 1024, snapshot }))
    .toMatchObject({ totalContextTokens: 4096, perRequestContextTokens: 2048, calibration: 'uncalibrated' });
  expect(() => admitComparisonMemory({ params, metadata, modelBytes: artifact.sizeBytes, loraBytes: 1024,
    snapshot: { ...snapshot, freeBytes: 32 * 1024 ** 2 } })).toThrow();
  expect(() => buildComparisonNativeProfile({ ...nativeProfile, n_gpu_layers: 12 }, 2048)).toThrow();
  const admitMemory = (n_batch: number, n_ubatch: number) => admitComparisonMemory({
    params: { ...params, n_batch, n_ubatch }, metadata, modelBytes: artifact.sizeBytes, loraBytes: 1024, snapshot,
  });
  expect(admitMemory(512, 512).requiredBytes).toBeGreaterThan(admitMemory(128, 64).requiredBytes);
  expect(() => admitMemory(4096, 4096)).toThrow();
});

it('prepares independent JSON Schema and GBNF parser/grammar states and validates each final result', async () => {
  const transient = context(); jest.mocked(initLlama).mockResolvedValueOnce(transient);
  const result = compare({ variants: [
    { params: { n_predict: 32 }, generation: { output: { mode: 'json_schema', schema: JSON.stringify({
      type: 'object', properties: { answer: { const: 'A' } }, required: ['answer'], additionalProperties: false }) } } },
    { params: { n_predict: 32 }, generation: { output: { mode: 'gbnf', grammar: 'root ::= "B"' } } },
  ] });
  await until(() => jobs.length === 2);
  const calls = jest.mocked(transient.parallel.completion).mock.calls;
  expect(calls[0][0]).toMatchObject({ grammar: '', chat_parser: '', chat_format: 0 });
  expect(calls[0][0].json_schema).toContain('answer');
  expect(calls[1][0]).toMatchObject({ grammar: 'root ::= "B"', chat_parser: '', chat_format: 0 });
  expect(calls[1][0].json_schema).toBeUndefined();
  admit(0); admit(1);
  jobs[0].result.resolve({ text: '{"answer":"wrong"}' }); jobs[1].result.resolve({ text: 'B' });
  await expect(result).resolves.toEqual([{ status: 'error', error: expect.any(Error) },
    { status: 'success', result: expect.objectContaining({ text: 'B', structuredOutput: { mode: 'gbnf', status: 'not_applicable' } }) }]);
});

it('close cancels both variants, drains their real terminal results and then restores A', async () => {
  const abort = new AbortController();
  const result = compare({ signal: abort.signal });
  const failure = expect(result).rejects.toMatchObject({ code: 'engine_busy' });
  await until(() => jobs.length === 2); admit(0); admit(1); abort.abort();
  await until(() => jobs.every(job => job.stop.mock.calls.length === 1));
  expect(restore).not.toHaveBeenCalled();
  jobs[0].result.resolve({ text: 'late0' }); jobs[1].result.resolve({ text: 'late1' });
  await failure; expect(restore).toHaveBeenCalledTimes(1);
});

it('missing native terminal callback quarantines ownership instead of releasing or restoring', async () => {
  jest.useFakeTimers();
  const result = compare();
  const failure = expect(result).rejects.toMatchObject({ code: 'engine_recovery_required' });
  try {
    await until(() => jobs.length === 2); admit(0); admit(1);
    jobs[1].result.resolve({ text: 'done' });
    await jest.advanceTimersByTimeAsync(120_001);
    await failure;
    expect(events).not.toContain('release-comparison'); expect(restore).not.toHaveBeenCalled();
    expect(service.comparisonOperation).not.toBeNull();
    expect(() => llmEngineService.assertModelResourcesIdle(['/a.gguf'])).toThrow();
    await llmEngineService.stopComparisonVariant(0);
    expect(jobs[0].stop).toHaveBeenCalledTimes(1);
  } finally {
    jobs[0].result.resolve({ text: 'late' });
    await until(() => events.includes('release-comparison'));
    if (service.orphanedContextReleasePromise) await service.orphanedContextReleasePromise;
    service.orphanedContextReleaseError = null;
  }
});
