import * as FileSystem from 'expo-file-system/legacy';
import type { CompletionParams, LlamaContext, ParallelStatus } from 'llama.rn';
import fixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import retrievalFixture from '../../docs/validation/llama-rn-stage5/retrieval-fixtures.json';
import { useChatStore } from '../store/chatStore';
import { createChatId, type LlmChatMessage } from '../types/chat';
import { DocumentRetrievalError } from '../types/documentRetrieval';
import type { ChatDocumentAttachmentDraft } from '../types/attachments';
import { freezeGenerationParameters } from '../utils/generationControls';
import { getCompanionBindingIdentity } from '../utils/modelArtifacts';
import { ANDROID_QA_DOCUMENT_MODEL_ID, isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { getAndroidQaEffectiveProfileIdentity, prepareAndroidQaStage3Adapter } from './AndroidQaStage3';
import { prepareAndroidQaDocumentRetrievalModels } from './AndroidQaDocumentRetrieval';
import { getAppCacheRootDir } from './FileSystemSetup';
import { registry } from './LocalStorageRegistry';
import { llmEngineService, type ComparisonCompletionOutcome, type ComparisonSamplingParams } from './LLMEngineService';
import { PreparedLlamaRequestCache } from './PreparedLlamaRequest';
import { tokenizeFormattedPrompt, type LlamaCompletionResult } from './LlamaRuntimeAdapter';
import { enableParallelContext, disableParallelContext, startParallelCompletion, subscribeParallelStatus,
  getParallelContextStatus, type ParallelCompletionHandle } from './LlamaParallelRequests';
import { getFreshMemorySnapshot } from './SystemMetricsService';
import { LLAMA_SOURCE_PATCH_SHA256 } from './LlamaSourcePatchIdentity';
import { chatAttachmentStorageService, materializeDocumentDraftsForProcessing } from './ChatAttachmentStorageService';
import { chatAttachmentProcessorRegistry } from './ChatAttachmentProcessorRegistry';
import { retrieveDocumentCandidates } from './DocumentRetrievalService';
import { resolveRetrievalRuntimeBinding } from './DocumentRetrievalRuntime';

export type AndroidQaParallelMode = 'single' | 'compare' | 'stop_one' | 'prepare_auxiliary' | 'auxiliary';
type Step = { id: string; slots: 1 | 2; status: 'passed'; callbacks?: number[]; ttftMs?: number[];
  totalMs?: number; nativeWindowMs?: number; peakSampledPssBytes?: number; peakSampledResidentBytes?: number;
  overlapObserved?: boolean; maxGenerating?: number; nativeIdsDistinct?: boolean; markersMatched?: boolean;
  queuedStop?: boolean; runningStop?: boolean; nextSucceeded?: boolean; drainConfirmed?: boolean;
  embeddingStarted?: number; rerankStarted?: number; nativeSettled?: number; restored?: number;
  profileRestored?: boolean; loraCount?: number; candidateCount?: number; indicesValidated?: boolean };
export type AndroidQaParallelEvidence = { schemaVersion: 1; status: 'idle' | 'running' | 'fixtures_ready' | 'native_passed' | 'failed';
  phase: string; mode?: AndroidQaParallelMode; runtimeVersion: '0.13.0-rc.3'; sourcePatchSha256: string;
  backend: 'cpu'; requiresForceStop: boolean; failureCode?: string; steps: Step[];
  uiChoice: 'not_run'; physicalPerformance: 'not_run'; automaticResume: false;
  timingDefinition: 'native_window_admission_through_terminal_drain_total_includes_context_lifecycle'; };
let evidence: AndroidQaParallelEvidence = initial();
let active: Promise<void> | null = null;
const listeners = new Set<() => void>();
function initial(): AndroidQaParallelEvidence {
  return { schemaVersion: 1, status: 'idle', phase: 'idle', runtimeVersion: '0.13.0-rc.3',
    sourcePatchSha256: LLAMA_SOURCE_PATCH_SHA256, backend: 'cpu', requiresForceStop: false,
    steps: [], uiChoice: 'not_run', physicalPerformance: 'not_run', automaticResume: false,
    timingDefinition: 'native_window_admission_through_terminal_drain_total_includes_context_lifecycle' };
}
export const getAndroidQaParallelRequestsEvidence = () => evidence;
export function subscribeAndroidQaParallelRequests(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function isAndroidQaParallelRequestsEnabled(): boolean {
  return isAndroidQaDocumentModelBootstrapEnabled() && /\.qa\/cache\/$/u.test(getAppCacheRootDir() ?? '');
}
function publish(patch: Partial<AndroidQaParallelEvidence>): void {
  evidence = { ...evidence, ...patch }; listeners.forEach(listener => listener());
}
class QaFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new QaFailure(code); }
function pass(step: Omit<Step, 'status'>): void { publish({ steps: [...evidence.steps, { ...step, status: 'passed' }] }); }
const markers = ['QA_ALPHA_81 ', 'QA_BETA_81 '] as const;
const messages: LlmChatMessage[] = [{ role: 'user', content: 'Continue the answer with a short explanation of why leaves are green.' }];
const variant = (index: 0 | 1, nPredict = 64) => ({
  params: { n_predict: nPredict, temperature: 0, top_p: 1, top_k: 40, min_p: 0, seed: 81 + index,
    penalty_repeat: 1, enable_thinking: false } satisfies ComparisonSamplingParams,
  generation: { ignoreEos: true, template: { prefillText: markers[index] } },
});
function restored(profile: string): void {
  check(!llmEngineService.hasActiveCompletion() && !llmEngineService.hasAuxiliaryContextOperation(), 'native_owner_not_drained');
  check(llmEngineService.getState().activeModelId === ANDROID_QA_DOCUMENT_MODEL_ID, 'model_not_restored');
  check(getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters()) === profile, 'profile_not_restored');
}
function captureOwner() {
  check(isAndroidQaParallelRequestsEnabled(), 'isolated_qa_required');
  const model = registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID);
  const profile = llmEngineService.getEffectiveLoadParameters();
  check(model?.localPath && model.downloadIntegrity?.sha256 === fixture.base.sha256, 'pinned_text_fixture_required');
  check(llmEngineService.getState().activeModelId === model.id && profile?.backendPolicy === 'cpu'
    && llmEngineService.getLoadedGpuLayers() === 0 && !profile.mtpEnabled, 'loaded_cpu_fixture_required');
  check(!llmEngineService.hasActiveCompletion() && !llmEngineService.hasAuxiliaryContextOperation(), 'engine_busy');
  const threadId = useChatStore.getState().activeThreadId;
  const fileIdentity = getCompanionBindingIdentity(model);
  const isCurrent = () => {
    const current = registry.getModel(model.id);
    return useChatStore.getState().activeThreadId === threadId && Boolean(current)
      && getCompanionBindingIdentity(current!) === fileIdentity;
  };
  return { model, profile, isCurrent, fileIdentity, profileIdentity: getAndroidQaEffectiveProfileIdentity(profile) };
}

async function measured<T>(operation: () => Promise<T>): Promise<{ value: T; totalMs: number;
  peakSampledPssBytes?: number; peakSampledResidentBytes?: number }> {
  let pss: number | undefined; let resident: number | undefined; let pending: Promise<void> | null = null;
  const sample = () => {
    if (pending) return pending;
    pending = getFreshMemorySnapshot(0).then(snapshot => {
      if (snapshot?.appPssBytes !== undefined) pss = Math.max(pss ?? 0, snapshot.appPssBytes);
      if (snapshot?.appResidentBytes !== undefined) resident = Math.max(resident ?? 0, snapshot.appResidentBytes);
    }).catch(() => undefined).finally(() => { pending = null; });
    return pending;
  };
  await sample();
  const start = Date.now();
  const timer = setInterval(() => { void sample(); }, 100);
  try { return { value: await operation(), totalMs: Date.now() - start,
    ...(pss !== undefined ? { peakSampledPssBytes: pss } : {}),
    ...(resident !== undefined ? { peakSampledResidentBytes: resident } : {}) }; }
  finally { clearInterval(timer); if (pending) await pending; }
}

async function withSingleContext<T>(operation: (context: LlamaContext, prepared: CompletionParams[], profileIdentity: string) => Promise<T>): Promise<T> {
  const owner = captureOwner();
  check((owner.profile.loraAdapters?.length ?? 0) === 0, 'benchmark_requires_unadapted_fixture');
  const nativeProfile = llmEngineService.getEffectiveNativeInitParameters();
  check(nativeProfile && !nativeProfile.embedding && !nativeProfile.speculative && !nativeProfile.model_draft,
    'native_text_profile_required');
  const contextTokens = llmEngineService.getContextSize();
  check(contextTokens >= 512 && contextTokens <= 4096, 'bounded_context_required');
  const value = await llmEngineService.runWithAuxiliaryContext({ modelId: owner.model.id,
    isCurrent: owner.isCurrent, nativeDrainTimeoutMs: 120_000,
    initParams: { ...nativeProfile, n_ctx: contextTokens, n_parallel: 1, n_gpu_layers: 0,
      ctx_shift: false, state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 },
  }, async context => {
    const cache = new PreparedLlamaRequestCache();
    const prepared: CompletionParams[] = [];
    const frozenNow = Math.floor(Date.now() / 1000);
    for (const index of [0, 1] as const) {
      const config = variant(index, 128);
      const request = await cache.prepare({ context, epoch: 1, messages, generation: freezeGenerationParameters(config.generation, frozenNow),
        enableThinking: false, reasoningFormat: 'none' });
      const tokens = await tokenizeFormattedPrompt({ context, prompt: request.completion.prompt ?? '' });
      check(tokens.tokens.length + 128 + 16 <= contextTokens, 'prompt_budget_exceeded');
      prepared.push({ ...request.completion, ...config.params, ignore_eos: config.generation.ignoreEos,
        stop: [...(request.formatted.additional_stops ?? [])] });
    }
    await enableParallelContext(context, { n_parallel: 1, n_batch: nativeProfile.n_batch ?? 512 });
    try { return await operation(context, prepared, owner.profileIdentity); }
    finally { cache.clear(); await disableParallelContext(context); }
  });
  restored(owner.profileIdentity);
  return value;
}
function start(context: LlamaContext, params: CompletionParams, index: number, profileIdentity: string,
  onToken: () => void): ParallelCompletionHandle {
  return startParallelCompletion({ context, params, onToken,
    identity: { id: `qa81-${index}`, ownerId: 'qa81-single', modelId: ANDROID_QA_DOCUMENT_MODEL_ID,
      fileIdentity: fixture.base.sha256, contextEpoch: 1, profileIdentity, outputMode: 'text' } });
}
async function singleCancellation(): Promise<void> {
  publish({ phase: 'single_slot_cancel' });
  const callbacks = [0, 0, 0];
  let queuedStop = false; let runningStop = false;
  await withSingleContext(async (context, prepared, identity) => {
    const handles: ParallelCompletionHandle[] = [];
    let current = true;
    const remove = await subscribeParallelStatus(context, status => {
      const queued = handles[1]; const running = handles[0];
      if (queued && !queuedStop && status.requests.some(item => item.request_id === queued.nativeRequestId && item.state === 'queued')) {
        queuedStop = true; void queued.cancel().catch(() => undefined);
      }
      if (running && queuedStop && callbacks[0] > 0 && !runningStop
        && status.requests.some(item => item.request_id === running.nativeRequestId && item.state === 'generating')) {
        runningStop = true; void running.cancel().catch(() => undefined);
      }
    }, () => current);
    try {
      for (const index of [0, 1, 2]) {
        const handle = start(context, { ...prepared[index % 2], n_predict: index === 2 ? 32 : 128 }, index, identity, () => { callbacks[index] += 1; });
        handles.push(handle); void handle.promise.catch(() => undefined);
      }
      const results = await Promise.all(handles.map(handle => handle.promise));
      check(queuedStop && runningStop && results[0].interrupted === true && results[1].interrupted === true
        && callbacks[1] === 0 && callbacks[2] > 0 && results[2].interrupted !== true, 'single_cancel_receipt_failed');
      const status = await getParallelContextStatus(context);
      check(status.requests.length === 0 && status.active_slots === 0 && status.queued_requests === 0, 'single_drain_failed');
    } finally {
      current = false; remove();
      await Promise.all(handles.map(handle => handle.cancel().catch(() => undefined)));
      await Promise.allSettled(handles.map(handle => handle.promise));
    }
  });
  pass({ id: 'queued_running_stop_then_success', slots: 1, callbacks, queuedStop, runningStop, nextSucceeded: true, drainConfirmed: true });
}
async function sequentialBench(): Promise<void> {
  const callbacks = [0, 0]; const ttftMs = [-1, -1];
  const metrics = await measured(() => withSingleContext(async (context, prepared, identity) => {
    const begin = Date.now();
    for (const index of [0, 1]) {
      const startAt = Date.now();
      const result = await start(context, { ...prepared[index], n_predict: 64 }, index, identity, () => {
        callbacks[index] += 1; if (ttftMs[index] < 0) ttftMs[index] = Date.now() - startAt;
      }).promise;
      check(result.interrupted !== true && callbacks[index] > 0, 'sequential_completion_failed');
    }
    return Date.now() - begin;
  }));
  const { value: nativeWindowMs, ...timing } = metrics;
  pass({ id: 'sequential_pair', slots: 1, callbacks, ttftMs, nativeWindowMs, ...timing, drainConfirmed: true });
}
function markerMatches(result: LlamaCompletionResult, index: 0 | 1): boolean {
  const content = result.content ?? result.text;
  return typeof content === 'string' && content.includes(markers[index].trim()) && !content.includes(markers[index === 0 ? 1 : 0].trim());
}
async function compare(stopOne: boolean): Promise<void> {
  const owner = captureOwner();
  check((owner.profile.loraAdapters?.length ?? 0) === 0, 'benchmark_requires_unadapted_fixture');
  const callbacks = [0, 0]; const ttftMs = [-1, -1]; let startAt = 0; let terminalAt = 0;
  const finished = new Set<number>();
  let maxGenerating = 0; let nativeIdsDistinct = false; let stopped = false;
  const status = (snapshot: ParallelStatus) => {
    // The engine explicitly reads an empty snapshot before either request is admitted.
    if (!startAt) startAt = Date.now();
    const generating = snapshot.requests.filter(item => item.type === 'completion' && item.state === 'generating');
    maxGenerating = Math.max(maxGenerating, generating.length);
    if (generating.length === 2 && new Set(generating.map(item => item.request_id)).size === 2) nativeIdsDistinct = true;
    if (stopOne && nativeIdsDistinct && callbacks[0] > 0 && callbacks[1] > 0 && !stopped) {
      stopped = true; void llmEngineService.stopComparisonVariant(0).catch(() => undefined);
    }
  };
  const metrics = await measured(() => llmEngineService.compareChatCompletions({ messages, expectedModelId: owner.model.id,
    variants: [variant(0, stopOne ? 128 : 64), variant(1, stopOne ? 128 : 64)], isCurrent: owner.isCurrent,
    onState: (index, state) => {
      if (state === 'completed' || state === 'cancelled' || state === 'error') {
        finished.add(index);
        if (finished.size === 2) terminalAt = Date.now();
      }
    }, onNativeStatus: status,
    onToken: index => { callbacks[index] += 1; if (ttftMs[index] < 0) ttftMs[index] = Date.now() - startAt; },
  }));
  restored(owner.profileIdentity);
  const results: readonly ComparisonCompletionOutcome[] = metrics.value;
  check(startAt > 0 && terminalAt >= startAt, 'native_timing_receipt_failed');
  check(nativeIdsDistinct && maxGenerating === 2 && callbacks.every(count => count > 0), 'native_overlap_not_observed');
  check(results[1].status === 'success' && markerMatches(results[1].result, 1), 'second_marker_failed');
  if (stopOne) check(stopped && results[0].status === 'cancelled', 'independent_stop_failed');
  else check(results[0].status === 'success' && markerMatches(results[0].result, 0), 'first_marker_failed');
  const { value: _results, ...timing } = metrics;
  pass({ id: stopOne ? 'two_slot_stop_one' : 'two_slot_pair', slots: 2, callbacks, ttftMs,
    nativeWindowMs: terminalAt - startAt, ...timing, maxGenerating, nativeIdsDistinct,
    overlapObserved: true, markersMatched: true, ...(stopOne ? { runningStop: true, nextSucceeded: true } : {}), drainConfirmed: true });
}

async function auxiliary(): Promise<void> {
  const owner = captureOwner();
  check((owner.profile.loraAdapters?.length ?? 0) > 0, 'loaded_lora_fixture_required');
  check(owner.profile.loraAdapters!.every(adapter => owner.model.artifacts?.some(artifact =>
    artifact.id === adapter.artifactId && artifact.installState === 'installed'
    && artifact.integrity?.kind === 'sha256' && artifact.integrity.sha256 === fixture.adapter.sha256
    && artifact.integrity.sizeBytes === fixture.adapter.sizeBytes)), 'pinned_lora_fixture_required');
  const checkSelection = () => { check(owner.isCurrent(), 'selection_changed'); };
  // Never download or silently replace the auxiliary selections from this harness.
  for (const role of ['embedding', 'reranker'] as const) {
    const binding = resolveRetrievalRuntimeBinding(role, { assertCurrent: checkSelection });
    const expected = retrievalFixture.models.find(item => item.role === role);
    check(registry.getModel(binding.modelId)?.downloadIntegrity?.sha256 === expected?.sha256, 'pinned_auxiliary_selection_required');
  }
  const temporary = `${getAppCacheRootDir()}parallel-qa-${createChatId()}.txt`;
  let draft: ChatDocumentAttachmentDraft | undefined;
  try {
    const doc = retrievalFixture.corpus.documents[0];
    await FileSystem.writeAsStringAsync(temporary, doc.paragraphs.slice(0, 2).map(item => item.text).join('\n\n'));
    draft = await chatAttachmentStorageService.copyDocumentAssetToDraft({ uri: temporary, name: 'parallel-qa.txt', mimeType: 'text/plain' });
    const attachment = materializeDocumentDraftsForProcessing({ threadId: createChatId(), messageId: createChatId(), drafts: [draft] })[0];
    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(attachment, { query: '', maxChars: 16000, maxChunks: 4 });
    check(result.chunks.length > 0 && result.chunks.length <= 2, 'bounded_document_required');
    const entry = { attachment, result };
    for (const cancel of [true, false]) {
      publish({ phase: cancel ? 'auxiliary_stop_drain' : 'auxiliary_next_search' });
      const controller = new AbortController();
      let embeddingStarted = 0; let rerankStarted = 0; let nativeSettled = 0; let restoredCount = 0; let indicesValidated = false;
      let cancelled = false; let candidateCount = 0;
      try {
        const found = await retrieveDocumentCandidates(doc.paragraphs[0].text, [entry], { mode: 'hybrid', rerank: true }, {
          prepareMissing: true, signal: controller.signal, assertCurrent: checkSelection, assertSelectionCurrent: checkSelection,
          assertProvisionalEntryCurrent: candidate => { checkSelection(); check(candidate.attachment.id === attachment.id && Boolean(draft), 'draft_owner_changed'); },
          onRestored: () => { restoredCount += 1; },
          onNativeOperation: event => {
            if (event.phase === 'started') {
              if (event.operation === 'embedding') embeddingStarted += 1; else rerankStarted += 1;
              if (cancel) controller.abort();
            } else {
              nativeSettled += 1;
              if (event.operation === 'rerank' && event.indices) indicesValidated = event.indices.length > 0
                && new Set(event.indices).size === event.indices.length
                && event.indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < (event.inputCount ?? 0));
            }
          },
        });
        check(!cancel && found.actualMode === 'hybrid+rerank' && !found.fallbackReason && found.candidates.length > 0, 'production_search_failed');
        candidateCount = found.candidates.length;
      } catch (error) {
        if (cancel && error instanceof DocumentRetrievalError && error.code === 'cancelled') cancelled = true;
        else throw error;
      }
      restored(owner.profileIdentity);
      check(nativeSettled === embeddingStarted + rerankStarted && restoredCount === 1, 'auxiliary_drain_failed');
      check(cancel ? cancelled && embeddingStarted === 1 && rerankStarted === 0
        : embeddingStarted >= 2 && rerankStarted === 1 && indicesValidated, 'auxiliary_receipt_failed');
      pass({ id: cancel ? 'auxiliary_stop_drain' : 'auxiliary_next_search', slots: 1,
        embeddingStarted, rerankStarted, nativeSettled, restored: restoredCount, candidateCount,
        indicesValidated, profileRestored: true, loraCount: owner.profile.loraAdapters!.length, drainConfirmed: true,
        ...(cancel ? { runningStop: true } : { nextSucceeded: true }) });
    }
  } finally {
    // Production retrieval does not return until accepted native work and restoration drain.
    if (draft) await chatAttachmentStorageService.discardDocumentDraft(draft);
    await FileSystem.deleteAsync(temporary, { idempotent: true });
  }
}

async function prepareAuxiliary(): Promise<void> {
  const owner = captureOwner();
  const threadId = useChatStore.getState().activeThreadId;
  const isCurrent = () => useChatStore.getState().activeThreadId === threadId
    && registry.getModel(owner.model.id)?.downloadIntegrity?.sha256 === fixture.base.sha256;
  publish({ phase: 'prepare_pinned_auxiliary_files' });
  await prepareAndroidQaDocumentRetrievalModels(600_000);
  check(isCurrent(), 'selection_changed');
  const adapter = await prepareAndroidQaStage3Adapter(600_000);
  check(isCurrent(), 'selection_changed');
  publish({ phase: 'apply_pinned_lora' });
  await llmEngineService.applyLoraConfiguration(owner.model.id, [adapter], { isCurrent });
}

export function runAndroidQaParallelRequests(mode: AndroidQaParallelMode = 'single'): Promise<void> {
  if (active) return active;
  if (!isAndroidQaParallelRequestsEnabled() || evidence.requiresForceStop) return Promise.resolve();
  evidence = initial(); publish({ status: 'running', mode, phase: 'preconditions' });
  active = (async () => {
    try {
      captureOwner();
      if (mode === 'single') await singleCancellation();
      else if (mode === 'compare') { publish({ phase: 'sequential_pair' }); await sequentialBench(); publish({ phase: 'two_slot_pair' }); await compare(false); }
      else if (mode === 'stop_one') { publish({ phase: 'two_slot_stop_one' }); await compare(true); }
      else if (mode === 'prepare_auxiliary') await prepareAuxiliary();
      else await auxiliary();
      publish({ status: mode === 'prepare_auxiliary' ? 'fixtures_ready' : 'native_passed', phase: 'complete' });
    } catch (error) {
      const recovery = llmEngineService.getState().diagnostics?.contextRecoveryStatus;
      publish({ status: 'failed', failureCode: error instanceof QaFailure ? error.code : 'operation_failed',
        requiresForceStop: llmEngineService.hasActiveCompletion() || llmEngineService.hasAuxiliaryContextOperation()
          || Boolean(recovery && recovery !== 'idle') });
    } finally {
      try { await FileSystem.writeAsStringAsync(`${getAppCacheRootDir()}stage8-parallel-${mode}.json`, JSON.stringify(evidence)); }
      catch { /* Accessibility evidence remains available when cache export fails. */ }
      active = null;
    }
  })();
  return active;
}
