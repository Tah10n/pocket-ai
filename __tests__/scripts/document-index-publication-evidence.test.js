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
  it('rejects failed and timed-out evidence rather than calling a deadline completion', async () => {
    await expect(waitForDocumentIndexPublicationEvidence(() => ({ ...completeEvidence(), status: 'failed', phase: 'stop', failureCode: 'timeout' })))
      .rejects.toThrow('phase=stop, code=timeout');
    let time = 0;
    await expect(waitForDocumentIndexPublicationEvidence(() => null, { timeoutMs: 1, now: () => time,
      wait: async () => { time = 2; } })).rejects.toThrow('without actual terminal evidence');
  });
});
