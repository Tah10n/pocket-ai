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
