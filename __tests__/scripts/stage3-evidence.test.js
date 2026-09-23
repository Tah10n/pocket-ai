/* global describe, it, expect */
const { STEP_IDS, IDENTITIES, sanitizeStage3Evidence, validateStage3Evidence,
  waitForStage3Evidence } = require('../../scripts/lib/stage3-evidence');
const fixture = () => ({ schemaVersion: 1, status: 'passed', phase: 'complete', requiresForceStop: false,
  ...IDENTITIES, notRun: ['ios', 'gpu', 'npu', 'mtp'].map(backend => ({ backend, reason: 'cpu_only_fixture' })),
  steps: STEP_IDS.map(id => ({ id, status: 'passed', callbacks: 2, tokensPredicted: 1,
    tokensEvaluated: 12, tokenCount: 12, outputCharacters: 8, dimensions: 384, finite: true,
    historyUnchanged: true, profileRestored: true, loadedListConfirmed: true, deletionRejected: true,
    valid: true, stopped: true, adapterCount: 0, sharedTokens: 10, maxDelta: 0, baselineDelta: 0, threshold: 1e-6,
    completionDrained: true, exactConstraintMatch: true, stoppedLimit: id !== 'gbnf', interrupted: false, truncated: false, contextFull: false,
    probabilitiesValidated: true, structuredIncomplete: true, supportMatched: true,
    sampledTokens: 1, repeatedTokensPredicted: 1, repeatedSampledTokens: 1,
    templateGenerationTokensEvaluated: 12, templateGenerationCallbacks: 1, templateGenerationOutputCharacters: 4,
    probabilityBefore: 0.1, probabilityAfter: 0.999, eosConfirmed: true, resetEosConfirmed: true, stoppedEos: false, stoppedWord: false,
    ...(['stop', 'structured_cancel'].includes(id) ? { interrupted: true } : {}),
    ...(id === 'template_prefill' ? { tokensPredicted: 0 } : {}),
    ...(['lora_apply', 'lora_scale'].includes(id) ? { adapterCount: 1, scale: id === 'lora_apply' ? 1 : 0.5, maxDelta: 0.01, scaleDelta: 0.005 } : {}),
  })) });
describe('Stage 3 native evidence boundary', () => {
  it('accepts complete identities, constraints and independently measured LoRA changes', () => {
    expect(validateStage3Evidence(fixture()).status).toBe('passed');
  });
  it('accepts a real first sample with the unmodified native zero predicted counter', () => {
    const value = fixture();
    for (const id of ['gbnf', 'truncated_json', 'probability_baseline', 'lora_apply', 'lora_scale', 'lora_restore_baseline', 'lora_auxiliary_restore']) {
      value.steps.find(step => step.id === id).tokensPredicted = 0;
    }
    value.steps.find(step => step.id === 'probability_baseline').repeatedTokensPredicted = 0;
    expect(validateStage3Evidence(value).steps.find(step => step.id === 'lora_apply').tokensPredicted).toBe(0);
  });
  it('accepts a native probability sample without a visible callback, but never ordinary text without streaming', () => {
    const value = fixture(); const step = value.steps.find(item => item.id === 'lora_apply');
    step.callbacks = 0; step.outputCharacters = 0;
    expect(validateStage3Evidence(value).status).toBe('passed');
    step.probabilitiesValidated = false;
    expect(() => validateStage3Evidence(value)).toThrow(/unproven/);
    const text = fixture(); text.steps.find(item => item.id === 'text').callbacks = 0;
    expect(() => validateStage3Evidence(text)).toThrow(/generation/);
  });
  it('rejects claimed stop without native interruption and claimed restore with changed support', () => {
    for (const [id, field] of [['stop', 'interrupted'], ['structured_cancel', 'completionDrained'],
      ['structured_cancel', 'structuredIncomplete'], ['lora_restore_baseline', 'supportMatched']]) {
      const value = fixture(); value.steps.find(step => step.id === id)[field] = false;
      expect(() => validateStage3Evidence(value)).toThrow();
    }
  });
  it.each(Object.keys(IDENTITIES))('rejects changed %s', field => {
    expect(() => validateStage3Evidence({ ...fixture(), [field]: 'unknown' })).toThrow(/identities/);
  });
  it.each([
    ['json_schema', 'valid'], ['gbnf', 'valid'], ['truncated_json', 'valid'], ['structured_cancel', 'stopped'],
    ['template_prefill', 'tokensEvaluated'], ['template_prefill', 'historyUnchanged'], ['token_diagnostics', 'tokenCount'],
    ['probability_baseline', 'finite'], ['probability_baseline', 'baselineDelta'], ['lora_apply', 'loadedListConfirmed'],
    ['lora_scale', 'scaleDelta'], ['lora_scale', 'scale'], ['lora_remove', 'adapterCount'],
    ['lora_restore_baseline', 'tokensPredicted'], ['lora_auxiliary_restore', 'profileRestored'],
    ['lora_auxiliary_restore', 'maxDelta'], ['lora_delete_guard', 'deletionRejected'], ['cleanup', 'loadedListConfirmed'],
    ['gbnf', 'callbacks'], ['gbnf', 'exactConstraintMatch'], ['gbnf', 'stoppedLimit'], ['gbnf', 'interrupted'],
    ['gbnf', 'completionDrained'], ['truncated_json', 'stoppedLimit'], ['lora_apply', 'sampledTokens'],
    ['lora_apply', 'callbacks'], ['lora_apply', 'probabilitiesValidated'], ['lora_apply', 'stoppedEos'], ['lora_apply', 'stoppedWord'],
    ['stop', 'interrupted'], ['stop', 'completionDrained'], ['structured_cancel', 'structuredIncomplete'],
    ['probability_baseline', 'supportMatched'], ['sampling_reset', 'supportMatched'],
    ['lora_restore_baseline', 'supportMatched'], ['lora_auxiliary_restore', 'supportMatched'], ['probability_baseline', 'repeatedSampledTokens'],
    ['template_prefill', 'templateGenerationTokensEvaluated'], ['template_prefill', 'templateGenerationCallbacks'],
    ['template_prefill', 'templateGenerationOutputCharacters'],
    ['logit_bias', 'probabilityBefore'], ['logit_bias', 'probabilityAfter'], ['ignore_eos', 'eosConfirmed'],
    ['ignore_eos', 'stoppedEos'], ['invalid_logit_bias', 'valid'], ['sampling_reset', 'maxDelta'], ['sampling_reset', 'resetEosConfirmed'],
  ])('requires %s.%s rather than trusting passed', (id, field) => {
    const value = fixture(); delete value.steps.find(step => step.id === id)[field];
    expect(() => validateStage3Evidence(value)).toThrow();
  });
  it.each(['lora_apply', 'lora_scale'])('rejects fake or noise-only %s', id => {
    const value = fixture(); value.steps.find(step => step.id === id).maxDelta = 1e-7;
    expect(() => validateStage3Evidence(value)).toThrow(/unproven/);
  });
  it('rejects a changed baseline after remove or auxiliary restore', () => {
    for (const id of ['lora_restore_baseline', 'lora_auxiliary_restore']) {
      const value = fixture(); value.steps.find(step => step.id === id).maxDelta = 0.01;
      expect(() => validateStage3Evidence(value)).toThrow();
    }
  });
  it.each([0, 2])('rejects %s probability samples instead of exactly one', count => {
    const value = fixture(); value.steps.find(step => step.id === 'lora_apply').sampledTokens = count;
    expect(() => validateStage3Evidence(value)).toThrow(/unproven/);
  });
  it('rejects missing, duplicated, extra and not-run CPU steps and undisclosed backends', () => {
    const missing = fixture(); missing.steps.pop();
    const extra = fixture(); extra.steps.push(extra.steps[0]);
    const duplicated = fixture(); duplicated.steps[1] = duplicated.steps[0];
    const notRun = fixture(); notRun.steps[5].status = 'not_run';
    for (const value of [missing, extra, duplicated, notRun, { ...fixture(), notRun: [] }, { ...fixture(), requiresForceStop: true }]) {
      expect(() => validateStage3Evidence(value)).toThrow();
    }
  });
  it('preserves bounded failed/not_run statuses but strips all private payloads', () => {
    const value = fixture(); value.status = 'failed'; value.failureCode = 'PRIVATE'; value.prompt = 'PRIVATE';
    value.steps[0] = { ...value.steps[0], status: 'failed', text: 'PRIVATE', path: 'PRIVATE', probabilities: [{ token: 'PRIVATE' }] };
    value.steps[1].status = 'not_run'; value.steps[1].maxDelta = Infinity;
    const safe = sanitizeStage3Evidence(value);
    expect(safe.steps[0].status).toBe('failed'); expect(safe.steps[1].status).toBe('not_run');
    expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|"probabilities":|Infinity/);
  });
  it('does not interpret pending or a timeout as acceptance', async () => {
    let time = 0;
    await expect(waitForStage3Evidence(async () => ({ status: 'running' }), {
      now: () => time, wait: async () => { time += 1000; }, timeoutMs: 2000,
    })).rejects.toThrow(/timed out/);
    await expect(waitForStage3Evidence(async () => ({ ...fixture(), status: 'failed', failureCode: 'timeout' }))).rejects.toThrow(/timeout/);
  });
});
