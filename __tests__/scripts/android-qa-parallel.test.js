const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const fixture = require('../../docs/validation/llama-rn-stage3/lora-fixture.json');
const retrievalFixture = require('../../docs/validation/llama-rn-stage5/retrieval-fixtures.json');
const source = fs.readFileSync(path.join(__dirname, '../../src/services/AndroidQaParallelRequests.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;

function harness({ overlap = true, wrongMarker = false, enabled = true, recover = false, restoreContext = true } = {}) {
  let clock = 100;
  let cancelled = false;
  let profile = { backendPolicy: 'cpu', loraAdapters: [], cpuThreads: 4 };
  const writes = [];
  const lifecycle = [];
  const sessionSource = { enumerateChunks: jest.fn(), release: async () => lifecycle.push('release source') };
  const attachment = { id: 'fixture-attachment' };
  let context = 1;
  let searches = 0;
  class DocumentRetrievalError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  const native = { model: '/private/model.gguf', n_ctx: 512, n_threads: 4, cache_type_k: 'q8_0',
    cache_type_v: 'f16', use_mmap: false, cpu_mask: '0x03', n_batch: 256 };
  const phases = [];
  const prepared = [];
  const engine = {
    getEffectiveLoadParameters: () => profile,
    getEffectiveNativeInitParameters: () => native,
    getState: () => ({ activeModelId: 'qa', diagnostics: { contextRecoveryStatus: recover ? 'failed' : undefined } }),
    getLoadedGpuLayers: () => 0, getContextSize: () => 512, getPromptContextIdentity: () => String(context),
    hasActiveCompletion: () => false, hasAuxiliaryContextOperation: () => false,
    runWithAuxiliaryContext: async (phase, operation) => { phases.push(phase); return operation({}); },
    stopComparisonVariant: async index => { expect(index).toBe(0); cancelled = true; },
    compareChatCompletions: async options => {
      options.onNativeStatus({ requests: [], active_slots: 0, queued_requests: 0 });
      clock += 10; options.onToken(0, {});
      clock += 10; options.onToken(1, {});
      options.onNativeStatus({ requests: (overlap ? [1, 2] : [1]).map(id => ({
        request_id: id, type: 'completion', state: 'generating',
      })), active_slots: overlap ? 2 : 1, queued_requests: overlap ? 0 : 1 });
      clock += 30; options.onState(0, cancelled ? 'cancelled' : 'completed');
      clock += 20; options.onState(1, 'completed');
      clock += 1000; // Restoring A must not inflate the native decode window.
      return [cancelled ? { status: 'cancelled' } : { status: 'success', result: { content: 'QA_ALPHA_81 answer' } },
        { status: 'success', result: { content: wrongMarker ? 'QA_ALPHA_81 answer' : 'QA_BETA_81 answer' } }];
    },
    applyLoraConfiguration: async (_id, adapters) => { profile = { ...profile, loraAdapters: adapters }; return adapters; },
  };
  const model = { id: 'qa', localPath: 'model.gguf', downloadIntegrity: { sha256: fixture.base.sha256 },
    artifacts: [{ id: 'adapter', installState: 'installed', integrity: {
      kind: 'sha256', sha256: fixture.adapter.sha256, sizeBytes: fixture.adapter.sizeBytes,
    } }] };
  const mocks = {
    'expo-file-system/legacy': {
      writeAsStringAsync: async (file, data) => { if (file.endsWith('.json')) writes.push(JSON.parse(data)); },
      deleteAsync: async () => lifecycle.push('delete source file'),
    },
    '../store/chatStore': { useChatStore: { getState: () => ({ activeThreadId: 'thread' }) } },
    '../types/chat': { createChatId: () => 'synthetic' }, '../types/documentRetrieval': { DocumentRetrievalError },
    '../utils/generationControls': { freezeGenerationParameters: value => value },
    '../utils/modelArtifacts': { getCompanionBindingIdentity: () => 'identity' },
    './AndroidQaDocumentModelBootstrap': { ANDROID_QA_DOCUMENT_MODEL_ID: 'qa', isAndroidQaDocumentModelBootstrapEnabled: () => enabled },
    './AndroidQaStage3': { getAndroidQaEffectiveProfileIdentity: value => JSON.stringify(value),
      prepareAndroidQaStage3Adapter: async () => { prepared.push('lora'); return { artifactId: 'adapter', scale: 1 }; } },
    './AndroidQaDocumentRetrieval': { prepareAndroidQaDocumentRetrievalModels: async () => prepared.push('retrieval') },
    './FileSystemSetup': { getAppCacheRootDir: () => '/isolated/.qa/cache/' },
    './LocalStorageRegistry': { registry: { getModel: id => id === 'qa' ? model : {
      downloadIntegrity: { sha256: retrievalFixture.models.find(item => item.role === id)?.sha256 },
    } } },
    './LLMEngineService': { llmEngineService: engine },
    './PreparedLlamaRequest': { PreparedLlamaRequestCache: class {
      async prepare() { return { completion: { prompt: 'fixed prompt' }, formatted: {} }; }
      clear() {}
    } },
    './LlamaRuntimeAdapter': { tokenizeFormattedPrompt: async () => ({ tokens: [1] }) },
    './LlamaParallelRequests': { enableParallelContext: async () => {}, disableParallelContext: async () => {},
      startParallelCompletion: options => ({ promise: (async () => {
        clock += 5; options.onToken(); clock += 20; return { text: 'safe', interrupted: false };
      })() }) },
    './SystemMetricsService': { getFreshMemorySnapshot: async () => ({ appPssBytes: 1234, appResidentBytes: 2345 }) },
    './LlamaSourcePatchIdentity': { LLAMA_SOURCE_PATCH_SHA256: 'test-hash' },
    './ChatAttachmentStorageService': {
      chatAttachmentStorageService: {
        copyDocumentAssetToDraft: async () => ({}),
        discardDocumentDraft: async () => lifecycle.push('discard draft'),
      },
      materializeDocumentDraftsForProcessing: () => [attachment],
    },
    './ChatAttachmentProcessorRegistry': { chatAttachmentProcessorRegistry: {
      processDocumentTextAttachment: async (_attachment, { retainSessionContextSource }) => ({
        chunks: [{}], ...(retainSessionContextSource ? { sessionContextSource: sessionSource } : {}),
      }),
    } },
    './DocumentRetrievalRuntime': { resolveRetrievalRuntimeBinding: modelId => ({ modelId }) },
    './DocumentRetrievalService': { retrieveDocumentCandidates: async (_query, [entry], _settings, options) => {
      if (!entry.result.sessionContextSource?.enumerateChunks) {
        return { actualMode: 'lexical', fallbackReason: 'index_stale', candidates: [] };
      }
      expect(lifecycle).not.toContain('release source');
      options.assertProvisionalEntryCurrent(entry);
      const cancelledRun = searches++ === 0;
      options.onNativeOperation({ operation: 'embedding', phase: 'started' });
      expect(options.signal.aborted).toBe(false);
      await Promise.resolve();
      options.onNativeOperation({ operation: 'embedding', phase: 'settled' });
      if (restoreContext) context++;
      if (cancelledRun) {
        expect(options.signal.aborted).toBe(true);
        // The real engine restores A but suppresses onRestored after abort.
        throw new DocumentRetrievalError('cancelled');
      }
      options.onNativeOperation({ operation: 'embedding', phase: 'started' });
      options.onNativeOperation({ operation: 'embedding', phase: 'settled' });
      options.onNativeOperation({ operation: 'rerank', phase: 'started' });
      options.onNativeOperation({ operation: 'rerank', phase: 'settled', indices: [0], inputCount: 1 });
      options.onRestored();
      return { actualMode: 'hybrid+rerank', candidates: [{}] };
    } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => {
    if (id.endsWith('.json')) return require(path.resolve(__dirname, '../../src/services', id));
    if (!(id in mocks)) throw new Error(`Unexpected module ${id}`);
    return mocks[id];
  }, Date: { now: () => clock }, setInterval, clearInterval, queueMicrotask, Set, Promise, AbortController });
  return { exports, writes, phases, prepared, lifecycle };
}

test('native timings exclude restoration and single-slot benchmark copies the actual native profile', async () => {
  const { exports, phases, writes } = harness();
  await exports.runAndroidQaParallelRequests('compare');
  const report = exports.getAndroidQaParallelRequestsEvidence();
  expect(report.status).toBe('native_passed');
  expect(report.steps[1]).toMatchObject({ nativeWindowMs: 70, totalMs: 1070, ttftMs: [10, 20], nativeIdsDistinct: true });
  expect(phases[0].initParams).toMatchObject({ n_parallel: 1, cache_type_k: 'q8_0', use_mmap: false, cpu_mask: '0x03', n_batch: 256 });
  expect(JSON.stringify(writes)).not.toContain('/private/');
});

test('two settled promises without overlapping native generating slots cannot pass', async () => {
  const { exports } = harness({ overlap: false });
  await exports.runAndroidQaParallelRequests('stop_one');
  expect(exports.getAndroidQaParallelRequestsEvidence()).toMatchObject({ status: 'failed', failureCode: 'native_overlap_not_observed' });
});

test('distinct native IDs do not excuse cross-request parser marker contamination', async () => {
  const { exports } = harness({ wrongMarker: true });
  await exports.runAndroidQaParallelRequests('stop_one');
  expect(exports.getAndroidQaParallelRequestsEvidence()).toMatchObject({ status: 'failed', failureCode: 'second_marker_failed' });
});

test('independent stop requires cancellation of one request and successful other marker', async () => {
  const { exports } = harness();
  await exports.runAndroidQaParallelRequests('stop_one');
  expect(exports.getAndroidQaParallelRequestsEvidence()).toMatchObject({ status: 'native_passed',
    steps: [expect.objectContaining({ runningStop: true, nextSucceeded: true, overlapObserved: true })] });
});

test('fixture preparation is explicit and is not labelled native inference acceptance', async () => {
  const { exports, prepared } = harness();
  await exports.runAndroidQaParallelRequests('prepare_auxiliary');
  expect(prepared).toEqual(['retrieval', 'lora']);
  expect(exports.getAndroidQaParallelRequestsEvidence()).toMatchObject({ status: 'fixtures_ready', steps: [] });
});

test('disabled QA never prepares files; uncertain recovery suppresses further runs', async () => {
  const disabled = harness({ enabled: false });
  await disabled.exports.runAndroidQaParallelRequests('prepare_auxiliary');
  expect(disabled.prepared).toEqual([]);
  const blocked = harness({ overlap: false, recover: true });
  await blocked.exports.runAndroidQaParallelRequests('stop_one');
  expect(blocked.exports.getAndroidQaParallelRequestsEvidence().requiresForceStop).toBe(true);
  await blocked.exports.runAndroidQaParallelRequests('prepare_auxiliary');
  expect(blocked.prepared).toEqual([]);
});

test('auxiliary QA retains its source and proves restoration after cancellation without a callback', async () => {
  const { exports, lifecycle } = harness();
  await exports.runAndroidQaParallelRequests('prepare_auxiliary');
  await exports.runAndroidQaParallelRequests('auxiliary');
  expect(exports.getAndroidQaParallelRequestsEvidence()).toMatchObject({ status: 'native_passed',
    steps: [
      { id: 'auxiliary_stop_drain', embeddingStarted: 1, rerankStarted: 0, nativeSettled: 1, restored: 1, loraCount: 1 },
      { id: 'auxiliary_next_search', embeddingStarted: 2, rerankStarted: 1, nativeSettled: 3, restored: 1, indicesValidated: true },
    ] });
  expect(lifecycle).toEqual(['release source', 'discard draft', 'delete source file']);
});

test('auxiliary QA cannot pass cancellation without a replacement context', async () => {
  const { exports, lifecycle } = harness({ restoreContext: false });
  await exports.runAndroidQaParallelRequests('prepare_auxiliary');
  await exports.runAndroidQaParallelRequests('auxiliary');
  expect(exports.getAndroidQaParallelRequestsEvidence()).toMatchObject({
    status: 'failed', failureCode: 'auxiliary_drain_failed', steps: [],
  });
  expect(lifecycle).toEqual(['release source', 'discard draft', 'delete source file']);
});
