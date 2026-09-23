const fixture = require('../../docs/validation/llama-rn-stage3/lora-fixture.json');
const STEP_IDS = ['cpu_load', 'text', 'stop', 'json_object', 'json_schema', 'gbnf', 'template_prefill',
  'token_diagnostics', 'invalid_schema', 'invalid_grammar', 'truncated_json', 'structured_cancel', 'ordinary_after_failure',
  'prepare_adapter', 'probability_baseline', 'logit_bias', 'ignore_eos', 'invalid_logit_bias', 'sampling_reset',
  'lora_apply', 'lora_scale', 'lora_remove', 'lora_restore_baseline',
  'prepare_embedding', 'lora_auxiliary_restore', 'lora_delete_guard', 'cleanup'];
const IDENTITIES = { runtimeVersion: fixture.runtimeVersion, backend: 'cpu', baseRevision: fixture.base.revision,
  baseSha256: fixture.base.sha256, adapterRevision: fixture.adapter.revision, adapterSha256: fixture.adapter.sha256 };
const FAILURE_CODES = ['timeout', 'precondition', 'assertion', 'download', 'operation_failed', 'cleanup_failed'];
const NUMERIC_FIELDS = ['callbacks', 'tokensPredicted', 'tokensEvaluated', 'outputCharacters', 'adapterCount', 'scale',
  'sharedTokens', 'maxDelta', 'baselineDelta', 'threshold', 'scaleDelta', 'tokenCount', 'dimensions',
  'contentCharacters', 'sampledTokens', 'repeatedTokensPredicted', 'repeatedSampledTokens',
  'templateGenerationTokensEvaluated', 'templateGenerationCallbacks', 'templateGenerationOutputCharacters', 'probabilityBefore', 'probabilityAfter'];
const BOOLEAN_FIELDS = ['valid', 'stopped', 'historyUnchanged', 'profileRestored', 'loadedListConfirmed', 'deletionRejected', 'finite',
  'hasContent', 'hasReasoning', 'stoppedLimit', 'stoppedEos', 'stoppedWord', 'interrupted', 'truncated', 'contextFull', 'completionDrained', 'exactConstraintMatch', 'eosConfirmed', 'resetEosConfirmed'];
function sanitizeStage3Evidence(input) {
  return {
    schemaVersion: input?.schemaVersion === 1 ? 1 : null,
    status: ['idle', 'running', 'passed', 'failed'].includes(input?.status) ? input.status : 'unknown',
    phase: [...STEP_IDS, 'idle', 'preconditions', 'complete'].includes(input?.phase) ? input.phase : 'unknown',
    failureCode: FAILURE_CODES.includes(input?.failureCode) ? input.failureCode : undefined,
    requiresForceStop: typeof input?.requiresForceStop === 'boolean' ? input.requiresForceStop : null,
    ...Object.fromEntries(Object.entries(IDENTITIES).map(([key, value]) => [key, input?.[key] === value ? value : null])),
    steps: Array.isArray(input?.steps) ? input.steps.slice(0, STEP_IDS.length + 1).map(step => ({
      id: STEP_IDS.includes(step?.id) ? step.id : 'unknown',
      status: ['passed', 'failed', 'not_run'].includes(step?.status) ? step.status : 'unknown',
      ...Object.fromEntries(NUMERIC_FIELDS.filter(field => Number.isFinite(step?.[field])).map(field => [field, step[field]])),
      ...Object.fromEntries(BOOLEAN_FIELDS.filter(field => typeof step?.[field] === 'boolean').map(field => [field, step[field]])),
    })) : [],
    notRun: Array.isArray(input?.notRun) ? input.notRun.slice(0, 4).map(item => ({
      backend: ['ios', 'gpu', 'npu', 'mtp'].includes(item?.backend) ? item.backend : 'unknown',
      reason: item?.reason === 'cpu_only_fixture' ? item.reason : 'unknown',
    })) : [],
  };
}
function validateStage3Evidence(input) {
  const evidence = sanitizeStage3Evidence(input);
  const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  const realOutput = step => nonnegative(step.tokensPredicted) && positive(step.callbacks)
    && positive(step.outputCharacters) && step.completionDrained === true;
  const sampledOnce = step => realOutput(step) && step.tokensPredicted <= 1 && step.sampledTokens === 1
    && step.stoppedLimit === true && step.interrupted === false && step.truncated === false && step.contextFull === false;
  const distribution = step => Number.isSafeInteger(step.sharedTokens) && step.sharedTokens >= 3 && step.sharedTokens <= 10
    && Number.isFinite(step.maxDelta) && step.maxDelta >= 0 && step.maxDelta <= 1
    && Number.isFinite(step.threshold) && step.threshold >= 1e-6;
  requireValue(evidence.schemaVersion === 1 && evidence.status === 'passed' && evidence.phase === 'complete'
    && evidence.requiresForceStop === false && evidence.steps.length === STEP_IDS.length
    && !evidence.failureCode && Object.entries(IDENTITIES).every(([key, value]) => evidence[key] === value),
  'Incomplete Stage 3 evidence or unverified fixture identities.');
  requireValue(evidence.notRun.length === 4 && ['ios', 'gpu', 'npu', 'mtp'].every((backend, index) =>
    evidence.notRun[index].backend === backend && evidence.notRun[index].reason === 'cpu_only_fixture'), 'Missing CPU-only coverage boundary.');
  const steps = Object.fromEntries(evidence.steps.map(step => [step.id, step]));
  evidence.steps.forEach((step, index) => {
    requireValue(step.id === STEP_IDS[index] && step.status === 'passed', 'Stage 3 sequence is incomplete.');
    if (['text', 'json_object', 'json_schema', 'gbnf', 'truncated_json', 'ordinary_after_failure'].includes(step.id)) {
      requireValue(realOutput(step), 'No real generation evidence.');
    }
    if (['json_object', 'json_schema', 'gbnf', 'invalid_schema', 'invalid_grammar', 'truncated_json', 'token_diagnostics'].includes(step.id)) {
      requireValue(step.valid === true, 'Missing independent output or rejection validation.');
    }
    if (['stop', 'structured_cancel'].includes(step.id)) requireValue(positive(step.callbacks) && step.stopped === true, 'Missing real cancellation evidence.');
    if (step.id === 'gbnf') requireValue(step.exactConstraintMatch === true && step.stoppedLimit === false
      && step.interrupted === false, 'GBNF exact constraint completion is unproven.');
    if (step.id === 'truncated_json') requireValue(step.stoppedLimit === true, 'Missing token-limit structured output evidence.');
    if (step.id === 'text') requireValue(positive(step.tokenCount) && step.tokensEvaluated === step.tokenCount, 'Default prompt count differs from completion.');
    if (step.id === 'template_prefill') requireValue(positive(step.tokenCount) && step.tokensEvaluated === step.tokenCount
      && step.templateGenerationTokensEvaluated === step.tokenCount && positive(step.templateGenerationCallbacks)
      && positive(step.templateGenerationOutputCharacters)
      && step.tokensPredicted === 0 && step.historyUnchanged === true, 'Prompt count and prefill differ.');
    if (step.id === 'token_diagnostics') requireValue(positive(step.tokenCount), 'Missing native token diagnostic evidence.');
    if (step.id === 'logit_bias') requireValue(sampledOnce(step) && step.valid === true
      && Number.isFinite(step.probabilityBefore) && step.probabilityBefore > 1e-6 && step.probabilityBefore < 0.9
      && Number.isFinite(step.probabilityAfter) && step.probabilityAfter > 0.99 && step.probabilityAfter <= 1
      && step.probabilityAfter - step.probabilityBefore > step.threshold
      && step.threshold === steps.probability_baseline.threshold, 'Logit bias effect is unproven.');
    if (step.id === 'ignore_eos') requireValue(sampledOnce(step) && step.valid === true
      && step.eosConfirmed === true && step.stoppedEos === false, 'EOS suppression is unproven.');
    if (step.id === 'invalid_logit_bias') requireValue(step.valid === true, 'Invalid native vocabulary ID rejection is unproven.');
    if (step.id === 'sampling_reset') requireValue(sampledOnce(step) && step.valid === true && step.resetEosConfirmed === true && distribution(step)
      && step.maxDelta <= step.threshold && step.threshold === Math.max(1e-6, steps.probability_baseline.baselineDelta * 3), 'Sampling defaults were not restored.');
    if (['lora_apply', 'lora_scale'].includes(step.id)) requireValue(distribution(step) && step.maxDelta > step.threshold
      && step.threshold === steps.probability_baseline.threshold && step.adapterCount === 1 && step.loadedListConfirmed === true
      && sampledOnce(step) && step.scale === (step.id === 'lora_apply' ? 1 : 0.5), 'LoRA effect is unproven.');
    if (step.id === 'lora_scale') requireValue(Number.isFinite(step.scaleDelta) && step.scaleDelta > step.threshold
      && step.scaleDelta <= 1, 'LoRA scale change is unproven.');
    if (['lora_remove', 'cleanup'].includes(step.id)) requireValue(step.adapterCount === 0 && step.loadedListConfirmed === true, 'LoRA removal is unconfirmed.');
    if (step.id === 'lora_restore_baseline') requireValue(distribution(step) && step.maxDelta <= step.threshold
      && step.threshold === Math.max(1e-6, steps.probability_baseline.baselineDelta * 3)
      && sampledOnce(step), 'Baseline distribution was not restored.');
    if (step.id === 'probability_baseline') requireValue(distribution(step) && step.finite === true
      && step.baselineDelta === step.maxDelta && step.threshold === Math.max(1e-6, step.baselineDelta * 10)
      && sampledOnce(step) && nonnegative(step.repeatedTokensPredicted) && step.repeatedTokensPredicted <= 1
      && step.repeatedSampledTokens === 1, 'Missing repeat-baseline evidence.');
    if (step.id === 'lora_auxiliary_restore') requireValue(step.dimensions === 384 && step.profileRestored === true
      && step.historyUnchanged === true && sampledOnce(step) && distribution(step) && step.maxDelta <= step.threshold
      && step.threshold === Math.max(1e-6, steps.probability_baseline.baselineDelta * 3), 'LoRA A-B-A restoration is unproven.');
    if (step.id === 'lora_delete_guard') requireValue(step.deletionRejected === true, 'Applied adapter deletion was not rejected.');
  });
  return evidence;
}
async function waitForStage3Evidence(readEvidence, options = {}) {
  const now = options.now || Date.now;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 1_200_000);
  while (now() < deadline) {
    const evidence = sanitizeStage3Evidence(await readEvidence());
    if (evidence.status === 'failed') throw new Error(`Stage 3 scenario failed: phase=${evidence.phase}, code=${evidence.failureCode || 'unknown'}.`);
    if (evidence.status === 'passed') return validateStage3Evidence(evidence);
    await wait(1000);
  }
  throw new Error('Stage 3 native scenario timed out without complete evidence.');
}
module.exports = { STEP_IDS, IDENTITIES, sanitizeStage3Evidence, validateStage3Evidence, waitForStage3Evidence };
