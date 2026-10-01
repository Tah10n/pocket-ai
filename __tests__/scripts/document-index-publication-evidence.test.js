const { STEP_IDS, sanitizeDocumentIndexPublicationEvidence, validateDocumentIndexPublicationEvidence,
  waitForDocumentIndexPublicationEvidence } = require('../../scripts/lib/document-index-publication-evidence');
const fixture = require('../../docs/validation/llama-rn-stage5/retrieval-fixtures.json');

function completeEvidence() {
  return { schemaVersion: 1, fixtureId: fixture.fixtureId, runtimeVersion: fixture.runtimeVersion, backend: 'cpu',
    status: 'passed', phase: 'complete', requiresForceStop: false,
    steps: STEP_IDS.map(id => ({ id, status: 'passed', userCount: 1, assistantCount: 1, outputCharacters: 20,
      tokensPredicted: 10, tokensEvaluated: 40, completionDrained: true, noReady: true, oldIndexesRetained: true,
      historyRetained: true, attachmentsRetained: true, profileRestored: true, loraApplied: true, answerMatched: true,
      ...(id === 'four_indexes' ? { indexCount: 4, documentEmbeddings: 4, queryEmbeddings: 0, rerankCalls: 0, nativeStarted: 4, nativeSettled: 4 } : {}),
      ...(['fifth_new_chat', 'fifth_existing_chat'].includes(id) ? { actualMode: 'hybrid+rerank', cacheFailure: 'quota_exceeded',
        callbackCount: 1, documentEmbeddings: id === 'fifth_new_chat' ? 1 : 2, queryEmbeddings: 1, rerankCalls: 1,
        nativeStarted: id === 'fifth_new_chat' ? 3 : 4, nativeSettled: id === 'fifth_new_chat' ? 3 : 4, restored: 1 } : {}),
      ...(id === 'stop' ? { cancelled: true, documentEmbeddings: 1, queryEmbeddings: 0, rerankCalls: 0, nativeStarted: 1, nativeSettled: 1 } : {}),
      ...(id === 'cold_retention' ? { indexCount: 4 } : {}),
    })) };
}
describe('publication QA host evidence boundary', () => {
  it('accepts real-count warm and cold protocols without replaying the ranking matrix', () => {
    const input = completeEvidence(); expect(validateDocumentIndexPublicationEvidence(input).steps).toHaveLength(8);
    expect(validateDocumentIndexPublicationEvidence({ ...input, status: 'ready_for_cold_reopen', phase: 'cold_retention',
      steps: input.steps.slice(0, 5) }, { readyForColdReopen: true }).steps).toHaveLength(5);
  });
  it.each([
    ['hidden document reembedding', 'fifth_new_chat', 'documentEmbeddings', 2],
    ['lost callback', 'fifth_new_chat', 'callbackCount', 0],
    ['duplicate assistant', 'fifth_existing_chat', 'assistantCount', 2],
    ['incorrect retrieval label', 'fifth_existing_chat', 'actualMode', 'lexical'],
    ['false readiness', 'fifth_new_chat', 'noReady', false],
    ['missing active LoRA', 'fifth_new_chat', 'loraApplied', false],
    ['unsettled Stop', 'stop', 'nativeSettled', 0],
    ['lost cold attachments', 'cold_retention', 'attachmentsRetained', false],
  ])('rejects %s', (_label, id, field, value) => {
    const input = completeEvidence(); input.steps.find(step => step.id === id)[field] = value;
    expect(() => validateDocumentIndexPublicationEvidence(input)).toThrow();
  });
  it('strips source text, user paths, IDs, vectors and unknown error details', () => {
    const input = completeEvidence(); input.documentText = 'private document text'; input.localUri = '/private/user-file';
    input.steps[0].threadId = 'private-chat'; input.steps[0].vector = [0.2, 0.5]; input.steps[0].error = '/private/secret';
    const safe = JSON.stringify(sanitizeDocumentIndexPublicationEvidence(input));
    expect(safe).not.toMatch(/private|vector|threadId|documentText/u);
  });
  it('retains bounded seed checkpoints and real counts while stripping private diagnostic details', async () => {
    const seedProgress = { seedIndex: 2, completedSeeds: 1, operation: 'seed_prepare', documentEmbeddings: 1,
      queryEmbeddings: 0, rerankCalls: 0, nativeStarted: 1, nativeSettled: 1, restored: 1,
      completionDrained: true, operationErrorCode: 'native_failed', threadId: 'private-chat', error: '/private/file',
      vector: [0.2], text: 'private source', score: 0.5 };
    const input = { ...completeEvidence(), status: 'failed', phase: 'four_indexes', failureCode: 'operation_failed', seedProgress };
    const safe = sanitizeDocumentIndexPublicationEvidence(input);
    expect(safe.seedProgress).toEqual({ seedIndex: 2, completedSeeds: 1, operation: 'seed_prepare', documentEmbeddings: 1,
      queryEmbeddings: 0, rerankCalls: 0, nativeStarted: 1, nativeSettled: 1, restored: 1,
      completionDrained: true, operationErrorCode: 'native_failed' });
    expect(JSON.stringify(safe)).not.toMatch(/private|vector|threadId|score/u);
    await expect(waitForDocumentIndexPublicationEvidence(() => input)).rejects.toThrow(
      'seed=2, completed=1, operation=seed_prepare, error=native_failed');
    expect(() => validateDocumentIndexPublicationEvidence(input)).toThrow();
  });
  it.each([
    ['seedIndex', 0], ['seedIndex', 5], ['completedSeeds', -1], ['completedSeeds', 5], ['operation', '/private/operation'],
  ])('drops invalid seed checkpoint %s', (field, value) => {
    const seedProgress = { seedIndex: 1, completedSeeds: 0, operation: 'seed_prepare', [field]: value };
    expect(sanitizeDocumentIndexPublicationEvidence({ ...completeEvidence(), seedProgress }).seedProgress).toBeUndefined();
  });
  it('drops unbounded seed counts and non-allowlisted error strings', () => {
    const seedProgress = { seedIndex: 1, completedSeeds: 0, operation: 'seed_prepare', documentEmbeddings: Infinity,
      queryEmbeddings: -1, nativeStarted: 1000001, nativeSettled: 0.5, operationErrorCode: '/private/native-error' };
    expect(sanitizeDocumentIndexPublicationEvidence({ ...completeEvidence(), seedProgress }).seedProgress)
      .toEqual({ seedIndex: 1, completedSeeds: 0, operation: 'seed_prepare' });
  });
  it('preserves actual quota-turn counts and failed answer checks without exposing model output', async () => {
    const diagnostics = { turn: 'fifth_new_chat', operation: 'answer_match', callbackCount: 1, userCount: 1, assistantCount: 1,
      documentEmbeddings: 1, queryEmbeddings: 1, rerankCalls: 1, nativeStarted: 3, nativeSettled: 3, restored: 1,
      threadPresent: true, assistantTerminal: true, assistantError: false, loraApplied: true, answerMatched: false,
      outputCharacters: 30, tokensPredicted: 18, tokensEvaluated: 140, completionDrained: true };
    const input = { ...completeEvidence(), status: 'failed', phase: 'fifth_new_chat', failureCode: 'assertion',
      turnProgress: { ...diagnostics, threadId: 'private-chat', answer: 'private output', documentText: 'private source',
        localUri: '/private/file', vector: [0.2], score: 0.5 } };
    const safe = sanitizeDocumentIndexPublicationEvidence(input);
    expect(safe.turnProgress).toEqual(diagnostics);
    expect(JSON.stringify(safe)).not.toMatch(/private|vector|threadId|documentText|score/u);
    await expect(waitForDocumentIndexPublicationEvidence(() => input)).rejects.toThrow(
      'turn=fifth_new_chat, operation=answer_match, callback=1');
    expect(() => validateDocumentIndexPublicationEvidence(input)).toThrow();
  });
  it('preserves fallback/cache/profile diagnostics while required acceptance counts still fail', () => {
    const diagnostics = { turn: 'fifth_existing_chat', operation: 'status_cache', callbackCount: 1, attachmentCount: 1,
      actualMode: 'lexical', fallbackReason: 'invalid_ranking', cacheFailure: 'cache_write_failed', noReady: true,
      nativeStarted: 2, nativeSettled: 2, restored: 1, profileRestored: false, operationErrorCode: 'action_failed' };
    const input = { ...completeEvidence(), turnProgress: diagnostics };
    expect(sanitizeDocumentIndexPublicationEvidence(input).turnProgress).toEqual(diagnostics);
    input.steps.find(step => step.id === 'fifth_existing_chat').nativeSettled = 0;
    expect(() => validateDocumentIndexPublicationEvidence(input)).toThrow();
  });
  it.each([
    ['turn', 'private-chat'], ['operation', '/private/operation'],
  ])('drops invalid quota-turn checkpoint %s', (field, value) => {
    const turnProgress = { turn: 'fifth_new_chat', operation: 'dispatch', [field]: value };
    expect(sanitizeDocumentIndexPublicationEvidence({ ...completeEvidence(), turnProgress }).turnProgress).toBeUndefined();
  });
  it('strips unsafe quota diagnostics and keeps zero counts and false booleans', () => {
    const turnProgress = { turn: 'fifth_new_chat', operation: 'terminal_history', callbackCount: 0, userCount: -1,
      assistantCount: Infinity, nativeStarted: 1000001, nativeSettled: 0.5, outputCharacters: 'private length',
      actualMode: 'private mode', fallbackReason: 'engine_busy', cacheFailure: '/private/cache',
      operationErrorCode: '/private/error', assistantTerminal: false, assistantError: 'private error' };
    expect(sanitizeDocumentIndexPublicationEvidence({ ...completeEvidence(), turnProgress }).turnProgress)
      .toEqual({ turn: 'fifth_new_chat', operation: 'terminal_history', callbackCount: 0, assistantTerminal: false });
  });
  it('rejects failed and timed-out evidence rather than calling a deadline completion', async () => {
    await expect(waitForDocumentIndexPublicationEvidence(() => ({ ...completeEvidence(), status: 'failed', phase: 'stop', failureCode: 'timeout' })))
      .rejects.toThrow('phase=stop, code=timeout');
    let time = 0;
    await expect(waitForDocumentIndexPublicationEvidence(() => null, { timeoutMs: 1, now: () => time,
      wait: async () => { time = 2; } })).rejects.toThrow('without actual terminal evidence');
  });
});
