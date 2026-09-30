import type { LlamaContext } from 'llama.rn';
import {
  assertRetrievalContextProfile, embedDocumentRetrievalText, estimateRetrievalWorkingBytes,
  getDocumentRetrievalRuntimeIdentity, resolveRetrievalRuntimeBinding, runDocumentRetrievalRuntime,
  validateDocumentRerankPair,
} from '../../src/services/DocumentRetrievalRuntime';
import { VERIFIED_RETRIEVAL_PROFILES } from '../../src/services/DocumentRetrievalProfiles';
import { getAuxiliarySelection, validateAuxiliaryFile, claimNativePooledEmbeddingDimension } from '../../src/services/AuxiliaryModelService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { isPrivateStorageWritable } from '../../src/services/storage';
import { runWithIdleModelDownloads } from '../../src/services/ModelDownloadManager';
import { llmEngineService, type AuxiliaryContextSequence } from '../../src/services/LLMEngineService';
import { getLlamaBuildInfo } from '../../src/services/LlamaRuntimeAdapter';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { DOCUMENT_RETRIEVAL_LIMITS } from '../../src/types/documentRetrieval';

jest.mock('../../src/services/AuxiliaryModelService', () => ({
  getAuxiliarySelection: jest.fn(), validateAuxiliaryFile: jest.fn(), claimNativePooledEmbeddingDimension: jest.fn(),
}));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: jest.fn() } }));
jest.mock('../../src/services/SystemMetricsService', () => ({ getSystemMemorySnapshot: jest.fn() }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getModelsDir: () => 'file:///models/' }));
jest.mock('../../src/services/storage', () => ({ isPrivateStorageWritable: jest.fn() }));
jest.mock('../../src/store/storage', () => ({ getAppStorage: jest.fn() }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ runWithIdleModelDownloads: jest.fn() }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: { runWithAuxiliarySequence: jest.fn() } }));
jest.mock('../../src/services/LlamaRuntimeAdapter', () => ({ getLlamaBuildInfo: jest.fn() }));

const embeddingProfile = VERIFIED_RETRIEVAL_PROFILES.find(profile => profile.role === 'embedding')!;
const rerankerProfile = VERIFIED_RETRIEVAL_PROFILES.find(profile => profile.role === 'reranker')!;
function model(role: 'embedding' | 'reranker'): ModelMetadata {
  const profile = role === 'embedding' ? embeddingProfile : rerankerProfile;
  return { id: profile.modelRepository, name: role, author: 'fixture', size: profile.modelBytes,
    downloadUrl: `https://huggingface.co/${profile.modelRepository}/resolve/${profile.modelRevision}/${profile.modelFilename}`,
    hfRevision: profile.modelRevision, resolvedFileName: profile.modelFilename, localPath: profile.modelFilename,
    sha256: profile.modelSha256, lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1,
    accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false, fitsInRam: null,
    roleEvidence: [{ role, source: 'model_card', confidence: 'declared' }] };
}
function vector(index = 0): number[] { return Array.from({ length: 384 }, (_, position) => position === index ? 1 : 0); }
function context() {
  return { model: { nEmbd: 384, metadata: { 'tokenizer.ggml.model': 't5' } },
    tokenize: jest.fn(async (text: string) => ({ tokens: Array.from(text, (_, index) => index + 10) })),
    embedding: jest.fn(async () => ({ embedding: vector() })),
    detokenize: jest.fn(async () => 'retokenized pair'),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const nativeContext = (value: ReturnType<typeof context>) => value as unknown as LlamaContext;
const options = () => ({ assertCurrent: jest.fn() });

beforeEach(() => {
  jest.clearAllMocks();
  const models = [model('embedding'), model('reranker')];
  jest.mocked(getAuxiliarySelection).mockImplementation(role => models.find(entry => entry.roleEvidence?.[0]?.role === role));
  jest.mocked(registry.getModel).mockImplementation(id => models.find(entry => entry.id === id));
  jest.mocked(validateAuxiliaryFile).mockResolvedValue(undefined as never);
  jest.mocked(isPrivateStorageWritable).mockReturnValue(true);
  jest.mocked(getSystemMemorySnapshot).mockResolvedValue({ availableBytes: 4 * 2 ** 30, freeBytes: 4 * 2 ** 30,
    thresholdBytes: 0, lowMemory: false } as never);
  jest.mocked(getLlamaBuildInfo).mockReturnValue({ version: '0.13.0-rc.3', build: 'fixture' } as never);
  jest.mocked(runWithIdleModelDownloads).mockImplementation(operation => operation());
});

describe('DocumentRetrievalRuntime production adapter', () => {
  it.each(['embedding', 'reranker'] as const)('uses the pinned %s native init contract and verifies actual bytes before admission', async role => {
    const binding = resolveRetrievalRuntimeBinding(role, options());
    expect(binding.request.initParams).toMatchObject({ model: `/models/${binding.profile.modelFilename}`,
      n_ctx: 512, n_batch: 512, n_ubatch: 512, n_gpu_layers: 0, embedding: true,
      pooling_type: role === 'embedding' ? 'mean' : 'rank', embd_normalize: role === 'embedding' ? 2 : -1,
      ctx_shift: false, n_parallel: 1, state_cache_budget_mb: 0, state_cache_max_checkpoints: 8 });
    expect(binding.request.nativeDrainTimeoutMs).toBe(30_000);
    await binding.request.beforeInit?.();
    expect(validateAuxiliaryFile).toHaveBeenCalledWith(expect.objectContaining({ sha256: binding.profile.modelSha256 }));
    expect(binding.request.isCurrent()).toBe(true);
    expect(resolveRetrievalRuntimeBinding(role, options(), true).request.nativeDrainTimeoutMs).toBe(600_000);
  });

  it.each(['missing', 'unknown SHA', 'wrong role', 'wrong bytes'] as const)('rejects %s model profiles before native work', reason => {
    const selected = model('embedding');
    jest.mocked(getAuxiliarySelection).mockReturnValue(reason === 'missing' ? undefined
      : reason === 'wrong role' ? model('reranker') : { ...selected,
        ...(reason === 'unknown SHA' ? { sha256: 'a'.repeat(64) } : {}),
        ...(reason === 'wrong bytes' ? { size: embeddingProfile.modelBytes + 1 } : {}) });
    expect(() => resolveRetrievalRuntimeBinding('embedding', options())).toThrow(reason === 'missing' ? 'model_unavailable' : 'profile_unverified');
    expect(validateAuxiliaryFile).not.toHaveBeenCalled();
    expect(llmEngineService.runWithAuxiliarySequence).not.toHaveBeenCalled();
  });

  it.each([null, { availableBytes: 2 ** 30, freeBytes: 1, thresholdBytes: 0, lowMemory: false },
    { availableBytes: 8 * 2 ** 30, freeBytes: 8 * 2 ** 30, thresholdBytes: 0, lowMemory: true }])(
    'rejects unknown, strict-free-limited or low-memory budgets: %j', async snapshot => {
      jest.mocked(getSystemMemorySnapshot).mockResolvedValue(snapshot as never);
      await expect(resolveRetrievalRuntimeBinding('embedding', options()).request.beforeInit?.()).rejects.toMatchObject({ code: 'model_unavailable' });
    });

  it('accounts for live model/work buffers, retained cache and restoration headroom', async () => {
    expect(estimateRetrievalWorkingBytes(embeddingProfile)).toBe(embeddingProfile.modelBytes * 2 + 256 * 2 ** 20
      + 512 * 384 * 4 * 32 + DOCUMENT_RETRIEVAL_LIMITS.cacheBytes + 16 * 2 ** 20);
    expect(estimateRetrievalWorkingBytes(rerankerProfile)).toBeGreaterThan(rerankerProfile.modelBytes * 2);
    const budget = estimateRetrievalWorkingBytes(embeddingProfile);
    jest.mocked(getSystemMemorySnapshot).mockResolvedValue({ availableBytes: budget, freeBytes: budget,
      thresholdBytes: 1, lowMemory: false } as never);
    await expect(resolveRetrievalRuntimeBinding('embedding', options()).request.beforeInit?.()).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('rechecks same-file hash identity after a deferred integrity check', async () => {
    const selected = model('embedding');
    let installed = selected;
    jest.mocked(getAuxiliarySelection).mockReturnValue(selected);
    jest.mocked(registry.getModel).mockImplementation(() => installed);
    const gate = deferred<void>();
    jest.mocked(validateAuxiliaryFile).mockReturnValue(gate.promise as never);
    const binding = resolveRetrievalRuntimeBinding('embedding', options());
    const admission = binding.request.beforeInit!();
    installed = { ...selected, sha256: 'b'.repeat(64) }; // Same ID/path, different owned bytes.
    expect(binding.request.isCurrent()).toBe(false);
    gate.resolve();
    await expect(admission).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(getSystemMemorySnapshot).not.toHaveBeenCalled();
  });

  it('shares the download mutation lease, run owner, cancellation and restoration callback', async () => {
    const controller = new AbortController();
    const runOwner = Symbol('tool-run'); const onRestored = jest.fn();
    const settings = { ...options(), signal: controller.signal, runOwner, onRestored };
    const binding = resolveRetrievalRuntimeBinding('embedding', settings);
    let current!: () => boolean;
    jest.mocked(llmEngineService.runWithAuxiliarySequence).mockImplementation(async (request, operation) => {
      expect(request).toMatchObject({ signal: controller.signal, runOwner, onRestored });
      current = request.isCurrent;
      expect(current()).toBe(true);
      return operation({ withContext: jest.fn() });
    });
    await expect(runDocumentRetrievalRuntime([binding], settings, async () => 'settled')).resolves.toBe('settled');
    expect(runWithIdleModelDownloads).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(current()).toBe(false);
    jest.mocked(isPrivateStorageWritable).mockReturnValue(false);
    expect(binding.request.isCurrent()).toBe(false);
  });

  it.each(['tokenizer', 'detokenizer', 'enumeration', 'embedding'] as const)(
    'retains outer document/download leases after an engine timeout until the actual %s callback finally settles', async stage => {
      const nativeDrain = deferred<void>();
      const watchdog = deferred<void>();
      const ctx = context();
      ctx.tokenize.mockImplementation(async () => { await nativeDrain.promise; return { tokens: [10] }; });
      ctx.detokenize.mockImplementation(async () => { await nativeDrain.promise; return 'chunk'; });
      ctx.embedding.mockImplementation(async () => { await nativeDrain.promise; return { embedding: vector() }; });
      const enumerateChunks = jest.fn(async () => { await nativeDrain.promise; return { chunks: [] }; });
      const pendingCall = stage === 'tokenizer' ? ctx.tokenize : stage === 'detokenizer' ? ctx.detokenize
        : stage === 'embedding' ? ctx.embedding : enumerateChunks;
      const sourceRelease = jest.fn();
      const downloadRelease = jest.fn();
      const restored = jest.fn();
      const timeout = new Error('engine_recovery_required');
      const phase = jest.fn();
      const secondPhase = jest.fn(async () => 2);
      let callbackStarted = false;
      let callbackFinally = false;
      let outerSettled = false;
      const withContext: AuxiliaryContextSequence['withContext'] = async (request, callback) => {
        phase(request.modelId);
        const raw = callback(nativeContext(ctx));
        // Mirrors the engine quarantine: it observes raw drain, but its watchdog
        // rejects the phase before that drain is evidence of a released resource.
        void raw.catch(() => undefined);
        await watchdog.promise;
        throw timeout;
      };
      jest.mocked(llmEngineService.runWithAuxiliarySequence).mockImplementation(async (_request, operation) => operation({ withContext }));
      jest.mocked(runWithIdleModelDownloads).mockImplementation(async operation => {
        try { return await operation(); } finally { downloadRelease(); }
      });
      const binding = resolveRetrievalRuntimeBinding('embedding', options());
      const operation = runDocumentRetrievalRuntime([binding], { ...options(), onRestored: restored }, async (sequence, check) => {
        try {
          await sequence.withContext(binding.request, async () => {
            callbackStarted = true;
            try {
              // A twenty-portion callback must stop after the pending first call,
              // even though the user signal was never aborted by the watchdog.
              for (let portion = 0; portion < 20; portion++) {
                check();
                if (stage === 'tokenizer') await ctx.tokenize('chunk');
                else if (stage === 'detokenizer') await ctx.detokenize();
                else if (stage === 'embedding') await ctx.embedding();
                else await enumerateChunks();
                check();
              }
              return 20;
            }
            finally { callbackFinally = true; }
          });
        } catch (error) {
          // Even a caller trying a new phase after timeout cannot admit native work.
          await expect(sequence.withContext(binding.request, secondPhase)).rejects.toBe(timeout);
          throw error;
        }
        return 1;
      }).finally(() => { sourceRelease(); outerSettled = true; });
      const rejected = expect(operation).rejects.toBe(timeout);
      for (let attempt = 0; attempt < 100 && !callbackStarted; attempt++) await Promise.resolve();
      expect(callbackStarted).toBe(true);
      watchdog.resolve();
      for (let attempt = 0; attempt < 30; attempt++) await Promise.resolve();
      expect(outerSettled).toBe(false);
      expect(callbackFinally).toBe(false);
      expect(sourceRelease).not.toHaveBeenCalled();
      expect(downloadRelease).not.toHaveBeenCalled();
      expect(phase).toHaveBeenCalledTimes(1);
      expect(secondPhase).not.toHaveBeenCalled();
      expect(restored).not.toHaveBeenCalled();
      expect(pendingCall).toHaveBeenCalledTimes(1);
      nativeDrain.resolve();
      await rejected;
      expect(callbackFinally).toBe(true);
      expect(sourceRelease).toHaveBeenCalledTimes(1);
      expect(downloadRelease).toHaveBeenCalledTimes(1);
      expect(pendingCall).toHaveBeenCalledTimes(1);
      expect(downloadRelease.mock.invocationCallOrder[0]).toBeLessThan(sourceRelease.mock.invocationCallOrder[0]);
    },
  );

  it('fingerprints the pinned SHA/revision, prefixes, tokenizer and actual runtime build', () => {
    const first = getDocumentRetrievalRuntimeIdentity(embeddingProfile);
    for (const changed of [{ modelRevision: 'different' }, { modelSha256: 'a'.repeat(64) },
      { queryPrefix: 'different: ' }, { documentPrefix: 'different: ' }]) {
      expect(getDocumentRetrievalRuntimeIdentity({ ...embeddingProfile, ...changed })).not.toBe(first);
    }
    jest.mocked(getLlamaBuildInfo).mockReturnValue({ build: 'different' } as never);
    expect(getDocumentRetrievalRuntimeIdentity(embeddingProfile)).not.toBe(first);
  });

  it.each(['query', 'document'] as const)('counts the required %s prefix before embedding and requests L2 pooled vectors', async kind => {
    const ctx = context(); const check = jest.fn();
    await expect(embedDocumentRetrievalText(nativeContext(ctx), embeddingProfile, 'Нужна помощь', kind, check)).resolves.toEqual(vector());
    const input = (kind === 'query' ? 'query: ' : 'passage: ') + 'Нужна помощь';
    expect(ctx.tokenize).toHaveBeenCalledWith(input);
    expect(ctx.embedding).toHaveBeenCalledWith(input, { embd_normalize: 2 });
    expect(claimNativePooledEmbeddingDimension).toHaveBeenCalledWith(384);
    expect(ctx.tokenize.mock.invocationCallOrder[0]).toBeLessThan(ctx.embedding.mock.invocationCallOrder[0]);
  });

  it.each([[509, true], [510, false]] as const)('reserves two automatic specials: %i raw tokens, allowed=%s', async (count, allowed) => {
    const ctx = context(); ctx.tokenize.mockResolvedValue({ tokens: Array(count).fill(10) });
    const work = embedDocumentRetrievalText(nativeContext(ctx), embeddingProfile, 'source', 'document', () => {});
    if (allowed) await expect(work).resolves.toEqual(vector());
    else { await expect(work).rejects.toMatchObject({ code: 'input_too_large' }); expect(ctx.embedding).not.toHaveBeenCalled(); }
  });

  it.each([
    ['empty', []], ['wrong dimension', [1]], ['zero', Array(384).fill(0)],
    ['NaN', [NaN, ...Array(383).fill(0)]], ['infinite', [Infinity, ...Array(383).fill(0)]], ['nonunit', Array(384).fill(0.5)],
  ] satisfies [string, number[]][])('rejects %s native vectors', async (_name, badVector) => {
    const ctx = context(); ctx.embedding.mockResolvedValue({ embedding: badVector });
    await expect(embedDocumentRetrievalText(nativeContext(ctx), embeddingProfile, 'source', 'document', () => {}))
      .rejects.toMatchObject({ code: 'invalid_vector' });
  });

  it('rejects wrong model dimensions/tokenizer and a process-wide pooled dimension conflict before embedding', async () => {
    const ctx = context(); ctx.model.nEmbd = 1024;
    expect(() => assertRetrievalContextProfile(nativeContext(ctx), embeddingProfile)).toThrow('profile_unverified');
    ctx.model.nEmbd = 384; ctx.model.metadata['tokenizer.ggml.model'] = 'bert';
    expect(() => assertRetrievalContextProfile(nativeContext(ctx), embeddingProfile)).toThrow('profile_unverified');
    ctx.model.metadata['tokenizer.ggml.model'] = 't5';
    jest.mocked(claimNativePooledEmbeddingDimension).mockImplementationOnce(() => { throw new Error('dimension_conflict'); });
    await expect(embedDocumentRetrievalText(nativeContext(ctx), embeddingProfile, 'source', 'document', () => {})).rejects.toThrow('dimension_conflict');
    expect(ctx.embedding).not.toHaveBeenCalled();
  });

  it('counts the actual pinned native pair template after detokenization and retokenization', async () => {
    const ctx = context(); ctx.model.nEmbd = 1024;
    ctx.tokenize.mockResolvedValueOnce({ tokens: [11, 12] }).mockResolvedValueOnce({ tokens: [31] })
      .mockResolvedValueOnce({ tokens: Array(509).fill(10) });
    await validateDocumentRerankPair(nativeContext(ctx), rerankerProfile, 'question', 'source', () => {});
    expect(ctx.tokenize.mock.calls).toEqual([['question'], ['source'], ['retokenized pair']]);
    expect(ctx.detokenize).toHaveBeenCalledWith([0, 11, 12, 2, 31, 2]);
    expect(ctx.embedding).not.toHaveBeenCalled();
  });

  it('rejects a too-large retokenized pair despite small separate query/document counts', async () => {
    const ctx = context();
    ctx.tokenize.mockResolvedValueOnce({ tokens: [11] }).mockResolvedValueOnce({ tokens: [31] })
      .mockResolvedValueOnce({ tokens: Array(510).fill(10) });
    await expect(validateDocumentRerankPair(nativeContext(ctx), rerankerProfile, 'question', 'source', () => {}))
      .rejects.toMatchObject({ code: 'input_too_large' });
  });

  it('observes cancellation after pair detokenization before subsequent native work', async () => {
    const ctx = context(); const check = jest.fn();
    ctx.detokenize.mockImplementation(async () => { check.mockImplementation(() => { throw new Error('cancelled'); }); return 'pair'; });
    await expect(validateDocumentRerankPair(nativeContext(ctx), rerankerProfile, 'question', 'source', check)).rejects.toThrow('cancelled');
    expect(ctx.tokenize).toHaveBeenCalledTimes(2);
  });
});
