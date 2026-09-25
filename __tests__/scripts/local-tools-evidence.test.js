const { validateColdLocalToolsHistory, STEP_IDS, IDENTITIES, sanitizeLocalToolsEvidence, validateLocalToolsEvidence, waitForLocalToolsEvidence } = require('../../scripts/lib/local-tools-evidence');

// Synthetic receipts only test the verifier. They are never native acceptance evidence.
function receipt() {
  return { schemaVersion: 1, ...IDENTITIES, status: 'passed', phase: 'complete', requiresForceStop: false,
    steps: STEP_IDS.map(id => ({ id, status: 'passed', automaticCallSelected: id === 'calculate_auto' ? true : undefined, nativeSteps: 2, nativeCalls: 1, executedCalls: 1,
      resultReturned: true, referenceMatched: true, membershipMatched: true, locatorMatched: true, finalReferencePresent: true, schemaAnswerMatched: true,
      structuredValid: true, completionDrained: true, outputCharacters: 2, fixtureVerified: true, cpuConfirmed: true,
      historyRetained: true, profileRestored: true,
      ...(id === 'ordinary_auto' ? { nativeCalls: 0, executedCalls: 0 } : {}),
      ...(id === 'stop' ? { executedCalls: 0, cancelled: true } : {}),
    })) };
}
it('allows only bounded aggregate and boolean receipts, never payloads or native handles', () => {
  const input = receipt();
  input.prompt = 'secret prompt'; input.results = ['secret document']; input.nativeHandle = 42;
  input.steps[2].arguments = 'secret arguments'; input.steps[2].tokens = [4, 3, 2, 1];
  const safe = sanitizeLocalToolsEvidence(input);
  expect(JSON.stringify(safe)).not.toContain('secret');
  expect(safe).not.toHaveProperty('nativeHandle');
  expect(safe.steps[2]).not.toHaveProperty('tokens');
  expect(() => validateLocalToolsEvidence(safe)).not.toThrow();
});
it.each(['nativeCalls', 'executedCalls', 'resultReturned', 'referenceMatched', 'finalReferencePresent', 'completionDrained'])(
  'rejects calculator success without %s evidence', field => {
    const input = receipt(); input.steps[2][field] = false;
    expect(() => validateLocalToolsEvidence(input)).toThrow();
  });
it.each(['membershipMatched', 'locatorMatched'])('rejects document success without %s', field => {
  const input = receipt(); input.steps.find(step => step.id === 'document_search')[field] = false;
  expect(() => validateLocalToolsEvidence(input)).toThrow();
});
it('rejects false success, mismatched identities, duplicate steps and incomplete JSON', () => {
  for (const modify of [input => { input.modelSha256 = 'wrong'; },
    input => { input.steps[0].id = 'calculate_auto'; },
    input => { input.steps[3].status = 'not_run'; },
    input => { input.steps.find(step => step.id === 'json_schema').structuredValid = false; },
    input => { input.steps.find(step => step.id === 'json_schema').schemaAnswerMatched = false; }]) {
    const input = receipt(); modify(input); expect(() => validateLocalToolsEvidence(input)).toThrow();
  }
});
it('does not treat a timeout or still-running scenario as native success', async () => {
  let clock = 0;
  await expect(waitForLocalToolsEvidence(async () => ({ ...receipt(), status: 'running' }), {
    timeoutMs: 2, now: () => clock++, wait: async () => undefined,
  })).rejects.toThrow('timed out');
});

it('proves cold reopen preserves protocol and rejects any new process-local run', () => {
  const before = { hydrated: true, threadCount: 1, runCount: 6, callCount: 5, completedCalls: 4,
    pendingCalls: 0, runningRuns: 0, digest: '128:abcd', processRunStarts: 6, busy: false };
  const after = { ...before, processRunStarts: 0 };
  expect(validateColdLocalToolsHistory(before, after)).toMatchObject({ historyUnchanged: true, noReexecution: true });
  for (const patch of [{ processRunStarts: 1 }, { pendingCalls: 1 }, { runningRuns: 1 }, { busy: true },
    { hydrated: false }, { digest: '129:abcd' }, { completedCalls: 5 }, { busy: undefined }]) {
    expect(() => validateColdLocalToolsHistory(before, { ...after, ...patch })).toThrow();
  }
});

it('keeps allowlisted AppError diagnostics and strips arbitrary native strings', async () => {
  const failed = { ...receipt(), status: 'failed', failureCode: 'operation_failed', appErrorCode: 'engine_busy' };
  expect(sanitizeLocalToolsEvidence(failed).appErrorCode).toBe('engine_busy');
  await expect(waitForLocalToolsEvidence(async () => failed)).rejects.toThrow('app=engine_busy');
  const unsafe = sanitizeLocalToolsEvidence({ ...failed, appErrorCode: 'secret prompt/path', message: 'secret native error' });
  expect(unsafe.appErrorCode).toBeUndefined();
  expect(JSON.stringify(unsafe)).not.toContain('secret');
});

it('allows only finite native boundary and parser categories', () => {
  const input = receipt(); input.steps[2].nativeStage = 'count_prompt';
  input.nativeFailureCategory = 'formatter_parser_generation';
  expect(sanitizeLocalToolsEvidence(input).steps[2].nativeStage).toBe('count_prompt');
  expect(sanitizeLocalToolsEvidence(input).nativeFailureCategory).toBe('formatter_parser_generation');
  input.steps[2].nativeStage = 'secret native text'; input.nativeFailureCategory = 'secret template';
  expect(JSON.stringify(sanitizeLocalToolsEvidence(input))).not.toContain('secret');
});

it('records no native auto selection as observed, never as successful tool execution', () => {
  const input = receipt();
  const step = input.steps.find(item => item.id === 'calculate_auto');
  Object.assign(step, { status: 'observed', automaticCallSelected: false, nativeSteps: 1, nativeCalls: 0,
    executedCalls: 0, resultReturned: false, referenceMatched: false, finalReferencePresent: false });
  expect(validateLocalToolsEvidence(input).steps[3]).toMatchObject({ status: 'observed', automaticCallSelected: false });
  for (const patch of [{ status: 'passed' }, { executedCalls: 1 }, { nativeCalls: 1 }, { resultReturned: true },
    { referenceMatched: true }, { completionDrained: false }, { outputCharacters: 0 }]) {
    const changed = receipt(); changed.steps[3] = { ...step, ...patch };
    expect(() => validateLocalToolsEvidence(changed)).toThrow();
  }
  input.steps[2] = { ...step, id: 'calculate_required' };
  expect(() => validateLocalToolsEvidence(input)).toThrow();
});
it('still requires exact execution and forwarded result when auto selects a native call', () => {
  const input = receipt(); input.steps[3].resultReturned = false;
  expect(() => validateLocalToolsEvidence(input)).toThrow();
});
