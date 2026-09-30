const fixture = require('../../docs/validation/llama-rn-stage5/retrieval-fixtures.json');
const { STEP_IDS, MODES, IDENTITIES, sanitizeDocumentRetrievalEvidence, validateDocumentRetrievalEvidence,
  waitForDocumentRetrievalEvidence } = require('../../scripts/lib/document-retrieval-evidence');

// Synthetic verifier inputs only; these are never exported as native acceptance evidence.
function receipt({ warm = false, deleted = false } = {}) {
  const pair = { documentEmbeddings: 0, queryEmbeddings: 1, rerankCalls: 1, nativeStarted: 2,
    nativeSettled: 2, restored: 1, nativeIndices: Array.from({ length: 8 }, (_, index) => index) };
  return { schemaVersion: 1, ...IDENTITIES, status: warm ? 'ready_for_cold_reopen' : deleted ? 'ready_for_deleted_reopen' : 'passed',
    phase: warm ? 'cold_reuse' : deleted ? 'deleted_reuse' : 'complete', requiresForceStop: false,
    steps: (warm ? STEP_IDS.slice(0, STEP_IDS.indexOf('cold_reuse')) : deleted ? STEP_IDS.slice(0, STEP_IDS.indexOf('deleted_reuse')) : STEP_IDS)
      .map(id => ({ id, status: 'passed', ...pair,
      fixtureVerified: true, chunkCount: 12, indexCount: 4, profileRestored: true, probabilityRestored: true,
      nativeSteps: 2, toolCalls: 1, resultReturned: true, membershipMatched: true, locatorMatched: true,
      actualModeMatched: true, structuredValid: true, schemaAnswerMatched: true, outputCharacters: 4,
      promptTokens: 128, tokensEvaluated: 128,
      promptChunks: fixture.corpus.documents[0].paragraphs.map((paragraph, chunkIndex) => {
        const start = fixture.corpus.documents[0].paragraphs.slice(0, chunkIndex).reduce((sum, item) => sum + item.text.length + 2, 0);
        return { documentId: fixture.corpus.documents[0].id, paragraphId: paragraph.id, chunkIndex, rank: chunkIndex + 1,
          sourceStart: start, sourceEnd: start + paragraph.text.length };
      }),
      cancelled: true, completionDrained: true, noReexecution: true, deleted: true, oldIdsRejected: true,
      ...(id === 'tool_schema' ? { actualMode: 'hybrid' } : {}),
      ...(id === 'prepare_indexes' ? { documentEmbeddings: 12, queryEmbeddings: 0, rerankCalls: 0,
        nativeStarted: 12, nativeSettled: 12, restored: 1, nativeIndices: [] } : {}),
      ...(id === 'stop_prepare' ? { documentEmbeddings: 1, queryEmbeddings: 0, rerankCalls: 0,
        nativeStarted: 1, nativeSettled: 1, restored: 0, indexCount: 0, nativeIndices: [] } : {}),
      ...(id === 'stop_drain' ? { queryEmbeddings: 1, rerankCalls: 0, nativeStarted: 1, nativeSettled: 1, nativeIndices: [] } : {}),
      ...(id === 'deleted_reuse' ? { queryEmbeddings: 0, rerankCalls: 0, nativeStarted: 0, nativeSettled: 0, restored: 0, nativeIndices: [] } : {}),
    })),
    cases: fixture.corpus.queries.flatMap(query => MODES.map(mode => {
      const original = fixture.corpus.documents.flatMap(doc => doc.paragraphs.map((paragraph, chunkIndex) => {
        const start = doc.paragraphs.slice(0, chunkIndex).reduce((sum, item) => sum + item.text.length + 2, 0);
        return { documentId: doc.id, paragraphId: paragraph.id, chunkIndex, sourceStart: start, sourceEnd: start + paragraph.text.length };
      }));
      const selected = [...original.filter(item => query.relevantParagraphIds.includes(item.paragraphId)),
        ...original.filter(item => !query.relevantParagraphIds.includes(item.paragraphId))].map((item, index) => ({ ...item, rank: index + 1 }));
      const nativeStarted = mode === 'lexical' ? 0 : mode === 'hybrid' ? 1 : 2;
      return { queryId: query.id, mode, status: 'passed', actualMode: mode === 'hybrid_rerank' ? 'hybrid+rerank' : mode,
        documentEmbeddings: 0, queryEmbeddings: mode === 'lexical' ? 0 : 1, rerankCalls: mode === 'hybrid_rerank' ? 1 : 0,
        nativeStarted, nativeSettled: nativeStarted, restored: mode === 'lexical' ? 0 : 1,
        nativeIndices: mode === 'hybrid_rerank' ? pair.nativeIndices : [], selected, recallAt3: 1,
        relevantRanks: query.relevantParagraphIds.map(paragraphId => ({ paragraphId, rank: selected.find(item => item.paragraphId === paragraphId).rank })),
      };
    })),
  };
}

it('requires all 36 frozen cases and the complete warm/cold native sequence', () => {
  expect(() => validateDocumentRetrievalEvidence(receipt())).not.toThrow();
  expect(() => validateDocumentRetrievalEvidence(receipt({ warm: true }), { readyForColdReopen: true })).not.toThrow();
  expect(() => validateDocumentRetrievalEvidence(receipt({ deleted: true }), { readyForDeletedReopen: true })).not.toThrow();
  expect(() => validateDocumentRetrievalEvidence(receipt({ warm: true }))).toThrow();
  expect(() => validateDocumentRetrievalEvidence(receipt({ deleted: true }))).toThrow();
});
it('exports only fixed IDs, bounded indexes/metrics and finite boolean receipts', () => {
  const input = receipt(); input.userPath = '/private/secret'; input.prompts = ['secret'];
  input.steps[0].vectors = [[1, 2]]; input.cases[0].selected[0].text = 'private text'; input.cases[0].selected[0].nativeHandle = 7;
  input.cases[0].selected[0].path = '/private/model'; input.cases[0].tokens = [42];
  const safe = sanitizeDocumentRetrievalEvidence(input);
  expect(/secret|private|nativeHandle|"vectors"|"tokens"|"prompts"/.test(JSON.stringify(safe))).toBe(false);
  expect(() => validateDocumentRetrievalEvidence(safe)).not.toThrow();
});
it.each(['embeddingSha256', 'rerankerSha256', 'fixtureId', 'runtimeVersion'])('rejects mismatched %s provenance', field => {
  const input = receipt(); input[field] = 'unknown'; expect(() => validateDocumentRetrievalEvidence(input)).toThrow();
});
it.each([
  ['missing query', input => { input.cases.pop(); }],
  ['duplicate case', input => { input.cases[1] = input.cases[0]; }],
  ['hidden fallback', input => { input.cases[1].fallbackReason = 'native_failed'; }],
  ['false semantic mode', input => { input.cases[1].actualMode = 'lexical'; }],
  ['document recomputation', input => { input.cases[1].documentEmbeddings = 1; }],
  ['no restoration', input => { input.cases[1].restored = 0; }],
  ['unsettled native', input => { input.cases[1].nativeSettled = 0; }],
  ['native duplicate index', input => { input.cases[2].nativeIndices = Array(8).fill(0); }],
  ['native out-of-range index', input => { input.cases[2].nativeIndices[0] = 8; }],
  ['invalid original chunk', input => { input.cases[0].selected[0].chunkIndex = 99; }],
  ['invented locator', input => { input.cases[0].selected[0].pageNumber = 4; }],
  ['changed golden label', input => { input.cases[0].relevantRanks[0].paragraphId = 'invented'; }],
  ['false Recall@3', input => { input.cases[0].recallAt3 = 0; }],
  ['wrong rank', input => { input.cases[0].relevantRanks[0].rank = 16; }],
])('rejects %s in recorded corpus evidence', (_reason, change) => {
  const input = receipt(); change(input); expect(() => validateDocumentRetrievalEvidence(input)).toThrow();
});
it.each([
  ['stop_prepare', 'cancelled'], ['stop_prepare', 'completionDrained'], ['stop_prepare', 'profileRestored'],
  ['prepare_indexes', 'documentEmbeddings'], ['lora_handoff', 'profileRestored'], ['lora_handoff', 'probabilityRestored'],
  ['tool_schema', 'resultReturned'], ['tool_schema', 'membershipMatched'], ['tool_schema', 'actualModeMatched'],
  ['tool_schema', 'structuredValid'], ['tool_schema', 'schemaAnswerMatched'], ['stop_drain', 'completionDrained'],
  ['cold_reuse', 'noReexecution'], ['delete_corpus', 'deleted'], ['deleted_reuse', 'oldIdsRejected'], ['deleted_reuse', 'deleted'], ['cleanup', 'profileRestored'],
])('rejects success without %s/%s', (stepId, field) => {
  const input = receipt(); input.steps.find(step => step.id === stepId)[field] = false;
  expect(() => validateDocumentRetrievalEvidence(input)).toThrow();
});
it('waits for the explicit warm barrier and refuses failed or still-running evidence', async () => {
  let clock = 0; const wait = async ms => { clock += ms; };
  await expect(waitForDocumentRetrievalEvidence(async () => receipt({ warm: true }), { readyForColdReopen: true, now: () => clock, wait }))
    .resolves.toMatchObject({ status: 'ready_for_cold_reopen' });
  await expect(waitForDocumentRetrievalEvidence(async () => ({ ...receipt(), status: 'failed', failureCode: 'timeout' }), { now: () => clock, wait }))
    .rejects.toThrow('failed');
  await expect(waitForDocumentRetrievalEvidence(async () => ({ ...receipt(), status: 'running' }), { timeoutMs: 2, now: () => clock, wait }))
    .rejects.toThrow('timed out');
});


it('retains finite failed LoRA operation progress and typed engine errors without private payloads', () => {
  const input = receipt(); input.status = 'failed'; input.phase = 'lora_handoff'; input.failureCode = 'operation_failed';
  Object.assign(input.steps.find(step => step.id === 'lora_handoff'), { status: 'failed',
    operation: 'adapter_apply', operationErrorCode: 'engine_busy', nativeIdleBarrierWaited: true,
    adapterFound: true, adapterApplied: false, queryEmbeddings: 0, nativeStarted: 0, nativeSettled: 0,
    message: 'private native path /data/user/0/model.gguf', prompt: 'private prompt', probabilities: [0.5], vector: [1, 2] });
  const step = sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === 'lora_handoff');
  expect(step).toMatchObject({ status: 'failed', operation: 'adapter_apply', operationErrorCode: 'engine_busy',
    nativeIdleBarrierWaited: true, adapterFound: true, adapterApplied: false,
    queryEmbeddings: 0, nativeStarted: 0, nativeSettled: 0 });
  expect(JSON.stringify(step)).not.toMatch(/private|probabilities|vector|model\.gguf/);
});

it('retains known probability failures and drained counts while dropping arbitrary operation identifiers', () => {
  const input = receipt(); const pending = input.steps.find(step => step.id === 'lora_handoff');
  Object.assign(pending, { status: 'failed', operation: 'probability_compare',
    operationErrorCode: 'probability_support_mismatch', adapterApplied: true, baselineProbeCompleted: true,
    repeatProbeCompleted: true, handoffCompleted: true, restoredProbeCompleted: true,
    queryEmbeddings: 1, rerankCalls: 1, nativeStarted: 2, nativeSettled: 2, restored: 1 });
  expect(sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === 'lora_handoff')).toMatchObject({
    operation: 'probability_compare', operationErrorCode: 'probability_support_mismatch',
    adapterApplied: true, baselineProbeCompleted: true, repeatProbeCompleted: true,
    handoffCompleted: true, restoredProbeCompleted: true, nativeStarted: 2, nativeSettled: 2, restored: 1 });
  Object.assign(pending, { operation: '/private/prompt', operationErrorCode: '/private/model.gguf' });
  const step = sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === 'lora_handoff');
  expect(step.operation).toBeUndefined(); expect(step.operationErrorCode).toBeUndefined();
  expect(JSON.stringify(step)).not.toContain('/private/');
});


it.each(['lexical', 'lexical+rerank', 'hybrid+rerank', undefined])('rejects tool semantic proof with actual mode %s', mode => {
  const input = receipt(); input.steps.find(step => step.id === 'tool_schema').actualMode = mode;
  expect(() => validateDocumentRetrievalEvidence(input)).toThrow('Real tool proposal');
});
it('rejects a tool fallback even when its mode-match flag claims success', () => {
  const input = receipt(); input.steps.find(step => step.id === 'tool_schema').fallbackReason = 'native_failed';
  expect(() => validateDocumentRetrievalEvidence(input)).toThrow('Real tool proposal');
});
it('retains genuine tool timeout progress and reports its finite operation without payloads', async () => {
  const input = receipt(); input.status = 'failed'; input.phase = 'tool_schema'; input.failureCode = 'operation_failed';
  Object.assign(input.steps.find(step => step.id === 'tool_schema'), { status: 'failed',
    operation: 'tool_execute', operationErrorCode: 'local_tool_timeout', nativeStage: 'first_token',
    modelLoaded: true, threadConfigured: true, toolRunCompleted: false, nativeSteps: 1, toolCalls: 1,
    arguments: 'private query', result: 'private result', prompt: 'private prompt' });
  const failed = sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === 'tool_schema');
  expect(failed).toMatchObject({ operation: 'tool_execute', operationErrorCode: 'local_tool_timeout', nativeStage: 'first_token',
    modelLoaded: true, threadConfigured: true, toolRunCompleted: false, nativeSteps: 1, toolCalls: 1 });
  expect(JSON.stringify(failed)).not.toMatch(/private|arguments|result":|prompt":/);
  await expect(waitForDocumentRetrievalEvidence(async () => input)).rejects.toThrow('operationErrorCode=local_tool_timeout');
});
it.each([
  ['stop_drain', 'stop_retrieval'], ['next_query', 'next_retrieval'], ['cold_reuse', 'cold_index_check'],
  ['delete_corpus', 'corpus_delete'], ['deleted_reuse', 'deleted_tool_search'], ['cleanup', 'original_restore'],
])('retains finite %s failure diagnostics and secondary cleanup ownership', (id, operation) => {
  const input = receipt(); Object.assign(input.steps.find(step => step.id === id), { status: 'failed', operation,
    operationErrorCode: 'ownership_changed', cleanupOperation: 'original_restore', cleanupErrorCode: 'engine_busy',
    checkpointRead: true, indexFingerprintsMatched: false, corpusDeleted: true });
  const failed = sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === id);
  expect(failed).toMatchObject({ operation, operationErrorCode: 'ownership_changed',
    cleanupOperation: 'original_restore', cleanupErrorCode: 'engine_busy',
    checkpointRead: true, indexFingerprintsMatched: false, corpusDeleted: true });
  Object.assign(input.steps.find(step => step.id === id), { operation: 'private prompt',
    operationErrorCode: 'private error', cleanupOperation: '/private/model', cleanupErrorCode: '/private/path',
    nativeStage: 'private native output', actualMode: 'private mode', fallbackReason: 'private source' });
  const unknown = sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === id);
  expect(unknown.operation).toBeUndefined(); expect(unknown.operationErrorCode).toBeUndefined();
  expect(unknown.cleanupOperation).toBeUndefined(); expect(unknown.cleanupErrorCode).toBeUndefined();
  expect(unknown.nativeStage).toBeUndefined(); expect(unknown.actualMode).toBeUndefined(); expect(unknown.fallbackReason).toBeUndefined();
  expect(JSON.stringify(unknown)).not.toContain('private');
});

it('retains bounded Stop preparation failure diagnostics without accepting fallback or leaking payloads', () => {
  const input = receipt(); input.status = 'failed'; input.phase = 'stop_prepare'; input.failureCode = 'assertion';
  const pending = input.steps.find(step => step.id === 'stop_prepare');
  Object.assign(pending, { status: 'failed', sourceEntryCount: 3, modelRestored: false, profileRestored: false,
    cancelled: false, stopRequested: false, actualMode: 'lexical', fallbackReason: 'model_unavailable',
    documentEmbeddings: 0, nativeStarted: 0, nativeSettled: 0,
    text: 'private document', profileIdentity: '/private/model.gguf', vector: [1, 2] });
  for (const operation of ['stop_prepare_profile_capture', 'stop_prepare_owner_check', 'stop_prepare_source_load',
    'stop_prepare_retrieval', 'stop_prepare_cancel_check', 'stop_prepare_count_check', 'stop_prepare_idle_check',
    'stop_prepare_model_check', 'stop_prepare_profile_check', 'stop_prepare_index_check']) {
    pending.operation = operation;
    const failed = sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === 'stop_prepare');
    expect(failed).toMatchObject({ operation, sourceEntryCount: 3, modelRestored: false, cancelled: false,
      stopRequested: false, actualMode: 'lexical', fallbackReason: 'model_unavailable', nativeStarted: 0, nativeSettled: 0 });
    expect(JSON.stringify(failed)).not.toMatch(/private|profileIdentity|vector|model\.gguf/);
    expect(() => validateDocumentRetrievalEvidence(input)).toThrow('incomplete provenance or status');
  }
  Object.assign(pending, { operation: '/private/operation', sourceEntryCount: 1_000_001, modelRestored: 'private' });
  const invalid = sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === 'stop_prepare');
  expect(invalid.operation).toBeUndefined(); expect(invalid.sourceEntryCount).toBeUndefined(); expect(invalid.modelRestored).toBeUndefined();
  pending.sourceEntryCount = Number.NaN;
  expect(sanitizeDocumentRetrievalEvidence(input).steps.find(step => step.id === 'stop_prepare').sourceEntryCount).toBeUndefined();
});
