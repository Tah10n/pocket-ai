import * as FileSystem from 'expo-file-system/legacy';
import { useChatStore } from '../store/chatStore';
import { useDownloadStore } from '../store/downloadStore';
import { createChatId, DEFAULT_PRESET_SNAPSHOT } from '../types/chat';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../types/models';
import { getThreadInferenceWindow } from '../utils/inferenceWindow';
import { getModelFileIdentity } from '../utils/modelRoles';
import { safeJoinModelPath } from '../utils/safeFilePath';
import { checkAuxiliaryModel, selectAuxiliaryModel } from './AuxiliaryModelService';
import { ANDROID_QA_DOCUMENT_MODEL_ID, ANDROID_QA_DOCUMENT_MODEL_SHA256,
  isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { getAndroidQaInferenceSmokeEvidence } from './AndroidQaInferenceSmoke';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { getModelDownloadManager } from './ModelDownloadManager';
import { getSettings, updateSettings } from './SettingsStore';
import { getModelsDir } from './FileSystemSetup';
import { offloadModel } from './StorageManagerService';

export const ANDROID_QA_EMBEDDING_REPO = 'second-state/All-MiniLM-L6-v2-Embedding-GGUF';
export const ANDROID_QA_EMBEDDING_REVISION = '544f204f2eaa2d71361ffc74d6df7170285b286a';
export const ANDROID_QA_EMBEDDING_FILE = 'all-MiniLM-L6-v2-Q8_0.gguf';
export const ANDROID_QA_EMBEDDING_SHA256 = '263215c3cadd6e16740741a7624ab4cbb6c8e777688bd5331ecfbf5681c2f8ed';
export const ANDROID_QA_EMBEDDING_SIZE = 25_008_064;

type ResourceStep = { id: string; status: 'passed'; callbacks?: number; tokensPredicted?: number;
  tokensEvaluated?: number; outputCharacters?: number; dimensions?: number; finite?: boolean;
  chatUnchanged?: boolean; settingsUnchanged?: boolean; contextChanged?: boolean;
  contextUnchanged?: boolean; fileRemoved?: boolean };
export type AndroidQaModelResourcesEvidence = {
  schemaVersion: 1; status: 'idle' | 'running' | 'passed' | 'failed'; phase: string;
  requiresForceStop: boolean; failureCode?: string; steps: ResourceStep[];
  chatModelSha256: string; auxiliaryModelSha256: string; auxiliaryRevision: string;
};
const initialEvidence = (): AndroidQaModelResourcesEvidence => ({
  schemaVersion: 1, status: 'idle', phase: 'idle', requiresForceStop: false, steps: [],
  chatModelSha256: ANDROID_QA_DOCUMENT_MODEL_SHA256,
  auxiliaryModelSha256: ANDROID_QA_EMBEDDING_SHA256, auxiliaryRevision: ANDROID_QA_EMBEDDING_REVISION,
});
let evidence = initialEvidence();
let activeRun: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const getAndroidQaModelResourcesEvidence = () => evidence;
export function subscribeAndroidQaModelResources(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(patch: Partial<AndroidQaModelResourcesEvidence>): void {
  evidence = { ...evidence, ...patch };
  listeners.forEach(listener => listener());
}
class ResourceFailure extends Error {
  constructor(readonly code: string, readonly requiresForceStop = false) { super(code); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ResourceFailure(code);
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ResourceFailure('timeout', true)), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function fixture(): ModelMetadata {
  return {
    id: ANDROID_QA_EMBEDDING_REPO, name: 'Android QA MiniLM embedding', author: 'second-state',
    downloadUrl: `https://huggingface.co/${ANDROID_QA_EMBEDDING_REPO}/resolve/${ANDROID_QA_EMBEDDING_REVISION}/${ANDROID_QA_EMBEDDING_FILE}?download=true`,
    resolvedFileName: ANDROID_QA_EMBEDDING_FILE, size: ANDROID_QA_EMBEDDING_SIZE,
    sha256: ANDROID_QA_EMBEDDING_SHA256, lifecycleStatus: LifecycleStatus.AVAILABLE,
    fitsInRam: null, downloadProgress: 0,
    metadataTrust: 'trusted_remote', accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false,
    roleEvidence: [{ role: 'embedding', source: 'pipeline_tag', confidence: 'declared', value: 'feature-extraction' }],
  };
}
async function prepareEmbeddingFixture(timeoutMs: number): Promise<ModelMetadata> {
  const desired = fixture();
  const ready = () => {
    const model = registry.getModel(desired.id);
    return model?.localPath && getModelFileIdentity(model) === getModelFileIdentity(desired)
      && model.downloadIntegrity?.kind === 'sha256'
      && model.downloadIntegrity.sha256 === ANDROID_QA_EMBEDDING_SHA256
      && model.downloadIntegrity.sizeBytes === ANDROID_QA_EMBEDDING_SIZE ? model : undefined;
  };
  const existing = ready();
  if (existing) return existing;
  check(!registry.getModel(desired.id)?.localPath, 'fixture_identity_conflict');
  getModelDownloadManager();
  registry.updateModel(desired);
  useDownloadStore.getState().addToQueue(desired);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const model = ready();
    if (model) return model;
    const queued = useDownloadStore.getState().queue.find(item => item.id === desired.id);
    check(queued?.lifecycleStatus !== LifecycleStatus.FAILED, 'download_failed');
    check(queued?.lifecycleStatus !== LifecycleStatus.PAUSED, 'download_paused');
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  throw new ResourceFailure('download_timeout');
}
function chatSettings(): string {
  const { auxiliaryModels: _auxiliaryModels, ...settings } = getSettings();
  return JSON.stringify(settings);
}

/** Explicit isolated QA scenario; every native operation uses production services. */
export function runAndroidQaModelResources(options: { operationTimeoutMs?: number; downloadTimeoutMs?: number } = {}): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled()) return Promise.resolve();
  if (activeRun) return activeRun;
  if (evidence.status !== 'idle') return Promise.resolve();
  activeRun = execute(options).finally(() => { activeRun = null; });
  return activeRun;
}
async function execute({ operationTimeoutMs = 120_000, downloadTimeoutMs = 300_000 }: {
  operationTimeoutMs?: number; downloadTimeoutMs?: number;
}): Promise<void> {
  const originalThread = useChatStore.getState().activeThreadId;
  const originalBindings = getSettings().auxiliaryModels;
  let ownedThread: string | undefined;
  const abort = new AbortController();
  const pass = (step: Omit<ResourceStep, 'status'>) => publish({ steps: [...evidence.steps, { ...step, status: 'passed' }] });
  const phase = (value: string) => publish({ phase: value });
  const assertCpu = () => {
    const state = llmEngineService.getState();
    check(state.activeModelId === ANDROID_QA_DOCUMENT_MODEL_ID && state.status === 'ready', 'chat_model_identity');
    check(state.diagnostics?.backendMode === 'cpu' && state.diagnostics.actualGpuAccelerated === false
      && state.diagnostics.loadedGpuLayers === 0 && state.diagnostics.initNParallel === 1
      && state.diagnostics.stateCacheBudgetMb === 0 && state.diagnostics.stateCacheMaxCheckpoints === 8
      && llmEngineService.getContextSize() === 512, 'runtime_policy');
  };
  const generate = async (id: string) => {
    phase(id);
    const threadId = ownedThread!;
    useChatStore.getState().appendMessage(threadId, {
      id: createChatId(), role: 'user', content: 'Write a short sentence about a friendly dog.',
      state: 'complete', createdAt: Date.now(),
    });
    const thread = useChatStore.getState().threads[threadId];
    const messages = getThreadInferenceWindow(thread, { maxContextMessages: 16, maxContextTokens: 512, responseReserveTokens: 64 }).messages;
    let callbacks = 0;
    const result = await bounded(llmEngineService.chatCompletion({
      messages, expectedModelId: ANDROID_QA_DOCUMENT_MODEL_ID,
      params: { temperature: 0, seed: 42, n_predict: 32, enable_thinking: false },
      onToken: event => { if ((typeof event === 'string' ? event : event.token).length) callbacks += 1; },
    }), operationTimeoutMs);
    check(callbacks > 0 && typeof result.text === 'string' && result.text.trim().length > 0 && positive(result.tokens_predicted)
      && positive(result.tokens_evaluated) && !llmEngineService.hasActiveCompletion(), 'no_real_generation');
    useChatStore.getState().appendMessage(threadId, { id: createChatId(), role: 'assistant',
      content: result.text, state: 'complete', createdAt: Date.now() });
    pass({ id, callbacks, tokensPredicted: result.tokens_predicted, tokensEvaluated: result.tokens_evaluated, outputCharacters: result.text.length });
  };
  publish({ status: 'running', phase: 'preconditions' });
  try {
    check(getAndroidQaInferenceSmokeEvidence().status === 'passed', 'baseline_not_passed');
    check(!llmEngineService.hasActiveCompletion() && !llmEngineService.hasAuxiliaryContextOperation(), 'engine_busy');
    check(registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID)?.downloadIntegrity?.sha256 === ANDROID_QA_DOCUMENT_MODEL_SHA256, 'verified_chat_missing');
    phase('cpu_load');
    await bounded(llmEngineService.load(ANDROID_QA_DOCUMENT_MODEL_ID, { forceReload: true,
      loadParamsOverride: { contextSize: 512, backendPolicy: 'cpu', gpuLayers: 0, mtpEnabled: false, parallelSlots: 1 } }), operationTimeoutMs);
    assertCpu();
    pass({ id: 'cpu_load' });
    check(useChatStore.getState().beginNewThread(), 'new_chat_blocked');
    ownedThread = useChatStore.getState().createThread({ modelId: ANDROID_QA_DOCUMENT_MODEL_ID,
      title: 'Android resource QA', presetId: null, presetSnapshot: DEFAULT_PRESET_SNAPSHOT,
      paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 32, seed: 42 } });
    await generate('generate_before');
    phase('prepare_embedding');
    const model = await prepareEmbeddingFixture(downloadTimeoutMs);
    pass({ id: 'prepare_embedding' });
    selectAuxiliaryModel('embedding', model);
    const threadBefore = JSON.stringify(useChatStore.getState().threads[ownedThread]);
    const settingsBefore = chatSettings();
    const generationBefore = llmEngineService.getPromptContextIdentity();
    phase('embedding_check');
    const result = await bounded(checkAuxiliaryModel('embedding', { signal: abort.signal, verifyEmbedding: true }), operationTimeoutMs);
    check(result.operation === 'embedding' && result.dimensions === 384, 'embedding_invalid');
    pass({ id: 'embedding_check', dimensions: result.dimensions, finite: true });
    assertCpu();
    check(!llmEngineService.hasAuxiliaryContextOperation(), 'release_incomplete');
    check(useChatStore.getState().activeThreadId === ownedThread
      && JSON.stringify(useChatStore.getState().threads[ownedThread]) === threadBefore, 'chat_changed');
    check(chatSettings() === settingsBefore, 'settings_changed');
    check(llmEngineService.getPromptContextIdentity() !== generationBefore, 'context_not_replaced');
    pass({ id: 'restore_chat', chatUnchanged: true, settingsUnchanged: true, contextChanged: true });
    await generate('generate_after');
    // Only the pinned fixture in the explicitly isolated QA package is removed.
    // Keep the original A -> B -> A sequence above intact, then exercise offload
    // through the same production entry point used by storage management.
    phase('offload_unused_embedding');
    const installed = registry.getModel(ANDROID_QA_EMBEDDING_REPO);
    const modelsDir = getModelsDir();
    const fileUri = modelsDir && installed?.localPath
      ? safeJoinModelPath(modelsDir, installed.localPath) : null;
    check(fileUri && installed && getModelFileIdentity(installed) === getModelFileIdentity(model)
      && installed.downloadIntegrity?.sha256 === ANDROID_QA_EMBEDDING_SHA256, 'fixture_identity_conflict');
    check((await FileSystem.getInfoAsync(fileUri)).exists, 'fixture_file_missing');
    const contextBeforeOffload = llmEngineService.getPromptContextIdentity();
    const threadBeforeOffload = JSON.stringify(useChatStore.getState().threads[ownedThread]);
    const settingsBeforeOffload = chatSettings();
    await bounded(offloadModel(installed.id), operationTimeoutMs);
    assertCpu();
    check(llmEngineService.getPromptContextIdentity() === contextBeforeOffload, 'context_changed_on_offload');
    check(useChatStore.getState().activeThreadId === ownedThread
      && JSON.stringify(useChatStore.getState().threads[ownedThread]) === threadBeforeOffload, 'chat_changed');
    check(chatSettings() === settingsBeforeOffload, 'settings_changed');
    check(!registry.getModel(installed.id)?.localPath && !(await FileSystem.getInfoAsync(fileUri)).exists, 'fixture_not_removed');
    pass({ id: 'offload_unused_embedding', chatUnchanged: true, settingsUnchanged: true, contextUnchanged: true, fileRemoved: true });
    const messagesBeforeNextAnswer = useChatStore.getState().threads[ownedThread].messages;
    const retainedMessageCount = messagesBeforeNextAnswer.length;
    const retainedMessagesSnapshot = JSON.stringify(messagesBeforeNextAnswer);
    await generate('generate_after_offload');
    assertCpu();
    check(llmEngineService.getPromptContextIdentity() === contextBeforeOffload, 'context_changed_on_offload');
    check(chatSettings() === settingsBeforeOffload, 'settings_changed');
    const threadAfterNextAnswer = useChatStore.getState().threads[ownedThread];
    check(useChatStore.getState().activeThreadId === ownedThread && threadAfterNextAnswer
      && threadAfterNextAnswer.messages.length === retainedMessageCount + 2
      && JSON.stringify(threadAfterNextAnswer.messages.slice(0, retainedMessageCount))
        === retainedMessagesSnapshot, 'chat_changed');
    pass({ id: 'confirm_context_retained', contextUnchanged: true });
    publish({ status: 'passed', phase: 'complete' });
  } catch (error) {
    abort.abort();
    const requiresForceStop = error instanceof ResourceFailure && error.requiresForceStop
      || llmEngineService.hasActiveCompletion() || llmEngineService.hasAuxiliaryContextOperation()
      || llmEngineService.getState().diagnostics?.contextRecoveryStatus === 'failed';
    publish({ status: 'failed', failureCode: error instanceof ResourceFailure ? error.code : 'operation_failed', requiresForceStop });
    if (evidence.phase === 'prepare_embedding') await getModelDownloadManager().cancelDownload(ANDROID_QA_EMBEDDING_REPO).catch(() => undefined);
  } finally {
    if (!evidence.requiresForceStop) {
      if (ownedThread) useChatStore.getState().deleteThread(ownedThread);
      useChatStore.getState().setActiveThread(originalThread);
      updateSettings({ auxiliaryModels: originalBindings });
    }
  }
}
export function resetAndroidQaModelResourcesForTests(): void {
  if (process.env.NODE_ENV === 'test') { evidence = initialEvidence(); activeRun = null; }
}
