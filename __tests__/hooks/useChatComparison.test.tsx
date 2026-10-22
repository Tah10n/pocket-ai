import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { comparisonUnavailableReason, useChatComparison } from '../../src/hooks/useChatComparison';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { __resetChatGenerationServiceForTests, hasActiveChatGenerationWork } from '../../src/services/ChatGenerationService';
import { resetChatStoreForPrivateStorageReset, useChatStore } from '../../src/store/chatStore';
import { EngineStatus } from '../../src/types/models';
import { getPreparedTemplateNow } from '../../src/utils/generationControls';
import { getAppStorage, storage } from '../../src/store/storage';
import { getChatThreadStorageKey, readChatThreadRecord } from '../../src/store/chatPersistence';

jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  getState: jest.fn(), getEffectiveLoadParameters: jest.fn(), getPromptContextIdentity: jest.fn(),
  compareChatCompletions: jest.fn(), stopComparisonVariant: jest.fn(),
} }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  getModel: () => ({ id: 'model', name: 'Tiny text', localPath: 'model.gguf', sha256: 'abc', size: 1024 }),
} }));

type Options = Parameters<typeof llmEngineService.compareChatCompletions>[0];
type Outcomes = Awaited<ReturnType<typeof llmEngineService.compareChatCompletions>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ephemeral two-answer comparison through the real history store', () => {
  let threadId: string;
  let pending: ReturnType<typeof deferred<Outcomes>>;
  let options: Options;
  beforeEach(() => {
    __resetChatGenerationServiceForTests();
    storage.clearAll();
    resetChatStoreForPrivateStorageReset();
    jest.clearAllMocks();
    jest.mocked(llmEngineService.getState).mockReturnValue({ status: EngineStatus.READY, activeModelId: 'model' } as ReturnType<typeof llmEngineService.getState>);
    jest.mocked(llmEngineService.getEffectiveLoadParameters).mockReturnValue(null);
    jest.mocked(llmEngineService.getPromptContextIdentity).mockReturnValue('restored-context');
    jest.mocked(llmEngineService.stopComparisonVariant).mockResolvedValue(undefined);
    pending = deferred<Outcomes>();
    jest.mocked(llmEngineService.compareChatCompletions).mockImplementation(input => { options = input; return pending.promise; });
    threadId = useChatStore.getState().createThread({
      modelId: 'model', presetId: null, presetSnapshot: { id: null, name: 'Default', systemPrompt: 'Be helpful.' },
      paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 1024, seed: 12 },
    });
    useChatStore.getState().appendMessage(threadId, { id: 'user', role: 'user', content: 'Explain this', createdAt: 1, state: 'complete' });
    const original = useChatStore.getState().createAssistantPlaceholder(threadId, 'model');
    useChatStore.getState().finalizeAssistantTurn(threadId, original, { outcome: 'success', content: 'Original answer' });
  });
  afterEach(() => { __resetChatGenerationServiceForTests(); });

  it('captures one prompt and clock, prevents double start, and writes only the explicit chosen answer', async () => {
    const originalProfile = { contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16' as const, parallelSlots: 1 };
    jest.mocked(llmEngineService.getEffectiveLoadParameters).mockReturnValue(originalProfile);
    jest.mocked(llmEngineService.getState).mockReturnValue({ status: EngineStatus.READY, activeModelId: 'model', diagnostics: {
      comparison: { policy: 'text-comparison-v1', slots: 2, totalContextTokens: 4096, perRequestContextTokens: 2048,
        requiredBytes: 1024, availableBytes: 4096, calibration: 'uncalibrated' },
    } } as ReturnType<typeof llmEngineService.getState>);
    const { result, unmount } = renderHook(() => useChatComparison());
    const before = useChatStore.getState().threads[threadId];
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    await act(async () => { await result.current.start(); });
    expect(llmEngineService.compareChatCompletions).toHaveBeenCalledTimes(1);
    expect(options.messages.map(item => item.content)).toEqual(['Be helpful.', 'Explain this']);
    expect(options.variants[0].params?.seed).not.toBe(options.variants[1].params?.seed);
    expect(options.variants[0].params?.n_predict).toBeLessThanOrEqual(384);
    expect(getPreparedTemplateNow(options.variants[0].generation!)).toEqual(getPreparedTemplateNow(options.variants[1].generation!));
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    act(() => { options.onState?.(1, 'completed'); options.onToken?.(0, 'first partial'); result.current.choose(1); });
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    await act(async () => {
      pending.resolve([{ status: 'success', result: { text: 'First answer' } }, { status: 'success', result: { text: 'Second answer' } }]);
      await run;
    });
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    act(() => { options.onState?.(1, 'error'); options.onToken?.(1, 'late'); });
    expect(result.current.comparison?.variants[1].state).toBe('completed');
    expect(result.current.comparison?.variants[1].content).toBe('Second answer');
    act(() => { result.current.choose(1); result.current.choose(0); });
    expect(useChatStore.getState().threads[threadId].messages.map(message => message.content)).toEqual(['Explain this', 'Second answer']);
    expect(useChatStore.getState().threads[threadId].paramsSnapshot).toEqual(before.paramsSnapshot);
    expect(useChatStore.getState().threads[threadId].messages.at(-1)?.loadProfileSnapshot).toEqual({
      ...originalProfile, contextSize: 4096, parallelSlots: 2,
    });
    expect(originalProfile).toEqual({ contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16', parallelSlots: 1 });
    const persisted = readChatThreadRecord(storage, threadId);
    expect(persisted.ok).toBe(true);
    if (persisted.ok) expect(persisted.value.thread.messages.at(-1)?.loadProfileSnapshot).toEqual({
      ...originalProfile, contextSize: 4096, parallelSlots: 2,
    });
    expect(result.current.comparison).toBeNull();
    unmount();
  });

  it('stops one variant, ignores its late tokens, and retains the other successful result', async () => {
    const { result, unmount } = renderHook(() => useChatComparison());
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    act(() => { options.onState?.(0, 'running'); options.onState?.(1, 'running'); options.onToken?.(0, 'partial'); });
    await act(async () => { await result.current.stop(0); await result.current.stop(0); });
    expect(llmEngineService.stopComparisonVariant).toHaveBeenCalledTimes(1);
    expect(llmEngineService.stopComparisonVariant).toHaveBeenCalledWith(0);
    expect(hasActiveChatGenerationWork()).toBe(true);
    await act(async () => {
      options.onToken?.(0, 'late'); options.onToken?.(1, 'kept');
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    expect(result.current.comparison?.variants[0].content).toBe('partial');
    expect(result.current.comparison?.variants[1].content).toBe('kept');
    await act(async () => { pending.resolve([{ status: 'cancelled' }, { status: 'success', result: { content: 'kept' } }]); await run; });
    act(() => { result.current.choose(1); });
    expect(useChatStore.getState().threads[threadId].messages.at(-1)?.content).toBe('kept');
    expect(hasActiveChatGenerationWork()).toBe(false);
    unmount();
  });

  it('close preserves old history and keeps native ownership until true settlement', async () => {
    const { result, unmount } = renderHook(() => useChatComparison());
    const before = useChatStore.getState().threads[threadId];
    let run!: Promise<void>;
    act(() => { run = result.current.start(); result.current.close(); });
    expect(options.signal?.aborted).toBe(true);
    // Closing cancels execution without revoking the unchanged A restoration target.
    expect(options.isCurrent()).toBe(true);
    expect(result.current.comparison).toBeNull();
    expect(result.current.isBusy).toBe(true);
    expect(hasActiveChatGenerationWork()).toBe(true);
    act(() => { options.onToken?.(0, 'late'); });
    await act(async () => { pending.resolve([{ status: 'cancelled' }, { status: 'cancelled' }]); await run; });
    expect(hasActiveChatGenerationWork()).toBe(false);
    expect(result.current.isBusy).toBe(false);
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    unmount();
  });

  it('admission failure creates no placeholder and releases its generation owner', async () => {
    const { result, unmount } = renderHook(() => useChatComparison());
    const before = useChatStore.getState().threads[threadId];
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    await act(async () => { pending.reject(new Error('native admission rejected')); await run; });
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    expect(result.current.comparison?.errorCode).toBe('action_failed');
    expect(result.current.comparison?.variants.every(variant => variant.state === 'error')).toBe(true);
    expect(hasActiveChatGenerationWork()).toBe(false);
    unmount();
  });

  it.each(['thread', 'branch', 'lora', 'private-reset'] as const)('revokes results when %s ownership changes', async change => {
    const { result, unmount } = renderHook(() => useChatComparison());
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    act(() => {
      if (change === 'thread') useChatStore.setState({ activeThreadId: null });
      if (change === 'branch') useChatStore.getState().appendMessage(threadId, { id: 'new', role: 'user', content: 'new', createdAt: 9, state: 'complete' });
      if (change === 'lora') useChatStore.getState().updateThreadLoraSnapshot(threadId, [{ artifactId: 'adapter', artifactIdentity: 'abc', baseModelIdentity: 'model', scale: 1 }]);
      if (change === 'private-reset') resetChatStoreForPrivateStorageReset();
    });
    expect(options.signal?.aborted).toBe(true);
    expect(options.isCurrent()).toBe(false);
    await act(async () => { pending.resolve([{ status: 'success', result: { text: 'Stale' } }, { status: 'cancelled' }]); await run; });
    act(() => { result.current.choose(0); });
    expect(useChatStore.getState().threads[threadId]?.messages.some(message => message.content === 'Stale')).not.toBe(true);
    unmount();
  });

  it('rejects selection after a same-model context reload', async () => {
    const { result, unmount } = renderHook(() => useChatComparison());
    const before = useChatStore.getState().threads[threadId];
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    await act(async () => { pending.resolve([{ status: 'success', result: { text: 'Result' } }, { status: 'cancelled' }]); await run; });
    jest.mocked(llmEngineService.getPromptContextIdentity).mockReturnValue('new-context');
    act(() => { result.current.choose(0); });
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    unmount();
  });

  it('rolls back an empty replacement when the explicit selection cannot persist', async () => {
    const { result, unmount } = renderHook(() => useChatComparison());
    const before = useChatStore.getState().threads[threadId];
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    await act(async () => { pending.resolve([{ status: 'success', result: { text: 'Result' } }, { status: 'cancelled' }]); await run; });
    const original = useChatStore.getState().finalizeAssistantTurn;
    const commit = jest.spyOn(useChatStore.getState(), 'finalizeAssistantTurn');
    commit.mockImplementationOnce((id, messageId, finalization) => ({ status: 'persistence_failed', error: new Error('write failed'),
      recovery: { threadId: id, messageId, finalization } }));
    commit.mockImplementation(original);
    // A one-shot failure leaves the normal stop finalizer available to restore the old branch.
    act(() => { result.current.choose(0); });
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    expect(result.current.comparison?.errorCode).toBe('storage_private_unavailable');
    commit.mockRestore();
    act(() => { useChatStore.setState({ finalizeAssistantTurn: original }); });
    unmount();
  });

  it('restores old visible and durable history when selected-answer storage writes keep failing', async () => {
    const { result, unmount } = renderHook(() => useChatComparison());
    const before = useChatStore.getState().threads[threadId];
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    await act(async () => { pending.resolve([{ status: 'success', result: { text: 'Cannot persist this' } }, { status: 'cancelled' }]); await run; });
    const appStorage = getAppStorage();
    const originalSet = appStorage.set;
    appStorage.set = (key, value) => {
      if (key === getChatThreadStorageKey(threadId)) throw new Error('Storage write unavailable');
      originalSet.call(appStorage, key, value);
    };
    try {
      act(() => { result.current.choose(0); });
      expect(useChatStore.getState().threads[threadId]).toBe(before);
      expect(useChatStore.getState().getThread(threadId)?.messages).toEqual(before.messages);
      expect(result.current.comparison?.errorCode).toBe('storage_private_unavailable');
    } finally { appStorage.set = originalSet; unmount(); }
  });

  it.each(['json_schema', 'gbnf'] as const)('preserves %s constraints and rejects an independently invalid/incomplete variant', async mode => {
    const thread = useChatStore.getState().threads[threadId];
    const output = mode === 'json_schema'
      ? { mode, schema: '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}' } as const
      : { mode, grammar: 'root ::= "OK"' } as const;
    useChatStore.getState().updateThreadParamsSnapshot(threadId, { ...thread.paramsSnapshot, output, stop: ['END'] });
    const before = useChatStore.getState().threads[threadId];
    const { result, unmount } = renderHook(() => useChatComparison());
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    expect(options.variants[0].generation?.output).toEqual(output);
    expect(options.variants[1].generation?.output).toEqual(output);
    expect(options.variants[0].generation?.stop).toEqual(['END']);
    await act(async () => {
      pending.resolve([
        { status: 'success', result: { content: 'broken', structuredOutput: { mode, status: mode === 'gbnf' ? 'incomplete' : 'invalid' } } },
        { status: 'success', result: { content: mode === 'gbnf' ? 'OK' : '{"ok":true}', structuredOutput: { mode, status: mode === 'gbnf' ? 'not_applicable' : 'valid' } } },
      ]);
      await run;
    });
    act(() => { result.current.choose(0); });
    expect(useChatStore.getState().threads[threadId]).toBe(before);
    act(() => { result.current.choose(1); });
    expect(useChatStore.getState().threads[threadId].messages.at(-1)?.structuredOutput?.status).toBe(mode === 'gbnf' ? 'not_applicable' : 'valid');
    unmount();
  });

  it('cancels on background and unmount without releasing pending native ownership', async () => {
    const spy = jest.spyOn(AppState, 'addEventListener');
    const { result, unmount } = renderHook(() => useChatComparison());
    let run!: Promise<void>;
    act(() => { run = result.current.start(); });
    act(() => { spy.mock.calls.at(-1)?.[1]('background'); });
    expect(options.signal?.aborted).toBe(true);
    unmount();
    expect(hasActiveChatGenerationWork()).toBe(true);
    await act(async () => { pending.resolve([{ status: 'cancelled' }, { status: 'cancelled' }]); await run; });
    expect(hasActiveChatGenerationWork()).toBe(false);
    spy.mockRestore();
  });

  it('gates tools and retrieval without modifying their ordinary chat settings', () => {
    const thread = useChatStore.getState().threads[threadId];
    expect(comparisonUnavailableReason(thread)).toBeNull();
    expect(comparisonUnavailableReason({ ...thread, documentRetrieval: { mode: 'hybrid', rerank: true } })).toBe('textOnly');
    expect(comparisonUnavailableReason({ ...thread, documentRetrieval: { mode: 'lexical', rerank: true } })).toBe('textOnly');
    expect(comparisonUnavailableReason({ ...thread, messages: [{ ...thread.messages[0], contentParts: [{ type: 'input_audio', input_audio: { format: 'wav', url: '/voice.wav' } }] }] })).toBe('textOnly');
  });
});
