const APP_ERROR_CODES = ['local_tool_unsupported', 'local_tool_cancelled', 'local_tool_timeout', 'local_tool_round_limit', 'local_tool_call_limit', 'local_tool_token_limit', 'local_tool_result_limit', 'local_tool_invalid_proposal', 'local_tool_duplicate_id', 'local_tool_conflicting_id', 'local_tool_context_limit', 'action_failed', 'engine_not_ready', 'engine_busy', 'engine_recovery_required', 'engine_unloading', 'model_not_found', 'model_load_blocked', 'model_load_failed', 'model_incompatible', 'model_memory_insufficient', 'model_memory_warning', 'download_disk_space_low', 'download_size_unknown', 'download_metadata_unavailable', 'download_http_error', 'download_verification_failed', 'download_file_missing', 'storage_private_unavailable', 'message_empty', 'message_too_long', 'chat_model_not_loaded', 'chat_model_mismatch', 'chat_history_busy', 'multimodal_not_ready', 'chat_attachment_copy_failed', 'chat_attachment_limit_exceeded', 'chat_attachment_missing', 'chat_attachment_not_ready', 'chat_attachment_unsupported_type', 'chat_attachment_corrupt', 'chat_attachment_parse_failed', 'chat_attachment_too_large_for_context', 'chat_attachment_document_encrypted', 'chat_attachment_document_no_extractable_text', 'chat_attachment_document_too_large', 'chat_attachment_document_resource_limit', 'chat_attachment_document_semantic_spreadsheet', 'chat_attachment_native_unavailable', 'chat_attachment_native_failed', 'chat_attachment_processing_cancelled', 'chat_attachment_assets_skipped', 'chat_attachment_context_truncated'];
const STEP_IDS = ['prepare_model', 'cpu_load', 'calculate_required', 'calculate_auto', 'ordinary_auto',
  'document_search', 'json_schema', 'stop', 'ordinary_after_stop', 'cleanup'];
const fixture = require('../../docs/validation/llama-rn-stage4/tool-fixture.json');
const IDENTITIES = { runtimeVersion: fixture.runtimeVersion, backend: 'cpu',
  modelRevision: fixture.model.revision, modelSha256: fixture.model.sha256 };
const NUMBERS = ['nativeSteps', 'nativeCalls', 'executedCalls', 'outputCharacters'];
const BOOLEANS = ['automaticCallSelected', 'resultReturned', 'referenceMatched', 'membershipMatched', 'locatorMatched', 'finalReferencePresent', 'schemaAnswerMatched',
  'structuredValid', 'cancelled', 'completionDrained', 'fixtureVerified', 'cpuConfirmed', 'historyRetained', 'profileRestored'];
function sanitizeLocalToolsEvidence(input) {
  return {
    schemaVersion: input?.schemaVersion === 1 ? 1 : null,
    status: ['idle', 'running', 'passed', 'failed'].includes(input?.status) ? input.status : 'unknown',
    phase: [...STEP_IDS, 'idle', 'preconditions', 'complete'].includes(input?.phase) ? input.phase : 'unknown',
    failureCode: ['precondition', 'assertion', 'operation_failed', 'timeout', 'cleanup_failed'].includes(input?.failureCode) ? input.failureCode : undefined,
    nativeFailureCategory: input?.nativeFailureCategory === 'formatter_parser_generation' ? input.nativeFailureCategory : undefined,
    appErrorCode: APP_ERROR_CODES.includes(input?.appErrorCode) ? input.appErrorCode : undefined,
    toolFailureReason: ['cancelled', 'timeout', 'round_limit', 'call_limit', 'token_limit', 'result_limit', 'invalid_proposal', 'duplicate_id', 'conflicting_id', 'context_limit'].includes(input?.toolFailureReason) ? input.toolFailureReason : undefined,
    requiresForceStop: typeof input?.requiresForceStop === 'boolean' ? input.requiresForceStop : null,
    ...Object.fromEntries(Object.entries(IDENTITIES).map(([key, value]) => [key, input?.[key] === value ? value : null])),
    steps: Array.isArray(input?.steps) ? input.steps.slice(0, STEP_IDS.length + 1).map(step => ({
      id: STEP_IDS.includes(step?.id) ? step.id : 'unknown',
      nativeStage: ['count_prompt', 'completion'].includes(step?.nativeStage) ? step.nativeStage : undefined,
      status: ['passed', 'observed', 'failed', 'not_run'].includes(step?.status) ? step.status : 'unknown',
      ...Object.fromEntries(NUMBERS.filter(key => Number.isSafeInteger(step?.[key]) && step[key] >= 0).map(key => [key, step[key]])),
      ...Object.fromEntries(BOOLEANS.filter(key => typeof step?.[key] === 'boolean').map(key => [key, step[key]])),
    })) : [],
  };
}
function validateLocalToolsEvidence(input) {
  const evidence = sanitizeLocalToolsEvidence(input);
  const requireValue = (value, message) => { if (!value) throw new Error(message); };
  requireValue(evidence.schemaVersion === 1 && evidence.status === 'passed' && evidence.phase === 'complete'
    && evidence.requiresForceStop === false && !evidence.failureCode && evidence.steps.length === STEP_IDS.length
    && Object.entries(IDENTITIES).every(([key, value]) => evidence[key] === value), 'Local tool evidence is incomplete or has unverified identities.');
  for (const [index, step] of evidence.steps.entries()) {
    const unselectedAuto = step.id === 'calculate_auto' && step.automaticCallSelected === false;
    requireValue(step.id === STEP_IDS[index] && step.status === (unselectedAuto ? 'observed' : 'passed'), 'Local tool sequence did not pass.');
    if (unselectedAuto) {
      requireValue(step.nativeSteps >= 1 && step.nativeCalls === 0 && step.executedCalls === 0
        && step.resultReturned === false && step.referenceMatched === false
        && typeof step.finalReferencePresent === 'boolean' && step.completionDrained === true && step.outputCharacters > 0,
      'Unselected automatic tool observation is inconsistent.');
      continue;
    }
    if (step.id === 'calculate_auto') requireValue(step.automaticCallSelected === true, 'Automatic native selection missing.');
    if (['calculate_required', 'calculate_auto', 'document_search', 'json_schema'].includes(step.id)) {
      requireValue(step.nativeSteps >= 2 && step.nativeCalls >= 1 && step.executedCalls >= 1 && step.nativeCalls <= 8
        && step.executedCalls <= step.nativeCalls && step.resultReturned === true && step.referenceMatched === true
        && (step.id === 'json_schema' ? step.schemaAnswerMatched === true : step.finalReferencePresent === true) && step.completionDrained === true && step.outputCharacters > 0,
      'Real native proposal, actual execution, result feedback and continuation are not all proven.');
    }
    if (step.id === 'prepare_model') requireValue(step.fixtureVerified === true, 'Missing verified fixture.');
    if (step.id === 'cpu_load') requireValue(step.cpuConfirmed === true, 'CPU profile not confirmed.');
    if (step.id === 'document_search') requireValue(step.membershipMatched === true && step.locatorMatched === true, 'Document ownership and real locator not proven.');
    if (step.id === 'json_schema') requireValue(step.structuredValid === true, 'Final JSON Schema validation missing.');
    if (step.id === 'ordinary_auto') requireValue(step.nativeSteps >= 1 && step.nativeCalls === 0 && step.executedCalls === 0
      && step.outputCharacters > 0 && step.completionDrained === true, 'Ordinary automatic response not proven.');
    if (step.id === 'stop') requireValue(step.nativeSteps >= 1 && step.nativeCalls >= 1 && step.executedCalls === 0
      && step.cancelled === true && step.completionDrained === true, 'Stop did not cancel the real proposed run before execution.');
    if (step.id === 'ordinary_after_stop') requireValue(step.outputCharacters > 0 && step.completionDrained === true, 'Post-Stop recovery missing.');
    if (step.id === 'cleanup') requireValue(step.historyRetained === true && step.profileRestored === true, 'Cleanup and retained history unconfirmed.');
  }
  return evidence;
}
async function waitForLocalToolsEvidence(readEvidence, options = {}) {
  const now = options.now || Date.now;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 1800000);
  while (now() < deadline) {
    const evidence = sanitizeLocalToolsEvidence(await readEvidence());
    if (evidence.status === 'failed') throw new Error(`Local tools failed: phase=${evidence.phase}, code=${evidence.failureCode || 'unknown'}, tool=${evidence.toolFailureReason || 'none'}, app=${evidence.appErrorCode || 'none'}.`);
    if (evidence.status === 'passed') return validateLocalToolsEvidence(evidence);
    await wait(1000);
  }
  throw new Error('Local tools native scenario timed out without complete evidence.');
}
function sanitizeLocalToolsHistory(input) {
  return { hydrated: input?.hydrated === true, busy: typeof input?.busy === 'boolean' ? input.busy : null,
    digest: typeof input?.digest === 'string' && /^\d+:[0-9a-f]{1,8}$/.test(input.digest) ? input.digest : null,
    ...Object.fromEntries(['threadCount', 'runCount', 'callCount', 'completedCalls', 'pendingCalls', 'runningRuns', 'processRunStarts']
      .map(key => [key, Number.isSafeInteger(input?.[key]) && input[key] >= 0 ? input[key] : null])),
  };
}
function validateColdLocalToolsHistory(before, after) {
  const first = sanitizeLocalToolsHistory(before); const second = sanitizeLocalToolsHistory(after);
  if (!first.hydrated || !second.hydrated || first.threadCount !== 1 || second.threadCount !== 1
    || first.busy !== false || second.busy !== false || first.pendingCalls !== 0 || second.pendingCalls !== 0
    || first.runningRuns !== 0 || second.runningRuns !== 0 || first.completedCalls < 1
    || !Number.isSafeInteger(first.callCount) || first.callCount < 1 || !Number.isSafeInteger(first.runCount) || first.runCount < 1
    || second.processRunStarts !== 0 || !first.digest || first.digest !== second.digest
    || first.runCount !== second.runCount || first.callCount !== second.callCount || first.completedCalls !== second.completedCalls) {
    throw new Error('Cold reopen changed tool history or started new tool work.');
  }
  return { historyUnchanged: true, noReexecution: true, callCount: second.callCount, completedCalls: second.completedCalls };
}
module.exports = { sanitizeLocalToolsHistory, validateColdLocalToolsHistory, STEP_IDS, IDENTITIES, sanitizeLocalToolsEvidence, validateLocalToolsEvidence, waitForLocalToolsEvidence };
