import * as FileSystem from 'expo-file-system/legacy';
import { useChatStore, flushPendingChatPersistenceWrites } from '../store/chatStore';
import { getAppStorage } from '../store/storage';
import { CHAT_STREAM_PROGRESS_SCHEMA_VERSION, getChatStreamingProgressStorageKey, readChatStreamingProgressRecord, readChatThreadRecord,
  writeChatStreamingProgressRecord } from '../store/chatPersistence';
import { createChatBranchBaseSemanticIdentity, buildChatBranchReplacementPlan,
  createChatBranchReplacementProgress } from '../store/chatBranchReplacement';
import { createChatId, type ChatThread } from '../types/chat';
import type { LocalToolSettings } from '../types/localTools';
import type { LlamaCompletionResult } from './LlamaRuntimeAdapter';
import { isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { ANDROID_QA_TOOL_FIXTURE, hasAndroidQaVisibleAnswer } from './AndroidQaLocalTools';
import { getLocalToolRunStartCount } from './LocalToolRun';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { getAssistantPresentation } from '../utils/chatPresentation';

export const ANDROID_QA_TOOL_RECOVERY_STEPS = ['ordinary_auto_limit', 'empty_regenerate_stop',
  'empty_branch_stop', 'empty_checkpoint_cold_recovery'] as const;
type StepId = typeof ANDROID_QA_TOOL_RECOVERY_STEPS[number];
type Receipt = { id: StepId; status: 'passed' | 'failed' | 'not_run'; nativeSteps?: number; nativeCalls?: number;
  executedCalls?: number; outputCharacters?: number; stoppedLimit?: boolean; parsedContentRetained?: boolean;
  storedStopped?: boolean; completionDrained?: boolean; firstNativeTokenObserved?: boolean; emptyRunObserved?: boolean;
  historyUnchanged?: boolean; attachmentsRetained?: boolean; otherChatsUnchanged?: boolean; emptyWriteRejected?: boolean;
  legacyCheckpointSeeded?: boolean; legacyCheckpointRejected?: boolean; noReexecution?: boolean };
export type AndroidQaLocalToolsRecoveryEvidence = { schemaVersion: 1; status: 'idle' | 'running' | 'ready_for_cold_reopen' | 'passed' | 'failed';
  phase: StepId | 'idle' | 'preconditions' | 'complete'; steps: Receipt[];
  failureCode?: 'precondition' | 'assertion' | 'timeout' | 'operation_failed' | 'cleanup_failed'; requiresForceStop: boolean };
export type AndroidQaLocalToolsHookActions = { appendUserMessage: (text: string) => Promise<unknown>;
  regenerateLastResponse: () => Promise<unknown>; regenerateFromUserMessage: (id: string, text: string) => Promise<unknown>;
  stopGeneration: () => Promise<unknown> };
type NativeSettlement = { threadId: string; runId: string; phase: 'tools' | 'final'; result: LlamaCompletionResult };
type NativeFirstToken = Omit<NativeSettlement, 'result'>;
const CHECKPOINT_KEY = 'android-qa:local-tools-empty-recovery:v1';
const initial = (): AndroidQaLocalToolsRecoveryEvidence => ({ schemaVersion: 1, status: 'idle', phase: 'idle', steps: [], requiresForceStop: false });
let evidence = initial();
let active: Promise<void> | null = null;
let nativeSettlementObserver: ((value: NativeSettlement) => void) | undefined;
let firstTokenObserver: ((value: NativeFirstToken) => void) | undefined;
const listeners = new Set<() => void>();
export const getAndroidQaLocalToolsRecoveryEvidence = () => evidence;
export function subscribeAndroidQaLocalToolsRecovery(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function publish(patch: Partial<AndroidQaLocalToolsRecoveryEvidence>) {
  evidence = { ...evidence, ...patch }; listeners.forEach(listener => listener());
}
/** QA observers retain no raw tokens. Settled parsed content is compared transiently, never logged. */
export function recordAndroidQaLocalToolNativeFirstToken(value: NativeFirstToken): void {
  if (isAndroidQaDocumentModelBootstrapEnabled()) firstTokenObserver?.(value);
}
export function recordAndroidQaLocalToolNativeSettlement(value: NativeSettlement): void {
  if (isAndroidQaDocumentModelBootstrapEnabled()) nativeSettlementObserver?.(value);
}
class QaFailure extends Error {
  constructor(readonly code: NonNullable<AndroidQaLocalToolsRecoveryEvidence['failureCode']>, readonly forceStop = false) { super(code); }
}
function check(value: unknown): asserts value { if (!value) throw new QaFailure('assertion'); }
async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QaFailure('timeout', true)), ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function androidQaHistoryDigest(value: unknown): string {
  const text = JSON.stringify(canonical(value));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  return `${text.length}:${hash.toString(16)}`;
}
const historyDigest = (thread: ChatThread) => androidQaHistoryDigest(thread.messages);
function otherChatsDigest(threadId: string): string {
  return androidQaHistoryDigest(Object.fromEntries(Object.entries(useChatStore.getState().threads).filter(([id]) => id !== threadId)));
}
function attachmentUris(thread: ChatThread): string[] {
  const uris = thread.messages.flatMap(message => (message.attachments ?? []).map(attachment => {
    check(attachment.threadId === thread.id && attachment.messageId === message.id);
    return attachment.localUri;
  }));
  return [...new Set(uris)];
}
async function attachmentsExist(uris: readonly string[]): Promise<boolean> {
  const results = await Promise.all(uris.map(uri => FileSystem.getInfoAsync(uri)));
  return results.every(result => result.exists);
}
async function waitForHookRender(): Promise<void> { await new Promise<void>(resolve => setTimeout(resolve, 50)); }

/** Runs only on the explicitly isolated QA build. Every generation/Stop uses the mounted production hook. */
export function runAndroidQaLocalToolsRecovery(getActions: () => AndroidQaLocalToolsHookActions,
  options: { operationTimeoutMs?: number } = {}): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled() || evidence.status !== 'idle') return active ?? Promise.resolve();
  active = execute(getActions, options.operationTimeoutMs ?? 210000).finally(() => { active = null; });
  return active;
}
async function execute(getActions: () => AndroidQaLocalToolsHookActions, timeoutMs: number): Promise<void> {
  const originalThread = useChatStore.getState().activeThreadId;
  const originalModel = llmEngineService.getState().activeModelId;
  const originalProfile = llmEngineService.getEffectiveLoadParameters();
  let touchedContext = false;
  let threadId: string | undefined;
  let pending: Receipt | undefined;
  publish({ status: 'running', phase: 'preconditions' });
  const pass = (receipt: Receipt) => publish({ steps: [...evidence.steps, { ...receipt, status: 'passed' }] });
  try {
    if (llmEngineService.hasActiveCompletion() || llmEngineService.hasAuxiliaryContextOperation()) throw new QaFailure('precondition');
    const threads = Object.values(useChatStore.getState().threads).filter(thread => thread.title === 'Android local tools QA'
      && thread.modelId === ANDROID_QA_TOOL_FIXTURE.repository);
    if (threads.length !== 1 || threads[0].messages.length < 8) throw new QaFailure('precondition');
    const retained = threads[0]; threadId = retained.id;
    check(retained.messages.some(message => message.toolRun?.rounds.some(round => round.calls.some(call => call.status === 'completed'))));
    const uris = attachmentUris(retained); check(uris.length > 0 && await attachmentsExist(uris));
    const fixture = registry.getModel(ANDROID_QA_TOOL_FIXTURE.repository);
    check(fixture?.localPath && fixture.downloadIntegrity?.kind === 'sha256'
      && fixture.downloadIntegrity.sha256 === ANDROID_QA_TOOL_FIXTURE.sha256
      && fixture.downloadIntegrity.sizeBytes === ANDROID_QA_TOOL_FIXTURE.size);
    touchedContext = true;
    await bounded(llmEngineService.load(ANDROID_QA_TOOL_FIXTURE.repository, { forceReload: true, loadParamsMode: 'replace',
      loadParamsOverride: { contextSize: 4096, backendPolicy: 'cpu', gpuLayers: 0, mtpEnabled: false,
        kvCacheType: 'f16', cacheTypeK: 'f16', cacheTypeV: 'f16', loraAdapters: [], parallelSlots: 1 } }), timeoutMs);
    check(llmEngineService.getState().diagnostics?.backendMode === 'cpu');
    check(useChatStore.getState().setActiveThread(threadId));
    const auto: LocalToolSettings = { enabled: true, allowedTools: ['calculate'], toolChoice: 'auto' };
    useChatStore.getState().updateThreadToolSettings(threadId, auto);
    useChatStore.getState().updateThreadParamsSnapshot(threadId, { ...retained.paramsSnapshot,
      temperature: 0, topP: 1, seed: 42, maxTokens: 32, reasoningEffort: 'off', output: { mode: 'text' }, template: undefined });
    await waitForHookRender();
    publish({ phase: 'ordinary_auto_limit' });
    pending = { id: 'ordinary_auto_limit', status: 'failed', nativeSteps: 0, nativeCalls: 0, executedCalls: 0 };
    let settlement: NativeSettlement | undefined;
    nativeSettlementObserver = value => {
      if (value.threadId !== threadId) return;
      settlement = value; pending!.nativeSteps! += 1; pending!.nativeCalls! += value.result.tool_calls?.length ?? 0;
    };
    await bounded(getActions().appendUserMessage('Write twenty detailed sentences about a peaceful forest. Begin with ordinary prose. No calculation or tool is needed.'), timeoutMs);
    nativeSettlementObserver = undefined;
    check(settlement);
    const partial = useChatStore.getState().getThread(threadId)!.messages.find(message => message.id === settlement!.runId);
    const parsedContent = settlement.result.content ?? '';
    const parsed = getAssistantPresentation(parsedContent).finalContent;
    pending.outputCharacters = parsed.length;
    pending.stoppedLimit = settlement.result.stopped_limit === true;
    // Preserve exact native parsed content; presentation may hide boundary blank lines.
    pending.parsedContentRetained = Boolean(partial && parsed.trim() && partial.content === parsedContent
      && getAssistantPresentation(partial.content).finalContent === parsed);
    pending.storedStopped = partial?.state === 'stopped' && useChatStore.getState().getThread(threadId)?.status === 'stopped'
      && partial.toolRun?.status === 'interrupted';
    pending.executedCalls = partial?.toolRun?.rounds.flatMap(round => round.calls).filter(call => call.status === 'completed').length ?? 0;
    pending.completionDrained = !llmEngineService.hasActiveCompletion();
    check(pending.nativeSteps === 1 && pending.nativeCalls === 0 && pending.executedCalls === 0 && pending.stoppedLimit
      && pending.parsedContentRetained && pending.storedStopped && pending.completionDrained && hasAndroidQaVisibleAnswer(parsed));
    pass(pending); pending = undefined;
    useChatStore.getState().updateThreadToolSettings(threadId, { ...auto, toolChoice: 'required' });
    useChatStore.getState().updateThreadParamsSnapshot(threadId, { ...retained.paramsSnapshot, temperature: 0, topP: 1, seed: 42,
      reasoningEffort: 'off', output: { mode: 'text' }, template: undefined });
    await waitForHookRender();
    const original = useChatStore.getState().getThread(threadId)!;
    const originalMessages = historyDigest(original);
    const otherChats = otherChatsDigest(threadId);
    const firstUser = original.messages.find(message => message.role === 'user'); check(firstUser);
    for (const id of ['empty_regenerate_stop', 'empty_branch_stop'] as const) {
      publish({ phase: id });
      pending = { id, status: 'failed', nativeSteps: 0, nativeCalls: 0, executedCalls: 0, firstNativeTokenObserved: false, emptyRunObserved: false };
      let stopPromise: Promise<unknown> | undefined;
      let attemptRunId: string | undefined;
      const unsubscribe = useChatStore.subscribe(() => {
        if (!attemptRunId) return;
        const run = useChatStore.getState().getThread(threadId!)?.messages.find(message => message.id === attemptRunId)?.toolRun;
        pending!.executedCalls = Math.max(pending!.executedCalls ?? 0,
          run?.rounds.flatMap(round => round.calls).filter(call => call.result !== undefined).length ?? 0);
      });
      firstTokenObserver = value => {
        if (value.threadId !== threadId || stopPromise) return;
        attemptRunId = value.runId;
        const message = useChatStore.getState().getThread(threadId!)?.messages.find(item => item.id === value.runId);
        pending!.firstNativeTokenObserved = true;
        pending!.emptyRunObserved = Boolean(message?.toolRun && message.toolRun.rounds.length === 0
          && !message.content.trim() && !message.thoughtContent?.trim());
        stopPromise = getActions().stopGeneration();
        void stopPromise.catch(() => undefined);
      };
      nativeSettlementObserver = value => {
        if (value.threadId === threadId) { pending!.nativeSteps! += 1; pending!.nativeCalls! += value.result.tool_calls?.length ?? 0; }
      };
      try {
        await bounded(id === 'empty_regenerate_stop' ? getActions().regenerateLastResponse()
          : getActions().regenerateFromUserMessage(firstUser.id, firstUser.content), timeoutMs);
        if (stopPromise) await bounded(stopPromise, timeoutMs);
      } finally { unsubscribe(); firstTokenObserver = undefined; nativeSettlementObserver = undefined; }
      const after = useChatStore.getState().getThread(threadId)!;
      pending.historyUnchanged = historyDigest(after) === originalMessages;
      pending.attachmentsRetained = androidQaHistoryDigest(attachmentUris(after)) === androidQaHistoryDigest(uris) && await attachmentsExist(uris);
      pending.otherChatsUnchanged = otherChatsDigest(threadId) === otherChats;
      pending.completionDrained = !llmEngineService.hasActiveCompletion();
      check(pending.firstNativeTokenObserved && pending.emptyRunObserved && pending.historyUnchanged
        && pending.attachmentsRetained && pending.otherChatsUnchanged && pending.completionDrained && pending.nativeCalls === 0 && pending.executedCalls === 0);
      pass(pending); pending = undefined; await waitForHookRender();
    }
    publish({ phase: 'empty_checkpoint_cold_recovery' });
    flushPendingChatPersistenceWrites();
    const durable = readChatThreadRecord(getAppStorage(), threadId); check(durable.ok);
    const plan = buildChatBranchReplacementPlan({ thread: durable.value.thread, targetUserMessageId: firstUser.id,
      nextUserContent: firstUser.content, createMessageId: createChatId }); check(plan);
    const checkpointId = createChatId();
    const progress = { schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION as 1, threadId, messageId: checkpointId,
      modelId: ANDROID_QA_TOOL_FIXTURE.repository, createdAt: Date.now(), content: '', state: 'streaming' as const,
      persistedAt: Math.max(Date.now(), durable.value.persistedAt + 1), revision: 1,
      toolRun: { id: checkpointId, threadId, settings: { ...auto, toolChoice: 'required' as const }, phase: 'tools' as const, status: 'running' as const, rounds: [] },
      branchReplacement: createChatBranchReplacementProgress({ durablePersistedAt: durable.value.persistedAt,
        commitRevision: durable.value.commitRevision, baseSemanticIdentity: createChatBranchBaseSemanticIdentity(durable.value.thread),
        targetUserMessageId: firstUser.id, targetUserCreatedAt: firstUser.createdAt }, plan) };
    const written = writeChatStreamingProgressRecord(getAppStorage(), progress);
    check(written.status === 'rejected' && written.reason === 'empty_progress');
    // Equivalent legacy schema-1 journal fixture, scoped to the synthetic QA thread.
    // Current production writes reject it. No native proposal or output is fabricated.
    getAppStorage().set(getChatStreamingProgressStorageKey(threadId), JSON.stringify(progress));
    const read = readChatStreamingProgressRecord(getAppStorage(), threadId);
    check(!read.ok && read.reason === 'invalid_shape');
    getAppStorage().set(CHECKPOINT_KEY, JSON.stringify({ threadId, checkpointId, digest: originalMessages, otherChats,
      attachmentUris: uris, steps: evidence.steps, processStarts: getLocalToolRunStartCount() }));
    publish({ status: 'ready_for_cold_reopen' });
  } catch (error) {
    publish({ status: 'failed', failureCode: error instanceof QaFailure ? error.code : 'operation_failed',
      requiresForceStop: error instanceof QaFailure && error.forceStop,
      steps: [...evidence.steps, ...ANDROID_QA_TOOL_RECOVERY_STEPS.filter(id => !evidence.steps.some(step => step.id === id))
        .map(id => ({ ...(pending?.id === id ? pending : {}), id, status: id === evidence.phase ? 'failed' as const : 'not_run' as const }))] });
  } finally {
    firstTokenObserver = undefined; nativeSettlementObserver = undefined;
    if (touchedContext && !evidence.requiresForceStop) {
      try {
        if (originalModel && originalProfile) await bounded(llmEngineService.load(originalModel, { forceReload: true,
          loadParamsMode: 'replace', loadParamsOverride: originalProfile }), timeoutMs);
        else await bounded(llmEngineService.unload(), timeoutMs);
        useChatStore.getState().setActiveThread(originalThread);
      } catch { publish({ status: 'failed', failureCode: 'cleanup_failed', requiresForceStop: true }); }
    }
  }
}

/** After host force-stop/relaunch: validate the actual hydrated history and attachment files, never replay a run. */
export async function checkAndroidQaLocalToolsRecoveryAfterColdReopen(): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled() || evidence.status !== 'idle') return;
  publish({ status: 'running', phase: 'empty_checkpoint_cold_recovery' });
  try {
    const raw = getAppStorage().getString(CHECKPOINT_KEY); check(raw);
    const saved = JSON.parse(raw) as { threadId: string; checkpointId: string; digest: string; otherChats: string;
      attachmentUris: string[]; steps: Receipt[]; processStarts: number };
    check(useChatStore.persist.hasHydrated());
    const thread = useChatStore.getState().getThread(saved.threadId); check(thread);
    const receipt: Receipt = { id: 'empty_checkpoint_cold_recovery', status: 'passed', emptyWriteRejected: true,
      legacyCheckpointSeeded: true, legacyCheckpointRejected: true,
      historyUnchanged: historyDigest(thread) === saved.digest && !thread.messages.some(message => message.id === saved.checkpointId),
      otherChatsUnchanged: otherChatsDigest(saved.threadId) === saved.otherChats,
      attachmentsRetained: await attachmentsExist(saved.attachmentUris),
      noReexecution: getLocalToolRunStartCount() === 0 && saved.processStarts > 0,
      completionDrained: !llmEngineService.hasActiveCompletion() && !llmEngineService.hasAuxiliaryContextOperation() };
    check(receipt.historyUnchanged && receipt.otherChatsUnchanged && receipt.attachmentsRetained && receipt.noReexecution && receipt.completionDrained);
    publish({ status: 'passed', phase: 'complete', steps: [...saved.steps, receipt] });
    getAppStorage().remove(CHECKPOINT_KEY);
  } catch (error) { publish({ status: 'failed', failureCode: error instanceof QaFailure ? error.code : 'operation_failed' }); }
}
export function resetAndroidQaLocalToolsRecoveryForTests(): void {
  if (process.env.NODE_ENV === 'test') { evidence = initial(); active = null; firstTokenObserver = undefined; nativeSettlementObserver = undefined; }
}
