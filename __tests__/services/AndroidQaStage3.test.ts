import fixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import { assertAndroidQaCancelledReceipt, assertAndroidQaGeneratedReceipt, assertAndroidQaProbabilityReceipt, getAndroidQaCompletionReceipt, getAndroidQaEffectiveProfileIdentity,
  getAndroidQaStage3Evidence, resetAndroidQaStage3ForTests, runAndroidQaStage3 } from '../../src/services/AndroidQaStage3';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';
import type { LlmChatCompletionOptions } from '../../src/types/chat';
import type { LlamaCompletionResult } from '../../src/services/LlamaRuntimeAdapter';

const mockEnabled = jest.fn(() => true);
const mockStage1 = jest.fn(() => ({ status: 'passed' }));
const mockStage2 = jest.fn(() => ({ status: 'passed' }));
const mockLoad = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockUnload = jest.fn(async () => undefined);
const mockGetState = jest.fn(() => ({ activeModelId: 'qa-chat', status: 'error', diagnostics: {} }));
const mockRestoreThread = jest.fn();
const mockUpdateSettings = jest.fn();
const mockGetModel = jest.fn(() => ({ id: 'qa-chat', downloadIntegrity: { sha256: fixture.base.sha256 } }));
const mockCompletion = jest.fn<Promise<LlamaCompletionResult>, [LlmChatCompletionOptions]>();
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({
  ANDROID_QA_DOCUMENT_MODEL_ID: 'qa-chat', isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled(),
}));
jest.mock('../../src/services/AndroidQaInferenceSmoke', () => ({ getAndroidQaInferenceSmokeEvidence: () => mockStage1() }));
jest.mock('../../src/services/AndroidQaModelResources', () => ({ getAndroidQaModelResourcesEvidence: () => mockStage2() }));
jest.mock('../../src/services/AuxiliaryModelService', () => ({}));
jest.mock('../../src/services/ModelDownloadManager', () => ({}));
jest.mock('../../src/store/downloadStore', () => ({}));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: () => mockGetModel() } }));
jest.mock('../../src/services/SettingsStore', () => ({ getSettings: () => ({ auxiliaryModels: {} }), updateSettings: (value: unknown) => mockUpdateSettings(value) }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({ activeThreadId: 'original', setActiveThread: mockRestoreThread,
  beginNewThread: () => true, createThread: () => 'qa-owned', deleteThread: () => undefined,
}) } }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  load: (...args: unknown[]) => mockLoad(...args), unload: () => mockUnload(),
  getEffectiveLoadParameters: () => ({ contextSize: 512 }), getState: () => mockGetState(),
  hasActiveCompletion: () => false, hasAuxiliaryContextOperation: () => false,
  countPromptTokens: async () => 12, chatCompletion: (options: LlmChatCompletionOptions) => mockCompletion(options),
} }));

describe('Stage 3 QA lifecycle contract (unit tests are not native acceptance)', () => {
  beforeEach(() => {
    jest.clearAllMocks(); jest.useRealTimers(); resetAndroidQaStage3ForTests();
    mockEnabled.mockReturnValue(true); mockStage1.mockReturnValue({ status: 'passed' }); mockStage2.mockReturnValue({ status: 'passed' });
    mockLoad.mockImplementation(async () => undefined);
    mockGetState.mockReturnValue({ activeModelId: 'qa-chat', status: 'error', diagnostics: {} });
    mockGetModel.mockReturnValue({ id: 'qa-chat', downloadIntegrity: { sha256: fixture.base.sha256 } });
  });
  afterEach(() => jest.useRealTimers());
  it('preserves native first-token zero and exports only safe completion metrics', () => {
    const receipt = getAndroidQaCompletionReceipt({ text: 'PRIVATE', content: 'PRIVATE', tokens_predicted: 0,
      tokens_evaluated: 12, stopped_eos: true, stopped_limit: false, interrupted: false }, 1, true);
    expect(() => assertAndroidQaGeneratedReceipt(receipt)).not.toThrow();
    expect(receipt).toMatchObject({ tokensPredicted: 0, callbacks: 1, outputCharacters: 7, contentCharacters: 7,
      stoppedEos: true, stoppedLimit: false, completionDrained: true });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE');
    const missingFlags = getAndroidQaCompletionReceipt({ text: 'x', tokens_predicted: 0 }, 1, true);
    expect(missingFlags.stoppedLimit).toBeUndefined();
    expect(missingFlags.interrupted).toBeUndefined();
    expect(missingFlags.truncated).toBeUndefined();
    expect(missingFlags.contextFull).toBeUndefined();
    for (const invalid of [{ callbacks: 0 }, { outputCharacters: 0 }, { tokensPredicted: -1 }, { tokensPredicted: undefined }, { completionDrained: false }]) {
      expect(() => assertAndroidQaGeneratedReceipt({ ...receipt, ...invalid })).toThrow('assertion');
    }
  });
  const probabilityResult = (): LlamaCompletionResult => ({
    text: '<', content: '<', tokens_predicted: 0, tokens_evaluated: 59,
    stopped_limit: true, stopped_eos: false, stopped_word: false, interrupted: false, truncated: false, context_full: false,
    probabilitiesSummary: { requested: 10, retainedTokens: 1, totalTokens: 1, truncated: false },
    completion_probabilities: [{ content: '<', probs: Array.from({ length: 10 }, (_, index) => ({ tok_str: `PRIVATE-${index}`, prob: 0.05 })) }],
  });
  it('accepts a real final one-token distribution without a visible callback only in probability diagnostics', () => {
    const result = probabilityResult();
    const receipt = assertAndroidQaProbabilityReceipt(result, 0, true);
    expect(receipt).toMatchObject({ callbacks: 0, tokensPredicted: 0, sampledTokens: 1, stoppedLimit: true, completionDrained: true, probabilitiesValidated: true });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE');
    expect(getAndroidQaCompletionReceipt(result, 0, true).probabilitiesValidated).toBeUndefined();
    expect(() => assertAndroidQaGeneratedReceipt(receipt)).toThrow('assertion');
    expect(() => assertAndroidQaProbabilityReceipt({ ...result, text: '', content: '', tokens_predicted: 1 }, 0, true)).not.toThrow();
    expect(() => assertAndroidQaProbabilityReceipt(result, 0, false)).toThrow('assertion');
  });
  it('rejects missing, stale, malformed or non-finite native probability samples even with visible output', () => {
    const result = probabilityResult();
    for (const completion_probabilities of [undefined, [], [...result.completion_probabilities!, ...result.completion_probabilities!]]) {
      expect(() => assertAndroidQaProbabilityReceipt({ ...result, completion_probabilities }, 1, true)).toThrow();
    }
    for (const probability of [NaN, Infinity, -0.1, 1.1, 0]) {
      const invalid = probabilityResult();
      invalid.completion_probabilities![0].probs = invalid.completion_probabilities![0].probs.map(item => ({ ...item, prob: probability }));
      expect(() => assertAndroidQaProbabilityReceipt(invalid, 0, true)).toThrow();
    }
    const incomplete = probabilityResult(); incomplete.completion_probabilities![0].probs.pop();
    expect(() => assertAndroidQaProbabilityReceipt(incomplete, 0, true)).toThrow();
    for (const probabilitiesSummary of [undefined,
      { requested: 0, retainedTokens: 1, totalTokens: 1, truncated: false },
      { requested: 10, retainedTokens: 0, totalTokens: 1, truncated: false },
      { requested: 10, retainedTokens: 1, totalTokens: 2, truncated: false },
      { requested: 10, retainedTokens: 1, totalTokens: 1, truncated: true }]) {
      expect(() => assertAndroidQaProbabilityReceipt({ ...result, probabilitiesSummary }, 0, true)).toThrow();
    }
  });
  it('requires the exact native terminal flags and bounded raw prediction counter for probability proof', () => {
    const result = probabilityResult();
    for (const tokens_predicted of [undefined, -1, 2, 0.5, NaN, Infinity]) {
      expect(() => assertAndroidQaProbabilityReceipt({ ...result, tokens_predicted }, 0, true)).toThrow('assertion');
    }
    for (const key of ['stopped_limit', 'stopped_eos', 'stopped_word', 'interrupted', 'truncated', 'context_full'] as const) {
      expect(() => assertAndroidQaProbabilityReceipt({ ...result, [key]: !result[key] }, 0, true)).toThrow('assertion');
      expect(() => assertAndroidQaProbabilityReceipt({ ...result, [key]: undefined }, 0, true)).toThrow('assertion');
    }
  });
  it('requires native interruption and drained ownership instead of treating normal completion or errors as cancellation', () => {
    const result: LlamaCompletionResult = { text: 'PRIVATE PARTIAL', tokens_predicted: 0, interrupted: true,
      structuredOutput: { mode: 'json_schema', status: 'incomplete', error: 'interrupted' } };
    const receipt = assertAndroidQaCancelledReceipt(result, 1, true, true);
    expect(receipt).toMatchObject({ interrupted: true, completionDrained: true, callbacks: 1, tokensPredicted: 0, structuredIncomplete: true });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE');
    expect(assertAndroidQaCancelledReceipt(result, 1, true, false).structuredIncomplete).toBeUndefined();
    expect(getAndroidQaCompletionReceipt(result, 1, true).structuredIncomplete).toBeUndefined();
    expect(() => assertAndroidQaCancelledReceipt(null, 1, true, true)).toThrow('assertion');
    for (const interrupted of [false, undefined]) {
      expect(() => assertAndroidQaCancelledReceipt({ ...result, interrupted }, 1, true, false)).toThrow('assertion');
      expect(() => assertAndroidQaCancelledReceipt({ ...result, interrupted }, 1, true, true)).toThrow('assertion');
    }
    expect(() => assertAndroidQaCancelledReceipt(result, 0, true, true)).toThrow('assertion');
    expect(() => assertAndroidQaCancelledReceipt(result, 1, false, true)).toThrow('assertion');
  });
  it('requires incomplete JSON Schema validation for structured cancellation, never missing or GBNF metadata', () => {
    const result: LlamaCompletionResult = { text: 'PARTIAL', tokens_predicted: 0, interrupted: true };
    expect(() => assertAndroidQaCancelledReceipt(result, 1, true, true)).toThrow('assertion');
    for (const structuredOutput of [
      { mode: 'json_schema', status: 'valid' }, { mode: 'json_schema', status: 'invalid' },
      { mode: 'gbnf', status: 'not_applicable' }, { mode: 'json_object', status: 'incomplete' },
    ] as const) {
      expect(() => assertAndroidQaCancelledReceipt({ ...result, structuredOutput }, 1, true, true)).toThrow('assertion');
    }
  });
  it('retains zero-counter failure receipts before refusing a completion without callbacks', async () => {
    mockGetState.mockReturnValue({ activeModelId: 'qa-chat', status: 'ready', diagnostics: {
      backendMode: 'cpu', actualGpuAccelerated: false, loadedGpuLayers: 0, initNParallel: 1,
      stateCacheBudgetMb: 0, stateCacheMaxCheckpoints: 8,
    } });
    mockCompletion.mockResolvedValueOnce({ text: 'PRIVATE', content: 'PRIVATE', tokens_predicted: 0,
      tokens_evaluated: 12, stopped_eos: true, stopped_limit: false, interrupted: false });
    await runAndroidQaStage3();
    expect(getAndroidQaStage3Evidence()).toMatchObject({ status: 'failed', phase: 'text', failureCode: 'assertion' });
    expect(getAndroidQaStage3Evidence().steps.find(step => step.id === 'text')).toMatchObject({ status: 'failed',
      callbacks: 0, tokensPredicted: 0, outputCharacters: 7, contentCharacters: 7, completionDrained: true, stoppedEos: true });
    expect(JSON.stringify(getAndroidQaStage3Evidence())).not.toContain('PRIVATE');
  });
  it('compares the complete applied profile across auxiliary restore, preserving values and adapter order', () => {
    const adapter = { artifactId: 'qa', artifactIdentity: 'source', baseModelIdentity: 'base', scale: 0.5, sizeBytes: 64 };
    const profile: ModelLoadParameters = { contextSize: 512, gpuLayers: 0, kvCacheType: 'f16', backendPolicy: 'cpu',
      cpuThreads: 4, nBatch: 128, selectedBackendDevices: [], noExtraBufts: false, loraAdapters: [adapter, { ...adapter, artifactId: 'second' }] };
    const identity = getAndroidQaEffectiveProfileIdentity(profile);
    expect(getAndroidQaEffectiveProfileIdentity({ ...profile, cpuMask: undefined,
      loraAdapters: [{ sizeBytes: 64, scale: 0.5, baseModelIdentity: 'base', artifactIdentity: 'source', artifactId: 'qa' }, { ...adapter, artifactId: 'second' }] })).toBe(identity);
    const changes: Partial<ModelLoadParameters>[] = [
      { contextSize: 1024 }, { gpuLayers: 1 }, { backendPolicy: 'gpu' }, { cpuThreads: 2 }, { nBatch: 64 },
      { selectedBackendDevices: null }, { noExtraBufts: undefined }, { noExtraBufts: true },
      { loraAdapters: [{ ...adapter, scale: 1 }, { ...adapter, artifactId: 'second' }] },
      { loraAdapters: [{ ...adapter, artifactId: 'second' }, adapter] },
    ];
    for (const change of changes) expect(getAndroidQaEffectiveProfileIdentity({ ...profile, ...change })).not.toBe(identity);
    expect(() => getAndroidQaEffectiveProfileIdentity(null)).toThrow('assertion');
  });
  it('is inert outside the isolated QA gate', async () => {
    mockEnabled.mockReturnValue(false);
    await runAndroidQaStage3();
    expect(getAndroidQaStage3Evidence().status).toBe('idle'); expect(mockLoad).not.toHaveBeenCalled();
  });
  it.each(['stage1', 'stage2', 'identity'])('does not touch the context before the %s precondition is confirmed', async failure => {
    if (failure === 'stage1') mockStage1.mockReturnValue({ status: 'failed' });
    if (failure === 'stage2') mockStage2.mockReturnValue({ status: 'running' });
    if (failure === 'identity') mockGetModel.mockReturnValue({ id: 'qa-chat', downloadIntegrity: { sha256: 'unverified' } });
    await runAndroidQaStage3();
    expect(getAndroidQaStage3Evidence()).toMatchObject({ status: 'failed', failureCode: 'precondition' });
    expect(getAndroidQaStage3Evidence().steps.every(step => step.status === 'not_run')).toBe(true);
    expect(mockLoad).not.toHaveBeenCalled(); expect(mockUnload).not.toHaveBeenCalled(); expect(mockRestoreThread).not.toHaveBeenCalled();
  });
  it('holds uncertain native work after timeout and ignores a late successful settlement', async () => {
    jest.useFakeTimers();
    let resolveLoad: () => void = () => undefined;
    mockLoad.mockImplementationOnce(() => new Promise<void>(resolve => { resolveLoad = resolve; }));
    const pending = runAndroidQaStage3({ operationTimeoutMs: 20 });
    expect(runAndroidQaStage3()).toBe(pending);
    await jest.advanceTimersByTimeAsync(21); await pending;
    expect(getAndroidQaStage3Evidence()).toMatchObject({ status: 'failed', phase: 'cpu_load', requiresForceStop: true, failureCode: 'timeout' });
    expect(mockLoad).toHaveBeenCalledTimes(1); expect(mockUnload).not.toHaveBeenCalled(); expect(mockRestoreThread).not.toHaveBeenCalled();
    resolveLoad(); await Promise.resolve(); await Promise.resolve();
    expect(getAndroidQaStage3Evidence().status).toBe('failed');
    expect(mockLoad).toHaveBeenCalledTimes(1); expect(mockUpdateSettings).not.toHaveBeenCalled();
  });
  it('restores the original confirmed load profile after a settled assertion failure', async () => {
    await runAndroidQaStage3();
    expect(getAndroidQaStage3Evidence()).toMatchObject({ status: 'failed', failureCode: 'assertion', requiresForceStop: false });
    expect(mockLoad).toHaveBeenLastCalledWith('qa-chat', { forceReload: true, loadParamsOverride: { contextSize: 512 } });
    expect(mockRestoreThread).toHaveBeenCalledWith('original');
    expect(mockUpdateSettings).toHaveBeenCalledWith({ auxiliaryModels: {} });
  });
});
