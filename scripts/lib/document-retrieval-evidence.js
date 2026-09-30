const fixture = require('../../docs/validation/llama-rn-stage5/retrieval-fixtures.json');
const STEP_IDS = ['prepare_models', 'prepare_corpus', 'stop_prepare', 'prepare_indexes', 'corpus_rankings', 'repeat_query', 'lora_handoff',
  'tool_schema', 'stop_drain', 'next_query', 'cold_reuse', 'delete_corpus', 'deleted_reuse', 'cleanup'];
const MODES = ['lexical', 'hybrid', 'hybrid_rerank'];
const ISSUES = ['model_unavailable', 'profile_unverified', 'index_not_ready', 'index_stale', 'quota_exceeded', 'input_too_large',
  'invalid_vector', 'invalid_ranking', 'native_failed', 'cancelled', 'ownership_changed', 'restore_failed'];
const IDENTITIES = { fixtureId: fixture.fixtureId, runtimeVersion: fixture.runtimeVersion, backend: 'cpu',
  embeddingSha256: fixture.models[0].sha256, rerankerSha256: fixture.models[1].sha256 };
const LORA_OPERATIONS = ['adapter_lookup', 'idle_barrier', 'adapter_apply', 'baseline_probe', 'repeat_probe', 'baseline_compare',
  'retrieval_handoff', 'profile_check', 'restored_probe', 'probability_compare', 'prompt_count', 'answer_completion',
  'answer_check', 'adapter_remove'];
const OPERATION_ERRORS = ['action_failed', 'engine_not_ready', 'engine_busy', 'engine_recovery_required', 'engine_unloading',
  'model_not_found', 'model_load_blocked', 'model_load_failed', 'model_incompatible', 'model_memory_insufficient',
  'model_memory_warning', 'storage_private_unavailable', 'probabilities_missing', 'probabilities_invalid',
  'probability_support_mismatch', 'probability_overlap_insufficient', 'probability_receipt_invalid'];
const COUNTERS = ['documentEmbeddings', 'queryEmbeddings', 'rerankCalls', 'nativeStarted', 'nativeSettled', 'restored'];
const NUMBERS = [...COUNTERS, 'chunkCount', 'indexCount', 'nativeSteps', 'toolCalls', 'outputCharacters', 'promptTokens', 'tokensEvaluated'];
const BOOLEANS = ['fixtureVerified', 'profileRestored', 'probabilityRestored', 'resultReturned', 'membershipMatched', 'locatorMatched',
  'actualModeMatched', 'structuredValid', 'schemaAnswerMatched', 'cancelled', 'completionDrained', 'noReexecution', 'deleted', 'oldIdsRejected',
  'nativeIdleBarrierWaited', 'adapterFound', 'adapterApplied', 'baselineProbeCompleted', 'repeatProbeCompleted',
  'handoffCompleted', 'restoredProbeCompleted'];
const isBoundedInteger = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const statuses = ['passed', 'failed', 'not_run'];
const safeNumbers = (input, keys) => Object.fromEntries(keys.filter(key => isBoundedInteger(input?.[key])).map(key => [key, input[key]]));
const safeIndices = input => Array.isArray(input) ? input.slice(0, 8).map(value => isBoundedInteger(value) && value < 8 ? value : null) : [];
function safeSelected(input) {
  return Array.isArray(input) ? input.slice(0, 16).map(selected => {
    const doc = fixture.corpus.documents.find(doc => doc.id === selected?.documentId);
    return { documentId: doc?.id ?? 'unknown', paragraphId: doc?.paragraphs.some(paragraph => paragraph.id === selected?.paragraphId) ? selected.paragraphId : 'unknown',
      ...safeNumbers(selected, ['chunkIndex', 'rank', 'start', 'end', 'sourceStart', 'sourceEnd', 'pageNumber', 'slideNumber']) };
  }) : [];
}
function validSelected(selected, selectedIndex) {
  const doc = fixture.corpus.documents.find(doc => doc.id === selected.documentId);
  const paragraph = doc?.paragraphs[selected.chunkIndex];
  const start = doc?.paragraphs.slice(0, selected.chunkIndex).reduce((sum, item) => sum + item.text.length + 2, 0);
  return paragraph?.id === selected.paragraphId && selected.rank === selectedIndex + 1 && selected.pageNumber === undefined
    && selected.slideNumber === undefined && selected.sourceStart === start && selected.sourceEnd === start + paragraph.text.length;
}
function sanitizeDocumentRetrievalEvidence(input) {
  return { schemaVersion: input?.schemaVersion === 1 ? 1 : null,
    ...Object.fromEntries(Object.entries(IDENTITIES).map(([key, expected]) => [key, input?.[key] === expected ? expected : null])),
    status: ['idle', 'running', 'ready_for_cold_reopen', 'ready_for_deleted_reopen', 'passed', 'failed'].includes(input?.status) ? input.status : 'unknown',
    phase: [...STEP_IDS, 'idle', 'preconditions', 'complete'].includes(input?.phase) ? input.phase : 'unknown',
    failureCode: ['precondition', 'assertion', 'operation_failed', 'timeout', 'cleanup_failed'].includes(input?.failureCode) ? input.failureCode : undefined,
    requiresForceStop: typeof input?.requiresForceStop === 'boolean' ? input.requiresForceStop : null,
    steps: Array.isArray(input?.steps) ? input.steps.slice(0, STEP_IDS.length).map(step => ({
      id: STEP_IDS.includes(step?.id) ? step.id : 'unknown', status: statuses.includes(step?.status) ? step.status : 'unknown',
      ...safeNumbers(step, NUMBERS), nativeIndices: safeIndices(step?.nativeIndices),
      ...(step?.id === 'lora_handoff' ? {
        operation: LORA_OPERATIONS.includes(step?.operation) ? step.operation : undefined,
        operationErrorCode: OPERATION_ERRORS.includes(step?.operationErrorCode) ? step.operationErrorCode : undefined,
      } : {}),
      promptChunks: safeSelected(step?.promptChunks),
      ...Object.fromEntries(BOOLEANS.filter(key => typeof step?.[key] === 'boolean').map(key => [key, step[key]])),
    })) : [],
    cases: Array.isArray(input?.cases) ? input.cases.slice(0, fixture.corpus.queries.length * MODES.length).map(item => {
      const query = fixture.corpus.queries.find(query => query.id === item?.queryId);
      return { queryId: query?.id ?? 'unknown', mode: MODES.includes(item?.mode) ? item.mode : 'unknown',
        status: statuses.includes(item?.status) ? item.status : 'unknown', ...safeNumbers(item, COUNTERS), nativeIndices: safeIndices(item?.nativeIndices),
        actualMode: ['lexical', 'hybrid', 'lexical+rerank', 'hybrid+rerank'].includes(item?.actualMode) ? item.actualMode : undefined,
        fallbackReason: ISSUES.includes(item?.fallbackReason) ? item.fallbackReason : undefined,
        recallAt3: typeof item?.recallAt3 === 'number' && Number.isFinite(item.recallAt3) && item.recallAt3 >= 0 && item.recallAt3 <= 1 ? item.recallAt3 : undefined,
        relevantRanks: Array.isArray(item?.relevantRanks) ? item.relevantRanks.slice(0, 2).map(rank => ({
          paragraphId: query?.relevantParagraphIds.includes(rank?.paragraphId) ? rank.paragraphId : 'unknown',
          rank: rank?.rank === null ? null : isBoundedInteger(rank?.rank) && rank.rank > 0 && rank.rank <= 16 ? rank.rank : undefined,
        })) : [],
        selected: safeSelected(item?.selected),
      };
    }) : [],
  };
}
function validateDocumentRetrievalEvidence(input, { readyForColdReopen = false, readyForDeletedReopen = false } = {}) {
  const evidence = sanitizeDocumentRetrievalEvidence(input);
  const requireValue = (value, message) => { if (!value) throw new Error(message); };
  const requiredSteps = readyForColdReopen ? STEP_IDS.slice(0, STEP_IDS.indexOf('cold_reuse'))
    : readyForDeletedReopen ? STEP_IDS.slice(0, STEP_IDS.indexOf('deleted_reuse')) : STEP_IDS;
  const status = readyForColdReopen ? 'ready_for_cold_reopen' : readyForDeletedReopen ? 'ready_for_deleted_reopen' : 'passed';
  const phase = readyForColdReopen ? 'cold_reuse' : readyForDeletedReopen ? 'deleted_reuse' : 'complete';
  requireValue(evidence.schemaVersion === 1 && evidence.status === status
    && evidence.phase === phase && evidence.requiresForceStop === false && !evidence.failureCode
    && Object.entries(IDENTITIES).every(([key, value]) => evidence[key] === value), 'Document retrieval has incomplete provenance or status.');
  requireValue(evidence.steps.length === requiredSteps.length && evidence.steps.every((step, index) => step.id === requiredSteps[index] && step.status === 'passed'),
    'Document retrieval sequence is incomplete.');
  requireValue(evidence.cases.length === 36, 'The fixed 12-query/three-mode corpus was not fully executed.');
  for (const [index, item] of evidence.cases.entries()) {
    const query = fixture.corpus.queries[Math.floor(index / MODES.length)]; const mode = MODES[index % MODES.length];
    requireValue(item.queryId === query.id && item.mode === mode && item.status === 'passed' && !item.fallbackReason
      && item.actualMode === (mode === 'hybrid_rerank' ? 'hybrid+rerank' : mode), 'A fixed corpus case changed or used fallback.');
    requireValue(item.documentEmbeddings === 0 && item.nativeStarted === item.nativeSettled
      && item.queryEmbeddings === (mode === 'lexical' ? 0 : 1) && item.rerankCalls === (mode === 'hybrid_rerank' ? 1 : 0)
      && item.restored === (mode === 'lexical' ? 0 : 1), 'Actual native operation counts or restoration are unproven.');
    if (mode === 'hybrid_rerank') requireValue(item.nativeIndices.length === 8 && new Set(item.nativeIndices).size === 8
      && item.nativeIndices.every(value => Number.isSafeInteger(value) && value >= 0 && value < 8), 'Native rerank original indexes are invalid.');
    requireValue(item.selected.length > 0 && item.selected.every(validSelected), 'Selected original corpus chunks or locators are invalid.');
    requireValue(item.relevantRanks.length === query.relevantParagraphIds.length && item.relevantRanks.every((rank, rankIndex) =>
      rank.paragraphId === query.relevantParagraphIds[rankIndex] && rank.rank === (item.selected.find(selected => selected.paragraphId === rank.paragraphId)?.rank ?? null)),
    'Golden paragraph ranks do not match selected chunks.');
    requireValue(item.recallAt3 === item.relevantRanks.filter(rank => rank.rank !== null && rank.rank <= 3).length / query.relevantParagraphIds.length,
      'Recall@3 was not computed from the frozen relevance labels.');
  }
  const byId = Object.fromEntries(evidence.steps.map(step => [step.id, step]));
  const cancelledPreparation = byId.stop_prepare;
  requireValue(cancelledPreparation.cancelled === true && cancelledPreparation.profileRestored === true
    && cancelledPreparation.completionDrained === true && cancelledPreparation.indexCount === 0
    && cancelledPreparation.documentEmbeddings === 1 && cancelledPreparation.queryEmbeddings === 0
    && cancelledPreparation.rerankCalls === 0 && cancelledPreparation.nativeStarted === 1 && cancelledPreparation.nativeSettled === 1,
  'Preparation Stop did not drain the actual document embedding, restore A or reject provisional readiness.');
  const prepared = byId.prepare_indexes;
  requireValue(byId.prepare_models.fixtureVerified === true && byId.prepare_corpus.chunkCount === 12
    && prepared.documentEmbeddings === 12 && prepared.queryEmbeddings === 0 && prepared.rerankCalls === 0
    && prepared.nativeStarted === 12 && prepared.nativeSettled === 12 && prepared.restored === 1 && prepared.indexCount === 4,
  'Real document indexing and four readiness manifests are unproven.');
  for (const id of ['repeat_query', 'lora_handoff', 'next_query', ...(readyForColdReopen ? [] : ['cold_reuse'])]) {
    const step = byId[id];
    requireValue(step.documentEmbeddings === 0 && step.queryEmbeddings === 1 && step.rerankCalls === 1
      && step.nativeStarted === 2 && step.nativeSettled === 2 && step.restored === 1, 'Repeated or restarted query recomputed document vectors or did not drain.');
  }
  requireValue(byId.lora_handoff.profileRestored === true && byId.lora_handoff.probabilityRestored === true
    && byId.lora_handoff.outputCharacters > 0 && byId.lora_handoff.completionDrained === true
    && byId.lora_handoff.promptTokens > 0 && byId.lora_handoff.tokensEvaluated === byId.lora_handoff.promptTokens
    && byId.lora_handoff.promptChunks.length === 3 && byId.lora_handoff.promptChunks.every(validSelected),
  'Applied LoRA profile, probability restoration or actual selected prompt chunks are unproven.');
  const tool = byId.tool_schema;
  requireValue(tool.nativeSteps >= 2 && tool.toolCalls >= 1 && tool.toolCalls <= 8 && tool.resultReturned === true
    && tool.membershipMatched === true && tool.locatorMatched === true && tool.actualModeMatched === true
    && tool.structuredValid === true && tool.schemaAnswerMatched === true && tool.outputCharacters > 0 && tool.completionDrained === true,
  'Real tool proposal, owned retrieval feedback and final schema answer are unproven.');
  const stopped = byId.stop_drain;
  requireValue(stopped.cancelled === true && stopped.completionDrained === true && stopped.nativeStarted === 1
    && stopped.nativeSettled === 1 && stopped.queryEmbeddings === 1 && stopped.documentEmbeddings === 0 && stopped.rerankCalls === 0,
  'Stop did not drain the actual in-flight query before cancelling subsequent native phases.');
  if (!readyForColdReopen) requireValue(byId.cold_reuse.noReexecution === true && byId.cold_reuse.indexCount === 4
    && byId.delete_corpus.deleted === true, 'Cold reuse or committed deletion is incomplete.');
  if (!readyForColdReopen && !readyForDeletedReopen) requireValue(byId.deleted_reuse.deleted === true
    && byId.deleted_reuse.oldIdsRejected === true && byId.deleted_reuse.noReexecution === true
    && COUNTERS.every(key => byId.deleted_reuse[key] === 0) && byId.deleted_reuse.completionDrained === true
    && byId.cleanup.deleted === true && byId.cleanup.profileRestored === true && byId.cleanup.completionDrained === true,
  'Deleted source/index absence after another cold reopen or cleanup is incomplete.');
  return evidence;
}
async function waitForDocumentRetrievalEvidence(readEvidence, options = {}) {
  const now = options.now || Date.now; const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 3600000);
  while (now() < deadline) {
    const evidence = sanitizeDocumentRetrievalEvidence(await readEvidence());
    if (evidence.status === 'failed') throw new Error(`Document retrieval failed: phase=${evidence.phase}, code=${evidence.failureCode || 'unknown'}.`);
    if (evidence.status === (options.readyForColdReopen ? 'ready_for_cold_reopen'
      : options.readyForDeletedReopen ? 'ready_for_deleted_reopen' : 'passed')) return validateDocumentRetrievalEvidence(evidence, options);
    await wait(1000);
  }
  throw new Error('Document retrieval scenario timed out without complete native evidence.');
}
module.exports = { STEP_IDS, MODES, IDENTITIES, sanitizeDocumentRetrievalEvidence, validateDocumentRetrievalEvidence, waitForDocumentRetrievalEvidence };
