const fixture = require('../../docs/validation/llama-rn-stage5/retrieval-fixtures.json');
const STEP_IDS = ['four_indexes', 'fifth_new_chat', 'fifth_existing_chat', 'stop', 'after_stop', 'cold_retention', 'next_query', 'cleanup'];
const NUMBERS = ['documentEmbeddings', 'queryEmbeddings', 'rerankCalls', 'nativeStarted', 'nativeSettled', 'restored',
  'indexCount', 'callbackCount', 'userCount', 'assistantCount', 'outputCharacters', 'tokensPredicted', 'tokensEvaluated'];
const BOOLEANS = ['noReady', 'oldIndexesRetained', 'historyRetained', 'attachmentsRetained', 'profileRestored', 'loraApplied', 'completionDrained', 'cancelled', 'answerMatched'];
function sanitizeDocumentIndexPublicationEvidence(input) {
  return { schemaVersion: input?.schemaVersion === 1 ? 1 : null,
    fixtureId: input?.fixtureId === fixture.fixtureId ? fixture.fixtureId : null,
    runtimeVersion: input?.runtimeVersion === fixture.runtimeVersion ? fixture.runtimeVersion : null,
    backend: input?.backend === 'cpu' ? 'cpu' : null,
    status: ['idle', 'running', 'ready_for_cold_reopen', 'passed', 'failed'].includes(input?.status) ? input.status : 'unknown',
    phase: [...STEP_IDS, 'idle', 'preconditions', 'complete'].includes(input?.phase) ? input.phase : 'unknown',
    requiresForceStop: typeof input?.requiresForceStop === 'boolean' ? input.requiresForceStop : null,
    failureCode: ['precondition', 'assertion', 'operation_failed', 'timeout', 'cleanup_failed'].includes(input?.failureCode) ? input.failureCode : undefined,
    steps: Array.isArray(input?.steps) ? input.steps.slice(0, STEP_IDS.length).map(step => ({
      id: STEP_IDS.includes(step?.id) ? step.id : 'unknown',
      status: ['passed', 'failed', 'not_run'].includes(step?.status) ? step.status : 'unknown',
      actualMode: step?.actualMode === 'hybrid+rerank' ? 'hybrid+rerank' : undefined,
      cacheFailure: step?.cacheFailure === 'quota_exceeded' ? 'quota_exceeded' : undefined,
      ...Object.fromEntries(NUMBERS.filter(key => Number.isSafeInteger(step?.[key]) && step[key] >= 0 && step[key] <= 1000000).map(key => [key, step[key]])),
      ...Object.fromEntries(BOOLEANS.filter(key => typeof step?.[key] === 'boolean').map(key => [key, step[key]])),
    })) : [] };
}
function validateDocumentIndexPublicationEvidence(input, options = {}) {
  const evidence = sanitizeDocumentIndexPublicationEvidence(input);
  const check = (value, message) => { if (!value) throw new Error(message); };
  const required = options.readyForColdReopen ? STEP_IDS.slice(0, 5) : STEP_IDS;
  check(evidence.schemaVersion === 1 && evidence.fixtureId === fixture.fixtureId && evidence.runtimeVersion === fixture.runtimeVersion
    && evidence.backend === 'cpu' && !evidence.failureCode && evidence.requiresForceStop === false
    && evidence.status === (options.readyForColdReopen ? 'ready_for_cold_reopen' : 'passed')
    && evidence.phase === (options.readyForColdReopen ? 'cold_retention' : 'complete'), 'Publication QA has incomplete identity or terminal status.');
  check(evidence.steps.length === required.length && evidence.steps.every((step, index) => step.id === required[index] && step.status === 'passed'),
    'Publication QA did not execute its required sequence.');
  const byId = Object.fromEntries(evidence.steps.map(step => [step.id, step]));
  const seed = byId.four_indexes;
  check(seed.indexCount === 4 && seed.documentEmbeddings === 4 && seed.queryEmbeddings === 0 && seed.rerankCalls === 0
    && seed.nativeStarted === 4 && seed.nativeSettled === 4 && seed.oldIndexesRetained === true, 'Four genuine retained indexes are unproven.');
  for (const [id, documentEmbeddings] of [['fifth_new_chat', 1], ['fifth_existing_chat', 2]]) {
    const step = byId[id];
    check(step.actualMode === 'hybrid+rerank' && step.cacheFailure === 'quota_exceeded' && step.callbackCount === 1
      && step.userCount === 1 && step.assistantCount === 1 && step.outputCharacters > 0 && step.tokensPredicted > 0 && step.tokensEvaluated > 0
      && step.documentEmbeddings === documentEmbeddings && step.queryEmbeddings === 1 && step.rerankCalls === 1
      && step.nativeStarted === documentEmbeddings + 2 && step.nativeSettled === step.nativeStarted && step.restored === 1
      && step.noReady === true && step.oldIndexesRetained === true && step.attachmentsRetained === true
      && step.historyRetained === true && step.profileRestored === true && step.loraApplied === true
      && step.completionDrained === true && step.answerMatched === true,
    'The accepted fifth-document hook turn lost context, repeated native work or has unproven cache failure/answer.');
  }
  check(byId.stop.cancelled === true && byId.stop.completionDrained === true && byId.stop.noReady === true
    && byId.stop.documentEmbeddings === 1 && byId.stop.queryEmbeddings === 0 && byId.stop.rerankCalls === 0
    && byId.stop.nativeStarted === 1 && byId.stop.nativeSettled === 1, 'Retrieval Stop did not drain actual native work.');
  for (const id of ['after_stop', ...(options.readyForColdReopen ? [] : ['next_query'])]) {
    check(byId[id].userCount === 1 && byId[id].assistantCount === 1 && byId[id].outputCharacters > 0
      && byId[id].tokensPredicted > 0 && byId[id].tokensEvaluated > 0 && byId[id].completionDrained === true,
    'The next ordinary hook request did not complete.');
  }
  if (!options.readyForColdReopen) {
    check(byId.cold_retention.indexCount === 4 && byId.cold_retention.oldIndexesRetained === true
      && byId.cold_retention.historyRetained === true && byId.cold_retention.attachmentsRetained === true
      && byId.cold_retention.noReady === true && byId.cleanup.completionDrained === true,
    'Cold readiness, history, attachments or task-owned cleanup are unproven.');
  }
  return evidence;
}
async function waitForDocumentIndexPublicationEvidence(readEvidence, options = {}) {
  const now = options.now || Date.now; const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 1800000);
  while (now() < deadline) {
    const evidence = sanitizeDocumentIndexPublicationEvidence(await readEvidence());
    if (evidence.status === 'failed') throw new Error(`Document index publication failed: phase=${evidence.phase}, code=${evidence.failureCode || 'unknown'}.`);
    if (evidence.status === (options.readyForColdReopen ? 'ready_for_cold_reopen' : 'passed')) return validateDocumentIndexPublicationEvidence(evidence, options);
    await wait(1000);
  }
  throw new Error('Document index publication timed out without actual terminal evidence.');
}
module.exports = { STEP_IDS, sanitizeDocumentIndexPublicationEvidence, validateDocumentIndexPublicationEvidence, waitForDocumentIndexPublicationEvidence };
