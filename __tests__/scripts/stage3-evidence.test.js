/* global describe, it, expect */
const { STEP_IDS, IDENTITIES, sanitizeStage3Evidence, validateStage3Evidence,
  waitForStage3Evidence } = require('../../scripts/lib/stage3-evidence');
const fixture = () => ({ schemaVersion: 1, status: 'passed', phase: 'complete', requiresForceStop: false,
  ...IDENTITIES, notRun: ['ios', 'gpu', 'npu', 'mtp'].map(backend => ({ backend, reason: 'cpu_only_fixture' })),
  steps: STEP_IDS.map(id => ({ id, status: 'passed', callbacks: 2, tokensPredicted: 1,
    tokensEvaluated: 12, tokenCount: 12, outputCharacters: 8, dimensions: 384, finite: true,
    historyUnchanged: true, profileRestored: true, loadedListConfirmed: true, deletionRejected: true,
    valid: true, stopped: true, adapterCount: 0, sharedTokens: 10, maxDelta: 0, baselineDelta: 0, threshold: 1e-6,
    ...(id === 'template_prefill' ? { tokensPredicted: 0 } : {}),
    ...(['lora_apply', 'lora_scale'].includes(id) ? { adapterCount: 1, scale: id === 'lora_apply' ? 1 : 0.5, maxDelta: 0.01, scaleDelta: 0.005 } : {}),
  })) });
describe('Stage 3 native evidence boundary', () => {
  it('accepts complete identities, constraints and independently measured LoRA changes', () => {
    expect(validateStage3Evidence(fixture()).status).toBe('passed');
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
    expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|probabilities|Infinity/);
  });
  it('does not interpret pending or a timeout as acceptance', async () => {
    let time = 0;
    await expect(waitForStage3Evidence(async () => ({ status: 'running' }), {
      now: () => time, wait: async () => { time += 1000; }, timeoutMs: 2000,
    })).rejects.toThrow(/timed out/);
    await expect(waitForStage3Evidence(async () => ({ ...fixture(), status: 'failed', failureCode: 'timeout' }))).rejects.toThrow(/timeout/);
  });
});
