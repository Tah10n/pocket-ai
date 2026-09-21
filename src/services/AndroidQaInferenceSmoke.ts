import { useChatStore } from '../store/chatStore';
import { createChatId, DEFAULT_PRESET_SNAPSHOT } from '../types/chat';
import { getThreadInferenceWindow } from '../utils/inferenceWindow';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import {
  ANDROID_QA_DOCUMENT_MODEL_ID,
  ANDROID_QA_DOCUMENT_MODEL_SHA256,
  isAndroidQaDocumentModelBootstrapEnabled,
} from './AndroidQaDocumentModelBootstrap';

type Engine = Pick<typeof llmEngineService,
  'getBackendAvailability' | 'load' | 'unload' | 'chatCompletion' | 'stopCompletion'
  | 'hasActiveCompletion' | 'getState'>;
type Step = {
  id: string;
  status: 'passed';
  callbacks?: number;
  outputCharacters?: number;
  tokensPredicted?: number;
  tokensEvaluated?: number;
  inputMessages?: number;
  backendMode?: string;
  loadedGpuLayers?: number;
  actualGpuAccelerated?: boolean;
  discoveredDeviceCount?: number;
};
export type AndroidQaInferenceSmokeEvidence = {
  schemaVersion: 1;
  status: 'idle' | 'running' | 'passed' | 'failed';
  phase: string;
  failureCode?: string;
  requiresForceStop: boolean;
  steps: Step[];
};

const listeners = new Set<() => void>();
const initialEvidence = (): AndroidQaInferenceSmokeEvidence => ({
  schemaVersion: 1, status: 'idle', phase: 'idle', requiresForceStop: false, steps: [],
});
let evidence = initialEvidence();
let activeRun: Promise<void> | null = null;
export const getAndroidQaInferenceSmokeEvidence = () => evidence;
export function subscribeAndroidQaInferenceSmoke(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(patch: Partial<AndroidQaInferenceSmokeEvidence>): void {
  evidence = { ...evidence, ...patch };
  listeners.forEach((listener) => listener());
}
class SmokeFailure extends Error {
  constructor(readonly code: string, readonly requiresForceStop = false) { super(code); }
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SmokeFailure(code);
}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmokeFailure('timeout', true)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const positiveInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
);

/** Fixed, explicitly invoked QA only. Never exports prompts, generated text, paths, or native logs. */
export function runAndroidQaInferenceSmoke(options: {
  engine?: Engine;
  operationTimeoutMs?: number;
  stopTimeoutMs?: number;
} = {}): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled()) return Promise.resolve();
  if (activeRun) return activeRun;
  // A failed native operation can still be running: only a new process may retry.
  if (evidence.status !== 'idle') return Promise.resolve();
  activeRun = execute(options).finally(() => { activeRun = null; });
  return activeRun;
}

async function execute({
  engine = llmEngineService,
  operationTimeoutMs = 120_000,
  stopTimeoutMs = 15_000,
}: { engine?: Engine; operationTimeoutMs?: number; stopTimeoutMs?: number }): Promise<void> {
  const modelId = ANDROID_QA_DOCUMENT_MODEL_ID;
  const ownedThreads: string[] = [];
  const originalThreadId = useChatStore.getState().activeThreadId;
  const pass = (step: Omit<Step, 'status'>) => publish({
    steps: [...evidence.steps, { ...step, status: 'passed' }],
  });
  const phase = (name: string) => publish({ phase: name });
  const createThread = () => {
    const store = useChatStore.getState();
    check(store.beginNewThread(), 'new_chat_blocked');
    const id = store.createThread({
      modelId, presetId: null, presetSnapshot: DEFAULT_PRESET_SNAPSHOT,
      paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 32, seed: 42 },
      title: 'Android inference QA',
    });
    ownedThreads.push(id);
    const thread = useChatStore.getState().threads[id];
    check(thread && thread.messages.length === 0 && !thread.summary, 'new_chat_history');
    return id;
  };
  const assertCpu = (id: string) => {
    const state = engine.getState();
    const diagnostics = state.diagnostics;
    check(state.activeModelId === modelId, 'model_identity');
    check(diagnostics?.backendMode === 'cpu'
      && diagnostics.actualGpuAccelerated === false
      && diagnostics.loadedGpuLayers === 0, 'actual_backend');
    check(diagnostics.initNParallel === 1 && diagnostics.stateCacheBudgetMb === 0
      && diagnostics.stateCacheMaxCheckpoints === 8, 'runtime_policy');
    pass({ id, backendMode: 'cpu', loadedGpuLayers: 0, actualGpuAccelerated: false });
  };
  const load = async (id: string) => {
    phase(id);
    await bounded(engine.load(modelId, { forceReload: true, preferLastWorkingProfile: false,
      loadParamsOverride: { backendPolicy: 'cpu', gpuLayers: 0, contextSize: 512,
        parallelSlots: 1, mtpEnabled: false } }), operationTimeoutMs);
    assertCpu(id);
  };
  const generate = async (id: string, threadId: string, cancel = false, fresh = false) => {
    phase(id);
    const prompt = cancel
      ? 'Count from one to one hundred, writing every number on a separate line.'
      : 'Write a short sentence about a friendly dog.';
    useChatStore.getState().appendMessage(threadId, {
      id: createChatId(), role: 'user', content: prompt, state: 'complete', createdAt: Date.now(),
    });
    const thread = useChatStore.getState().threads[threadId];
    check(thread?.modelId === modelId, 'chat_model_identity');
    const messages = getThreadInferenceWindow(thread, { maxContextMessages: 16,
      maxContextTokens: 512, responseReserveTokens: 64 }).messages;
    if (fresh) {
      const nonSystem = messages.filter((message) => message.role !== 'system');
      check(nonSystem.length === 1 && nonSystem[0].role === 'user'
        && nonSystem[0].content === prompt && thread.messages.length === 1, 'new_chat_history');
    }
    let callbacks = 0;
    let tokenCharacters = 0;
    let resolveFirstToken: () => void = () => undefined;
    const firstToken = new Promise<void>((resolve) => { resolveFirstToken = resolve; });
    let settled = false;
    const completion = engine.chatCompletion({
      messages, expectedModelId: thread.modelId,
      params: { temperature: 0, seed: 42, n_predict: cancel ? 256 : 32, enable_thinking: false },
      onToken: (event) => {
        const token = typeof event === 'string' ? event : event.token;
        if (token.length > 0) {
          callbacks += 1;
          tokenCharacters += token.length;
          resolveFirstToken();
        }
      },
    }).then((result) => { settled = true; return { result }; }, () => {
      settled = true;
      return { result: null };
    });
    if (cancel) {
      await bounded(Promise.race([firstToken, completion.then(() => {
        if (!callbacks) throw new SmokeFailure('no_real_tokens');
      })]), operationTimeoutMs);
      check(callbacks > 0 && !settled && engine.hasActiveCompletion(), 'stop_not_during_generation');
      // Await native stop AND the originating driver. Do not start a second context on timeout.
      const stopDeadline = Date.now() + stopTimeoutMs;
      await bounded(Promise.all([engine.stopCompletion(), completion]), stopTimeoutMs);
      while (engine.hasActiveCompletion()) {
        if (Date.now() >= stopDeadline) throw new SmokeFailure('timeout', true);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      pass({ id, callbacks, outputCharacters: tokenCharacters, inputMessages: messages.length });
      return;
    }
    const { result } = await bounded(completion, operationTimeoutMs);
    check(result, 'completion_failed');
    check(callbacks > 0 && tokenCharacters > 0 && typeof result.text === 'string' && result.text.trim().length > 0
      && positiveInteger(result.tokens_predicted) && positiveInteger(result.tokens_evaluated),
    'no_real_generation');
    check(!engine.hasActiveCompletion(), 'completion_not_drained');
    pass({ id, callbacks, outputCharacters: result.text.length,
      tokensPredicted: result.tokens_predicted, tokensEvaluated: result.tokens_evaluated,
      inputMessages: messages.length });
    useChatStore.getState().appendMessage(threadId, {
      id: createChatId(), role: 'assistant', content: result.text, state: 'complete', createdAt: Date.now(),
    });
  };
  publish({ status: 'running', phase: 'preconditions' });
  try {
    check(!engine.hasActiveCompletion(), 'engine_busy');
    const model = registry.getModel(modelId);
    check(model?.localPath && model.downloadIntegrity?.kind === 'sha256'
      && model.downloadIntegrity.sha256 === ANDROID_QA_DOCUMENT_MODEL_SHA256, 'verified_model_missing');
    phase('backend_discovery');
    const backend = await bounded(engine.getBackendAvailability(), operationTimeoutMs);
    check(!backend.discoveryUnavailable, 'backend_discovery_unavailable');
    pass({ id: 'backend_discovery', discoveredDeviceCount: backend.devices.length });
    await load('cpu_load');
    const first = createThread();
    await generate('generate', first);
    await generate('stop_after_token', first, true);
    await generate('generate_after_stop', first);
    const second = createThread();
    check(second !== first, 'new_chat_identity');
    await generate('new_chat_isolation', second, false, true);
    phase('unload');
    await bounded(engine.unload(), operationTimeoutMs);
    check(!engine.getState().activeModelId && !engine.hasActiveCompletion(), 'unload_incomplete');
    pass({ id: 'unload' });
    await load('cpu_reload');
    await generate('generate_after_reload', second);
    publish({ status: 'passed', phase: 'complete' });
  } catch (error) {
    publish({ status: 'failed', failureCode: error instanceof SmokeFailure ? error.code : 'operation_failed',
      requiresForceStop: error instanceof SmokeFailure && error.requiresForceStop || engine.hasActiveCompletion() });
  } finally {
    // Store-only cleanup. Never invoke native lifecycle operations after an uncertain timeout.
    if (!evidence.requiresForceStop) {
      ownedThreads.forEach((id) => useChatStore.getState().deleteThread(id));
      useChatStore.getState().setActiveThread(originalThreadId);
    }
  }
}

export function resetAndroidQaInferenceSmokeForTests(): void {
  if (process.env.NODE_ENV === 'test') { evidence = initialEvidence(); activeRun = null; }
}
