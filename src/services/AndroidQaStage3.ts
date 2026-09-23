import fixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import { useChatStore } from '../store/chatStore';
import { useDownloadStore } from '../store/downloadStore';
import { DEFAULT_PRESET_SNAPSHOT, type LlmChatCompletionOptions } from '../types/chat';
import { LifecycleStatus } from '../types/models';
import { bindManagedCompanion, getCompanionBindingIdentity, getCompanionSourceIdentity } from '../utils/modelArtifacts';
import { getAdvancedLoadProfileIdentity, type LoraProfileAdapter } from '../utils/advancedLoadProfile';
import { compareProbabilityDistributions, firstTokenProbabilityDistribution } from '../utils/loraProbabilityProbe';
import { ANDROID_QA_DOCUMENT_MODEL_ID, isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { getAndroidQaInferenceSmokeEvidence } from './AndroidQaInferenceSmoke';
import { ANDROID_QA_EMBEDDING_REPO, getAndroidQaModelResourcesEvidence, prepareAndroidQaEmbeddingFixture } from './AndroidQaModelResources';
import { checkAuxiliaryModel, selectAuxiliaryModel } from './AuxiliaryModelService';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { getModelDownloadManager } from './ModelDownloadManager';
import { getSettings, updateSettings, type ModelLoadParameters } from './SettingsStore';
import type { LlamaCompletionResult } from './LlamaRuntimeAdapter';

export const ANDROID_QA_STAGE3_STEPS = [
  'cpu_load', 'text', 'stop', 'json_object', 'json_schema', 'gbnf', 'template_prefill',
  'token_diagnostics', 'invalid_schema', 'invalid_grammar', 'truncated_json', 'structured_cancel', 'ordinary_after_failure',
  'prepare_adapter', 'probability_baseline', 'logit_bias', 'ignore_eos', 'invalid_logit_bias', 'sampling_reset',
  'lora_apply', 'lora_scale', 'lora_remove',
  'lora_restore_baseline', 'prepare_embedding', 'lora_auxiliary_restore', 'lora_delete_guard', 'cleanup',
] as const;
type StepId = typeof ANDROID_QA_STAGE3_STEPS[number];
type Step = { id: StepId; status: 'passed' | 'failed' | 'not_run';
  callbacks?: number; tokensPredicted?: number; tokensEvaluated?: number; outputCharacters?: number;
  adapterCount?: number; scale?: number; sharedTokens?: number; maxDelta?: number; baselineDelta?: number;
  threshold?: number; scaleDelta?: number; tokenCount?: number; dimensions?: number;
  templateGenerationTokensEvaluated?: number; templateGenerationCallbacks?: number; templateGenerationOutputCharacters?: number;
  probabilityBefore?: number; probabilityAfter?: number; eosConfirmed?: boolean; resetEosConfirmed?: boolean;
  contentCharacters?: number; sampledTokens?: number; repeatedTokensPredicted?: number; repeatedSampledTokens?: number;
  hasContent?: boolean; hasReasoning?: boolean; stoppedLimit?: boolean; stoppedEos?: boolean; stoppedWord?: boolean;
  interrupted?: boolean; truncated?: boolean; contextFull?: boolean; completionDrained?: boolean; exactConstraintMatch?: boolean;
  valid?: boolean; stopped?: boolean; historyUnchanged?: boolean; profileRestored?: boolean;
  loadedListConfirmed?: boolean; deletionRejected?: boolean; finite?: boolean; probabilitiesValidated?: boolean;
  structuredIncomplete?: boolean; supportMatched?: boolean };
export type AndroidQaStage3Evidence = {
  schemaVersion: 1; status: 'idle' | 'running' | 'passed' | 'failed'; phase: StepId | 'idle' | 'preconditions' | 'complete';
  requiresForceStop: boolean; failureCode?: 'timeout' | 'precondition' | 'assertion' | 'download' | 'operation_failed' | 'cleanup_failed';
  runtimeVersion: string; backend: 'cpu'; baseRevision: string; baseSha256: string; adapterRevision: string; adapterSha256: string;
  steps: Step[];
  notRun: { backend: 'ios' | 'gpu' | 'npu' | 'mtp'; reason: 'cpu_only_fixture' }[];
};
const initialEvidence = (): AndroidQaStage3Evidence => ({
  schemaVersion: 1, status: 'idle', phase: 'idle', requiresForceStop: false, steps: [],
  runtimeVersion: fixture.runtimeVersion, backend: 'cpu', baseRevision: fixture.base.revision,
  baseSha256: fixture.base.sha256, adapterRevision: fixture.adapter.revision, adapterSha256: fixture.adapter.sha256,
  notRun: (['ios', 'gpu', 'npu', 'mtp'] as const).map(backend => ({ backend, reason: 'cpu_only_fixture' })),
});
let evidence = initialEvidence();
let activeRun: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const getAndroidQaStage3Evidence = () => evidence;
export function subscribeAndroidQaStage3(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function publish(patch: Partial<AndroidQaStage3Evidence>): void {
  evidence = { ...evidence, ...patch }; listeners.forEach(listener => listener());
}
class Stage3Failure extends Error {
  constructor(readonly code: NonNullable<AndroidQaStage3Evidence['failureCode']>, readonly requiresForceStop = false) { super(code); }
}
function check(value: unknown): asserts value { if (!value) throw new Stage3Failure('assertion'); }

export function getAndroidQaCompletionReceipt(result: LlamaCompletionResult, callbacks: number, completionDrained: boolean): Omit<Step, 'id' | 'status'> {
  return {
    callbacks, tokensPredicted: result.tokens_predicted, tokensEvaluated: result.tokens_evaluated,
    outputCharacters: typeof result.text === 'string' ? result.text.length : 0,
    contentCharacters: typeof result.content === 'string' ? result.content.length : 0,
    hasContent: typeof result.content === 'string', hasReasoning: Boolean(result.reasoning_content),
    stoppedLimit: typeof result.stopped_limit === 'boolean' ? result.stopped_limit : undefined,
    stoppedEos: typeof result.stopped_eos === 'boolean' ? result.stopped_eos : undefined,
    stoppedWord: typeof result.stopped_word === 'boolean' ? result.stopped_word : undefined,
    interrupted: typeof result.interrupted === 'boolean' ? result.interrupted : undefined,
    truncated: typeof result.truncated === 'boolean' ? result.truncated : undefined,
    contextFull: typeof result.context_full === 'boolean' ? result.context_full : undefined, completionDrained,
  };
}

export function assertAndroidQaGeneratedReceipt(receipt: Omit<Step, 'id' | 'status'>): void {
  // rc.3 excludes the first sample after multi-token prompt evaluation from its
  // predicted counter. Real callbacks and output prove generation, not counter+1.
  check(Number.isSafeInteger(receipt.tokensPredicted) && receipt.tokensPredicted! >= 0
    && (receipt.callbacks ?? 0) > 0 && (receipt.outputCharacters ?? 0) > 0 && receipt.completionDrained === true);
}

/** A final native probability record proves a sample even when STOP_PARTIAL withheld streaming. */
export function assertAndroidQaProbabilityReceipt(result: LlamaCompletionResult, callbacks: number,
  completionDrained: boolean): Omit<Step, 'id' | 'status'> {
  const receipt = { ...getAndroidQaCompletionReceipt(result, callbacks, completionDrained),
    sampledTokens: result.completion_probabilities?.length ?? 0 };
  check(Number.isSafeInteger(receipt.tokensPredicted) && receipt.tokensPredicted! >= 0 && receipt.tokensPredicted! <= 1
    && Number.isSafeInteger(callbacks) && callbacks >= 0 && receipt.completionDrained === true
    && result.probabilitiesSummary?.requested === 10 && result.probabilitiesSummary.retainedTokens === 1
    && result.probabilitiesSummary.totalTokens === 1 && result.probabilitiesSummary.truncated === false
    && receipt.sampledTokens === 1 && receipt.stoppedLimit === true && receipt.stoppedEos === false && receipt.stoppedWord === false
    && receipt.interrupted === false && receipt.truncated === false && receipt.contextFull === false);
  const distribution = firstTokenProbabilityDistribution(result.completion_probabilities);
  check([...distribution.values()].some(probability => probability > 0));
  return { ...receipt, probabilitiesValidated: true };
}

/** Cancellation evidence must come from a settled native result, never an arbitrary rejection. */
export function assertAndroidQaCancelledReceipt(result: LlamaCompletionResult | null, callbacks: number,
  completionDrained: boolean, structured: boolean): Omit<Step, 'id' | 'status'> {
  check(result);
  const receipt = getAndroidQaCompletionReceipt(result, callbacks, completionDrained);
  check(callbacks > 0 && receipt.interrupted === true && receipt.completionDrained === true);
  if (structured) check(result.structuredOutput?.mode === 'json_schema' && result.structuredOutput.status === 'incomplete');
  return { ...receipt, ...(structured ? { structuredIncomplete: true } : {}) };
}

/** Private comparison only; never export profile values or this identity in QA evidence. */
export function getAndroidQaEffectiveProfileIdentity(profile: ModelLoadParameters | null): string {
  check(profile);
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  return JSON.stringify(canonical(profile));
}
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Stage3Failure('timeout', true)), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function prepareAdapter(timeoutMs: number): Promise<LoraProfileAdapter> {
  const base = registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID);
  check(base && base.downloadIntegrity?.sha256 === fixture.base.sha256);
  const bound = bindManagedCompanion(base, { kind: 'lora_adapter', downloadUrl: fixture.adapter.downloadUrl,
    sha256: fixture.adapter.sha256, sizeBytes: fixture.adapter.sizeBytes });
  const artifact = bound.artifacts?.find(item => item.downloadUrl === fixture.adapter.downloadUrl);
  check(artifact);
  registry.updateModel(bound);
  const manager = getModelDownloadManager();
  if (artifact.installState !== 'installed') manager.prepareCompanion(bound, artifact.id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = registry.getModel(base.id);
    const installed = current?.artifacts?.find(item => item.id === artifact.id);
    if (current && installed?.installState === 'installed' && installed.localPath
      && installed.integrity?.kind === 'sha256' && installed.integrity.sha256 === fixture.adapter.sha256
      && installed.integrity.sizeBytes === fixture.adapter.sizeBytes) {
      return { artifactId: installed.id, artifactIdentity: getCompanionSourceIdentity(installed),
        baseModelIdentity: getCompanionBindingIdentity(current), scale: 1, sizeBytes: installed.sizeBytes ?? undefined };
    }
    const queued = useDownloadStore.getState().queue.find(item => item.id === base.id);
    if (installed?.installState === 'failed' || queued?.lifecycleStatus === LifecycleStatus.FAILED
      || queued?.lifecycleStatus === LifecycleStatus.PAUSED) throw new Stage3Failure('download');
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  throw new Stage3Failure('download');
}

/** Explicit isolated CPU QA. No prompt, generated content, token strings or paths enter evidence. */
export function runAndroidQaStage3(options: { operationTimeoutMs?: number; downloadTimeoutMs?: number } = {}): Promise<void> {
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
  const originalProfile = llmEngineService.getEffectiveLoadParameters();
  const originalModelId = llmEngineService.getState().activeModelId;
  let ownedThread: string | undefined;
  let touchedContext = false;
  let completed = false;
  let pendingStepReceipt: Omit<Step, 'id' | 'status'> = {};
  const abort = new AbortController();
  const phase = (id: StepId) => { pendingStepReceipt = {}; publish({ phase: id }); };
  const pass = (step: Omit<Step, 'status'>) => publish({ steps: [...evidence.steps, { ...step, status: 'passed' }] });
  const assertCpu = () => {
    const state = llmEngineService.getState();
    check(state.activeModelId === ANDROID_QA_DOCUMENT_MODEL_ID && state.status === 'ready'
      && state.diagnostics?.backendMode === 'cpu' && state.diagnostics.actualGpuAccelerated === false
      && state.diagnostics.loadedGpuLayers === 0 && state.diagnostics.initNParallel === 1
      && state.diagnostics.stateCacheBudgetMb === 0 && state.diagnostics.stateCacheMaxCheckpoints === 8);
  };
  const request = (generation: LlmChatCompletionOptions['generation'] = {}, nPredict = 64,
    prompt = 'Write one short sentence about a friendly dog.'): LlmChatCompletionOptions => ({
    messages: [{ role: 'user', content: prompt }], expectedModelId: ANDROID_QA_DOCUMENT_MODEL_ID,
    generation, params: { temperature: 0, top_k: 0, top_p: 1, min_p: 0, penalty_repeat: 1,
      seed: 42, n_predict: nPredict, enable_thinking: false },
  });
  const generate = async (id: StepId, options = request(), validate?: (result: LlamaCompletionResult) => void) => {
    phase(id); let callbacks = 0;
    const tokenCount = id === 'text' ? await bounded(llmEngineService.countPromptTokens(options), operationTimeoutMs) : undefined;
    const result = await bounded(llmEngineService.chatCompletion({ ...options,
      onToken: token => { if ((typeof token === 'string' ? token : token.token).length > 0) callbacks += 1; },
    }), operationTimeoutMs);
    pendingStepReceipt = { ...getAndroidQaCompletionReceipt(result, callbacks, !llmEngineService.hasActiveCompletion()),
      ...(id === 'gbnf' ? { exactConstraintMatch: (result.content ?? result.text) === 'yes' } : {}),
      ...(tokenCount !== undefined ? { tokenCount } : {}) };
    assertAndroidQaGeneratedReceipt(pendingStepReceipt);
    validate?.(result);
    if (tokenCount !== undefined) check(result.tokens_evaluated === tokenCount);
    pass({ id, ...pendingStepReceipt, ...(validate ? { valid: true } : {}) });
    return result;
  };
  const cancelGeneration = async (id: 'stop' | 'structured_cancel', structured: boolean) => {
    phase(id); let callbacks = 0; let settled = false;
    let firstToken: () => void = () => undefined;
    const started = new Promise<void>(resolve => { firstToken = resolve; });
    const operation = llmEngineService.chatCompletion({ ...request(structured
      ? { output: { mode: 'json_schema', schema: JSON.stringify({ type: 'object',
        properties: { story: { type: 'string', minLength: 64, maxLength: 512 } },
        required: ['story'], additionalProperties: false }) } } : {}, 256,
    'Write a very long detailed story about a dog. Continue for many paragraphs.'),
    onToken: token => { if ((typeof token === 'string' ? token : token.token).length > 0) { callbacks += 1; firstToken(); } },
    }).then(result => { settled = true; return result; }, () => { settled = true; return null; });
    await bounded(Promise.race([started, operation]), operationTimeoutMs);
    check(callbacks > 0 && !settled && llmEngineService.hasActiveCompletion());
    const [, result] = await bounded(Promise.all([llmEngineService.stopCompletion(), operation]), operationTimeoutMs);
    const deadline = Date.now() + operationTimeoutMs;
    while (llmEngineService.hasActiveCompletion()) {
      if (Date.now() >= deadline) throw new Stage3Failure('timeout', true);
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    pendingStepReceipt = result ? getAndroidQaCompletionReceipt(result, callbacks, !llmEngineService.hasActiveCompletion())
      : { callbacks, completionDrained: !llmEngineService.hasActiveCompletion() };
    pendingStepReceipt = assertAndroidQaCancelledReceipt(result, callbacks, !llmEngineService.hasActiveCompletion(), structured);
    pass({ id, ...pendingStepReceipt, stopped: true });
  };
  const probabilityRequest = (overrides: LlmChatCompletionOptions['generation'] = {}) => {
    const options = request({ nProbs: fixture.probabilityProbe.nProbs, template: { now: 1700000000 }, ...overrides }, 1,
      'Create an XML behavior tree for a robot that finds a cup, grasps it and places it on a table. Return only the behavior tree.');
    options.params = { ...options.params, temperature: fixture.probabilityProbe.temperature };
    return options;
  };
  const probabilityProbe = async (overrides: LlmChatCompletionOptions['generation'] = {}) => {
    const options = probabilityRequest(overrides);
    let callbacks = 0;
    const result = await bounded(llmEngineService.chatCompletion({ ...options,
      onToken: token => { if ((typeof token === 'string' ? token : token.token).length > 0) callbacks += 1; },
    }), operationTimeoutMs);
    pendingStepReceipt = { ...getAndroidQaCompletionReceipt(result, callbacks, !llmEngineService.hasActiveCompletion()),
      sampledTokens: result.completion_probabilities?.length ?? 0 };
    pendingStepReceipt = assertAndroidQaProbabilityReceipt(result, callbacks, !llmEngineService.hasActiveCompletion());
    return { distribution: firstTokenProbabilityDistribution(result.completion_probabilities), receipt: { ...pendingStepReceipt } };
  };
  const apply = async (profile: LoraProfileAdapter[]) => {
    const loaded = await bounded(llmEngineService.applyLoraConfiguration(ANDROID_QA_DOCUMENT_MODEL_ID, profile,
      { signal: abort.signal, isCurrent: () => useChatStore.getState().activeThreadId === ownedThread }), operationTimeoutMs);
    check(getAdvancedLoadProfileIdentity({ loraAdapters: loaded }) === getAdvancedLoadProfileIdentity({ loraAdapters: profile }));
    assertCpu(); return loaded;
  };
  publish({ status: 'running', phase: 'preconditions' });
  try {
    if (getAndroidQaInferenceSmokeEvidence().status !== 'passed' || getAndroidQaModelResourcesEvidence().status !== 'passed'
      || registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID)?.downloadIntegrity?.sha256 !== fixture.base.sha256
      || llmEngineService.hasActiveCompletion() || llmEngineService.hasAuxiliaryContextOperation()) throw new Stage3Failure('precondition');
    phase('cpu_load');
    touchedContext = true;
    await bounded(llmEngineService.load(ANDROID_QA_DOCUMENT_MODEL_ID, { forceReload: true,
      loadParamsOverride: { contextSize: 512, backendPolicy: 'cpu', gpuLayers: 0, mtpEnabled: false,
        kvCacheType: 'f16', cacheTypeK: 'f16', cacheTypeV: 'f16', loraAdapters: [], parallelSlots: 1 } }), operationTimeoutMs);
    assertCpu(); pass({ id: 'cpu_load' });
    check(useChatStore.getState().beginNewThread());
    ownedThread = useChatStore.getState().createThread({ modelId: ANDROID_QA_DOCUMENT_MODEL_ID, title: 'Android Stage 3 QA',
      presetId: null, presetSnapshot: DEFAULT_PRESET_SNAPSHOT, paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 64, seed: 42 } });
    await generate('text');
    await cancelGeneration('stop', false);
    await generate('json_object', request({ output: { mode: 'json_object' } }, 128, 'Return a JSON object with a single key answer and value yes.'),
      result => { check(result.structuredOutput?.status === 'valid'); check(JSON.parse(result.content ?? result.text ?? '') !== null); });
    await generate('json_schema', request({ output: { mode: 'json_schema', schema: JSON.stringify({ type: 'object',
      properties: { answer: { type: 'string', enum: ['yes', 'no'] } }, required: ['answer'], additionalProperties: false }) } }, 64,
    'Answer yes in the requested JSON object.'), result => {
      check(result.structuredOutput?.status === 'valid');
      const parsed = JSON.parse(result.content ?? result.text ?? '');
      check(parsed && ['yes', 'no'].includes(parsed.answer) && Object.keys(parsed).length === 1);
    });
    await generate('gbnf', request({ output: { mode: 'gbnf', grammar: 'root ::= "yes"' } }, 32, 'Reply no.'),
      result => check((result.content ?? result.text) === 'yes' && result.stopped_limit === false && result.interrupted === false));
    phase('template_prefill');
    const historyBefore = JSON.stringify(useChatStore.getState().threads[ownedThread]);
    const templateRequest = request({ template: {
      chatTemplate: "{% if qa_marker != 'QA' or strftime_now('%Y') != '2023' %}{{ raise_exception('QA formatting mismatch') }}{% endif %}{{ bos_token }}{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}",
      jinja: true, kwargs: { qa_marker: 'QA' }, now: 1700000000, addGenerationPrompt: true, forcePureContent: true, prefillText: 'The answer is',
    } }, 8, 'What is two plus two?');
    const tokenCount = await bounded(llmEngineService.countPromptTokens(templateRequest), operationTimeoutMs);
    const prefill = await bounded(llmEngineService.prefillPrompt(templateRequest), operationTimeoutMs);
    check(tokenCount > 0 && prefill.tokens_predicted === 0 && prefill.tokens_evaluated === tokenCount);
    check(JSON.stringify(useChatStore.getState().threads[ownedThread]) === historyBefore);
    let templateCallbacks = 0;
    const templateCompletion = await bounded(llmEngineService.chatCompletion({ ...templateRequest,
      onToken: token => { if ((typeof token === 'string' ? token : token.token).length > 0) templateCallbacks += 1; },
    }), operationTimeoutMs);
    pendingStepReceipt = { tokenCount, tokensEvaluated: prefill.tokens_evaluated, tokensPredicted: prefill.tokens_predicted,
      templateGenerationTokensEvaluated: templateCompletion.tokens_evaluated, templateGenerationCallbacks: templateCallbacks,
      templateGenerationOutputCharacters: templateCompletion.text?.length ?? 0, historyUnchanged: true };
    assertAndroidQaGeneratedReceipt(getAndroidQaCompletionReceipt(templateCompletion, templateCallbacks, !llmEngineService.hasActiveCompletion()));
    check(templateCompletion.tokens_evaluated === tokenCount);
    pass({ id: 'template_prefill', ...pendingStepReceipt });
    phase('token_diagnostics');
    const tokens = await bounded(llmEngineService.inspectTokens('A friendly dog.', ANDROID_QA_DOCUMENT_MODEL_ID), operationTimeoutMs);
    check(tokens.tokenCount > 0 && tokens.tokens.length === tokens.tokenCount && !tokens.truncated && tokens.detokenized.length > 0);
    pass({ id: 'token_diagnostics', tokenCount: tokens.tokenCount, valid: true });
    for (const id of ['invalid_schema', 'invalid_grammar'] as const) {
      phase(id); let rejected = false;
      try { await bounded(llmEngineService.chatCompletion(request({ output: id === 'invalid_schema'
        ? { mode: 'json_schema', schema: '{' } : { mode: 'gbnf', grammar: 'root ::= "' } })), operationTimeoutMs); }
      catch (error) { if (error instanceof Stage3Failure && error.requiresForceStop) throw error; rejected = true; }
      check(rejected && !llmEngineService.hasActiveCompletion()); pass({ id, valid: true });
    }
    await generate('truncated_json', request({ output: { mode: 'json_schema', schema: JSON.stringify({
      type: 'object', properties: { answer: { type: 'string', enum: ['definitely'] } }, required: ['answer'], additionalProperties: false,
    }) } }, 1, 'Return the required JSON object.'), result => {
      check(result.structuredOutput?.status === 'incomplete' && result.stopped_limit === true);
    });
    await cancelGeneration('structured_cancel', true);
    await generate('ordinary_after_failure');
    phase('prepare_adapter'); const adapter = await prepareAdapter(downloadTimeoutMs); pass({ id: 'prepare_adapter' });
    phase('probability_baseline');
    const baseline = await probabilityProbe(); const repeated = await probabilityProbe();
    const baselineComparison = compareProbabilityDistributions(baseline.distribution, repeated.distribution, { requireSameSupport: true });
    const threshold = Math.max(1e-6, baselineComparison.maxDelta * 10);
    pass({ id: 'probability_baseline', ...baseline.receipt, repeatedTokensPredicted: repeated.receipt.tokensPredicted,
      repeatedSampledTokens: repeated.receipt.sampledTokens, ...baselineComparison, baselineDelta: baselineComparison.maxDelta, threshold, finite: true });
    phase('logit_bias');
    let biasTarget: { token: string; id: number; probability: number } | undefined;
    for (const [token, probability] of baseline.distribution) {
      if (probability <= 1e-6 || probability >= 0.9) continue;
      const inspected = await bounded(llmEngineService.inspectTokens(token, ANDROID_QA_DOCUMENT_MODEL_ID), operationTimeoutMs);
      if (inspected.tokens.length === 1 && !inspected.truncated && inspected.detokenized === token) {
        biasTarget = { token, id: inspected.tokens[0], probability }; break;
      }
    }
    check(biasTarget);
    const biased = await probabilityProbe({ logitBias: [[biasTarget.id, 100]] });
    const biasedProbability = biased.distribution.get(biasTarget.token);
    check(biasedProbability !== undefined && biasedProbability > 0.99 && biasedProbability - biasTarget.probability > threshold);
    pass({ id: 'logit_bias', ...biased.receipt, probabilityBefore: biasTarget.probability, probabilityAfter: biasedProbability, threshold, valid: true });
    phase('ignore_eos');
    // Confirm the pinned model's special end-of-turn token actually stops native
    // generation before proving ignore_eos wins over an explicit positive bias.
    const eos = await bounded(llmEngineService.inspectTokens('<|im_end|>', ANDROID_QA_DOCUMENT_MODEL_ID), operationTimeoutMs);
    check(eos.tokens.length === 1 && !eos.truncated && eos.detokenized === '<|im_end|>');
    const forcedEos = await bounded(llmEngineService.chatCompletion(probabilityRequest({ logitBias: [[eos.tokens[0], 100]] })), operationTimeoutMs);
    check(forcedEos.stopped_eos === true && forcedEos.interrupted === false && !llmEngineService.hasActiveCompletion());
    const suppressedEos = await probabilityProbe({ ignoreEos: true, logitBias: [[eos.tokens[0], 100]] });
    check(suppressedEos.receipt.stoppedEos === false);
    pass({ id: 'ignore_eos', ...suppressedEos.receipt, eosConfirmed: true, valid: true });
    phase('invalid_logit_bias');
    let rejectedBias = false;
    try { await bounded(llmEngineService.chatCompletion(probabilityRequest({ logitBias: [[2_147_483_647, 1]] })), operationTimeoutMs); }
    catch (error) {
      if (error instanceof Stage3Failure && error.requiresForceStop) throw error;
      rejectedBias = error instanceof Error && error.message.includes('logit_bias token is outside the loaded vocabulary');
    }
    check(rejectedBias && !llmEngineService.hasActiveCompletion());
    pass({ id: 'invalid_logit_bias', valid: true });
    phase('sampling_reset');
    const resetEos = await bounded(llmEngineService.chatCompletion(probabilityRequest({ logitBias: [[eos.tokens[0], 100]] })), operationTimeoutMs);
    check(resetEos.stopped_eos === true && resetEos.interrupted === false && !llmEngineService.hasActiveCompletion());
    const samplingReset = await probabilityProbe();
    const resetComparison = compareProbabilityDistributions(baseline.distribution, samplingReset.distribution, { requireSameSupport: true });
    check(resetComparison.maxDelta <= Math.max(1e-6, baselineComparison.maxDelta * 3));
    pass({ id: 'sampling_reset', ...samplingReset.receipt, ...resetComparison, threshold: Math.max(1e-6, baselineComparison.maxDelta * 3), resetEosConfirmed: true, valid: true });
    phase('lora_apply'); await apply([adapter]);
    const adapted = await probabilityProbe(); const change = compareProbabilityDistributions(baseline.distribution, adapted.distribution);
    check(change.maxDelta > threshold);
    pass({ id: 'lora_apply', ...adapted.receipt, ...change, threshold, adapterCount: 1, scale: 1, loadedListConfirmed: true });
    phase('lora_scale'); await apply([{ ...adapter, scale: 0.5 }]);
    const half = await probabilityProbe(); const halfChange = compareProbabilityDistributions(baseline.distribution, half.distribution);
    const scaleChange = compareProbabilityDistributions(adapted.distribution, half.distribution);
    check(halfChange.maxDelta > threshold && scaleChange.maxDelta > threshold);
    pass({ id: 'lora_scale', ...half.receipt, ...halfChange, scaleDelta: scaleChange.maxDelta, threshold, adapterCount: 1, scale: 0.5, loadedListConfirmed: true });
    phase('lora_remove'); await apply([]); pass({ id: 'lora_remove', adapterCount: 0, loadedListConfirmed: true });
    phase('lora_restore_baseline'); const removed = await probabilityProbe();
    const restored = compareProbabilityDistributions(baseline.distribution, removed.distribution, { requireSameSupport: true });
    check(restored.maxDelta <= Math.max(1e-6, baselineComparison.maxDelta * 3));
    pass({ id: 'lora_restore_baseline', ...removed.receipt, ...restored, threshold: Math.max(1e-6, baselineComparison.maxDelta * 3) });
    phase('prepare_embedding'); const embedding = await prepareAndroidQaEmbeddingFixture(downloadTimeoutMs); pass({ id: 'prepare_embedding' });
    await apply([{ ...adapter, scale: 0.5 }]);
    phase('lora_auxiliary_restore'); selectAuxiliaryModel('embedding', embedding);
    const before = getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters());
    const history = JSON.stringify(useChatStore.getState().threads[ownedThread]);
    const auxiliary = await bounded(checkAuxiliaryModel('embedding', { signal: abort.signal, verifyEmbedding: true }), operationTimeoutMs);
    check(auxiliary.dimensions === 384 && before === getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters()));
    check(history === JSON.stringify(useChatStore.getState().threads[ownedThread])); assertCpu();
    const afterAuxiliary = await probabilityProbe();
    const auxiliaryRestored = compareProbabilityDistributions(half.distribution, afterAuxiliary.distribution, { requireSameSupport: true });
    check(auxiliaryRestored.maxDelta <= Math.max(1e-6, baselineComparison.maxDelta * 3));
    pass({ id: 'lora_auxiliary_restore', ...afterAuxiliary.receipt, ...auxiliaryRestored, threshold: Math.max(1e-6, baselineComparison.maxDelta * 3),
      dimensions: 384, profileRestored: true, historyUnchanged: true });
    phase('lora_delete_guard'); let rejected = false;
    try { await getModelDownloadManager().removeCompanion(ANDROID_QA_DOCUMENT_MODEL_ID, adapter.artifactId); }
    catch (error) { rejected = error !== null && typeof error === 'object' && 'code' in error && error.code === 'engine_busy'; }
    check(rejected && registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID)?.artifacts?.some(item => item.id === adapter.artifactId && item.installState === 'installed'));
    pass({ id: 'lora_delete_guard', deletionRejected: true });
    phase('cleanup'); await apply([]);
    completed = true;
  } catch (error) {
    abort.abort();
    const requiresForceStop = (error instanceof Stage3Failure && error.requiresForceStop) || llmEngineService.hasActiveCompletion()
      || llmEngineService.hasAuxiliaryContextOperation() || llmEngineService.getState().diagnostics?.contextRecoveryStatus === 'failed';
    const completed = new Set(evidence.steps.map(step => step.id));
    const failedPhase = evidence.phase;
    publish({ status: 'failed', failureCode: error instanceof Stage3Failure ? error.code : 'operation_failed', requiresForceStop,
      steps: [...evidence.steps, ...ANDROID_QA_STAGE3_STEPS.filter(id => !completed.has(id)).map(id => ({ id,
        ...(id === failedPhase ? pendingStepReceipt : {}), status: id === failedPhase ? 'failed' as const : 'not_run' as const }))] });
    if (failedPhase === 'prepare_adapter') await getModelDownloadManager().cancelDownload(ANDROID_QA_DOCUMENT_MODEL_ID).catch(() => undefined);
    if (failedPhase === 'prepare_embedding') await getModelDownloadManager().cancelDownload(ANDROID_QA_EMBEDDING_REPO).catch(() => undefined);
  } finally {
    if (touchedContext && !evidence.requiresForceStop) {
      try {
        if (originalModelId && originalProfile) await bounded(llmEngineService.load(originalModelId,
          { forceReload: true, loadParamsOverride: originalProfile }), operationTimeoutMs);
        else await bounded(llmEngineService.unload(), operationTimeoutMs);
        if (ownedThread) useChatStore.getState().deleteThread(ownedThread);
        useChatStore.getState().setActiveThread(originalThread);
        updateSettings({ auxiliaryModels: originalBindings });
      } catch {
        publish({ status: 'failed', phase: 'cleanup', failureCode: 'cleanup_failed', requiresForceStop: true,
          steps: [...evidence.steps.filter(step => step.id !== 'cleanup'), { id: 'cleanup', status: 'failed' }] });
      }
    }
  }
  if (completed && evidence.status !== 'failed') {
    pass({ id: 'cleanup', adapterCount: 0, loadedListConfirmed: true });
    publish({ status: 'passed', phase: 'complete' });
  }
}

export function resetAndroidQaStage3ForTests(): void {
  if (process.env.NODE_ENV === 'test') { evidence = initialEvidence(); activeRun = null; }
}
