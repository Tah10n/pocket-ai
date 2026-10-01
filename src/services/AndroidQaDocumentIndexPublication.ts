import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import fixture from '../../docs/validation/llama-rn-stage5/retrieval-fixtures.json';
import loraFixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import type { AppendUserMessageOptions } from '../hooks/useChatSession';
import { useChatStore, flushPendingChatPersistenceWrites } from '../store/chatStore';
import { getAppStorage } from '../store/storage';
import { DEFAULT_PRESET_SNAPSHOT, createChatId, type ChatThread } from '../types/chat';
import type { ChatDocumentAttachmentDraft } from '../types/attachments';
import { documentIndexFingerprint, DocumentRetrievalError, type DocumentRetrievalIssue } from '../types/documentRetrieval';
import { getCompanionBindingIdentity, getCompanionSourceIdentity } from '../utils/modelArtifacts';
import { getAssistantPresentation } from '../utils/chatPresentation';
import { fileUriToNativePath } from '../utils/safeFilePath';
import { ANDROID_QA_DOCUMENT_MODEL_ID, ANDROID_QA_DOCUMENT_MODEL_SHA256, isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { prepareAndroidQaDocumentRetrievalModels } from './AndroidQaDocumentRetrieval';
import { androidQaHistoryDigest } from './AndroidQaLocalToolsRecovery';
import { observeAndroidQaDocumentIndexNativeOperations, type AndroidQaDocumentIndexCounters } from './AndroidQaDocumentIndexObservation';
import { AppError } from './AppError';
import { getAndroidQaEffectiveProfileIdentity } from './AndroidQaStage3';
import { chatAttachmentStorageService, materializeDocumentDraftsForProcessing } from './ChatAttachmentStorageService';
import { chatAttachmentProcessorRegistry } from './ChatAttachmentProcessorRegistry';
import { documentIndexStore } from './DocumentIndexStore';
import { getOwnedRetrievalDocuments } from './DocumentRetrievalOwnership';
import { prepareDocumentRetrieval } from './DocumentRetrievalPreparation';
import { getDocumentRetrievalStatus } from './DocumentRetrievalStatus';
import { documentSessionContextCache } from './DocumentSessionContextCache';
import { hasActiveChatGenerationWork } from './ChatGenerationService';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { getGenerationParametersForModel, getSettings, updateSettings, type AuxiliaryModelBindings, type ModelLoadParameters } from './SettingsStore';

export type AndroidQaDocumentIndexHookActions = {
  appendUserMessage: (text: string, options?: AppendUserMessageOptions) => Promise<unknown>;
  stopGeneration: () => Promise<unknown>;
};
export const ANDROID_QA_DOCUMENT_INDEX_STEPS = ['four_indexes', 'fifth_new_chat', 'fifth_existing_chat', 'stop', 'after_stop', 'cold_retention', 'next_query', 'cleanup'] as const;
type StepId = typeof ANDROID_QA_DOCUMENT_INDEX_STEPS[number];
type Receipt = Partial<AndroidQaDocumentIndexCounters> & {
  id: StepId; status: 'passed' | 'failed' | 'not_run'; indexCount?: number; callbackCount?: number;
  actualMode?: 'hybrid+rerank'; cacheFailure?: 'quota_exceeded'; userCount?: number; assistantCount?: number;
  outputCharacters?: number; tokensPredicted?: number; tokensEvaluated?: number;
  noReady?: boolean; oldIndexesRetained?: boolean; historyRetained?: boolean; attachmentsRetained?: boolean;
  profileRestored?: boolean; loraApplied?: boolean; completionDrained?: boolean; cancelled?: boolean; answerMatched?: boolean;
};
type SeedOperation = 'seed_create' | 'seed_idle_before' | 'seed_parse' | 'seed_prepare' | 'seed_idle_after'
  | 'seed_ready' | 'seed_owners' | 'seed_native_counts';
type SeedProgress = AndroidQaDocumentIndexCounters & {
  seedIndex: number; completedSeeds: number; operation: SeedOperation; completionDrained?: boolean;
  operationErrorCode?: DocumentRetrievalIssue | 'engine_busy' | 'engine_unloading' | 'model_load_failed' | 'engine_recovery_required';
};
type TurnOperation = 'new_thread_begin' | 'profile_check' | 'dispatch' | 'after_append' | 'terminal_history'
  | 'answer_match' | 'status_cache' | 'ownership' | 'native_counts' | 'profile_restoration';
type TurnProgress = Omit<Receipt, 'id' | 'status' | 'actualMode' | 'cacheFailure'> & {
  turn: 'fifth_new_chat' | 'fifth_existing_chat'; operation: TurnOperation; attachmentCount?: number;
  threadPresent?: boolean; assistantTerminal?: boolean; assistantError?: boolean;
  actualMode?: 'lexical' | 'hybrid' | 'lexical+rerank' | 'hybrid+rerank';
  cacheFailure?: 'quota_exceeded' | 'cache_write_failed'; fallbackReason?: DocumentRetrievalIssue;
  operationErrorCode?: SeedProgress['operationErrorCode'] | 'action_failed' | 'chat_model_not_loaded'
    | 'chat_model_mismatch' | 'engine_not_ready' | 'model_memory_insufficient' | 'message_too_long';
};
export type AndroidQaDocumentIndexPublicationEvidence = {
  schemaVersion: 1; fixtureId: string; runtimeVersion: string; backend: 'cpu';
  status: 'idle' | 'running' | 'ready_for_cold_reopen' | 'passed' | 'failed';
  phase: StepId | 'idle' | 'preconditions' | 'complete'; steps: Receipt[]; requiresForceStop: boolean;
  seedProgress?: SeedProgress;
  turnProgress?: TurnProgress;
  failureCode?: 'precondition' | 'assertion' | 'operation_failed' | 'timeout' | 'cleanup_failed';
};
type Owner = { threadId: string; attachmentId: string; fingerprint: string; historyDigest: string };
type Saved = { originalThread: string | null; originalModel: string | null; originalProfile: ModelLoadParameters | null;
  originalBindings: AuxiliaryModelBindings | undefined };
type Checkpoint = Saved & { version: 1; ownedThreads: string[]; owners: Owner[]; fifthThread: string;
  history: Record<string, string>; attachments: string[]; evidence: AndroidQaDocumentIndexPublicationEvidence };
const CHECKPOINT_KEY = 'android-qa:document-index-publication:v1';
const TITLE = 'Android index publication QA';
const initial = (): AndroidQaDocumentIndexPublicationEvidence => ({ schemaVersion: 1, fixtureId: fixture.fixtureId,
  runtimeVersion: fixture.runtimeVersion, backend: 'cpu', status: 'idle', phase: 'idle', steps: [], requiresForceStop: false });
let evidence = initial(); let active: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const getAndroidQaDocumentIndexPublicationEvidence = () => evidence;
export function subscribeAndroidQaDocumentIndexPublication(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function publish(patch: Partial<AndroidQaDocumentIndexPublicationEvidence>): void {
  evidence = { ...evidence, ...patch }; listeners.forEach(listener => listener());
}
class QaFailure extends Error {
  constructor(readonly code: NonNullable<AndroidQaDocumentIndexPublicationEvidence['failureCode']>, readonly forceStop = false) { super(code); }
}
function check(value: unknown): asserts value { if (!value) throw new QaFailure('assertion'); }
const idle = () => !llmEngineService.hasActiveCompletion() && !llmEngineService.hasAuxiliaryContextOperation()
  && !llmEngineService.hasActiveContextOperation() && !hasActiveChatGenerationWork();
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QaFailure('timeout', true)), timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function waitIdle(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!idle()) { if (Date.now() >= deadline) throw new QaFailure('timeout', true); await new Promise<void>(resolve => setTimeout(resolve, 25)); }
}
const renderHook = () => new Promise<void>(resolve => setTimeout(resolve, 50));
const pass = (receipt: Omit<Receipt, 'status'>) => publish({ steps: [...evidence.steps, { ...receipt, status: 'passed' }] });
function fail(error: unknown): void {
  const failedPhase = evidence.phase;
  const operationErrorCode = error instanceof DocumentRetrievalError ? error.code
    : error instanceof AppError && ['engine_busy', 'engine_unloading', 'model_load_failed', 'engine_recovery_required'].includes(error.code)
      ? error.code as SeedProgress['operationErrorCode'] : undefined;
  const turnErrorCode = operationErrorCode ?? (error instanceof AppError
    && ['action_failed', 'chat_model_not_loaded', 'chat_model_mismatch', 'engine_not_ready', 'model_memory_insufficient', 'message_too_long'].includes(error.code)
    ? error.code as TurnProgress['operationErrorCode'] : undefined);
  publish({ status: 'failed', failureCode: error instanceof QaFailure ? error.code : 'operation_failed',
    ...(failedPhase === 'four_indexes' && evidence.seedProgress ? { seedProgress: {
      ...evidence.seedProgress, completionDrained: idle(), operationErrorCode,
    } } : {}),
    ...((failedPhase === 'fifth_new_chat' || failedPhase === 'fifth_existing_chat') && evidence.turnProgress ? { turnProgress: {
      ...evidence.turnProgress, completionDrained: idle(), operationErrorCode: turnErrorCode,
    } } : {}),
    requiresForceStop: error instanceof QaFailure ? error.forceStop || !idle() : !idle(),
    steps: [...evidence.steps, ...ANDROID_QA_DOCUMENT_INDEX_STEPS.filter(id => !evidence.steps.some(step => step.id === id))
      .map(id => ({ id, status: id === failedPhase ? 'failed' as const : 'not_run' as const }))] });
}
async function assertOwners(owners: readonly Owner[]): Promise<void> {
  for (const owner of owners) {
    const identity = documentIndexStore.inspect(owner.threadId, owner.attachmentId);
    check(identity && documentIndexFingerprint(identity) === owner.fingerprint
      && getOwnedRetrievalDocuments(owner.threadId).some(attachment => attachment.id === owner.attachmentId)
      && threadHistory(owner.threadId) === owner.historyDigest);
    const index = await documentIndexStore.read(owner.threadId, owner.attachmentId, identity, () => {
      check(threadHistory(owner.threadId) === owner.historyDigest);
    });
    check(index && index.rows.length === 1);
  }
  check(getAppStorage().getAllKeys().filter(key => key.startsWith('document-retrieval-v1:') && key.endsWith(':ready')).length === 4);
}
async function copyFixtureDraft(documentIndex: number): Promise<ChatDocumentAttachmentDraft> {
  check(FileSystem.cacheDirectory);
  const temporary = `${FileSystem.cacheDirectory}publication-qa-${createChatId()}.txt`;
  try {
    await FileSystem.writeAsStringAsync(temporary, fixture.corpus.documents[documentIndex].paragraphs[0].text);
    const draft = await chatAttachmentStorageService.copyDocumentAssetToDraft({ uri: temporary,
      name: fixture.corpus.documents[documentIndex].filename, mimeType: 'text/plain' });
    check(draft.id && draft.localUri); return draft;
  } finally { await FileSystem.deleteAsync(temporary, { idempotent: true }); }
}
function threadHistory(threadId: string): string {
  const thread = useChatStore.getState().getThread(threadId); check(thread);
  return androidQaHistoryDigest(thread.messages);
}
async function attachmentsUnchanged(threadIds: readonly string[]): Promise<boolean> {
  for (const threadId of threadIds) for (const attachment of getOwnedRetrievalDocuments(threadId)) {
    if (!(await FileSystem.getInfoAsync(attachment.localUri)).exists
      || await RNFS.hash(fileUriToNativePath(attachment.localUri), 'sha256') !== attachment.document.contentSha256) return false;
  }
  return true;
}
async function seedIndex(documentIndex: number, ownedThreads: string[], timeoutMs: number,
  recordProgress: (operation: SeedOperation) => void): Promise<Owner> {
  recordProgress('seed_create');
  check(useChatStore.getState().beginNewThread());
  const threadId = useChatStore.getState().createThread({ modelId: ANDROID_QA_DOCUMENT_MODEL_ID, title: TITLE,
    presetId: null, presetSnapshot: DEFAULT_PRESET_SNAPSHOT, paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 48, seed: 42 } });
  ownedThreads.push(threadId); await renderHook(); recordProgress('seed_idle_before'); await waitIdle(timeoutMs);
  const draft = await copyFixtureDraft(documentIndex); let committed = false;
  try {
    recordProgress('seed_parse');
    const messageId = createChatId();
    const attachment = materializeDocumentDraftsForProcessing({ threadId, messageId, drafts: [draft] })[0];
    const parsed = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(attachment, { query: '', maxChars: 16000, maxChunks: 64 });
    check(parsed.chunks.length === 1 && parsed.chunks[0].text === fixture.corpus.documents[documentIndex].paragraphs[0].text);
    useChatStore.getState().appendMessage(threadId, { id: messageId, role: 'user', content: '[Document attachment]',
      state: 'complete', createdAt: Date.now(), attachments: [{ ...attachment, state: 'ready', document: {
        processorId: parsed.processorId, processorVersion: parsed.processorVersion, contentSha256: parsed.contentSha256,
        contentHash: parsed.contentHash, canonicalFormat: parsed.canonicalFormat, sourceByteCount: parsed.sourceByteCount,
        sourceCharCount: parsed.sourceCharCount, chunkCount: parsed.chunkCount, parserId: parsed.parserId,
        parserVersion: parsed.parserVersion, exactAnyDocCommit: parsed.exactAnyDocCommit } }] });
    committed = true;
    useChatStore.getState().updateThreadDocumentRetrieval(threadId, { mode: 'hybrid', rerank: false });
    check(useChatStore.getState().getThread(threadId)?.documentRetrieval?.mode === 'hybrid');
    recordProgress('seed_prepare');
    // The production preparation owner retains revision, Stop and document/native
    // resource ownership through the real drain; a host deadline cannot release it.
    await bounded(prepareDocumentRetrieval(threadId, [attachment.id]), timeoutMs);
    recordProgress('seed_idle_after');
    await waitIdle(timeoutMs);
    recordProgress('seed_ready');
    check(getDocumentRetrievalStatus(threadId).preparation?.phase === 'ready');
    const identity = documentIndexStore.inspect(threadId, attachment.id); check(identity);
    return { threadId, attachmentId: attachment.id, fingerprint: documentIndexFingerprint(identity), historyDigest: threadHistory(threadId) };
  } finally { if (!committed) await chatAttachmentStorageService.discardDocumentDraft(draft); }
}
function answerReceipt(thread: ChatThread, previousCount: number,
  recordDiagnostics?: (receipt: Partial<TurnProgress>) => void): Omit<Receipt, 'id' | 'status'> {
  const added = thread.messages.slice(previousCount); const users = added.filter(message => message.role === 'user');
  const assistants = added.filter(message => message.role === 'assistant');
  recordDiagnostics?.({ userCount: users.length, assistantCount: assistants.length,
    assistantTerminal: assistants.length === 1 && assistants[0].state !== 'streaming' && assistants[0].state !== 'error',
    assistantError: assistants.some(message => message.state === 'error') });
  check(users.length === 1 && assistants.length === 1 && assistants[0].state !== 'streaming' && assistants[0].state !== 'error');
  const answer = getAssistantPresentation(assistants[0].content).finalContent.trim();
  const telemetry = assistants[0].inferenceMetrics;
  recordDiagnostics?.({ outputCharacters: answer.length, tokensPredicted: telemetry?.tokensPredicted ?? 0,
    tokensEvaluated: telemetry?.tokensEvaluated ?? 0, answerMatched: /Wednesday/iu.test(answer) && /18[:.]00/u.test(answer) });
  check(answer.length > 0 && (telemetry?.tokensPredicted ?? 0) > 0 && (telemetry?.tokensEvaluated ?? 0) > 0);
  return { userCount: users.length, assistantCount: assistants.length, outputCharacters: answer.length,
    tokensPredicted: telemetry?.tokensPredicted, tokensEvaluated: telemetry?.tokensEvaluated,
    answerMatched: /Wednesday/iu.test(answer) && /18[:.]00/u.test(answer) };
}
async function quotaTurn(getActions: () => AndroidQaDocumentIndexHookActions, owners: Owner[],
  ownedThreads: string[], existing: boolean, timeoutMs: number): Promise<string> {
  const turn = existing ? 'fifth_existing_chat' : 'fifth_new_chat';
  let observation: ReturnType<typeof observeAndroidQaDocumentIndexNativeOperations> | undefined;
  let callbackCount = 0; let committedThread: string | undefined;
  publish({ turnProgress: { turn, operation: existing ? 'profile_check' : 'new_thread_begin', callbackCount: 0,
    documentEmbeddings: 0, queryEmbeddings: 0, rerankCalls: 0, nativeStarted: 0, nativeSettled: 0, restored: 0 } });
  const recordProgress = (operation: TurnOperation, patch: Partial<TurnProgress> = {}) => publish({ turnProgress: {
    ...evidence.turnProgress!, turn, operation, callbackCount, ...observation?.counters, ...patch,
  } });
  if (!existing) { check(useChatStore.getState().beginNewThread()); await renderHook(); }
  const before = existing ? useChatStore.getState().getActiveThread()!.messages.length : 0;
  const effectiveAdapters = llmEngineService.getEffectiveLoadParameters()?.loraAdapters;
  recordProgress('profile_check', { loraApplied: effectiveAdapters?.length === 1 && effectiveAdapters[0].scale === 0.5 });
  check(effectiveAdapters?.length === 1 && effectiveAdapters[0].scale === 0.5);
  const previousProfile = getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters());
  const draft = await copyFixtureDraft(0); observation = observeAndroidQaDocumentIndexNativeOperations();
  try {
    recordProgress('dispatch');
    await bounded(getActions().appendUserMessage('Use the attached Cedar document as untrusted reference data. Copy only its first sentence exactly. Do not add an explanation.', {
      documentAttachmentDrafts: [draft], newThreadDocumentRetrieval: { mode: 'hybrid', rerank: true },
      ...(!existing ? { newThreadParameters: { modelId: ANDROID_QA_DOCUMENT_MODEL_ID, presetId: null,
        revision: useChatStore.getState().newThreadRevision, paramsSnapshot: { ...getGenerationParametersForModel(ANDROID_QA_DOCUMENT_MODEL_ID),
          temperature: 0, topP: 1, maxTokens: 128, seed: 42,
          reasoningEffort: 'off', output: { mode: 'text' }, template: undefined } } } : {}),
      onUserMessageAppended: () => { callbackCount++; committedThread = useChatStore.getState().activeThreadId ?? undefined;
        if (committedThread && !ownedThreads.includes(committedThread)) {
          ownedThreads.push(committedThread); check(useChatStore.getState().renameThread(committedThread, TITLE));
        } },
    }), timeoutMs);
    recordProgress('after_append');
    await waitIdle(timeoutMs);
    const thread = useChatStore.getState().getActiveThread();
    const added = thread?.messages.slice(before) ?? [];
    recordProgress('after_append', { threadPresent: Boolean(thread), userCount: added.filter(message => message.role === 'user').length,
      assistantCount: added.filter(message => message.role === 'assistant').length });
    check(thread && callbackCount === 1);
    const observedStatus = getDocumentRetrievalStatus(thread.id);
    const observedDocuments = added.filter(message => message.role === 'user').flatMap(message => message.attachments ?? [])
      .filter(attachment => 'kind' in attachment && attachment.kind === 'document');
    recordProgress('terminal_history', { attachmentCount: observedDocuments.length, actualMode: observedStatus.lastSearch?.actualMode,
      fallbackReason: observedStatus.lastSearch?.fallbackReason,
      cacheFailure: observedStatus.cacheFailures?.find(failure => observedDocuments.some(attachment => attachment.id === failure.attachmentId))?.reason });
    const receipt = answerReceipt(thread, before, patch => recordProgress('terminal_history', patch));
    recordProgress('answer_match', { answerMatched: receipt.answerMatched });
    check(receipt.answerMatched);
    const status = getDocumentRetrievalStatus(thread.id);
    const documents = thread.messages.at(-2)?.attachments?.filter(attachment => 'kind' in attachment && attachment.kind === 'document') ?? [];
    recordProgress('status_cache', { attachmentCount: documents.length, actualMode: status.lastSearch?.actualMode,
      fallbackReason: status.lastSearch?.fallbackReason });
    check(documents.length === 1);
    const attachmentId = documents[0].id;
    const noReady = !documentIndexStore.inspect(thread.id, attachmentId);
    recordProgress('status_cache', { cacheFailure: status.cacheFailures?.find(failure => failure.attachmentId === attachmentId)?.reason,
      noReady });
    check(status.lastSearch?.actualMode === 'hybrid+rerank' && !status.lastSearch.fallbackReason
      && status.cacheFailures?.some(failure => failure.attachmentId === attachmentId && failure.reason === 'quota_exceeded')
      && noReady);
    recordProgress('ownership');
    await assertOwners(owners);
    const retained = await attachmentsUnchanged([...owners.map(owner => owner.threadId), thread.id]);
    recordProgress('ownership', { oldIndexesRetained: true, attachmentsRetained: retained });
    check(retained);
    recordProgress('native_counts');
    check(observation.counters.documentEmbeddings === (existing ? 2 : 1) && observation.counters.queryEmbeddings === 1
      && observation.counters.rerankCalls === 1 && observation.counters.nativeStarted === observation.counters.nativeSettled
      && observation.counters.restored === 1);
    const profileRestored = previousProfile === getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters());
    recordProgress('profile_restoration', { profileRestored }); check(profileRestored);
    pass({ id: existing ? 'fifth_existing_chat' : 'fifth_new_chat', ...receipt, ...observation.counters, callbackCount,
      actualMode: 'hybrid+rerank', cacheFailure: 'quota_exceeded', noReady: true, oldIndexesRetained: true,
      historyRetained: true, attachmentsRetained: true,
      profileRestored: true, loraApplied: true, completionDrained: true });
    return thread.id;
  } finally {
    recordProgress(evidence.turnProgress!.operation);
    observation.release();
    if (!committedThread) {
      const committed = Object.values(useChatStore.getState().threads).find(thread => thread.messages.some(message =>
        message.attachments?.some(attachment => attachment.id === draft.id)));
      if (committed && !ownedThreads.includes(committed.id)) ownedThreads.push(committed.id);
      if (!committed) await chatAttachmentStorageService.discardDocumentDraft(draft);
    }
  }
}
async function cleanup(saved: Saved, ownedThreads: readonly string[], timeoutMs: number, restoreContext = true): Promise<void> {
  await waitIdle(timeoutMs);
  const uris = ownedThreads.flatMap(threadId => getOwnedRetrievalDocuments(threadId).map(attachment => attachment.localUri));
  for (const threadId of ownedThreads) {
    check(useChatStore.getState().getThread(threadId)?.title === TITLE);
    useChatStore.getState().deleteThread(threadId); await documentSessionContextCache.clearThread(threadId);
  }
  flushPendingChatPersistenceWrites();
  const deadline = Date.now() + 30000;
  while ((await Promise.all(uris.map(uri => FileSystem.getInfoAsync(uri)))).some(info => info.exists)) {
    if (Date.now() >= deadline) throw new QaFailure('cleanup_failed'); await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  if (restoreContext && saved.originalModel && saved.originalProfile) await bounded(llmEngineService.load(saved.originalModel, {
    forceReload: true, loadParamsMode: 'replace', loadParamsOverride: saved.originalProfile }), timeoutMs);
  else if (restoreContext) await bounded(llmEngineService.unload(), timeoutMs);
  updateSettings({ auxiliaryModels: saved.originalBindings }); useChatStore.getState().setActiveThread(saved.originalThread);
  getAppStorage().remove(CHECKPOINT_KEY); flushPendingChatPersistenceWrites();
}
export function runAndroidQaDocumentIndexPublication(getActions: () => AndroidQaDocumentIndexHookActions): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled() || evidence.status !== 'idle') return active ?? Promise.resolve();
  active = execute(getActions).finally(() => { active = null; }); return active;
}
async function execute(getActions: () => AndroidQaDocumentIndexHookActions): Promise<void> {
  const timeoutMs = 600000;
  const saved: Saved = { originalThread: useChatStore.getState().activeThreadId,
    originalModel: llmEngineService.getState().activeModelId ?? null, originalProfile: llmEngineService.getEffectiveLoadParameters(),
    originalBindings: getSettings().auxiliaryModels };
  const ownedThreads: string[] = []; const owners: Owner[] = []; let keepForCold = false;
  let touchedSettings = false; let touchedContext = false;
  publish({ status: 'running', phase: 'preconditions' });
  try {
    await waitIdle(timeoutMs);
    if (getAppStorage().contains(CHECKPOINT_KEY) || getAppStorage().getAllKeys().some(key => key.startsWith('document-retrieval-v1:'))
      || registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID)?.downloadIntegrity?.sha256 !== ANDROID_QA_DOCUMENT_MODEL_SHA256) throw new QaFailure('precondition');
    touchedSettings = true; await prepareAndroidQaDocumentRetrievalModels(900000);
    touchedContext = true;
    await bounded(llmEngineService.load(ANDROID_QA_DOCUMENT_MODEL_ID, { forceReload: true, loadParamsMode: 'replace',
      loadParamsOverride: { contextSize: 1024, backendPolicy: 'cpu', gpuLayers: 0, mtpEnabled: false, kvCacheType: 'f16',
        cacheTypeK: 'f16', cacheTypeV: 'f16', loraAdapters: [], parallelSlots: 1 } }), timeoutMs);
    check(llmEngineService.getState().diagnostics?.backendMode === 'cpu');
    publish({ phase: 'four_indexes' });
    const seedObservation = observeAndroidQaDocumentIndexNativeOperations();
    const recordSeedProgress = (seedIndex: number, operation: SeedOperation) => publish({ seedProgress: {
      seedIndex, completedSeeds: owners.length, operation, ...seedObservation.counters,
    } });
    try { for (let index = 0; index < 4; index++) {
      owners.push(await seedIndex(index, ownedThreads, timeoutMs, operation => recordSeedProgress(index + 1, operation)));
      recordSeedProgress(index + 1, 'seed_ready');
    } } finally {
      if (evidence.seedProgress) publish({ seedProgress: { ...evidence.seedProgress, ...seedObservation.counters } });
      seedObservation.release();
    }
    recordSeedProgress(4, 'seed_owners'); await assertOwners(owners);
    recordSeedProgress(4, 'seed_native_counts'); check(seedObservation.counters.documentEmbeddings === 4 && seedObservation.counters.queryEmbeddings === 0
      && seedObservation.counters.rerankCalls === 0 && seedObservation.counters.nativeStarted === seedObservation.counters.nativeSettled);
    pass({ id: 'four_indexes', ...seedObservation.counters, indexCount: 4, oldIndexesRetained: true });
    const base = registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID)!;
    const adapter = base.artifacts?.find(item => item.integrity?.sha256 === loraFixture.adapter.sha256 && item.installState === 'installed' && item.localPath);
    check(adapter); await waitIdle(timeoutMs);
    const lora = { artifactId: adapter.id, artifactIdentity: getCompanionSourceIdentity(adapter), baseModelIdentity: getCompanionBindingIdentity(base),
      scale: 0.5, sizeBytes: adapter.sizeBytes ?? undefined };
    await bounded(llmEngineService.applyLoraConfiguration(ANDROID_QA_DOCUMENT_MODEL_ID, [lora]), timeoutMs);
    const loraThreadId = useChatStore.getState().activeThreadId; check(loraThreadId);
    useChatStore.getState().updateThreadLoraSnapshot(loraThreadId, [lora]);
    await renderHook(); await waitIdle(timeoutMs);
    publish({ phase: 'fifth_new_chat' }); const fifthThread = await quotaTurn(getActions, owners, ownedThreads, false, timeoutMs);
    publish({ phase: 'fifth_existing_chat' }); await quotaTurn(getActions, owners, ownedThreads, true, timeoutMs);
    publish({ phase: 'stop' });
    check(useChatStore.getState().beginNewThread()); await renderHook(); await waitIdle(timeoutMs);
    const cancelledDraft = await copyFixtureDraft(1); let stop: Promise<unknown> | undefined; let appended = false;
    const stoppedObservation = observeAndroidQaDocumentIndexNativeOperations(event => {
      if (event.operation === 'embedding' && event.kind === 'document' && !stop) stop = getActions().stopGeneration();
    });
    try {
      await bounded(getActions().appendUserMessage('What is LAB-204?', { documentAttachmentDrafts: [cancelledDraft],
        newThreadDocumentRetrieval: { mode: 'hybrid', rerank: true }, onUserMessageAppended: () => { appended = true; } }), timeoutMs);
      check(stop); await bounded(stop, timeoutMs); await waitIdle(timeoutMs);
      check(!appended && useChatStore.getState().activeThreadId === null && stoppedObservation.counters.documentEmbeddings === 1
        && stoppedObservation.counters.nativeStarted === stoppedObservation.counters.nativeSettled);
      await assertOwners(owners); pass({ id: 'stop', ...stoppedObservation.counters, cancelled: true, completionDrained: true, noReady: true });
    } finally { stoppedObservation.release(); if (!appended) await chatAttachmentStorageService.discardDocumentDraft(cancelledDraft); }
    publish({ phase: 'after_stop' });
    check(useChatStore.getState().setActiveThread(fifthThread));
    useChatStore.getState().updateThreadDocumentRetrieval(fifthThread, { mode: 'lexical', rerank: false });
    await renderHook(); await waitIdle(timeoutMs);
    const before = useChatStore.getState().getThread(fifthThread)!.messages.length;
    await bounded(getActions().appendUserMessage('Say hello briefly.'), timeoutMs); await waitIdle(timeoutMs);
    pass({ id: 'after_stop', ...answerReceipt(useChatStore.getState().getThread(fifthThread)!, before), completionDrained: true });
    const history = Object.fromEntries(ownedThreads.map(threadId => [threadId, threadHistory(threadId)]));
    const attachments = ownedThreads.flatMap(threadId => getOwnedRetrievalDocuments(threadId).map(attachment => attachment.localUri));
    publish({ phase: 'cold_retention', status: 'ready_for_cold_reopen' });
    const checkpoint: Checkpoint = { version: 1, ...saved, ownedThreads, owners, fifthThread, history, attachments, evidence };
    getAppStorage().set(CHECKPOINT_KEY, JSON.stringify(checkpoint)); flushPendingChatPersistenceWrites(); keepForCold = true;
  } catch (error) { fail(error); }
  finally {
    if (!keepForCold && idle() && (touchedSettings || ownedThreads.length > 0)) {
      try { await cleanup(saved, ownedThreads, timeoutMs, touchedContext); } catch { publish({ failureCode: 'cleanup_failed', requiresForceStop: true }); }
    }
  }
}
export async function checkAndroidQaDocumentIndexPublicationAfterColdReopen(getActions: () => AndroidQaDocumentIndexHookActions): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled() || evidence.status !== 'idle') return;
  let checkpoint: Checkpoint | undefined; let verifiedOwnership = false; const timeoutMs = 600000;
  try {
    const raw = getAppStorage().getString(CHECKPOINT_KEY); check(raw); checkpoint = JSON.parse(raw) as Checkpoint;
    check(checkpoint.version === 1 && checkpoint.ownedThreads.length === 5 && new Set(checkpoint.ownedThreads).size === 5
      && checkpoint.owners.length === 4 && checkpoint.ownedThreads.includes(checkpoint.fifthThread)
      && checkpoint.owners.every(owner => checkpoint!.ownedThreads.includes(owner.threadId))
      && checkpoint.evidence.status === 'ready_for_cold_reopen'
      && checkpoint.ownedThreads.every(threadId => useChatStore.getState().getThread(threadId)?.title === TITLE));
    verifiedOwnership = true;
    publish({ ...checkpoint.evidence, status: 'running' }); await waitIdle(timeoutMs);
    const owners = new Map(checkpoint.ownedThreads.map(threadId => [threadId, new Set(getOwnedRetrievalDocuments(threadId).map(attachment => attachment.id))]));
    documentIndexStore.reconcile(owners); await assertOwners(checkpoint.owners);
    check(checkpoint.ownedThreads.every(threadId => threadHistory(threadId) === checkpoint!.history[threadId])
      && (await Promise.all(checkpoint.attachments.map(uri => FileSystem.getInfoAsync(uri)))).every(info => info.exists)
      && await attachmentsUnchanged(checkpoint.ownedThreads)
      && getOwnedRetrievalDocuments(checkpoint.fifthThread).every(attachment => !documentIndexStore.inspect(checkpoint!.fifthThread, attachment.id)));
    pass({ id: 'cold_retention', indexCount: 4, oldIndexesRetained: true, historyRetained: true, attachmentsRetained: true, noReady: true });
    publish({ phase: 'next_query' });
    await bounded(llmEngineService.load(ANDROID_QA_DOCUMENT_MODEL_ID, { forceReload: true, loadParamsMode: 'replace',
      loadParamsOverride: { contextSize: 1024, backendPolicy: 'cpu', gpuLayers: 0, mtpEnabled: false, kvCacheType: 'f16',
        cacheTypeK: 'f16', cacheTypeV: 'f16', loraAdapters: [], parallelSlots: 1 } }), timeoutMs);
    check(useChatStore.getState().setActiveThread(checkpoint.fifthThread));
    useChatStore.getState().updateThreadLoraSnapshot(checkpoint.fifthThread, []); await renderHook(); await waitIdle(timeoutMs);
    const before = useChatStore.getState().getThread(checkpoint.fifthThread)!.messages.length;
    await bounded(getActions().appendUserMessage('Say hello briefly.'), timeoutMs); await waitIdle(timeoutMs);
    pass({ id: 'next_query', ...answerReceipt(useChatStore.getState().getThread(checkpoint.fifthThread)!, before), completionDrained: true });
    publish({ phase: 'cleanup' }); await cleanup(checkpoint, checkpoint.ownedThreads, timeoutMs);
    pass({ id: 'cleanup', completionDrained: idle() }); publish({ status: 'passed', phase: 'complete' });
  } catch (error) {
    fail(error);
    if (checkpoint && verifiedOwnership && idle()) { try { await cleanup(checkpoint, checkpoint.ownedThreads, timeoutMs); } catch { publish({ failureCode: 'cleanup_failed', requiresForceStop: true }); } }
  }
}
