import type { ChatMessage, ChatThread, LlmChatCompletionOptions } from '../../src/types/chat';
import type { llmEngineService } from '../../src/services/LLMEngineService';
import {
  getAndroidQaInferenceSmokeEvidence,
  resetAndroidQaInferenceSmokeForTests,
  runAndroidQaInferenceSmoke,
} from '../../src/services/AndroidQaInferenceSmoke';

jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {} }));
const mockGetModel = jest.fn();
jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: { getModel: () => mockGetModel() },
}));
const mockEnabled = jest.fn(() => true);
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({
  ANDROID_QA_DOCUMENT_MODEL_ID: 'qa-model',
  ANDROID_QA_DOCUMENT_MODEL_SHA256: 'verified-digest',
  isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled(),
}));
let mockThreads: Record<string, ChatThread> = {};
let mockActiveId: string | null = null;
let mockNextThread = 0;
jest.mock('../../src/store/chatStore', () => ({
  useChatStore: { getState: () => ({
    threads: mockThreads,
    activeThreadId: mockActiveId,
    beginNewThread: () => { mockActiveId = null; return true; },
    createThread: (input: Omit<ChatThread, 'id' | 'messages' | 'createdAt' | 'updatedAt' | 'status'>) => {
      const id = `thread-${++mockNextThread}`;
      mockThreads[id] = { ...input, id, messages: [], createdAt: 1, updatedAt: 1, status: 'idle' };
      mockActiveId = id;
      return id;
    },
    appendMessage: (id: string, message: ChatMessage) => { mockThreads[id].messages.push(message); },
    deleteThread: (id: string) => { delete mockThreads[id]; },
    setActiveThread: (id: string | null) => { mockActiveId = id; return true; },
  }) },
}));

type Engine = Pick<typeof llmEngineService,
  'getBackendAvailability' | 'load' | 'unload' | 'chatCompletion' | 'stopCompletion'
  | 'hasActiveCompletion' | 'getState'>;

function makeEngine() {
  let active = false;
  let loaded = false;
  let cancelReject: ((error: Error) => void) | undefined;
  const events: string[] = [];
  const engine = {
    getBackendAvailability: jest.fn(async () => ({ discoveryUnavailable: false, devices: [] })),
    load: jest.fn(async () => { events.push('load'); loaded = true; }),
    unload: jest.fn(async () => { events.push('unload'); loaded = false; }),
    getState: jest.fn(() => ({ activeModelId: loaded ? 'qa-model' : undefined, diagnostics: {
      backendMode: 'cpu', actualGpuAccelerated: false, loadedGpuLayers: 0,
      initNParallel: 1, stateCacheBudgetMb: 0, stateCacheMaxCheckpoints: 8,
    } })),
    hasActiveCompletion: jest.fn(() => active),
    chatCompletion: jest.fn((request: LlmChatCompletionOptions) => {
      active = true;
      events.push('generate');
      if (request.params?.n_predict === 256) {
        return new Promise((_, reject) => {
          cancelReject = reject;
          request.onToken?.({ token: 'one' });
        });
      }
      request.onToken?.({ token: 'dog' });
      active = false;
      return Promise.resolve({ text: 'A friendly dog.', tokens_predicted: 4, tokens_evaluated: 12 });
    }),
    stopCompletion: jest.fn(async () => {
      events.push('stop');
      cancelReject?.(new Error('stopped'));
      active = false;
    }),
  };
  return { engine, events, options: { engine: engine as unknown as Engine } };
}

describe('explicit Android inference smoke contract (native proof is separate)', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    resetAndroidQaInferenceSmokeForTests();
    mockEnabled.mockReturnValue(true);
    mockGetModel.mockReturnValue({ localPath: 'qa.gguf',
      downloadIntegrity: { kind: 'sha256', sha256: 'verified-digest' } });
    mockThreads = {};
    mockActiveId = null;
    mockNextThread = 0;
  });
  afterEach(() => { jest.useRealTimers(); });

  it('drains cancellation before subsequent generation and proves a new store chat has fresh input', async () => {
    const { engine, events, options } = makeEngine();
    await runAndroidQaInferenceSmoke(options);
    expect(getAndroidQaInferenceSmokeEvidence()).toMatchObject({ status: 'passed', requiresForceStop: false });
    expect(events).toEqual(['load', 'generate', 'generate', 'stop', 'generate', 'generate',
      'unload', 'load', 'generate']);
    const freshRequest = engine.chatCompletion.mock.calls[3][0];
    expect(freshRequest.messages.filter((message) => message.role !== 'system')).toHaveLength(1);
    expect(freshRequest.expectedModelId).toBe('qa-model');
    expect(mockNextThread).toBe(2);
    expect(Object.keys(mockThreads)).toHaveLength(0);
    expect(JSON.stringify(getAndroidQaInferenceSmokeEvidence())).not.toContain('friendly dog');
  });

  it('does nothing outside the explicit QA build gate', async () => {
    const { engine, options } = makeEngine();
    mockEnabled.mockReturnValue(false);
    await runAndroidQaInferenceSmoke(options);
    expect(engine.load).not.toHaveBeenCalled();
    expect(getAndroidQaInferenceSmokeEvidence().status).toBe('idle');
  });

  it('fails missing verified model without starting native work', async () => {
    const { engine, options } = makeEngine();
    mockGetModel.mockReturnValue(null);
    await runAndroidQaInferenceSmoke(options);
    expect(getAndroidQaInferenceSmokeEvidence()).toMatchObject({ status: 'failed', failureCode: 'verified_model_missing' });
    expect(engine.load).not.toHaveBeenCalled();
  });

  it.each(['callbacks', 'native counters'] as const)('rejects missing %s as native generation evidence', async (missing) => {
    const { engine, options } = makeEngine();
    engine.chatCompletion.mockImplementation(async (request) => {
      if (missing !== 'callbacks') request.onToken?.({ token: 'text' });
      return { text: 'text', tokens_predicted: missing === 'native counters' ? 0 : 1, tokens_evaluated: 1 };
    });
    await runAndroidQaInferenceSmoke(options);
    expect(getAndroidQaInferenceSmokeEvidence()).toMatchObject({ status: 'failed', failureCode: 'no_real_generation' });
    expect(engine.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('times out native load and never unloads or starts another context', async () => {
    jest.useFakeTimers();
    const { engine, options } = makeEngine();
    engine.load.mockImplementation(() => new Promise(() => undefined));
    const run = runAndroidQaInferenceSmoke({ ...options, operationTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(110);
    await run;
    expect(getAndroidQaInferenceSmokeEvidence()).toMatchObject({ status: 'failed', failureCode: 'timeout', requiresForceStop: true });
    expect(engine.unload).not.toHaveBeenCalled();
    expect(engine.chatCompletion).not.toHaveBeenCalled();
    await runAndroidQaInferenceSmoke(options);
    expect(engine.load).toHaveBeenCalledTimes(1);
  });

  it('fails bounded cancellation without subsequent completion or reload', async () => {
    jest.useFakeTimers();
    const { engine, options } = makeEngine();
    engine.stopCompletion.mockImplementation(() => new Promise(() => undefined));
    const run = runAndroidQaInferenceSmoke({ ...options, stopTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(110);
    await run;
    expect(getAndroidQaInferenceSmokeEvidence()).toMatchObject({ status: 'failed', phase: 'stop_after_token', requiresForceStop: true });
    expect(engine.chatCompletion).toHaveBeenCalledTimes(2);
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(engine.unload).not.toHaveBeenCalled();
  });

  it.each([false, true])('waits for the native driver after public cancellation settles (stuck=%s)', async (stuck) => {
    jest.useFakeTimers();
    const { engine, events, options } = makeEngine();
    const originalActive = engine.hasActiveCompletion.getMockImplementation()!;
    let drained = false;
    engine.hasActiveCompletion.mockImplementation(() => (
      events.includes('stop') && !drained ? true : originalActive()
    ));
    const run = runAndroidQaInferenceSmoke({ ...options, stopTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(10);
    expect(engine.stopCompletion).toHaveBeenCalledTimes(1);
    expect(engine.chatCompletion).toHaveBeenCalledTimes(2);
    if (!stuck) drained = true;
    await jest.advanceTimersByTimeAsync(110);
    await run;
    expect(getAndroidQaInferenceSmokeEvidence().status).toBe(stuck ? 'failed' : 'passed');
    expect(engine.chatCompletion).toHaveBeenCalledTimes(stuck ? 2 : 5);
    if (stuck) {
      expect(engine.unload).not.toHaveBeenCalled();
      expect(getAndroidQaInferenceSmokeEvidence().requiresForceStop).toBe(true);
    }
    expect(jest.getTimerCount()).toBe(0);
  });
});
